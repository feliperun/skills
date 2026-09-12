import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { syncAgentSignal } from "../repo/signal.mjs";
import { JUDGE_SCHEMA, TERMINAL, retryPrompt } from "./prompts.mjs";
import { verificationFailureVerdict } from "./judge-gate.mjs";
import {
  applyJudgeProtocolFailure,
  applyJudgeResult,
  applyRejection,
  applyVerificationFailure,
} from "./review.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, probeRuntime } from "../harnesses/index.mjs";
import { extractJson } from "../harnesses/protocol.mjs";
import { routingBackoffActive } from "./failover.mjs";
import { blockingChecks, environmentPreflight, reachableRuntimes } from "../host/preflight.mjs";
import { composeAssignments, discoverRuntimes } from "./runtime-discovery.mjs";

import {
  appendJsonl,
  bootstrapAttemptPath,
  bootstrapPath,
  cleanupBootstrapAttempts,
  readJson,
  writeJsonAtomic,
} from "../run/store.mjs";
import {
  acquire as acquireLock,
  LockBusyError,
  LockLostError,
  pidAlive,
  processStartToken,
  readLock,
} from "../run/lock.mjs";
import { verificationFailureWithScope } from "../contract/scope-findings.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "../contract/worker-result.mjs";
import { registerRun, resolveCampaign } from "../campaign/index.mjs";
import {
  isUnknownEffectStop,
  planResumeRetry,
  renderPreviousAttemptSection,
} from "./retry.mjs";
import { attemptWorkspace, attemptWorktreePath, createRunRef, gitHead, removeWorktree, runRefName } from "../repo/worktree.mjs";
import { recoverIntegrations } from "../repo/integrate.mjs";
import { bootstrapNonceForProcess, waitForBootstrapAcknowledgement } from "./detach.mjs";
import {
  applyInvalidWorkerResult,
  assertRunMutable,
  finalizeClosedJobs,
  handleProviderExhaustion,
  raiseNodeAttention,
  settleDone,
  startJudge,
  startWorker,
  terminalErrorCode,
} from "./lifecycle.mjs";
import { delay, errorCode, errorMessage, excerpt, stableJson } from "../util.mjs";
import { alreadyNotified, notifyQueueFor, notifyQueuesByRun, renderCampaignHandoffSafely } from "./notify-queue.mjs";
import { detectStalls, invocationAlive, terminateInvocation, terminateProcess } from "./process.mjs";
import { ensureTerminalEvent, hasDoneEvent, recordExecutionOverride, transition, writeNode } from "./state.mjs";
import { render, renderFinalReport, writeFindingsArtifact } from "../report/final.mjs";
import { hasOperationIntent, hasOperationSettlement, operationNeedsRecovery, operationNextState, providerReceipts, providerReceiptsFromInvocationTail, readOperationSettlement, settleInvocation } from "../run/operations.mjs";
import { appendUsageRecord, emptyUsage, invocationCost, invocationUsage, persistRecoveryUsage, recordInvocationUsage } from "../run/usage.mjs";
import { closePersistedInvocation, recoverOrphan, recoveryFromOverride } from "./recover.mjs";
import { canonicalWorkerResultText, isResultMaterializationInvocation, materializeAttemptResult, recoverWorkerResult } from "./result-file.mjs";
import { captureNodeScopeBoundaries, checkPersistedWorkerScope, checkWorkerScope, emptyScope, persistedScopeBoundary, reconcileAmbiguousWorkerRestart, resolveUnknownEffect } from "./scope.mjs";
import { executeControllerVerification, recoverVerificationAttempts, verifyCandidateWorkspace } from "./verify.mjs";
import { validateContract } from "../contract/index.mjs";
import { validateNodeSnapshot, validateRunMetadata } from "../contract/snapshot.mjs";
import { captureSourceIdentity } from "../contract/source-identity.mjs";

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
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./lifecycle.mjs").RecoveryOutcome} RecoveryOutcome */
/** @typedef {import("./lifecycle.mjs").InvocationProbe} InvocationProbe */
/** @typedef {import("../contract/worker-result.mjs").WorkerResult} WorkerResult */
/** @typedef {{runDir: string, states: Map<string, NodeSnapshot>, ok: boolean, error?: Error}} RunOutcome */

/**
 * @param {string} contractPath
 * @param {{detachedBootstrap?: boolean}} [options] `detachedBootstrap` is set
 *   only by the CLI entry when this process is its own detached child, and
 *   makes the controller wait for the launcher's acknowledgement
 * @returns {Promise<RunOutcome>}
 */
export async function runContract(contractPath, options = {}) {
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
        scope: emptyScope(/** @type {import("../repo/workspace.mjs").WorkspaceScopeBoundary} */ (scopeBoundaries.get(node.id))),
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
    const outcome = await driveRun(contract, runDir, states, campaign, lock, sourceIdentity, {}, options);
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
 * @param {{node?: string, reconcile?: string, detachedBootstrap?: boolean}} [options]
 *   `node` limits the retry in place to one node and its dependants,
 *   `reconcile` acknowledges a node stopped as `unknown_effect_reconciled`, and
 *   `detachedBootstrap` is set only by the CLI entry when this process is its
 *   own detached child
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
    const outcome = await driveRun(contract, runDir, states, campaign, lock, sourceIdentity, resumeMetadata, options);
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
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {CampaignRef} campaign
 * @param {LockHandle} lock
 * @param {SourceIdentity} sourceIdentity
 * @param {{identityWarnings?: string[]}} [resume] resume-only records persisted on the run metadata
 * @param {{detachedBootstrap?: boolean}} [options] set by the CLI entry alone
 * @returns {Promise<RunOutcome>}
 */
async function driveRun(contract, runDir, states, campaign, lock, sourceIdentity, resume = {}, options = {}) {
  lock.assert();
  assertEnvironmentReady(contract, runDir, sourceIdentity);
  const runsDir = join(contract.cwd, ".runs");
  const bootstrapNonce = bootstrapNonceForProcess();
  // Only the CLI entry can answer this: a nonce inherited by evals/run.mjs or
  // by a test must not make the controller wait for an acknowledgement nobody
  // is going to write.
  const detachedBootstrap = options.detachedBootstrap === true;
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
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 * @param {string} campaignPath
 * @returns {Promise<import("../repo/integrate.mjs").IntegrationResult|null>}
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

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @returns {NodeSnapshot[]}
 */
export function readRunNodes(runDir, contract) {
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

const HARNESS_PROBE_RETRIES = 2;

const HARNESS_PROBE_RETRY_BACKOFF_MS = 250;

/**
 * Probe a runtime version, retrying transient unavailability so a loaded host
 * is never misread as a changed harness. Only a concrete version or final
 * unavailability leaves this function.
 *
 * @param {import("../harnesses/index.mjs").HarnessRuntime & {capabilities?: unknown}} runtime
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function probeRuntimeVersionStable(runtime, cwd) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await probeRuntime(runtime, { cwd, timeoutSec: 5 });
    if (result.version !== null || attempt >= HARNESS_PROBE_RETRIES) return result.version ?? null;
    await new Promise((resolveRetry) => setTimeout(resolveRetry, HARNESS_PROBE_RETRY_BACKOFF_MS * 2 ** attempt));
  }
}

/**
 * Capture the run's source identity, including one version-only probe per
 * distinct routed runtime (a local binary call, no model tokens) so a later
 * resume can refuse a harness that was upgraded or broke mid-campaign.
 *
 * @param {ValidatedContract} contract
 * @param {Map<string, import("../repo/workspace.mjs").WorkspaceScopeBoundary>} scopeBoundaries
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
  return { ...identity, harnessVersions: Object.fromEntries(versions) };
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
  const fields = ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "harnessVersions"];
  /** @type {string[]} */
  const warnings = [];
  for (const field of fields) {
    const expectedRecord = /** @type {Record<string, unknown>|undefined} */ (expected);
    const actualRecord = /** @type {Record<string, unknown>|undefined} */ (actual);
    if (expectedRecord?.[field] === undefined) throw new Error(`source identity is incomplete; resume refused`);
    if (field === "harnessVersions") {
      const expectedVersions = /** @type {Record<string, string|null>} */ (expectedRecord?.[field] ?? {});
      const actualVersions = /** @type {Record<string, string|null>} */ (actualRecord?.[field] ?? {});
      const ids = new Set([...Object.keys(expectedVersions), ...Object.keys(actualVersions)]);
      for (const id of ids) {
        const expectedVersion = expectedVersions[id] ?? null;
        const actualVersion = actualVersions[id] ?? null;
        if (expectedVersion === actualVersion) continue;
        if (expectedVersion === null || actualVersion === null) {
          throw new Error(`harness probe unavailable for ${id}; resume refused`);
        }
        throw new Error("source drift detected in harnessVersions; resume refused");
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
    harnessVersions: sourceIdentity?.harnessVersions ?? {},
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
