/**
 * How a node ends: accepted and integrated, rejected, or parked for attention.
 *
 * These are the settlement primitives, and they are their own module because
 * both the control loop and the review policy call them -- `settleDone`'s
 * `onVerificationFailure` callback rejects the candidate, and `review.mjs`
 * settles a node whose judge passed. Leaving them in `engine/lifecycle.mjs`
 * made those two import each other, which was the last runtime import cycle in
 * `src/` and the one the allowlist used to name.
 *
 * `settleDone` is the only place a node becomes `done`, and it does it through
 * the integration transaction: the journal and the conditional ref update
 * belong to `repo/integrate.mjs`, and the callbacks here own node state alone.
 */
import { candidateOnlyFailures, resetPhaseRouting, verificationFailureVerdict } from "./judge-gate.mjs";
import { retryPrompt } from "./prompts.mjs";
import { startWorker } from "./dispatch.mjs";
import { ensureTerminalEvent, transition, writeNode } from "./state.mjs";
import { verificationFailureWithScope } from "../contract/scope-findings.mjs";
import { alreadyNotified, notifyQueueFor } from "./notify-queue.mjs";

import {
  attemptWorkspace,
  attemptWorktreePath,
  removeWorktree,
  sealAttempt,
} from "../repo/worktree.mjs";
import { basename } from "node:path";
import { boundedUtf8, errorCode, errorMessage } from "../util.mjs";
import { campaignIdOf } from "../campaign/record.mjs";
import { integrateAttempt } from "../repo/integrate.mjs";
import { verifyCandidateWorkspace } from "./verify.mjs";

/** @typedef {import("../repo/integrate.mjs").IntegrationResult} IntegrationResult */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */

/** Settle one worker-generation rejection: bounded revision when one remains, otherwise terminal exhausted/failed. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {JudgeVerdict} verdict @param {{code: string, label: string, phase?: "worker"|"judge", message?: string}} options */
export function applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, options) {
  const { code, label, phase = "worker", message = verdict.summary } = options;
  state.gate = verdict;
  if (node.gate.enabled && state.revisions < (node.gate.maxRevisions ?? 1)) {
    resetPhaseRouting(state);
    state.revisions += 1;
    state.attempt += 1;
    process.stdout.write(`[${label}] ${node.id} retry · ${verdict.summary}\n`);
    if (running) startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lock, states, campaignPath);
    else transition(runDir, state, "pending", { phase: "worker", error: null }, lock);
    return;
  }
  transition(runDir, state, node.gate.enabled ? "exhausted" : "failed", {
    phase,
    gate: verdict,
    error: { code, message },
  }, lock);
}
/** Deterministic verification failure settles through the shared rejection path. The verdict carries this attempt's unexpected paths, so a red attempt reports them whether it stops here or starts its revision (TECH-SPEC lean, rule 1). @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {JudgeVerdict} [verdict] */
export function applyVerificationFailure(contract, node, state, runDir, running, lock, states, campaignPath, verdict = verificationFailureWithScope(verificationFailureVerdict(state), state.scope)) {
  applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, { code: "verification_failed", label: "verification" });
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
