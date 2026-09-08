#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { syncAgentSignal } from "./signal.mjs";
import {
  JUDGE_SCHEMA,
  TERMINAL,
  excerpt,
  judgePrompt,
  normalizeProviderResult,
  parseJudge,
  renderFindings,
  renderReport,
  renderStatus,
  retryPrompt,
  routeRuntime,
  validateContract,
} from "./lib.mjs";
import {
  clearJudgeReask,
  deterministicGate,
  judgeReaskOutstanding,
  judgeReaskReason,
  judgeRequired,
  markJudgeReask,
  resetPhaseRouting,
  uncitedRejection,
  verificationFailureVerdict,
} from "./judge-gate.mjs";
import {
  JUDGE_UNAVAILABLE_CODE,
  UNCITED_REJECTION_REASON,
  invalidJudgeVerdict,
  judgeReaskInstruction,
  judgeVerdictEvidence,
  reviewMode,
} from "./review-modes.mjs";
import {
  INTENT_FACTORY_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  driverCapabilities,
  probeRuntime,
  providerCommand,
} from "./drivers/index.mjs";
import { extractJson, liveUsage, SessionMetricsParser, TOOL_OUTPUT_LIMIT_BYTES } from "./drivers/exec-jsonl.mjs";
import {
  addRuntimeRequirement,
  failoverTargets,
  routingBackoffActive,
  runtimeSnapshot,
} from "./failover.mjs";
import {
  NON_FAILOVER_CODES,
  buildRouting,
  classifyTransition,
  isRepairable,
  latestTimeoutSec,
  networkBackoffAttempts,
  networkTransition,
  nodeDeadlineAt,
  planRoute,
} from "./backoff.mjs";
import {
  blockingChecks,
  doctorCommand,
  environmentPreflight,
  reachableRuntimes,
} from "./env-preflight.mjs";
import { composeAssignments, discoverRuntimes, exhaustedUntilOf } from "./runtime-discovery.mjs";
import { renderReportJson, renderStatusJson, statusNote, writeStatusArtifacts } from "./render.mjs";
import {
  captureSourceIdentity,
  validateEvent,
  validateNodeSnapshot,
  validateRunMetadata,
} from "./contract.mjs";
import {
  appendJsonl,
  bootstrapAckPath,
  bootstrapAttemptPath,
  bootstrapPath,
  cleanupBootstrapAttempts,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from "./store.mjs";
import {
  acquire as acquireLock,
  LockBusyError,
  LockLostError,
  pidAlive,
  processStartToken,
  readLock,
} from "./lock.mjs";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceScope,
  compareWorkspaceSnapshot,
  compactVerification,
  runVerification,
  validateWorkspaceScopeBoundary,
} from "./verification.mjs";
import { scopeFindingFromScope, scopeFindingsNote, verificationFailureWithScope } from "./scope-findings.mjs";
import { finalVerificationCommands } from "./final-verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "./worker-result.mjs";
import { campaignIdOf, registerRun, renderHandoff, renderRunHandoff, resolveCampaign } from "./campaign.mjs";
import { campaignCli } from "./campaign-cli.mjs";
import { contractCli, validateContractFile } from "./contract-cli.mjs";
import {
  appendPreviousAttempt,
  isUnknownEffectStop,
  planResumeRetry,
  renderPreviousAttemptSection,
} from "./retry.mjs";
import { bootstrapFailureMatchesChild, bootstrapMatchesChild, sameProcessStartToken, validBootstrapNonce } from "./lease-liveness.mjs";
import { NotifyQueue } from "./notify/index.mjs";
import { METRICS_OPTIONS, renderCampaignMetrics } from "./metrics.mjs";
import {
  attemptWorktreePath,
  createAttemptWorktree,
  createRunRef,
  gitHead,
  removeWorktree,
  sealAttempt,
  runRefName,
} from "./worktree.mjs";
import { integrateAttempt, recoverIntegrations } from "./integrate.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./contract.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./contract.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("./contract.mjs").RunMetadata} RunMetadata */
/** @typedef {import("./contract.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("./contract.mjs").EventRecord} EventRecord */
/** @typedef {import("./contract.mjs").Usage} Usage */
/** @typedef {import("./contract.mjs").GateResult} GateResult */
/** @typedef {import("./contract.mjs").SnapshotError} SnapshotError */
/** @typedef {import("./contract.mjs").BoundedScope} BoundedScope */
/** @typedef {import("./verification.mjs").WorkspaceSnapshot} WorkspaceSnapshot */
/** @typedef {import("./lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("./drivers/index.mjs").DriverRuntime} DriverRuntime */
/** @typedef {import("./drivers/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("./drivers/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("./verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("./verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("./verification.mjs").VerificationResult} VerificationResult */
/** @typedef {import("./verification.mjs").ScopeComparison} ScopeComparison */
/** @typedef {import("./worker-result.mjs").WorkerResult} WorkerResult */
/** @typedef {import("./campaign.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./lib.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {{kind: "adopted"|"rejudge"|"restart"|"reconciled"|"exhausted"|"stalled", phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, error?: {code: string, message: string}|null, invocationId?: string, reason?: string}} RecoveryOutcome */
/** @typedef {{runDir: string, states: Map<string, NodeSnapshot>, ok: boolean, error?: Error}} RunOutcome */
/** @typedef {import("node:child_process").ChildProcess & {bootstrapNonce?: string, bootstrapProcessStartToken?: string|null}} DetachedChild */
/** @typedef {{status?: string, nonce?: string, pid?: number, processStartToken?: string|null, holderId?: string, generation?: number, error?: unknown, runDir?: string}} BootstrapRecord */

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return error.code;
  return undefined;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_GRACE_MS = 2_000;
const GATE_SCRIPT = String.raw`
import { existsSync, readFileSync, statSync, openSync, closeSync, readSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const config = JSON.parse(readFileSync(process.env.INTENT_FACTORY_GATE_CONFIG, "utf8"));
const releasePath = process.env.INTENT_FACTORY_GATE_RELEASE;
const parentPid = Number(process.env.INTENT_FACTORY_GATE_PARENT_PID);
const parentToken = process.env.INTENT_FACTORY_GATE_PARENT_TOKEN || null;
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
  delete merged.INTENT_FACTORY_NOTIFY_BIN;
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

/** Fixed-size read for incremental transcript observation. */
const MONITOR_CHUNK_BYTES = 64 * 1024;

/** Per-observation read budget: one tick never blocks on a huge backlog. */
const MONITOR_CALL_BUDGET_BYTES = 1024 * 1024;

/** @typedef {{prompt: string|null, stdout: string, stderr: string}} PathSet */
/** @typedef {{id: string, pid: number, processGroupId: number|null, processStartToken: string|null, driver: string, runtimeId: string|null, runtimeFingerprint?: string, revision?: number, phase: string, promptPath: string|null, stdoutPath: string, stderrPath: string, startedAt: string, deadlineAt: string|null, updatedAt: string, closedAt: string|null, exitCode: number|null, signal: string|null, status: "active"|"closed"|"terminated", executable: string, snapshotPath?: string, usage?: Usage, usageEstimated?: boolean, costUsd?: number|null, runId?: string, campaignId?: string, nodeId?: string, attempt?: number, workspace?: string, worktreeBranch?: string|null, worktreeBaseSha?: string|null, planPhase?: string, role?: "worker"|"judge", model?: string, reasoning?: string|null, sandbox?: string|null, continuationId?: string|null, continuationMode?: "fresh"|"reuse"|"rotate"}} Invocation */
/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {{pid: number|null, processGroupId?: number|null, processStartToken?: string|null}} InvocationProbe */
/** @typedef {{child: ChildProcess, node: ValidatedNode, state: NodeSnapshot, runtime: DriverRuntime & {id: string|null}, cwd: string, paths: PathSet, phase: string, invocation: Invocation, startedAt: string, startedTicks: bigint, progressTicks: bigint, lastOutputAt: number, closed: boolean, exitCode: number|null, signal: string|null, spawnError: Error|null, terminating: Promise<void>|null, gateConfigPath: string, gateReleasePath: string, scopeBaseline?: unknown, scopeChecked?: boolean, scopeViolation?: boolean, resultMaterialization?: boolean, recoveryBaseline?: unknown, observeTimer?: ReturnType<typeof setInterval>, monitorOffset?: number, monitorParser?: import("./drivers/exec-jsonl.mjs").SessionMetricsParser, onClose?: (invocation: Invocation) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} Job */

/**
 * @param {{contract: ValidatedContract, node: ValidatedNode, state: NodeSnapshot, runtime: DriverRuntime & {id: string|null}, prompt: string, paths: PathSet, phase: string, workspace?: string, commandOptions?: import("./drivers/index.mjs").CommandOptions, onInvocation: (invocation: Invocation, job: Job) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} args
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
    driver: runtime.driver,
    env: command.env ?? null,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  });
  let child;
  try {
    child = spawn(process.execPath, ["-e", GATE_SCRIPT], {
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
 * Observe a bounded prefix while the provider is live. Driver normalizers know
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
  } catch {}
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
    const parser = job.monitorParser ?? (job.monitorParser = new SessionMetricsParser(job.runtime.driver));
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
async function terminateProcess(job, options = {}) {
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

/** @param {string} runDir */
function assertRunMutable(runDir) {
  if (!existsSync(join(runDir, "incident-freeze.json"))) return;
  const error = /** @type {Error & {code: string}} */ (new Error("incident_frozen: run is frozen as immutable incident evidence"));
  error.code = "incident_frozen";
  throw error;
}

/**
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string|null}
 */
function boundedChars(value, maxChars) {
  if (typeof value !== "string" || !value.trim()) return null;
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

/**
 * Derive the run-level liveness state from the node snapshots alone.
 * A run awaiting a provider backoff is persisted as a pending node whose
 * routing override carries a future backoffUntil, so that shape - and only
 * that shape - derives paused_quota. A snapshot where every node is already
 * terminal is never paused_quota: terminal exhaustion with no remaining
 * failover route reports failed instead.
 *
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
export function livenessState(states) {
  const all = [...states.values()];
  const running = all.filter((state) => state.status === "running");
  if (running.some((state) => state.phase !== "judge")) return "running";
  if (running.length > 0) return "waiting_gate";
  if (all.some((state) => state.status === "blocked")) return "blocked";
  if (all.length > 0 && all.every((state) => state.status === "done")) return "done";
  if (all.length > 0 && all.every((state) => TERMINAL.has(state.status))) return "failed";
  if (all.some((state) => state.status === "pending" && routingBackoffActive(state, state.phase))) return "paused_quota";
  return "running";
}

/**
 * One notify queue per run, so retries and the notify.jsonl receipt log stay
 * scoped to the run that owns them across the whole controller lifetime.
 * @type {Map<string, NotifyQueue>}
 */
const notifyQueuesByRun = new Map();

/** @param {string} runDir @returns {NotifyQueue} */
function notifyQueueFor(runDir) {
  let queue = notifyQueuesByRun.get(runDir);
  if (!queue) {
    queue = new NotifyQueue({ runDir });
    notifyQueuesByRun.set(runDir, queue);
  }
  return queue;
}

/**
 * The projector error code of a terminal node event. A `blocked_context`
 * worker result is persisted by the runner as error code `context_missing`;
 * it is classified as the blocking question it is, so the notify template
 * carries the worker's own terminal status code.
 *
 * @param {NodeSnapshot} state
 * @returns {string|null}
 */
function terminalErrorCode(state) {
  const result = state.result && typeof state.result === "object" ? /** @type {{status?: unknown}} */ (state.result) : {};
  if (result.status === "blocked_context") return "blocked_context";
  const error = state.error && typeof state.error === "object" ? /** @type {{code?: unknown}} */ (state.error) : {};
  return typeof error.code === "string" && error.code ? error.code : null;
}

/**
 * Whether `notify.jsonl` already carries a receipt for this exact logical
 * event. A resumed controller starts a fresh in-memory notify queue, so
 * without this durable check it would re-notify every node that was already
 * terminal before the resume; the durable log is the only thing that
 * survives the process boundary.
 *
 * @param {string} runDir
 * @param {string} dedupeKey
 * @returns {boolean}
 */
function alreadyNotified(runDir, dedupeKey) {
  const path = join(runDir, "notify.jsonl");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).dedupeKey === dedupeKey) return true;
    } catch {
      // A torn trailing line was never a committed receipt.
    }
  }
  return false;
}

/**
 * @param {CampaignRef} campaign
 * @param {string} runsDir
 * @param {string} runDir
 * @returns {boolean}
 */
function renderCampaignHandoffSafely(campaign, runsDir, runDir) {
  try {
    renderHandoff(campaign.path, runsDir);
    return true;
  } catch (error) {
    /** @type {Record<string, unknown>} */
    const diagnostic = {
      type: "campaign.handoff-failed",
      at: new Date().toISOString(),
      campaignId: campaign.campaign.id,
      error: errorMessage(error),
    };
    try {
      appendJsonl(join(runDir, "events.jsonl"), diagnostic);
    } catch {
      // A failed diagnostic must not abort the controller either.
    }
    process.stderr.write(`[warn] campaign handoff render failed: ${errorMessage(error)}\n`);
    return false;
  }
}

/**
 * @param {string} contractPath
 * @returns {Promise<RunOutcome>}
 */
export async function runContract(contractPath) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContract(JSON.parse(readFileSync(absoluteContractPath, "utf8")), absoluteContractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
  mkdirSync(join(contract.cwd, ".runs"), { recursive: true });
  try {
    mkdirSync(runDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error(`run already exists: ${runDir}`);
    throw error;
  }
  const lock = acquireLock(runDir);
  try {
    const runtimePlan = await runtimeAssignments(contract);
    const scopeBoundaries = captureNodeScopeBoundaries(contract);
    const sourceIdentity = await captureRunIdentity(contract, scopeBoundaries);
    const integrationRef = createRunRef(contract.cwd, contract.id, sourceIdentity.gitHead);
    lock.assert();
    const runsDir = join(contract.cwd, ".runs");
    const campaign = resolveCampaign(runsDir, contract.campaignId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    mkdirSync(join(runDir, "logs"), { recursive: true });
    writeJsonAtomic(join(runDir, "contract.json"), serializableContract(contract));
    writeJsonAtomic(join(runDir, "judge.schema.json"), JUDGE_SCHEMA);
    writeJsonAtomic(join(runDir, "run.json"), createRunMetadata(lock, sourceIdentity, {}, integrationRef));
    registerRun(campaign.path, contract.id);
    renderCampaignHandoffSafely(campaign, runsDir, runDir);

    const states = new Map();
    for (const node of contract.nodes) {
      /** @type {NodeSnapshot} */
      const state = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        contractVersion: INTENT_FACTORY_VERSION,
        id: node.id,
        type: node.type,
        sourceIdentity: node.sourceIdentity,
        packetHash: node.packetHash,
        status: "pending",
        phase: "waiting",
        attempt: 0,
        revisions: 0,
        runtime: null,
        blockedBy: [],
        startedAt: null,
        updatedAt: new Date().toISOString(),
        result: null,
        verification: null,
        scope: emptyScope(/** @type {import("./verification.mjs").WorkspaceScopeBoundary} */ (scopeBoundaries.get(node.id))),
        gate: null,
        error: null,
        judgeFailures: 0,
        routing: {
          history: [],
          currentOverride: null,
          assignments: runtimePlan.assignments[node.id],
          availability: runtimePlan.availability,
        },
        progress: null,
        invocations: [],
        executionOverrides: [],
        worktree: { status: "unassigned", path: null, branch: null, commit: null, baseSha: null },
        integratedHead: null,
      };
      states.set(node.id, state);
      writeNode(runDir, state, lock);
    }
    syncAgentSignal(runsDir);
    const outcome = await driveRun(contract, runDir, states, campaign, lock, sourceIdentity);
    syncAgentSignal(runsDir);
    return outcome;
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Resolve role assignments once at run creation. Discovery is used only for
 * omitted roles; the resulting pair is persisted so resume is deterministic.
 *
 * @param {ValidatedContract} contract
 * @returns {Promise<{assignments: Record<string, {worker: string, judge: string, composedWorker: boolean, composedJudge: boolean}>, availability: Record<string, import("./runtime-discovery.mjs").RuntimeAvailability>}>}
 */
async function runtimeAssignments(contract) {
  const needsComposition = contract.nodes.some((node) =>
    (node.runtime === undefined && contract.runtimeDefaults?.worker === undefined)
    || (node.gate.enabled && node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined));
  const availability = needsComposition ? await discoverRuntimes(contract.runtimes, { cwd: contract.cwd }) : {};
  const assignments = composeAssignments(contract, availability);
  return {
    assignments: Object.fromEntries(Object.entries(assignments).map(([nodeId, assignment]) => {
      const node = contract.nodes.find((candidate) => candidate.id === nodeId);
      return [nodeId, {
        ...assignment,
        composedWorker: node?.runtime === undefined && contract.runtimeDefaults?.worker === undefined,
        composedJudge: Boolean(node?.gate.enabled && node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined),
      }];
    })),
    availability,
  };
}

/**
 * @param {string} runDirPath
 * @param {{node?: string, reconcile?: string}} [options] `node` limits the
 *   retry in place to one node and its dependants, and `reconcile`
 *   acknowledges a node stopped as `unknown_effect_reconciled`
 * @returns {Promise<RunOutcome>}
 */
export async function resumeRun(runDirPath, options = {}) {
  const runDir = resolve(runDirPath);
  assertRunMutable(runDir);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  const lock = acquireLock(runDir);
  try {
    const storedMetadata = validateRunMetadata(readJson(join(runDir, "run.json")), { requireSourceIdentity: true });
    if (!gitHead(contract.cwd, runRefName(contract.id))) throw new Error(`integration ref is unavailable for ${contract.id}`);
    const states = new Map(readRunNodes(runDir, contract).map((state) => [state.id, state]));
    for (const state of states.values()) {
      state.usage = invocationUsage(state);
      state.costUsd = invocationCost(state);
    }
    const scopeBoundaries = new Map(contract.nodes.map((node) => [
      node.id,
      persistedScopeBoundary(contract, node, states.get(node.id), attemptWorkspace(states.get(node.id)) ?? contract.cwd),
    ]));
    const sourceIdentity = await captureRunIdentity(contract, scopeBoundaries);
    const identity = assertSourceUnchanged(storedMetadata.sourceIdentity, sourceIdentity);
    // A resume is an explicit instruction to continue the run: it consumes a
    // stale cancel request instead of letting it re-cancel the retried nodes.
    if (existsSync(join(runDir, "cancel.request.json"))) {
      unlinkSync(join(runDir, "cancel.request.json"));
      process.stdout.write(`[resume] ${contract.id} · consumed cancel request\n`);
    }
    const runsDir = join(runDir, "..");
    const campaign = resolveCampaign(runsDir, contract.campaignId);
    registerRun(campaign.path, contract.id);
    await recoverIntegrationTransactions(contract, runDir, states, lock, campaign.path);
    const plan = planResumeRetry(contract, states, { node: options.node, reconcile: options.reconcile });
    for (const item of plan.attention) {
      process.stdout.write(`[run] ${contract.id} attention · ${item.id} · ${item.reason}\n`);
    }
    const resumeMetadata = {
      ...(identity.warnings.length ? { identityWarnings: identity.warnings } : {}),
    };
    for (const node of contract.nodes) {
      const state = states.get(node.id);
      if (!state) continue;
      if (state.status === "done" || isBlockedContextTerminal(state)) continue;
      const action = plan.actions.get(node.id) ?? "recover";
      // Adoption before retry: an unresolved blocking review is re-judged from
      // the preserved worker result, never reset to a fresh worker attempt.
      if (action === "rejudge") {
        transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lock);
        continue;
      }
      if (action === "hold") continue;
      if (action === "retry") {
        if (isUnknownEffectStop(state)) {
          recordExecutionOverride(runDir, state, {
            kind: "recovery",
            decision: "reconcile_acknowledged",
            reason: `unknown_effect_reconciled acknowledged by --reconcile; node ${node.id} is re-dispatched`,
          }, lock);
        }
        state.previousAttempt = renderPreviousAttemptSection(state) ?? state.previousAttempt;
        transition(runDir, state, "pending", { phase: "worker", error: null, blockedBy: [] }, lock);
        continue;
      }
      const lastInvocation = state.invocations?.at(-1);
      await recoverVerificationAttempts(runDir, state, lock);
      const pendingStart = state.status === "pending" && (state.phase === "worker" || state.phase === "judge") && lastInvocation?.status === "active";
      if (!pendingStart && state.status === "pending" && (state.phase === "worker" || state.phase === "judge")) continue;
      const lastInvocationId = lastInvocation?.id;
      const persistedRecovery = lastInvocationId
        ? [...(state.executionOverrides ?? [])].reverse().find((item) => {
          const record = /** @type {Record<string, unknown>} */ (item);
          return record.kind === "recovery" && record.invocationId === lastInvocationId;
        })
        : undefined;
      const recoveryState = pendingStart ? /** @type {NodeSnapshot} */ ({ ...state, status: "running" }) : state;
      const recovery = (state.status === "running" || pendingStart) && persistedRecovery
        ? recoveryFromOverride(persistedRecovery, lastInvocationId)
        : await recoverOrphan(runDir, contract, node, recoveryState, lock);
      await persistRecoveryUsage(runDir, state, recovery, lock);
      if (recovery?.kind === "reconciled") {
        transition(runDir, state, "blocked", {
          phase: recovery.phase ?? "worker",
          error: {
            code: "unknown_effect_reconciled",
            message: excerpt(recovery.reason ?? "unknown effect requires manual reconciliation"),
          },
        }, lock);
        continue;
      }
      if (recovery?.kind === "exhausted") {
        const invocation = state.invocations?.find((item) => item.id === recovery.invocationId);
        const hadUsage = Boolean(invocation?.usage);
        const hadCost = invocation ? Object.hasOwn(invocation, "costUsd") : false;
        state.invocations = closePersistedInvocation(
          state.invocations,
          recovery.invocationId,
          hadUsage ? undefined : recovery.usage,
          hadCost ? undefined : recovery.costUsd,
        );
        state.costUsd = invocationCost(state);
        writeNode(runDir, state, lock);
        settleInvocation(runDir, /** @type {string | Invocation} */ (invocation ?? recovery.invocationId), {
          status: "exhausted",
          usage: invocation?.usage ?? recovery.usage ?? null,
          costUsd: typeof invocation?.costUsd === "number" ? invocation.costUsd : recovery.costUsd ?? null,
          receipts: providerReceiptsFromInvocationTail(contract, invocation),
          error: recovery.error ?? null,
        });
        handleProviderExhaustion(
          contract,
          runDir,
          node,
          state,
          recovery.phase ?? (invocation?.phase === "judge" ? "judge" : "worker"),
          {
            status: "exhausted",
            result: null,
            continuationId: null,
            usage: recovery.usage ?? invocation?.usage ?? emptyUsage(),
            costUsd: recovery.costUsd ?? invocation?.costUsd ?? null,
            error: recovery.error ?? { code: "provider_exhausted", message: recovery.reason ?? "provider exhausted" },
          },
          invocation?.runtimeId ?? null,
          lock,
          states,
          campaign.path,
        );
        continue;
      }
      if (recovery?.kind === "stalled") {
        const invocation = state.invocations?.find((item) => item.id === recovery.invocationId);
        const hadUsage = Boolean(invocation?.usage);
        const hadCost = invocation ? Object.hasOwn(invocation, "costUsd") : false;
        state.invocations = closePersistedInvocation(
          state.invocations,
          recovery.invocationId,
          hadUsage ? undefined : recovery.usage,
          hadCost ? undefined : recovery.costUsd,
        );
        state.costUsd = invocationCost(state);
        settleInvocation(runDir, /** @type {string | Invocation} */ (invocation ?? recovery.invocationId), {
          status: "stalled",
          usage: invocation?.usage ?? recovery.usage ?? null,
          costUsd: typeof invocation?.costUsd === "number" ? invocation.costUsd : recovery.costUsd ?? null,
          receipts: providerReceiptsFromInvocationTail(contract, invocation),
          error: recovery.error ?? null,
        });
        transition(runDir, state, "stalled", {
          phase: recovery.phase ?? (invocation?.phase === "judge" ? "judge" : "worker"),
          error: recovery.error ?? { code: "progress_stalled", message: recovery.reason ?? "worker made no progress" },
          usage: state.usage,
        }, lock);
        continue;
      }
      if (recovery?.kind === "adopted" || recovery?.kind === "rejudge") {
        // The run-owned canonical file outranks every provider-derived source:
        // the message, the settlement, and the adopted stream result. A
        // present-but-invalid file surfaces as an invalid result on every
        // recovery path, never as a reason to adopt provider evidence.
        let workerResult;
        try {
          materializeAttemptResult(runDir, state, node);
          workerResult = recovery.phase === "judge"
            ? recoverWorkerResult(runDir, state, contract, node)
            : canonicalWorkerResultText(runDir, node.id) ?? recovery.result;
        } catch (error) {
          await applyInvalidWorkerResult(contract, node, state, runDir, null, lock, errorMessage(error), states, campaign.path);
          continue;
        }
        if (recovery.phase === "worker" && workerResult !== null && workerResult !== undefined) {
          const invocation = recovery.kind === "rejudge"
            ? [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker")
            : state.invocations?.find((item) => item.id === recovery.invocationId);
          // A recovered result-materialization turn keeps its live-path rule:
          // the turn had no workspace authority, so any change is a violation.
          if (!checkPersistedWorkerScope(contract, runDir, state, node, invocation, lock, {
            materialization: isResultMaterializationInvocation(invocation),
          })) continue;
          /** @type {WorkerResult|undefined} */
          let parsedWorkerResult;
          try {
            parsedWorkerResult = parseWorkerResult(String(extractJson(workerResult) ?? workerResult));
          } catch (error) {
            await applyInvalidWorkerResult(contract, node, state, runDir, null, lock, errorMessage(error), states, campaign.path);
            continue;
          }
          if (node.taskPacket.mode === "discovery" && parsedWorkerResult.status === "done") {
            try {
              parseDiscoveryResult(parsedWorkerResult, attemptWorkspace(state) ?? contract.cwd);
            } catch (error) {
              await applyInvalidWorkerResult(contract, node, state, runDir, null, lock, errorMessage(error), states, campaign.path);
              continue;
            }
          }
          state.result = parsedWorkerResult;
          if (parsedWorkerResult.status === "blocked_context") {
            transition(runDir, state, "blocked", {
              phase: "complete",
              result: parsedWorkerResult,
              error: { code: "context_missing", message: parsedWorkerResult.missingContext.join("; ") },
            }, lock);
            continue;
          }
          await executeControllerVerification(contract, runDir, node, state, lock);
          if (!state.verification?.passed) {
            applyVerificationFailure(contract, node, state, runDir, null, lock, states, campaign.path);
            continue;
          }
        } else {
          state.result = workerResult ?? state.result;
        }
        const recoveredInvocation = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
        const hadUsage = Boolean(recoveredInvocation?.usage);
        const hadCost = recoveredInvocation ? Object.hasOwn(recoveredInvocation, "costUsd") : false;
        state.invocations = closePersistedInvocation(
          state.invocations,
          recovery.invocationId,
          hadUsage ? undefined : recovery.usage,
          hadCost ? undefined : recovery.costUsd,
        );
        state.costUsd = invocationCost(state);
        settleInvocation(runDir, /** @type {string | Invocation} */ (recoveredInvocation ?? recovery.invocationId), {
          status: recovery.kind,
          usage: recoveredInvocation?.usage ?? recovery.usage ?? null,
          costUsd: typeof recoveredInvocation?.costUsd === "number" ? recoveredInvocation.costUsd : recovery.costUsd ?? null,
          structuredResult: recovery.result !== null && recovery.result !== undefined,
          result: recovery.result ?? null,
          receipts: providerReceipts(/** @type {{continuationId?: string|null}|null|undefined} */ (/** @type {unknown} */ (recovery))),
        });
        if (!persistedRecovery) recordExecutionOverride(runDir, state, {
          kind: "recovery",
          decision: recovery.kind === "rejudge" ? "rejudge" : "adopted",
          invocationId: recovery.invocationId,
          phase: recovery.phase,
          result: recovery.result,
          usage: recovery.usage,
          costUsd: recovery.costUsd,
          reason: recovery.kind === "rejudge"
            ? `judge invocation ${recovery.invocationId} was not adopted; completed worker stream was re-judged`
            : `${recovery.phase} invocation ${recovery.invocationId} completed after controller loss`,
        }, lock);
        if (recovery.phase === "worker" && node.gate.enabled) {
          transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lock);
        } else if (recovery.phase === "judge") {
          await applyJudgeResult(contract, node, state, recovery.result, runDir, lock, null, states, campaign.path);
        } else {
          await settleDone(contract, node, state, runDir, lock, states, campaign.path, { phase: "complete", error: null, blockedBy: [] });
        }
        continue;
      }
      if (recovery?.kind === "restart") {
        const restartInvocation = state.invocations?.find((item) => item.id === recovery.invocationId)
          ?? [...(state.invocations ?? [])].reverse()[0];
        const unknownEffectId = recovery.invocationId ?? lastInvocationId;
        const recoveryPhase = recovery.phase ?? restartInvocation?.phase ?? "worker";
        // A restart of a result-materialization turn means the one permitted
        // result-only turn already ran and left no canonical result. It must
        // fail terminally instead of becoming fresh implementation work.
        if (restartInvocation?.phase === "worker" && isResultMaterializationInvocation(restartInvocation)) {
          if (recovery.invocationId) {
            state.invocations = closePersistedInvocation(state.invocations, recovery.invocationId, recovery.usage, recovery.costUsd);
            if (!hasOperationSettlement(runDir, recovery.invocationId)) {
              settleInvocation(runDir, restartInvocation, {
                status: "failed",
                error: { code: "missing_worker_result", message: "result-only materialization produced no canonical worker result" },
                reason: recovery.reason ?? undefined,
                nextState: "failed",
              });
            }
          }
          state.costUsd = invocationCost(state);
          transition(runDir, state, "failed", {
            phase: "worker",
            error: { code: "missing_worker_result", message: "result-only materialization produced no canonical worker result before the controller was interrupted" },
          }, lock);
          continue;
        }
        if (recoveryPhase === "worker" || recoveryPhase === "judge") {
          const unknownInvocation = restartInvocation?.id === unknownEffectId
            ? restartInvocation
            : state.invocations?.find((item) => item.id === unknownEffectId);
          const workerInvocation = unknownInvocation?.phase === "worker"
            ? unknownInvocation
            : [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
          const hasUnknownEffect = Boolean(
            unknownEffectId
            && hasOperationIntent(runDir, unknownEffectId)
            && operationNeedsRecovery(runDir, unknownEffectId),
          );
          if (hasUnknownEffect) {
            // The controller died inside the spawn→settlement window: this
            // attempt's workspace effects are unknown until proven otherwise.
            const resolution = await resolveUnknownEffect(contract, runDir, node, state, workerInvocation, lock);
            const targetInvocation = unknownInvocation ?? workerInvocation ?? unknownEffectId;
            const targetUsage = unknownInvocation?.usage ?? recovery.usage ?? null;
            const targetCost = typeof unknownInvocation?.costUsd === "number" ? unknownInvocation.costUsd : recovery.costUsd ?? null;
            settleInvocation(runDir, /** @type {string | Invocation} */ (targetInvocation ?? unknownEffectId), {
              status: resolution.action === "replay" ? "safe_replay" : "reconciled",
              usage: targetUsage,
              costUsd: targetCost,
              receipts: providerReceiptsFromInvocationTail(contract, unknownInvocation ?? workerInvocation),
              unknownEffect: true,
              classification: "unknown_effect",
              reason: resolution.action === "replay"
                ? "unknown_effect resolved as safe replay"
                : resolution.reason,
            });
            if (!persistedRecovery) recordExecutionOverride(runDir, state, {
              kind: "recovery",
              decision: resolution.action === "replay" ? "safe_replay" : "reconciled",
              invocationId: unknownEffectId,
              phase: recoveryPhase,
              reason: resolution.action === "replay"
                ? "unknown_effect resolved as safe replay; scope clean and deterministic verification passed"
                : resolution.reason,
            }, lock);
            if (resolution.action === "replay") {
              if (recoveryPhase === "judge") {
                // A judge has no workspace effect of its own. Replaying it
                // must keep the accepted worker result and schedule a fresh
                // judge invocation rather than rerunning the worker.
                transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lock);
                continue;
              }
            }
            if (resolution.action === "reconcile") {
              transition(runDir, state, "blocked", {
                phase: recoveryPhase,
                error: { code: "unknown_effect_reconciled", message: excerpt(resolution.reason) },
              }, lock);
              continue;
            }
          }
        }
        if (recovery.phase === "worker" || restartInvocation?.phase === "worker") {
          const invocation = restartInvocation
            ?? [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
          if (reconcileAmbiguousWorkerRestart(contract, runDir, node, state, invocation, recovery, persistedRecovery, lock)) continue;
        }
        const recoveredInvocation = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
        const hadUsage = Boolean(recoveredInvocation?.usage);
        const hadCost = recoveredInvocation ? Object.hasOwn(recoveredInvocation, "costUsd") : false;
        if (recovery.invocationId) {
          state.invocations = closePersistedInvocation(
            state.invocations,
            recovery.invocationId,
            hadUsage ? undefined : recovery.usage,
            hadCost ? undefined : recovery.costUsd,
          );
          if (!hasOperationSettlement(runDir, recovery.invocationId)) {
            settleInvocation(runDir, recoveredInvocation ?? recovery.invocationId, {
              status: "restarted",
              usage: recoveredInvocation?.usage ?? recovery.usage ?? null,
              costUsd: typeof recoveredInvocation?.costUsd === "number" ? recoveredInvocation.costUsd : recovery.costUsd ?? null,
              receipts: providerReceiptsFromInvocationTail(contract, recoveredInvocation ?? restartInvocation),
              error: recovery.error ?? null,
              reason: recovery.reason,
            });
          }
        }
        const replayingJudge = recoveryPhase === "judge"
          && (persistedRecovery?.decision === "safe_replay"
            || readOperationSettlement(runDir, recovery.invocationId ?? "")?.status === "safe_replay");
        if (replayingJudge) {
          state.costUsd = invocationCost(state);
          transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lock);
          continue;
        }
        state.costUsd = invocationCost(state);
        if (!persistedRecovery) recordExecutionOverride(runDir, state, {
          kind: "recovery",
          decision: "restart",
          invocationId: recovery.invocationId,
          phase: recovery.phase,
          result: recovery.result,
          usage: recovery.usage,
          costUsd: recovery.costUsd,
          reason: recovery.reason,
        }, lock);
      }
      transition(runDir, state, "pending", { phase: "waiting", error: null, blockedBy: [] }, lock);
    }
    const outcome = await driveRun(contract, runDir, states, campaign, lock, sourceIdentity, resumeMetadata);
    syncAgentSignal(runsDir);
    return outcome;
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * @param {NodeSnapshot} state
 * @returns {boolean}
 */
function isBlockedContextTerminal(state) {
  return state.status === "blocked" && state.error?.code === "context_missing";
}

/**
 * A reconciled unknown effect is a deliberate manual-stop boundary. It must
 * remain blocked on every later resume until a human changes the persisted
 * state; automatically turning it back into pending would replay the effect.
 *
 * @param {NodeSnapshot} state
 * @returns {boolean}
 */
function isUnknownEffectTerminal(state) {
  return state.status === "blocked" && state.error?.code === "unknown_effect_reconciled";
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {CampaignRef} campaign
 * @param {LockHandle} lock
 * @param {SourceIdentity} sourceIdentity
 * @param {{identityWarnings?: string[]}} [resume] resume-only records persisted on the run metadata
 * @returns {Promise<RunOutcome>}
 */
export async function driveRun(contract, runDir, states, campaign, lock, sourceIdentity, resume = {}) {
  lock.assert();
  assertEnvironmentReady(contract, runDir, sourceIdentity);
  const runsDir = join(contract.cwd, ".runs");
  const bootstrapNonce = bootstrapNonceForProcess();
  const detachedBootstrap = hasDetachedBootstrapNonce();
  const runMetadata = createRunMetadata(lock, sourceIdentity, resume, runRefName(contract.id));
  writeJsonAtomic(join(runDir, "run.json"), runMetadata);
  writeJsonAtomic(bootstrapPath(runDir), {
    status: "ready",
    nonce: bootstrapNonce,
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    runDir,
    metadataPath: join(runDir, "run.json"),
    at: new Date().toISOString(),
  });
  writeJsonAtomic(bootstrapAttemptPath(runDir, bootstrapNonce), readJson(bootstrapPath(runDir)));
  cleanupBootstrapAttempts(runDir, bootstrapNonce);
  if (detachedBootstrap) await waitForBootstrapAcknowledgement(runDir, {
      nonce: bootstrapNonce,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
  });
  lock.assert();
  renderCampaignHandoffSafely(campaign, runsDir, runDir);

  /** @type {string|null} */
  let statusFingerprint = null;
  /** @param {boolean} force @param {LockHandle|null} [renderLock] */
  const renderStatusIfChanged = (force = false, renderLock = lock) => {
    const fingerprint = statesFingerprint(states);
    if (!force && fingerprint === statusFingerprint) return;
    statusFingerprint = fingerprint;
    render(runDir, runsDir, contract, states, renderLock);
  };
  let handoffFingerprint = statesFingerprint(states);
  const renderHandoffIfChanged = () => {
    const fingerprint = statesFingerprint(states);
    if (fingerprint === handoffFingerprint) return;
    handoffFingerprint = fingerprint;
    renderCampaignHandoffSafely(campaign, runsDir, runDir);
  };
  // Progress never notifies (TECH-SPEC lean, rule 6): only a node reaching a
  // terminal state wakes the notify queue. status.json (written every render)
  // is the progress surface now.
  const notifyQueue = notifyQueueFor(runDir);
  /** @type {string|null} */
  let notificationFingerprint = null;
  const notifyStateChanges = async () => {
    await notifyQueue.pump();
    const fingerprint = statesFingerprint(states);
    if (fingerprint === notificationFingerprint) return;
    notificationFingerprint = fingerprint;
    for (const state of states.values()) {
      if (!TERMINAL.has(state.status)) continue;
      const runId = basename(runDir);
      const dedupeKey = `node.terminal:${runId}:${state.id}:${state.status}:${state.attempt ?? 0}:${state.revisions ?? 0}`;
      if (alreadyNotified(runDir, dedupeKey)) continue;
      await notifyQueue.enqueue({
        type: "node.terminal",
        campaignId: campaign.campaign.id,
        runId,
        nodeId: state.id,
        status: state.status,
        attempt: state.attempt ?? 0,
        errorCode: terminalErrorCode(state),
        dedupeKey,
      });
    }
  };

  /** @type {Map<string, Job>} */
  const running = new Map();
  let canceled = false;
  const cancel = () => { canceled = true; };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  process.once("SIGHUP", cancel);
  try {
    while ([...states.values()].some((state) => !TERMINAL.has(state.status))) {
      lock.assert();
      if (existsSync(join(runDir, "cancel.request.json"))) canceled = true;
      if (canceled) {
        const jobs = [...running.values()];
        await Promise.all(jobs.map((job) => terminateProcess(job)));
        const envelopes = new Map();
        for (const job of jobs) envelopes.set(job.invocation.id, recordInvocationUsage(job, { accumulate: false }));
        for (const job of jobs) {
          const invocation = job.state.invocations?.find((item) => item.id === job.invocation.id) ?? job.invocation;
          const scopeOk = job.phase !== "worker" || checkWorkerScope(contract, runDir, job, lock);
          settleInvocation(runDir, invocation, {
            status: scopeOk ? "canceled" : "failed",
            usage: invocation.usage ?? null,
            costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
            receipts: providerReceipts(envelopes.get(job.invocation.id)),
            error: scopeOk ? null : job.state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
            nextState: operationNextState(job.state),
          });
        }
        running.clear();
        for (const state of states.values()) {
          if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled" }, lock);
        }
        break;
      }

      await finalizeClosedJobs(contract, runDir, states, running, lock, campaign.path);
      await detectStalls(contract, running, async (job, status, error) => {
        const envelope = recordInvocationUsage(job);
        job.state.usage = invocationUsage(job.state);
        job.state.costUsd = invocationCost(job.state);
        const invocation = job.state.invocations?.find((item) => item.id === job.invocation.id) ?? job.invocation;
        appendUsageRecord(runDir, invocation);
        if (job.phase === "worker" && !checkWorkerScope(contract, runDir, job, lock)) {
          settleInvocation(runDir, invocation, {
            status: "failed",
            usage: invocation.usage ?? null,
            costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
            receipts: providerReceipts(envelope),
            error: job.state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
            nextState: operationNextState(job.state),
          });
          return;
        }
        settleInvocation(runDir, invocation, {
          status,
          usage: invocation.usage ?? null,
          costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
          receipts: providerReceipts(envelope),
          error,
          nextState: operationNextState(job.state),
        });
        // A judge killed on its own wall clock produced no verdict. That is a
        // judge protocol defect, not a node outcome: it earns the one bounded
        // re-ask, and only then the review mode settles the node.
        if (job.phase === "judge" && error.code === "wall_clock_timeout") {
          await applyJudgeProtocolFailure(contract, job.node, job.state, runDir, running, lock, states, campaign.path, error.message);
          return;
        }
        transition(runDir, job.state, status, { phase: job.phase, error }, lock);
      }, async (job) => {
        writeNode(runDir, job.state, lock);
      });
      blockDependents(contract, runDir, states, lock);

      const slots = contract.maxParallel - running.size;
      if (slots > 0) {
        const ready = contract.nodes.filter((node) => {
          const state = states.get(node.id);
          return state?.status === "pending" && node.dependsOn.every((id) => states.get(id)?.status === "done");
        });
        for (const node of ready.slice(0, slots)) {
          const state = states.get(node.id);
          if (!state || routingBackoffActive(state, state.phase)) continue;
          if (state.phase === "judge" && state.result) {
            await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaign.path);
            continue;
          }
          state.attempt += 1;
          const prompt = state.gate?.verdict === "fail" ? retryPrompt(node, state.gate) : node.prompt;
          startWorker(contract, node, state, runDir, running, prompt, lock, states, campaign.path);
        }
      }

      renderHandoffIfChanged();
      renderStatusIfChanged();
      await notifyStateChanges();
      if ([...states.values()].some((state) => !TERMINAL.has(state.status))) await delay(contract.pollIntervalMs);
    }
  } catch (error) {
    if (!(error instanceof LockLostError)) throw error;
    await Promise.all([...running.values()].map((job) => terminateProcess(job)));
    notifyQueuesByRun.delete(runDir);
    return { runDir, states, ok: false, error };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGHUP", cancel);
    lock.release();
  }
  renderStatusIfChanged(false, null);
  renderCampaignHandoffSafely(campaign, runsDir, runDir);
  writeFindingsArtifact(runDir, contract, states);
  const failed = [...states.values()].filter((state) => state.status !== "done");
  const runId = basename(runDir);
  const runDedupeKey = `run.terminal:${runId}:${failed.length ? "attention" : "done"}`;
  if (!alreadyNotified(runDir, runDedupeKey)) {
    await notifyQueue.enqueue({
      type: "run.terminal",
      campaignId: campaign.campaign.id,
      runId,
      done: states.size - failed.length,
      total: states.size,
      dedupeKey: runDedupeKey,
    });
  }
  // No more ticks will run to retry a failed delivery: exhaust the bounded
  // retry budget here, in real time, before the controller returns.
  await notifyQueue.drain();
  notifyQueuesByRun.delete(runDir);
  process.stdout.write(`[run] ${contract.id} ${failed.length ? `failed · ${runDir} · findings.json` : `done · ${runDir}`}\n`);
  if ([...states.values()].some((state) => state.usage)) {
    const report = renderFinalReport(runDir, contract, states);
    process.stdout.write(report);
  }
  return { runDir, states, ok: failed.length === 0 };
}

/**
 * @param {LockHandle} lock
 * @param {SourceIdentity} sourceIdentity
 * @param {{identityWarnings?: string[]}} [resume]
 * @param {string} [integrationRef]
 * @returns {RunMetadata}
 */
function createRunMetadata(lock, sourceIdentity, resume = {}, integrationRef = undefined) {
  const current = lock.current;
  const metadata = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    pid: current.pid,
    processStartToken: current.processStartToken,
    startedAt: current.startedAt,
    sourceIdentity,
    ...(integrationRef ? { integrationRef } : {}),
    ...(resume.identityWarnings?.length ? { identityWarnings: resume.identityWarnings } : {}),
  };
  return validateRunMetadata(metadata);
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {"worker"|"judge"} role
 * @returns {RuntimeSnapshot}
 */
function routeRuntimeForState(contract, node, state, role) {
  const override = state.routing?.currentOverride;
  if (override?.role === role && contract.runtimes[override.runtime]) {
    const runtime = contract.runtimes[override.runtime];
    return { id: override.runtime, ...runtime, capabilities: driverCapabilities(runtime) };
  }
  const assigned = state.routing?.assignments?.[role];
  if (assigned && contract.runtimes[assigned]) {
    const runtime = contract.runtimes[assigned];
    return { id: assigned, ...runtime, capabilities: driverCapabilities(runtime) };
  }
  return /** @type {RuntimeSnapshot} */ (routeRuntime(contract, node, role));
}

/**
 * Select the only continuation that is allowed for this plan phase and role.
 * The search is intentionally limited to persisted node snapshots in this run.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {"worker"|"judge"} role
 * @param {string} prompt
 * @returns {{prompt: string, continuationId: string|null, mode: "fresh"|"reuse"|"rotate"}}
 */
function phaseInvocationPlan(contract, node, state, runDir, role, prompt) {
  const runId = basename(runDir);
  const session = phaseSessionCandidates(contract, node, state, runDir, role).at(-1);
  const runtime = routeRuntimeForState(contract, node, state, role);
  const identityMatches = session && session.invocation.runId === runId
    && session.invocation.campaignId === contract.campaignId
    && session.invocation.planPhase === node.phase
    && session.invocation.role === role
    && session.invocation.driver === runtime.driver
    && session.invocation.runtimeId === runtime.id
    && session.invocation.runtimeFingerprint === fingerprintRuntime(runtime)
    && session.invocation.model === runtime.model
    && session.invocation.reasoning === (runtime.reasoning ?? null)
    && session.invocation.sandbox === (runtime.sandbox ?? null);
  const canContinue = runtime.capabilities.continuation === true;
  if (identityMatches && canContinue) {
    return { prompt, continuationId: session.invocation.continuationId ?? null, mode: "reuse" };
  }
  // A driver that cannot continue at all, or a session picked up from a
  // different phase-sibling node whose identity does not match this one, has
  // no native continuity: the fresh attempt carries the prior nodes'
  // structured summaries forward instead of starting blind.
  if (session && (!canContinue || session.nodeId !== node.id)) {
    return {
      prompt: phaseHandoffPrompt(contract, node, state, runDir, role),
      continuationId: null,
      mode: "rotate",
    };
  }
  // A capable driver continuing its own node whose identity merely drifted
  // (the run directory moved, or a runtime edge) still gets the caller's own
  // prompt — already carrying the node's bounded "Previous attempt" section —
  // in a fresh session, never a synthesized handoff.
  return { prompt, continuationId: null, mode: session ? "rotate" : "fresh" };
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} currentState
 * @param {string} runDir
 * @param {"worker"|"judge"} role
 * @returns {{nodeId: string, invocation: Invocation}[]}
 */
function phaseSessionCandidates(contract, node, currentState, runDir, role) {
  /** @type {{nodeId: string, invocation: Invocation}[]} */
  const candidates = [];
  for (const candidate of contract.nodes) {
    if (candidate.phase !== node.phase) continue;
    let state = candidate.id === currentState.id ? currentState : null;
    if (!state) {
      try { state = validateNodeSnapshot(readJson(join(runDir, "nodes", `${candidate.id}.json`)), candidate); } catch { continue; }
    }
    for (const invocation of state.invocations ?? []) {
      if (invocation.role !== role || invocation.planPhase !== node.phase || !invocation.continuationId) continue;
      if (invocation.nodeId !== candidate.id || invocation.attempt !== state.attempt || invocation.workspace !== state.worktree?.path) continue;
      candidates.push({ nodeId: candidate.id, invocation });
    }
  }
  return candidates.sort((left, right) => {
    const leftStarted = Date.parse(left.invocation.startedAt);
    const rightStarted = Date.parse(right.invocation.startedAt);
    if (leftStarted !== rightStarted) return leftStarted - rightStarted;
    const leftUpdated = Date.parse(left.invocation.updatedAt);
    const rightUpdated = Date.parse(right.invocation.updatedAt);
    if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;
    return left.invocation.id.localeCompare(right.invocation.id);
  });
}

/** @param {Invocation} invocation @param {ValidatedContract} contract @param {ValidatedNode} node @param {RuntimeSnapshot} runtime @param {NodeSnapshot} state @param {string} runDir @param {"worker"|"judge"} role @param {"fresh"|"reuse"|"rotate"} mode @param {string|null} continuationId */
function stampInvocation(invocation, contract, node, runtime, state, runDir, role, mode, continuationId) {
  invocation.runId = basename(runDir);
  invocation.campaignId = contract.campaignId;
  invocation.nodeId = node.id;
  invocation.attempt = state.attempt;
  invocation.workspace = attemptWorkspace(state) ?? contract.cwd;
  invocation.worktreeBranch = state.worktree?.branch ?? null;
  invocation.worktreeBaseSha = state.worktree?.baseSha ?? null;
  invocation.planPhase = node.phase;
  invocation.role = role;
  invocation.runtimeFingerprint = fingerprintRuntime(runtime);
  invocation.model = runtime.model;
  invocation.reasoning = runtime.reasoning ?? null;
  invocation.sandbox = runtime.sandbox ?? null;
  invocation.continuationId = continuationId;
  invocation.continuationMode = mode;
}

/** @param {RuntimeSnapshot} runtime @returns {string} */
function fingerprintRuntime(runtime) {
  const executable = providerCommand(runtime, "").executable;
  return createHash("sha256").update(stableJson({ runtime, executable })).digest("hex");
}

/** @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {"worker"|"judge"} role @returns {string} */
function phaseHandoffPrompt(contract, node, state, runDir, role) {
  const summaries = phaseSessionCandidates(contract, node, state, runDir, role)
    .map(({ nodeId }) => {
      const candidate = contract.nodes.find((item) => item.id === nodeId);
      let snapshot = null;
      try { snapshot = readJson(join(runDir, "nodes", `${nodeId}.json`)); } catch {}
      const result = snapshot?.result;
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? /** @type {Record<string, unknown>} */ (result)
        : null;
      const summary = typeof record?.summary === "string" ? record.summary : null;
      return summary && candidate ? `${candidate.id}: ${boundedUtf8(summary, 1024)}` : null;
    })
    .filter(Boolean)
    .slice(-8);
  const handoff = [
    `Continue phase ${node.phase} as the ${role} agent in a fresh provider session.`,
    "Prior structured node summaries:",
    summaries.length ? summaries.map((summary) => `- ${summary}`).join("\n") : "- (none)",
    "Current closed task packet:",
    boundedUtf8(node.prompt, 48 * 1024),
  ].join("\n\n");
  return boundedUtf8(handoff, 60 * 1024);
}

/**
 * The mechanical worker tool policy for the provider boundary: hook settings
 * on Claude-compatible commands. Only an adapter whose surface can prove
 * enforcement (`capabilities.toolPolicy`) receives it; prompt text is not
 * enforcement.
 *
 * @param {RuntimeSnapshot} runtime
 * @returns {import("./drivers/index.mjs").ToolPolicy|undefined}
 */
function workerToolPolicy(runtime) {
  if (runtime.capabilities.toolPolicy !== true) return undefined;
  return { foregroundOnly: true, maxToolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES };
}

/**
 * Build the bounded options shared by workers, judges, and gate revisions.
 * Only provider session continuation travels here; time is the controller's
 * only attempt control.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {RuntimeSnapshot} runtime
 * @param {{prompt: string, continuationId: string|null, mode: "fresh"|"reuse"|"rotate"}} phasePlan
 * @param {string} runDir
 * @param {LockHandle} lock
 * @param {import("./drivers/index.mjs").CommandOptions} [extra]
 * @returns {import("./drivers/index.mjs").CommandOptions}
 */
function invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, extra = {}) {
  return {
    ...extra,
    continuationId: runtime.capabilities.continuation === true ? phasePlan.continuationId : null,
  };
}

/** @param {NodeSnapshot|undefined} state @returns {string|null} */
function attemptWorkspace(state) {
  const path = state?.worktree?.path;
  return path && state?.worktree?.status !== "removed" && existsSync(path) ? path : null;
}

/**
 * Seal the worktree the previous attempt left behind so its edits become the
 * base of the next attempt instead of being abandoned in a discarded
 * worktree (TECH-SPEC lean v0.3 section 3 rule 4). By the time this runs,
 * `state.worktree` still points at the previous attempt — the caller always
 * increments `state.attempt` before dispatching the next one — so that
 * attempt's number is `state.attempt - 1`. Returns null when there is no
 * previous worktree to seal, or it carries no diff from its own base: the
 * next attempt is then cut from the integration head as before.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @returns {{sha: string, attempt: number}|null}
 */
function sealPreviousAttempt(contract, node, state) {
  const path = attemptWorkspace(state);
  if (!path || !state.worktree?.branch || !state.worktree.baseSha) return null;
  const attempt = state.attempt - 1;
  const sealed = sealAttempt({
    repo: contract.cwd,
    path,
    baseSha: state.worktree.baseSha,
    runId: contract.id,
    nodeId: node.id,
    attempt,
  });
  return sealed.empty ? null : { sha: sealed.sha, attempt };
}

/**
 * Create the isolated workspace for the current attempt, or reuse the exact
 * one already recorded for a controller restart. A retried attempt continues
 * from the previous attempt's sealed sha rather than a fresh cut from the
 * integration head, so sealed work is never abandoned in a discarded
 * worktree.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LockHandle} lock
 * @returns {string}
 */
function ensureAttemptWorkspace(contract, node, state, runDir, lock) {
  const expectedPath = attemptWorktreePath(runDir, contract.id, node.id, state.attempt);
  if (state.worktree?.path === expectedPath && attemptWorkspace(state)) return expectedPath;
  const previous = sealPreviousAttempt(contract, node, state);
  const worktree = createAttemptWorktree({
    repo: contract.cwd,
    runDir,
    runId: contract.id,
    nodeId: node.id,
    attempt: state.attempt,
    base: previous?.sha,
  });
  const boundary = captureWorkspaceScope(worktree.path, workerScope(node.taskPacket));
  state.worktree = previous ? { ...worktree, previousAttempt: previous.attempt } : worktree;
  state.scope = emptyScope(boundary);
  writeNode(runDir, state, lock);
  return worktree.path;
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 * @param {string} campaignPath
 * @returns {Promise<import("./integrate.mjs").IntegrationResult|null>}
 */
async function recoverIntegrationTransactions(contract, runDir, states, lock, campaignPath) {
  return recoverIntegrations({
    repo: contract.cwd,
    runDir,
    runId: contract.id,
    verifyCandidate: async (workspace, transaction) => {
      const node = contract.nodes.find((candidate) => candidate.id === transaction.node);
      const state = states.get(transaction.node);
      if (!node || !state) return { passed: false, error: "journal references an unknown node" };
      return verifyCandidateWorkspace(contract, node, state, runDir, workspace);
    },
    onAccepted: async (transaction) => {
      const state = states.get(transaction.node);
      if (!state) return;
      // Once a `done` transition for this attempt was already durably
      // recorded, every effect this transaction owns (ref move, done-write,
      // cleanup, terminal event) was already fully applied — on some earlier
      // resume, or in the same process that accepted it. A later reset of
      // node status (recovery exercising a different concern for the same
      // attempt) is not evidence that the crash this callback recovers from
      // ever happened; forcing "done" again here would stomp that unrelated
      // recovery outcome.
      if (state.attempt === transaction.attempt && hasDoneEvent(runDir, state.id, state.attempt)) return;
      const path = state.attempt === transaction.attempt && state.worktree?.path
        ? state.worktree.path
        : attemptWorktreePath(runDir, contract.id, transaction.node, transaction.attempt);
      if (state.attempt === transaction.attempt && state.status !== "done") {
        transition(runDir, state, "done", {
          phase: "complete",
          integratedHead: transaction.candidateSha,
          worktree: { ...(state.worktree ?? {}), status: "removed", commit: transaction.attemptSha, baseSha: transaction.previousRunRefTip },
        }, lock);
      }
      if (state.attempt === transaction.attempt && state.status === "done") ensureTerminalEvent(runDir, state, lock);
      removeWorktree(contract.cwd, path);
    },
    onVerificationFailure: async (transaction) => {
      const node = contract.nodes.find((candidate) => candidate.id === transaction.node);
      const state = states.get(transaction.node);
      if (!node || !state || TERMINAL.has(state.status)) return;
      const verdict = verificationFailureWithScope(verificationFailureVerdict(state), state.scope);
      verdict.summary = "integrated candidate verification failed during recovery";
      applyRejection(contract, node, state, runDir, null, lock, states, campaignPath, verdict, {
        code: "verification_failed",
        label: "candidate-verification",
      });
    },
    onConflict: async (transaction) => {
      const state = states.get(transaction.node);
      if (!state || TERMINAL.has(state.status)) return;
      const paths = transaction.conflictingPaths?.length ? transaction.conflictingPaths.join(", ") : "unknown paths";
      transition(runDir, state, "blocked", {
        phase: "complete",
        error: { code: "integration_conflict", message: `integration conflict in: ${paths}` },
      }, lock);
      await raiseNodeAttention(campaignPath, runDir, state, "integration_conflict");
    },
    onConcurrentMove: async (transaction) => {
      const state = states.get(transaction.node);
      if (!state || TERMINAL.has(state.status)) return;
      transition(runDir, state, "blocked", {
        phase: "complete",
        error: { code: "integration_concurrent_move", message: `run ref moved from ${transaction.previousRunRefTip} to ${transaction.currentRunRefTip ?? "unknown"}` },
      }, lock);
      await raiseNodeAttention(campaignPath, runDir, state, "integration_concurrent_move");
    },
  });
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {string} prompt
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 */
function startWorker(contract, node, state, runDir, running, prompt, lock, states, campaignPath) {
  let workspace;
  try {
    workspace = ensureAttemptWorkspace(contract, node, state, runDir, lock);
  } catch (error) {
    state.worktree = { ...(state.worktree ?? {}), status: "failed", path: state.worktree?.path ?? null, branch: state.worktree?.branch ?? null, commit: state.worktree?.commit ?? null, baseSha: state.worktree?.baseSha ?? null };
    transition(runDir, state, "failed", { phase: "worker", error: { code: errorCode(error) ?? "worktree_create_failed", message: errorMessage(error) } }, lock);
    return;
  }
  const runtime = routeRuntimeForState(contract, node, state, "worker");
  const phasePlan = phaseInvocationPlan(contract, node, state, runDir, "worker", prompt);
  // The previous-attempt section still has to survive on a retried attempt,
  // so it is appended to the resolved prompt rather than the candidate handed
  // to phaseInvocationPlan.
  phasePlan.prompt = appendPreviousAttempt(phasePlan.prompt, state.previousAttempt);
  // The worker prompt directs the provider to write the canonical result file;
  // make sure the directory exists before the provider is asked to.
  const resultPath = attemptWorkerResultPath(runDir, node.id, workspace);
  mkdirSync(dirname(resultPath), { recursive: true });
  const effectivePrompt = workerProtocolPrompt(phasePlan.prompt, resultPath);
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  if (Buffer.byteLength(effectivePrompt, "utf8") > 64 * 1024) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "worker_prompt_too_large", message: "worker prompt exceeds 65536 bytes" } }, lock);
    return;
  }
  /** @type {import("./verification.mjs").WorkspaceScopeBoundary} */
  let boundary;
  /** @type {unknown} */
  let baseline;
  try {
    boundary = persistedScopeBoundary(contract, node, state, workspace);
    baseline = captureWorkspaceSnapshot(workspace);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: errorMessage(error) } }, lock);
    return;
  }
  const snapshotPath = `${paths.prompt}.snapshot.json`;
  writeJsonAtomic(snapshotPath, baseline);
  state.phase = "worker";
  state.runtime = runtime;
  // A new worker attempt has no accepted result yet. The canonical result
  // file is cleared only when the previous attempt was explicitly rejected
  // (failed gate verdict) or when no valid canonical file exists: a valid
  // file at the start of a continuation attempt is durable evidence and must
  // stay in place so the completion path can adopt it.
  state.result = null;
  state.verification = null;
  state.scope = null;
  let existingCanonicalResult = null;
  try {
    existingCanonicalResult = readWorkerResultFile(runDir, node.id);
  } catch {
    existingCanonicalResult = null;
  }
  clearAttemptWorkerResult(workspace, node.id);
  if (state.gate?.verdict === "fail" || existingCanonicalResult === null) {
    clearWorkerResultFile(runDir, node.id);
  }
  const previousInvocation = state.invocations?.at(-1);
  if (previousInvocation && hasOperationSettlement(runDir, previousInvocation.id)) {
    settleInvocation(runDir, previousInvocation, { nextState: operationNextState(state) });
  }
  state.startedAt ??= new Date().toISOString();
  state.error = null;
  state.scope = emptyScope(boundary);
  writeNode(runDir, state, lock);
  try {
    const job = startProcess({
      contract, node, state, runtime, workspace, prompt: effectivePrompt, paths, phase: "worker",
      commandOptions: invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, {
        toolPolicy: workerToolPolicy(runtime),
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, runtime, state, runDir, "worker", phasePlan.mode, phasePlan.continuationId);
        invocation.snapshotPath = snapshotPath;
        currentJob.scopeBaseline = baseline;
        persistInvocation(runDir, state, invocation, currentJob, lock);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "worker",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(runtime),
          prompt: effectivePrompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lock),
      onProgress: () => writeNode(runDir, state, lock),
    });
    transition(runDir, state, "running", { phase: "worker", runtime, error: null }, lock);
    running.set(node.id, job);
  } catch (error) {
    const invocation = state.invocations?.at(-1);
    if (invocation && hasOperationIntent(runDir, invocation.id) && operationNeedsRecovery(runDir, invocation.id)) {
      settleInvocation(runDir, invocation, {
        status: "failed",
        error: { code: "spawn_error", message: errorMessage(error) },
        reason: "provider did not start",
        nextState: operationNextState(state),
      });
    }
    transition(runDir, state, "failed", { phase: "worker", error: { code: "spawn_error", message: errorMessage(error) } }, lock);
  }
}

/**
 * A completed implementation may have omitted only its durable result. Resume
 * the exact provider session for one turn to materialize that file; never use
 * this path to restart implementation work.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {Invocation} sourceInvocation
 * @param {DriverRuntime & {id: string|null}} runtime
 * @param {string|null} continuationId
 * @param {LockHandle} lock
 */
function startResultMaterialization(contract, node, state, runDir, running, sourceInvocation, runtime, continuationId, lock) {
  const materializationRuntime = runtime.id ? runtimeSnapshot(contract, runtime.id) : null;
  if (!materializationRuntime || materializationRuntime.capabilities.continuation !== true || !continuationId) {
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: "missing_worker_result", message: "worker completed without a canonical result file and this runtime did not provide a resumable session for the one-turn materialization" },
    }, lock);
    return;
  }
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  const resultPath = attemptWorkerResultPath(runDir, node.id, workspace);
  const prompt = [
    `${RESULT_MATERIALIZATION_PROMPT_HEADER} Do not inspect, implement, verify, or invoke tools.`,
    `Your only job in this single bounded turn is to write the required worker-result JSON object to: ${resultPath}`,
    "Then return that same JSON object as the final message.",
  ].join("\n\n");
  let baseline;
  try {
    baseline = captureWorkspaceSnapshot(workspace);
    writeJsonAtomic(`${paths.prompt}.snapshot.json`, baseline);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "result_materialization_snapshot_invalid", message: errorMessage(error) } }, lock);
    return;
  }
  state.phase = "worker";
  state.runtime = materializationRuntime;
  state.error = { code: "result_materialization_pending", message: "awaiting one-turn canonical worker-result materialization" };
  writeNode(runDir, state, lock);
  try {
    const job = startProcess({
      contract, node, state, runtime: materializationRuntime, workspace, prompt, paths, phase: "worker",
      commandOptions: invocationCommandOptions(contract, node, state, materializationRuntime, {
        prompt,
        continuationId,
        mode: "reuse",
      }, runDir, lock, {
        toolPolicy: workerToolPolicy(materializationRuntime),
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, materializationRuntime, state, runDir, "worker", "reuse", continuationId);
        invocation.snapshotPath = `${paths.prompt}.snapshot.json`;
        currentJob.resultMaterialization = true;
        currentJob.recoveryBaseline = baseline;
        persistInvocation(runDir, state, invocation, currentJob, lock);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "worker",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(materializationRuntime),
          prompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lock),
    });
    transition(runDir, state, "running", { phase: "worker", runtime: materializationRuntime }, lock);
    running.set(node.id, job);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "result_materialization_failed", message: errorMessage(error) } }, lock);
  }
}

/** Gate a completed worker: mechanical proofs gate first, the judge arbitrates only judgment items and is skipped when the review mode is `none` or no judgment item exists. A judge protocol re-ask never re-runs the round's mechanical proofs. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>} running @param {unknown} workerResult @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath */
async function startJudge(contract, node, state, runDir, running, workerResult, lock, states, campaignPath) {
  const reaskReason = judgeReaskReason(state);
  const reask = reaskReason !== undefined;
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  const { verdict, results } = await deterministicGate(
    node,
    workspace,
    reask,
    Math.max(1_000, Math.min((node.timeoutSec ?? contract.timeoutSec ?? 60) * 1000, 120_000)),
    /** @type {import("./contract.mjs").VerificationState|null} */ (state.verification),
  );
  state.review = reviewMode(node.gate);
  if (verdict.verdict === "fail") {
    applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, {
      code: "mechanical_gate_failed",
      label: "mechanical-gate",
    });
    return;
  }
  if (!judgeRequired(node)) {
    await settleDone(contract, node, state, runDir, lock, states, campaignPath, { phase: "complete", result: workerResult, gate: verdict });
    return;
  }
  const runtime = routeRuntimeForState(contract, node, state, "judge");
  const paths = logPaths(runDir, node.id, "judge", state.attempt);
  state.phase = "judge";
  state.runtime = runtime;
  const previousInvocation = state.invocations?.at(-1);
  if (previousInvocation && hasOperationSettlement(runDir, previousInvocation.id)) {
    settleInvocation(runDir, previousInvocation, { nextState: operationNextState(state) });
  }
  try {
    const prompt = `${judgePrompt(node, workerResult, {
      diff: state.scope?.changedPaths,
      verification: state.verification,
      deterministic: results,
      scopeFindings: state.scopeFindings,
      previousAttempt: state.previousAttempt,
    })}${reask ? judgeReaskInstruction(reaskReason) : ""}`;
    const phasePlan = phaseInvocationPlan(contract, node, state, runDir, "judge", prompt);
    // judgePrompt already carries the section when phaseInvocationPlan reuses
    // that candidate; appendPreviousAttempt is a no-op then.
    phasePlan.prompt = appendPreviousAttempt(phasePlan.prompt, state.previousAttempt);
    if (Buffer.byteLength(phasePlan.prompt, "utf8") > 64 * 1024) {
      const error = /** @type {Error & {code: string}} */ (new Error("judge prompt exceeds 65536 bytes"));
      error.code = "judge_prompt_too_large";
      throw error;
    }
    const job = startProcess({
      contract, node, state, runtime, workspace,
      prompt: phasePlan.prompt,
      paths, phase: "judge",
      commandOptions: invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, {
        schema: JUDGE_SCHEMA,
        schemaPath: join(runDir, "judge.schema.json"),
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, runtime, state, runDir, "judge", phasePlan.mode, phasePlan.continuationId);
        persistInvocation(runDir, state, invocation, currentJob, lock);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "judge",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(runtime),
          prompt: phasePlan.prompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lock),
    });
    transition(runDir, state, "running", { phase: "judge", runtime }, lock);
    running.set(node.id, job);
  } catch (error) {
    const invocation = state.invocations?.at(-1);
    if (invocation && hasOperationIntent(runDir, invocation.id) && operationNeedsRecovery(runDir, invocation.id)) {
      settleInvocation(runDir, invocation, {
        status: "failed",
        error: { code: /** @type {string} */ (errorCode(error) ?? "spawn_error"), message: errorMessage(error) },
        reason: "provider did not start",
        nextState: operationNextState(state),
      });
    }
    transition(runDir, state, "failed", { phase: "judge", error: { code: /** @type {string} */ (errorCode(error) ?? "spawn_error"), message: errorMessage(error) } }, lock);
  }
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Job} job
 * @param {LockHandle} lock
 */
function persistInvocation(runDir, state, invocation, job, lock) {
  state.invocations = [...(state.invocations ?? []), invocation];
  state.updatedAt = invocation.updatedAt;
  writeNode(runDir, state, lock);
  job.onClose = (closed) => {
    try {
      let continuationId = closed.continuationId ?? null;
      let usage = closed.usage;
      let costUsd = closed.costUsd;
      let envelopeStatus = "closed";
      let structuredResult = null;
      let envelopeResult = null;
      let envelopeError = null;
      try {
        const envelope = normalizeProviderResult(job.runtime, readBoundedTail(job.paths.stdout), job.exitCode, null, { preferStructured: job.phase === "judge" });
        continuationId = envelope.continuationId ?? continuationId;
        usage = envelope.usage;
        costUsd = envelope.costUsd;
        envelopeStatus = envelope.status;
        structuredResult = Boolean(envelope.result);
        envelopeResult = envelope.result ?? null;
        envelopeError = envelope.error ?? null;
      } catch {}
      const completed = { ...closed, continuationId, usage, costUsd };
      state.invocations = (state.invocations ?? []).map((item) => item.id === completed.id ? completed : item);
      state.usage = invocationUsage(state);
      state.costUsd = invocationCost(state);
      state.updatedAt = closed.updatedAt;
      writeNode(runDir, state, lock);
      settleInvocation(runDir, completed, {
        status: envelopeStatus,
        usage,
        costUsd: typeof costUsd === "number" ? costUsd : null,
        structuredResult,
        result: envelopeResult,
        receipts: providerReceipts({ continuationId }),
        error: envelopeError,
        nextState: operationNextState(state),
      });
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
    }
  };
}

/**
 * Persist live provider observations without creating a second invocation
 * record. Continuation identity is authoritative before the provider log is
 * capped or the process is terminated.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {LockHandle} lock
 */
function persistInvocationUpdate(runDir, state, invocation, lock) {
  try {
    state.invocations = (state.invocations ?? []).map((item) => item.id === invocation.id ? invocation : item);
    state.updatedAt = invocation.updatedAt;
    writeNode(runDir, state, lock);
  } catch (error) {
    if (!(error instanceof LockLostError)) throw error;
  }
}

const OPERATIONS_SCHEMA_VERSION = 1;

/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {string}
 */
function operationIntentPath(runDir, invocationId) {
  return join(runDir, "operations", `${invocationId}.intent.json`);
}

/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {string}
 */
function operationSettlementPath(runDir, invocationId) {
  return join(runDir, "operations", `${invocationId}.settlement.json`);
}

/**
 * Reserve the operation durably before the gate releases the provider process.
 * The invocation identity is written before spawn and is the only identity
 * later accepted for settlement or recovery.
 *
 * @param {string} runDir
 * @param {Invocation} invocation
 * @param {{nodeId: string, role: "worker"|"judge", attempt: number, runtimeFingerprint: string, prompt: string}} context
 */
function persistInvocationIntent(runDir, invocation, context) {
  const promptFingerprint = createHash("sha256").update(context.prompt, "utf8").digest("hex");
  writeJsonAtomic(operationIntentPath(runDir, invocation.id), {
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    operationId: invocation.id,
    invocationId: invocation.id,
    runId: invocation.runId ?? basename(runDir),
    campaignId: invocation.campaignId ?? null,
    nodeId: context.nodeId,
    role: context.role,
    phase: invocation.phase,
    planPhase: invocation.planPhase ?? null,
    attempt: context.attempt,
    runtimeId: invocation.runtimeId ?? null,
    runtimeFingerprint: context.runtimeFingerprint,
    promptFingerprint,
    promptHash: promptFingerprint,
    scopeSnapshotPath: context.role === "worker" ? invocation.snapshotPath ?? null : null,
    scopeSnapshotRef: context.role === "worker" ? invocation.snapshotPath ?? null : null,
    startedAt: invocation.startedAt,
    intentAt: new Date().toISOString(),
  });
}

/**
 * Read an operation record without allowing a malformed or mismatched record
 * to become recovery evidence.
 *
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {Record<string, unknown>|null}
 */
function readOperationSettlement(runDir, invocationId) {
  try {
    const record = readJson(operationSettlementPath(runDir, invocationId));
    return record.operationId === invocationId ? record : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {Record<string, unknown>|null}
 */
function readOperationIntent(runDir, invocationId) {
  try {
    const record = readJson(operationIntentPath(runDir, invocationId));
    return record.operationId === invocationId ? record : null;
  } catch {
    return null;
  }
}

/**
 * A preliminary close observation is not a terminal settlement. It can be
 * replaced by the final envelope outcome, while a resolved outcome is never
 * downgraded by a later controller pass.
 */
const UNRESOLVED_OPERATION_STATUSES = new Set(["closed", "unknown_effect"]);
const RESOLVED_OPERATION_STATUSES = new Set(["done", "failed", "exhausted", "stalled", "canceled", "adopted", "rejudge", "restarted", "safe_replay", "reconciled"]);

/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {boolean}
 */
function operationNeedsRecovery(runDir, invocationId) {
  const settlement = readOperationSettlement(runDir, invocationId);
  return !settlement || UNRESOLVED_OPERATION_STATUSES.has(String(settlement.status));
}

/**
 * @param {Invocation|undefined|string} invocationOrId
 * @param {unknown} supplied
 * @param {unknown[]} existing
 * @returns {Record<string, string>[]}
 */
function operationReceipts(invocationOrId, supplied, existing = []) {
  /** @type {Record<string, string>[]} */
  const receipts = [];
  const seen = new Set();
  /** @type {(kind: string, ref: unknown) => void} */
  const add = (kind, ref) => {
    if (typeof ref !== "string" || ref.length === 0) return;
    const key = `${kind}\u0000${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    receipts.push({ kind, ref });
  };
  for (const receipt of existing) {
    if (receipt && typeof receipt === "object") {
      const record = /** @type {Record<string, unknown>} */ (receipt);
      add(String(record.kind ?? "operation"), String(record.ref ?? ""));
    }
  }
  if (Array.isArray(supplied)) {
    for (const receipt of supplied) {
      if (typeof receipt === "string") add("provider", receipt);
      else if (receipt && typeof receipt === "object") {
        const record = /** @type {Record<string, unknown>} */ (receipt);
        add(String(record.kind ?? "provider"), String(record.ref ?? ""));
      }
    }
  }
  const invocation = invocationOrId && typeof invocationOrId === "object" ? invocationOrId : null;
  if (invocation) {
    add("prompt", invocation.promptPath);
    add("stdout", invocation.stdoutPath);
    add("stderr", invocation.stderrPath);
    if (invocation.phase === "worker") add("scope_snapshot", invocation.snapshotPath);
    add("provider", invocation.continuationId);
  }
  return receipts;
}

/**
 * Provider-side evidence from the close path. The continuation identity the
 * provider returned (thread/session) is a durable receipt for the invocation's
 * external effect; the first terminal settlement must persist it.
 *
 * @param {{continuationId?: string|null}|null|undefined} envelope
 * @returns {Record<string, string>[]}
 */
function providerReceipts(envelope) {
  const ref = envelope?.continuationId;
  return typeof ref === "string" && ref.length > 0 ? [{ kind: "provider", ref }] : [];
}

/**
 * Provider receipts still recoverable from an invocation's surviving stream
 * tail. A controller-loss window's first terminal settlement must persist
 * them so repeated settlement/recovery stays idempotent and exact-once.
 *
 * @param {ValidatedContract} contract
 * @param {Invocation|undefined} invocation
 * @returns {Record<string, string>[]}
 */
function providerReceiptsFromInvocationTail(contract, invocation) {
  if (!invocation?.stdoutPath) return [];
  try {
    const runtime = typeof invocation.runtimeId === "string"
      ? runtimeSnapshot(contract, invocation.runtimeId)
      : null;
    if (!runtime) return [];
    const envelope = normalizeProviderResult(
      runtime,
      readBoundedTail(invocation.stdoutPath),
      invocation.exitCode ?? null,
      invocation.signal ?? null,
    );
    return providerReceipts(envelope);
  } catch {
    return [];
  }
}

/** @param {unknown} value @returns {unknown|null} */
function boundedSettlementResult(value) {
  if (value === undefined || value === null) return null;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 64 * 1024) return null;
    return value;
  } catch {
    return null;
  }
}

/** @param {NodeSnapshot} state @returns {Record<string, unknown>} */
function operationNextState(state) {
  return {
    status: state.status,
    phase: state.phase,
    attempt: state.attempt,
    revisions: state.revisions,
  };
}

/**
 * Persist a settlement as an idempotent operation record. The operation keeps
 * its first settledAt timestamp, merges receipts, and retains unknown-effect
 * classification while the controller resolves it.
 *
 * @param {string} runDir
 * @param {Invocation|string} invocationOrId
 * @param {{status?: string, usage?: import("./contract.mjs").Usage|null, costUsd?: number|null, structuredResult?: boolean|null, result?: unknown, receipts?: unknown, nextState?: unknown, terminalOutcome?: unknown, unknownEffect?: boolean, classification?: string, reason?: string, error?: unknown}} settlement
 */
function settleInvocation(runDir, invocationOrId, settlement) {
  const invocation = typeof invocationOrId === "object" ? invocationOrId : undefined;
  const invocationId = typeof invocationOrId === "string" ? invocationOrId : invocation?.id;
  if (!invocationId) throw new TypeError("settlement requires an invocation identity");
  const previous = readOperationSettlement(runDir, invocationId) ?? {};
  const intent = readOperationIntent(runDir, invocationId) ?? {};
  const requestedStatus = settlement.status ?? String(previous.status ?? "unknown_effect");
  const previousStatus = String(previous.status ?? "");
  const status = RESOLVED_OPERATION_STATUSES.has(previousStatus)
    && ["adopted", "rejudge", "restarted"].includes(requestedStatus)
    ? previousStatus
    : requestedStatus;
  const receipts = operationReceipts(invocationOrId, settlement.receipts, Array.isArray(previous.receipts) ? previous.receipts : []);
  const result = settlement.result !== undefined
    ? boundedSettlementResult(settlement.result)
    : previous.result ?? null;
  const record = {
    ...previous,
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    operationId: invocationId,
    invocationId,
    runId: invocation?.runId ?? intent.runId ?? basename(runDir),
    campaignId: invocation?.campaignId ?? intent.campaignId ?? null,
    nodeId: intent.nodeId ?? null,
    role: invocation?.role ?? intent.role ?? null,
    status,
    terminalOutcome: settlement.terminalOutcome ?? previous.terminalOutcome ?? status,
    usage: settlement.usage !== undefined ? settlement.usage : previous.usage ?? null,
    costUsd: settlement.costUsd !== undefined ? settlement.costUsd : previous.costUsd ?? null,
    receipts,
    nextState: settlement.nextState !== undefined ? settlement.nextState : previous.nextState ?? null,
    structuredResult: settlement.structuredResult !== undefined ? settlement.structuredResult : previous.structuredResult ?? null,
    result,
    unknownEffect: settlement.unknownEffect ?? previous.unknownEffect ?? status === "unknown_effect",
    classification: settlement.classification ?? previous.classification ?? null,
    reason: settlement.reason ?? previous.reason ?? null,
    error: settlement.error ?? previous.error ?? null,
    settledAt: previous.settledAt ?? new Date().toISOString(),
  };
  writeJsonAtomic(operationSettlementPath(runDir, invocationId), record);
}

/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {boolean}
 */
function hasOperationIntent(runDir, invocationId) {
  return existsSync(operationIntentPath(runDir, invocationId));
}

/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {boolean}
 */
function hasOperationSettlement(runDir, invocationId) {
  return existsSync(operationSettlementPath(runDir, invocationId));
}

/**
 * @param {string} cwd
 * @returns {{gitHead: string|null, dirty: boolean}}
 */
function captureWorktreeIdentity(cwd) {
  const head = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--", ".", ":(exclude).runs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return {
    gitHead: head.status === 0 ? head.stdout.trim() || null : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : false,
  };
}

/**
 * @param {NodeSnapshot} state
 * @returns {string|null}
 */
function sourceWorkerRuntime(state) {
  return [...(state.invocations ?? [])].reverse().find((invocation) => invocation.phase === "worker")?.runtimeId
    ?? state.runtime?.id
    ?? null;
}

/**
 * @param {ScopeComparison} scope
 * @param {import("./verification.mjs").WorkspaceScopeBoundary} boundary
 * @returns {BoundedScope}
 */
function boundedScope(scope, boundary) {
  return {
    boundary,
    changedPaths: scope.changedPaths.slice(0, 64),
    unexpectedPaths: scope.unexpectedPaths.slice(0, 64),
    changedPathCount: scope.changedPaths.length,
    unexpectedPathCount: scope.unexpectedPaths.length,
    truncated: scope.changedPaths.length > 64 || scope.unexpectedPaths.length > 64,
  };
}

/**
 * @param {import("./verification.mjs").WorkspaceScopeBoundary} boundary
 * @returns {BoundedScope}
 */
function emptyScope(boundary) {
  if (!boundary) throw Object.assign(new Error("worker scope boundary is missing"), { code: "scope_boundary_missing" });
  return {
    boundary,
    changedPaths: [],
    unexpectedPaths: [],
    changedPathCount: 0,
    unexpectedPathCount: 0,
    truncated: false,
  };
}

/**
 * @param {ValidatedContract} contract
 * @returns {Map<string, import("./verification.mjs").WorkspaceScopeBoundary>}
 */
function captureNodeScopeBoundaries(contract) {
  return new Map(contract.nodes.map((node) => [node.id, captureWorkspaceScope(contract.cwd, workerScope(node.taskPacket))]));
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot|undefined} state
 * @returns {import("./verification.mjs").WorkspaceScopeBoundary}
 */
function persistedScopeBoundary(contract, node, state, workspace = contract.cwd) {
  const boundary = state?.scope?.boundary;
  if (!boundary) throw Object.assign(new Error(`node ${node.id} has no persisted worker scope boundary`), { code: "scope_boundary_missing" });
  return validateWorkspaceScopeBoundary(workspace, boundary, workerScope(node.taskPacket));
}

/**
 * @param {import("./contract.mjs").TaskPacket} taskPacket
 * @returns {{files: string[], roots: string[]}}
 */
function workerScope(taskPacket) {
  return {
    files: taskPacket.writeFiles ?? [],
    roots: taskPacket.writeRoots ?? [],
  };
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

/**
 * @param {VerificationAttemptResult|null|undefined} result
 * @returns {VerificationAttemptResult}
 */
function boundedVerificationAttemptResult(result) {
  return {
    passed: Boolean(result?.passed),
    stdout: boundedUtf8(result?.stdout ?? "", 2 * 1024),
    stderr: boundedUtf8(result?.stderr ?? "", 2 * 1024),
    error: result?.error ? boundedUtf8(result.error, 2 * 1024) : null,
    exitCode: Number.isInteger(result?.exitCode) ? result?.exitCode ?? null : null,
    signal: result?.signal ?? null,
    timedOut: Boolean(result?.timedOut),
    durationMs: Number.isFinite(result?.durationMs) ? result?.durationMs ?? null : null,
  };
}

/**
 * @param {NodeSnapshot} state
 * @returns {import("./contract.mjs").VerificationAttempt[]}
 */
function verificationAttemptRecords(state) {
  if (!state.verification || !Array.isArray(state.verification.attempts)) {
    state.verification = { passed: false, commands: [], completed: false, attempts: [] };
  }
  return state.verification.attempts ?? [];
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @param {VerificationAttempt} attempt
 */
function persistVerificationAttempt(runDir, state, lock, attempt) {
  const attempts = verificationAttemptRecords(state);
  const index = attempts.findIndex((item) => item.invocationId === attempt.invocationId);
  if (index >= 0) attempts[index] = { ...attempts[index], ...attempt };
  else attempts.push({ ...attempt, completedAt: attempt.completedAt ?? null, result: attempt.result ?? null });
  state.verification ??= { passed: false, commands: [], completed: false, attempts: [] };
  state.verification.attempts = attempts.slice(-16);
  writeNode(runDir, state, lock);
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<import("./contract.mjs").VerificationState>}
 */
async function executeControllerVerification(contract, runDir, node, state, lock) {
  if (state.verification?.completed === true) return /** @type {import("./contract.mjs").VerificationState} */ (state.verification);
  state.verification = {
    passed: false,
    commands: [],
    completed: false,
    attempts: [...(state.verification?.attempts ?? [])],
  };
  writeNode(runDir, state, lock);
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  try {
    const result = await runVerification([...node.taskPacket.verification, ...finalVerificationCommands(contract, node)], workspace, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.verification`),
      onAttemptStart: (attempt) => persistVerificationAttempt(runDir, state, lock, attempt),
      onAttemptSpawn: (attempt) => persistVerificationAttempt(runDir, state, lock, {
        ...attempt,
        processStartToken: processStartToken(attempt.pid),
      }),
      onAttemptComplete: (attempt) => persistVerificationAttempt(runDir, state, lock, {
        ...attempt,
        result: boundedVerificationAttemptResult(attempt.result),
      }),
    });
    state.verification = {
      ...compactVerification(result),
      completed: true,
      attempts: verificationAttemptRecords(state),
    };
  } catch (error) {
    state.verification = {
      ...state.verification,
      completed: true,
      passed: false,
      error: boundedUtf8(errorMessage(error), 4 * 1024),
      attempts: verificationAttemptRecords(state),
    };
  }
  writeNode(runDir, state, lock);
  return state.verification;
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<void>}
 */
async function recoverVerificationAttempts(runDir, state, lock) {
  const active = (state.verification?.attempts ?? []).filter((attempt) => attempt.status === "active");
  if (!active.length) return;
  for (const attempt of active) {
    if (attempt.pid) {
      try {
    await terminateInvocation({
      id: attempt.invocationId,
      pid: attempt.pid,
      processGroupId: attempt.processGroupId,
      processStartToken: attempt.processStartToken,
    }, { graceMs: 500, killGraceMs: 1_000 });
      } catch (error) {
        throw new Error(`verification attempt ${attempt.invocationId} could not be terminated: ${errorMessage(error)}`);
      }
    }
    persistVerificationAttempt(runDir, state, lock, {
      ...attempt,
      status: "crashed",
      completedAt: new Date().toISOString(),
      result: { passed: false, stdout: "", stderr: "", error: "verification controller interrupted", exitCode: null, signal: null, timedOut: false, durationMs: null },
    });
  }
  state.verification = { ...state.verification, completed: false, passed: false };
  delete state.verification.error;
  writeNode(runDir, state, lock);
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Job} job
 * @param {LockHandle} lock
 * @param {{deferViolation?: boolean}} [options]
 * @returns {boolean}
 */
function checkWorkerScope(contract, runDir, job, lock, options = {}) {
  if (job.scopeChecked) return !job.scopeViolation;
  job.scopeChecked = true;
  const state = job.state;
  try {
    const baseline = /** @type {WorkspaceSnapshot|undefined} */ (job.scopeBaseline ?? (job.invocation.snapshotPath ? readJson(job.invocation.snapshotPath) : null));
    if (!baseline) throw Object.assign(new Error("worker scope snapshot is missing"), { code: "scope_snapshot_missing" });
    const boundary = persistedScopeBoundary(contract, job.node, state, job.cwd);
    const scope = compareWorkspaceSnapshot(baseline, job.cwd, { ...workerScope(job.node.taskPacket), boundary });
    const bounded = boundedScope(scope, boundary);
    state.scope = bounded;
    if (!scope.unexpectedPaths.length) return true;
    job.scopeViolation = true;
    // A completed attempt whose controller verification passes never fails
    // on scope alone (TECH-SPEC lean, rule 1): the caller defers the verdict
    // until verification has run and records an advisory finding instead.
    if (options.deferViolation) return true;
    const shown = bounded.unexpectedPaths.slice(0, 8).join(", ");
    const message = `unexpected paths changed (${scope.unexpectedPaths.length}): ${shown}`;
    if (!TERMINAL.has(state.status)) {
      transition(runDir, state, "failed", { phase: "worker", error: { code: "unexpected_write", message: excerpt(message) } }, lock);
      appendTransitionEvent(runDir, state, "failed", "failed", {
        unexpectedPaths: bounded.unexpectedPaths,
        unexpectedPathCount: bounded.unexpectedPathCount,
      }, lock);
    }
    return false;
  } catch (error) {
    job.scopeViolation = true;
    if (!TERMINAL.has(state.status)) {
      transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: excerpt(errorMessage(error)) } }, lock);
    }
    return false;
  }
}

/**
 * A result-only continuation is not implementation work. Its baseline is
 * captured immediately before that single turn, so every workspace change is
 * outside its authority (the run-owned result file is ignored by snapshots).
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Job} job
 * @param {LockHandle} lock
 * @param {string} [label]
 * @returns {boolean}
 */
function checkResultMaterializationScope(contract, runDir, job, lock, label = "result materialization") {
  if (job.scopeChecked) return !job.scopeViolation;
  job.scopeChecked = true;
  const state = job.state;
  try {
    const baseline = /** @type {WorkspaceSnapshot|undefined} */ (job.recoveryBaseline ?? (job.invocation.snapshotPath ? readJson(job.invocation.snapshotPath) : null));
    if (!baseline) throw Object.assign(new Error(`${label} scope snapshot is missing`), { code: "scope_snapshot_missing" });
    const scope = compareWorkspaceSnapshot(baseline, job.cwd);
    if (!scope.changedPaths.length) return true;
    job.scopeViolation = true;
    const shown = scope.changedPaths.slice(0, 8).join(", ");
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: "unexpected_write", message: excerpt(`${label} changed workspace paths (${scope.changedPaths.length}): ${shown}`) },
    }, lock);
    return false;
  } catch (error) {
    job.scopeViolation = true;
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: excerpt(errorMessage(error)) },
    }, lock);
    return false;
  }
}

/**
 * Materialization can reuse prior controller evidence only when that evidence
 * survived the same worker attempt. A fresh worker clears verification; the
 * retained, completed record is therefore the bounded same-attempt proof.
 * Judge evidence cannot currently carry that identity, so gated nodes fail
 * closed and run their normal judge phase.
 *
 * @param {NodeSnapshot} state
 * @param {ValidatedNode} node
 * @returns {boolean}
 */
function canReuseResultEvidence(state, node) {
  if (state.verification?.completed !== true || state.verification.passed !== true) return false;
  return !node.gate.enabled;
}

/**
 * Compare the current workspace against the persisted worker baseline without
 * transitioning the node. Shared by the unexpected-write failure path and the
 * unknown_effect replay gate.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Invocation|undefined} invocation
 * @param {{strict?: boolean}} [options]
 * @returns {{ok: true}|{ok: false, code: string, detail: string, unexpectedPaths?: string[], unexpectedPathCount?: number, changedPaths?: string[], changedPathCount?: number}}
 */
function evaluatePersistedWorkerScope(contract, node, state, invocation, options = {}) {
  const strict = options.strict === true;
  try {
    const baseline = invocation?.snapshotPath
      ? /** @type {WorkspaceSnapshot} */ (readJson(invocation.snapshotPath))
      : null;
    if (!baseline) return { ok: false, code: "scope_snapshot_missing", detail: "worker scope snapshot is missing" };
    const workspace = attemptWorkspace(state) ?? invocation?.workspace ?? contract.cwd;
    const boundary = persistedScopeBoundary(contract, node, state, workspace);
    const scope = compareWorkspaceSnapshot(baseline, workspace, { ...workerScope(node.taskPacket), boundary });
    const bounded = boundedScope(scope, boundary);
    state.scope = bounded;
    if (!scope.unexpectedPaths.length && (!strict || scope.changedPaths.length === 0)) return { ok: true };
    if (scope.unexpectedPaths.length) {
      const shown = bounded.unexpectedPaths.slice(0, 8).join(", ");
      return {
        ok: false,
        code: "unexpected_write",
        detail: `unexpected paths changed (${scope.unexpectedPaths.length}): ${shown}`,
        unexpectedPaths: bounded.unexpectedPaths,
        unexpectedPathCount: bounded.unexpectedPathCount,
      };
    }
    return {
      ok: false,
      code: "declared_paths_changed",
      detail: `declared workspace paths changed across the ambiguous window (${scope.changedPaths.length}): ${bounded.changedPaths.slice(0, 8).join(", ")}`,
      changedPaths: bounded.changedPaths,
      changedPathCount: bounded.changedPathCount,
    };
  } catch (error) {
    return { ok: false, code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), detail: errorMessage(error) };
  }
}

/**
 * Gate a worker restart behind proof that the replay cannot duplicate effects.
 * Declared workspace changes are not proof of absence: any change across the
 * ambiguous window (declared or unexpected) or a missing scope baseline is
 * reconciled as terminal attention instead of silently replaying the attempt.
 * Returns true when the restart must not proceed (the node was blocked).
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Invocation|undefined} invocation
 * @param {RecoveryOutcome} recovery
 * @param {Record<string, unknown>|undefined} persistedRecovery
 * @param {LockHandle} lock
 * @returns {boolean}
 */
function reconcileAmbiguousWorkerRestart(contract, runDir, node, state, invocation, recovery, persistedRecovery, lock) {
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, invocation, { strict: true });
  if (evaluation.ok) return false;
  const invocationId = recovery.invocationId ?? invocation?.id;
  const reason = evaluation.code === "declared_paths_changed"
    ? `declared workspace changes across the ambiguous window are not proof that replay cannot duplicate effects for node ${state.id}: ${evaluation.detail}`
    : evaluation.code === "unexpected_write"
      ? `workspace moved outside the declared write scope across the ambiguous window: ${evaluation.detail}`
      : `the ambiguous worker window for node ${state.id} cannot prove replay safety: ${evaluation.detail}`;
  if (invocationId) {
    settleInvocation(runDir, invocationId, {
      status: "reconciled",
      usage: invocation?.usage ?? recovery.usage ?? null,
      costUsd: typeof invocation?.costUsd === "number" ? invocation.costUsd : recovery.costUsd ?? null,
      receipts: providerReceiptsFromInvocationTail(contract, invocation),
      unknownEffect: true,
      classification: "unknown_effect",
      reason,
    });
  }
  if (!persistedRecovery) recordExecutionOverride(runDir, state, {
    kind: "recovery",
    decision: "reconciled",
    invocationId,
    phase: recovery.phase,
    reason,
  }, lock);
  transition(runDir, state, "blocked", {
    phase: recovery.phase,
    error: { code: "unknown_effect_reconciled", message: excerpt(reason) },
  }, lock);
  return true;
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {ValidatedNode} node
 * @param {Invocation|undefined} invocation
 * @param {LockHandle} lock
 * @param {{materialization?: boolean}} [options]
 * @returns {boolean}
 */
function checkPersistedWorkerScope(contract, runDir, state, node, invocation, lock, options = {}) {
  const materialization = options.materialization === true;
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, invocation, { strict: materialization });
  if (evaluation.ok) return true;
  // A recovered materialization turn mirrors the live check: it may only write
  // the canonical result file, so declared-path changes are as terminal as
  // unexpected ones.
  const failure = materialization && (evaluation.code === "unexpected_write" || evaluation.code === "declared_paths_changed")
    ? {
      code: "unexpected_write",
      message: excerpt(`result materialization changed workspace paths (${evaluation.changedPathCount ?? evaluation.unexpectedPathCount}): ${(evaluation.changedPaths ?? evaluation.unexpectedPaths ?? []).slice(0, 8).join(", ")}`),
    }
    : { code: evaluation.code, message: excerpt(evaluation.detail) };
  transition(runDir, state, "failed", {
    phase: "worker",
    error: failure,
  }, lock);
  if (evaluation.unexpectedPaths) {
    appendTransitionEvent(runDir, state, "failed", "failed", {
      unexpectedPaths: evaluation.unexpectedPaths,
      unexpectedPathCount: evaluation.unexpectedPathCount,
    }, lock);
  }
  return false;
}

/**
 * Record a deferred scope violation as an advisory finding on a node whose
 * controller verification passed: the node proceeds into the gate exactly as
 * a clean node would (TECH-SPEC lean, rule 1).
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 */
function recordScopeFinding(runDir, state, lock) {
  if (!state.scope?.unexpectedPaths?.length) return;
  state.scopeFindings = scopeFindingFromScope(state.scope);
  writeNode(runDir, state, lock);
  appendTransitionEvent(runDir, state, state.status, state.status, {
    type: "scope.finding",
    unexpectedPaths: state.scopeFindings.unexpectedPaths,
    unexpectedPathCount: state.scope.unexpectedPathCount,
  }, lock);
}

/**
 * Resolve an unknown_effect window (intent without settlement) per the node's
 * replayPolicy. Adoption proof was already applied by recoverOrphan when it
 * applied; what remains is the scoped safe-replay or a durable reconcile.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Invocation|undefined} workerInvocation
 * @param {LockHandle} lock
 * @returns {Promise<{action: "replay"}|{action: "reconcile", reason: string}>}
 */
async function resolveUnknownEffect(contract, runDir, node, state, workerInvocation, lock) {
  const policy = node.replayPolicy ?? "safe";
  if (policy !== "safe") {
    return { action: "reconcile", reason: `node ${state.id} declares replayPolicy ${policy}; the interrupted attempt with unknown effects requires manual reconciliation` };
  }
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, workerInvocation, { strict: true });
  if (!evaluation.ok) {
    return {
      action: "reconcile",
      reason: evaluation.code === "declared_paths_changed"
        ? `declared workspace changes across the ambiguous window are not proof that replay cannot duplicate effects for node ${state.id}: ${evaluation.detail}`
        : `workspace moved outside the declared write scope across the ambiguous window: ${evaluation.detail}`,
    };
  }
  await executeControllerVerification(contract, runDir, node, state, lock);
  if (!state.verification?.passed) {
    return { action: "reconcile", reason: `deterministic verification failed while resolving the ambiguous window for node ${state.id}; partial effects cannot be proven absent` };
  }
  return { action: "replay" };
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {Map<string, Job>} running
 * @param {LockHandle} lock
 * @param {string} campaignPath
 * @returns {Promise<void>}
 */
async function finalizeClosedJobs(contract, runDir, states, running, lock, campaignPath) {
  for (const [nodeId, job] of running) {
    if (!job.closed || invocationAlive(job.invocation)) continue;
    running.delete(nodeId);
    const state = states.get(nodeId);
    if (!state) continue;
    // Usage is extracted and persisted BEFORE any outcome-specific handling:
    // a scope-gate failure, a killed process, or an invalid stream must never
    // lose the tokens its invocation already spent (the 2026-08 incident
    // persisted zero usage for 1.2M+ token workers on exactly this path).
    if (TERMINAL.has(state.status)) {
      recordInvocationUsage(job, { accumulate: false });
      writeNode(runDir, state, lock);
      continue;
    }
    // The branch's onClose already persisted this invocation's usage and
    // recomputed state.usage; this call only extracts the provider envelope
    // (with transcript backfill) without accumulating a second time.
    let envelope = recordInvocationUsage(job, { accumulate: false });
    if (job.spawnError) {
      settleInvocation(runDir, job.invocation, {
        status: "failed",
        error: { code: "spawn_error", message: job.spawnError.message },
        reason: "provider did not start",
        nextState: operationNextState(state),
      });
      transition(runDir, state, "failed", { phase: job.phase, error: { code: "spawn_error", message: job.spawnError.message } }, lock);
      continue;
    }
    // The provider close evidence was already read by recordInvocationUsage
    // above; run the scope gate before any settlement so a scope failure
    // still persists the provider receipts and usage.
    // Whether this is a completed attempt is decided before the scope gate:
    // only a completed attempt may defer its scope verdict to after controller
    // verification (TECH-SPEC lean, rule 1). Completed is exactly what the
    // canonical result file says: a done envelope without that file, with a
    // non-done result in it, or with an unparseable file is not accepted work,
    // so it keeps the terminal unexpected_write it always had instead of
    // deferring a verdict nothing will settle. The envelope's own result is
    // materialized into the canonical file only after this gate.
    /** @type {import("./worker-result.mjs").WorkerResult|null} */
    let adoptedWorkerResult = null;
    /** @type {Error|undefined} */
    let workerResultError;
    if (job.phase === "worker" && !job.resultMaterialization) {
      try {
        materializeAttemptResult(runDir, state, job.node);
        adoptedWorkerResult = readWorkerResultFile(runDir, job.node.id);
      } catch (error) {
        // A present-but-invalid canonical file is not completed work: the
        // invalid-result branch below decides, exactly as it did before the
        // advisory scope verdict existed.
        workerResultError = /** @type {Error} */ (error);
      }
    }
    const completedAttempt = job.phase === "worker" && !job.resultMaterialization
      && adoptedWorkerResult?.status === "done";
    if (job.phase === "worker") {
      const scopeOk = job.resultMaterialization
        ? checkResultMaterializationScope(contract, runDir, job, lock)
        : checkWorkerScope(contract, runDir, job, lock, { deferViolation: completedAttempt });
      if (!scopeOk) {
        settleInvocation(runDir, job.invocation, {
          status: "failed",
          usage: job.invocation.usage ?? null,
          costUsd: typeof job.invocation.costUsd === "number" ? job.invocation.costUsd : null,
          receipts: providerReceipts(envelope),
          error: state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
          nextState: operationNextState(state),
        });
        continue;
      }
    }
    state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === job.invocation.id
      ? {
        ...invocation,
        continuationId: envelope.continuationId ?? invocation.continuationId ?? null,
        usage: envelope.usage,
        costUsd: envelope.costUsd,
      }
      : invocation);
    settleInvocation(runDir, job.invocation, {
      status: envelope.status,
      usage: envelope.usage ?? null,
      costUsd: typeof envelope.costUsd === "number" ? envelope.costUsd : null,
      structuredResult: Boolean(envelope.result),
      result: envelope.result ?? null,
      receipts: providerReceipts(envelope),
      error: envelope.error ?? null,
      nextState: operationNextState(state),
    });
    appendUsageRecord(runDir, state.invocations.find((invocation) => invocation.id === job.invocation.id));
    state.usage = invocationUsage(state);
    state.costUsd = invocationCost(state);
    // A closed worker whose canonical result file is valid and whose scope
    // passed is completed work, no matter what the provider envelope or the
    // exit code said. The durable file was read above, before the scope gate,
    // so the gate knows whether this attempt may defer its verdict; the file
    // is adopted before the exhaustion and failure branches and enters the
    // normal verification/gate flow with
    // that result. A present-but-invalid file still fails exactly as the done
    // path fails it today.
    if (workerResultError) {
      if (envelope.status === "done") {
        await applyInvalidWorkerResult(contract, job.node, state, runDir, running, lock, errorMessage(workerResultError), states, campaignPath);
        continue;
      }
      adoptedWorkerResult = null;
    }
    if (adoptedWorkerResult) {
      settleInvocation(runDir, job.invocation, {
        status: "done",
        usage: envelope.usage ?? null,
        costUsd: typeof envelope.costUsd === "number" ? envelope.costUsd : null,
        structuredResult: true,
        result: adoptedWorkerResult,
        receipts: providerReceipts(envelope),
        error: null,
        nextState: operationNextState(state),
      });
    }
    if (!adoptedWorkerResult && envelope.status === "exhausted") {
      handleProviderExhaustion(contract, runDir, job.node, state, /** @type {"worker"|"judge"} */ (job.phase), envelope, job.runtime.id, lock, states, campaignPath);
      continue;
    }
    // A judge provider that failed outright (its turn died, its tool host was
    // gone) is a provider failure, never a verdict: the gate cannot adopt a
    // result the judge could not ground in inspection. Re-dispatch the judge
    // once on the same routing, then settle by review mode so a judge failure
    // is surfaced, never silently settled. A stream that never reached its
    // terminal envelope is a protocol defect instead and takes the bounded
    // re-ask below.
    if (job.phase === "judge" && envelope.status === "failed" && envelope.error?.code !== "incomplete_stream") {
      // A judge that lost its socket is not an unavailable judge. It buys the
      // same bounded network waits a worker does, on the runtime it already
      // warmed, and spends none of the one re-dispatch counted below.
      const network = networkTransition(contract, job.node, state, "judge", envelope, job.exitCode);
      if (network && handleProviderExhaustion(contract, runDir, job.node, state, "judge", envelope, job.runtime.id, lock, states, campaignPath, network)) continue;
      // The provider died on the bounded re-ask itself, so the one permitted
      // re-ask is spent: settle by review mode here rather than dispatch a
      // third judge invocation behind a fresh failure count.
      // The provider died on the bounded re-ask itself, so the one permitted
      // re-ask is spent: settle by review mode here rather than dispatch a
      // third judge invocation behind a fresh failure count.
      if (judgeReaskOutstanding(state)) {
        await applyJudgeProtocolFailure(contract, job.node, state, runDir, running, lock, states, campaignPath, envelope.error?.message ?? "judge provider failed");
        continue;
      }
      state.judgeFailures = (state.judgeFailures ?? 0) + 1;
      if (state.judgeFailures < JUDGE_MAX_FAILURES) {
        writeNode(runDir, state, lock);
        await startJudge(contract, job.node, state, runDir, running, state.result, lock, states, campaignPath);
        continue;
      }
      await settleUnavailableJudge(contract, job.node, state, runDir, lock, states, campaignPath, envelope.error?.message ?? "judge provider failed");
      continue;
    }    // Whatever else this invocation produced, it is not exactly one usable
    // verdict: no verdict at all, several of them in separate agent messages,
    // an unparseable one, a stream cut off before its terminal envelope, or a
    // phase killed on its wall clock. One bounded re-ask, then the review mode
    // decides — advisory completes, blocking enters attention with the work
    // preserved so a retry in place can re-judge it.
    if (job.phase === "judge") {
      const evidence = judgeVerdictEvidence(envelope);
      if (!evidence.ok) {
        const network = networkTransition(contract, job.node, state, "judge", envelope, job.exitCode);
        if (network && handleProviderExhaustion(contract, runDir, job.node, state, "judge", envelope, job.runtime.id, lock, states, campaignPath, network)) continue;
        await applyJudgeProtocolFailure(contract, job.node, state, runDir, running, lock, states, campaignPath, evidence.reason);
        continue;
      }
      await applyJudgeResult(contract, job.node, state, evidence.result, runDir, lock, running, states, campaignPath);
      continue;
    }
    // An empty final message is a missing worker result, not a no-op worker:
    // when the canonical file exists it is authoritative (the message is
    // redundant), and a worker that completed without it gets exactly one
    // result-only continuation before the node fails.
    if (job.phase === "worker") materializeAttemptResult(runDir, state, job.node);
    const fileBackedNoOp = job.phase === "worker" && envelope.status === "no-op" && existsSync(workerResultPath(runDir, job.node.id));
    if (!adoptedWorkerResult && job.phase === "worker" && envelope.status === "no-op" && !fileBackedNoOp) {
      if (job.resultMaterialization) {
        transition(runDir, state, "failed", {
          phase: "worker",
          error: { code: "missing_worker_result", message: "result-only materialization produced no canonical worker result" },
        }, lock);
      } else {
        startResultMaterialization(
          contract,
          job.node,
          state,
          runDir,
          running,
          job.invocation,
          job.runtime,
          envelope.continuationId ?? job.invocation.continuationId ?? null,
          lock,
        );
      }
      continue;
    }
    if (!adoptedWorkerResult && envelope.status !== "done" && !fileBackedNoOp) {
      // A dropped connection is not a failed task: let the node wait on the
      // runtime it already warmed before it spends a failover hop on it. When
      // the waits and the edges are both spent, the failure is reported here.
      const role = /** @type {"worker"|"judge"} */ (job.phase);
      const network = networkTransition(contract, job.node, state, role, envelope, job.exitCode);
      if (network && handleProviderExhaustion(contract, runDir, job.node, state, role, envelope, job.runtime.id, lock, states, campaignPath, network)) continue;
      transition(runDir, state, envelope.status, {
        phase: job.phase,
        result: state.result,
        error: envelope.error,
        usage: state.usage,
      }, lock);
      continue;
    }
    if (job.phase === "worker") {
      /** @type {WorkerResult} */
      let workerResult;
      try {
        workerResult = resolveWorkerResult(runDir, job.node, envelope.result);
      } catch (error) {
        if (job.resultMaterialization) {
          transition(runDir, state, "failed", {
            phase: "worker",
            error: { code: "missing_worker_result", message: `result-only materialization did not produce a valid canonical worker result: ${errorMessage(error)}` },
          }, lock);
          continue;
        }
        await applyInvalidWorkerResult(contract, job.node, state, runDir, running, lock, errorMessage(error), states, campaignPath);
        continue;
      }
      if (job.node.taskPacket.mode === "discovery" && workerResult.status === "done") {
        try {
          parseDiscoveryResult(workerResult, attemptWorkspace(state) ?? contract.cwd);
        } catch (error) {
          await applyInvalidWorkerResult(contract, job.node, state, runDir, running, lock, errorMessage(error), states, campaignPath);
          continue;
        }
      }
      state.result = workerResult;
      if (workerResult.status === "blocked_context") {
        transition(runDir, state, "blocked", {
          phase: "complete",
          result: workerResult,
          error: { code: "context_missing", message: workerResult.missingContext.join("; ") },
        }, lock);
        continue;
      }
      if (job.resultMaterialization && canReuseResultEvidence(state, job.node)) {
        if (job.node.gate.enabled) await applyJudgeResult(contract, job.node, state, state.gate, runDir, lock, running, states, campaignPath);
        else await settleDone(contract, job.node, state, runDir, lock, states, campaignPath, { phase: "complete", result: workerResult, error: null });
        continue;
      }
      await executeControllerVerification(contract, runDir, job.node, state, lock);
      if (!state.verification?.passed) {
        applyVerificationFailure(contract, job.node, state, runDir, running, lock, states, campaignPath);
        continue;
      }
      if (job.scopeViolation) recordScopeFinding(runDir, state, lock);
      if (job.node.gate.enabled) await startJudge(contract, job.node, state, runDir, running, workerResult, lock, states, campaignPath);
      else await settleDone(contract, job.node, state, runDir, lock, states, campaignPath, { phase: "complete", result: workerResult });
      continue;
    }
  }
}

/**
 * Settle one unusable invocation onto the route it earned: a wait on the
 * runtime the node already warmed, or a hop to the next one.
 *
 * Exhaustion is the common caller and classifies the transition itself; a
 * caller that already knows why it is rerouting — a provider that could not
 * hold the result protocol, say — passes its own.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {"worker"|"judge"} role
 * @param {ProviderEnvelope} envelope
 * @param {string|null} currentRuntime
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {import("./backoff.mjs").Transition} [precomputed]
 * @returns {boolean} false when no edge remained and the node was left blocked by the caller
 */
function handleProviderExhaustion(contract, runDir, node, state, role, envelope, currentRuntime, lock, states, campaignPath, precomputed) {
  const error = envelope.error ?? { code: "provider_exhausted", message: "provider exhausted" };
  if (NON_FAILOVER_CODES.has(error.code)) {
    transition(runDir, state, "exhausted", { phase: role, result: state.result, usage: state.usage, error }, lock);
    return true;
  }
  const current = currentRuntime ?? state.runtime?.id ?? routeRuntimeForState(contract, node, state, role).id;
  const now = Date.now();
  // A quota reset inside the node's remaining window is cheaper than any hop,
  // and so is one more wait on a dropped connection: neither spends a runtime,
  // so planRoute charges neither a hop.
  const schedule = precomputed ?? classifyTransition(envelope, {
    deadline: nodeDeadlineAt(contract, node, state),
    attempt: networkBackoffAttempts(state, role, state.revisions ?? 0),
    now,
  });
  const plan = planRoute(contract, node, state, role, error, current, schedule, now);
  const status = envelope.status === "failed" ? "failed" : "exhausted";
  if (plan.blocked) {
    // A caller that classified the failure itself also owns what happens when
    // there is nowhere left to route it: it has a better answer than another
    // silent exhaustion — attention, or the provider's own error.
    if (precomputed) return false;
    const attention = plan.blocked.code === "runtime_tier_exhausted";
    const exhaustedUntil = exhaustedUntilOf(envelope);
    transition(runDir, state, attention ? "blocked" : "exhausted", {
      phase: role,
      result: state.result,
      usage: state.usage,
      error: { ...plan.blocked, ...(exhaustedUntil ? { exhaustedUntil } : {}) },
    }, lock);
    if (attention) void raiseNodeAttention(campaignPath, runDir, state, plan.blocked.code).catch(() => {});
    return true;
  }
  // A judge fallback that would land on the vendor of the worker it is
  // reviewing is not caught at validation time — reachability depends on
  // which worker runtime actually ran, which a static contract cannot know —
  // so it is refused here, and the node is parked for a human rather than
  // quietly arbitrated by the vendor it is supposed to check.
  if (role === "judge" && plan.nextRuntime !== current) {
    const workerRuntimeId = sourceWorkerRuntime(state);
    const workerVendor = workerRuntimeId ? contract.runtimes[workerRuntimeId]?.vendor : undefined;
    const judgeFallbackVendor = contract.runtimes[plan.nextRuntime]?.vendor;
    if (workerVendor && judgeFallbackVendor && workerVendor === judgeFallbackVendor) {
      if (precomputed) return false;
      transition(runDir, state, "blocked", {
        phase: role,
        result: state.result,
        usage: state.usage,
        error: {
          code: "judge_fallback_vendor_conflict",
          message: `judge fallback runtime ${plan.nextRuntime} shares vendor ${judgeFallbackVendor} with worker runtime ${workerRuntimeId}`,
        },
      }, lock);
      return true;
    }
  }
  applyRoute(contract, runDir, state, lock, { role, error, current, plan, schedule, envelope, status, now });
  return true;
}

/**
 * Persist one planned route: the history entry that records what happened, the
 * override that tells the scheduler where the phase goes next, and the pending
 * transition that makes it schedulable once the backoff window closes.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @param {{role: "worker"|"judge", error: {code: string, message: string}, current: string, plan: ReturnType<typeof planRoute>, schedule: import("./backoff.mjs").Transition, envelope: ProviderEnvelope, status: string, now: number}} options
 */
function applyRoute(contract, runDir, state, lock, { role, error, current, plan, schedule, envelope, status, now }) {
  const { routing, override, errorCode } = buildRouting(state, {
    role, error, current, plan, schedule, status, now, usage: envelope.usage, costUsd: envelope.costUsd,
  });
  transition(runDir, state, "pending", {
    phase: role,
    runtime: runtimeSnapshot(contract, plan.nextRuntime),
    result: state.result,
    error: null,
    routing,
  }, lock);
  appendTransitionEvent(runDir, state, "pending", "pending", { role, status, currentRuntime: current, errorCode, override }, lock);
}
/**
 * Extract the invocation's provider envelope from the bounded transcript tail
 * and persist its usage into the matching invocation record. By default the
 * usage is also accumulated into `state.usage` (the caller then transitions or
 * continues); with `accumulate: false` only the invocation record is updated,
 * for jobs whose node already reached a terminal state that already counted
 * this spend.
 *
 * @param {Job} job
 * @param {{accumulate?: boolean}} [options]
 * @returns {ProviderEnvelope}
 */
function recordInvocationUsage(job, options = {}) {
  const { state } = job;
  /** @type {ProviderEnvelope} */
  let envelope;
  let boundedStdout = "";
  try {
    boundedStdout = readBoundedTail(job.paths.stdout);
    const boundedStderr = readBoundedTail(job.paths.stderr, 512 * 1024);
    envelope = normalizeProviderResult(job.runtime, boundedStdout, job.exitCode, job.signal, { preferStructured: job.phase === "judge" });
  } catch (error) {
    envelope = {
      status: "failed",
      result: null,
      continuationId: null,
      usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null },
      costUsd: null,
      error: { code: "invalid_output", message: errorMessage(error) },
    };
  }
  // Failure envelopes carry zeroed usage (a killed provider emits no terminal
  // event), yet its transcript holds real per-turn counters. Backfill the
  // normalized usage components from the live meter so kills, timeouts, and
  // scope failures still report what they spent, cache reads separated.
  if (envelope.usage.inputTokens === null && boundedStdout) {
    const observed = liveUsage(job.runtime.driver, boundedStdout);
    if (observed.inputTokens !== null) {
      envelope = { ...envelope, usage: { ...envelope.usage, inputTokens: observed.inputTokens, cacheReadInputTokens: observed.cacheReadInputTokens } };
    }
  }
  state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === job.invocation.id
    ? { ...invocation, usage: envelope.usage }
    : invocation);
  if (options.accumulate !== false) state.usage = addUsage(state.usage, envelope.usage);
  return envelope;
}

/** A failed judge envelope gets one bounded re-dispatch, then judge_unavailable. */
const JUDGE_MAX_FAILURES = 2;

/** Attention code raised when an advisory review completes without a verdict. */
const INVALID_JUDGE_OUTPUT_CODE = "invalid_judge_output";

/**
 * Settle a judge round that produced no usable verdict. The first defect earns
 * the one bounded re-ask on the node's own bound; once it is spent the review
 * mode decides, and blocking review never degrades into a pass.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>|null} running
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {string} reason
 */
async function applyJudgeProtocolFailure(contract, node, state, runDir, running, lock, states, campaignPath, reason) {
  if (judgeReaskOutstanding(state)) {
    if (reviewMode(node.gate) === "advisory") {
      // The deterministic verification passed, so the review cannot fail the
      // node; completing with the defect recorded keeps it visible instead of
      // silently discarding the review.
      await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, invalidJudgeVerdict(reason));
      await raiseNodeAttention(campaignPath, runDir, state, INVALID_JUDGE_OUTPUT_CODE);
      return;
    }
    // Nothing about the attempt is rewritten: the accepted worker result, the
    // verification records and the gate state stay exactly as a node awaiting
    // its judge leaves them, so a retry in place re-judges instead of re-running.
    transition(runDir, state, "blocked", {
      phase: "judge",
      result: state.result,
      usage: state.usage,
      error: { code: JUDGE_UNAVAILABLE_CODE, message: excerpt(reason) ?? "judge unavailable" },
    }, lock);
    await raiseNodeAttention(campaignPath, runDir, state, JUDGE_UNAVAILABLE_CODE);
    return;
  }
  // The bound rides on the node: the next write — the recovered pending
  // judge below or the re-ask dispatch's own invocation — persists it with
  // the transition it belongs to, leaving no gap either way.
  markJudgeReask(state, reason);
  if (!running) {
    // A verdict recovered after controller loss keeps its durable bound:
    // the drive loop dispatches the one remaining bounded re-ask.
    transition(runDir, state, "pending", { phase: "judge", gate: null, result: state.result, error: null, blockedBy: [] }, lock);
    return;
  }
  await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaignPath);
}

/**
 * Settle an advisory gate: the verdict is recorded with its findings and the
 * node completes, because the deterministic verification already passed. A
 * verdict that is not a clean pass appends the `gate.advisory` event the run
 * journal keeps for review outcomes.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {JudgeVerdict} verdict
 */
async function settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, verdict) {
  clearJudgeReask(state);
  state.gate = verdict;
  if (verdict.verdict !== "pass") {
    appendTransitionEvent(runDir, state, state.status, state.status, {
      type: "gate.advisory",
      verdict: verdict.verdict,
      summary: verdict.summary,
    }, lock);
  }
  await settleDone(contract, node, state, runDir, lock, states, campaignPath, { phase: "complete", gate: verdict });
}

/** Settle a judge whose provider failed its bounded re-dispatches: blocking review blocks with the work preserved; advisory review completes with the defect recorded. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {string} providerMessage */
async function settleUnavailableJudge(contract, node, state, runDir, lock, states, campaignPath, providerMessage) {
  if (reviewMode(node.gate) === "advisory") {
    await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, invalidJudgeVerdict(providerMessage));
    await raiseNodeAttention(campaignPath, runDir, state, INVALID_JUDGE_OUTPUT_CODE);
    return;
  }
  transition(runDir, state, "blocked", {
    phase: "judge",
    result: state.result,
    usage: state.usage,
    error: { code: JUDGE_UNAVAILABLE_CODE, message: excerpt(providerMessage) ?? "judge unavailable" },
  }, lock);
  await raiseNodeAttention(campaignPath, runDir, state, JUDGE_UNAVAILABLE_CODE);
}

/** Apply a judge verdict: pass settles done; a rejection citing no judgment item id is a judge protocol failure — one durable bounded re-ask, then blocked judge_protocol attention — and never consumes a revision, at any severity. Under advisory review a fail verdict is recorded and the node still completes. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {unknown} result @param {string} runDir @param {LockHandle} lock @param {Map<string, Job>|null} running @param {Map<string, NodeSnapshot>} states @param {string} campaignPath */
async function applyJudgeResult(contract, node, state, result, runDir, lock, running, states, campaignPath) {
  /** @type {JudgeVerdict} */
  let verdict;
  try {
    verdict = parseJudge(String(result ?? ""));
  } catch (error) {
    await applyJudgeProtocolFailure(contract, node, state, runDir, running, lock, states, campaignPath, errorMessage(error));
    return;
  }
  state.gate = verdict;
  state.judgeFailures = 0;
  const advisory = reviewMode(node.gate) === "advisory";
  const protocolFailure = verdict.verdict === "fail" && uncitedRejection(verdict, node);
  if (protocolFailure && judgeReaskOutstanding(state)) {
    if (advisory) {
      await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, verdict);
      await raiseNodeAttention(campaignPath, runDir, state, "judge_protocol");
      return;
    }
    transition(runDir, state, "blocked", {
      phase: "judge",
      gate: verdict,
      result: state.result,
      error: { code: "judge_protocol", message: "judge rejection cited no Definition of Done item id after the bounded re-ask" },
    }, lock);
    await raiseNodeAttention(campaignPath, runDir, state, "judge_protocol");
    return;
  }
  if (protocolFailure) {
    markJudgeReask(state, UNCITED_REJECTION_REASON);
    if (!running) {
      // A verdict recovered after controller loss keeps its durable bound:
      // the drive loop dispatches the one remaining bounded re-ask.
      transition(runDir, state, "pending", { phase: "judge", gate: null, result: state.result, error: null, blockedBy: [] }, lock);
      return;
    }
    await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaignPath);
    return;
  }
  clearJudgeReask(state);
  if (advisory) {
    await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, verdict);
    return;
  }
  const shouldFail = verdict.verdict === "fail" && verdict.maxSeverity !== "none"
    && (node.gate.failOn ?? ["critical"]).includes(verdict.maxSeverity);
  if (!shouldFail) {
    await settleDone(contract, node, state, runDir, lock, states, campaignPath, { phase: "complete", gate: verdict });
    return;
  }
  applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, {
    code: "revision_cap",
    label: "gate",
    phase: "judge",
  });
}

/** Settle one worker-generation rejection: bounded revision when one remains, otherwise terminal exhausted/failed. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {JudgeVerdict} verdict @param {{code: string, label: string, phase?: "worker"|"judge", message?: string}} options */
function applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, options) {
  const { code, label, phase = "worker", message = verdict.summary } = options;
  state.gate = verdict;
  if (node.gate.enabled && state.revisions < (node.gate.maxRevisions ?? 1)) {
    resetPhaseRouting(state);
    state.revisions += 1;
    state.attempt += 1;
    process.stdout.write(`[${label}] ${node.id} retry · ${verdict.summary}\n`);
    if (running) startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lock, states, campaignPath);
    else transition(runDir, state, "pending", { phase: "worker", error: null }, lock);
    return;
  }
  transition(runDir, state, node.gate.enabled ? "exhausted" : "failed", {
    phase,
    gate: verdict,
    error: { code, message },
  }, lock);
}

/** Deterministic verification failure settles through the shared rejection path. The verdict carries this attempt's unexpected paths, so a red attempt reports them whether it stops here or starts its revision (TECH-SPEC lean, rule 1). @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {JudgeVerdict} [verdict] */
function applyVerificationFailure(contract, node, state, runDir, running, lock, states, campaignPath, verdict = verificationFailureWithScope(verificationFailureVerdict(state), state.scope)) {
  applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, { code: "verification_failed", label: "verification" });
}

/**
 * Seal the current attempt, verify its candidate in a detached worktree, and
 * only then perform the single done-state transition. The integration module
 * owns the journal and conditional ref update; this callback owns node state.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {Partial<NodeSnapshot>} [patch]
 * @returns {Promise<import("./integrate.mjs").IntegrationResult|null|undefined>}
 */
async function settleDone(contract, node, state, runDir, lock, states, campaignPath, patch = {}) {
  const workspace = attemptWorkspace(state);
  if (!workspace || !state.worktree?.branch || !state.worktree.baseSha) {
    transition(runDir, state, "failed", {
      phase: "complete",
      error: { code: "attempt_worktree_missing", message: "completed attempt has no isolated worktree" },
    }, lock);
    return;
  }
  let sealed;
  try {
    sealed = sealAttempt({
      repo: contract.cwd,
      path: workspace,
      baseSha: state.worktree.baseSha,
      runId: contract.id,
      nodeId: node.id,
      attempt: state.attempt,
    });
    state.worktree = { ...state.worktree, commit: sealed.sha, status: "ready" };
    writeNode(runDir, state, lock);
  } catch (error) {
    transition(runDir, state, "failed", {
      phase: "complete",
      error: { code: errorCode(error) ?? "attempt_seal_failed", message: errorMessage(error) },
    }, lock);
    return;
  }
  const result = await integrateAttempt({
    repo: contract.cwd,
    runDir,
    runId: contract.id,
    nodeId: node.id,
    attempt: state.attempt,
    attemptSha: sealed.sha,
    branch: state.worktree.branch,
    verificationEvidence: state.verification,
    verifyCandidate: (candidateWorkspace) => verifyCandidateWorkspace(contract, node, state, runDir, candidateWorkspace),
    onAccepted: async (transaction) => {
      const acceptedPath = state.worktree?.path ?? attemptWorktreePath(runDir, contract.id, node.id, transaction.attempt);
      if (state.attempt === transaction.attempt && state.status !== "done") {
        transition(runDir, state, "done", {
          ...patch,
          integratedHead: transaction.candidateSha,
          worktree: { ...(state.worktree ?? {}), status: "removed", commit: transaction.attemptSha, baseSha: transaction.previousRunRefTip },
        }, lock);
      }
      if (state.attempt === transaction.attempt) ensureTerminalEvent(runDir, state, lock);
      removeWorktree(contract.cwd, acceptedPath);
    },
    onVerificationFailure: async (transaction) => {
      const verdict = verificationFailureWithScope(verificationFailureVerdict(state), state.scope);
      verdict.summary = "integrated candidate verification failed";
      verdict.findings = [...(verdict.findings ?? []), {
        severity: "critical",
        description: "the sealed candidate did not pass the node verification in its integration worktree",
        evidence: boundedUtf8(JSON.stringify(transaction.candidateEvidence ?? {}), 4 * 1024),
      }];
      applyRejection(contract, node, state, runDir, null, lock, states, campaignPath, verdict, {
        code: "verification_failed",
        label: "candidate-verification",
      });
    },
    onConflict: async (transaction) => {
      const paths = transaction.conflictingPaths?.length ? transaction.conflictingPaths.join(", ") : "unknown paths";
      transition(runDir, state, "blocked", {
        phase: "complete",
        error: { code: "integration_conflict", message: `integration conflict in: ${paths}` },
      }, lock);
      if (campaignPath) await raiseNodeAttention(campaignPath, runDir, state, "integration_conflict");
    },
    onConcurrentMove: async (transaction) => {
      transition(runDir, state, "blocked", {
        phase: "complete",
        error: { code: "integration_concurrent_move", message: `run ref moved from ${transaction.previousRunRefTip} to ${transaction.currentRunRefTip ?? "unknown"}` },
      }, lock);
      if (campaignPath) await raiseNodeAttention(campaignPath, runDir, state, "integration_concurrent_move");
    },
  });
  return result;
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {string} workspace
 * @returns {Promise<import("./integrate.mjs").CandidateEvidence>}
 */
async function verifyCandidateWorkspace(contract, node, state, runDir, workspace) {
  try {
    const result = await runVerification([...node.taskPacket.verification, ...finalVerificationCommands(contract, node)], workspace, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.candidate-verification`),
    });
    return compactVerification(result);
  } catch (error) {
    return { passed: false, error: boundedUtf8(errorMessage(error), 4 * 1024) };
  }
}

/**
 * A worker result that does not match the structured protocol gets one bounded
 * repair on the same provider, then stops asking it.
 *
 * The first unparseable result is worth re-asking for: the task packet is
 * intact and the model only has to re-emit its answer as the object it was
 * told to return. A second one is evidence about the provider rather than the
 * packet, so the node records a protocol_failure and takes its failover edge —
 * and when no edge remains, it blocks and raises attention rather than filing
 * a quiet exhaustion nobody reads.
 *
 * @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {string} message @param {Map<string, NodeSnapshot>} states @param {string} campaignPath
 */
async function applyInvalidWorkerResult(contract, node, state, runDir, running, lock, message, states, campaignPath) {
  const verdict = /** @type {JudgeVerdict} */ ({
    verdict: "fail",
    maxSeverity: "critical",
    summary: "worker result did not match the structured result protocol",
    findings: [{
      severity: "critical",
      description: "the entire final message must be exactly the required JSON object: no markdown fences, no prose before or after it. Return it as the only content of the final message.",
      evidence: boundedUtf8(message, 4 * 1024),
    }],
  });
  if (isRepairable(node, state)) {
    applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, {
      code: "invalid_worker_result",
      label: "worker-result",
      message,
    });
    return;
  }
  const error = { code: "protocol_failure", message: excerpt(message) ?? "worker result did not match the structured result protocol" };
  /** @type {ProviderEnvelope} */
  const envelope = {
    status: "failed",
    result: null,
    continuationId: null,
    usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null },
    costUsd: null,
    error,
  };
  // A failover hop is a fresh chance on a different provider, not a rejection
  // of the work to fix: `state.gate` must not carry this synthetic verdict
  // into the next dispatch, or the generic retry prompt would frame it as a
  // quality gate rejection instead of a plain new attempt.
  const routed = handleProviderExhaustion(contract, runDir, node, state, "worker", envelope, state.runtime?.id ?? null, lock, states, campaignPath, { kind: "failover", reason: "protocol_failure" });
  if (routed) {
    process.stdout.write(`[worker-result] ${node.id} protocol failure · failing over\n`);
    return;
  }
  transition(runDir, state, "blocked", { phase: "worker", gate: verdict, result: state.result, usage: state.usage, error }, lock);
  await raiseNodeAttention(campaignPath, runDir, state, "protocol_failure");
}

/**
 * Surface a node attention state through the run's notify queue.
 * @param {string} campaignPath
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {string} code
 */
async function raiseNodeAttention(campaignPath, runDir, state, code) {
  const runId = basename(runDir);
  const dedupeKey = `attention:${runId}:${state.id}:${code}`;
  if (alreadyNotified(runDir, dedupeKey)) return;
  await notifyQueueFor(runDir).enqueue({
    type: "attention",
    campaignId: campaignIdOf(campaignPath),
    runId,
    nodeId: state.id,
    errorCode: code,
    dedupeKey,
  });
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 */
function blockDependents(contract, runDir, states, lock) {
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state) continue;
    if (state.status !== "pending") continue;
    const blockedBy = node.dependsOn.filter((id) => TERMINAL.has(states.get(id)?.status ?? "") && states.get(id)?.status !== "done");
    if (blockedBy.length) transition(runDir, state, "blocked", { phase: "dependency", blockedBy, error: { code: "dependency_failed", message: `blocked by ${blockedBy.join(", ")}` } }, lock);
  }
}

const USAGE_LOG_NAME = "usage.jsonl";

/** @param {Usage|undefined} usage @returns {boolean} */
function hasMeasuredUsage(usage) {
  return Boolean(usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens]
    .some((value) => typeof value === "number" && Number.isFinite(value)));
}

/** @param {NodeSnapshot} state @returns {Usage} */
function invocationUsage(state) {
  const seen = new Set();
  return (state.invocations ?? []).reduce((total, invocation) => {
    if (invocation.id && seen.has(invocation.id)) return total;
    if (invocation.id) seen.add(invocation.id);
    return addUsage(total, invocation.usage);
  }, /** @type {Usage} */ ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }));
}

/** @param {NodeSnapshot} state @returns {number|undefined} */
function invocationCost(state) {
  const costs = /** @type {number[]} */ ((state.invocations ?? [])
    .map((invocation) => invocation.costUsd)
    .filter((cost) => typeof cost === "number" && Number.isFinite(cost)));
  return costs.length ? costs.reduce((total, cost) => total + cost, 0) : undefined;
}

/**
 * Invocation ids already present in the run's usage.jsonl. The append path
 * uses this to stay idempotent across resume and replay.
 *
 * @param {string} runDir
 * @returns {Set<string>}
 */
function usageRecordIds(runDir) {
  const ids = new Set();
  const path = join(runDir, USAGE_LOG_NAME);
  if (!existsSync(path)) return ids;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const value = record && typeof record === "object" && !Array.isArray(record)
        ? /** @type {Record<string, unknown>} */ (record)
        : null;
      if (value && typeof value.invocationId === "string") ids.add(value.invocationId);
    } catch {
      // A truncated tail line is repaired by appendJsonl on the next write.
    }
  }
  return ids;
}

/**
 * Append one usage.jsonl record for a worker or judge invocation. Usage is a
 * reporting record only: no control path reads this file to gate work.
 *
 * @param {string} runDir
 * @param {Invocation|undefined|null} invocation
 */
function appendUsageRecord(runDir, invocation) {
  if (!invocation?.id || usageRecordIds(runDir).has(invocation.id)) return;
  const usage = /** @type {Usage} */ (invocation.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
  appendJsonl(join(runDir, USAGE_LOG_NAME), {
    invocationId: invocation.id,
    runId: invocation.runId ?? basename(runDir),
    nodeId: invocation.nodeId ?? null,
    attempt: invocation.attempt ?? null,
    role: invocation.role ?? null,
    runtimeId: invocation.runtimeId ?? null,
    model: invocation.model ?? null,
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
    cacheReadInputTokens: typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : null,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
    costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
    costProvenance: typeof invocation.costUsd === "number" ? "provider" : "unknown",
    startedAt: invocation.startedAt ?? null,
    finishedAt: invocation.closedAt ?? null,
  });
}

/**
 * Idempotently write every persisted invocation of the run into usage.jsonl.
 * Resume calls this after adopting previously recorded node state.
 *
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 */
function synchronizeRunUsage(runDir, states) {
  const seen = usageRecordIds(runDir);
  for (const state of states.values()) {
    for (const invocation of state.invocations ?? []) {
      if (seen.has(invocation.id)) continue;
      appendUsageRecord(runDir, invocation);
      seen.add(invocation.id);
    }
  }
}

/**
 * Recovery can discover usage after the run synchronized its records. Attach
 * it to the authoritative invocation first, then write the updated usage
 * record. The invocation id makes repeated resumes idempotent.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {RecoveryOutcome|null|undefined} recovery
 * @param {LockHandle} lock
 * @returns {Promise<void>}
 */
async function persistRecoveryUsage(runDir, state, recovery, lock) {
  if (!recovery?.invocationId) return;
  const current = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
  if (!current) return;
  const usage = hasMeasuredUsage(current.usage) ? current.usage : recovery.usage;
  const costUsd = typeof current.costUsd === "number" ? current.costUsd : recovery.costUsd;
  const changed = stableJson(current.usage) !== stableJson(usage)
    || current.costUsd !== (costUsd ?? null);
  if (changed) {
    state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === current.id
      ? { ...invocation, usage, costUsd: costUsd ?? null }
      : invocation);
    state.usage = invocationUsage(state);
    writeNode(runDir, state, lock);
  }
  const updated = state.invocations?.find((invocation) => invocation.id === current.id);
  if (updated) appendUsageRecord(runDir, updated);
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {import("./contract.mjs").NodeStatus} status
 * @param {Record<string, unknown>} [patch]
 * @param {LockHandle|null} [lock]
 */
function transition(runDir, state, status, patch = {}, lock = null) {
  lock?.assert();
  const from = state.status;
  const updatedAt = new Date().toISOString();
  Object.assign(state, patch, { status, updatedAt });
  writeNode(runDir, state, lock);
  if (status === "done" && process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT === "after-state") {
    throw new Error("integration interrupted after node state write");
  }
  const invocation = state.invocations?.at(-1);
  if (invocation && hasOperationSettlement(runDir, invocation.id)) {
    settleInvocation(runDir, invocation, { nextState: operationNextState(state) });
  }
  appendTransitionEvent(runDir, state, from, status, {}, lock);
  if (TERMINAL.has(status)) {
    const note = state.gate?.summary ?? resultSummary(state.result) ?? state.error?.message;
    process.stdout.write(`[node] ${state.id} ${status}${note ? ` · ${note}` : ""}\n`);
  }
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle|null} [lock]
 */
function ensureTerminalEvent(runDir, state, lock = null) {
  if (!hasDoneEvent(runDir, state.id, state.attempt)) {
    appendTransitionEvent(runDir, state, "done", "done", { recovery: "terminal side effects replayed" }, lock);
  }
}

/**
 * Whether a `done` transition for this node and attempt was already durably
 * recorded, at any point in the past. This is the idempotent signal for "this
 * attempt's integration effects were already fully applied at least once" —
 * a later, unrelated change to the node's current status is not evidence
 * that they need reapplying.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {number} attempt
 * @returns {boolean}
 */
function hasDoneEvent(runDir, nodeId, attempt) {
  let text = "";
  try { text = readFileSync(join(runDir, "events.jsonl"), "utf8"); } catch {}
  return text.split("\n").filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line);
      return event.node === nodeId && event.to === "done" && event.attempt === attempt;
    } catch {
      return false;
    }
  });
}

/**
 * @param {unknown} result
 * @returns {string|null}
 */
function resultSummary(result) {
  if (typeof result === "object" && result !== null && "summary" in result) {
    const summary = /** @type {{summary?: unknown}} */ (result).summary;
    if (typeof summary === "string") return summary;
  }
  return typeof result === "string" && result ? excerpt(result) : null;
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {string} from
 * @param {string} to
 * @param {Record<string, unknown>} [details]
 * @param {LockHandle|null} [lock]
 */
function appendTransitionEvent(runDir, state, from, to, details = {}, lock = null) {
  lock?.assert();
  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    at: state.updatedAt,
    node: state.id,
    sourceIdentity: state.sourceIdentity,
    packetHash: state.packetHash,
    from,
    to,
    phase: state.phase,
    ...details,
  };
  if (state.attempt) event.attempt = state.attempt;
  if (state.runtime?.id) event.runtime = state.runtime.id;
  if (state.error?.code) event.error = state.error.code;
  if (state.gate?.verdict) event.verdict = state.gate.verdict;
  if (state.gate?.summary) event.summary = state.gate.summary;
  if (state.revisions) event.revisions = state.revisions;
  const invocation = state.invocations?.at(-1);
  if (invocation?.id) event.invocationId = invocation.id;
  validateEvent(event);
  appendJsonl(join(runDir, "events.jsonl"), event);
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {import("./contract.mjs").ExecutionOverride} override
 * @param {LockHandle} lock
 */
function recordExecutionOverride(runDir, state, override, lock) {
  const entry = { ...override, at: override.at ?? new Date().toISOString() };
  state.executionOverrides = [...(state.executionOverrides ?? []), entry];
  writeNode(runDir, state, lock);
  appendTransitionEvent(runDir, state, state.status, state.status, { override: entry, recovery: entry.decision }, lock);
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle|null} [lock]
 */
function writeNode(runDir, state, lock = null) {
  lock?.assert();
  validateNodeSnapshot(state);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > 128 * 1024) throw new Error("node snapshot exceeds 131072 bytes");
  writeTextAtomic(join(runDir, "nodes", `${state.id}.json`), `${serialized}\n`);
}

/**
 * @param {string} runDir
 * @param {string} runsDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle|null} [lock]
 */
function render(runDir, runsDir, contract, states, lock = null) {
  lock?.assert();
  writeTextAtomic(join(runDir, "STATUS.md"), renderFinalStatus(runDir, contract, states));
  writeStatusArtifacts(runDir, runsDir, contract, states);
}

const STATUS_MARK = {
  pending: "[ ]",
  running: "[>]",
  done: "[+]",
  "no-op": "[.]",
  blocked: "[!]",
  failed: "[x]",
  exhausted: "[$]",
  stalled: "[~]",
  canceled: "[/]",
};

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
function renderFinalStatus(runDir, contract, states) {
  const nodes = /** @type {NodeSnapshot[]} */ (contract.nodes.map((node) => states.get(node.id)).filter((node) => node !== undefined));
  const runMetadata = /** @type {{identityWarnings?: string[]}} */ (readJson(join(runDir, "run.json")) ?? {});
  const identityWarnings = runMetadata.identityWarnings ?? [];
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  // The note carries every advisory marker a node earned (scope finding,
  // review verdict, gate summary), so the cell holds the composed note whole.
  const widths = [3, 24, 9, 28, 7, 64];
  /** @param {unknown[]} cells */
  const row = (cells) => cells.map((cell, index) => fitStatus(String(cell ?? ""), widths[index])).join(" ");
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    contract.goal,
    "",
    `${nodes.length} nodes · ${summary}`,
    "",
    "```",
    row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]),
    row(widths.map((width) => "-".repeat(width))),
  ];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const detail = statusNote(node) ?? "-";
    // A scope finding leads the note and drops the phase boilerplate: the
    // operator has to see it, and the fixed cell cannot hold both.
    const note = scopeFindingsNote(node.scopeFindings)
      ? detail
      : `${detail} · phase ${planNode?.phase ?? "-"} · ${node.invocations?.at(-1)?.continuationMode ?? "fresh"}`;
    lines.push(row([STATUS_MARK[node.status] ?? "[?]", node.id, node.status, runtime, node.attempt ?? 0, note]));
  }
  lines.push("```", "", "## Needs you", "");
  const attention = nodes.filter((node) => !["pending", "running", "done"].includes(node.status));
  if (!attention.length && !identityWarnings.length) lines.push("Nothing needs you right now.");
  for (const warning of identityWarnings) lines.push(`- [~] ${warning}`);
  for (const node of attention) lines.push(`- ${STATUS_MARK[node.status] ?? "[?]"} ${node.id}: ${node.gate?.summary ?? node.error?.message ?? node.status}`);
  return `${lines.join("\n")}\n`;
}

/** @param {string} value @param {number} width @returns {string} */
function fitStatus(value, width) {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (clean.length <= width) return clean + " ".repeat(width - clean.length);
  return `${clean.slice(0, Math.max(0, width - 2))}..`.padEnd(width, " ");
}

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
function renderFinalReport(runDir, contract, states) {
  const nodes = /** @type {NodeSnapshot[]} */ (contract.nodes.map((node) => states.get(node.id)).filter((node) => node !== undefined));
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 7, 7, 28, 10, 10, 10, 12, 64];
  /** @param {unknown[]} cells */
  const row = (cells) => cells.map((cell, index) => fitStatus(String(cell ?? ""), widths[index])).join(" ");
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let totalCostUsd = null;
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    `${nodes.length} nodes · ${summary}`,
    "",
    "```",
    row(["", "NODE", "STATE", "TRY", "REV", "RUNTIME", "IN", "OUT", "CACHE", "COST", "NOTE"]),
    row(widths.map((width) => "-".repeat(width))),
  ];
  for (const node of nodes) {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    if (typeof node.costUsd === "number" && Number.isFinite(node.costUsd)) totalCostUsd = (totalCostUsd ?? 0) + node.costUsd;
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const detail = node.gate?.summary ?? node.error?.message ?? (node.blockedBy?.length ? node.blockedBy.join(", ") : null) ?? (typeof node.result === "string" && node.result.trim() ? node.result.trim() : node.phase ?? "-");
    // The advisory scope finding leads the note, as it does in STATUS.md.
    const note = scopeFindingsNote(node.scopeFindings)
      ? `${scopeFindingsNote(node.scopeFindings)} · ${detail}`
      : `${detail} · phase ${planNode?.phase ?? "-"} · ${node.invocations?.at(-1)?.continuationMode ?? "fresh"}`;
    lines.push(row([
      STATUS_MARK[node.status] ?? "[?]",
      node.id,
      node.status,
      node.attempt ?? 0,
      node.revisions ?? 0,
      runtime,
      compactTokens(usage.inputTokens),
      compactTokens(usage.outputTokens),
      compactTokens(usage.cacheReadInputTokens),
      compactCost(node.costUsd),
      note,
    ]));
  }
  lines.push("```", "", `totals · in ${compactTokens(totals.inputTokens)} · out ${compactTokens(totals.outputTokens)} · cache ${compactTokens(totals.cacheReadInputTokens)} · cost ${compactCost(totalCostUsd)}`);
  return `${lines.join("\n")}\n`;
}

/** @param {number|null|undefined} value @returns {string} */
function compactTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** @param {number|null|undefined} value @returns {string} */
function compactCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "-";
}

/**
 * Consolidated terminal-state handoff: one bounded JSON snapshot in the run
 * dir so a triage session never loads full run state. Nodes stay the source
 * of truth; this file is a snapshot of the moment the run finished. Written
 * when any node ended non-done; removed when a later resume drives the run
 * fully done, so a stale snapshot cannot outlive the state it described.
 *
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 */
function writeFindingsArtifact(runDir, contract, states) {
  const failing = [...states.values()].filter((state) => state.status !== "done");
  const path = join(runDir, "findings.json");
  if (!failing.length) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return;
  }
  const counts = new Map();
  for (const state of states.values()) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  writeJsonAtomic(path, {
    schemaVersion: 1,
    run: contract.id,
    goal: contract.goal,
    summary: [...counts].map(([status, count]) => `${count} ${status}`).join(" · "),
    nodes: failing.map((state) => ({
      id: state.id,
      status: state.status,
      attempt: state.attempt,
      revisions: state.revisions,
      error: state.error,
      gate: state.gate,
      ...(state.blockedBy?.length ? { blockedBy: state.blockedBy } : {}),
      ...missingContextOf(state),
      ...unexpectedPathsOf(state),
    })),
  });
}

/**
 * @param {NodeSnapshot} state
 * @returns {{missingContext?: string[]}}
 */
function missingContextOf(state) {
  const result = /** @type {{missingContext?: unknown}|null} */ (state.result);
  if (result && Array.isArray(result.missingContext) && result.missingContext.length) {
    return { missingContext: result.missingContext.map(String) };
  }
  return {};
}

/**
 * An `unexpected_write` failure is only actionable with the offending paths,
 * and the bounded error message truncates them. Carry a bounded list into the
 * artifact so triage never has to open the node file.
 *
 * @param {NodeSnapshot} state
 * @returns {{unexpectedPaths?: string[]}}
 */
function unexpectedPathsOf(state) {
  const scope = /** @type {{unexpectedPaths?: unknown}|null|undefined} */ (state.scope);
  if (scope && Array.isArray(scope.unexpectedPaths) && scope.unexpectedPaths.length) {
    return { unexpectedPaths: scope.unexpectedPaths.slice(0, 16).map(String) };
  }
  return {};
}

/**
 * Run-owned worker-result sidecar. It lives in its own directory because every
 * `.json` directly under `nodes/` is a validated node snapshot — status,
 * report, campaign summary, and signal readers reject or miscount anything
 * else there.
 *
 * @param {string} runDir @param {string} nodeId @returns {string} */
function workerResultPath(runDir, nodeId) {
  return join(runDir, "results", `${nodeId}.json`);
}

/** @param {string} runDir @param {string} nodeId @param {string} workspace @returns {string} */
function attemptWorkerResultPath(runDir, nodeId, workspace) {
  return join(workspace, ".runs", "results", `${nodeId}.json`);
}

/** @param {string} workspace @param {string} nodeId */
function clearAttemptWorkerResult(workspace, nodeId) {
  try { unlinkSync(attemptWorkerResultPath("", nodeId, workspace)); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** @param {string} runDir @param {NodeSnapshot} state @param {ValidatedNode} node */
function materializeAttemptResult(runDir, state, node) {
  const workspace = attemptWorkspace(state);
  if (!workspace) return;
  const source = attemptWorkerResultPath(runDir, node.id, workspace);
  if (!existsSync(source)) return;
  writeTextAtomic(workerResultPath(runDir, node.id), readFileSync(source, "utf8"));
}

/**
 * The run-owned result file is the primary recovery source. The provider's
 * final message is intentionally only redundant input.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {WorkerResult|null}
 */
function readWorkerResultFile(runDir, nodeId) {
  const path = workerResultPath(runDir, nodeId);
  if (!existsSync(path)) return null;
  try {
    return parseWorkerResult(JSON.stringify(readJson(path)));
  } catch (error) {
    throw new TypeError(`canonical worker result ${path} is invalid: ${errorMessage(error)}`);
  }
}

/** @param {string} runDir @param {string} nodeId @param {WorkerResult} result */
function persistWorkerResultFile(runDir, nodeId, result) {
  writeJsonAtomic(workerResultPath(runDir, nodeId), result);
}

/** @param {string} runDir @param {string} nodeId */
function clearWorkerResultFile(runDir, nodeId) {
  try { unlinkSync(workerResultPath(runDir, nodeId)); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** First line of the one-turn result-materialization prompt. */
const RESULT_MATERIALIZATION_PROMPT_HEADER = "The implementation is already complete.";

/**
 * The canonical result text without validation. Presence is authoritative:
 * adoption decisions must surface a present-but-invalid file as an invalid
 * result, never treat it as missing work.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {string|null}
 */
function canonicalWorkerResultText(runDir, nodeId) {
  const path = workerResultPath(runDir, nodeId);
  if (!existsSync(path)) return null;
  try { return JSON.stringify(readJson(path)); } catch { return readFileSync(path, "utf8"); }
}

/**
 * The materialization mode must survive controller interruption, so it is
 * derived from the persisted invocation prompt — the run-owned record of what
 * that turn was asked to do — instead of in-memory job state.
 *
 * @param {Invocation|null|undefined} invocation
 * @returns {boolean}
 */
function isResultMaterializationInvocation(invocation) {
  if (!invocation?.promptPath) return false;
  try {
    return readFileSync(invocation.promptPath, "utf8").startsWith(RESULT_MATERIALIZATION_PROMPT_HEADER);
  } catch {
    return false;
  }
}

/**
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {unknown} providerResult
 * @returns {WorkerResult}
 */
function resolveWorkerResult(runDir, node, providerResult) {
  const fromFile = readWorkerResultFile(runDir, node.id);
  if (fromFile) return fromFile;
  const result = parseWorkerResult(String(extractJson(providerResult) ?? providerResult ?? ""));
  persistWorkerResultFile(runDir, node.id, result);
  return result;
}

/**
 * @param {string} prompt
 * @param {string} resultPath
 * @returns {string}
 */
function workerProtocolPrompt(prompt, resultPath) {
  return [
    prompt,
    "Controller worker protocol:",
    `Before your final response, write the required worker-result JSON object to this canonical result file: ${resultPath}`,
    "Your final provider message is redundant; the result file is the recovery source.",
  ].join("\n\n");
}

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @param {string} phase
 * @param {number} attempt
 * @returns {PathSet}
 */
function logPaths(runDir, nodeId, phase, attempt) {
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
function readBoundedTail(path, maxBytes = 512 * 1024) {
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

/**
 * Parse a result persisted in a node checkpoint or operation settlement. The
 * provider stream remains the first source of evidence; this path is used only
 * after that stream is unavailable.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function parsePersistedWorkerResult(value) {
  if (value === undefined || value === null) return null;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    parseWorkerResult(String(extractJson(serialized) ?? serialized));
    return serialized;
  } catch {
    return null;
  }
}

/**
 * Durable worker-result evidence for recovery, in authority order: the run-owned
 * canonical file first, then the operation settlement, then the node snapshot.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Record<string, unknown>|null} settlement
 * @returns {string|null}
 */
function persistedWorkerResult(runDir, state, invocation, settlement) {
  const fromFile = canonicalWorkerResultText(runDir, state.id);
  if (fromFile !== null) return fromFile;
  const fromSettlement = parsePersistedWorkerResult(settlement?.result);
  if (fromSettlement) return fromSettlement;
  if (invocation.status !== "active") return parsePersistedWorkerResult(state.result);
  return null;
}

/**
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Record<string, unknown>|null} settlement
 * @returns {unknown|null}
 */
function persistedJudgeResult(state, invocation, settlement) {
  const candidates = [settlement?.result, invocation.status !== "active" ? state.gate : null];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    try {
      const serialized = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      parseJudge(serialized);
      return serialized;
    } catch {}
  }
  return null;
}

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<RecoveryOutcome|null>}
 */
async function recoverOrphan(runDir, contract, node, state, lock) {
  const invocation = state.invocations?.at(-1);
  if (state.status !== "running") return null;
  if (!invocation) return { kind: "restart", reason: `node ${state.id} has no live invocation` };
  if (hasOperationIntent(runDir, invocation.id) && operationNeedsRecovery(runDir, invocation.id)) {
    // Persist the classification before inspecting any provider or workspace
    // evidence. A controller can therefore die again without losing the fact
    // that this invocation's external effect was ambiguous.
    settleInvocation(runDir, invocation, {
      status: "unknown_effect",
      terminalOutcome: "unknown_effect",
      unknownEffect: true,
      classification: "unknown_effect",
      reason: `invocation ${invocation.id} has an intent but no terminal settlement`,
      nextState: operationNextState(state),
    });
  }
  const settlement = readOperationSettlement(runDir, invocation.id);
  const runtime = invocation?.runtimeId
    ? runtimeSnapshot(contract, invocation.runtimeId)
    : routeRuntimeForState(contract, node, state, invocation?.phase === "judge" ? "judge" : "worker");
  const startedAt = Date.parse(invocation.startedAt);
  const timeoutSec = latestTimeoutSec(state, node.timeoutSec ?? contract.timeoutSec);
  const deadline = Number.isFinite(startedAt) && Number.isFinite(timeoutSec)
    ? startedAt + timeoutSec * 1_000
    : null;
  if (deadline === null || !Number.isFinite(deadline)) {
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    const terminal = invocationResult(invocation, runtime, { preferStructured: invocation.phase === "judge" });
    if (terminal?.status === "done") {
      if (invocation.phase === "judge") return adoptOrRejudgeJudge(state, contract, node, invocation, terminal);
      return /** @type {RecoveryOutcome} */ ({ kind: "adopted", ...terminal, phase: invocation.phase, invocationId: invocation.id });
    }
    const persisted = invocation.phase === "worker"
      ? persistedWorkerResult(runDir, state, invocation, settlement)
      : persistedJudgeResult(state, invocation, settlement);
    if (persisted) {
      if (invocation.phase === "judge") {
        return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "judge", result: persisted, invocationId: invocation.id });
      }
      return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "worker", result: persisted, invocationId: invocation.id });
    }
    return restartRecovery(invocation, terminal, `invocation ${invocation.id} has no reliable start time or timeout deadline`);
  }
  if (invocation.closedAt !== null && !Number.isFinite(Date.parse(invocation.closedAt))) {
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    const terminal = invocationResult(invocation, runtime, { preferStructured: invocation.phase === "judge" });
    if (terminal?.status === "done") {
      if (invocation.phase === "judge") return adoptOrRejudgeJudge(state, contract, node, invocation, terminal);
      return /** @type {RecoveryOutcome} */ ({ kind: "adopted", ...terminal, phase: invocation.phase, invocationId: invocation.id });
    }
    const persisted = invocation.phase === "worker"
      ? persistedWorkerResult(runDir, state, invocation, settlement)
      : persistedJudgeResult(state, invocation, settlement);
    if (persisted) {
      if (invocation.phase === "judge") {
        return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "judge", result: persisted, invocationId: invocation.id });
      }
      return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "worker", result: persisted, invocationId: invocation.id });
    }
    return restartRecovery(invocation, terminal, `invocation ${invocation.id} has no reliable close time`);
  }
  if (invocation && invocationAlive(invocation)) {
    if (Date.now() > deadline) {
      await terminateInvocation(invocation);
      return restartRecovery(invocation, invocationResult(invocation, runtime), `${invocation.phase} invocation ${invocation.id} exceeded its wall-clock budget`);
    }
    while (invocationAlive(invocation) && Date.now() < deadline) {
      const result = invocationResult(invocation, runtime, { preferStructured: invocation.phase === "judge" });
      if (result?.status === "done") {
        if (Date.now() > deadline || (invocation.closedAt !== null && Date.parse(invocation.closedAt) > deadline)) {
          await terminateInvocation(invocation);
          return restartRecovery(invocation, result, `${invocation.phase} invocation ${invocation.id} completed after its wall-clock budget`);
        }
        await terminateInvocation(invocation);
        if (invocation.phase === "judge") return adoptOrRejudgeJudge(state, contract, node, invocation, result);
        return /** @type {RecoveryOutcome} */ ({ kind: "adopted", ...result, phase: invocation.phase, invocationId: invocation.id });
      }
      await delay(Math.min(contract.pollIntervalMs, 250));
    }
    const expired = Date.now() >= deadline;
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    if (expired) return restartRecovery(invocation, null, `${invocation.phase} invocation ${invocation.id} exceeded its wall-clock budget`);
    if (invocation.closedAt === null) {
      const persisted = invocation.phase === "worker"
        ? persistedWorkerResult(runDir, state, invocation, settlement)
        : persistedJudgeResult(state, invocation, settlement);
      if (persisted) return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: invocation.phase === "judge" ? "judge" : "worker", result: persisted, invocationId: invocation.id });
      return restartRecovery(invocation, null, `${invocation.phase} invocation ${invocation.id} has no reliable close time`);
    }
    if (invocation.phase === "judge") {
      const result = invocationResult(invocation, runtime, { preferStructured: true, exitCode: invocation.exitCode, signal: invocation.signal });
      if (result?.status === "done") return adoptOrRejudgeJudge(state, contract, node, invocation, result);
      if (result?.status === "exhausted") return {
        kind: "exhausted",
        phase: "judge",
        invocationId: invocation.id,
        usage: result.usage,
        costUsd: result.costUsd,
        error: result.error,
        reason: result.error?.message,
      };
      const persisted = persistedJudgeResult(state, invocation, settlement);
      if (persisted) return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "judge", result: persisted, invocationId: invocation.id });
      return rejudgeOrRestart(state, contract, node, invocation, result);
    }
  }
  if (invocation) {
    const closedAt = Date.parse(invocation.closedAt ?? "");
    if (!Number.isFinite(closedAt) || closedAt > deadline) {
      return restartRecovery(invocation, null, `${invocation.phase} invocation ${invocation.id} completed after its wall-clock budget`);
    }
    if (invocation.closedAt === null) {
      return restartRecovery(invocation, null, `${invocation.phase} invocation ${invocation.id} has no reliable close time`);
    }
    const result = invocationResult(invocation, runtime, { preferStructured: invocation.phase === "judge", exitCode: invocation.exitCode, signal: invocation.signal });
    if (invocation.phase === "judge") {
      if (result?.status === "done") return adoptOrRejudgeJudge(state, contract, node, invocation, result);
      if (result?.status === "exhausted") return {
        kind: "exhausted",
        phase: "judge",
        invocationId: invocation.id,
        usage: result.usage,
        costUsd: result.costUsd,
        error: result.error,
        reason: result.error?.message,
      };
      return rejudgeOrRestart(state, contract, node, invocation, result);
    }
    if (result?.status === "done") return /** @type {RecoveryOutcome} */ ({ kind: "adopted", ...result, phase: invocation.phase, invocationId: invocation.id });
    if (result?.status === "exhausted") return /** @type {RecoveryOutcome} */ ({ kind: "exhausted", ...result, phase: invocation.phase, invocationId: invocation.id, reason: result.error?.message });
    const persisted = persistedWorkerResult(runDir, state, invocation, settlement);
    if (persisted) return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "worker", result: persisted, invocationId: invocation.id });
    return restartRecovery(invocation, result, `${invocation.phase} invocation ${invocation.id} died without a completed stream`);
  }
  return { kind: "restart", reason: `node ${state.id} died without a completed stream` };
}

/** @param {Invocation} invocation @param {ProviderEnvelope|null} result @param {string} reason @returns {RecoveryOutcome} */
function restartRecovery(invocation, result, reason) {
  return /** @type {RecoveryOutcome} */ ({
    kind: "restart",
    phase: invocation.phase,
    invocationId: invocation.id,
    usage: result?.usage ?? invocation.usage,
    costUsd: result?.costUsd ?? invocation.costUsd,
    reason,
  });
}

/**
 * @param {Record<string, unknown>} override
 * @param {string|undefined} invocationId
 * @returns {RecoveryOutcome}
 */
function recoveryFromOverride(override, invocationId) {
  const decision = override.decision;
  return /** @type {RecoveryOutcome} */ ({
    kind: decision === "rejudge"
      ? "rejudge"
      : decision === "restart" || decision === "safe_replay"
        ? "restart"
        : decision === "reconciled"
          ? "reconciled"
          : "adopted",
    phase: override.phase,
    result: override.result,
    usage: override.usage,
    costUsd: override.costUsd,
    reason: override.reason,
    invocationId,
  });
}

/**
 * @param {NodeSnapshot} state
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {Invocation} judgeInvocation
 * @param {ProviderEnvelope|null} [judgeResult]
 * @returns {RecoveryOutcome}
 */
function rejudgeOrRestart(state, contract, node, judgeInvocation, judgeResult = null) {
  const workerInvocation = [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
  const workerResult = workerInvocation && invocationResult(
    workerInvocation,
    workerInvocation.runtimeId ? runtimeSnapshot(contract, workerInvocation.runtimeId) : routeRuntimeForState(contract, node, state, "worker"),
  );
  if (workerResult?.status === "done") {
    return /** @type {RecoveryOutcome} */ ({
      kind: "rejudge",
      phase: "worker",
      result: workerResult.result,
      usage: judgeResult?.usage,
      costUsd: judgeResult?.costUsd,
      invocationId: judgeInvocation.id,
    });
  }
  return /** @type {RecoveryOutcome} */ ({
    kind: "restart",
    phase: "judge",
    invocationId: judgeInvocation.id,
    usage: judgeResult?.usage,
    costUsd: judgeResult?.costUsd,
    reason: `judge invocation ${judgeInvocation.id} completed but its worker stream is unavailable`,
  });
}

/**
 * @param {NodeSnapshot} state
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {Invocation} judgeInvocation
 * @param {ProviderEnvelope} result
 * @returns {RecoveryOutcome}
 */
function adoptOrRejudgeJudge(state, contract, node, judgeInvocation, result) {
  try {
    parseJudge(result.result ?? "");
    return /** @type {RecoveryOutcome} */ ({
      kind: "adopted",
      phase: "judge",
      result: result.result,
      usage: result.usage,
      costUsd: result.costUsd,
      invocationId: judgeInvocation.id,
    });
  } catch {
    return rejudgeOrRestart(state, contract, node, judgeInvocation, result);
  }
}

/**
 * @param {Invocation[]|undefined} invocations
 * @param {string|undefined} invocationId
 * @param {Usage|undefined} [usage]
 * @param {number|null|undefined} [costUsd]
 * @returns {Invocation[]}
 */
function closePersistedInvocation(invocations, invocationId, usage = undefined, costUsd = undefined) {
  return (invocations ?? []).map((invocation) => invocation.id === invocationId ? {
    ...invocation,
    status: "closed",
    usage: usage ?? invocation.usage,
    costUsd: costUsd ?? invocation.costUsd ?? null,
    closedAt: invocation.closedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } : invocation);
}

/**
 * The worker result backing a judge-phase recovery. The canonical file is
 * primary: a present-but-invalid file throws so the caller surfaces an
 * invalid result, and only an absent file falls back to the transcript.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @returns {WorkerResult|null}
 */
function recoverWorkerResult(runDir, state, contract, node) {
  const fromFile = canonicalWorkerResultText(runDir, state.id);
  if (fromFile !== null) {
    // Presence is authoritative: an unparsable canonical file is an invalid
    // result, never a license to adopt provider-derived evidence instead.
    return parseWorkerResult(String(extractJson(fromFile) ?? fromFile));
  }
  const invocation = [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
  if (!invocation) return null;
  const result = invocationResult(invocation, invocation.runtimeId ? runtimeSnapshot(contract, invocation.runtimeId) : routeRuntimeForState(contract, node, state, "worker"));
  if (result?.status !== "done") return null;
  try { return parseWorkerResult(result.result ?? ""); } catch { return null; }
}

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @returns {NodeSnapshot[]}
 */
function readRunNodes(runDir, contract) {
  const nodeDir = join(runDir, "nodes");
  const names = readdirSync(nodeDir).filter((name) => name.endsWith(".json"));
  const expected = new Map(contract.nodes.map((node) => [`${node.id}.json`, node]));
  for (const name of names) if (!expected.has(name)) throw new TypeError(`unexpected persisted node snapshot ${name}`);
  return contract.nodes.map((node) => {
    const name = `${node.id}.json`;
    if (!names.includes(name)) throw new TypeError(`missing persisted node snapshot ${name}`);
    return validateNodeSnapshot(JSON.parse(readFileSync(join(nodeDir, name), "utf8")), node);
  });
}

const DRIVER_PROBE_RETRIES = 2;
const DRIVER_PROBE_RETRY_BACKOFF_MS = 250;

/**
 * Probe a runtime version, retrying transient unavailability so a loaded host
 * is never misread as a changed driver. Only a concrete version or final
 * unavailability leaves this function.
 *
 * @param {import("./drivers/index.mjs").DriverRuntime & {capabilities?: unknown}} runtime
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function probeRuntimeVersionStable(runtime, cwd) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await probeRuntime(runtime, { cwd, timeoutSec: 5 });
    if (result.version !== null || attempt >= DRIVER_PROBE_RETRIES) return result.version ?? null;
    await new Promise((resolveRetry) => setTimeout(resolveRetry, DRIVER_PROBE_RETRY_BACKOFF_MS * 2 ** attempt));
  }
}

/**
 * Capture the run's source identity, including one version-only probe per
 * distinct routed runtime (a local binary call, no model tokens) so a later
 * resume can refuse a driver that was upgraded or broke mid-campaign.
 *
 * @param {ValidatedContract} contract
 * @param {Map<string, import("./verification.mjs").WorkspaceScopeBoundary>} scopeBoundaries
 * @returns {Promise<SourceIdentity>}
 */
async function captureRunIdentity(contract, scopeBoundaries) {
  const runtimes = reachableRuntimes(contract);
  const versionsPromise = Promise.all([...runtimes.entries()].map(async ([id, { runtime }]) => {
    return [id, await probeRuntimeVersionStable(runtime, contract.cwd)];
  }));
  const ignorePaths = [...new Set([...scopeBoundaries.values()].flatMap((boundary) => boundary.files))];
  const ignoreRoots = [...new Set([...scopeBoundaries.values()].flatMap((boundary) => boundary.roots))];
  const identity = captureSourceIdentity(contract, {}, { ignorePaths, ignoreRoots });
  const versions = await versionsPromise;
  return { ...identity, driverVersions: Object.fromEntries(versions) };
}

/**
 * Compare the recorded source identity with the current one. A HEAD that
 * descends from the recorded one is accepted and recorded — workers and the
 * orchestrator commit between attempts, so a retry in place expects the branch
 * to have moved on — while a non-descendant HEAD is still drift. A dirty-tree
 * fingerprint mismatch is only a warning: the fingerprint covers the whole
 * tree, so any committed work between attempts changes it.
 *
 * @param {SourceIdentity|undefined} expected
 * @param {SourceIdentity|undefined} actual
 * @returns {{warnings: string[]}} warnings to surface in status
 */
function assertSourceUnchanged(expected, actual) {
  const fields = ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "driverVersions"];
  /** @type {string[]} */
  const warnings = [];
  for (const field of fields) {
    const expectedRecord = /** @type {Record<string, unknown>|undefined} */ (expected);
    const actualRecord = /** @type {Record<string, unknown>|undefined} */ (actual);
    if (expectedRecord?.[field] === undefined) throw new Error(`source identity is incomplete; resume refused`);
    if (field === "driverVersions") {
      const expectedVersions = /** @type {Record<string, string|null>} */ (expectedRecord?.[field] ?? {});
      const actualVersions = /** @type {Record<string, string|null>} */ (actualRecord?.[field] ?? {});
      const ids = new Set([...Object.keys(expectedVersions), ...Object.keys(actualVersions)]);
      for (const id of ids) {
        const expectedVersion = expectedVersions[id] ?? null;
        const actualVersion = actualVersions[id] ?? null;
        if (expectedVersion === actualVersion) continue;
        if (expectedVersion === null || actualVersion === null) {
          throw new Error(`driver probe unavailable for ${id}; resume refused`);
        }
        throw new Error("source drift detected in driverVersions; resume refused");
      }
      continue;
    }
    if (field === "gitHead" && stableJson(expectedRecord?.gitHead ?? null) !== stableJson(actualRecord?.gitHead ?? null)) {
      const expectedHead = typeof expectedRecord?.gitHead === "string" ? expectedRecord.gitHead : null;
      const actualHead = typeof actualRecord?.gitHead === "string" ? actualRecord.gitHead : null;
      if (expectedHead && actualHead && isDescendantHead(expected?.cwd, expectedHead, actualHead)) continue;
      throw new Error(`source drift detected in gitHead; resume refused`);
    }
    if (field === "dirtyTreeFingerprint" && stableJson(expectedRecord?.[field] ?? null) !== stableJson(actualRecord?.[field] ?? null)) {
      warnings.push("source tree fingerprint changed since the run started; work committed between attempts is expected and the run continues on the current tree");
      continue;
    }
    if (stableJson(expectedRecord?.[field] ?? null) !== stableJson(actualRecord?.[field] ?? null)) {
      throw new Error(`source drift detected in ${field}; resume refused`);
    }
  }
  return { warnings };
}

/**
 * Whether `head` is a descendant of `recorded` (or the same commit).
 *
 * @param {string|undefined} cwd
 * @param {string} recorded
 * @param {string} head
 * @returns {boolean}
 */
function isDescendantHead(cwd, recorded, head) {
  if (!cwd) return false;
  const result = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", recorded, head], { encoding: "utf8" });
  return result.status === 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {Usage|undefined} left
 * @param {Usage|undefined} right
 * @returns {Usage}
 */
function addUsage(left, right) {
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    cacheReadInputTokens: (left?.cacheReadInputTokens ?? 0) + (right?.cacheReadInputTokens ?? 0),
  };
}

/** @param {number|undefined} left @param {number|null|undefined} right @returns {number} */
function addCost(left, right) {
  return (left ?? 0) + (right ?? 0);
}

/**
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
function statesFingerprint(states) {
  return [...states.values()].map((state) => `${state.id}:${state.status}:${state.phase}:${state.attempt ?? 0}:${state.revisions ?? 0}`).join("|");
}

/**
 * @param {ValidatedContract} contract
 * @returns {ValidatedContract}
 */
function serializableContract(contract) {
  const { warnings, ...rest } = contract;
  return {
    ...rest,
    warnings,
    nodes: contract.nodes.map((node) => {
      const copy = /** @type {Record<string, unknown>} */ ({ ...node });
      delete copy.prompt;
      delete copy.promptFile;
      delete copy.taskPacketFile;
      return /** @type {ValidatedNode} */ (copy);
    }),
  };
}

/**
 * @param {string} runDirPath
 * @returns {Promise<boolean>}
 */
export async function cancelRun(runDirPath) {
  const runDir = resolve(runDirPath);
  assertRunMutable(runDir);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  writeJsonAtomic(join(runDir, "cancel.request.json"), { requestedAt: new Date().toISOString(), pid: process.pid });
  const current = readLock(runDir);
  const holder = current && !current.invalid ? /** @type {LockRecord} */ (current) : null;
  if (holder && holder.pid === process.pid) {
    throw new Error("cancel cannot take over a controller lock held by this process");
  }
  if (holder) {
    const controller = { pid: holder.pid, processStartToken: holder.processStartToken };
    if (invocationAlive(controller)) {
      signalController(holder, "SIGTERM");
      if (!await waitForProcessDeath(controller, 2_000)) {
        signalController(holder, "SIGKILL");
        if (!await waitForProcessDeath(controller, 2_000)) throw new Error("cancel could not confirm controller termination");
      }
    }
  }
  const controllerLock = await acquireStaleLock(runDir);
  try {
    const states = readRunNodes(runDir, contract);
    /** @type {Error[]} */
    const failures = [];
    for (const state of states) {
      for (const invocation of state.invocations ?? []) {
        if (invocation.status === "active" || invocationAlive(invocation)) {
          try {
            await terminateInvocation(invocation);
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
      for (const invocation of state.invocations ?? []) {
        if (invocationAlive(invocation)) failures.push(new Error(`provider invocation ${invocation.id} is still alive after cancellation`));
      }
      for (const attempt of state.verification?.attempts ?? []) {
        if (attempt.status !== "active" && (!attempt.pid || !invocationAlive(attempt))) continue;
        if (attempt.pid) {
          try {
            await terminateInvocation({
              id: attempt.invocationId,
              pid: attempt.pid,
              processGroupId: attempt.processGroupId,
              processStartToken: attempt.processStartToken,
            });
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (attempt.pid && invocationAlive(attempt)) failures.push(new Error(`verification attempt ${attempt.invocationId} is still alive after cancellation`));
        const completedAt = new Date().toISOString();
        state.verification = state.verification ?? { passed: false, commands: [], completed: false, attempts: [] };
        state.verification.attempts = (state.verification.attempts ?? []).map((item) => item.invocationId === attempt.invocationId
          ? { ...item, status: "canceled", completedAt, result: { passed: false, stdout: "", stderr: "", error: "verification canceled", exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: null } }
          : item);
        state.verification.completed = true;
        state.verification.passed = false;
        state.verification.error = "verification canceled";
      }
      if (state.verification?.attempts?.length) writeNode(runDir, state, controllerLock);
      if (failures.length) continue;
      const closedAt = new Date().toISOString();
      const invocations = (state.invocations ?? []).map((invocation) => invocation.status === "active"
        ? { ...invocation, status: "terminated", closedAt, updatedAt: closedAt }
        : invocation);
      if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled", invocations }, controllerLock);
    }
    if (failures.length) {
      const error = new Error(`cancel could not confirm termination of ${failures.length} invocation${failures.length === 1 ? "" : "s"}`);
      error.cause = failures[0];
      throw error;
    }
    if (!await waitForTerminal(runDir, 1_000)) throw new Error("cancel could not confirm a terminal run state");
    syncAgentSignal(join(runDir, ".."));
    return true;
  } finally {
    controllerLock.release();
  }
}

/**
 * The controller pid is already confirmed dead (or was never alive) by the
 * time this is called, so the lock is stale and acquire() takes it over on
 * its own; the retry here only covers a lock file whose write has not
 * settled yet, never a live rival.
 * @param {string} runDir
 * @returns {Promise<LockHandle>}
 */
async function acquireStaleLock(runDir) {
  for (;;) {
    try {
      return acquireLock(runDir);
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      const holder = /** @type {LockRecord|null} */ (error.lock);
      if (!holder || pidAlive(holder.pid)) throw error;
      await delay(50);
    }
  }
}

/**
 * @param {LockRecord} lock
 * @param {NodeJS.Signals} signal
 */
function signalController(lock, signal) {
  if (!invocationAlive({ pid: lock.pid, processStartToken: lock.processStartToken })) return;
  try {
    process.kill(lock.pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

/**
 * @param {InvocationProbe} invocation
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForProcessDeath(invocation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!invocationAlive(invocation)) return true;
    await delay(50);
  }
  return !invocationAlive(invocation);
}

/**
 * @param {string} runDir
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForTerminal(runDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const contractPath = join(runDir, "contract.json");
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
    const states = readRunNodes(runDir, contract);
    if (states.every((state) => TERMINAL.has(state.status)) && states.every((state) => (state.invocations ?? []).every((invocation) => !invocationAlive(invocation)))) return true;
    await delay(100);
  }
  return false;
}

const LIVE_PREFLIGHT_PROMPT = "Respond with exactly INTENT_FACTORY_PREFLIGHT_OK and do not use tools.";
const LIVE_PREFLIGHT_OUTPUT_LIMIT_BYTES = 512 * 1024;

/**
 * @param {string} contractPath
 * @param {{static?: boolean, liveTimeoutSec?: number}} [options]
 * @returns {Promise<ProbeResult[]>}
 */
export async function preflightContract(contractPath, options = {}) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContract(JSON.parse(readFileSync(absoluteContractPath, "utf8")), absoluteContractPath);
  const runtimes = reachableRuntimes(contract);
  const staticChecks = await Promise.all([...runtimes.values()].map(({ runtime, requiredCapabilitySets }) =>
    probeRuntime(runtime, { cwd: contract.cwd, requiredCapabilitySets }),
  ));
  if (options.static === true) return staticChecks;

  const timeoutSec = livePreflightTimeout(options.liveTimeoutSec);
  let liveRepo;
  try {
    liveRepo = createLivePreflightRepo();
  } catch (error) {
    return staticChecks.map((check) => ({
      ...check,
      ok: false,
      live: true,
      liveStatus: "failed",
      detail: `${check.detail ?? "static probe failed"} · live preflight repository failed: ${redactProviderText(errorMessage(error))}`,
    }));
  }
  try {
    return await Promise.all(staticChecks.map(async (check, index) => {
      const runtime = [...runtimes.values()][index].runtime;
      const live = await livePreflight(runtime, liveRepo, timeoutSec);
      const liveDetail = live.status === "done"
        ? `live done · usage ${formatUsage(live.usage)} · cost ${formatCost(live.costUsd)}`
        : `live ${live.status} · ${live.error?.code ?? "provider_error"}: ${redactProviderText(live.error?.message ?? "generation failed")} · usage ${formatUsage(live.usage)} · cost ${formatCost(live.costUsd)}`;
      return {
        ...check,
        ok: check.ok && live.status === "done",
        live: true,
        liveStatus: live.status,
        usage: live.usage,
        costUsd: live.costUsd,
        detail: `${check.detail ?? "static probe failed"} · ${liveDetail}`,
      };
    }));
  } finally {
    rmSync(liveRepo, { recursive: true, force: true });
  }
}

/** @param {number|undefined} configured */
function livePreflightTimeout(configured) {
  const raw = configured ?? (process.env.INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC === undefined
    ? 15
    : Number(process.env.INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC));
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new TypeError("preflight live timeout must be a positive number of seconds");
  }
  return raw;
}

/** @returns {string} */
function createLivePreflightRepo() {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-preflight-"));
  const result = spawnSync("git", ["init", "-q", directory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`git init failed${result.stderr ? `: ${redactProviderText(result.stderr)}` : ""}`);
  }
  return directory;
}

/**
 * @param {RuntimeSnapshot} runtime
 * @returns {RuntimeSnapshot}
 */
function safeLiveRuntime(runtime) {
  if (runtime.driver === "codex") return { ...runtime, sandbox: "read-only" };
  if (runtime.driver === "claude" || runtime.driver === "glm") return { ...runtime, permissionMode: "plan" };
  return { ...runtime };
}

/**
 * @param {RuntimeSnapshot} runtime
 * @param {string} cwd
 * @param {number} timeoutSec
 * @returns {Promise<ProviderEnvelope>}
 */
function livePreflight(runtime, cwd, timeoutSec) {
  const safeRuntime = safeLiveRuntime(runtime);
  let command;
  try {
    command = providerCommand(safeRuntime, LIVE_PREFLIGHT_PROMPT);
  } catch (error) {
    return Promise.resolve({
      status: "failed",
      result: null,
      continuationId: null,
      usage: emptyUsage(),
      costUsd: null,
      error: { code: "command_invalid", message: errorMessage(error) },
    });
  }
  return new Promise((settle) => {
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
    let child;
    try {
      const env = { ...process.env };
      for (const [key, value] of Object.entries(command.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      delete env.INTENT_FACTORY_NOTIFY_BIN;
      child = /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (spawn(command.executable, command.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: [command.promptTransport === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
      }));
    } catch (error) {
      settle({
        status: "failed",
        result: null,
        continuationId: null,
        usage: emptyUsage(),
        costUsd: null,
        error: { code: "spawn_error", message: errorMessage(error) },
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let killTimer = null;
    /** @param {ProviderEnvelope} envelope */
    const finish = (envelope) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      settle(envelope);
    };
    /** @param {NodeJS.Signals} name */
    const signal = (name) => {
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-/** @type {number} */ (child.pid), name);
      } catch {}
    };
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, LIVE_PREFLIGHT_OUTPUT_LIMIT_BYTES); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, LIVE_PREFLIGHT_OUTPUT_LIMIT_BYTES); });
    child.once("error", (error) => finish({
      status: "failed",
      result: null,
      continuationId: null,
      usage: emptyUsage(),
      costUsd: null,
      error: { code: "spawn_error", message: redactProviderText(errorMessage(error)) },
    }));
    child.once("close", (exitCode, signalName) => {
      if (timedOut) {
        finish({
          status: "failed",
          result: null,
          continuationId: null,
          usage: emptyUsage(),
          costUsd: null,
          error: { code: "preflight_timeout", message: `live generation timed out after ${timeoutSec}s` },
        });
        return;
      }
      /** @type {ProviderEnvelope} */
      let envelope;
      try {
        envelope = normalizeProviderResult(safeRuntime, stdout, exitCode, signalName);
      } catch (error) {
        envelope = {
          status: "failed",
          result: null,
          continuationId: null,
          usage: emptyUsage(),
          costUsd: null,
          error: { code: "invalid_output", message: redactProviderText(errorMessage(error)) },
        };
      }
      if (envelope.error) envelope.error = { ...envelope.error, message: redactProviderText(envelope.error.message) };
      finish(envelope);
    });
    timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 100);
    }, timeoutSec * 1_000);
    if (command.promptTransport === "stdin") child.stdin.end(command.input);
  });
}

/** @param {string} current @param {Uint8Array|string} chunk @param {number} limit */
function appendBounded(current, chunk, limit) {
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  return (combined.length > limit ? combined.subarray(combined.length - limit) : combined).toString("utf8");
}

/** @returns {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} */
function emptyUsage() {
  return { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
}

/** @param {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}|undefined} usage */
function formatUsage(usage) {
  if (!usage) return "in - out - cache -";
  return `in ${compactMetric(usage.inputTokens)} out ${compactMetric(usage.outputTokens)} cache ${compactMetric(usage.cacheReadInputTokens)}`;
}

/** @param {number|null|undefined} value */
function compactMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

/** @param {number|null|undefined} value */
function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "-";
}

/** @param {string} value */
function redactProviderText(value) {
  let result = String(value);
  for (const secret of Object.values(process.env)) {
    if (typeof secret === "string" && secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

/**
 * The dispatch gate: no node starts until the host can carry the run. The
 * report is written as run evidence either way, and a blocking failure leaves
 * the materialized run untouched — the operator fixes the host and resumes,
 * so a run is never silently restarted and already-paid nodes are not redone.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {SourceIdentity|undefined} sourceIdentity
 */
function assertEnvironmentReady(contract, runDir, sourceIdentity) {
  const report = environmentPreflight({
    cwd: contract.cwd,
    runtimes: reachableRuntimes(contract),
    driverVersions: sourceIdentity?.driverVersions ?? {},
  });
  const evidence = {
    schemaVersion: report.schemaVersion,
    contractVersion: INTENT_FACTORY_VERSION,
    at: new Date().toISOString(),
    contractId: contract.id,
    ok: report.ok,
    checks: report.checks,
  };
  writeJsonAtomic(join(runDir, "env-preflight.json"), evidence);
  if (report.ok) return;
  appendJsonl(join(runDir, "events.jsonl"), { type: "run.env-preflight-failed", ...evidence });
  const blocking = blockingChecks(report).map((check) => `${check.name}: ${check.detail}`).join(" · ");
  throw Object.assign(new Error(`env_preflight_failed: ${blocking} · the run stays resumable: fix the environment and resume ${runDir}`), { code: "env_preflight_failed" });
}

/**
 * @param {ValidatedContract} contract
 * @returns {string[]}
 */
function reusedDoneWarnings(contract) {
  /** @type {string[]} */
  const warnings = [];
  const runsDir = join(contract.cwd, ".runs");
  if (!existsSync(runsDir)) return warnings;
  const ownRunDir = join(runsDir, contract.id);
  for (const name of readdirSync(runsDir)) {
    const otherRunDir = join(runsDir, name);
    const nodeDir = join(otherRunDir, "nodes");
    if (otherRunDir === ownRunDir || !existsSync(nodeDir)) continue;
    const relevantNodes = contract.nodes.filter((node) => existsSync(join(nodeDir, `${node.id}.json`)));
    if (!relevantNodes.length) continue;
    const otherContractPath = join(otherRunDir, "contract.json");
    if (!existsSync(otherContractPath)) throw new TypeError(`missing persisted contract ${otherContractPath}`);
    // A historical contract may reference paths that no longer exist (e.g. a
    // rename); reusing its done nodes is best-effort and must not block a new run.
    let otherContract;
    try {
      otherContract = validateContract(JSON.parse(readFileSync(otherContractPath, "utf8")), otherContractPath, { persisted: true });
    } catch {
      continue;
    }
    for (const node of relevantNodes) {
      const statePath = join(nodeDir, `${node.id}.json`);
      const otherNode = otherContract.nodes.find((candidate) => candidate.id === node.id);
      if (!otherNode) continue;
      try {
        if (validateNodeSnapshot(JSON.parse(readFileSync(statePath, "utf8")), otherNode).status === "done") warnings.push(`node ${node.id} is already done in run ${name}`);
      } catch {
        // Historical snapshots are advisory only. A snapshot written by an
        // older protocol revision must not prevent a new run from starting;
        // the new run still validates its own contract and snapshots strictly.
      }
    }
  }
  return warnings;
}

/**
 * @param {string} command
 * @param {string} target
 * @param {string[]} [extraArgs]
 * @returns {DetachedChild}
 */
function detachSelf(command, target, extraArgs = []) {
  const nonce = randomUUID();
  const child = /** @type {DetachedChild} */ (spawn(process.execPath, [fileURLToPath(import.meta.url), command, target, ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: nonce },
    detached: process.platform !== "win32", stdio: "ignore",
  }));
  child.unref();
  child.bootstrapNonce = nonce;
  child.bootstrapProcessStartToken = processStartToken(child.pid ?? null);
  return child;
}

/**
 * @param {string} runDir
 * @param {number} pid
 * @param {DetachedChild|null} [child]
 * @param {number} [timeoutMs]
 * @returns {Promise<BootstrapRecord>}
 */
async function waitForBootstrap(runDir, pid, child = null, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const nonce = child?.bootstrapNonce;
  if (!nonce) throw new Error(`detached bootstrap has no start nonce for pid ${pid}`);
  if (!validBootstrapNonce(nonce) || child.pid !== pid) throw new Error(`detached bootstrap has invalid child identity for pid ${pid}`);
  let expectedProcessStartToken = child.bootstrapProcessStartToken ?? null;
  let exited = false;
  child?.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    const childExited = exited || child?.exitCode !== null || child?.signalCode !== null;
    if (expectedProcessStartToken === null && !childExited) expectedProcessStartToken = processStartToken(pid);
    for (const path of [bootstrapAttemptPath(runDir, nonce), bootstrapPath(runDir)]) {
      try {
        const bootstrap = /** @type {BootstrapRecord} */ (readJson(path));
        const childIdentity = bootstrapMatchesChild(bootstrap, pid, nonce, expectedProcessStartToken);
        if (bootstrap.status === "failed" && bootstrapFailureMatchesChild(bootstrap, pid, nonce, expectedProcessStartToken)) {
          cleanupBootstrapAttempts(runDir);
          throw new Error(`detached bootstrap failed: ${bootstrap.error}`);
        }
        const lock = readLock(runDir);
        const currentOwner = lockOwnedBy(lock, pid, expectedProcessStartToken);
        if (!childExited && bootstrap.status === "ready" && childIdentity && currentOwner && runIsNonterminal(runDir)) {
          cleanupBootstrapAttempts(runDir);
          try {
            writeBootstrapAcknowledgement(runDir, bootstrap, expectedProcessStartToken);
          } catch (error) {
            cleanupBootstrapNonce(runDir, nonce);
            throw error;
          }
          return bootstrap;
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          cleanupBootstrapNonce(runDir, nonce);
          cleanupBootstrapAttempts(runDir);
          throw error;
        }
      }
    }
    if (childExited) {
      try {
        const failure = /** @type {BootstrapRecord} */ (readJson(bootstrapAttemptPath(runDir, nonce)));
        if (failure.status === "failed" && bootstrapFailureMatchesChild(failure, pid, nonce, expectedProcessStartToken)) {
          cleanupBootstrapAttempts(runDir);
          throw new Error(`detached bootstrap failed: ${failure.error}`);
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          cleanupBootstrapNonce(runDir, nonce);
          cleanupBootstrapAttempts(runDir);
          throw error;
        }
      }
      cleanupBootstrapNonce(runDir, nonce);
      cleanupBootstrapAttempts(runDir);
      throw new Error(`detached bootstrap failed before readiness for pid ${pid}`);
    }
    await delay(50);
  }
  cleanupBootstrapNonce(runDir, nonce);
  cleanupBootstrapAttempts(runDir);
  throw new Error(`detached bootstrap did not become ready for pid ${pid}`);
}

/**
 * @param {string} runDir
 * @param {BootstrapRecord} bootstrap
 * @param {string|null} expectedProcessStartToken
 */
function writeBootstrapAcknowledgement(runDir, bootstrap, expectedProcessStartToken) {
  if (!bootstrap.nonce) throw new Error("bootstrap record has no nonce");
  writeJsonAtomic(bootstrapAckPath(runDir, bootstrap.nonce), {
    status: "acknowledged",
    nonce: bootstrap.nonce,
    pid: bootstrap.pid ?? null,
    processStartToken: expectedProcessStartToken,
    at: new Date().toISOString(),
  });
}

/**
 * @param {string} runDir
 * @param {{nonce: string, pid: number, processStartToken: string|null}} expected
 * @returns {Promise<void>}
 */
async function waitForBootstrapAcknowledgement(runDir, expected) {
  if (!validBootstrapNonce(expected.nonce)) return;
  const deadline = Date.now() + 5_000;
  const path = bootstrapAckPath(runDir, expected.nonce);
  try {
    while (Date.now() < deadline) {
      try {
        const acknowledgement = /** @type {BootstrapRecord} */ (readJson(path));
        if (
          acknowledgement.status === "acknowledged" &&
          acknowledgement.nonce === expected.nonce &&
          acknowledgement.pid === expected.pid &&
          sameProcessStartToken(acknowledgement.processStartToken, expected.processStartToken)
        ) {
          return;
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await delay(25);
    }
  } finally {
    cleanupBootstrapNonce(runDir, expected.nonce);
  }
}

/**
 * @param {string} runDir
 * @param {string} nonce
 */
function cleanupBootstrapNonce(runDir, nonce) {
  if (!validBootstrapNonce(nonce)) return;
  for (const path of [bootstrapAttemptPath(runDir, nonce), bootstrapAckPath(runDir, nonce)]) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/**
 * @param {string} runDir
 * @returns {boolean}
 */
function runIsNonterminal(runDir) {
  try {
    const contractPath = join(runDir, "contract.json");
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
    const nodes = readRunNodes(runDir, contract);
    return nodes.length > 0 && nodes.some((node) => !TERMINAL.has(node.status));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * @param {string} command
 * @param {string|undefined} target
 * @returns {string|null}
 */
function bootstrapRunDir(command, target) {
  try {
    if (command === "run") {
      if (!target) return null;
      const path = resolve(target);
      const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
      return join(contract.cwd, ".runs", contract.id);
    }
    if (["resume", "cancel"].includes(command)) {
      if (!target) return null;
      return resolve(target);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {string} command
 * @param {string|undefined} target
 * @param {Error} error
 */
function writeBootstrapFailure(command, target, error) {
  const runDir = bootstrapRunDir(command, target);
  if (!runDir || !existsSync(runDir)) return;
  const nonce = validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE) ? process.env.INTENT_FACTORY_BOOTSTRAP_NONCE : null;
  const failure = { status: "failed", pid: process.pid, processStartToken: processStartToken(process.pid), runDir, nonce, at: new Date().toISOString(), error: error.message };
  if (command === "run" && existsSync(join(runDir, "contract.json"))) return;
  /** @type {BootstrapRecord|null} */
  let current = null;
  try {
    current = /** @type {BootstrapRecord} */ (readJson(bootstrapPath(runDir)));
    const controllerLock = readLock(runDir);
    const currentOwnerActive = current.status === "ready" && current.pid !== process.pid
      && lockOwnedBy(controllerLock, current.pid, current.processStartToken);
    if (currentOwnerActive) return;
  } catch (readError) {
    if (errorCode(readError) !== "ENOENT") return;
  }
  // Only a detached bootstrap child records an attempt file for its own nonce;
  // a --detach parent that observed the failure must not recreate attempt
  // artifacts with an ambient nonce it does not own.
  if (nonce && !process.argv.includes("--detach") && !(current?.status === "ready" && current.pid === process.pid)) {
    try { writeJsonAtomic(bootstrapAttemptPath(runDir, nonce), failure); } catch {}
  }
  try { writeJsonAtomic(bootstrapPath(runDir), failure); } catch {}
}

/**
 * @param {import("./lock.mjs").ReadLockResult} lock
 * @param {number|undefined} pid
 * @param {string|null|undefined} processStartToken
 * @returns {boolean}
 */
function lockOwnedBy(lock, pid, processStartToken) {
  return lock !== null && !lock.invalid && lock.pid === pid
    && sameProcessStartToken(lock.processStartToken, processStartToken);
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/** @returns {boolean} */
function hasDetachedBootstrapNonce() {
  if (!validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)) return false;
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * @returns {string}
 */
function bootstrapNonceForProcess() {
  return validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)
    ? /** @type {string} */ (process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)
    : randomUUID();
}

/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const COMMAND_OPTIONS = {
  run: { detach: { type: "boolean" } },
  resume: { detach: { type: "boolean" }, node: { type: "string" }, reconcile: { type: "string" } },
  cancel: {},
  preflight: { static: { type: "boolean" }, json: { type: "boolean" } },
  validate: {},
  status: { json: { type: "boolean" } },
  report: { json: { type: "boolean" } },
  findings: {},
  doctor: { cwd: { type: "string" }, json: { type: "boolean" }, discover: { type: "boolean" } },
  metrics: METRICS_OPTIONS,
};

/**
 * Strict per-command parsing: unknown options, missing positionals, and extra
 * positionals are rejected. Flags are scoped to the commands that declare them.
 *
 * @param {string[]} argv
 * @param {boolean} [quiet]
 * @returns {{command: string, target: string|undefined, values: Record<string, unknown>}|null}
 */
function parseCli(argv, quiet = false) {
  const [command, ...rest] = argv;
  if (!command || !COMMAND_OPTIONS[command]) return null;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: COMMAND_OPTIONS[command], allowPositionals: true, strict: true });
  } catch (error) {
    if (!quiet) process.stderr.write(`${errorMessage(error)}\n`);
    return null;
  }
  if (parsed.positionals.length > 1) return null;
  if (command !== "doctor" && parsed.positionals.length !== 1) return null;
  return {
    command,
    target: parsed.positionals[0],
    values: /** @type {Record<string, unknown>} */ (parsed.values),
  };
}

/**
 * The retry-in-place options of a `resume` invocation, validated before any
 * lock is taken.
 *
 * @param {Record<string, unknown>} values
 * @returns {{node?: string, reconcile?: string}}
 */
function resumeOptionsOf(values) {
  const node = typeof values.node === "string" && values.node ? values.node : undefined;
  const reconcile = typeof values.reconcile === "string" && values.reconcile ? values.reconcile : undefined;
  return { node, reconcile };
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv[0] === "campaign") { await campaignCli(argv.slice(1)); return; }
  if (argv[0] === "contract") { contractCli(argv.slice(1)); return; }
  const parsed = parseCli(argv);
  if (!parsed) { usage(); return; }
  const { command, values } = parsed;
  const target = parsed.target;
  if (command === "doctor") {
    const ok = await doctorCommand(target, {
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
      json: values.json === true,
      discover: values.discover === true,
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (!target) { usage(); return; }
  if (command === "run") {
    const absolute = resolve(target);
    const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
    const runDir = join(contract.cwd, ".runs", contract.id);
    if (values.detach === true) {
      if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
      for (const warning of [...contract.warnings, ...reusedDoneWarnings(contract)]) process.stdout.write(`[warn] ${warning}\n`);
      const child = detachSelf("run", target);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[run] ${contract.id} detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    for (const warning of [...contract.warnings, ...reusedDoneWarnings(contract)]) process.stdout.write(`[warn] ${warning}\n`);
    const result = await runContract(target);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "resume") {
    const resumeOptions = resumeOptionsOf(values);
    if (values.detach === true) {
      const runDir = resolve(target);
      if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
      const extraArgs = [
        ...(resumeOptions.node ? ["--node", resumeOptions.node] : []),
        ...(resumeOptions.reconcile ? ["--reconcile", resumeOptions.reconcile] : []),
      ];
      const child = detachSelf("resume", target, extraArgs);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[resume] detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    const result = await resumeRun(target, resumeOptions);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "cancel") { await cancelRun(target); return; }
  if (command === "preflight") {
    const absolute = resolve(target);
    const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
    const checks = await preflightContract(absolute, { static: values.static === true });
    const environment = environmentPreflight({
      cwd: contract.cwd,
      runtimes: reachableRuntimes(contract),
      driverVersions: Object.fromEntries(checks.map((check) => [check.id, check.version])),
    });
    const ok = environment.ok && checks.every((check) => check.ok);
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        contractId: contract.id,
        ok,
        environment: environment.checks,
        checks: checks.map((check) => ({
          id: check.id,
          driver: check.driver,
          executable: check.executable,
          model: check.model,
          version: check.version,
          ok: check.ok,
          live: check.live === true,
          liveStatus: check.liveStatus ?? null,
          usage: check.usage ?? null,
          costUsd: check.costUsd ?? null,
          detail: check.detail,
        })),
      })}\n`);
    } else {
      for (const check of environment.checks) process.stdout.write(`[${check.ok ? "ok" : check.advisory ? "warn" : "fail"}] ${check.name} · ${check.detail}\n`);
      for (const check of checks) process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.id} · ${check.detail}\n`);
    }
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "status") {
    const runDir = resolve(target);
    if (values.json === true) {
      process.stdout.write(renderStatusJson(runDir));
      return;
    }
    const status = renderStatus(runDir);
    writeTextAtomic(join(runDir, "STATUS.md"), status);
    try {
      renderRunHandoff(runDir);
    } catch (error) {
      process.stderr.write(`[warn] campaign handoff render failed: ${errorMessage(error)}\n`);
    }
    process.stdout.write(status);
    return;
  }
  if (command === "report") {
    process.stdout.write(values.json === true ? renderReportJson(resolve(target)) : renderReport(resolve(target)));
    return;
  }
  if (command === "metrics") { process.stdout.write(renderCampaignMetrics(target, values)); return; }
  if (command === "findings") { process.stdout.write(renderFindings(resolve(target))); return; }
  if (command === "validate") { validateContractFile(resolve(target)); return; }
  usage();
}

function usage() {
  process.stderr.write(
    "usage: runner.mjs <run|validate|preflight> <contract.json> [--detach] | " +
    "<resume|cancel> <run-dir> [--detach] | " +
    "<status|report> <run-dir> [--json] | findings <run-dir> | " +
    "doctor [<contract.json>] [--cwd <dir>] [--discover] [--json] | contract <prune|validate> ... | " +
    "metrics <campaign-id> [--cwd <dir>] [--json] | " +
    "campaign <init|attach|note|resolve|close|show|list> ...\n",
  );
  process.exitCode = 2;
}

// A closed stdout pipe (orphaned monitor, ended pipeline) must never kill a
// controller through an unhandled EPIPE. Run state lives in the run directory;
// console output is advisory.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const isMain = process.argv[1] && sameFile(process.argv[1], import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  const parsed = parseCli(process.argv.slice(2), true);
  const command = parsed?.command;
  const target = parsed?.target;
  writeBootstrapFailure(command ?? "", target, error);
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});

/**
 * @param {string|undefined} left
 * @param {string} right
 * @returns {boolean}
 */
function sameFile(left, right) {
  try { return realpathSync(resolve(left ?? "")) === realpathSync(new URL(right)); } catch { return false; }
}
