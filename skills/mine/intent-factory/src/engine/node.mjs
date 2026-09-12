import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JUDGE_SCHEMA,
  TERMINAL,
  judgePrompt,
  normalizeProviderResult,
  parseJudge,
  routeRuntime,
} from "./prompts.mjs";
import {
  deterministicGate,
  candidateOnlyFailures,
  judgeReaskOutstanding,
  judgeReaskReason,
  judgeRequired,
  verificationFailureVerdict,
} from "./judge-gate.mjs";
import {
  judgeReaskInstruction,
  judgeVerdictEvidence,
  reviewMode,
} from "../contract/review-modes.mjs";
import {
  JUDGE_MAX_FAILURES,
  applyJudgeProtocolFailure,
  applyJudgeResult,
  applyRejection,
  applyVerificationFailure,
  settleUnavailableJudge,
} from "./review.mjs";
import {
  INTENT_FACTORY_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  harnessCapabilities,
  providerCommand,
} from "../harnesses/index.mjs";
import { liveUsage, SessionMetricsParser, TOOL_OUTPUT_LIMIT_BYTES } from "../harnesses/exec-jsonl/index.mjs";
import { extractJson } from "../harnesses/protocol.mjs";
import { routingBackoffActive, runtimeSnapshot } from "./failover.mjs";
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
import { exhaustedUntilOf } from "./runtime-discovery.mjs";
import { statusNote, writeStatusArtifacts } from "../report/render.mjs";
import { validateEvent, validateNodeSnapshot } from "../contract/index.mjs";
import {
  appendJsonl,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from "../run/store.mjs";
import { acquire as acquireLock, LockLostError, processStartToken } from "../run/lock.mjs";
import { writeRunTextWithDiskPressureRetry } from "../run/disk-gc.mjs";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceScope,
  compareWorkspaceSnapshot,
  compactVerification,
  runVerification,
  validateWorkspaceScopeBoundary,
} from "../contract/verification.mjs";
import { scopeFindingFromScope, scopeFindingsNote, verificationFailureWithScope } from "../contract/scope-findings.mjs";
import { finalVerificationCommands } from "../contract/final-verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "../contract/worker-result.mjs";
import { campaignIdOf, renderHandoff } from "../campaign/index.mjs";
import { appendPreviousAttempt } from "./retry.mjs";
import { NotifyQueue } from "../notify/index.mjs";
import {
  attemptWorktreePath,
  createAttemptWorktree,
  gitHead,
  removeWorktree,
  sealAttempt,
} from "../repo/worktree.mjs";
import { integrateAttempt } from "../repo/integrate.mjs";
import { delay, errorCode, errorMessage, excerpt, stableJson } from "../util.mjs";
import { alreadyNotified, notifyQueueFor } from "./notify-queue.mjs";
import { invocationAlive, invocationResult, logPaths, readBoundedTail, startProcess, terminateInvocation } from "./process.mjs";
import { hasOperationIntent, hasOperationSettlement, operationNeedsRecovery, operationNextState, persistInvocationIntent, providerReceipts, providerReceiptsFromInvocationTail, readOperationSettlement, settleInvocation } from "../run/operations.mjs";
import { appendTransitionEvent, ensureTerminalEvent, recordExecutionOverride, transition, writeNode } from "./state.mjs";
import { appendUsageRecord, invocationCost, invocationUsage, recordInvocationUsage } from "../run/usage.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("../contract/index.mjs").RunMetadata} RunMetadata */
/** @typedef {import("../contract/index.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("../contract/index.mjs").EventRecord} EventRecord */
/** @typedef {import("../contract/index.mjs").Usage} Usage */
/** @typedef {import("../contract/index.mjs").GateResult} GateResult */
/** @typedef {import("../contract/index.mjs").SnapshotError} SnapshotError */
/** @typedef {import("../contract/index.mjs").BoundedScope} BoundedScope */
/** @typedef {import("../contract/verification.mjs").WorkspaceSnapshot} WorkspaceSnapshot */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../harnesses/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("../contract/verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/verification.mjs").VerificationResult} VerificationResult */
/** @typedef {import("../contract/verification.mjs").ScopeComparison} ScopeComparison */
/** @typedef {import("../contract/worker-result.mjs").WorkerResult} WorkerResult */
/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {import("./process.mjs").PathSet} PathSet */
/** @typedef {import("./process.mjs").Invocation} Invocation */
/** @typedef {import("./process.mjs").InvocationProbe} InvocationProbe */
/** @typedef {import("./process.mjs").Job} Job */
/** @typedef {{kind: "adopted"|"rejudge"|"restart"|"reconciled"|"exhausted"|"stalled", phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, error?: {code: string, message: string}|null, invocationId?: string, reason?: string}} RecoveryOutcome */
/** @typedef {import("node:child_process").ChildProcess & {bootstrapNonce?: string, bootstrapProcessStartToken?: string|null}} DetachedChild */
/** @typedef {{status?: string, nonce?: string, pid?: number, processStartToken?: string|null, holderId?: string, generation?: number, error?: unknown, runDir?: string}} BootstrapRecord */

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */

/** @param {string} runDir */
export function assertRunMutable(runDir) {
  if (!existsSync(join(runDir, "incident-freeze.json"))) return;
  const error = /** @type {Error & {code: string}} */ (new Error("incident_frozen: run is frozen as immutable incident evidence"));
  error.code = "incident_frozen";
  throw error;
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
 * The projector error code of a terminal node event. A `blocked_context`
 * worker result is persisted by the runner as error code `context_missing`;
 * it is classified as the blocking question it is, so the notify template
 * carries the worker's own terminal status code.
 *
 * @param {NodeSnapshot} state
 * @returns {string|null}
 */
export function terminalErrorCode(state) {
  const result = state.result && typeof state.result === "object" ? /** @type {{status?: unknown}} */ (state.result) : {};
  if (result.status === "blocked_context") return "blocked_context";
  const error = state.error && typeof state.error === "object" ? /** @type {{code?: unknown}} */ (state.error) : {};
  return typeof error.code === "string" && error.code ? error.code : null;
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
    return { id: override.runtime, ...runtime, capabilities: harnessCapabilities(runtime) };
  }
  const assigned = state.routing?.assignments?.[role];
  if (assigned && contract.runtimes[assigned]) {
    const runtime = contract.runtimes[assigned];
    return { id: assigned, ...runtime, capabilities: harnessCapabilities(runtime) };
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
    && session.invocation.harness === runtime.harness
    && session.invocation.runtimeId === runtime.id
    && session.invocation.runtimeFingerprint === fingerprintRuntime(runtime)
    && session.invocation.model === runtime.model
    && session.invocation.reasoning === (runtime.reasoning ?? null)
    && session.invocation.sandbox === (runtime.sandbox ?? null);
  const canContinue = runtime.capabilities.continuation === true;
  if (identityMatches && canContinue) {
    return { prompt, continuationId: session.invocation.continuationId ?? null, mode: "reuse" };
  }
  // A harness that cannot continue at all, or a session picked up from a
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
  // A capable harness continuing its own node whose identity merely drifted
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
 * @returns {import("../harnesses/index.mjs").ToolPolicy|undefined}
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
 * @param {import("../harnesses/index.mjs").CommandOptions} [extra]
 * @returns {import("../harnesses/index.mjs").CommandOptions}
 */
function invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, extra = {}) {
  return {
    ...extra,
    continuationId: runtime.capabilities.continuation === true ? phasePlan.continuationId : null,
  };
}

/** @param {NodeSnapshot|undefined} state @returns {string|null} */
export function attemptWorkspace(state) {
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
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {string} prompt
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 */
export function startWorker(contract, node, state, runDir, running, prompt, lock, states, campaignPath) {
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
  /** @type {import("../contract/verification.mjs").WorkspaceScopeBoundary} */
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
 * @param {HarnessRuntime & {id: string|null}} runtime
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
export async function startJudge(contract, node, state, runDir, running, workerResult, lock, states, campaignPath) {
  const reaskReason = judgeReaskReason(state);
  const reask = reaskReason !== undefined;
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  const { verdict, results } = await deterministicGate(
    node,
    workspace,
    reask,
    Math.max(1_000, Math.min((node.timeoutSec ?? contract.timeoutSec ?? 60) * 1000, 120_000)),
    /** @type {import("../contract/index.mjs").VerificationState|null} */ (state.verification),
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
 * @param {import("../contract/verification.mjs").WorkspaceScopeBoundary} boundary
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
 * @param {import("../contract/verification.mjs").WorkspaceScopeBoundary} boundary
 * @returns {BoundedScope}
 */
export function emptyScope(boundary) {
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
 * @returns {Map<string, import("../contract/verification.mjs").WorkspaceScopeBoundary>}
 */
export function captureNodeScopeBoundaries(contract) {
  return new Map(contract.nodes.map((node) => [node.id, captureWorkspaceScope(contract.cwd, workerScope(node.taskPacket))]));
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot|undefined} state
 * @returns {import("../contract/verification.mjs").WorkspaceScopeBoundary}
 */
export function persistedScopeBoundary(contract, node, state, workspace = contract.cwd) {
  const boundary = state?.scope?.boundary;
  if (!boundary) throw Object.assign(new Error(`node ${node.id} has no persisted worker scope boundary`), { code: "scope_boundary_missing" });
  return validateWorkspaceScopeBoundary(workspace, boundary, workerScope(node.taskPacket));
}

/**
 * @param {import("../contract/index.mjs").TaskPacket} taskPacket
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
 * @returns {import("../contract/index.mjs").VerificationAttempt[]}
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
 * @returns {Promise<import("../contract/index.mjs").VerificationState>}
 */
export async function executeControllerVerification(contract, runDir, node, state, lock) {
  if (state.verification?.completed === true) return /** @type {import("../contract/index.mjs").VerificationState} */ (state.verification);
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
export async function recoverVerificationAttempts(runDir, state, lock) {
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
export function checkWorkerScope(contract, runDir, job, lock, options = {}) {
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
export function reconcileAmbiguousWorkerRestart(contract, runDir, node, state, invocation, recovery, persistedRecovery, lock) {
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
export function checkPersistedWorkerScope(contract, runDir, state, node, invocation, lock, options = {}) {
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
export async function resolveUnknownEffect(contract, runDir, node, state, workerInvocation, lock) {
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
export async function finalizeClosedJobs(contract, runDir, states, running, lock, campaignPath) {
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
    /** @type {import("../contract/worker-result.mjs").WorkerResult|null} */
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
export function handleProviderExhaustion(contract, runDir, node, state, role, envelope, currentRuntime, lock, states, campaignPath, precomputed) {
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
 * @returns {Promise<import("../repo/integrate.mjs").IntegrationResult|null|undefined>}
 */
export async function settleDone(contract, node, state, runDir, lock, states, campaignPath, patch = {}) {
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
      const divergent = candidateOnlyFailures(state.verification, transaction.candidateEvidence);
      verdict.findings = [...(verdict.findings ?? []), {
        severity: "critical",
        description: divergent.length
          ? `the integration worktree failed a verification the attempt passed (${boundedUtf8(divergent.join("; "), 512)}): the two worktrees disagree about the environment, not about the work`
          : "the sealed candidate did not pass the node verification in its integration worktree",
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
 * @returns {Promise<import("../repo/integrate.mjs").CandidateEvidence>}
 */
export async function verifyCandidateWorkspace(contract, node, state, runDir, workspace) {
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
export async function applyInvalidWorkerResult(contract, node, state, runDir, running, lock, message, states, campaignPath) {
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
export async function raiseNodeAttention(campaignPath, runDir, state, code) {
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
export function materializeAttemptResult(runDir, state, node) {
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
export function canonicalWorkerResultText(runDir, nodeId) {
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
export function isResultMaterializationInvocation(invocation) {
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
export async function recoverOrphan(runDir, contract, node, state, lock) {
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
export function recoveryFromOverride(override, invocationId) {
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
export function closePersistedInvocation(invocations, invocationId, usage = undefined, costUsd = undefined) {
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
export function recoverWorkerResult(runDir, state, contract, node) {
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

