import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { syncAgentSignal } from "../repo/signal.mjs";
import { JUDGE_SCHEMA, TERMINAL, retryPrompt } from "./prompts.mjs";
import { verificationFailureVerdict } from "./judge-gate.mjs";
import {
  applyJudgeProtocolFailure,
  applyJudgeResult,
  applyJudgeRound,
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
import { startJudge, startWorker } from "./dispatch.mjs";
import { assertEnvironmentReady, assertSourceUnchanged, captureRunIdentity, createRunMetadata, serializableContract, statesFingerprint } from "./run-identity.mjs";
import { blockDependents, runtimeAssignments } from "./assignment.mjs";

/** @typedef {import("../contract/index.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */

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
export async function driveRun(contract, runDir, states, campaign, lock, sourceIdentity, resume = {}, options = {}) {
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
            await applyJudgeRound(await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaign.path),
              contract, node, state, runDir, running, lock, states, campaign.path, state.result);
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

