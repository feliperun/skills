/**
 * Garbage collection for `.runs/` under disk pressure.
 *
 * A finished run's directory (contract, node snapshots, invocation logs) is
 * disposable once nothing can ever read it again: every node is terminal, no
 * controller holds it, and it is not the run currently writing. Reclaiming it
 * is the only thing that can turn an ENOSPC mid-run into something a resume
 * can recover from, since the disk will not free itself.
 *
 * Selection is a pure function over already-gathered facts (`describeRuns`
 * reads the disk; `selectGarbageCollectableRuns` does not) so the eligibility
 * rules are testable without creating a single file. Removal is a separate,
 * impure step that stops as soon as free space clears the threshold — it
 * never removes more than it has to — and it never removes `.runs/campaigns/`
 * or `.runs/archive/`, the durable handoff and any future archive, no matter
 * what a caller passes in.
 */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TERMINAL } from "../engine/prompts.mjs";
import { lockStale, readLock } from "./lock.mjs";
import { campaignsDir } from "../campaign/index.mjs";
import { checkDisk, minFreeDiskBytes } from "../host/preflight.mjs";
import { appendJsonl, writeTextAtomic } from "./store.mjs";
import { errorCode } from "../util.mjs";

/** @typedef {{path: string, startedAt: string|null, hasActiveController: boolean, allNodesTerminal: boolean}} RunDescriptor */

/** Names under `.runs/` a run directory can never be, in any circumstance. */
const RESERVED_RUN_DIR_NAMES = new Set(["campaigns", "archive"]);

/**
 * Gather the facts GC needs about every candidate under `runsDir`, straight
 * off disk. A directory this cannot positively identify as a run (no
 * readable `run.json`) is never described at all — `selectGarbageCollectableRuns`
 * only ever sees directories this function is sure are runs.
 *
 * @param {string} runsDir
 * @returns {RunDescriptor[]}
 */
export function describeRuns(runsDir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(runsDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const reservedPaths = new Set([campaignsDir(runsDir), join(runsDir, "archive")].map((path) => resolve(path)));
  /** @type {RunDescriptor[]} */
  const descriptors = [];
  for (const name of names) {
    if (RESERVED_RUN_DIR_NAMES.has(name)) continue;
    const path = join(runsDir, name);
    if (reservedPaths.has(resolve(path))) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    /** @type {string|null} */
    let startedAt = null;
    try {
      const metadata = JSON.parse(readFileSync(join(path, "run.json"), "utf8"));
      startedAt = typeof metadata.startedAt === "string" ? metadata.startedAt : null;
    } catch {
      // Not a recognizable run directory (missing or unreadable run.json) —
      // never described, so it can never be selected.
      continue;
    }
    const lock = readLock(path);
    descriptors.push({
      path,
      startedAt,
      hasActiveController: lock !== null && !lockStale(lock),
      allNodesTerminal: allNodeStatesTerminal(path),
    });
  }
  return descriptors;
}

/**
 * @param {string} runDir
 * @returns {boolean}
 */
function allNodeStatesTerminal(runDir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(join(runDir, "nodes")).filter((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
  if (names.length === 0) return false;
  for (const name of names) {
    try {
      const state = JSON.parse(readFileSync(join(runDir, "nodes", name), "utf8"));
      if (!TERMINAL.has(state.status)) return false;
    } catch {
      // An unreadable or corrupt node snapshot is never provably terminal.
      return false;
    }
  }
  return true;
}

/**
 * Pure selection: every rule here is checked against already-gathered facts,
 * never the filesystem, so this is testable with hand-built descriptors and
 * no run directory ever created. Eligible runs are returned oldest first —
 * `run.json`'s own `startedAt` is the only ordering signal, so a run whose
 * `startedAt` this could not read is never eligible; there is nothing safe to
 * compare it against.
 *
 * @param {RunDescriptor[]} descriptors
 * @param {{currentRunDir?: string|null}} [options]
 * @returns {string[]} run directories eligible for GC, oldest to newest
 */
export function selectGarbageCollectableRuns(descriptors, options = {}) {
  const currentRunDir = options.currentRunDir ? resolve(options.currentRunDir) : null;
  return descriptors
    .filter((run) => !RESERVED_RUN_DIR_NAMES.has(basename(run.path)))
    .filter((run) => typeof run.startedAt === "string")
    .filter((run) => run.allNodesTerminal)
    .filter((run) => !run.hasActiveController)
    .filter((run) => resolve(run.path) !== currentRunDir)
    .sort((a, b) => Date.parse(/** @type {string} */ (a.startedAt)) - Date.parse(/** @type {string} */ (b.startedAt)))
    .map((run) => run.path);
}

/**
 * Remove eligible run directories, oldest first, stopping the instant free
 * space clears the threshold — never more than the minimum necessary. Every
 * removal is appended to `<runsDir>/gc.jsonl` with its path and reason before
 * the next candidate is even considered, so a removal is never silent.
 *
 * @param {string} runsDir
 * @param {{currentRunDir?: string|null, minFreeBytes?: number, probePath?: string, reason?: string, isAboveThreshold?: () => boolean}} [options]
 * @returns {{removed: string[]}}
 */
export function runGarbageCollection(runsDir, options = {}) {
  const minFreeBytes = options.minFreeBytes ?? minFreeDiskBytes(process.env);
  const probePath = options.probePath ?? runsDir;
  const reason = options.reason ?? "enospc";
  // A real statfs threshold check by default, unless a case deterministically
  // simulates disk pressure (see `simulatedDiskPressureOverride`) — the same
  // threshold `checkDisk` already reuses, just paired with a way to prove the
  // removal loop without waiting on real free space to move. Tests may also
  // substitute their own stub directly instead of either.
  const isAboveThreshold = options.isAboveThreshold
    ?? (() => simulatedDiskPressureOverride() ?? checkDisk(probePath, minFreeBytes).ok);
  /** @type {string[]} */
  const removed = [];
  if (isAboveThreshold()) return { removed };
  const descriptors = describeRuns(runsDir);
  const candidates = selectGarbageCollectableRuns(descriptors, { currentRunDir: options.currentRunDir });
  for (const runDir of candidates) {
    if (isAboveThreshold()) break;
    rmSync(runDir, { recursive: true, force: true });
    removed.push(runDir);
    appendJsonl(join(runsDir, "gc.jsonl"), { at: new Date().toISOString(), path: runDir, reason });
  }
  return { removed };
}

/** Error code a run stops with when GC could not recover from disk pressure. */
export const DISK_PRESSURE_UNRECOVERABLE = "disk_pressure_unrecoverable";

/**
 * Write one run-directory text file, running GC exactly once and retrying
 * exactly once if the first write fails with ENOSPC. A second ENOSPC is never
 * retried again and never swallowed: it becomes a distinct, named error so
 * the run stops visibly instead of failing on whatever generic thing ENOSPC
 * happened to break next.
 *
 * @param {string} runDir
 * @param {string} path
 * @param {string} text
 */
export function writeRunTextWithDiskPressureRetry(runDir, path, text) {
  try {
    simulateEnospcForTest(path);
    writeTextAtomic(path, text);
    return;
  } catch (error) {
    if (errorCode(error) !== "ENOSPC") throw error;
  }
  runGarbageCollection(dirname(runDir), { currentRunDir: runDir });
  try {
    simulateEnospcForTest(path);
    writeTextAtomic(path, text);
  } catch (error) {
    if (errorCode(error) !== "ENOSPC") throw error;
    throw Object.assign(
      new Error(`disk pressure persists after garbage collection while writing ${path}`),
      { code: DISK_PRESSURE_UNRECOVERABLE },
    );
  }
}

/**
 * Deterministic ENOSPC injection for tests and evals, never a real full
 * disk. Inert unless `INTENT_FACTORY_SIMULATE_ENOSPC_MATCH` names a substring
 * of `path` and `INTENT_FACTORY_SIMULATE_ENOSPC_COUNT` holds a positive
 * integer; each simulated failure decrements that count, so a case sets it to
 * `1` to prove GC recovers the write and `2` to prove a second ENOSPC in a
 * row is never retried again.
 *
 * @param {string} path
 */
function simulateEnospcForTest(path) {
  const match = process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH;
  if (!match || !path.includes(match)) return;
  const remaining = Number(process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT ?? "0");
  if (!Number.isInteger(remaining) || remaining <= 0) return;
  process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT = String(remaining - 1);
  throw Object.assign(
    new Error(`ENOSPC: simulated no space left on device, write '${path}'`),
    { code: "ENOSPC", errno: -28, syscall: "write", path },
  );
}

/**
 * Deterministic stand-in for "free space is still below the threshold",
 * paired with `simulateEnospcForTest` so a case can prove the removal loop
 * itself — not just the write retry — without waiting on real free space to
 * move. Inert unless `INTENT_FACTORY_SIMULATE_GC_ROUNDS` holds a non-negative
 * integer; never consulted by `environmentPreflight`'s own disk check, which
 * always reads real free space.
 *
 * The count is calls, not removals: `runGarbageCollection` calls this once
 * before considering any candidate, then once more before each one it
 * removes, so a run with `n` eligible candidates needs `n + 1` to remove all
 * of them, or fewer to stop early after that many candidates.
 *
 * @returns {boolean|null} `false`/`true` to override the real check, or
 * `null` when no simulation is configured and the real check should decide
 */
function simulatedDiskPressureOverride() {
  const raw = process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS;
  if (raw === undefined) return null;
  const remaining = Number(raw);
  if (!Number.isInteger(remaining) || remaining < 0) return null;
  if (remaining <= 0) return true;
  process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS = String(remaining - 1);
  return false;
}
