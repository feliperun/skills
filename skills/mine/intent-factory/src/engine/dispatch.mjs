/**
 * Putting a worker or a judge in front of a node: resolve the runtime, choose
 * the continuation, build the prompt and the attempt workspace, spawn, and
 * record the invocation intent before a token is spent.
 *
 * It decides nothing about outcomes. `startJudge` runs the mechanical gate and
 * returns what it found -- `rejected`, `settle` or `dispatched` -- for the
 * caller to act on. It used to call `applyRejection` and `settleDone` itself,
 * which made dispatch depend on review policy and on settlement, and that is
 * the shape that kept `engine/` a web instead of a stack.
 */
import { JUDGE_SCHEMA, judgePrompt } from "./prompts.mjs";
import { LockLostError } from "../run/lock.mjs";
import { TOOL_OUTPUT_LIMIT_BYTES } from "../harnesses/exec-jsonl/index.mjs";
import { appendPreviousAttempt } from "./retry.mjs";
import {
  RESULT_MATERIALIZATION_PROMPT_HEADER,
  attemptWorkerResultPath,
  clearAttemptWorkerResult,
  clearWorkerResultFile,
  readWorkerResultFile,
  workerProtocolPrompt,
} from "./result-file.mjs";
import { attemptWorkspace } from "../repo/worktree.mjs";
import { attemptWorktreePath, createAttemptWorktree, sealAttempt } from "../repo/worktree.mjs";
import { basename, dirname, join } from "node:path";
import { boundedUtf8, errorCode, errorMessage, stableJson } from "../util.mjs";
import { captureWorkspaceScope, captureWorkspaceSnapshot } from "../repo/workspace.mjs";
import { createHash } from "node:crypto";
import { deterministicGate, judgeReaskReason, judgeRequired } from "./judge-gate.mjs";
import { emptyScope, persistedScopeBoundary, workerScope } from "./scope.mjs";
import { hasOperationIntent, hasOperationSettlement, operationNeedsRecovery, operationNextState, persistInvocationIntent, providerReceipts, settleInvocation } from "../run/operations.mjs";
import { invocationCost, invocationUsage } from "../run/usage.mjs";
import { logPaths, readBoundedTail, startProcess } from "./process.mjs";
import { mkdirSync } from "node:fs";
import { normalizeProviderResult, providerCommand } from "../harnesses/index.mjs";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { judgeReaskInstruction, reviewMode } from "../contract/review-modes.mjs";
import { routeRuntimeForState, runtimeSnapshot } from "./failover.mjs";
import { transition, writeNode } from "./state.mjs";
import { validateNodeSnapshot } from "../contract/snapshot.mjs";

/**
 * What a judge round decided, for the caller to act on.
 * `rejected`: the mechanical gate failed, so nothing was dispatched.
 * `settle`: the gate passed and no judgment item needs arbitrating.
 * `dispatched`: a judge is running (or failed to start and the node is already
 * marked failed).
 *
 * @typedef {{kind: "rejected", verdict: JudgeVerdict}|{kind: "settle", gate: JudgeVerdict}|{kind: "dispatched"}} JudgeRound
 */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */

/** @typedef {import("../harnesses/index.mjs").CommandOptions} CommandOptions */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").VerificationState} VerificationState */
/** @typedef {import("../contract/index.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */

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
  /** @type {import("../repo/workspace.mjs").WorkspaceScopeBoundary} */
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
export function startResultMaterialization(contract, node, state, runDir, running, sourceInvocation, runtime, continuationId, lock) {
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
/**
 * Gate a completed worker: mechanical proofs gate first, the judge arbitrates
 * only judgment items and is skipped when the review mode is `none` or no
 * judgment item exists. A judge protocol re-ask never re-runs the round's
 * mechanical proofs.
 *
 * Returns what it decided rather than acting on it. Calling `applyRejection` or
 * `settleDone` from here made dispatch depend on review policy and on
 * settlement, which is the shape that kept `engine/` a web instead of a stack:
 * every caller of this function already reaches both, and now it is their call.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {unknown} workerResult
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @returns {Promise<JudgeRound>}
 */
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
  if (verdict.verdict === "fail") return { kind: "rejected", verdict };
  if (!judgeRequired(node)) return { kind: "settle", gate: verdict };
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
  return { kind: "dispatched" };
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
