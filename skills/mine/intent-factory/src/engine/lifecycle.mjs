/**
 * One node's lifecycle: dispatch a worker, run the mechanical gate, dispatch a
 * judge or settle, and absorb whatever the provider did instead.
 *
 * This is what was left after node.mjs -- 3,766 lines and 146 definitions -- was
 * cut into process, state, scope, verify, result-file, recover, operations,
 * usage, notify-queue and the final report. What did not come out is dispatch
 * and settlement, and that is not an oversight: `startJudge` evaluates the
 * deterministic gate and then either dispatches a judge or settles the node
 * outright, so the two halves meet inside one function. Separating them is a
 * design change (have `startJudge` return a decision and let the caller settle),
 * not a move, and it is also what would end the last import cycle in `src/`:
 * lifecycle <-> review.
 */
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
  parseJudge,
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
  applyJudgeRound,
  applyRejection,
  applyVerificationFailure,
  settleUnavailableJudge,
} from "./review.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, harnessCapabilities, normalizeProviderResult, providerCommand } from "../harnesses/index.mjs";
import { liveUsage, SessionMetricsParser, TOOL_OUTPUT_LIMIT_BYTES } from "../harnesses/exec-jsonl/index.mjs";
import { extractJson } from "../harnesses/protocol.mjs";
import { routeRuntimeForState, routingBackoffActive, runtimeSnapshot } from "./failover.mjs";
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

import {
  appendJsonl,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from "../run/store.mjs";
import { acquire as acquireLock, LockLostError, processStartToken } from "../run/lock.mjs";
import { writeRunTextWithDiskPressureRetry } from "../run/disk-gc.mjs";
import {
  compactVerification,
} from "../contract/verification.mjs";
import { scopeFindingFromScope, scopeFindingsNote, verificationFailureWithScope } from "../contract/scope-findings.mjs";
import { finalVerificationCommands } from "../contract/final-verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "../contract/worker-result.mjs";
import { renderHandoff } from "../campaign/index.mjs";
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
import { boundedUtf8, delay, errorCode, errorMessage, excerpt, stableJson } from "../util.mjs";
import { alreadyNotified, notifyQueueFor } from "./notify-queue.mjs";
import { invocationAlive, invocationResult, logPaths, readBoundedTail, startProcess, terminateInvocation } from "./process.mjs";
import { hasOperationIntent, hasOperationSettlement, operationNeedsRecovery, operationNextState, persistInvocationIntent, providerReceipts, providerReceiptsFromInvocationTail, readOperationSettlement, settleInvocation } from "../run/operations.mjs";
import { appendTransitionEvent, ensureTerminalEvent, recordExecutionOverride, transition, writeNode } from "./state.mjs";
import { appendUsageRecord, invocationCost, invocationUsage, recordInvocationUsage } from "../run/usage.mjs";
import { attemptWorkspace } from "../repo/worktree.mjs";
import { executeControllerVerification, verifyCandidateWorkspace } from "./verify.mjs";
import {
  RESULT_MATERIALIZATION_PROMPT_HEADER,
  attemptWorkerResultPath,
  clearAttemptWorkerResult,
  clearWorkerResultFile,
  materializeAttemptResult,
  persistedJudgeResult,
  persistedWorkerResult,
  readWorkerResultFile,
  resolveWorkerResult,
  workerProtocolPrompt,
  workerResultPath,
} from "./result-file.mjs";
import { canReuseResultEvidence, checkResultMaterializationScope, checkWorkerScope, emptyScope, persistedScopeBoundary, recordScopeFinding, sourceWorkerRuntime, workerScope } from "./scope.mjs";
import { runVerification } from "./run-command.mjs";
import { captureWorkspaceScope, captureWorkspaceSnapshot, compareWorkspaceSnapshot, validateWorkspaceScopeBoundary } from "../repo/workspace.mjs";
import { routeRuntime } from "../contract/runtime.mjs";
import { validateEvent, validateNodeSnapshot } from "../contract/snapshot.mjs";
import { campaignIdOf } from "../campaign/record.mjs";
import { startJudge, startResultMaterialization } from "./dispatch.mjs";

/** @typedef {import("../repo/integrate.mjs").IntegrationResult} IntegrationResult */
/** @typedef {import("./backoff.mjs").Transition} Transition */

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
/** @typedef {import("../repo/workspace.mjs").WorkspaceSnapshot} WorkspaceSnapshot */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../harnesses/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("../contract/verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/verification.mjs").VerificationResult} VerificationResult */
/** @typedef {import("../repo/workspace.mjs").ScopeComparison} ScopeComparison */
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
        await applyJudgeRound(await startJudge(contract, job.node, state, runDir, running, state.result, lock, states, campaignPath),
          contract, job.node, state, runDir, running, lock, states, campaignPath, state.result);
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
      if (job.node.gate.enabled) {
        await applyJudgeRound(await startJudge(contract, job.node, state, runDir, running, workerResult, lock, states, campaignPath),
          contract, job.node, state, runDir, running, lock, states, campaignPath, workerResult);
      }
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

