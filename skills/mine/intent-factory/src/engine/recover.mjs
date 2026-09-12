/**
 * Adopting what a previous controller left running.
 *
 * A resumed run finds nodes marked `running` whose process may be alive, dead,
 * or finished-but-unrecorded. `recoverOrphan` decides which, from the pid, the
 * process start token, the operation ledger and the transcript on disk -- never
 * by re-dispatching hopefully. Adopt a finished turn, re-judge a finished
 * worker, restart only what left no usable evidence.
 */
import { delay } from "../util.mjs";
import { hasOperationIntent, operationNeedsRecovery, operationNextState, readOperationSettlement, settleInvocation } from "../run/operations.mjs";
import { invocationAlive, invocationResult, terminateInvocation } from "./process.mjs";
import { latestTimeoutSec } from "./backoff.mjs";
import { parseJudge } from "./prompts.mjs";
import { persistedJudgeResult, persistedWorkerResult } from "./result-file.mjs";
import { routeRuntimeForState, runtimeSnapshot } from "./failover.mjs";

/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("../run/usage.mjs").RecoveryOutcome} RecoveryOutcome */
/** @typedef {import("../contract/index.mjs").Usage} Usage */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */

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
