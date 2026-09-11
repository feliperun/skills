import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fakeCodex, fixture, packet, writeContract } from "./helpers.mjs";
import {
  blockingChecks,
  checkDisk,
  checkGit,
  checkRuntimeBinaries,
  checkWorktree,
  environmentPreflight,
  reachableRuntimes,
  timeVerificationCommands,
} from "../scripts/env-preflight.mjs";
import { validateContract } from "../scripts/contract.mjs";
import {
  DISK_PRESSURE_UNRECOVERABLE,
  describeRuns,
  runGarbageCollection,
  selectGarbageCollectableRuns,
  writeRunTextWithDiskPressureRetry,
} from "../scripts/disk-gc.mjs";
import { acquire as acquireLock } from "../scripts/lock.mjs";
import { writeJsonAtomic } from "../scripts/store.mjs";

const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));

const EXPECTED_CHECK_KEYS = ["costUsd", "detail", "executable", "harness", "id", "live", "liveStatus", "model", "ok", "usage", "version"];

/**
 * @param {string} directory
 * @param {string[]} extraArgs
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function preflightCli(directory, extraArgs) {
  const contractPath = writeContract(directory, fixture());
  const result = spawnSync(process.execPath, [runner, "preflight", ...extraArgs, contractPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      INTENT_FACTORY_CODEX_BIN: fakeCodex(directory),
      INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC: "120",
    },
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("preflight --static --json reports every check with live false", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-static-json-"));
  const result = preflightCli(directory, ["--static", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{schemaVersion: number, contractId: string, ok: boolean, checks: Record<string, unknown>[]}} */ (JSON.parse(result.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.contractId, "test-run");
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.length > 0, "expected at least one routed runtime check");
  for (const check of payload.checks) {
    assert.deepEqual(Object.keys(check).sort(), EXPECTED_CHECK_KEYS);
    assert.equal(check.live, false);
    assert.equal(check.liveStatus, null);
    assert.equal(check.usage, null);
    assert.equal(check.costUsd, null);
  }
});

test("preflight --json runs the live probe and reports usage per check", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-live-json-"));
  const result = preflightCli(directory, ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{schemaVersion: number, contractId: string, ok: boolean, checks: Record<string, unknown>[]}} */ (JSON.parse(result.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.contractId, "test-run");
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.length > 0, "expected at least one routed runtime check");
  for (const check of payload.checks) {
    assert.deepEqual(Object.keys(check).sort(), EXPECTED_CHECK_KEYS);
    assert.equal(check.live, true);
    assert.equal(check.liveStatus, "done");
    const usage = /** @type {{inputTokens: number}} */ (check.usage);
    assert.equal(typeof usage.inputTokens, "number");
  }
});

/**
 * @param {string} prefix
 * @param {string[][]} commands
 * @returns {string}
 */
function gitRepo(prefix, commands = []) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["-C", directory, "init", "-q"], { encoding: "utf8" });
  writeFileSync(join(directory, "README.md"), "fixture\n");
  spawnSync("git", ["-C", directory, "add", "README.md"], { encoding: "utf8" });
  spawnSync("git", ["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "fixture"], { encoding: "utf8" });
  for (const args of commands) spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return directory;
}

/**
 * @param {string} executable
 * @returns {Map<string, {runtime: import("../scripts/contract.mjs").RuntimeSnapshot, requiredCapabilitySets: []}>}
 */
function routedRuntimes(executable) {
  const runtime = /** @type {import("../scripts/contract.mjs").RuntimeSnapshot} */ ({
    id: "luna",
    harness: "codex",
    executable,
    model: "gpt-5.6-luna",
  });
  return new Map([["luna", { runtime, requiredCapabilitySets: /** @type {[]} */ ([]) }]]);
}

test("preflight disk check fails below the configured free-space threshold", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-disk-"));
  const plenty = checkDisk(directory, 0);
  assert.equal(plenty.ok, true, plenty.detail);
  assert.equal(plenty.advisory, false);
  const starved = checkDisk(directory, Number.MAX_SAFE_INTEGER);
  assert.equal(starved.ok, false);
  assert.equal(starved.advisory, false, "a disk shortfall blocks a dispatch");
  assert.match(starved.detail, /free at least/u);
});

test("preflight git check requires an initial commit and rejects a missing cwd", () => {
  const unborn = mkdtempSync(join(tmpdir(), "env-preflight-unborn-"));
  spawnSync("git", ["-C", unborn, "init", "-q"], { encoding: "utf8" });
  const fresh = checkGit(unborn);
  assert.equal(fresh.ok, false, fresh.detail);
  assert.match(fresh.detail, /at least one commit/u);
  const directory = gitRepo("env-preflight-git-");
  const committed = checkGit(directory);
  assert.equal(committed.ok, true, committed.detail);
  assert.match(committed.detail, /HEAD /u);
  const missing = checkGit(join(directory, "absent"));
  assert.equal(missing.ok, false);
  assert.equal(missing.advisory, false);
});

test("preflight worktree check is advisory when dirty and blocking mid-merge", () => {
  const directory = gitRepo("env-preflight-worktree-");
  assert.equal(checkWorktree(directory, false).ok, true, "a fresh repository is clean");
  writeFileSync(join(directory, "note.txt"), "dirt\n");
  const dirty = checkWorktree(directory, false);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.advisory, true, "a merely dirty tree never blocks a dispatch");
  const strict = checkWorktree(directory, true);
  assert.equal(strict.ok, false);
  assert.equal(strict.advisory, false, "INTENT_FACTORY_REQUIRE_CLEAN_WORKTREE makes dirt fatal");
  writeFileSync(join(directory, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
  const merging = checkWorktree(directory, false);
  assert.equal(merging.ok, false);
  assert.equal(merging.advisory, false);
  assert.match(merging.detail, /merge is in progress/u);
});

test("preflight runtime binary check requires a resolvable binary and a version", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-binary-"));
  const executable = fakeCodex(directory);
  const versioned = checkRuntimeBinaries(routedRuntimes(executable), { luna: "1.0.0" });
  assert.equal(versioned.ok, true, versioned.detail);
  assert.match(versioned.detail, /luna 1\.0\.0/u);
  const unversioned = checkRuntimeBinaries(routedRuntimes(executable), { luna: null });
  assert.equal(unversioned.ok, false);
  assert.equal(unversioned.advisory, false);
  assert.match(unversioned.detail, /reported no version/u);
  const absent = checkRuntimeBinaries(routedRuntimes(join(directory, "absent-bin")), { luna: "1.0.0" });
  assert.equal(absent.ok, false);
  assert.match(absent.detail, /not found on PATH/u);
});

test("preflight environment report blocks only on non-advisory failures", () => {
  const directory = gitRepo("env-preflight-report-");
  writeFileSync(join(directory, "note.txt"), "dirt\n");
  const runtimes = routedRuntimes(fakeCodex(directory));
  const ready = environmentPreflight({ cwd: directory, runtimes, harnessVersions: { luna: "1.0.0" }, env: {} });
  assert.deepEqual(ready.checks.map((check) => check.name), ["disk", "git", "worktree", "runtime binaries"]);
  assert.equal(ready.ok, true, "a dirty worktree alone stays dispatchable");
  assert.deepEqual(blockingChecks(ready), []);
  const starved = environmentPreflight({
    cwd: directory,
    runtimes,
    harnessVersions: { luna: null },
    env: { INTENT_FACTORY_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) },
  });
  assert.equal(starved.ok, false);
  assert.deepEqual(blockingChecks(starved).map((check) => check.name), ["disk", "runtime binaries"]);
});

test("preflight failure keeps the run materialized, evidenced, and resumable", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-resumable-"));
  const contractPath = writeContract(directory, fixture());
  const env = { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory) };
  const blocked = spawnSync(process.execPath, [runner, "run", contractPath], {
    encoding: "utf8",
    env: { ...env, INTENT_FACTORY_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) },
  });
  assert.equal(blocked.status, 1, blocked.stdout);
  assert.match(String(blocked.stderr), /env_preflight_failed/u);
  const runDir = join(directory, ".runs", "test-run");
  assert.ok(existsSync(join(runDir, "contract.json")), "the run stays materialized for a resume");
  const evidence = JSON.parse(readFileSync(join(runDir, "env-preflight.json"), "utf8"));
  assert.equal(evidence.ok, false);
  assert.deepEqual(evidence.checks.filter((/** @type {{ok: boolean, advisory: boolean}} */ check) => !check.ok && !check.advisory).map((/** @type {{name: string}} */ check) => check.name), ["disk"]);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "run.env-preflight-failed"), "the failure is durable run evidence");
  const persisted = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  for (const node of persisted.nodes) {
    assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8")).status, "pending", `node ${node.id} was dispatched`);
  }
  const resumed = spawnSync(process.execPath, [runner, "resume", runDir], { encoding: "utf8", env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(readFileSync(join(runDir, "env-preflight.json"), "utf8")).ok, true, "the resume re-checks the environment");
});

test("preflight's reachable-state enumeration stops at one hop and never probes an unreachable second hop", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-one-hop-"));
  const contractPath = writeContract(directory, fixture({
    runtimeDefaults: { worker: "a", judge: "a" },
    runtimes: {
      a: { harness: "codex", model: "a", executable: "/nonexistent/codex", fallback: "b" },
      b: { harness: "codex", model: "b", executable: "/nonexistent/codex", fallback: "c" },
      c: { harness: "codex", model: "c", executable: "/nonexistent/codex" },
    },
    nodes: [{ id: "build", type: "backend", runtime: "a", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runtimes = reachableRuntimes(contract);
  assert.deepEqual(
    [...runtimes.keys()].sort(),
    ["a", "b"],
    "a node assigned runtime a can take only its one declared hop to b; c is never reachable from it and must never be probed",
  );
});

test("doctor reports the four environment checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-doctor-"));
  const contractPath = writeContract(directory, fixture());
  const result = spawnSync(process.execPath, [runner, "doctor", "--json", "--cwd", directory, contractPath], {
    encoding: "utf8",
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory) },
  });
  const payload = /** @type {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(result.stdout));
  const names = payload.checks.map((check) => check.name);
  for (const name of ["disk", "git", "worktree", "runtime binaries"]) {
    assert.ok(names.includes(name), `doctor is missing the ${name} check`);
  }
  const worktree = payload.checks.find((check) => check.name === "worktree");
  assert.equal(worktree?.ok, true, "an advisory worktree finding never fails doctor");
});

test("verification timing measures each declared command against its own timeout", () => {
  const contract = /** @type {any} */ ({
    cwd: process.cwd(),
    nodes: [
      { id: "first", taskPacket: { verification: [{ argv: ["slow"], timeoutSec: 600 }] } },
      // The same command on a second node is timed once, under the strictest timeout.
      { id: "second", taskPacket: { verification: [{ argv: ["slow"], timeoutSec: 300 }, { argv: ["quick"], timeoutSec: 120 }] } },
    ],
  });

  /** @type {string[]} */
  const invoked = [];
  let clock = 0;
  const durations = { slow: 644_000, quick: 2_000 };
  const checks = timeVerificationCommands(contract, {
    now: () => clock,
    run: /** @type {any} */ (/** @param {string} file */ (file) => {
      invoked.push(file);
      clock += durations[/** @type {"slow"|"quick"} */ (file)];
      return { status: 0, signal: null };
    }),
  });

  assert.deepEqual(invoked, ["slow", "quick"], "one measurement per distinct command, not per node");
  const slow = checks.find((check) => check.name.includes("slow"));
  assert.equal(slow?.ok, false, "644s cannot pass a 300s verification entry");
  assert.match(slow?.detail ?? "", /644\.0s measured against 300s declared/u);
  assert.match(slow?.detail ?? "", /declared by first, second/u);
  const quick = checks.find((check) => check.name.includes("quick"));
  assert.equal(quick?.ok, true);
});

test("verification timing warns before a command reaches its cap", () => {
  const contract = /** @type {any} */ ({
    cwd: process.cwd(),
    nodes: [{ id: "only", taskPacket: { verification: [{ argv: ["near"], timeoutSec: 100 }] } }],
  });
  let clock = 0;
  const [check] = timeVerificationCommands(contract, {
    now: () => clock,
    run: /** @type {any} */ (() => { clock += 85_000; return { status: 1, signal: null }; }),
  });
  assert.equal(check.ok, false);
  assert.equal(check.advisory, true, "a command close to its cap is a warning, not a blocker");
  assert.match(check.detail, /exit 1/u, "a red command is reported, never failed on: a node may be what turns it green");
});

/**
 * @param {string} runsDir
 * @param {string} id
 * @param {{startedAt?: string, status?: string}} [options]
 * @returns {string}
 */
function makeRun(runsDir, id, options = {}) {
  const runDir = join(runsDir, id);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeJsonAtomic(join(runDir, "run.json"), { startedAt: options.startedAt ?? new Date().toISOString() });
  writeJsonAtomic(join(runDir, "nodes", "build.json"), { status: options.status ?? "done" });
  return runDir;
}

test("garbage collection selection is pure: sorts oldest first and excludes every ineligible descriptor without touching disk", () => {
  const descriptors = [
    { path: "/runs/b", startedAt: "2026-01-02T00:00:00.000Z", hasActiveController: false, allNodesTerminal: true },
    { path: "/runs/a", startedAt: "2026-01-01T00:00:00.000Z", hasActiveController: false, allNodesTerminal: true },
    { path: "/runs/running", startedAt: "2025-12-31T00:00:00.000Z", hasActiveController: false, allNodesTerminal: false },
    { path: "/runs/locked", startedAt: "2025-12-30T00:00:00.000Z", hasActiveController: true, allNodesTerminal: true },
    { path: "/runs/current", startedAt: "2025-12-29T00:00:00.000Z", hasActiveController: false, allNodesTerminal: true },
    { path: "/runs/unknown-age", startedAt: null, hasActiveController: false, allNodesTerminal: true },
    { path: "/runs/campaigns", startedAt: "2025-01-01T00:00:00.000Z", hasActiveController: false, allNodesTerminal: true },
  ];
  const selected = selectGarbageCollectableRuns(descriptors, { currentRunDir: "/runs/current" });
  assert.deepEqual(selected, ["/runs/a", "/runs/b"], "only the two ordinary, terminal, unlocked, non-current runs, oldest first");
});

test("describeRuns never even describes campaigns/ or archive/, whatever they contain", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "disk-gc-describe-"));
  mkdirSync(join(runsDir, "campaigns", "camp-1"), { recursive: true });
  writeJsonAtomic(join(runsDir, "campaigns", "run.json"), { startedAt: "2020-01-01T00:00:00.000Z" });
  mkdirSync(join(runsDir, "campaigns", "nodes"), { recursive: true });
  writeJsonAtomic(join(runsDir, "campaigns", "nodes", "build.json"), { status: "done" });
  mkdirSync(join(runsDir, "archive"), { recursive: true });
  writeJsonAtomic(join(runsDir, "archive", "run.json"), { startedAt: "2020-01-01T00:00:00.000Z" });
  mkdirSync(join(runsDir, "archive", "nodes"), { recursive: true });
  writeJsonAtomic(join(runsDir, "archive", "nodes", "build.json"), { status: "done" });
  const ordinary = makeRun(runsDir, "ordinary-run", { startedAt: "2026-01-01T00:00:00.000Z" });

  const descriptors = describeRuns(runsDir);
  assert.deepEqual(descriptors.map((run) => run.path), [ordinary], "campaigns/ and archive/ are never described, even with a run-shaped run.json and nodes/ inside them");
});

test("garbage collection removes only the minimum necessary, oldest first, and never the active or current run, or campaigns", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "disk-gc-run-"));
  mkdirSync(join(runsDir, "campaigns", "camp-1"), { recursive: true });
  writeFileSync(join(runsDir, "campaigns", "camp-1", "campaign.json"), "{}\n");

  const oldest = makeRun(runsDir, "oldest-run", { startedAt: "2026-01-01T00:00:00.000Z" });
  const middle = makeRun(runsDir, "middle-run", { startedAt: "2026-01-02T00:00:00.000Z" });
  const newest = makeRun(runsDir, "newest-run", { startedAt: "2026-01-03T00:00:00.000Z" });
  const running = makeRun(runsDir, "running-run", { startedAt: "2025-12-31T00:00:00.000Z", status: "running" });
  const locked = makeRun(runsDir, "locked-run", { startedAt: "2025-12-30T00:00:00.000Z" });
  const lockHandle = acquireLock(locked, { pid: process.pid });
  const current = makeRun(runsDir, "current-run", { startedAt: "2025-12-29T00:00:00.000Z" });

  try {
    // Reports "below threshold" for the first three checks (the initial gate,
    // then before removing oldest and middle) and "above" from then on, so
    // exactly two removals — the minimum this stub demands — must happen.
    let calls = 0;
    const isAboveThreshold = () => { calls += 1; return calls > 3; };
    const { removed } = runGarbageCollection(runsDir, { currentRunDir: current, isAboveThreshold });

    assert.deepEqual(removed, [oldest, middle], "removes the minimum necessary, strictly oldest first");
    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(middle), false);
    assert.equal(existsSync(newest), true, "left alone: the threshold was already satisfied by then");
    assert.equal(existsSync(running), true, "never removed: not every node is terminal");
    assert.equal(existsSync(locked), true, "never removed: an active controller holds it");
    assert.equal(existsSync(current), true, "never removed: it is the run currently writing");
    assert.equal(existsSync(join(runsDir, "campaigns")), true, "never removed: the durable handoff");

    const events = readFileSync(join(runsDir, "gc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.path), [oldest, middle], "one event per removal, in removal order");
    for (const event of events) {
      assert.equal(typeof event.at, "string");
      assert.equal(event.reason, "enospc");
    }
  } finally {
    lockHandle.release();
  }
});

test("garbage collection does nothing once free space is already above the threshold", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "disk-gc-noop-"));
  const onlyRun = makeRun(runsDir, "only-run", { startedAt: "2026-01-01T00:00:00.000Z" });
  const { removed } = runGarbageCollection(runsDir, { isAboveThreshold: () => true });
  assert.deepEqual(removed, []);
  assert.equal(existsSync(onlyRun), true);
  assert.equal(existsSync(join(runsDir, "gc.jsonl")), false, "no removal, so no event");
});

test("INTENT_FACTORY_SIMULATE_GC_ROUNDS deterministically bounds how many eligible runs the default threshold check lets through", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "disk-gc-simulate-rounds-"));
  const oldest = makeRun(runsDir, "oldest-run", { startedAt: "2026-01-01T00:00:00.000Z" });
  const newest = makeRun(runsDir, "newest-run", { startedAt: "2026-01-02T00:00:00.000Z" });
  const previous = process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS;
  try {
    process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS = "0";
    assert.deepEqual(runGarbageCollection(runsDir).removed, [], "0 rounds reports the threshold already satisfied");
    assert.equal(existsSync(oldest), true);

    process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS = "2";
    assert.deepEqual(runGarbageCollection(runsDir).removed, [oldest], "one candidate needs candidates+1 = 2 rounds");
    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(newest), true, "the second candidate is never reached once satisfied");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS; else process.env.INTENT_FACTORY_SIMULATE_GC_ROUNDS = previous;
  }
});

test("a write that fails once with ENOSPC runs GC once and succeeds on retry", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "disk-gc-retry-recover-"));
  const runDir = join(runsDir, "current-run");
  mkdirSync(runDir, { recursive: true });
  const target = join(runDir, "nodes", "build.json");
  const previousMatch = process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH;
  const previousCount = process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT;
  process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH = "build.json";
  process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT = "1";
  try {
    writeRunTextWithDiskPressureRetry(runDir, target, "hello\n");
    assert.equal(readFileSync(target, "utf8"), "hello\n");
    assert.equal(process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT, "0", "exactly one simulated failure was consumed");
  } finally {
    if (previousMatch === undefined) delete process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH; else process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH = previousMatch;
    if (previousCount === undefined) delete process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT; else process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT = previousCount;
  }
});

test("a second ENOSPC in a row after garbage collection stops the write visibly, never silently", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "disk-gc-retry-persist-"));
  const runDir = join(runsDir, "current-run");
  mkdirSync(runDir, { recursive: true });
  const target = join(runDir, "nodes", "build.json");
  const previousMatch = process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH;
  const previousCount = process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT;
  process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH = "build.json";
  process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT = "2";
  try {
    assert.throws(
      () => writeRunTextWithDiskPressureRetry(runDir, target, "hello\n"),
      (/** @type {Error & {code?: string}} */ error) => error.code === DISK_PRESSURE_UNRECOVERABLE,
    );
    assert.equal(existsSync(target), false, "the write never landed");
  } finally {
    if (previousMatch === undefined) delete process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH; else process.env.INTENT_FACTORY_SIMULATE_ENOSPC_MATCH = previousMatch;
    if (previousCount === undefined) delete process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT; else process.env.INTENT_FACTORY_SIMULATE_ENOSPC_COUNT = previousCount;
  }
});
