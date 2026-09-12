/**
 * The write boundary: what a node was allowed to touch, what it actually
 * touched, and what to do when those differ.
 *
 * Scope is advisory by design -- an unexpected write is recorded as a finding
 * and shown to the judge, not treated as a crime -- with one exception:
 * `resolveUnknownEffect` decides whether an invocation whose effect is unproven
 * may be replayed at all, and a dirty scope there is a refusal.
 */
import { TERMINAL } from "./prompts.mjs";
import { appendTransitionEvent, recordExecutionOverride, transition, writeNode } from "./state.mjs";
import { attemptWorkspace } from "../repo/worktree.mjs";

import { errorCode, errorMessage, excerpt } from "../util.mjs";
import { executeControllerVerification } from "./verify.mjs";
import { providerReceiptsFromInvocationTail, settleInvocation } from "../run/operations.mjs";
import { readJson } from "../run/store.mjs";
import { scopeFindingFromScope } from "../contract/scope-findings.mjs";
import { captureWorkspaceScope, compareWorkspaceSnapshot, validateWorkspaceScopeBoundary } from "../repo/workspace.mjs";

/** @typedef {import("../contract/index.mjs").BoundedScope} BoundedScope */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../run/usage.mjs").RecoveryOutcome} RecoveryOutcome */
/** @typedef {import("../repo/workspace.mjs").ScopeComparison} ScopeComparison */
/** @typedef {import("../contract/index.mjs").TaskPacket} TaskPacket */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../repo/workspace.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */
/** @typedef {import("../repo/workspace.mjs").WorkspaceSnapshot} WorkspaceSnapshot */

/**
 * @param {NodeSnapshot} state
 * @returns {string|null}
 */
export function sourceWorkerRuntime(state) {
  return [...(state.invocations ?? [])].reverse().find((invocation) => invocation.phase === "worker")?.runtimeId
    ?? state.runtime?.id
    ?? null;
}
/**
 * @param {ScopeComparison} scope
 * @param {import("../repo/workspace.mjs").WorkspaceScopeBoundary} boundary
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
 * @param {import("../repo/workspace.mjs").WorkspaceScopeBoundary} boundary
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
 * @returns {Map<string, import("../repo/workspace.mjs").WorkspaceScopeBoundary>}
 */
export function captureNodeScopeBoundaries(contract) {
  return new Map(contract.nodes.map((node) => [node.id, captureWorkspaceScope(contract.cwd, workerScope(node.taskPacket))]));
}
/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot|undefined} state
 * @returns {import("../repo/workspace.mjs").WorkspaceScopeBoundary}
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
export function workerScope(taskPacket) {
  return {
    files: taskPacket.writeFiles ?? [],
    roots: taskPacket.writeRoots ?? [],
  };
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
export function checkResultMaterializationScope(contract, runDir, job, lock, label = "result materialization") {
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
export function canReuseResultEvidence(state, node) {
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
export function recordScopeFinding(runDir, state, lock) {
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
