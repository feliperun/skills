/**
 * One provider invocation as an operating-system fact: spawn it behind the gate,
 * watch its transcript grow, decide it has stalled, and take it down.
 *
 * Everything here is about the process and its files -- pids, process groups,
 * start tokens, log tails, stall clocks. Nothing here knows what a node is, what
 * a judge decides, or when a run is done. That separation is the point: a stuck
 * provider is killed by the same code whatever it was asked to do.
 */
import { SessionMetricsParser } from "../harnesses/exec-jsonl/index.mjs";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorCode } from "../util.mjs";
import { fileURLToPath } from "node:url";
import { harnessCapabilities, normalizeProviderResult, providerCommand } from "../harnesses/index.mjs";
import { latestTimeoutSec } from "./backoff.mjs";

import { processStartToken } from "../run/lock.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeJsonAtomic } from "../run/store.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../contract/index.mjs").Usage} Usage */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {{prompt: string|null, stdout: string, stderr: string}} PathSet */
/** @typedef {{id: string, pid: number, processGroupId: number|null, processStartToken: string|null, harness: string, runtimeId: string|null, runtimeFingerprint?: string, revision?: number, phase: string, promptPath: string|null, stdoutPath: string, stderrPath: string, startedAt: string, deadlineAt: string|null, updatedAt: string, closedAt: string|null, exitCode: number|null, signal: string|null, status: "active"|"closed"|"terminated", executable: string, snapshotPath?: string, usage?: Usage, usageEstimated?: boolean, costUsd?: number|null, runId?: string, campaignId?: string, nodeId?: string, attempt?: number, workspace?: string, worktreeBranch?: string|null, worktreeBaseSha?: string|null, planPhase?: string, role?: "worker"|"judge", model?: string, reasoning?: string|null, sandbox?: string|null, continuationId?: string|null, continuationMode?: "fresh"|"reuse"|"rotate"}} Invocation */
/** @typedef {{pid: number|null, processGroupId?: number|null, processStartToken?: string|null}} InvocationProbe */
/** @typedef {{child: ChildProcess, node: ValidatedNode, state: NodeSnapshot, runtime: HarnessRuntime & {id: string|null}, cwd: string, paths: PathSet, phase: string, invocation: Invocation, startedAt: string, startedTicks: bigint, progressTicks: bigint, lastOutputAt: number, closed: boolean, exitCode: number|null, signal: string|null, spawnError: Error|null, terminating: Promise<void>|null, gateConfigPath: string, gateReleasePath: string, scopeBaseline?: unknown, scopeChecked?: boolean, scopeViolation?: boolean, resultMaterialization?: boolean, recoveryBaseline?: unknown, observeTimer?: ReturnType<typeof setInterval>, monitorOffset?: number, monitorParser?: import("../harnesses/exec-jsonl/index.mjs").SessionMetricsParser, onClose?: (invocation: Invocation) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} Job */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GRACE_MS = 2_000;
const GATE_PATH = join(HERE, "gate.mjs");
const MAX_PROVIDER_LOG_BYTES = 512 * 1024;
/** Fixed-size read for incremental transcript observation. */
const MONITOR_CHUNK_BYTES = 64 * 1024;
/** Per-observation read budget: one tick never blocks on a huge backlog. */
const MONITOR_CALL_BUDGET_BYTES = 1024 * 1024;
/**
 * @param {{contract: ValidatedContract, node: ValidatedNode, state: NodeSnapshot, runtime: HarnessRuntime & {id: string|null}, prompt: string, paths: PathSet, phase: string, workspace?: string, commandOptions?: import("../harnesses/index.mjs").CommandOptions, onInvocation: (invocation: Invocation, job: Job) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} args
 * @returns {Job}
 */
export function startProcess({ contract, node, state, runtime, prompt, paths, phase, workspace = contract.cwd, commandOptions = {}, onInvocation, onInvocationUpdate, onProgress }) {
  const command = providerCommand(runtime, prompt, commandOptions);
  if (paths.prompt) writeFileSync(paths.prompt, prompt, { flag: "wx", mode: 0o600 });
  const gateConfigPath = `${paths.prompt}.gate.json`;
  const gateReleasePath = `${paths.prompt}.gate.release`;
  writeJsonAtomic(gateConfigPath, {
    cwd: workspace,
    executable: command.executable,
    args: command.args,
    promptTransport: command.promptTransport,
    harness: runtime.harness,
    env: command.env ?? null,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  });
  let child;
  try {
    child = spawn(process.execPath, [GATE_PATH], {
      cwd: workspace,
      env: {
        ...process.env,
        INTENT_FACTORY_GATE_CONFIG: gateConfigPath,
        INTENT_FACTORY_GATE_RELEASE: gateReleasePath,
        INTENT_FACTORY_GATE_PARENT_PID: String(process.pid),
        INTENT_FACTORY_GATE_PARENT_TOKEN: processStartToken(process.pid) ?? "",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch (error) {
    cleanupGate({ gateConfigPath, gateReleasePath });
    throw error;
  }
  const startedAt = new Date().toISOString();
  const timeoutSec = latestTimeoutSec(state, node.timeoutSec ?? contract.timeoutSec);
  /** @type {Invocation} */
  const invocation = {
    id: randomUUID(),
    pid: /** @type {number} */ (child.pid),
    processGroupId: process.platform === "win32" ? null : /** @type {number} */ (child.pid),
    processStartToken: processStartToken(/** @type {number} */ (child.pid)),
    harness: runtime.harness,
    runtimeId: runtime.id ?? null,
    revision: state.revisions ?? 0,
    phase,
    promptPath: paths.prompt ?? null,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    startedAt,
    deadlineAt: Number.isFinite(timeoutSec) ? new Date(Date.parse(startedAt) + timeoutSec * 1_000).toISOString() : null,
    updatedAt: startedAt,
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: command.executable,
  };
  /** @type {Job} */
  const job = {
    child,
    node,
    state,
    runtime,
    cwd: workspace,
    paths,
    phase,
    invocation,
    startedAt,
    startedTicks: process.hrtime.bigint(),
    progressTicks: process.hrtime.bigint(),
    lastOutputAt: 0,
    closed: false,
    exitCode: null,
    signal: null,
    spawnError: null,
    terminating: null,
    gateConfigPath,
    gateReleasePath,
    onInvocationUpdate,
    onProgress,
  };
  child.once("error", (error) => {
    job.spawnError = error;
    job.closed = true;
    closeInvocation(job);
  });
  child.once("close", (exitCode, signal) => {
    job.exitCode = exitCode;
    job.signal = signal;
    job.closed = true;
    closeInvocation(job);
  });
  try {
    if (typeof onInvocation !== "function") throw new Error("durable invocation persistence callback is required");
    onInvocation(invocation, job);
    signalGate(job.gateReleasePath);
    if (command.promptTransport === "stdin") {
      child.stdin.on("error", () => {});
      child.stdin.end(command.input);
    }
    job.observeTimer = setInterval(() => observeInvocation(job), 25);
    job.observeTimer.unref?.();
  } catch (error) {
    void terminateInvocation(invocation, { graceMs: 100, killGraceMs: 500 }).catch(() => {});
    cleanupGate(job);
    throw error;
  }
  process.stdout.write(`[node] ${node.id} running · ${phase} · ${runtime.id}\n`);
  return job;
}
/**
 * @param {Job} job
 */
function closeInvocation(job) {
  if (job.observeTimer) clearInterval(job.observeTimer);
  job.observeTimer = undefined;
  job.invocation = /** @type {Invocation} */ ({
    ...job.invocation,
    updatedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    exitCode: job.exitCode,
    signal: job.signal,
    status: "closed",
  });
  job.onClose?.(job.invocation);
  cleanupGate(job);
}
/**
 * Observe a bounded prefix while the provider is live. Harness normalizers know
 * how to recognize a continuation-start event without runner-specific parsing.
 *
 * @param {Job} job
 */
function observeInvocation(job) {
  if (job.closed || job.invocation.continuationId) return;
  try {
    const monitored = monitorInvocation(job);
    if (!monitored.continuationId) return;
    job.invocation = {
      ...job.invocation,
      continuationId: monitored.continuationId,
      updatedAt: new Date().toISOString(),
    };
    job.onInvocationUpdate?.(job.invocation);
  } catch {
    // Observation is best-effort: a failed metrics tick must not stop the run.
  }
}
/**
 * Observe the transcript incrementally: read only the bytes appended since
 * the last observation, in fixed-size chunks folded into a parser whose
 * retained state never scales with the unread length — so the metrics
 * survive both a transcript that outgrows any fixed window and an
 * already-large transcript on the first call after a controller restart.
 * The gate caps the log only at close, so byte offsets stay valid while the
 * provider is live. Only newline-terminated records are evidence; a
 * trailing partial record stays unconsumed for the next observation. The
 * generic metrics are zero for a provider that does not expose them.
 *
 * @param {Job} job
 * @returns {{continuationId: string|null, turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}}
 */
export function monitorInvocation(job) {
  try {
    const parser = job.monitorParser ?? (job.monitorParser = new SessionMetricsParser(job.runtime.harness));
    const size = statSync(job.paths.stdout).size;
    let offset = job.monitorOffset ?? 0;
    let budget = MONITOR_CALL_BUDGET_BYTES;
    if (size > offset) {
      const fd = openSync(job.paths.stdout, "r");
      try {
        const chunk = Buffer.alloc(MONITOR_CHUNK_BYTES);
        while (offset < size && budget > 0) {
          const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset, budget), offset);
          if (read <= 0) break;
          parser.push(chunk.subarray(0, read));
          offset += read;
          budget -= read;
        }
      } finally {
        closeSync(fd);
      }
      job.monitorOffset = offset;
    }
    return { continuationId: parser.continuationId, ...parser.metrics() };
  } catch {
    return { continuationId: null, turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false };
  }
}
/**
 * @param {string} path
 */
function signalGate(path) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${Date.now()}\n`, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/**
 * @param {Job|{gateConfigPath: string, gateReleasePath: string}} job
 */
function cleanupGate(job) {
  for (const path of [job.gateConfigPath, job.gateReleasePath]) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
/**
 * @param {Job|undefined} job
 * @param {{graceMs?: number, killGraceMs?: number, escalate?: boolean}} options
 * @returns {Promise<void>}
 */
export async function terminateProcess(job, options = {}) {
  if (!job) return;
  if (job.terminating) return job.terminating;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  job.terminating = (async () => {
    const invocation = job.invocation;
    signalInvocation(invocation, "SIGTERM");
    if (await waitForJobTermination(job, invocation, graceMs)) return;
    if (options.escalate !== false && process.platform !== "win32") signalInvocation(invocation, "SIGKILL");
    if (await waitForJobTermination(job, invocation, options.killGraceMs ?? graceMs)) return;
    throw new Error(`provider invocation ${invocation.id} did not terminate`);
  })();
  try {
    await job.terminating;
  } finally {
    job.terminating = null;
  }
}
/**
 * @param {InvocationProbe & {id?: string}|undefined} invocation
 * @param {{graceMs?: number, killGraceMs?: number, escalate?: boolean}} options
 * @returns {Promise<void>}
 */
export async function terminateInvocation(invocation, options = {}) {
  if (!invocation || !invocationAlive(invocation)) return;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  signalInvocation(invocation, "SIGTERM");
  if (await waitForInvocationDeath(invocation, graceMs)) return;
  if (options.escalate !== false && process.platform !== "win32") signalInvocation(invocation, "SIGKILL");
  if (!await waitForInvocationDeath(invocation, options.killGraceMs ?? graceMs)) {
    throw new Error(`provider invocation ${invocation.id} did not terminate`);
  }
}
/**
 * @param {ValidatedContract} contract
 * @param {Map<string, Job>} running
 * @param {(job: Job, outcome: "exhausted"|"stalled", error: {code: string, message: string}) => Promise<void>} onTimeout
 * @param {(job: Job) => Promise<void>|void} [onProgress]
 */
export async function detectStalls(contract, running, onTimeout, onProgress) {
  const now = process.hrtime.bigint();
  for (const [nodeId, job] of running) {
    const budgetSec = latestTimeoutSec(job.state, job.node.timeoutSec ?? contract.timeoutSec);
    if (elapsedSeconds(job.startedTicks, now) >= budgetSec) {
      await terminateProcess(job);
      running.delete(nodeId);
      await onTimeout(job, "exhausted", {
        code: "wall_clock_timeout",
        message: `${job.phase} ran longer than ${budgetSec}s`,
      });
      continue;
    }
    // A harness that never writes output until it exits (zcode's `--json`,
    // replay's single envelope line) cannot prove liveness through mtime: the
    // wall-clock check above is the only budget it is held to.
    if (!harnessCapabilities(job.runtime).streamsOutput) continue;
    let observed = 0;
    for (const path of [job.paths.stdout, job.paths.stderr]) {
      try {
        observed = Math.max(observed, statSync(path).mtimeMs);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    if (observed > job.lastOutputAt) {
      job.lastOutputAt = observed;
      job.progressTicks = now;
    }
    if (elapsedSeconds(job.progressTicks, now) < contract.stallTimeoutSec) continue;
    await terminateProcess(job);
    running.delete(nodeId);
    await onTimeout(job, "stalled", {
      code: "stall_timeout",
      message: `no provider output for ${contract.stallTimeoutSec}s`,
    });
  }
}
/**
 * @param {InvocationProbe|undefined} invocation
 * @returns {boolean}
 */
export function invocationAlive(invocation) {
  if (!invocation?.pid || !Number.isInteger(invocation.pid)) return false;
  let leaderAlive = false;
  try {
    process.kill(invocation.pid, 0);
    leaderAlive = true;
  } catch (error) {
    leaderAlive = errorCode(error) === "EPERM";
  }
  if (leaderAlive) return processStartTokenMatches(invocation);
  return processGroupAlive(invocation.processGroupId ?? null);
}
/**
 * @param {number|null} processGroupId
 * @returns {boolean}
 */
function processGroupAlive(processGroupId) {
  if (process.platform === "win32" || typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
/**
 * @param {{stdoutPath: string}} invocation
 * @param {HarnessRuntime} runtime
 * @param {import("../harnesses/index.mjs").NormalizeOptions} options
 * @returns {import("../harnesses/index.mjs").ProviderEnvelope|null}
 */
export function invocationResult(invocation, runtime, options = {}) {
  try {
    const stdout = boundedRegion(invocation.stdoutPath);
    return normalizeProviderResult(runtime, stdout, options.exitCode ?? 0, options.signal ?? null, options);
  } catch {
    return null;
  }
}
/**
 * @param {string} path
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedRegion(path, maxBytes = MAX_PROVIDER_LOG_BYTES) {
  try {
    return dropPartialLogLine(readFileSync(`${path}.tail`, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(maxBytes);
    readSync(fd, bytes, 0, maxBytes, size - maxBytes);
    return dropPartialLogLine(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
/**
 * @param {InvocationProbe} invocation
 * @returns {boolean}
 */
function processStartTokenMatches(invocation) {
  if (!invocation.processStartToken) return true;
  const current = processStartToken(invocation.pid);
  return current === invocation.processStartToken;
}
/**
 * @param {InvocationProbe & {id?: string}} invocation
 * @param {string} signal
 */
function signalInvocation(invocation, signal) {
  if (!invocationAlive(invocation)) return;
  const pid = invocation.pid;
  if (pid === null || pid === undefined) return;
  const target = process.platform === "win32" ? pid : -(invocation.processGroupId ?? pid);
  try {
    process.kill(target, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}
/**
 * @param {Job} job
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForJobClose(job, timeoutMs) {
  if (job.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const previous = job.onClose;
    job.onClose = (invocation) => {
      previous?.(invocation);
      clearTimeout(timer);
      resolve(true);
    };
  });
}
/**
 * @param {Job} job
 * @param {Invocation} invocation
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForJobTermination(job, invocation, timeoutMs) {
  const [closed, dead] = await Promise.all([
    waitForJobClose(job, timeoutMs),
    waitForInvocationDeath(invocation, timeoutMs),
  ]);
  return closed && dead;
}
/**
 * @param {InvocationProbe} invocation
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForInvocationDeath(invocation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!invocationAlive(invocation)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !invocationAlive(invocation);
}
/**
 * @param {bigint} fromTicks
 * @param {bigint} toTicks
 * @returns {number}
 */
function elapsedSeconds(fromTicks, toTicks) {
  return Number(toTicks - fromTicks) / 1e9;
}
/**
 * @param {string} runDir
 * @param {string} nodeId
 * @param {string} phase
 * @param {number} attempt
 * @returns {PathSet}
 */
export function logPaths(runDir, nodeId, phase, attempt) {
  const base = `${nodeId}.${attempt}.${phase}`;
  let stem = base;
  /**
   * @param {string} candidate
   * @returns {boolean}
   */
  const occupied = (candidate) => ["prompt", "jsonl", "err"].some((suffix) => existsSync(join(runDir, "logs", `${candidate}.${suffix}`)));
  for (let generation = 2; occupied(stem); generation += 1) stem = `${base}.r${generation}`;
  return {
    prompt: join(runDir, "logs", `${stem}.prompt`),
    stdout: join(runDir, "logs", `${stem}.jsonl`),
    stderr: join(runDir, "logs", `${stem}.err`),
  };
}
/**
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function readBoundedTail(path, maxBytes = 512 * 1024) {
  try {
    try { return dropPartialLogLine(readFileSync(`${path}.tail`, "utf8")); } catch (tailError) {
      if (errorCode(tailError) !== "ENOENT") throw tailError;
    }
    const size = statSync(path).size;
    if (size <= maxBytes) return readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      const bytes = Buffer.alloc(maxBytes);
      readSync(fd, bytes, 0, maxBytes, size - maxBytes);
      return dropPartialLogLine(bytes.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}
/**
 * @param {unknown} value
 * @returns {string}
 */
function dropPartialLogLine(value) {
  const newline = String(value).indexOf("\n");
  return newline < 0 ? "" : String(value).slice(newline + 1);
}
