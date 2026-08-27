import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { providerCommand, normalizeProviderResult } from "./drivers/index.mjs";
import { readLease, leaseHealthy, writeJsonAtomic } from "./store.mjs";
import { captureWorkspaceSnapshot, compareWorkspaceSnapshot } from "./verification.mjs";

const DEFAULT_GRACE_MS = 2_000;
const GATE_SCRIPT = String.raw`
import { existsSync, readFileSync, statSync, openSync, closeSync, readSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const config = JSON.parse(readFileSync(process.env.PLAN_RUNNER_GATE_CONFIG, "utf8"));
const releasePath = process.env.PLAN_RUNNER_GATE_RELEASE;
const parentPid = Number(process.env.PLAN_RUNNER_GATE_PARENT_PID);
const parentToken = process.env.PLAN_RUNNER_GATE_PARENT_TOKEN || null;
const maxLogBytes = 512 * 1024;
function startToken(pid) {
  if (process.platform !== "linux" || !pid) return null;
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8").trim();
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}
function parentAlive() {
  try { process.kill(parentPid, 0); } catch (error) { return error.code === "EPERM"; }
  return !parentToken || process.platform !== "linux" || startToken(parentPid) === parentToken;
}
let provider = null;
let inputEnded = config.promptTransport !== "stdin";
const pendingInput = [];
if (config.promptTransport === "stdin") {
  process.stdin.on("data", (chunk) => {
    if (provider) provider.stdin.write(chunk);
    else pendingInput.push(chunk);
  });
  process.stdin.on("end", () => {
    inputEnded = true;
    if (provider) provider.stdin.end();
  });
}
function killGroup(signal) {
  try { process.kill(-process.pid, signal); } catch {}
}
function stopProvider() {
  try { provider?.kill("SIGTERM"); } catch {}
  setTimeout(() => killGroup("SIGKILL"), 100).unref();
}
// Providers write directly into the log files: a provider with non-blocking
// stdout (EAGAIN on a full pipe) must never die because the controller's event
// loop is briefly busy. Cap the files to the last maxLogBytes afterwards.
function capLog(path, preservePrefix = false) {
  try {
    const size = statSync(path).size;
    if (size <= maxLogBytes) return;
    if (preservePrefix) {
      const prefixLimit = Math.min(64 * 1024, maxLogBytes - 1);
      const prefix = Buffer.alloc(prefixLimit);
      const prefixFd = openSync(path, "r");
      readSync(prefixFd, prefix, 0, prefixLimit, 0);
      closeSync(prefixFd);
      const prefixEnd = prefix.lastIndexOf(10);
      if (prefixEnd >= 0) {
        const tailLimit = maxLogBytes - prefixEnd - 1;
        const tail = Buffer.alloc(tailLimit);
        const tailFd = openSync(path, "r");
        readSync(tailFd, tail, 0, tailLimit, size - tailLimit);
        closeSync(tailFd);
        const tailStart = tail.indexOf(10);
        const suffix = tailStart >= 0 ? tail.subarray(tailStart + 1) : Buffer.alloc(0);
        const out = openSync(path, "w");
        writeSync(out, Buffer.concat([prefix.subarray(0, prefixEnd + 1), suffix]));
        closeSync(out);
        return;
      }
    }
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxLogBytes);
    readSync(fd, buffer, 0, maxLogBytes, size - maxLogBytes);
    closeSync(fd);
    const out = openSync(path, "w");
    writeSync(out, buffer);
    closeSync(out);
  } catch {}
}
function childEnv() {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  // Worker providers are not a notification surface: strip the controller-only
  // transport after the driver overlay so no driver can reintroduce it.
  delete merged.PLAN_RUNNER_NOTIFY_BIN;
  return merged;
}
process.on("SIGTERM", () => stopProvider());
process.on("SIGINT", () => stopProvider());
const timer = setInterval(() => {
  if (!parentAlive()) { clearInterval(timer); stopProvider(); return; }
  if (!existsSync(releasePath)) return;
  clearInterval(timer);
  const stdoutFd = openSync(config.stdoutPath, "wx", 0o600);
  const stderrFd = openSync(config.stderrPath, "wx", 0o600);
  provider = spawn(config.executable, config.args, {
    cwd: config.cwd,
    env: childEnv(),
    stdio: [config.promptTransport === "stdin" ? "pipe" : "ignore", stdoutFd, stderrFd],
  });
  if (config.promptTransport === "stdin") {
    for (const chunk of pendingInput) provider.stdin.write(chunk);
    pendingInput.length = 0;
    if (inputEnded) provider.stdin.end();
  }
  provider.once("error", () => process.exitCode = 127);
  provider.once("close", (code) => {
    capLog(config.stdoutPath, config.driver === "codex");
    capLog(config.stderrPath);
    process.exit(code ?? 1);
  });
}, 10);
`;

const MAX_PROVIDER_LOG_BYTES = 512 * 1024;

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./drivers/index.mjs").DriverRuntime} DriverRuntime */
/** @typedef {{prompt: string|null, stdout: string, stderr: string}} PathSet */
/** @typedef {{id: string, pid: number, processGroupId: number|null, processStartToken: string|null, driver: string, runtimeId: string|null, runtimeFingerprint?: string, revision?: number, phase: string, promptPath: string|null, stdoutPath: string, stderrPath: string, startedAt: string, deadlineAt: string|null, updatedAt: string, closedAt: string|null, exitCode: number|null, signal: string|null, status: "active"|"closed"|"terminated", executable: string, snapshotPath?: string, usage?: import("./contract.mjs").Usage, costUsd?: number|null, runId?: string, campaignId?: string, planPhase?: string, role?: "worker"|"judge", model?: string, reasoning?: string|null, sandbox?: string|null, continuationId?: string|null, continuationMode?: "fresh"|"reuse"|"rotate"}} Invocation */
/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {{pid: number|null, processGroupId?: number|null, processStartToken?: string|null}} InvocationProbe */
/** @typedef {import("./contract.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {{child: ChildProcess, node: ValidatedNode, state: NodeSnapshot, runtime: DriverRuntime & {id: string|null}, cwd: string, paths: PathSet, phase: string, invocation: Invocation, startedAt: string, startedTicks: bigint, progressTicks: bigint, lastOutputAt: number, closed: boolean, exitCode: number|null, signal: string|null, spawnError: Error|null, terminating: Promise<void>|null, gateConfigPath: string, gateReleasePath: string, scopeBaseline?: unknown, scopeChecked?: boolean, scopeViolation?: boolean, budgetStop?: "node"|"campaign"|"wallclock", liveInputTokens?: number, observeTimer?: ReturnType<typeof setInterval>, onClose?: (invocation: Invocation) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} Job */

/**
 * @param {{contract: ValidatedContract, node: ValidatedNode, state: NodeSnapshot, runtime: DriverRuntime & {id: string|null}, prompt: string, paths: PathSet, phase: string, commandOptions?: import("./drivers/index.mjs").CommandOptions, onInvocation: (invocation: Invocation, job: Job) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} args
 * @returns {Job}
 */
export function startProcess({ contract, node, state, runtime, prompt, paths, phase, commandOptions = {}, onInvocation, onInvocationUpdate, onProgress }) {
  const command = providerCommand(runtime, prompt, commandOptions);
  if (paths.prompt) writeFileSync(paths.prompt, prompt, { flag: "wx", mode: 0o600 });
  const gateConfigPath = `${paths.prompt}.gate.json`;
  const gateReleasePath = `${paths.prompt}.gate.release`;
  writeJsonAtomic(gateConfigPath, {
    cwd: contract.cwd,
    executable: command.executable,
    args: command.args,
    promptTransport: command.promptTransport,
    driver: runtime.driver,
    env: command.env ?? null,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  });
  let child;
  try {
    child = spawn(process.execPath, ["-e", GATE_SCRIPT], {
      cwd: contract.cwd,
      env: {
        ...process.env,
        PLAN_RUNNER_GATE_CONFIG: gateConfigPath,
        PLAN_RUNNER_GATE_RELEASE: gateReleasePath,
        PLAN_RUNNER_GATE_PARENT_PID: String(process.pid),
        PLAN_RUNNER_GATE_PARENT_TOKEN: processStartToken(process.pid) ?? "",
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
    driver: runtime.driver,
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
    cwd: contract.cwd,
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
    if (phase === "worker" && node.progressPolicy) {
      initializeProgress(job);
      job.onProgress?.(state);
    }
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
 * Observe a bounded prefix while the provider is live. Driver normalizers know
 * how to recognize a continuation-start event without runner-specific parsing.
 *
 * @param {Job} job
 */
function observeInvocation(job) {
  if (job.closed || job.invocation.continuationId) return;
  try {
    const bytes = readFileSync(job.paths.stdout);
    const bounded = bytes.subarray(0, Math.min(bytes.length, 128 * 1024));
    const newline = bounded.lastIndexOf(10);
    if (newline < 0) return;
    const envelope = normalizeProviderResult(job.runtime, bounded.subarray(0, newline + 1).toString("utf8"), null, null);
    if (!envelope.continuationId) return;
    job.invocation = {
      ...job.invocation,
      continuationId: envelope.continuationId,
      updatedAt: new Date().toISOString(),
    };
    job.onInvocationUpdate?.(job.invocation);
  } catch {}
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
 * @param {Job} job
 */
function initializeProgress(job) {
  const policy = job.node.progressPolicy;
  if (!policy) return;
  const existing = job.state.progress;
  const revision = job.state.revisions ?? 0;
  const keep = existing && (existing.revision === undefined || existing.revision === revision);
  const baselineSignature = job.scopeBaseline
    ? workspaceProgressSignature(/** @type {import("./verification.mjs").WorkspaceSnapshot} */ (job.scopeBaseline), job.state.scope?.boundary)
    : null;
  if (keep) {
    job.state.progress = {
      ...existing,
      revision,
      nextCheckAt: existing.nextCheckAt ?? new Date(Date.parse(job.startedAt) + policy.graceSec * 1_000).toISOString(),
      progressSignature: existing.progressSignature ?? baselineSignature,
    };
    return;
  }
  const startedAt = Date.parse(job.startedAt);
  job.state.progress = {
    revision,
    heartbeatCount: 0,
    dryHeartbeatCount: 0,
    progressSignature: baselineSignature,
    lastHeartbeatAt: null,
    lastProgressAt: job.startedAt,
    nextCheckAt: new Date(startedAt + policy.graceSec * 1_000).toISOString(),
  };
}

/**
 * @param {import("./verification.mjs").WorkspaceSnapshot} snapshot
 * @param {import("./verification.mjs").WorkspaceScopeBoundary|undefined} boundary
 * @returns {string}
 */
function workspaceProgressSignature(snapshot, boundary) {
  if (!boundary || !Array.isArray(boundary.files) || !Array.isArray(boundary.roots)) {
    throw Object.assign(new Error("persisted worker scope boundary is missing"), { code: "scope_boundary_missing" });
  }
  const entries = snapshot.entries.filter((entry) => boundary.files.includes(entry.path) || boundary.roots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * @param {Job} job
 * @param {ValidatedContract} contract
 * @param {bigint} nowTicks
 * @returns {Promise<boolean>}
 */
async function checkProgress(job, contract, nowTicks) {
  const policy = job.node.progressPolicy;
  if (job.phase !== "worker" || !policy || !job.state.progress) return false;
  const progress = job.state.progress;
  const nextCheck = Date.parse(progress.nextCheckAt ?? "");
  if (Number.isFinite(nextCheck) && Date.now() < nextCheck) return false;
  const baseline = /** @type {import("./verification.mjs").WorkspaceSnapshot|undefined} */ (job.scopeBaseline);
  if (!baseline) return false;
  const boundary = job.state.scope?.boundary;
  const comparison = compareWorkspaceSnapshot(baseline, contract.cwd, {
    files: job.node.taskPacket.writeFiles,
    roots: job.node.taskPacket.writeRoots,
    boundary,
  });
  const signature = workspaceProgressSignature(comparison.after, boundary);
  const changed = progress.progressSignature !== null && progress.progressSignature !== undefined
    ? signature !== progress.progressSignature
    : true;
  const now = new Date().toISOString();
  progress.heartbeatCount += 1;
  progress.lastHeartbeatAt = now;
  progress.nextCheckAt = new Date(Date.now() + policy.intervalSec * 1_000).toISOString();
  if (changed) {
    progress.progressSignature = signature;
    progress.dryHeartbeatCount = 0;
    progress.lastProgressAt = now;
  } else {
    progress.dryHeartbeatCount += 1;
  }
  job.onProgress?.(job.state);
  return progress.dryHeartbeatCount >= policy.maxDryHeartbeats;
}

/**
 * Apply the same durable heartbeat policy while a resumed controller adopts a
 * still-live worker invocation. The persisted progress deadline and dry count
 * are authoritative; provider output is intentionally not considered here.
 *
 * @param {{contract: ValidatedContract, node: ValidatedNode, state: NodeSnapshot, invocation: Invocation, baseline?: import("./verification.mjs").WorkspaceSnapshot|null}} args
 * @returns {Promise<boolean>}
 */
export async function checkRecoveredProgress({ contract, node, state, invocation, baseline }) {
  const policy = node.progressPolicy;
  if (invocation.phase !== "worker" || !policy) return false;
  const revision = state.revisions ?? 0;
  const existing = state.progress;
  const baselineSignature = baseline
    ? workspaceProgressSignature(baseline, state.scope?.boundary)
    : null;
  const keep = existing && (existing.revision === undefined || existing.revision === revision);
  if (!keep) {
    const startedAt = Date.parse(invocation.startedAt);
    state.progress = {
      revision,
      heartbeatCount: 0,
      dryHeartbeatCount: 0,
      progressSignature: baselineSignature,
      lastHeartbeatAt: null,
      lastProgressAt: invocation.startedAt,
      nextCheckAt: new Date((Number.isFinite(startedAt) ? startedAt : Date.now()) + policy.graceSec * 1_000).toISOString(),
    };
  } else {
    state.progress = {
      ...existing,
      revision,
      nextCheckAt: existing.nextCheckAt ?? new Date(Date.parse(invocation.startedAt) + policy.graceSec * 1_000).toISOString(),
      progressSignature: existing.progressSignature ?? baselineSignature,
    };
  }
  const progress = state.progress;
  const nextCheck = Date.parse(progress.nextCheckAt ?? "");
  if (Number.isFinite(nextCheck) && Date.now() < nextCheck) return false;
  if (!baseline) return false;
  const boundary = state.scope?.boundary;
  const comparison = compareWorkspaceSnapshot(baseline, contract.cwd, {
    files: node.taskPacket.writeFiles,
    roots: node.taskPacket.writeRoots,
    boundary,
  });
  const signature = workspaceProgressSignature(comparison.after, boundary);
  const changed = progress.progressSignature !== null && progress.progressSignature !== undefined
    ? signature !== progress.progressSignature
    : true;
  const now = new Date().toISOString();
  progress.heartbeatCount += 1;
  progress.lastHeartbeatAt = now;
  progress.nextCheckAt = new Date(Date.now() + policy.intervalSec * 1_000).toISOString();
  if (changed) {
    progress.progressSignature = signature;
    progress.dryHeartbeatCount = 0;
    progress.lastProgressAt = now;
  } else {
    progress.dryHeartbeatCount += 1;
  }
  return progress.dryHeartbeatCount >= policy.maxDryHeartbeats;
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
    try {
      const progressStalled = await checkProgress(job, contract, now);
      if (job.state.progress) await onProgress?.(job);
      if (progressStalled) {
        await terminateProcess(job);
        running.delete(nodeId);
        await onTimeout(job, "stalled", {
          code: "progress_stalled",
          message: `allowed workspace scope made no progress for ${job.state.progress?.dryHeartbeatCount ?? 0} heartbeats`,
        });
        continue;
      }
    } catch (error) {
      running.delete(nodeId);
      await terminateProcess(job);
      await onTimeout(job, "stalled", {
        code: errorCode(error) ?? "progress_snapshot_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
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
 * @param {Record<string, unknown>|undefined} state
 * @param {number} fallback
 * @returns {number}
 */
export function latestTimeoutSec(state, fallback) {
  const overrides = /** @type {unknown[]} */ (state?.executionOverrides ?? []);
  const override = [...overrides].reverse().find((item) =>
    item && typeof item === "object" &&
    /** @type {Record<string, unknown>} */ (item).kind === "timeout" &&
    typeof /** @type {Record<string, unknown>} */ (item).timeoutSec === "number" &&
    Number.isFinite(/** @type {Record<string, unknown>} */ (item).timeoutSec),
  );
  return override ? /** @type {number} */ (/** @type {Record<string, unknown>} */ (override).timeoutSec) : fallback;
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
export function processGroupAlive(processGroupId) {
  if (process.platform === "win32" || typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * @param {string} runDir
 * @returns {boolean}
 */
export function runProcessAlive(runDir) {
  const lease = readLease(runDir);
  if (lease && !lease.invalid && leaseHealthy(lease)) return invocationAlive({
    pid: /** @type {number} */ (lease.pid),
    processGroupId: null,
    processStartToken: /** @type {string|null} */ (lease.processStartToken),
  });
  return false;
}

/**
 * @param {{stdoutPath: string}} invocation
 * @param {DriverRuntime} runtime
 * @param {import("./drivers/index.mjs").NormalizeOptions} options
 * @returns {import("./drivers/index.mjs").ProviderEnvelope|null}
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
 * @param {string} value
 * @returns {string}
 */
function dropPartialLogLine(value) {
  const newline = String(value).indexOf("\n");
  return newline < 0 ? "" : String(value).slice(newline + 1);
}

/**
 * @param {number|null} pid
 * @returns {string|null}
 */
export function processStartToken(pid) {
  if (process.platform !== "linux" || !pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return tail[19] ?? null;
  } catch {
    return null;
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
 * @param {unknown} error
 * @returns {string|undefined}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
