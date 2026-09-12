/**
 * Picking a run back up: what the previous controller left, and what may be
 * trusted from it.
 *
 * Resume is the hard half of the loop. Nodes marked `running` may have a live
 * process, a dead one, or a finished turn nobody recorded; integration may be
 * half-applied; the source the run was pinned to may have moved. Nothing here
 * re-dispatches hopefully -- every node is adopted, re-judged, retried in place
 * or refused on evidence that is on disk.
 *
 * `runtimeAssignments` re-composes the worker/judge pair only for roles the
 * contract left open, and only from runtimes that are available now: a resume
 * after an exhausted provider is exactly when that matters.
 */
import { TERMINAL } from "./prompts.mjs";
import { acquire as acquireLock } from "../run/lock.mjs";
import { applyInvalidWorkerResult, assertRunMutable, handleProviderExhaustion } from "./lifecycle.mjs";
import { applyJudgeResult } from "./review.mjs";
import { assertSourceUnchanged, captureRunIdentity } from "./run-identity.mjs";
import { attemptWorkspace, attemptWorktreePath, gitHead, removeWorktree, runRefName } from "../repo/worktree.mjs";
import { canonicalWorkerResultText, isResultMaterializationInvocation, materializeAttemptResult, recoverWorkerResult } from "./result-file.mjs";
import { checkPersistedWorkerScope, persistedScopeBoundary, reconcileAmbiguousWorkerRestart, resolveUnknownEffect } from "./scope.mjs";
import { closePersistedInvocation, recoverOrphan, recoveryFromOverride } from "./recover.mjs";
import { driveRun, readRunNodes } from "./scheduler.mjs";
import { emptyUsage, invocationCost, invocationUsage, persistRecoveryUsage } from "../run/usage.mjs";
import { ensureTerminalEvent, hasDoneEvent, recordExecutionOverride, transition, writeNode } from "./state.mjs";
import { errorMessage, excerpt } from "../util.mjs";
import { executeControllerVerification, recoverVerificationAttempts, verifyCandidateWorkspace } from "./verify.mjs";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { extractJson } from "../harnesses/protocol.mjs";
import { hasOperationIntent, hasOperationSettlement, operationNeedsRecovery, providerReceipts, providerReceiptsFromInvocationTail, readOperationSettlement, settleInvocation } from "../run/operations.mjs";
import { isUnknownEffectStop, planResumeRetry, renderPreviousAttemptSection } from "./retry.mjs";
import { join, resolve } from "node:path";
import { parseDiscoveryResult, parseWorkerResult } from "../contract/worker-result.mjs";
import { readJson } from "../run/store.mjs";
import { recoverIntegrations } from "../repo/integrate.mjs";
import { registerRun, resolveCampaign } from "../campaign/index.mjs";
import { syncAgentSignal } from "../repo/signal.mjs";
import { validateContract } from "../contract/index.mjs";
import { validateRunMetadata } from "../contract/snapshot.mjs";
import { verificationFailureVerdict } from "./judge-gate.mjs";
import { verificationFailureWithScope } from "../contract/scope-findings.mjs";
import { applyRejection, applyVerificationFailure, raiseNodeAttention, settleDone } from "./settle.mjs";

/** @typedef {import("../repo/integrate.mjs").IntegrationResult} IntegrationResult */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./scheduler.mjs").RunOutcome} RunOutcome */
/** @typedef {import("./runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/worker-result.mjs").WorkerResult} WorkerResult */

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
export function isBlockedContextTerminal(state) {
  return state.status === "blocked" && state.error?.code === "context_missing";
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 * @param {string} campaignPath
 * @returns {Promise<import("../repo/integrate.mjs").IntegrationResult|null>}
 */
export async function recoverIntegrationTransactions(contract, runDir, states, lock, campaignPath) {
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
