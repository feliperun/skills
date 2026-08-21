#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  openSync,
  readSync,
  statSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
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
import { PLAN_RUNNER_VERSION, PROTOCOL_SCHEMA_VERSION, probeRuntime } from "./drivers/index.mjs";
import { extractJson } from "./drivers/exec-jsonl.mjs";
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
  compareWorkspaceSnapshot,
  compactVerification,
  runVerification,
} from "./verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "./worker-result.mjs";
import { registerRun, renderHandoff, renderRunHandoff, resolveCampaign } from "./campaign.mjs";
import { campaignCli } from "./campaign-cli.mjs";

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
/** @typedef {import("./verification.mjs").WorkspaceSnapshot} WorkspaceSnapshot */
/** @typedef {import("./worker-result.mjs").WorkerResult} WorkerResult */
/** @typedef {import("./campaign.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./lib.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {{kind: "adopted"|"rejudge"|"restart", phase?: "worker"|"judge", result?: unknown, usage?: Usage, invocationId?: string, reason?: string}} RecoveryOutcome */
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
  const lease = acquireControllerLease(runDir, {
    contractVersion: PLAN_RUNNER_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  lease.startHeartbeat();
  try {
    const sourceIdentity = await captureRunIdentity(contract);
    lease.assert();
    const runsDir = join(contract.cwd, ".runs");
    const campaign = resolveCampaign(runsDir, contract.campaignId);
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
        contractVersion: PLAN_RUNNER_VERSION,
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
        scope: null,
        gate: null,
        error: null,
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
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const lease = acquireControllerLease(runDir, {
    contractVersion: PLAN_RUNNER_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  lease.startHeartbeat();
  try {
    const storedMetadata = validateRunMetadata(readJson(join(runDir, "run.json")), { requireSourceIdentity: true });
    const states = new Map(readRunNodes(runDir, contract).map((state) => [state.id, state]));
    const sourceIdentity = await captureRunIdentity(contract);
    assertSourceUnchanged(storedMetadata.sourceIdentity, sourceIdentity);
    const runsDir = join(runDir, "..");
    const campaign = resolveCampaign(runsDir, contract.campaignId);
    registerRun(campaign.path, contract.id);
    for (const node of contract.nodes) {
      const state = states.get(node.id);
      if (!state) continue;
      if (state.status === "done" || state.status === "canceled" || isBlockedContextTerminal(state)) continue;
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
        if (!hadUsage && recovery.usage) state.usage = addUsage(state.usage, recovery.usage);
        state.invocations = closePersistedInvocation(state.invocations, recovery.invocationId, hadUsage ? undefined : recovery.usage);
        if (!persistedRecovery) recordExecutionOverride(runDir, state, {
          kind: "recovery",
          decision: recovery.kind === "rejudge" ? "rejudge" : "adopted",
          invocationId: recovery.invocationId,
          phase: recovery.phase,
          result: recovery.result,
          usage: recovery.usage,
          reason: recovery.kind === "rejudge"
            ? `judge invocation ${recovery.invocationId} was not adopted; completed worker stream was re-judged`
            : `${recovery.phase} invocation ${recovery.invocationId} completed after controller loss`,
        }, lease);
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
        if (recovery.phase === "worker" || restartInvocation?.phase === "worker") {
          const invocation = restartInvocation
            ?? [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
          if (!checkPersistedWorkerScope(contract, runDir, state, node, invocation, lease)) continue;
        }
        const recoveredInvocation = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
        const hadUsage = Boolean(recoveredInvocation?.usage);
        if (!hadUsage && recovery.usage) state.usage = addUsage(state.usage, recovery.usage);
        if (recovery.invocationId) {
          state.invocations = closePersistedInvocation(
            state.invocations,
            recovery.invocationId,
            hadUsage ? undefined : recovery.usage,
          );
        }
        if (!persistedRecovery) recordExecutionOverride(runDir, state, {
          kind: "recovery",
          decision: "restart",
          invocationId: recovery.invocationId,
          phase: recovery.phase,
          result: recovery.result,
          usage: recovery.usage,
          reason: recovery.reason,
        }, lease);
      }
      if (state.status === "exhausted" && state.error?.code === "wall_clock_timeout" && !state.executionOverrides?.some((item) => item.kind === "timeout")) {
        const timeoutSec = (node.timeoutSec ?? contract.timeoutSec) * 2;
        state.executionOverrides = [...(state.executionOverrides ?? []), {
          kind: "timeout",
          timeoutSec,
          at: new Date().toISOString(),
          reason: "resume after wall-clock timeout",
        }];
        writeNode(runDir, state, lease);
        appendTransitionEvent(runDir, state, state.status, state.status, { override: { kind: "timeout", timeoutSec } }, lease);
        process.stdout.write(`[resume] ${node.id} wall-clock budget doubled to ${timeoutSec}s\n`);
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
  const detachedBootstrap = validBootstrapNonce(process.env.PLAN_RUNNER_BOOTSTRAP_NONCE);
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
  render(runDir, lease);
  renderCampaignHandoffSafely(campaign, runsDir, runDir);

  let handoffFingerprint = statesFingerprint(states);
  const renderHandoffIfChanged = () => {
    const fingerprint = statesFingerprint(states);
    if (fingerprint === handoffFingerprint) return;
    handoffFingerprint = fingerprint;
    renderCampaignHandoffSafely(campaign, runsDir, runDir);
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
        for (const job of jobs) {
          if (job.phase === "worker") checkWorkerScope(contract, runDir, job, lease);
        }
        running.clear();
        for (const state of states.values()) {
          if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled" }, lease);
        }
        break;
      }

      await finalizeClosedJobs(contract, runDir, states, running, lease);
      await detectStalls(contract, running, async (job, status, error) => {
        if (job.phase === "worker" && !checkWorkerScope(contract, runDir, job, lease)) return;
        transition(runDir, job.state, status, { phase: job.phase, error }, lease);
      });
      blockDependents(contract, runDir, states, lease);
      enforceTokenBudget(contract, runDir, states, lease);

      const slots = contract.maxParallel - running.size;
      if (slots > 0) {
        const ready = contract.nodes.filter((node) => {
          const state = states.get(node.id);
          return state?.status === "pending" && node.dependsOn.every((id) => states.get(id)?.status === "done");
        });
        for (const node of ready.slice(0, slots)) {
          const state = states.get(node.id);
          if (!state) continue;
          if (state.phase === "judge" && state.result) {
            startJudge(contract, node, state, runDir, running, state.result, lease);
            continue;
          }
          state.attempt += 1;
          const prompt = state.gate?.verdict === "fail" ? retryPrompt(node, state.gate) : node.prompt;
          startWorker(contract, node, state, runDir, running, prompt, lease);
        }
      }

      render(runDir, lease);
      renderHandoffIfChanged();
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
  render(runDir);
  renderCampaignHandoffSafely(campaign, runsDir, runDir);
  const failed = [...states.values()].filter((state) => state.status !== "done");
  process.stdout.write(`[run] ${contract.id} ${failed.length ? "failed" : "done"} · ${runDir}\n`);
  if ([...states.values()].some((state) => state.usage)) process.stdout.write(renderReport(runDir));
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
    contractVersion: PLAN_RUNNER_VERSION,
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
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {string} prompt
 * @param {LeaseHandle} lease
 */
function startWorker(contract, node, state, runDir, running, prompt, lease) {
  const runtime = routeRuntime(contract, node, "worker");
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "worker_prompt_too_large", message: "worker prompt exceeds 65536 bytes" } }, lease);
    return;
  }
  /** @type {unknown} */
  let baseline;
  try {
    baseline = captureWorkspaceSnapshot(contract.cwd);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: errorMessage(error) } }, lease);
    return;
  }
  const snapshotPath = `${paths.prompt}.snapshot.json`;
  writeJsonAtomic(snapshotPath, baseline);
  state.phase = "worker";
  state.runtime = runtime;
  state.verification = null;
  state.scope = null;
  state.startedAt ??= new Date().toISOString();
  state.error = null;
  try {
    const job = startProcess({
      contract, node, state, runtime, prompt, paths, phase: "worker",
      onInvocation: (invocation, currentJob) => {
        invocation.snapshotPath = snapshotPath;
        currentJob.scopeBaseline = baseline;
        persistInvocation(runDir, state, invocation, currentJob, lease);
      },
    });
    transition(runDir, state, "running", { phase: "worker", runtime, error: null }, lease);
    running.set(node.id, job);
  } catch (error) {
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
  const runtime = routeRuntime(contract, node, "judge");
  const paths = logPaths(runDir, node.id, "judge", state.attempt);
  state.phase = "judge";
  state.runtime = runtime;
  try {
    const prompt = judgePrompt(node, workerResult, { diff: state.scope?.changedPaths, verification: state.verification });
    if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) {
      const error = /** @type {Error & {code: string}} */ (new Error("judge prompt exceeds 65536 bytes"));
      error.code = "judge_prompt_too_large";
      throw error;
    }
    const job = startProcess({
      contract, node, state, runtime,
      prompt,
      paths, phase: "judge",
      commandOptions: { schema: JUDGE_SCHEMA, schemaPath: join(runDir, "judge.schema.json") },
      onInvocation: (invocation, currentJob) => persistInvocation(runDir, state, invocation, currentJob, lease),
    });
    transition(runDir, state, "running", { phase: "judge", runtime }, lease);
    running.set(node.id, job);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "judge", error: { code: /** @type {string} */ (errorCode(error) ?? "spawn_error"), message: errorMessage(error) } }, lease);
  }
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Job} job
 * @param {LeaseHandle} lease
 */
function persistInvocation(runDir, state, invocation, job, lease) {
  state.invocations = [...(state.invocations ?? []), invocation];
  state.updatedAt = invocation.updatedAt;
  writeNode(runDir, state, lease);
  job.onClose = (closed) => {
    try {
      state.invocations = (state.invocations ?? []).map((item) => item.id === closed.id ? closed : item);
      state.updatedAt = closed.updatedAt;
      writeNode(runDir, state, lease);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    }
  };
}

/**
 * @param {ScopeComparison} scope
 * @returns {BoundedScope}
 */
function boundedScope(scope) {
  return {
    changedPaths: scope.changedPaths.slice(0, 64),
    unexpectedPaths: scope.unexpectedPaths.slice(0, 64),
    changedPathCount: scope.changedPaths.length,
    unexpectedPathCount: scope.unexpectedPaths.length,
    truncated: scope.changedPaths.length > 64 || scope.unexpectedPaths.length > 64,
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
    const scope = compareWorkspaceSnapshot(baseline, contract.cwd, job.node.taskPacket.writeFiles);
    const bounded = boundedScope(scope);
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
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {ValidatedNode} node
 * @param {Invocation|undefined} invocation
 * @param {LeaseHandle} lease
 * @returns {boolean}
 */
function checkPersistedWorkerScope(contract, runDir, state, node, invocation, lease) {
  try {
    const baseline = invocation?.snapshotPath
      ? /** @type {WorkspaceSnapshot} */ (readJson(invocation.snapshotPath))
      : null;
    if (!baseline) throw Object.assign(new Error("worker scope snapshot is missing"), { code: "scope_snapshot_missing" });
    const scope = compareWorkspaceSnapshot(baseline, contract.cwd, node.taskPacket.writeFiles);
    const bounded = boundedScope(scope);
    state.scope = bounded;
    if (!scope.unexpectedPaths.length) return true;
    const shown = bounded.unexpectedPaths.slice(0, 8).join(", ");
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: "unexpected_write", message: excerpt(`unexpected paths changed (${scope.unexpectedPaths.length}): ${shown}`) },
    }, lease);
    appendTransitionEvent(runDir, state, "failed", "failed", {
      unexpectedPaths: bounded.unexpectedPaths,
      unexpectedPathCount: bounded.unexpectedPathCount,
    }, lease);
    return false;
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: excerpt(errorMessage(error)) } }, lease);
    return false;
  }
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {Map<string, Job>} running
 * @param {LeaseHandle} lease
 * @returns {Promise<void>}
 */
async function finalizeClosedJobs(contract, runDir, states, running, lease) {
  for (const [nodeId, job] of running) {
    if (!job.closed || invocationAlive(job.invocation)) continue;
    running.delete(nodeId);
    const state = states.get(nodeId);
    if (!state) continue;
    if (job.phase === "worker" && !checkWorkerScope(contract, runDir, job, lease)) continue;
    if (TERMINAL.has(state.status)) continue;
    if (job.spawnError) {
      transition(runDir, state, "failed", { phase: job.phase, error: { code: "spawn_error", message: job.spawnError.message } }, lease);
      continue;
    }
    /** @type {ProviderEnvelope} */
    let envelope;
    try {
      const boundedStdout = readBoundedTail(job.paths.stdout);
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
    state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === job.invocation.id
      ? { ...invocation, usage: envelope.usage }
      : invocation);
    if (envelope.status !== "done") {
      transition(runDir, state, envelope.status, {
        phase: job.phase,
        result: state.result,
        error: envelope.error,
        usage: addUsage(state.usage, envelope.usage),
      }, lease);
      continue;
    }
    if (job.phase === "worker") {
      state.usage = addUsage(state.usage, envelope.usage);
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
      if (job.node.gate.enabled) startJudge(contract, job.node, state, runDir, running, workerResult, lease);
      else transition(runDir, state, "done", { phase: "complete", result: workerResult }, lease);
      continue;
    }
    state.usage = addUsage(state.usage, envelope.usage);
    applyJudgeResult(contract, job.node, state, envelope.result, runDir, lease, running);
  }
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
    state.revisions += 1;
    state.attempt += 1;
    if (running) startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lease);
    else transition(runDir, state, "pending", { phase: "worker", error: null }, lease);
  } else {
    transition(runDir, state, "exhausted", { phase: "judge", gate: verdict, error: { code: "revision_cap", message: verdict.summary } }, lease);
  }
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

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LeaseHandle} lease
 */
function enforceTokenBudget(contract, runDir, states, lease) {
  if (contract.maxInputTokens === undefined) return;
  const spent = [...states.values()].reduce((total, state) => total + (state.usage?.inputTokens ?? 0), 0);
  if (spent < contract.maxInputTokens) return;
  for (const state of states.values()) {
    if (state.status === "pending") transition(runDir, state, "blocked", { phase: "budget", error: { code: "budget_exceeded", message: `total input tokens (${spent}) reached the ${contract.maxInputTokens} budget` } }, lease);
  }
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
    contractVersion: PLAN_RUNNER_VERSION,
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
 * @param {LeaseHandle|null} [lease]
 */
function render(runDir, lease = null) {
  lease?.assert();
  writeTextAtomic(join(runDir, "STATUS.md"), renderStatus(runDir));
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
  const runtime = invocation?.phase === "judge" ? routeRuntime(contract, node, "judge") : routeRuntime(contract, node, "worker");
  const startedAt = Date.parse(invocation.startedAt);
  const timeoutSec = latestTimeoutSec(state, node.timeoutSec ?? contract.timeoutSec);
  const deadline = Number.isFinite(startedAt) && Number.isFinite(timeoutSec)
    ? startedAt + timeoutSec * 1_000
    : null;
  if (deadline === null || !Number.isFinite(deadline)) {
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    return { kind: "restart", reason: `invocation ${invocation.id} has no reliable start time or timeout deadline` };
  }
  if (invocation.closedAt !== null && !Number.isFinite(Date.parse(invocation.closedAt))) {
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    return { kind: "restart", reason: `invocation ${invocation.id} has no reliable close time` };
  }
  if (invocation && invocationAlive(invocation)) {
    if (Date.now() > deadline) {
      await terminateInvocation(invocation);
      return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} exceeded its wall-clock budget` };
    }
    while (invocationAlive(invocation) && Date.now() < deadline) {
      const result = invocationResult(invocation, runtime, { preferStructured: invocation.phase === "judge" });
      if (result?.status === "done") {
        if (Date.now() > deadline || (invocation.closedAt !== null && Date.parse(invocation.closedAt) > deadline)) {
          await terminateInvocation(invocation);
          return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} completed after its wall-clock budget` };
        }
        await terminateInvocation(invocation);
        if (invocation.phase === "judge") return adoptOrRejudgeJudge(state, contract, node, invocation, result);
        return /** @type {RecoveryOutcome} */ ({ kind: "adopted", ...result, phase: invocation.phase, invocationId: invocation.id });
      }
      await delay(Math.min(contract.pollIntervalMs, 250));
    }
    const expired = Date.now() >= deadline;
    if (invocationAlive(invocation)) await terminateInvocation(invocation);
    if (expired) return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} exceeded its wall-clock budget` };
    if (invocation.closedAt === null) return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} has no reliable close time` };
    if (invocation.phase === "judge") {
      const result = invocationResult(invocation, runtime, { preferStructured: true, exitCode: invocation.exitCode, signal: invocation.signal });
      return result?.status === "done"
        ? adoptOrRejudgeJudge(state, contract, node, invocation, result)
        : rejudgeOrRestart(state, contract, node, invocation, result);
    }
  }
  if (invocation) {
    const closedAt = Date.parse(invocation.closedAt ?? "");
    if (!Number.isFinite(closedAt) || closedAt > deadline) {
      return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} completed after its wall-clock budget` };
    }
    if (invocation.closedAt === null) {
      return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} has no reliable close time` };
    }
    const result = invocationResult(invocation, runtime, { preferStructured: invocation.phase === "judge", exitCode: invocation.exitCode, signal: invocation.signal });
    if (invocation.phase === "judge") {
      if (result?.status === "done") return adoptOrRejudgeJudge(state, contract, node, invocation, result);
      return rejudgeOrRestart(state, contract, node, invocation, result);
    }
    if (result?.status === "done") return /** @type {RecoveryOutcome} */ ({ kind: "adopted", ...result, phase: invocation.phase, invocationId: invocation.id });
    return { kind: "restart", reason: `${invocation.phase} invocation ${invocation.id} died without a completed stream` };
  }
  return { kind: "restart", reason: `node ${state.id} died without a completed stream` };
}

/**
 * @param {Record<string, unknown>} override
 * @param {string|undefined} invocationId
 * @returns {RecoveryOutcome}
 */
function recoveryFromOverride(override, invocationId) {
  return /** @type {RecoveryOutcome} */ ({
    kind: override.decision === "rejudge" ? "rejudge" : override.decision === "restart" ? "restart" : "adopted",
    phase: override.phase,
    result: override.result,
    usage: override.usage,
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
  const workerResult = workerInvocation && invocationResult(workerInvocation, routeRuntime(contract, node, "worker"));
  if (workerResult?.status === "done") {
    return /** @type {RecoveryOutcome} */ ({
      kind: "rejudge",
      phase: "worker",
      result: workerResult.result,
      usage: judgeResult?.usage,
      invocationId: judgeInvocation.id,
    });
  }
  return /** @type {RecoveryOutcome} */ ({
    kind: "restart",
    phase: "judge",
    invocationId: judgeInvocation.id,
    usage: judgeResult?.usage,
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
 * @returns {Invocation[]}
 */
function closePersistedInvocation(invocations, invocationId, usage = undefined) {
  return (invocations ?? []).map((invocation) => invocation.id === invocationId ? { ...invocation, status: "closed", usage: usage ?? invocation.usage, closedAt: invocation.closedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() } : invocation);
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
  const result = invocationResult(invocation, routeRuntime(contract, node, "worker"));
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

/**
 * @param {ValidatedContract} contract
 * @returns {Promise<SourceIdentity>}
 */
async function captureRunIdentity(contract) {
  /** @type {Map<string, RuntimeSnapshot>} */
  const runtimes = new Map();
  for (const node of contract.nodes) {
    runtimes.set(routeRuntime(contract, node, "worker").id, routeRuntime(contract, node, "worker"));
    if (node.gate.enabled) runtimes.set(routeRuntime(contract, node, "judge").id, routeRuntime(contract, node, "judge"));
  }
  const versions = await Promise.all([...runtimes.entries()].map(async ([id, runtime]) => {
    const result = await probeRuntime(runtime, { cwd: contract.cwd, timeoutSec: 5 });
    return [id, result.version ?? null];
  }));
  const ignorePaths = [...new Set(contract.nodes.flatMap((node) => node.taskPacket?.writeFiles ?? []))];
  return captureSourceIdentity(contract, Object.fromEntries(versions), { ignorePaths });
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
      for (const [id, expectedVersion] of Object.entries(expectedVersions)) {
        if (expectedVersion !== null && actualVersions[id] !== expectedVersion) throw new Error("source drift detected in driverVersions; resume refused");
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
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  writeJsonAtomic(join(runDir, "cancel.request.json"), { requestedAt: new Date().toISOString(), pid: process.pid });
  const lease = readLease(runDir);
  const healthyLease = lease && leaseHealthy(lease) ? /** @type {LeaseRecord} */ (lease) : null;
  if (healthyLease && healthyLease.pid !== process.pid) {
    const controller = { pid: healthyLease.pid, processStartToken: healthyLease.processStartToken };
    if (invocationAlive(controller)) {
      signalController(healthyLease, "SIGTERM");
      if (!await waitForProcessDeath(controller, 2_000)) {
        signalController(healthyLease, "SIGKILL");
        if (!await waitForProcessDeath(controller, 2_000)) throw new Error("cancel could not confirm controller termination");
      }
    }
    await waitForLeaseExpiry(runDir, 30_000);
  }
  if (healthyLease && healthyLease.pid === process.pid) {
    throw new Error("cancel cannot take over a controller lease held by this process");
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
      return acquireControllerLease(runDir, { contractVersion: PLAN_RUNNER_VERSION, processStartToken: processStartToken(process.pid) });
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
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
    const states = readRunNodes(runDir, contract);
    if (states.every((state) => TERMINAL.has(state.status)) && states.every((state) => (state.invocations ?? []).every((invocation) => !invocationAlive(invocation)))) return true;
    await delay(100);
  }
  return false;
}

/**
 * @param {string} contractPath
 * @returns {Promise<ProbeResult[]>}
 */
export async function preflightContract(contractPath) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContract(JSON.parse(readFileSync(absoluteContractPath, "utf8")), absoluteContractPath);
  /** @type {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>} */
  const runtimes = new Map();
  for (const node of contract.nodes) {
    const worker = routeRuntime(contract, node, "worker");
    addRuntimeRequirement(runtimes, worker, [worker.requiredCapabilities, node.requiredCapabilities].filter((item) => item !== undefined));
    if (node.gate.enabled) {
      const judge = routeRuntime(contract, node, "judge");
      addRuntimeRequirement(runtimes, judge, [judge.requiredCapabilities, node.gate.requiredCapabilities, { structuredOutput: true }].filter((item) => item !== undefined));
    }
  }
  return Promise.all([...runtimes.values()].map(({ runtime, requiredCapabilitySets }) => probeRuntime(runtime, { cwd: contract.cwd, requiredCapabilitySets })));
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
    const otherContractPath = join(otherRunDir, "contract.json");
    if (!existsSync(otherContractPath)) throw new TypeError(`missing persisted contract ${otherContractPath}`);
    const otherContract = validateContract(JSON.parse(readFileSync(otherContractPath, "utf8")), otherContractPath);
    for (const node of contract.nodes) {
      const statePath = join(nodeDir, `${node.id}.json`);
      if (!existsSync(statePath)) continue;
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
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const supervisorLease = acquireSupervisorLease(runDir, {
    contractVersion: PLAN_RUNNER_VERSION,
    processStartToken: processStartToken(process.pid),
  });
  try {
    validateRunMetadata(readJson(join(runDir, "run.json")), { requireSourceIdentity: true });
    const bootstrapNonce = bootstrapNonceForProcess();
    const detachedBootstrap = validBootstrapNonce(process.env.PLAN_RUNNER_BOOTSTRAP_NONCE);
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
      if (nodes.length && nodes.every((node) => TERMINAL.has(node.status))) {
        process.stdout.write(`[supervise] ${basename(runDir)} finished · ${nodes.filter((node) => node.status === "done").length}/${nodes.length} done\n`);
        return;
      }
      const lease = readLease(runDir);
      if (!leaseHealthy(lease)) {
        const child = detachSelf("resume", runDir);
        const pid = child.pid;
        if (pid === undefined) throw new Error("detached child has no pid");
        process.stdout.write(`[supervise] controller lease expired · resumed · pid ${pid}\n`);
        await waitForBootstrap(runDir, pid, child);
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
    env: { ...process.env, PLAN_RUNNER_BOOTSTRAP_NONCE: nonce },
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
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
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
  const nonce = validBootstrapNonce(process.env.PLAN_RUNNER_BOOTSTRAP_NONCE) ? process.env.PLAN_RUNNER_BOOTSTRAP_NONCE : null;
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

/**
 * @returns {string}
 */
function bootstrapNonceForProcess() {
  return validBootstrapNonce(process.env.PLAN_RUNNER_BOOTSTRAP_NONCE)
    ? /** @type {string} */ (process.env.PLAN_RUNNER_BOOTSTRAP_NONCE)
    : randomUUID();
}

export { detectStalls, runProcessAlive, startProcess };

/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const COMMAND_OPTIONS = {
  run: { detach: { type: "boolean" } },
  resume: { detach: { type: "boolean" } },
  supervise: { detach: { type: "boolean" }, interval: { type: "string" } },
  cancel: {},
  preflight: {},
  validate: {},
  status: { json: { type: "boolean" } },
  report: { json: { type: "boolean" } },
  findings: {},
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
  if (argv[0] === "campaign") { campaignCli(argv.slice(1)); return; }
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
      for (const warning of reusedDoneWarnings(contract)) process.stdout.write(`[warn] ${warning}\n`);
      const child = detachSelf("run", target);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[run] ${contract.id} detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    for (const warning of reusedDoneWarnings(contract)) process.stdout.write(`[warn] ${warning}\n`);
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
    const checks = await preflightContract(target);
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

const DRIVER_BIN_OVERRIDES = Object.freeze({
  codex: "PLAN_RUNNER_CODEX_BIN",
  claude: "PLAN_RUNNER_CLAUDE_BIN",
  agy: "PLAN_RUNNER_AGY_BIN",
  "exec-jsonl": "PLAN_RUNNER_EXEC_JSONL_BIN",
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
  checks.push({ name: "runner schema", ok: true, detail: `protocol ${PROTOCOL_SCHEMA_VERSION} · runner ${PLAN_RUNNER_VERSION}` });
  /** @type {Set<string>} */
  let usedDrivers = new Set();
  /** @type {Set<string>} */
  const overriddenDrivers = new Set();
  if (contractPath) {
    const absolute = resolve(contractPath);
    try {
      const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
      checks.push({ name: "contract", ok: true, detail: `${contract.id} · ${contract.nodes.length} node${contract.nodes.length === 1 ? "" : "s"}` });
      /** @type {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>} */
      const runtimes = new Map();
      for (const node of contract.nodes) {
        const worker = routeRuntime(contract, node, "worker");
        addRuntimeRequirement(runtimes, worker, [worker.requiredCapabilities, node.requiredCapabilities].filter((item) => item !== undefined));
        if (node.gate.enabled) {
          const judge = routeRuntime(contract, node, "judge");
          addRuntimeRequirement(runtimes, judge, [judge.requiredCapabilities, node.gate.requiredCapabilities, { structuredOutput: true }].filter((item) => item !== undefined));
        }
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
  // an explicit executable or a PLAN_RUNNER_*_BIN override; the driver probe above
  // already validated whatever the runtime actually resolves to.
  for (const binary of ["codex", "claude", "agy", "exec-jsonl"]) {
    const found = findExecutable(binary);
    const overrideName = /** @type {Record<string, string>} */ (DRIVER_BIN_OVERRIDES)[binary];
    const overridden = overriddenDrivers.has(binary) || Boolean(process.env[overrideName]);
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
