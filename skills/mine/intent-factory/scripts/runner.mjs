#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
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
} from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
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
  INTENT_FACTORY_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  driverCapabilities,
  probeRuntime,
  providerCommand,
} from "./drivers/index.mjs";
import { extractJson, liveInputTokens, liveUsage } from "./drivers/exec-jsonl.mjs";
import { renderReportJson, renderStatusJson } from "./render.mjs";
import {
  captureSourceIdentity,
  validateEvent,
  validateNodeSnapshot,
  validateRunMetadata,
} from "./contract.mjs";
import {
  appendJsonl,
  acquireControllerLease,
  acquireSupervisorLease,
  bootstrapAckPath,
  bootstrapAttemptPath,
  bootstrapPath,
  cleanupBootstrapAttempts,
  LeaseLostError,
  leaseHealthy,
  readJson,
  readLease,
  readSupervisorLease,
  writeJsonAtomic,
  writeTextAtomic,
} from "./store.mjs";
import {
  detectStalls,
  checkRecoveredProgress,
  invocationAlive,
  invocationResult,
  latestTimeoutSec,
  processStartToken,
  runProcessAlive,
  startProcess,
  terminateInvocation,
  terminateProcess,
} from "./supervisor.mjs";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceScope,
  compareWorkspaceSnapshot,
  compactVerification,
  runVerification,
  validateWorkspaceScopeBoundary,
} from "./verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "./worker-result.mjs";
import { buildCapsule, DEFAULT_CAPSULE_BYTES, parseCapsule } from "./capsule.mjs";
import { registerRun, renderHandoff, renderRunHandoff, resolveCampaign } from "./campaign.mjs";
import { campaignCli } from "./campaign-cli.mjs";
import { drainNotifications, enqueueNotification } from "./campaign-autonomy.mjs";

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
/** @typedef {import("./store.mjs").LeaseRecord} LeaseRecord */
/** @typedef {ReturnType<typeof acquireControllerLease>} LeaseHandle */
/** @typedef {import("./supervisor.mjs").Job} Job */
/** @typedef {import("./supervisor.mjs").Invocation} Invocation */
/** @typedef {import("./supervisor.mjs").InvocationProbe} InvocationProbe */
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
/** @typedef {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number, conservativeInputTokens: number, budgetInputTokens: number, workerBudgetInputTokens: number, judgeBudgetInputTokens: number, remainingWorkerAllowance: number|null, judgeReserveInputTokens: number|null, maxInputTokens: number|null, phases: Record<string, {budgetInputTokens: number, conservativeInputTokens: number, invocations: number}>}} CampaignUsage */
/** @typedef {{policy: {epoch: string, maxInputTokens: number, judgeReserveInputTokens: number, maxPhaseInputTokens: number, maxInvocationTokens: number, cacheReadWeight: number}, invocations: Record<string, {runId?: string, campaignId?: string, role?: "worker"|"judge", planPhase?: string, usage: Usage, costUsd: number|null}>}} UsageLedgerEpoch */
/** @typedef {{schemaVersion: number, epochs: Record<string, UsageLedgerEpoch>}} UsageLedger */
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

/** @param {string} campaignPath */
async function drainNotificationsSafely(campaignPath) {
  try {
    await drainNotifications(campaignPath);
  } catch (error) {
    process.stderr.write(`[warn] notification delivery failed: ${errorMessage(error)}\n`);
  }
}

/**
 * @param {string} campaignPath
 * @param {string} type
 * @param {string} key
 * @param {string} summary
 * @param {Record<string, unknown>} [data]
 */
async function notifyCampaign(campaignPath, type, key, summary, data = {}) {
  try {
    enqueueNotification(campaignPath, type, key, summary, data);
  } catch (error) {
    process.stderr.write(`[warn] notification enqueue failed: ${errorMessage(error)}\n`);
    return;
  }
  await drainNotificationsSafely(campaignPath);
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
  assertCostCapability(contract);
  const runDir = join(contract.cwd, ".runs", contract.id);
  if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
  mkdirSync(join(contract.cwd, ".runs"), { recursive: true });
  try {
    mkdirSync(runDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error(`run already exists: ${runDir}`);
    throw error;
  }
  const lease = acquireControllerLease(runDir, {
    contractVersion: INTENT_FACTORY_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  lease.startHeartbeat();
  try {
    const scopeBoundaries = captureNodeScopeBoundaries(contract);
    const sourceIdentity = await captureRunIdentity(contract, scopeBoundaries);
    lease.assert();
    const runsDir = join(contract.cwd, ".runs");
    const campaign = resolveCampaign(runsDir, contract.campaignId);
    ensureCampaignUsageLedger(campaign.path, contract.usagePolicy);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    mkdirSync(join(runDir, "logs"), { recursive: true });
    writeJsonAtomic(join(runDir, "contract.json"), serializableContract(contract));
    writeJsonAtomic(join(runDir, "judge.schema.json"), JUDGE_SCHEMA);
    writeJsonAtomic(join(runDir, "run.json"), createRunMetadata(lease, sourceIdentity));
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
        routing: { history: [], currentOverride: null },
        progress: null,
        invocations: [],
        executionOverrides: [],
      };
      states.set(node.id, state);
      writeNode(runDir, state, lease);
    }
    syncAgentSignal(runsDir);
    const outcome = await driveRun(contract, runDir, states, campaign, lease, sourceIdentity);
    syncAgentSignal(runsDir);
    return outcome;
  } catch (error) {
    lease.release();
    throw error;
  }
}

/**
 * @param {string} runDirPath
 * @returns {Promise<RunOutcome>}
 */
export async function resumeRun(runDirPath) {
  const runDir = resolve(runDirPath);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  assertCostCapability(contract);
  const lease = acquireControllerLease(runDir, {
    contractVersion: INTENT_FACTORY_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  lease.startHeartbeat();
  try {
    const storedMetadata = validateRunMetadata(readJson(join(runDir, "run.json")), { requireSourceIdentity: true });
    const states = new Map(readRunNodes(runDir, contract).map((state) => [state.id, state]));
    const scopeBoundaries = new Map(contract.nodes.map((node) => [
      node.id,
      persistedScopeBoundary(contract, node, states.get(node.id)),
    ]));
    const sourceIdentity = await captureRunIdentity(contract, scopeBoundaries);
    assertSourceUnchanged(storedMetadata.sourceIdentity, sourceIdentity);
    const runsDir = join(runDir, "..");
    const campaign = resolveCampaign(runsDir, contract.campaignId);
    registerRun(campaign.path, contract.id);
    ensureCampaignUsageLedger(campaign.path, contract.usagePolicy);
    await synchronizeCampaignUsage(campaign.path, contract.usagePolicy, states);
    for (const node of contract.nodes) {
      const state = states.get(node.id);
      if (!state) continue;
      state.usage = invocationUsage(state);
      state.costUsd = invocationCost(state);
      if (state.status === "done" || state.status === "canceled" || isBlockedContextTerminal(state) || isUnknownEffectTerminal(state)) continue;
      const lastInvocation = state.invocations?.at(-1);
      await recoverVerificationAttempts(runDir, state, lease);
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
        : await recoverOrphan(runDir, contract, node, recoveryState, lease);
      await persistRecoveryUsage(campaign.path, contract.usagePolicy, runDir, state, recovery, lease);
      if (recovery?.kind === "reconciled") {
        transition(runDir, state, "blocked", {
          phase: recovery.phase ?? "worker",
          error: {
            code: "unknown_effect_reconciled",
            message: excerpt(recovery.reason ?? "unknown effect requires manual reconciliation"),
          },
        }, lease);
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
        writeNode(runDir, state, lease);
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
          lease,
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
        }, lease);
        continue;
      }
      if (recovery?.kind === "adopted" || recovery?.kind === "rejudge") {
        const workerResult = recovery.phase === "judge"
          ? recoverWorkerResult(state, contract, node)
          : recovery.result;
        if (recovery.phase === "worker" && workerResult !== null) {
          const invocation = recovery.kind === "rejudge"
            ? [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker")
            : state.invocations?.find((item) => item.id === recovery.invocationId);
          if (!checkPersistedWorkerScope(contract, runDir, state, node, invocation, lease)) continue;
          /** @type {WorkerResult|undefined} */
          let parsedWorkerResult;
          try {
            parsedWorkerResult = parseWorkerResult(String(extractJson(workerResult) ?? workerResult));
          } catch (error) {
            applyInvalidWorkerResult(contract, node, state, runDir, null, lease, errorMessage(error));
            continue;
          }
          if (node.taskPacket.mode === "discovery" && parsedWorkerResult.status === "done") {
            try {
              parseDiscoveryResult(parsedWorkerResult, contract.cwd);
            } catch (error) {
              applyInvalidWorkerResult(contract, node, state, runDir, null, lease, errorMessage(error));
              continue;
            }
          }
          state.result = parsedWorkerResult;
          if (parsedWorkerResult.status === "blocked_context") {
            transition(runDir, state, "blocked", {
              phase: "complete",
              result: parsedWorkerResult,
              error: { code: "context_missing", message: parsedWorkerResult.missingContext.join("; ") },
            }, lease);
            continue;
          }
          await executeControllerVerification(contract, runDir, node, state, lease);
          if (!state.verification?.passed) {
            state.gate = verificationFailureVerdict(state);
            if (node.gate.enabled && state.revisions < (node.gate.maxRevisions ?? 1)) {
              resetPhaseRouting(state);
              state.revisions += 1;
              state.attempt += 1;
              transition(runDir, state, "pending", { phase: "worker", error: null }, lease);
            } else {
              transition(runDir, state, node.gate.enabled ? "exhausted" : "failed", {
                phase: "worker",
                error: { code: "verification_failed", message: "deterministic verification failed" },
              }, lease);
            }
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
        }, lease);
        if (recovery.phase === "worker") {
          persistNodeCapsule(contract, node, state, runDir, lease, "continue from the adopted worker result");
          consumeManualHandoff(state);
        }
        if (recovery.phase === "worker" && node.gate.enabled) {
          transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lease);
        } else if (recovery.phase === "judge") {
          applyJudgeResult(contract, node, state, recovery.result, runDir, lease);
        } else {
          transition(runDir, state, "done", { phase: "complete", error: null, blockedBy: [] }, lease);
        }
        continue;
      }
      if (recovery?.kind === "restart") {
        const restartInvocation = state.invocations?.find((item) => item.id === recovery.invocationId)
          ?? [...(state.invocations ?? [])].reverse()[0];
        const unknownEffectId = recovery.invocationId ?? lastInvocationId;
        const recoveryPhase = recovery.phase ?? restartInvocation?.phase ?? "worker";
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
            const resolution = await resolveUnknownEffect(contract, runDir, node, state, workerInvocation, lease);
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
            }, lease);
            if (resolution.action === "replay") {
              if (recoveryPhase === "worker") {
                persistNodeCapsule(contract, node, state, runDir, lease, "retry the closed task packet on a fresh attempt");
              } else {
                // A judge has no workspace effect of its own. Replaying it
                // must keep the accepted worker result and schedule a fresh
                // judge invocation rather than rerunning the worker.
                transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lease);
                continue;
              }
            }
            if (resolution.action === "reconcile") {
              transition(runDir, state, "blocked", {
                phase: recoveryPhase,
                error: { code: "unknown_effect_reconciled", message: excerpt(resolution.reason) },
              }, lease);
              continue;
            }
          }
        }
        if (recovery.phase === "worker" || restartInvocation?.phase === "worker") {
          const invocation = restartInvocation
            ?? [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
          if (reconcileAmbiguousWorkerRestart(contract, runDir, node, state, invocation, recovery, persistedRecovery, lease)) continue;
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
          transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lease);
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
        }, lease);
      }
      transition(runDir, state, "pending", { phase: "waiting", error: null, blockedBy: [] }, lease);
    }
    const outcome = await driveRun(contract, runDir, states, campaign, lease, sourceIdentity);
    syncAgentSignal(runsDir);
    return outcome;
  } catch (error) {
    lease.release();
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
 * @param {LeaseHandle} lease
 * @param {SourceIdentity} sourceIdentity
 * @returns {Promise<RunOutcome>}
 */
export async function driveRun(contract, runDir, states, campaign, lease, sourceIdentity) {
  lease.assert();
  const runsDir = join(contract.cwd, ".runs");
  const currentLease = lease.current;
  const bootstrapNonce = bootstrapNonceForProcess();
  const detachedBootstrap = hasDetachedBootstrapNonce();
  const runMetadata = createRunMetadata(lease, sourceIdentity);
  writeJsonAtomic(join(runDir, "run.json"), runMetadata);
  /** @type {Error|null} */
  let leaseLost = null;
  /**
   * @param {LeaseRecord} current
   */
  const refreshMetadata = (current) => {
    writeJsonAtomic(join(runDir, "run.json"), {
      ...runMetadata,
      leaseRenewedAt: current.renewedAt,
      leaseExpiresAt: current.expiresAt,
    });
  };
  lease.options.onRenew = refreshMetadata;
  lease.startHeartbeat((error) => {
    if (!leaseLost) leaseLost = error;
  });
  writeJsonAtomic(bootstrapPath(runDir), {
    status: "ready",
    nonce: bootstrapNonce,
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    runDir,
    holderId: currentLease.holderId,
    generation: currentLease.generation,
    leaseExpiresAt: currentLease.expiresAt,
    metadataPath: join(runDir, "run.json"),
    at: new Date().toISOString(),
  });
  writeJsonAtomic(bootstrapAttemptPath(runDir, bootstrapNonce), readJson(bootstrapPath(runDir)));
  cleanupBootstrapAttempts(runDir, bootstrapNonce);
  if (detachedBootstrap) await waitForBootstrapAcknowledgement(runDir, {
      nonce: bootstrapNonce,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      holderId: currentLease.holderId,
      generation: currentLease.generation,
  });
  lease.assert();
  renderCampaignHandoffSafely(campaign, runsDir, runDir);

  /** @type {string|null} */
  let statusFingerprint = null;
  /** @param {boolean} force @param {LeaseHandle|null} [renderLease] */
  const renderStatusIfChanged = (force = false, renderLease = lease) => {
    const fingerprint = statesFingerprint(states);
    if (!force && fingerprint === statusFingerprint) return;
    statusFingerprint = fingerprint;
    render(runDir, contract, states, renderLease);
  };
  let handoffFingerprint = statesFingerprint(states);
  const renderHandoffIfChanged = () => {
    const fingerprint = statesFingerprint(states);
    if (fingerprint === handoffFingerprint) return;
    handoffFingerprint = fingerprint;
    renderCampaignHandoffSafely(campaign, runsDir, runDir);
  };
  /** @type {string|null} */
  let notificationFingerprint = null;
  const notifyStateChanges = async () => {
    const fingerprint = statesFingerprint(states);
    if (fingerprint === notificationFingerprint) return;
    notificationFingerprint = fingerprint;
    for (const state of states.values()) {
      if (!TERMINAL.has(state.status)) continue;
      const note = state.gate?.summary ?? resultSummary(state.result) ?? state.error?.message ?? state.status;
      await notifyCampaign(
        campaign.path,
        "node.terminal",
        `${basename(runDir)}:${state.id}:${state.status}:${state.attempt}:${state.revisions}`,
        `${state.id} ${state.status}: ${excerpt(note) ?? state.status}`,
        { runId: basename(runDir), nodeId: state.id, status: state.status },
      );
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
      lease.assert();
      if (leaseLost || existsSync(join(runDir, "cancel.request.json"))) canceled = true;
      if (canceled) {
        const jobs = [...running.values()];
        await Promise.all(jobs.map((job) => terminateProcess(job)));
        const envelopes = new Map();
        for (const job of jobs) envelopes.set(job.invocation.id, recordInvocationUsage(job, { accumulate: false }));
        for (const job of jobs) {
          const scopeOk = job.phase !== "worker" || checkWorkerScope(contract, runDir, job, lease);
          settleInvocation(runDir, job.invocation, {
            status: scopeOk ? "canceled" : "failed",
            usage: job.invocation.usage ?? null,
            costUsd: typeof job.invocation.costUsd === "number" ? job.invocation.costUsd : null,
            receipts: providerReceipts(envelopes.get(job.invocation.id)),
            error: scopeOk ? null : job.state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
            nextState: operationNextState(job.state),
          });
        }
        running.clear();
        for (const state of states.values()) {
          if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled" }, lease);
        }
        break;
      }

      await finalizeClosedJobs(contract, runDir, states, running, lease, campaign.path);
      await detectStalls(contract, running, async (job, status, error) => {
        const invocation = job.state.invocations?.find((item) => item.id === job.invocation.id);
        const envelope = recordInvocationUsage(job);
        job.state.usage = invocationUsage(job.state);
        job.state.costUsd = invocationCost(job.state);
        await recordCampaignUsage(campaign.path, contract.usagePolicy, invocation);
        if (job.phase === "worker" && !checkWorkerScope(contract, runDir, job, lease)) {
          settleInvocation(runDir, invocation ?? job.invocation, {
            status: "failed",
            usage: invocation?.usage ?? null,
            costUsd: typeof invocation?.costUsd === "number" ? invocation.costUsd : null,
            receipts: providerReceipts(envelope),
            error: job.state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
            nextState: operationNextState(job.state),
          });
          return;
        }
        settleInvocation(runDir, invocation ?? job.invocation, {
          status,
          usage: invocation?.usage ?? null,
          costUsd: typeof invocation?.costUsd === "number" ? invocation.costUsd : null,
          receipts: providerReceipts(envelope),
          error,
          nextState: operationNextState(job.state),
        });
        transition(runDir, job.state, status, { phase: job.phase, error }, lease);
      }, async (job) => {
        writeNode(runDir, job.state, lease);
      });
      blockDependents(contract, runDir, states, lease);
      enforceTokenBudget(contract, runDir, states, running, lease);
      enforceLedgerBudget(contract, runDir, states, lease, campaign.path);
      enforceCostBudget(contract, runDir, states, lease, campaign.path);

      // A provider that finishes its turn but never exits must not pin the
      // run forever: enforce each invocation's wall-clock deadline in the
      // live loop, not only on resume.
      const now = Date.now();
      for (const [nodeId, job] of running) {
        if (job.closed || job.budgetStop) continue;
        const startedAt = Date.parse(job.invocation.startedAt);
        const timeoutSec = latestTimeoutSec(job.state, job.node.timeoutSec ?? contract.timeoutSec);
        if (!Number.isFinite(startedAt) || !Number.isFinite(timeoutSec)) continue;
        if (now - startedAt > timeoutSec * 1000) {
          job.budgetStop = "wallclock";
          process.stdout.write(`[node] ${nodeId} wall-clock budget reached (${timeoutSec}s) · terminating\n`);
          void terminateProcess(job).catch(() => {});
        }
      }

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
            startJudge(contract, node, state, runDir, running, state.result, lease);
            continue;
          }
          state.attempt += 1;
          const prompt = state.gate?.verdict === "fail" ? retryPrompt(node, state.gate) : node.prompt;
          startWorker(contract, node, state, runDir, running, prompt, lease);
        }
      }

      renderHandoffIfChanged();
      renderStatusIfChanged();
      await notifyStateChanges();
      if ([...states.values()].some((state) => !TERMINAL.has(state.status))) await delay(contract.pollIntervalMs);
    }
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
    await Promise.all([...running.values()].map((job) => terminateProcess(job)));
    return { runDir, states, ok: false, error };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGHUP", cancel);
    lease.stopHeartbeat();
    if (!leaseLost) lease.release();
  }
  renderStatusIfChanged(false, null);
  renderCampaignHandoffSafely(campaign, runsDir, runDir);
  writeFindingsArtifact(runDir, contract, states);
  const failed = [...states.values()].filter((state) => state.status !== "done");
  await notifyCampaign(
    campaign.path,
    "run.terminal",
    `${basename(runDir)}:${failed.length ? "attention" : "done"}`,
    `${basename(runDir)} ${failed.length ? `needs attention (${failed.length}/${states.size} non-done)` : `completed (${states.size}/${states.size} done)`}`,
    { runId: basename(runDir), done: states.size - failed.length, total: states.size, needsAttention: failed.length },
  );
  process.stdout.write(`[run] ${contract.id} ${failed.length ? `failed · ${runDir} · findings.json` : `done · ${runDir}`}\n`);
  if ([...states.values()].some((state) => state.usage)) {
    const report = renderFinalReport(runDir, contract, states);
    process.stdout.write(report);
  }
  return { runDir, states, ok: failed.length === 0 };
}

/**
 * @param {LeaseHandle} lease
 * @param {SourceIdentity} sourceIdentity
 * @returns {RunMetadata}
 */
function createRunMetadata(lease, sourceIdentity) {
  const current = lease.current;
  const metadata = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    startedAt: new Date().toISOString(),
    holderId: current.holderId,
    leaseGeneration: current.generation,
    leaseAcquiredAt: current.acquiredAt,
    leaseRenewedAt: current.renewedAt,
    leaseExpiresAt: current.expiresAt,
    sourceIdentity,
  };
  return validateRunMetadata(metadata, { requireLease: true });
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
  const routed = routeRuntime(contract, node, role);
  const { ruleIndex, backoffSec, ...runtime } = routed;
  return runtime;
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runtimeId
 * @returns {RuntimeSnapshot}
 */
function runtimeSnapshot(contract, runtimeId) {
  const runtime = contract.runtimes[runtimeId];
  if (!runtime) throw new Error(`unknown persisted runtime: ${runtimeId}`);
  return { id: runtimeId, ...runtime, capabilities: driverCapabilities(runtime) };
}

/**
 * @param {NodeSnapshot} state
 * @param {string} phase
 * @returns {boolean}
 */
function routingBackoffActive(state, phase) {
  const override = state.routing?.currentOverride;
  return Boolean(override?.role === phase && override.backoffUntil && Date.parse(override.backoffUntil) > Date.now());
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
  const candidates = phaseSessionCandidates(contract, node, state, runDir, role);
  const session = candidates.at(-1);
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
  const priorNode = session?.nodeId ?? null;
  const phaseUsage = campaignUsage(campaignUsagePath(contract), contract.usagePolicy)
    .phases[`${role}:${node.phase}`]?.budgetInputTokens ?? 0;
  const softRotate = contract.usagePolicy !== false
    && phaseUsage >= contract.usagePolicy.maxPhaseInputTokens
    && priorNode !== null
    && priorNode !== node.id;
  const canContinue = runtime.capabilities.continuation === true;
  if (role === "worker" && isManualHandoff(state)) {
    return {
      prompt: capsuleHandoffPrompt(contract, node, state, runDir),
      continuationId: null,
      mode: "fresh",
    };
  }
  // Cross-harness handoff: the last accepted state came from a different
  // runtime identity, so the fresh attempt composes its prompt from the
  // portable capsule instead of raw summaries or native continuation.
  if (role === "worker" && session && session.invocation.runtimeFingerprint
    && session.invocation.runtimeFingerprint !== fingerprintRuntime(runtime)) {
    return {
      prompt: capsuleHandoffPrompt(contract, node, state, runDir),
      continuationId: null,
      mode: "fresh",
    };
  }
  if (identityMatches && !softRotate && canContinue) {
    return { prompt, continuationId: session.invocation.continuationId ?? null, mode: "reuse" };
  }
  if (softRotate || (session && !canContinue)) {
    return {
      prompt: phaseHandoffPrompt(contract, node, state, runDir, role),
      continuationId: null,
      mode: "rotate",
    };
  }
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

/** @param {Invocation} invocation @param {ValidatedContract} contract @param {ValidatedNode} node @param {RuntimeSnapshot} runtime @param {string} runDir @param {"worker"|"judge"} role @param {"fresh"|"reuse"|"rotate"} mode @param {string|null} continuationId */
function stampInvocation(invocation, contract, node, runtime, runDir, role, mode, continuationId) {
  invocation.runId = basename(runDir);
  invocation.campaignId = contract.campaignId;
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

/**
 * A manual handoff override has no routing rule metadata. Provider failover
 * overrides carry a rule, hop, or nextRuntime field and keep their existing
 * provider-specific routing behavior.
 *
 * @param {NodeSnapshot} state
 * @returns {boolean}
 */
function isManualHandoff(state) {
  const override = state.routing?.currentOverride;
  return override?.role === "worker"
    && typeof override.reason === "string"
    && override.ruleIndex === undefined
    && override.rule === undefined
    && override.hop === undefined
    && override.nextRuntime === undefined;
}

/** @param {NodeSnapshot} state */
function consumeManualHandoff(state) {
  if (isManualHandoff(state) && state.routing) state.routing.currentOverride = null;
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
 * Build the bounded options shared by workers, judges, and gate revisions.
 * Capability declarations decide which in-flight provider controls are sent;
 * timeout and campaign accounting remain universal fallbacks.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {RuntimeSnapshot} runtime
 * @param {{prompt: string, continuationId: string|null, mode: "fresh"|"reuse"|"rotate"}} phasePlan
 * @param {import("./drivers/index.mjs").CommandOptions} [extra]
 * @returns {import("./drivers/index.mjs").CommandOptions}
 */
function invocationCommandOptions(contract, node, state, runtime, phasePlan, extra = {}) {
  const options = {
    ...extra,
    continuationId: runtime.capabilities.continuation === true ? phasePlan.continuationId : null,
  };
  if (runtime.capabilities.tokenBudget === true && contract.usagePolicy !== false) {
    options.maxInvocationTokens = contract.usagePolicy.maxInvocationTokens;
  }
  if (runtime.capabilities.costBudget === true) {
    const allowance = remainingMonetaryAllowance(contract, node, state);
    if (allowance !== null) options.maxCostUsd = allowance;
  }
  return options;
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {string} prompt
 * @param {LeaseHandle} lease
 */
function startWorker(contract, node, state, runDir, running, prompt, lease) {
  const runtime = routeRuntimeForState(contract, node, state, "worker");
  const phasePlan = phaseInvocationPlan(contract, node, state, runDir, "worker", prompt);
  const effectivePrompt = phasePlan.prompt;
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  if (Buffer.byteLength(effectivePrompt, "utf8") > 64 * 1024) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "worker_prompt_too_large", message: "worker prompt exceeds 65536 bytes" } }, lease);
    return;
  }
  /** @type {import("./verification.mjs").WorkspaceScopeBoundary} */
  let boundary;
  /** @type {unknown} */
  let baseline;
  try {
    boundary = persistedScopeBoundary(contract, node, state);
    baseline = captureWorkspaceSnapshot(contract.cwd);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: errorMessage(error) } }, lease);
    return;
  }
  const snapshotPath = `${paths.prompt}.snapshot.json`;
  writeJsonAtomic(snapshotPath, baseline);
  state.phase = "worker";
  state.runtime = runtime;
  // A new worker attempt has no accepted result yet. Clearing the prior
  // attempt prevents resume from mistaking an old checkpoint for this one.
  state.result = null;
  state.verification = null;
  state.scope = null;
  const previousInvocation = state.invocations?.at(-1);
  if (previousInvocation && hasOperationSettlement(runDir, previousInvocation.id)) {
    settleInvocation(runDir, previousInvocation, { nextState: operationNextState(state) });
  }
  state.startedAt ??= new Date().toISOString();
  state.error = null;
  state.scope = emptyScope(boundary);
  writeNode(runDir, state, lease);
  try {
    const job = startProcess({
      contract, node, state, runtime, prompt: effectivePrompt, paths, phase: "worker",
      commandOptions: invocationCommandOptions(contract, node, state, runtime, phasePlan),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, runtime, runDir, "worker", phasePlan.mode, phasePlan.continuationId);
        invocation.snapshotPath = snapshotPath;
        currentJob.scopeBaseline = baseline;
        persistInvocation(runDir, state, invocation, currentJob, lease, contract.usagePolicy);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "worker",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(runtime),
          prompt: effectivePrompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lease),
      onProgress: () => writeNode(runDir, state, lease),
    });
    transition(runDir, state, "running", { phase: "worker", runtime, error: null }, lease);
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
    transition(runDir, state, "failed", { phase: "worker", error: { code: "spawn_error", message: errorMessage(error) } }, lease);
  }
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {unknown} workerResult
 * @param {LeaseHandle} lease
 */
function startJudge(contract, node, state, runDir, running, workerResult, lease) {
  const runtime = routeRuntimeForState(contract, node, state, "judge");
  const paths = logPaths(runDir, node.id, "judge", state.attempt);
  state.phase = "judge";
  state.runtime = runtime;
  const previousInvocation = state.invocations?.at(-1);
  if (previousInvocation && hasOperationSettlement(runDir, previousInvocation.id)) {
    settleInvocation(runDir, previousInvocation, { nextState: operationNextState(state) });
  }
  try {
    const prompt = judgePrompt(node, workerResult, { diff: state.scope?.changedPaths, verification: state.verification });
    const phasePlan = phaseInvocationPlan(contract, node, state, runDir, "judge", prompt);
    if (Buffer.byteLength(phasePlan.prompt, "utf8") > 64 * 1024) {
      const error = /** @type {Error & {code: string}} */ (new Error("judge prompt exceeds 65536 bytes"));
      error.code = "judge_prompt_too_large";
      throw error;
    }
    const job = startProcess({
      contract, node, state, runtime,
      prompt: phasePlan.prompt,
      paths, phase: "judge",
      commandOptions: invocationCommandOptions(contract, node, state, runtime, phasePlan, {
        schema: JUDGE_SCHEMA,
        schemaPath: join(runDir, "judge.schema.json"),
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, runtime, runDir, "judge", phasePlan.mode, phasePlan.continuationId);
        persistInvocation(runDir, state, invocation, currentJob, lease, contract.usagePolicy);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "judge",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(runtime),
          prompt: phasePlan.prompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lease),
    });
    transition(runDir, state, "running", { phase: "judge", runtime }, lease);
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
    transition(runDir, state, "failed", { phase: "judge", error: { code: /** @type {string} */ (errorCode(error) ?? "spawn_error"), message: errorMessage(error) } }, lease);
  }
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Job} job
 * @param {LeaseHandle} lease
 * @param {ValidatedContract["usagePolicy"]} usagePolicy
 */
function persistInvocation(runDir, state, invocation, job, lease, usagePolicy) {
  state.invocations = [...(state.invocations ?? []), invocation];
  state.updatedAt = invocation.updatedAt;
  writeNode(runDir, state, lease);
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
        usage = usageWithBudgetFallback(envelope.usage, envelope.error?.message, usagePolicy);
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
      writeNode(runDir, state, lease);
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
      if (!(error instanceof LeaseLostError)) throw error;
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
 * @param {LeaseHandle} lease
 */
function persistInvocationUpdate(runDir, state, invocation, lease) {
  try {
    state.invocations = (state.invocations ?? []).map((item) => item.id === invocation.id ? invocation : item);
    state.updatedAt = invocation.updatedAt;
    writeNode(runDir, state, lease);
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
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
  const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
 * Build the portable continuation capsule from the node's settled state.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {string} nextAction
 * @returns {ReturnType<typeof buildCapsule>}
 */
function buildNodeCapsule(contract, node, state, runDir, nextAction) {
  const usage = state.usage ?? emptyUsage();
  const sourceRuntime = sourceWorkerRuntime(state);
  const handoff = state.routing?.currentOverride;
  const result = /** @type {Record<string, unknown> | null | undefined} */ (state.result);
  const budgetRemaining = contract.usagePolicy === false
    ? null
    : roundBudgetTokens(contract.usagePolicy.maxInputTokens - campaignUsage(campaignUsagePath(contract), contract.usagePolicy).budgetInputTokens);
  return buildCapsule({
    runId: basename(runDir),
    nodeId: node.id,
    attemptId: `${node.id}.${state.attempt}`,
    objective: node.taskPacket.objective,
    decisions: node.taskPacket.decisions,
    nonGoals: node.taskPacket.nonGoals,
    changedFiles: state.scope?.changedPaths ?? (Array.isArray(result?.changedFiles) ? result.changedFiles.map(String) : []),
    worktreeIdentity: captureWorktreeIdentity(contract.cwd),
    verifications: (state.verification?.commands ?? []).map((command) => ({ argv: command.argv.join(" "), pass: command.passed === true })),
    artifacts: Array.isArray(result?.artifacts)
      ? /** @type {unknown[]} */ (result.artifacts).map((artifact) => {
        const record = /** @type {Record<string, unknown>} */ (artifact);
        return {
          handle: String(record.handle ?? record.path ?? ""),
          sha256: typeof record.sha256 === "string" ? record.sha256 : "",
          bytes: typeof record.bytes === "number" ? record.bytes : null,
          preview: typeof record.preview === "string" ? record.preview : typeof record.summary === "string" ? record.summary : null,
        };
      })
      : [],
    blockers: state.error?.message ? [state.error.message] : [],
    nextAction,
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
    },
    costUsd: typeof state.costUsd === "number" ? state.costUsd : null,
    budgetRemaining,
    continuationHint: isManualHandoff(state) && sourceRuntime && handoff
      ? "handoff from " + sourceRuntime + " to " + handoff.runtime + ": " + handoff.reason
      : null,
  });
}

/**
 * Persist the capsule at a settled worker boundary so any harness can pick up
 * the node without the prior transcript.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LeaseHandle|null} lease
 * @param {string} nextAction
 */
function persistNodeCapsule(contract, node, state, runDir, lease, nextAction) {
  const capsule = buildNodeCapsule(contract, node, state, runDir, nextAction);
  writeJsonAtomic(join(runDir, "capsules", `${node.id}.${state.attempt}.json`), capsule);
  return capsule;
}

/**
 * Load the newest persisted capsule at or below the current attempt.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {number} attempt
 * @returns {ReturnType<typeof buildCapsule>|null}
 */
function loadLatestCapsule(runDir, nodeId, attempt) {
  for (let candidate = attempt; candidate >= 0; candidate -= 1) {
    try {
      return /** @type {ReturnType<typeof buildCapsule>} */ (parseCapsule(readFileSync(join(runDir, "capsules", `${nodeId}.${candidate}.json`), "utf8")));
    } catch {}
  }
  return null;
}

/**
 * Compose a bounded fresh-session prompt from a portable capsule and the
 * closed task packet.
 *
 * @param {ReturnType<typeof buildCapsule>} capsule
 * @param {string|unknown} taskPacket
 * @returns {string}
 */
export function composeCapsulePrompt(capsule, taskPacket) {
  const packet = typeof taskPacket === "string"
    ? taskPacket
    : JSON.stringify(taskPacket, null, 2) ?? "";
  const handoff = [
    `Continue node ${capsule.nodeId} in a fresh provider session on a new harness. The portable continuation capsule below is authoritative; it carries everything from the previous attempt.`,
    `Portable continuation capsule (digest ${capsule.digest}):`,
    boundedUtf8(JSON.stringify(capsule, null, 2), DEFAULT_CAPSULE_BYTES),
    "Current closed task packet:",
    boundedUtf8(packet, 24 * 1024),
  ].join("\n\n");
  return boundedUtf8(handoff, 60 * 1024);
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @returns {string}
 */
function capsuleHandoffPrompt(contract, node, state, runDir) {
  const capsule = loadLatestCapsule(runDir, node.id, state.attempt)
    ?? buildNodeCapsule(contract, node, state, runDir, "continue from the last settled checkpoint");
  return composeCapsulePrompt(capsule, node.prompt);
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
function persistedScopeBoundary(contract, node, state) {
  const boundary = state?.scope?.boundary;
  if (!boundary) throw Object.assign(new Error(`node ${node.id} has no persisted worker scope boundary`), { code: "scope_boundary_missing" });
  return validateWorkspaceScopeBoundary(contract.cwd, boundary, workerScope(node.taskPacket));
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
 * @param {LeaseHandle} lease
 * @param {VerificationAttempt} attempt
 */
function persistVerificationAttempt(runDir, state, lease, attempt) {
  const attempts = verificationAttemptRecords(state);
  const index = attempts.findIndex((item) => item.invocationId === attempt.invocationId);
  if (index >= 0) attempts[index] = { ...attempts[index], ...attempt };
  else attempts.push({ ...attempt, completedAt: attempt.completedAt ?? null, result: attempt.result ?? null });
  state.verification ??= { passed: false, commands: [], completed: false, attempts: [] };
  state.verification.attempts = attempts.slice(-16);
  writeNode(runDir, state, lease);
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {LeaseHandle} lease
 * @returns {Promise<import("./contract.mjs").VerificationState>}
 */
async function executeControllerVerification(contract, runDir, node, state, lease) {
  if (state.verification?.completed === true) return /** @type {import("./contract.mjs").VerificationState} */ (state.verification);
  state.verification = {
    passed: false,
    commands: [],
    completed: false,
    attempts: [...(state.verification?.attempts ?? [])],
  };
  writeNode(runDir, state, lease);
  try {
    const result = await runVerification(node.taskPacket.verification, contract.cwd, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.verification`),
      onAttemptStart: (attempt) => persistVerificationAttempt(runDir, state, lease, attempt),
      onAttemptSpawn: (attempt) => persistVerificationAttempt(runDir, state, lease, {
        ...attempt,
        processStartToken: processStartToken(attempt.pid),
      }),
      onAttemptComplete: (attempt) => persistVerificationAttempt(runDir, state, lease, {
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
  writeNode(runDir, state, lease);
  return state.verification;
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LeaseHandle} lease
 * @returns {Promise<void>}
 */
async function recoverVerificationAttempts(runDir, state, lease) {
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
    persistVerificationAttempt(runDir, state, lease, {
      ...attempt,
      status: "crashed",
      completedAt: new Date().toISOString(),
      result: { passed: false, stdout: "", stderr: "", error: "verification controller interrupted", exitCode: null, signal: null, timedOut: false, durationMs: null },
    });
  }
  state.verification = { ...state.verification, completed: false, passed: false };
  delete state.verification.error;
  writeNode(runDir, state, lease);
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Job} job
 * @param {LeaseHandle} lease
 * @returns {boolean}
 */
function checkWorkerScope(contract, runDir, job, lease) {
  if (job.scopeChecked) return !job.scopeViolation;
  job.scopeChecked = true;
  const state = job.state;
  try {
    const baseline = /** @type {WorkspaceSnapshot|undefined} */ (job.scopeBaseline ?? (job.invocation.snapshotPath ? readJson(job.invocation.snapshotPath) : null));
    if (!baseline) throw Object.assign(new Error("worker scope snapshot is missing"), { code: "scope_snapshot_missing" });
    const boundary = persistedScopeBoundary(contract, job.node, state);
    const scope = compareWorkspaceSnapshot(baseline, contract.cwd, { ...workerScope(job.node.taskPacket), boundary });
    const bounded = boundedScope(scope, boundary);
    state.scope = bounded;
    if (!scope.unexpectedPaths.length) return true;
    job.scopeViolation = true;
    const shown = bounded.unexpectedPaths.slice(0, 8).join(", ");
    const message = `unexpected paths changed (${scope.unexpectedPaths.length}): ${shown}`;
    if (!TERMINAL.has(state.status)) {
      transition(runDir, state, "failed", { phase: "worker", error: { code: "unexpected_write", message: excerpt(message) } }, lease);
      appendTransitionEvent(runDir, state, "failed", "failed", {
        unexpectedPaths: bounded.unexpectedPaths,
        unexpectedPathCount: bounded.unexpectedPathCount,
      }, lease);
    }
    return false;
  } catch (error) {
    job.scopeViolation = true;
    if (!TERMINAL.has(state.status)) {
      transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: excerpt(errorMessage(error)) } }, lease);
    }
    return false;
  }
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
    const boundary = persistedScopeBoundary(contract, node, state);
    const scope = compareWorkspaceSnapshot(baseline, contract.cwd, { ...workerScope(node.taskPacket), boundary });
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
 * @param {LeaseHandle} lease
 * @returns {boolean}
 */
function reconcileAmbiguousWorkerRestart(contract, runDir, node, state, invocation, recovery, persistedRecovery, lease) {
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
  }, lease);
  transition(runDir, state, "blocked", {
    phase: recovery.phase,
    error: { code: "unknown_effect_reconciled", message: excerpt(reason) },
  }, lease);
  return true;
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {ValidatedNode} node
 * @param {Invocation|undefined} invocation
 * @param {LeaseHandle} lease
 * @returns {boolean}
 */
function checkPersistedWorkerScope(contract, runDir, state, node, invocation, lease) {
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, invocation);
  if (evaluation.ok) return true;
  transition(runDir, state, "failed", {
    phase: "worker",
    error: { code: evaluation.code, message: excerpt(evaluation.detail) },
  }, lease);
  if (evaluation.unexpectedPaths) {
    appendTransitionEvent(runDir, state, "failed", "failed", {
      unexpectedPaths: evaluation.unexpectedPaths,
      unexpectedPathCount: evaluation.unexpectedPathCount,
    }, lease);
  }
  return false;
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
 * @param {LeaseHandle} lease
 * @returns {Promise<{action: "replay"}|{action: "reconcile", reason: string}>}
 */
async function resolveUnknownEffect(contract, runDir, node, state, workerInvocation, lease) {
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
  await executeControllerVerification(contract, runDir, node, state, lease);
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
 * @param {LeaseHandle} lease
 * @param {string} campaignPath
 * @returns {Promise<void>}
 */
async function finalizeClosedJobs(contract, runDir, states, running, lease, campaignPath) {
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
      writeNode(runDir, state, lease);
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
      transition(runDir, state, "failed", { phase: job.phase, error: { code: "spawn_error", message: job.spawnError.message } }, lease);
      continue;
    }
    // The provider close evidence was already read by recordInvocationUsage
    // above; charge the declared ceiling when the provider omitted terminal
    // usage, then run the scope gate before any settlement so a scope failure
    // still persists the provider receipts and usage.
    envelope = {
      ...envelope,
      usage: usageWithBudgetFallback(envelope.usage, envelope.error?.message, contract.usagePolicy) ?? envelope.usage,
    };
    if (job.phase === "worker") {
      const scopeOk = checkWorkerScope(contract, runDir, job, lease);
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
      ? { ...invocation, continuationId: envelope.continuationId ?? invocation.continuationId ?? null, usage: envelope.usage, costUsd: envelope.costUsd }
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
    await recordCampaignUsage(campaignPath, contract.usagePolicy, state.invocations.find((invocation) => invocation.id === job.invocation.id));
    state.usage = invocationUsage(state);
    state.costUsd = invocationCost(state);
    if (hasCostBudget(contract, job.node) && envelope.costUsd === null) {
      transition(runDir, state, "failed", {
        phase: job.phase,
        result: state.result,
        usage: state.usage,
        error: { code: "cost_unavailable", message: "provider did not return cost for a monetary budget" },
      }, lease);
      continue;
    }
    if (envelope.status === "exhausted") {
        handleProviderExhaustion(contract, runDir, job.node, state, /** @type {"worker"|"judge"} */ (job.phase), envelope, job.runtime.id, lease);
      continue;
    }
    if (envelope.status !== "done") {
      transition(runDir, state, job.budgetStop ? "exhausted" : envelope.status, {
        phase: job.phase,
        result: state.result,
        error: job.budgetStop
          ? budgetStopError(job.budgetStop, job.state)
          : envelope.error,
        usage: state.usage,
      }, lease);
      continue;
    }
    if (job.phase === "worker") {
      /** @type {WorkerResult} */
      let workerResult;
      try {
        // Workers often prefix the required JSON with a closing summary sentence;
        // the structured object at the end of the message is authoritative.
        workerResult = parseWorkerResult(String(extractJson(envelope.result) ?? envelope.result ?? ""));
      } catch (error) {
        applyInvalidWorkerResult(contract, job.node, state, runDir, running, lease, errorMessage(error));
        continue;
      }
      if (job.node.taskPacket.mode === "discovery" && workerResult.status === "done") {
        try {
          parseDiscoveryResult(workerResult, contract.cwd);
        } catch (error) {
          applyInvalidWorkerResult(contract, job.node, state, runDir, running, lease, errorMessage(error));
          continue;
        }
      }
      state.result = workerResult;
      if (workerResult.status === "blocked_context") {
        transition(runDir, state, "blocked", {
          phase: "complete",
          result: workerResult,
          error: { code: "context_missing", message: workerResult.missingContext.join("; ") },
        }, lease);
        continue;
      }
      await executeControllerVerification(contract, runDir, job.node, state, lease);
      if (!state.verification?.passed) {
        applyVerificationFailure(contract, job.node, state, runDir, running, lease);
        continue;
      }
      persistNodeCapsule(
        contract,
        job.node,
        state,
        runDir,
        lease,
        job.node.gate.enabled ? "await judge verdict" : "worker result accepted; node complete",
      );
      consumeManualHandoff(state);
      if (job.node.gate.enabled && monetaryBudgetReached(contract, job.node, state, states)) {
        transition(runDir, state, "blocked", {
          phase: "budget",
          error: { code: "cost_budget_exceeded", message: "monetary budget reached before scheduling the judge" },
        }, lease);
      } else if (job.node.gate.enabled && contract.usagePolicy !== false
        && campaignUsage(campaignPath, contract.usagePolicy).budgetInputTokens >= contract.usagePolicy.maxInputTokens) {
        transition(runDir, state, "blocked", {
          phase: "budget",
          error: { code: "budget_exceeded", message: `campaign input tokens reached the ${contract.usagePolicy.maxInputTokens} hard maximum before the judge` },
        }, lease);
      } else if (job.node.gate.enabled) startJudge(contract, job.node, state, runDir, running, workerResult, lease);
      else transition(runDir, state, "done", { phase: "complete", result: workerResult }, lease);
      continue;
    }
    applyJudgeResult(contract, job.node, state, envelope.result, runDir, lease, running);
  }
}

/**
 * Route one completed provider exhaustion without changing the gate revision.
 * The routing record is written before the pending phase becomes schedulable.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {"worker"|"judge"} role
 * @param {ProviderEnvelope} envelope
 * @param {string|null} currentRuntime
 * @param {LeaseHandle} lease
 */
function handleProviderExhaustion(contract, runDir, node, state, role, envelope, currentRuntime, lease) {
  const error = envelope.error ?? { code: "provider_exhausted", message: "provider exhausted" };
  if (NON_FAILOVER_CODES.has(error.code)) {
    transition(runDir, state, "exhausted", {
      phase: role,
      result: state.result,
      usage: state.usage,
      error,
    }, lease);
    return;
  }
  const current = currentRuntime ?? state.runtime?.id ?? routeRuntimeForState(contract, node, state, role).id;
  const routed = routeRuntime(contract, node, role, {
    status: "exhausted",
    errorCode: error.code,
    currentRuntime: current,
  });
  const revision = state.revisions ?? 0;
  const attempted = new Set((state.invocations ?? [])
    .filter((invocation) => invocation.phase === role && (invocation.revision === undefined || invocation.revision === revision))
    .map((invocation) => invocation.runtimeId)
    .filter(Boolean));
  const previous = state.routing?.currentOverride;
  const previousHop = previous?.role === role && (previous.revision ?? revision) === revision
    ? previous.hop ?? 0
    : Math.max(0, ...(state.routing?.history ?? [])
      .filter((entry) => entry.role === role && (entry.revision ?? revision) === revision)
      .map((entry) => entry.hop ?? 0));
  const hop = previousHop + 1;
  const nextRuntime = routed.id;
  const routeBlocked = routed.ruleIndex === undefined
    ? { code: error.code, message: error.message }
    : attempted.has(nextRuntime)
      ? { code: "provider_failover_cycle", message: `runtime ${nextRuntime} was already attempted in ${role} revision ${revision}` }
      : hop >= Object.keys(contract.runtimes).length
        ? { code: "provider_failover_hop_cap", message: `provider failover exceeded the ${Object.keys(contract.runtimes).length}-runtime hop cap` }
        : null;
  if (routeBlocked) {
    transition(runDir, state, "exhausted", {
      phase: role,
      result: state.result,
      usage: state.usage,
      error: routeBlocked,
    }, lease);
    return;
  }
  const now = new Date();
  const backoffSec = routed.backoffSec ?? 0;
  const backoffUntil = new Date(now.getTime() + backoffSec * 1_000).toISOString();
  const historyEntry = {
    at: now.toISOString(),
    role,
    runtime: current,
    nextRuntime,
    rule: routed.ruleIndex,
    ruleIndex: routed.ruleIndex,
    revision,
    hop,
    status: "exhausted",
    errorCode: error.code,
    backoffSec,
    backoffUntil,
    usage: envelope.usage,
    costUsd: envelope.costUsd,
  };
  const override = {
    at: now.toISOString(),
    role,
    runtime: nextRuntime,
    nextRuntime,
    rule: routed.ruleIndex,
    ruleIndex: routed.ruleIndex,
    revision,
    hop,
    reason: `${role} provider ${current} exhausted: ${error.message}`,
    backoffSec,
    backoffUntil,
    usage: envelope.usage,
    costUsd: envelope.costUsd,
  };
  const routing = {
    history: [...(state.routing?.history ?? []), historyEntry].slice(-64),
    currentOverride: override,
  };
  const runtime = runtimeSnapshot(contract, nextRuntime);
  transition(runDir, state, "pending", {
    phase: role,
    runtime,
    result: state.result,
    error: null,
    routing,
  }, lease);
  appendTransitionEvent(runDir, state, "pending", "pending", {
    role,
    status: "exhausted",
    currentRuntime: current,
    errorCode: error.code,
    override,
  }, lease);
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

/**
 * @param {"node"|"campaign"|"wallclock"} scope
 * @param {NodeSnapshot} state
 * @returns {{code: string, message: string}}
 */
function budgetStopError(scope, state) {
  const observed = state.usage?.inputTokens ?? 0;
  return scope === "wallclock"
    ? { code: "wall_clock_timeout", message: "worker exceeded its wall-clock deadline" }
    : scope === "node"
    ? { code: "token_budget_exceeded", message: `worker exceeded its per-node input-token cap (observed ${observed})` }
    : { code: "budget_exceeded", message: `run input-token budget exhausted (spent ${observed})` };
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {unknown} result
 * @param {string} runDir
 * @param {LeaseHandle} lease
 * @param {Map<string, Job>|null} [running]
 */
function applyJudgeResult(contract, node, state, result, runDir, lease, running = null) {
  /** @type {JudgeVerdict} */
  let verdict;
  try {
    verdict = parseJudge(String(result ?? ""));
  } catch (error) {
    transition(runDir, state, "failed", { phase: "judge", error: { code: "invalid_judge_output", message: errorMessage(error) } }, lease);
    return;
  }
  state.gate = verdict;
  const shouldFail = verdict.verdict === "fail" && verdict.maxSeverity !== "none"
    && (node.gate.failOn ?? ["critical"]).includes(verdict.maxSeverity);
  if (!shouldFail) {
    transition(runDir, state, "done", { phase: "complete", gate: verdict }, lease);
  } else if (state.revisions < (node.gate.maxRevisions ?? 1)) {
    process.stdout.write(`[gate] ${node.id} retry · ${verdict.maxSeverity} · ${verdict.summary}\n`);
    persistNodeCapsule(contract, node, state, runDir, lease, "address gate findings on a fresh worker attempt");
    resetPhaseRouting(state);
    state.revisions += 1;
    state.attempt += 1;
    if (running) startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lease);
    else transition(runDir, state, "pending", { phase: "worker", error: null }, lease);
  } else {
    transition(runDir, state, "exhausted", { phase: "judge", gate: verdict, error: { code: "revision_cap", message: verdict.summary } }, lease);
  }
}

/** @param {NodeSnapshot} state */
function resetPhaseRouting(state) {
  if (state.routing) state.routing.currentOverride = null;
  state.progress = null;
}

/**
 * @param {NodeSnapshot} state
 * @returns {JudgeVerdict}
 */
function verificationFailureVerdict(state) {
  const failedCommands = (state.verification?.commands ?? []).filter((command) => !command.passed);
  const evidence = failedCommands.length
    ? failedCommands.map((command) => `${command.argv.join(" ")}: ${command.attempts.map((attempt) => `exit=${attempt.exitCode ?? "-"}${attempt.timedOut ? " timeout" : ""}`).join(", ")}`).join("; ")
    : state.verification?.error ?? "verification controller failed to execute a command";
  return {
    verdict: "fail",
    maxSeverity: "critical",
    summary: "deterministic verification failed",
    findings: [{ severity: "critical", description: "deterministic verification failed", evidence: boundedUtf8(evidence, 4 * 1024) }],
  };
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {LeaseHandle} lease
 */
function applyVerificationFailure(contract, node, state, runDir, running, lease) {
  const verdict = verificationFailureVerdict(state);
  state.gate = verdict;
  if (node.gate.enabled && state.revisions < (node.gate.maxRevisions ?? 1)) {
    resetPhaseRouting(state);
    state.revisions += 1;
    state.attempt += 1;
    process.stdout.write(`[verification] ${node.id} retry · ${verdict.summary}\n`);
    startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lease);
    return;
  }
  transition(runDir, state, node.gate.enabled ? "exhausted" : "failed", {
    phase: "worker",
    gate: verdict,
    error: { code: "verification_failed", message: verdict.summary },
  }, lease);
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>|null} running
 * @param {LeaseHandle} lease
 * @param {string} message
 */
function applyInvalidWorkerResult(contract, node, state, runDir, running, lease, message) {
  const verdict = /** @type {GateResult} */ ({
    verdict: "fail",
    maxSeverity: "critical",
    summary: "worker result did not match the structured result protocol",
    findings: [{
      severity: "critical",
      description: "the entire final message must be exactly the required JSON object: no markdown fences, no prose before or after it. Return it as the only content of the final message.",
      evidence: boundedUtf8(message, 4 * 1024),
    }],
  });
  state.gate = verdict;
  if (node.gate.enabled && state.revisions < (node.gate.maxRevisions ?? 1)) {
    resetPhaseRouting(state);
    state.revisions += 1;
    state.attempt += 1;
    process.stdout.write(`[worker-result] ${node.id} retry · ${verdict.summary}\n`);
    if (running) startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lease);
    else transition(runDir, state, "pending", { phase: "worker", error: null }, lease);
    return;
  }
  transition(runDir, state, node.gate.enabled ? "exhausted" : "failed", {
    phase: "worker",
    gate: verdict,
    error: { code: "invalid_worker_result", message },
  }, lease);
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LeaseHandle} lease
 */
function blockDependents(contract, runDir, states, lease) {
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state) continue;
    if (state.status !== "pending") continue;
    const blockedBy = node.dependsOn.filter((id) => TERMINAL.has(states.get(id)?.status ?? "") && states.get(id)?.status !== "done");
    if (blockedBy.length) transition(runDir, state, "blocked", { phase: "dependency", blockedBy, error: { code: "dependency_failed", message: `blocked by ${blockedBy.join(", ")}` } }, lease);
  }
}

const USAGE_LEDGER_SCHEMA_VERSION = 1;
const USAGE_LEDGER_NAME = "usage-ledger.json";
const USAGE_LOCK_NAME = "usage-ledger.lock";

/** @param {ValidatedContract} contract @returns {string} */
function campaignUsagePath(contract) {
  return join(contract.cwd, ".runs", "campaigns", contract.campaignId);
}

/** @param {ValidatedContract["usagePolicy"]} policy @returns {CampaignUsage} */
function emptyCampaignTotals(policy) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    conservativeInputTokens: 0,
    budgetInputTokens: 0,
    workerBudgetInputTokens: 0,
    judgeBudgetInputTokens: 0,
    remainingWorkerAllowance: policy === false ? null : Math.max(0, policy.maxInputTokens - policy.judgeReserveInputTokens),
    judgeReserveInputTokens: policy === false ? null : policy.judgeReserveInputTokens,
    maxInputTokens: policy === false ? null : policy.maxInputTokens,
    phases: {},
  };
}

/** @param {string} campaignPath @param {ValidatedContract["usagePolicy"]} policy */
function ensureCampaignUsageLedger(campaignPath, policy) {
  if (policy === false) return;
  const path = join(campaignPath, USAGE_LEDGER_NAME);
  /** @type {UsageLedger|undefined} */
  let ledger;
  try { ledger = /** @type {UsageLedger} */ (readJson(path)); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (!ledger) {
    writeJsonAtomic(path, {
      schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
      epochs: { [policy.epoch]: { policy, invocations: {} } },
    });
    return;
  }
  const epoch = ledger.epochs?.[policy.epoch];
  if (epoch && stableJson(epoch.policy) !== stableJson(policy)) {
    throw new Error(`usage policy epoch ${policy.epoch} has different limits; choose a new explicit epoch`);
  }
  if (!epoch) {
    writeJsonAtomic(path, {
      ...ledger,
      schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
      epochs: { ...(ledger.epochs ?? {}), [policy.epoch]: { policy, invocations: {} } },
    });
  }
}

/**
 * @param {string} campaignPath
 * @param {ValidatedContract["usagePolicy"]} policy
 * @returns {ReturnType<typeof emptyCampaignTotals>}
 */
function campaignUsage(campaignPath, policy) {
  const totals = emptyCampaignTotals(policy);
  if (policy === false) return totals;
  /** @type {UsageLedger|undefined} */
  let ledger;
  try { ledger = /** @type {UsageLedger} */ (readJson(join(campaignPath, USAGE_LEDGER_NAME))); } catch (error) {
    if (errorCode(error) === "ENOENT") return totals;
    throw error;
  }
  const epoch = /** @type {UsageLedger} */ (ledger).epochs?.[policy.epoch];
  if (!epoch) return totals;
  if (stableJson(epoch.policy) !== stableJson(policy)) {
    throw new Error(`usage policy epoch ${policy.epoch} has different limits; choose a new explicit epoch`);
  }
  for (const invocation of Object.values(epoch.invocations ?? {})) {
    const usage = invocation.usage ?? {};
    const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
    const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
    const cacheReadInputTokens = typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : 0;
    const conservativeInputTokens = inputTokens + cacheReadInputTokens;
    const budgetInputTokens = inputTokens + cacheReadInputTokens * policy.cacheReadWeight;
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheReadInputTokens += cacheReadInputTokens;
    totals.conservativeInputTokens += conservativeInputTokens;
    totals.budgetInputTokens = roundBudgetTokens(totals.budgetInputTokens + budgetInputTokens);
    if (invocation.role === "worker") totals.workerBudgetInputTokens = roundBudgetTokens(totals.workerBudgetInputTokens + budgetInputTokens);
    if (invocation.role === "judge") totals.judgeBudgetInputTokens = roundBudgetTokens(totals.judgeBudgetInputTokens + budgetInputTokens);
    const key = `${invocation.role}:${invocation.planPhase}`;
    const phase = totals.phases[key] ?? { budgetInputTokens: 0, conservativeInputTokens: 0, invocations: 0 };
    phase.budgetInputTokens = roundBudgetTokens(phase.budgetInputTokens + budgetInputTokens);
    phase.conservativeInputTokens += conservativeInputTokens;
    phase.invocations += 1;
    totals.phases[key] = phase;
  }
  totals.remainingWorkerAllowance = Math.max(0, policy.maxInputTokens - policy.judgeReserveInputTokens - totals.budgetInputTokens);
  return totals;
}

/** @param {number} value */
function roundBudgetTokens(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * @param {string} campaignPath
 * @param {ValidatedContract["usagePolicy"]} policy
 * @param {Invocation|undefined} invocation
 * @returns {Promise<void>}
 */
async function recordCampaignUsage(campaignPath, policy, invocation) {
  if (policy === false || !invocation || !hasMeasuredUsage(invocation.usage)) return;
  ensureCampaignUsageLedger(campaignPath, policy);
  const lockPath = join(campaignPath, USAGE_LOCK_NAME);
  let locked = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      mkdirSync(lockPath);
      locked = true;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 300_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {}
      await delay(5);
    }
  }
  if (!locked) throw new Error("usage ledger lock was not released");
  try {
    const path = join(campaignPath, USAGE_LEDGER_NAME);
    const ledger = /** @type {UsageLedger} */ (readJson(path));
    const epoch = ledger.epochs?.[policy.epoch] ?? { policy, invocations: {} };
    if (stableJson(epoch.policy) !== stableJson(policy)) {
      throw new Error(`usage policy epoch ${policy.epoch} has different limits; choose a new explicit epoch`);
    }
    if (epoch.invocations?.[invocation.id]) return;
    writeJsonAtomic(path, {
      ...ledger,
      schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
      epochs: {
        ...(ledger.epochs ?? {}),
        [policy.epoch]: {
          policy,
          invocations: {
            ...(epoch.invocations ?? {}),
            [invocation.id]: {
              runId: invocation.runId,
              campaignId: invocation.campaignId,
              role: invocation.role,
              planPhase: invocation.planPhase,
              usage: invocation.usage,
              costUsd: invocation.costUsd ?? null,
            },
          },
        },
      },
    });
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** @param {Usage|undefined} usage @returns {boolean} */
function hasMeasuredUsage(usage) {
  return Boolean(usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens]
    .some((value) => typeof value === "number" && Number.isFinite(value)));
}

/**
 * Codex can omit terminal usage when its native rollout budget stops a turn.
 * Charge the declared ceiling so missing telemetry cannot create a free retry.
 *
 * @param {Usage|undefined} usage
 * @param {string|null|undefined} message
 * @param {ValidatedContract["usagePolicy"]} policy
 * @returns {Usage|undefined}
 */
function usageWithBudgetFallback(usage, message, policy) {
  if (hasMeasuredUsage(usage) || policy === false || !/shared rollout token budget exhausted/iu.test(String(message ?? ""))) return usage;
  return { inputTokens: policy.maxInvocationTokens, outputTokens: null, cacheReadInputTokens: null };
}

/** @param {string} campaignPath @param {ValidatedContract["usagePolicy"]} policy @param {Map<string, NodeSnapshot>} states @returns {Promise<void>} */
async function synchronizeCampaignUsage(campaignPath, policy, states) {
  if (policy === false) return;
  for (const state of states.values()) {
    for (const invocation of state.invocations ?? []) await recordCampaignUsage(campaignPath, policy, invocation);
  }
}

/**
 * Recovery can discover usage after the initial campaign synchronization. Attach
 * it to the authoritative invocation first, then record that invocation in the
 * epoch ledger. The invocation id makes repeated resumes idempotent.
 *
 * @param {string} campaignPath
 * @param {ValidatedContract["usagePolicy"]} policy
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {RecoveryOutcome|null|undefined} recovery
 * @param {LeaseHandle} lease
 * @returns {Promise<void>}
 */
async function persistRecoveryUsage(campaignPath, policy, runDir, state, recovery, lease) {
  if (!recovery?.invocationId) return;
  const current = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
  if (!current) return;
  const recoveredUsage = usageWithBudgetFallback(recovery.usage, recovery.reason, policy);
  const usage = hasMeasuredUsage(current.usage) ? current.usage : recoveredUsage;
  const costUsd = typeof current.costUsd === "number" ? current.costUsd : recovery.costUsd;
  const changed = stableJson(current.usage) !== stableJson(usage)
    || current.costUsd !== (costUsd ?? null);
  if (changed) {
    state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === current.id
      ? { ...invocation, usage, costUsd: costUsd ?? null }
      : invocation);
    state.usage = invocationUsage(state);
    writeNode(runDir, state, lease);
  }
  const updated = state.invocations?.find((invocation) => invocation.id === current.id);
  await recordCampaignUsage(campaignPath, policy, updated);
}

/** @param {NodeSnapshot} state @returns {Usage} */
function invocationUsage(state) {
  return (state.invocations ?? []).reduce(
    (total, invocation) => addUsage(total, invocation.usage),
    /** @type {Usage} */ ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }),
  );
}

/** @param {NodeSnapshot} state @returns {number|undefined} */
function invocationCost(state) {
  const costs = /** @type {number[]} */ ((state.invocations ?? [])
    .map((invocation) => invocation.costUsd)
    .filter((cost) => typeof cost === "number" && Number.isFinite(cost)));
  return costs.length ? costs.reduce((total, cost) => total + cost, 0) : undefined;
}

/** @param {Usage|undefined|null} usage @returns {number} */
function conservativeInput(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LeaseHandle} lease
 * @param {string} campaignPath
 */
function enforceLedgerBudget(contract, runDir, states, lease, campaignPath) {
  const campaign = campaignUsage(campaignPath, contract.usagePolicy);
  const policy = contract.usagePolicy;
  if (policy !== false && campaign.budgetInputTokens >= policy.maxInputTokens) {
    for (const state of states.values()) {
      if (state.status === "pending") transition(runDir, state, "blocked", { phase: "budget", error: { code: "budget_exceeded", message: `campaign weighted input tokens (${campaign.budgetInputTokens}) reached the ${policy.maxInputTokens} hard maximum` } }, lease);
    }
  }
  if (policy !== false && campaign.budgetInputTokens >= policy.maxInputTokens - policy.judgeReserveInputTokens) {
    for (const state of states.values()) {
      if (state.status !== "pending" || state.phase === "judge") continue;
      transition(runDir, state, "blocked", { phase: "budget", error: { code: "budget_exceeded", message: `worker allowance exhausted at ${policy.maxInputTokens - policy.judgeReserveInputTokens}; ${policy.judgeReserveInputTokens} input tokens remain reserved for judges` } }, lease);
    }
  }
  for (const node of contract.nodes) {
    if (node.maxInputTokens === undefined) continue;
    const state = states.get(node.id);
    const nodeSpent = state ? conservativeInput(state.usage) : 0;
    if (state?.status === "pending" && nodeSpent >= node.maxInputTokens) {
      transition(runDir, state, "blocked", { phase: "budget", error: { code: "budget_exceeded", message: `node input tokens (${nodeSpent}) reached the ${node.maxInputTokens} budget` } }, lease);
    }
  }
}

/**
 * Block pending work before scheduling when either monetary budget is spent.
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LeaseHandle} lease
 * @param {string} campaignPath
 */
function enforceCostBudget(contract, runDir, states, lease, campaignPath) {
  const spent = campaignCostSpent(contract, states, campaignPath);
  if (contract.maxCostUsd !== undefined && spent >= contract.maxCostUsd) {
    for (const state of states.values()) {
      if (state.status === "pending") transition(runDir, state, "blocked", {
        phase: "budget",
        error: { code: "cost_budget_exceeded", message: `total cost (${formatCost(spent)}) reached the ${formatCost(contract.maxCostUsd)} budget` },
      }, lease);
    }
  }
  for (const node of contract.nodes) {
    if (node.maxCostUsd === undefined) continue;
    const state = states.get(node.id);
    if (state?.status !== "pending" || (state.costUsd ?? 0) < node.maxCostUsd) continue;
    transition(runDir, state, "blocked", {
      phase: "budget",
      error: { code: "cost_budget_exceeded", message: `node cost (${formatCost(state.costUsd)}) reached the ${formatCost(node.maxCostUsd)} budget` },
    }, lease);
  }
}

/** @param {ValidatedContract} contract @param {ValidatedNode} node */
function hasCostBudget(contract, node) {
  return contract.maxCostUsd !== undefined || node.maxCostUsd !== undefined;
}

/** @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {Map<string, NodeSnapshot>} states */
function monetaryBudgetReached(contract, node, state, states) {
  if (node.maxCostUsd !== undefined && (state.costUsd ?? 0) >= node.maxCostUsd) return true;
  if (contract.maxCostUsd === undefined) return false;
  const spent = campaignCostSpent(contract, states, campaignUsagePath(contract));
  return spent >= contract.maxCostUsd;
}

/**
 * Return the smallest positive remaining monetary allowance for one invocation.
 * The usage ledger covers completed invocations across runs in the campaign;
 * current-state costs not yet ledgered are merged by invocation ID.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Map<string, NodeSnapshot>} [states]
 * @returns {number|null}
 */
function remainingMonetaryAllowance(contract, node, state, states = new Map([[state.id, state]])) {
  const allowances = [];
  if (node.maxCostUsd !== undefined) {
    const remaining = roundCostAllowance(node.maxCostUsd - (state.costUsd ?? 0));
    if (remaining > 0) allowances.push(remaining);
  }
  if (contract.maxCostUsd !== undefined) {
    const remaining = roundCostAllowance(contract.maxCostUsd - campaignCostSpent(contract, states, campaignUsagePath(contract)));
    if (remaining > 0) allowances.push(remaining);
  }
  return allowances.length ? Math.min(...allowances) : null;
}

/** @param {number} value @returns {number} */
function roundCostAllowance(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @returns {number}
 */
function campaignCostSpent(contract, states, campaignPath) {
  const seen = new Set();
  let spent = 0;
  if (contract.usagePolicy !== false) {
    try {
      const ledger = /** @type {UsageLedger} */ (readJson(join(campaignPath, USAGE_LEDGER_NAME)));
      const epoch = ledger.epochs?.[contract.usagePolicy.epoch];
      for (const [id, invocation] of Object.entries(epoch?.invocations ?? {})) {
        if (typeof invocation.costUsd !== "number" || !Number.isFinite(invocation.costUsd)) continue;
        spent += invocation.costUsd;
        seen.add(id);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  /** @param {Invocation} invocation */
  const addInvocation = (invocation) => {
    if (seen.has(invocation.id) || invocation.status === "active") return;
    if (typeof invocation.costUsd !== "number" || !Number.isFinite(invocation.costUsd)) return;
    spent += invocation.costUsd;
    seen.add(invocation.id);
  };
  for (const state of states.values()) for (const invocation of state.invocations ?? []) addInvocation(invocation);

  // A false usage policy has no token ledger, but monetary campaign ceilings
  // still span completed invocations from earlier runs in the same campaign.
  const runsDir = join(contract.cwd, ".runs");
  try {
    for (const name of readdirSync(runsDir)) {
      const otherRunDir = join(runsDir, name);
      if (name === "campaigns" || !existsSync(join(otherRunDir, "run.json"))) continue;
      let metadata;
      try {
        metadata = validateRunMetadata(readJson(join(otherRunDir, "run.json")), { requireSourceIdentity: true });
      } catch {
        continue;
      }
      if (metadata.sourceIdentity.campaignId !== contract.campaignId) continue;
      const nodeDir = join(otherRunDir, "nodes");
      let otherContract;
      try {
        const otherContractPath = join(otherRunDir, "contract.json");
        otherContract = validateContract(readJson(otherContractPath), otherContractPath);
      } catch {
        continue;
      }
      for (const node of otherContract.nodes) {
        let snapshot;
        try {
          snapshot = validateNodeSnapshot(readJson(join(nodeDir, `${node.id}.json`)), node);
        } catch {
          continue;
        }
        for (const invocation of snapshot.invocations ?? []) addInvocation(invocation);
      }
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return spent;
}
/**
 * Live token-budget enforcement. Persisted `state.usage` lags behind reality
 * until an invocation closes, so active jobs are metered by scanning their
 * still-growing transcripts (bounded tail) every tick. Two ceilings:
 *
 * - per-node `maxInputTokens`: terminate that worker the moment its observed
 *   input tokens pass the cap (finalize labels the node exhausted);
 * - contract `maxInputTokens`: persisted spend plus every active job's
 *   observed spend — once reached, ALL active workers are terminated and
 *   pending nodes are blocked. A budget that cannot stop a running worker is
 *   not a budget.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {Map<string, Job>} running
 * @param {LeaseHandle} lease
 */
function enforceTokenBudget(contract, runDir, states, running, lease) {
  const cacheReadWeight = contract.usagePolicy === false ? 1 : (contract.usagePolicy?.cacheReadWeight ?? 1);
  const observed = new Map();
  let liveSpent = 0;
  for (const [nodeId, job] of running) {
    if (job.closed) continue;
    const seen = observeLiveInputTokens(job, cacheReadWeight);
    observed.set(nodeId, seen);
    liveSpent += seen;
    if (job.node.maxInputTokens !== undefined && seen > job.node.maxInputTokens && !job.budgetStop) {
      job.budgetStop = "node";
      void terminateProcess(job).catch(() => {});
      process.stdout.write(`[node] ${nodeId} input-token cap reached (${seen} > ${job.node.maxInputTokens}) · terminating\n`);
    }
  }
  // Persisted usage is the normalized ledger shape (inputTokens excludes
  // cache reads); weight the cached portion exactly like the live meter so
  // the two sides are comparable.
  const persisted = [...states.values()].reduce((total, state) => {
    const usage = state.usage ?? emptyUsage();
    return total + (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) * cacheReadWeight;
  }, 0);
  const spent = Math.round((persisted + liveSpent) * 1000) / 1000;
  if (spent < contract.maxInputTokens) return;
  for (const job of running.values()) {
    if (!job.budgetStop && !job.closed) {
      job.budgetStop = "campaign";
      void terminateProcess(job).catch(() => {});
    }
  }
  for (const state of states.values()) {
    if (state.status === "pending") transition(runDir, state, "blocked", { phase: "budget", error: { code: "budget_exceeded", message: `total input tokens (${spent}) reached the ${contract.maxInputTokens} budget` } }, lease);
  }
  return spent;
}

/**
 * Meter one active invocation from its transcript tail. A monotonic
 * high-water mark guards against providers whose counters reset or partial
 * reads that split a line.
 *
 * @param {Job} job
 * @param {number} [cacheReadWeight] cached-to-uncached rate ratio
 * @returns {number}
 */
function observeLiveInputTokens(job, cacheReadWeight = 1) {
  try {
    const seen = liveInputTokens(job.runtime.driver, readBoundedTail(job.paths.stdout), cacheReadWeight);
    job.liveInputTokens = Math.max(job.liveInputTokens ?? 0, seen);
  } catch {
    // An unreadable transcript meters as zero this tick; wall-clock and stall
    // detection remain the backstop.
  }
  return job.liveInputTokens ?? 0;
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {import("./contract.mjs").NodeStatus} status
 * @param {Record<string, unknown>} [patch]
 * @param {LeaseHandle|null} [lease]
 */
function transition(runDir, state, status, patch = {}, lease = null) {
  lease?.assert();
  const from = state.status;
  Object.assign(state, patch, { status, updatedAt: new Date().toISOString() });
  writeNode(runDir, state, lease);
  const invocation = state.invocations?.at(-1);
  if (invocation && hasOperationSettlement(runDir, invocation.id)) {
    settleInvocation(runDir, invocation, { nextState: operationNextState(state) });
  }
  appendTransitionEvent(runDir, state, from, status, {}, lease);
  if (TERMINAL.has(status)) {
    const note = state.gate?.summary ?? resultSummary(state.result) ?? state.error?.message;
    process.stdout.write(`[node] ${state.id} ${status}${note ? ` · ${note}` : ""}\n`);
  }
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
 * @param {LeaseHandle|null} [lease]
 */
function appendTransitionEvent(runDir, state, from, to, details = {}, lease = null) {
  lease?.assert();
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
 * @param {LeaseHandle} lease
 */
function recordExecutionOverride(runDir, state, override, lease) {
  const entry = { ...override, at: override.at ?? new Date().toISOString() };
  state.executionOverrides = [...(state.executionOverrides ?? []), entry];
  writeNode(runDir, state, lease);
  appendTransitionEvent(runDir, state, state.status, state.status, { override: entry, recovery: entry.decision }, lease);
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LeaseHandle|null} [lease]
 */
function writeNode(runDir, state, lease = null) {
  lease?.assert();
  validateNodeSnapshot(state);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > 128 * 1024) throw new Error("node snapshot exceeds 131072 bytes");
  writeTextAtomic(join(runDir, "nodes", `${state.id}.json`), `${serialized}\n`);
}

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @param {LeaseHandle|null} [lease]
 */
function render(runDir, contract, states, lease = null) {
  lease?.assert();
  writeTextAtomic(join(runDir, "STATUS.md"), renderFinalStatus(runDir, contract, states));
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

const NON_FAILOVER_CODES = new Set([
  "revision_cap", "verification_failed", "budget_exceeded", "wall_clock_timeout",
  "progress_stalled", "cancellation", "unexpected_write",
]);

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
function renderFinalStatus(runDir, contract, states) {
  const nodes = /** @type {NodeSnapshot[]} */ (contract.nodes.map((node) => states.get(node.id)).filter((node) => node !== undefined));
  const campaign = campaignUsage(campaignUsagePath(contract), contract.usagePolicy);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 28, 7, 24];
  /** @param {unknown[]} cells */
  const row = (cells) => cells.map((cell, index) => fitStatus(String(cell ?? ""), widths[index])).join(" ");
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    contract.goal,
    "",
    `${nodes.length} nodes · ${summary} · campaign ${compactTokens(campaign.budgetInputTokens)} weighted input · workers ${campaign.remainingWorkerAllowance === null ? "unlimited" : compactTokens(campaign.remainingWorkerAllowance)} · judge reserve ${campaign.judgeReserveInputTokens === null ? "-" : compactTokens(campaign.judgeReserveInputTokens)}`,
    "",
    "```",
    row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]),
    row(widths.map((width) => "-".repeat(width))),
  ];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const detail = node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase ?? "-";
    const note = `${detail} · phase ${planNode?.phase ?? "-"} · ${node.invocations?.at(-1)?.continuationMode ?? "fresh"}`;
    lines.push(row([STATUS_MARK[node.status] ?? "[?]", node.id, node.status, runtime, node.attempt ?? 0, note]));
  }
  lines.push("```", "", "## Needs you", "");
  const attention = nodes.filter((node) => !["pending", "running", "done"].includes(node.status));
  if (!attention.length) lines.push("Nothing needs you right now.");
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
  const campaign = campaignUsage(campaignUsagePath(contract), contract.usagePolicy);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 7, 7, 28, 10, 10, 10, 12, 36];
  /** @param {unknown[]} cells */
  const row = (cells) => cells.map((cell, index) => fitStatus(String(cell ?? ""), widths[index])).join(" ");
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let totalCostUsd = null;
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    `${nodes.length} nodes · ${summary} · campaign ${compactTokens(campaign.budgetInputTokens)} weighted input · workers ${campaign.remainingWorkerAllowance === null ? "unlimited" : compactTokens(campaign.remainingWorkerAllowance)} · judge reserve ${campaign.judgeReserveInputTokens === null ? "-" : compactTokens(campaign.judgeReserveInputTokens)}`,
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
    const note = `${detail} · phase ${planNode?.phase ?? "-"} · ${node.invocations?.at(-1)?.continuationMode ?? "fresh"}`;
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
 * @param {string} runDir
 * @param {string} nodeId
 * @param {string} phase
 * @param {number} attempt
 * @returns {import("./supervisor.mjs").PathSet}
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
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Record<string, unknown>|null} settlement
 * @returns {string|null}
 */
function persistedWorkerResult(state, invocation, settlement) {
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
 * @param {LeaseHandle} lease
 * @returns {Promise<RecoveryOutcome|null>}
 */
async function recoverOrphan(runDir, contract, node, state, lease) {
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
      ? persistedWorkerResult(state, invocation, settlement)
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
      ? persistedWorkerResult(state, invocation, settlement)
      : persistedJudgeResult(state, invocation, settlement);
    if (persisted) {
      if (invocation.phase === "judge") {
        return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "judge", result: persisted, invocationId: invocation.id });
      }
      return /** @type {RecoveryOutcome} */ ({ kind: "adopted", phase: "worker", result: persisted, invocationId: invocation.id });
    }
    return restartRecovery(invocation, terminal, `invocation ${invocation.id} has no reliable close time`);
  }
  /** @type {WorkspaceSnapshot|null} */
  let baseline = null;
  if (invocation.phase === "worker" && invocation.snapshotPath) {
    try { baseline = /** @type {WorkspaceSnapshot} */ (readJson(invocation.snapshotPath)); } catch {}
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
      try {
        const progressStalled = await checkRecoveredProgress({ contract, node, state, invocation, baseline });
        if (state.progress) writeNode(runDir, state, lease);
        if (progressStalled) {
          await terminateInvocation(invocation);
          const finalResult = invocationResult(invocation, runtime);
          return {
            kind: "stalled",
            phase: "worker",
            invocationId: invocation.id,
            usage: finalResult?.usage ?? invocation.usage,
            costUsd: finalResult?.costUsd ?? invocation.costUsd,
            error: { code: "progress_stalled", message: `allowed workspace scope made no progress for ${state.progress?.dryHeartbeatCount ?? 0} heartbeats` },
            reason: "resumed worker made no progress",
          };
        }
      } catch (error) {
        await terminateInvocation(invocation);
        const result = invocationResult(invocation, runtime);
        return {
          kind: "stalled",
          phase: invocation.phase === "judge" ? "judge" : "worker",
          invocationId: invocation.id,
          usage: result?.usage ?? invocation.usage,
          costUsd: result?.costUsd ?? invocation.costUsd,
          error: { code: /** @type {string} */ (errorCode(error) ?? "progress_snapshot_invalid"), message: errorMessage(error) },
          reason: "resumed worker progress check failed",
        };
      }
      await delay(Math.min(contract.pollIntervalMs, 250));
    }
    const expired = Date.now() >= deadline;
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    if (expired) return restartRecovery(invocation, null, `${invocation.phase} invocation ${invocation.id} exceeded its wall-clock budget`);
    if (invocation.closedAt === null) {
      const persisted = invocation.phase === "worker"
        ? persistedWorkerResult(state, invocation, settlement)
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
    const persisted = persistedWorkerResult(state, invocation, settlement);
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
 * @param {NodeSnapshot} state
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @returns {WorkerResult|null}
 */
function recoverWorkerResult(state, contract, node) {
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
 * @param {SourceIdentity|undefined} expected
 * @param {SourceIdentity|undefined} actual
 */
function assertSourceUnchanged(expected, actual) {
  const fields = ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "driverVersions"];
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
    if (stableJson(expectedRecord?.[field] ?? null) !== stableJson(actualRecord?.[field] ?? null)) {
      throw new Error(`source drift detected in ${field}; resume refused`);
    }
  }
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
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  writeJsonAtomic(join(runDir, "cancel.request.json"), { requestedAt: new Date().toISOString(), pid: process.pid });
  const lease = readLease(runDir);
  const currentLease = lease && !lease.invalid ? /** @type {LeaseRecord} */ (lease) : null;
  if (currentLease && currentLease.pid === process.pid) {
    throw new Error("cancel cannot take over a controller lease held by this process");
  }
  if (currentLease) {
    const controller = { pid: currentLease.pid, processStartToken: currentLease.processStartToken };
    if (invocationAlive(controller)) {
      signalController(currentLease, "SIGTERM");
      if (!await waitForProcessDeath(controller, 2_000)) {
        signalController(currentLease, "SIGKILL");
        if (!await waitForProcessDeath(controller, 2_000)) throw new Error("cancel could not confirm controller termination");
      }
    }
    if (leaseHealthy(currentLease)) await waitForLeaseExpiry(runDir, 30_000);
  }
  const controllerLease = await acquireStaleControllerLease(runDir);
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
      if (state.verification?.attempts?.length) writeNode(runDir, state, controllerLease);
      if (failures.length) continue;
      const closedAt = new Date().toISOString();
      const invocations = (state.invocations ?? []).map((invocation) => invocation.status === "active"
        ? { ...invocation, status: "terminated", closedAt, updatedAt: closedAt }
        : invocation);
      if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled", invocations }, controllerLease);
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
    controllerLease.release();
  }
}

/**
 * @param {string} runDir
 * @returns {Promise<LeaseHandle>}
 */
async function acquireStaleControllerLease(runDir) {
  for (;;) {
    try {
      return acquireControllerLease(runDir, { contractVersion: INTENT_FACTORY_VERSION, processStartToken: processStartToken(process.pid) });
    } catch (error) {
      const record = /** @type {Record<string, unknown>} */ (error);
      const lease = /** @type {LeaseRecord|undefined} */ (record.lease);
      if (!lease || !leaseHealthy(lease)) throw error;
      await delay(Math.min(100, Math.max(10, Date.parse(lease.expiresAt) - Date.now())));
    }
  }
}

/**
 * @param {string} runDir
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForLeaseExpiry(runDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = readLease(runDir);
    if (!lease || lease.invalid || !leaseHealthy(lease)) return;
    await delay(Math.min(100, Math.max(10, Date.parse(lease.expiresAt) - Date.now())));
  }
  throw new Error("controller lease did not become stale during cancellation");
}

/**
 * @param {LeaseRecord} lease
 * @param {NodeJS.Signals} signal
 */
function signalController(lease, signal) {
  if (!invocationAlive({ pid: lease.pid, processStartToken: lease.processStartToken })) return;
  try {
    process.kill(lease.pid, signal);
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
  const budgeted = contract.maxCostUsd !== undefined || contract.nodes.some((node) => node.maxCostUsd !== undefined);
  if (budgeted) {
    for (const entry of runtimes.values()) entry.requiredCapabilitySets.push({ cost: true });
  }
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
 * Collect initial worker/judge runtimes and runtime targets reachable through
 * currentRuntime failover rules, preserving every capability requirement.
 * @param {ValidatedContract} contract
 * @returns {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>}
 */
function reachableRuntimes(contract) {
  /** @type {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>} */
  const runtimes = new Map();
  const queue = [];
  for (const node of contract.nodes) {
    for (const role of /** @type {("worker"|"judge")[]} */ (["worker", ...(node.gate.enabled ? ["judge"] : [])])) {
      const runtime = routeRuntime(contract, node, role);
      const required = role === "judge"
        ? [runtime.requiredCapabilities, node.gate.requiredCapabilities, { structuredOutput: true }]
        : [runtime.requiredCapabilities, node.requiredCapabilities];
      addRuntimeRequirement(runtimes, runtime, required.filter((item) => item !== undefined));
      queue.push({ node, role, runtimeId: runtime.id, requiredCapabilitySets: required.filter((item) => item !== undefined) });
    }
  }
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const visitKey = `${current.node.id}:${current.role}:${current.runtimeId}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    for (const rule of contract.runtimeRules) {
      const match = rule.match;
      if (match.currentRuntime !== undefined && match.currentRuntime !== current.runtimeId) continue;
      if (match.role !== undefined && match.role !== current.role) continue;
      if (match.id !== undefined && match.id !== current.node.id) continue;
      if (match.type !== undefined && match.type !== current.node.type) continue;
      const declaredRuntime = current.role === "judge" ? current.node.gate.runtime : current.node.runtime;
      if (match.runtime !== undefined && match.runtime !== declaredRuntime) continue;
      const target = contract.runtimes[rule.runtime];
      const runtime = { id: rule.runtime, ...target, capabilities: driverCapabilities(target) };
      addRuntimeRequirement(runtimes, runtime, current.requiredCapabilitySets);
      queue.push({ ...current, runtimeId: rule.runtime });
    }
  }
  return runtimes;
}

/** @param {ValidatedContract} contract */
function assertCostCapability(contract) {
  if (contract.maxCostUsd === undefined && !contract.nodes.some((node) => node.maxCostUsd !== undefined)) return;
  const missing = [...reachableRuntimes(contract).values()]
    .filter(({ runtime }) => runtime.capabilities.cost !== true)
    .map(({ runtime }) => `${runtime.id} (${runtime.driver}/${runtime.model})`);
  if (missing.length) throw new Error(`monetary budget requires cost capability on every reachable runtime; missing: ${missing.join(", ")}`);
}

/**
 * @param {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>} runtimes
 * @param {RuntimeSnapshot} runtime
 * @param {import("./drivers/index.mjs").CapabilityRequirements[]} requiredCapabilitySets
 */
function addRuntimeRequirement(runtimes, runtime, requiredCapabilitySets) {
  const incoming = requiredCapabilitySets.filter((requirements) => requirements && Object.keys(requirements).length);
  const current = runtimes.get(runtime.id);
  if (!current) runtimes.set(runtime.id, { runtime, requiredCapabilitySets: incoming });
  else runtimes.set(runtime.id, { runtime: current.runtime, requiredCapabilitySets: [...current.requiredCapabilitySets, ...incoming] });
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
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return warnings;
}

/**
 * @param {string} runDir
 * @param {number} intervalSec
 * @returns {Promise<void>}
 */
export async function superviseRun(runDir, intervalSec) {
  if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  const campaign = resolveCampaign(join(contract.cwd, ".runs"), contract.campaignId);
  const supervisorLease = acquireSupervisorLease(runDir, {
    contractVersion: INTENT_FACTORY_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  try {
    validateRunMetadata(readJson(join(runDir, "run.json")), { requireSourceIdentity: true });
    const bootstrapNonce = bootstrapNonceForProcess();
    const detachedBootstrap = hasDetachedBootstrapNonce();
    writeJsonAtomic(bootstrapPath(runDir), {
      status: "ready",
      nonce: bootstrapNonce,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      runDir,
      holderId: supervisorLease.holderId,
      generation: supervisorLease.generation,
      at: new Date().toISOString(),
    });
    writeJsonAtomic(bootstrapAttemptPath(runDir, bootstrapNonce), readJson(bootstrapPath(runDir)));
    cleanupBootstrapAttempts(runDir, bootstrapNonce);
    if (detachedBootstrap) await waitForBootstrapAcknowledgement(runDir, {
        nonce: bootstrapNonce,
        pid: process.pid,
        processStartToken: processStartToken(process.pid),
        holderId: supervisorLease.holderId,
        generation: supervisorLease.generation,
      });
    supervisorLease.assert();
    supervisorLease.startHeartbeat();
    for (;;) {
      supervisorLease.assert();
      const nodes = readRunNodes(runDir, contract);
      await drainNotificationsSafely(campaign.path);
      if (nodes.length && nodes.every((node) => TERMINAL.has(node.status))) {
        const failed = nodes.filter((node) => node.status !== "done");
        await notifyCampaign(
          campaign.path,
          "run.terminal",
          `${basename(runDir)}:${failed.length ? "attention" : "done"}`,
          `${basename(runDir)} ${failed.length ? `needs attention (${failed.length}/${nodes.length} non-done)` : `completed (${nodes.length}/${nodes.length} done)`}`,
          { runId: basename(runDir), done: nodes.length - failed.length, total: nodes.length, needsAttention: failed.length },
        );
        process.stdout.write(`[supervise] ${basename(runDir)} finished · ${nodes.filter((node) => node.status === "done").length}/${nodes.length} done\n`);
        return;
      }
      const lease = readLease(runDir);
      if (!leaseHealthy(lease)) {
        /** @type {DetachedChild|null} */
        let child = null;
        /** @type {number|null} */
        let pid = null;
        try {
          child = detachSelf("resume", runDir);
          pid = child.pid ?? null;
          if (pid === null) throw new Error("detached child has no pid");
          process.stdout.write(`[supervise] controller lease expired · resumed · pid ${pid}\n`);
          await waitForBootstrap(runDir, pid, child);
        } catch (error) {
          const message = errorMessage(error);
          const code = message.includes("source drift") ? "source_drift" : "resume_failed";
          // A stale-lease resume can lose to a concurrently healthy controller
          // that renewed or took over while the detached child bootstrapped.
          // That contention is benign: re-read the lease and keep supervising.
          // Source drift, malformed state, and an absent or unhealthy controller
          // still need attention.
          const leaseAfter = readLease(runDir);
          if (
            code === "resume_failed" &&
            leaseAfter !== null &&
            !leaseAfter.invalid &&
            leaseHealthy(leaseAfter) &&
            leaseAfter.pid !== pid
          ) {
            process.stdout.write(`[supervise] controller lease contended · healthy controller pid ${leaseAfter.pid} owns the run · continuing\n`);
            continue;
          }
          writeJsonAtomic(join(runDir, "supervisor-attention.json"), {
            schemaVersion: PROTOCOL_SCHEMA_VERSION,
            at: new Date().toISOString(),
            code,
            message,
          });
          await notifyCampaign(
            campaign.path,
            "run.attention",
            `${basename(runDir)}:${code}:${message}`,
            `${basename(runDir)} needs attention: ${message}`,
            { runId: basename(runDir), code },
          );
          process.stderr.write(`[supervise] ${basename(runDir)} needs attention: ${message}\n`);
          return;
        }
      }
      await delay(intervalSec * 1_000);
    }
  } finally {
    supervisorLease.stopHeartbeat();
    supervisorLease.release();
  }
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
 * @param {"controller"|"supervisor"} [leaseKind]
 * @param {number} [timeoutMs]
 * @returns {Promise<BootstrapRecord>}
 */
async function waitForBootstrap(runDir, pid, child = null, leaseKind = "controller", timeoutMs = 30_000) {
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
        const lease = leaseKind === "supervisor" ? readSupervisorLease(runDir) : readLease(runDir);
        const currentOwner = lease !== null && !lease.invalid && leaseHealthy(lease)
          && lease.pid === pid
          && sameProcessStartToken(lease.processStartToken, expectedProcessStartToken)
          && lease.holderId === bootstrap.holderId
          && lease.generation === bootstrap.generation;
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
    holderId: bootstrap.holderId ?? null,
    generation: bootstrap.generation ?? null,
    at: new Date().toISOString(),
  });
}

/**
 * @param {string} runDir
 * @param {{nonce: string, pid: number, processStartToken: string|null, holderId: string, generation: number}} expected
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
          sameProcessStartToken(acknowledgement.processStartToken, expected.processStartToken) &&
          acknowledgement.holderId === expected.holderId &&
          acknowledgement.generation === expected.generation
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
 * @param {BootstrapRecord} record
 * @param {number} pid
 * @param {string} nonce
 * @param {string|null} expectedProcessStartToken
 * @returns {boolean}
 */
function bootstrapMatchesChild(record, pid, nonce, expectedProcessStartToken) {
  return record?.pid === pid && record?.nonce === nonce && validBootstrapNonce(record.nonce) && sameProcessStartToken(record.processStartToken, expectedProcessStartToken);
}

/**
 * @param {BootstrapRecord} record
 * @param {number} pid
 * @param {string} nonce
 * @param {string|null} expectedProcessStartToken
 * @returns {boolean}
 */
function bootstrapFailureMatchesChild(record, pid, nonce, expectedProcessStartToken) {
  return record?.pid === pid && record?.nonce === nonce && validBootstrapNonce(record.nonce) && (
    expectedProcessStartToken === null
      ? record.processStartToken === null || typeof record.processStartToken === "string"
      : record.processStartToken === expectedProcessStartToken
  );
}

/**
 * @param {string|null|undefined} actual
 * @param {string|null|undefined} expected
 * @returns {boolean}
 */
function sameProcessStartToken(actual, expected) {
  return actual === expected;
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
    if (["resume", "supervise", "cancel"].includes(command)) {
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
    const controllerLease = readLease(runDir);
    const supervisorLease = readSupervisorLease(runDir);
    const currentOwnerActive = current.status === "ready" && current.pid !== process.pid && (
      leaseOwnedBy(controllerLease, current.pid, current.processStartToken) ||
      leaseOwnedBy(supervisorLease, current.pid, current.processStartToken)
    );
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
 * @param {import("./store.mjs").ReadLeaseResult} lease
 * @param {number|undefined} pid
 * @param {string|null|undefined} processStartToken
 * @returns {boolean}
 */
function leaseOwnedBy(lease, pid, processStartToken) {
  return lease !== null && !lease.invalid && lease.pid === pid && leaseHealthy(lease)
    && sameProcessStartToken(lease.processStartToken, processStartToken);
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validBootstrapNonce(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{16,64}$/u.test(value);
}

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

export { buildCapsule, detectStalls, runProcessAlive, startProcess };

/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const COMMAND_OPTIONS = {
  run: { detach: { type: "boolean" } },
  resume: { detach: { type: "boolean" } },
  supervise: { detach: { type: "boolean" }, interval: { type: "string" } },
  cancel: {},
  preflight: { static: { type: "boolean" } },
  validate: {},
  status: { json: { type: "boolean" } },
  report: { json: { type: "boolean" } },
  findings: {},
  handoff: { node: { type: "string" }, runtime: { type: "string" }, reason: { type: "string" } },
  doctor: { cwd: { type: "string" }, json: { type: "boolean" } },
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
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv[0] === "campaign") { await campaignCli(argv.slice(1)); return; }
  const parsed = parseCli(argv);
  if (!parsed) { usage(); return; }
  const { command, values } = parsed;
  const target = parsed.target;
  if (command === "doctor") {
    const ok = await doctorCommand(target, {
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
      json: values.json === true,
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
    if (values.detach === true) {
      const runDir = resolve(target);
      if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
      const child = detachSelf("resume", target);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[resume] detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    const result = await resumeRun(target);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "supervise") {
    const intervalSec = typeof values.interval === "string" ? positiveInterval(values.interval) : 30;
    const runDir = resolve(target);
    if (values.detach === true) {
      const child = detachSelf("supervise", runDir, ["--interval", String(intervalSec)]);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child, "supervisor");
      process.stdout.write(`[supervise] detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    await superviseRun(runDir, intervalSec);
    return;
  }
  if (command === "cancel") { await cancelRun(target); return; }
  if (command === "preflight") {
    const checks = await preflightContract(target, { static: values.static === true });
    for (const check of checks) process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.id} · ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
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
  if (command === "findings") { process.stdout.write(renderFindings(resolve(target))); return; }
  if (command === "handoff") {
    const ok = await handoffCommand(target, values);
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "validate") {
    const path = resolve(target);
    const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
    process.stdout.write(`valid${contract.warnings.length ? ` (${contract.warnings.length} warning${contract.warnings.length === 1 ? "" : "s"})` : ""}\n`);
    for (const warning of contract.warnings) process.stdout.write(`[warn] ${warning}\n`);
    return;
  }
  usage();
}

/**
 * @param {string} value
 * @returns {number}
 */
function positiveInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval <= 0) throw new TypeError("--interval must be a positive number of seconds");
  return interval;
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @returns {boolean}
 */
function hasSettledCheckpoint(runDir, state) {
  // A reconciled unknown effect is terminal attention, never a settled and
  // safe checkpoint. It must not become handoff-able through a stale capsule.
  if (isUnknownEffectTerminal(state)) return false;
  const lastInvocation = state.invocations?.at(-1);
  if (lastInvocation) {
    const settlement = readOperationSettlement(runDir, lastInvocation.id);
    if (settlement) {
      const status = String(settlement.status);
      // Any existing settlement must be resolved: an unresolved ("closed",
      // "unknown_effect") or reconciled operation is not demonstrably settled,
      // and a stale capsule must not make the checkpoint handoff-able.
      if (status === "reconciled" || status === "unknown_effect" || !RESOLVED_OPERATION_STATUSES.has(status)) return false;
      return true;
    }
  }
  if (loadLatestCapsule(runDir, state.id, state.attempt) !== null) return true;
  if (state.result !== null && state.status !== "running") return true;
  return false;
}

/**
 * Manual cross-harness handoff: persist the node portable continuation capsule
 * from its settled checkpoint and route the next worker attempt to the requested
 * runtime. Returns false when no safe checkpoint exists.
 *
 * @param {string} target
 * @param {{node?: unknown, nodeId?: unknown, runtime?: unknown, runtimeId?: unknown, reason?: unknown}} values
 * @returns {Promise<boolean>}
 */
export async function handoffRun(target, values = {}) {
  const runDir = resolve(target);
  const contractPath = join(runDir, "contract.json");
  if (!existsSync(contractPath)) throw new Error(`not a run directory: ${runDir}`);
  const nodeId = typeof values.node === "string" ? values.node : typeof values.nodeId === "string" ? values.nodeId : "";
  const runtimeId = typeof values.runtime === "string" ? values.runtime : typeof values.runtimeId === "string" ? values.runtimeId : "";
  if (!nodeId) throw new TypeError("--node <id> is required");
  if (!runtimeId) throw new TypeError("--runtime <id> is required");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const planNode = contract.nodes.find((candidate) => candidate.id === nodeId);
  if (!planNode) throw new Error(`unknown node: ${nodeId}`);
  if (!contract.runtimes[runtimeId]) throw new Error(`unknown runtime: ${runtimeId}`);
  const lease = acquireControllerLease(runDir, {
    contractVersion: INTENT_FACTORY_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  lease.startHeartbeat();
  try {
    const state = readRunNodes(runDir, contract).find((node) => node.id === nodeId);
    if (!state) throw new Error(`missing persisted snapshot for node ${nodeId}`);
    if (state.status === "running") {
      process.stderr.write(`[handoff] refused: node ${nodeId} is currently running; cancel or resume first\n`);
      return false;
    }
    if (!hasSettledCheckpoint(runDir, state)) {
      process.stderr.write(isUnknownEffectTerminal(state)
        ? `[handoff] refused: node ${nodeId} is reconciled; a reconciled checkpoint is not safe for handoff\n`
        : `[handoff] refused: node ${nodeId} has no settled checkpoint to continue from\n`);
      return false;
    }
    const reason = boundedUtf8(typeof values.reason === "string" && values.reason.trim()
      ? values.reason.trim()
      : `manual handoff of node ${nodeId} to runtime ${runtimeId}`, 2 * 1024);
    const sourceRuntime = sourceWorkerRuntime(state);
    const at = new Date().toISOString();
    const routing = {
      history: [...(state.routing?.history ?? []), {
        at,
        role: "worker",
        runtime: sourceRuntime ?? runtimeId,
        nextRuntime: runtimeId,
        status: state.status,
      }].slice(-64),
      currentOverride: { at, role: "worker", runtime: runtimeId, reason },
    };
    // The capsule must be durable before the pending routing override becomes
    // schedulable: a crash at any write boundary leaves either the old safe
    // state or a complete handoff, never a pending node without its capsule.
    const pendingState = /** @type {NodeSnapshot} */ ({ ...state, routing, status: "pending", phase: "waiting", error: null, blockedBy: [], updatedAt: at });
    const capsule = persistNodeCapsule(contract, planNode, pendingState, runDir, lease, reason);
    const previousStatus = state.status;
    transition(runDir, state, "pending", { phase: "waiting", error: null, blockedBy: [], routing }, lease);
    appendTransitionEvent(runDir, state, previousStatus, "pending", {
      role: "worker",
      ...(sourceRuntime ? { currentRuntime: sourceRuntime } : {}),
      override: { sourceRuntime, destinationRuntime: runtimeId, reason, capsuleDigest: capsule.digest },
    }, lease);
    return true;
  } finally {
    lease.release();
  }
}

/**
 * @param {string} target
 * @param {{node?: unknown, runtime?: unknown, reason?: unknown}} values
 * @returns {Promise<boolean>}
 */
async function handoffCommand(target, values) {
  const ok = await handoffRun(target, values);
  if (!ok) return false;
  const runDir = resolve(target);
  const nodeId = /** @type {string} */ (values.node);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const state = readRunNodes(runDir, contract).find((node) => node.id === nodeId);
  const capsule = state ? loadLatestCapsule(runDir, nodeId, state.attempt) : null;
  process.stdout.write(`[handoff] node ${nodeId} → ${String(values.runtime)}\n[handoff] capsule ${join(runDir, "capsules", `${nodeId}.${state?.attempt ?? 0}.json`)}\n[handoff] digest ${capsule?.digest ?? "-"}\n`);
  return true;
}

const DRIVER_BIN_OVERRIDES = Object.freeze({
  codex: "INTENT_FACTORY_CODEX_BIN",
  claude: "INTENT_FACTORY_CLAUDE_BIN",
  agy: "INTENT_FACTORY_AGY_BIN",
  glm: "INTENT_FACTORY_GLM_BIN",
  "exec-jsonl": "INTENT_FACTORY_EXEC_JSONL_BIN",
});

/**
 * Mutation-free environment doctor: repository prerequisites, ignored .runs,
 * required binaries, and (when a contract is given) schema and driver versions.
 *
 * @param {string|undefined} contractPath
 * @param {{cwd?: string, json?: boolean}} values
 * @returns {Promise<boolean>}
 */
async function doctorCommand(contractPath, values) {
  const repoDir = resolve(values.cwd ?? ".");
  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const gitRepo = isGitWorkTree(repoDir);
  checks.push({ name: "git repository", ok: gitRepo, detail: gitRepo ? repoDir : "not inside a git work tree" });
  const runsIgnored = isRunsIgnored(repoDir);
  checks.push({
    name: ".runs ignored",
    ok: runsIgnored,
    detail: runsIgnored ? ".runs/ is git-ignored" : ".runs/ is not git-ignored; add .runs/ to .gitignore",
  });
  for (const binary of ["node", "npm"]) {
    const found = findExecutable(binary);
    checks.push({ name: `binary ${binary}`, ok: found !== null, detail: found ?? "not found on PATH" });
  }
  checks.push({ name: "runner schema", ok: true, detail: `protocol ${PROTOCOL_SCHEMA_VERSION} · runner ${INTENT_FACTORY_VERSION}` });
  /** @type {Set<string>} */
  let usedDrivers = new Set();
  /** @type {Set<string>} */
  const overriddenDrivers = new Set();
  if (contractPath) {
    const absolute = resolve(contractPath);
    try {
      const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
      checks.push({ name: "contract", ok: true, detail: `${contract.id} · ${contract.nodes.length} node${contract.nodes.length === 1 ? "" : "s"}` });
      const runtimes = reachableRuntimes(contract);
      if (contract.maxCostUsd !== undefined || contract.nodes.some((node) => node.maxCostUsd !== undefined)) {
        for (const entry of runtimes.values()) entry.requiredCapabilitySets.push({ cost: true });
      }
      usedDrivers = new Set([...runtimes.values()].map(({ runtime }) => runtime.driver));
      for (const runtime of Object.values(contract.runtimes)) {
        if (typeof runtime.executable === "string") overriddenDrivers.add(runtime.driver);
      }
      for (const { runtime, requiredCapabilitySets } of runtimes.values()) {
        const probe = await probeRuntime(runtime, { cwd: contract.cwd, requiredCapabilitySets });
        checks.push({ name: `driver ${probe.id ?? runtime.driver}`, ok: probe.ok, detail: probe.detail ?? (probe.ok ? "ok" : "probe failed") });
      }
    } catch (error) {
      checks.push({ name: "contract", ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({ name: "contract", ok: true, detail: "no contract.json provided; skipping runtime probes" });
  }
  // A PATH-only check must not fail a runtime whose binary is supplied through
  // an explicit executable or a INTENT_FACTORY_*_BIN override; the driver probe above
  // already validated whatever the runtime actually resolves to.
  for (const binary of ["codex", "claude", "agy", "glm", "exec-jsonl"]) {
    const overrideName = /** @type {Record<string, string>} */ (DRIVER_BIN_OVERRIDES)[binary];
    const overridden = overriddenDrivers.has(binary) || Boolean(process.env[overrideName]);
    // The glm driver drives a Claude-Code-compatible CLI; its default binary is `claude`.
    const found = findExecutable(binary === "glm" && !overridden ? "claude" : binary);
    const required = usedDrivers.has(binary) && !overridden;
    checks.push({
      name: `binary ${binary}`,
      ok: !required || found !== null,
      detail: overridden && !found ? "resolved via executable or env override" : required ? (found ?? "required by contract but not found on PATH") : (found ? "present" : "not on PATH (not required by this contract)"),
    });
  }
  const ok = checks.every((check) => check.ok);
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, repo: repoDir, ok, checks }, null, 2)}\n`);
  } else {
    for (const check of checks) process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.name} · ${check.detail}\n`);
  }
  return ok;
}

/**
 * @param {string} repoDir
 * @returns {boolean}
 */
function isGitWorkTree(repoDir) {
  if (existsSync(join(repoDir, ".git"))) return true;
  try {
    const result = spawnSync("git", ["-C", repoDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * @param {string} repoDir
 * @returns {boolean}
 */
function isRunsIgnored(repoDir) {
  try {
    const result = spawnSync("git", ["-C", repoDir, "check-ignore", "-q", ".runs"], { stdio: ["ignore", "ignore", "ignore"] });
    if (result.status === 0) return true;
  } catch {}
  try {
    const gitignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
    return gitignore.split(/\r?\n/u).some((line) => /^\.runs\/?$/u.test(line.trim()));
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function findExecutable(name) {
  if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function usage() {
  process.stderr.write(
    "usage: runner.mjs <run|validate|preflight> <contract.json> [--detach] | " +
    "<resume|supervise|cancel> <run-dir> [--detach] [--interval <sec>] | " +
    "<status|report> <run-dir> [--json] | findings <run-dir> | " +
    "handoff <run-dir> --node <id> --runtime <runtime-id> [--reason <text>] | " +
    "doctor [<contract.json>] [--cwd <dir>] [--json] | campaign <init|attach|note|resolve|close|show|list> ...\n",
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
