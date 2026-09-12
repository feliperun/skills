/**
 * Judge round arbitration: interpret a returned verdict, decide re-ask versus
 * settlement, and apply worker/verification rejections. `node.mjs` launches
 * the judge invocation (prompt rendering, provider dispatch) and hands the
 * result here; this module never starts a provider invocation itself.
 */
import { parseJudge, retryPrompt } from "./prompts.mjs";
import {
  clearJudgeReask,
  judgeReaskOutstanding,
  markJudgeReask,
  resetPhaseRouting,
  uncitedRejection,
  verificationFailureVerdict,
} from "./judge-gate.mjs";
import {
  JUDGE_UNAVAILABLE_CODE,
  UNCITED_REJECTION_REASON,
  invalidJudgeVerdict,
  reviewMode,
} from "../contract/review-modes.mjs";
import { verificationFailureWithScope } from "../contract/scope-findings.mjs";
import {
  raiseNodeAttention,
  settleDone,
} from "./lifecycle.mjs";
import { errorMessage, excerpt } from "../util.mjs";
import { appendTransitionEvent, transition } from "./state.mjs";
import { startJudge, startWorker } from "./dispatch.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {import("./lifecycle.mjs").Job} Job */

/** A failed judge envelope gets one bounded re-dispatch, then judge_unavailable. */
export const JUDGE_MAX_FAILURES = 2;

/** Attention code raised when an advisory review completes without a verdict. */
const INVALID_JUDGE_OUTPUT_CODE = "invalid_judge_output";

/**
 * Settle a judge round that produced no usable verdict. The first defect earns
 * the one bounded re-ask on the node's own bound; once it is spent the review
 * mode decides, and blocking review never degrades into a pass.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>|null} running
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {string} reason
 */
export async function applyJudgeProtocolFailure(contract, node, state, runDir, running, lock, states, campaignPath, reason) {
  if (judgeReaskOutstanding(state)) {
    if (reviewMode(node.gate) === "advisory") {
      // The deterministic verification passed, so the review cannot fail the
      // node; completing with the defect recorded keeps it visible instead of
      // silently discarding the review.
      await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, invalidJudgeVerdict(reason));
      await raiseNodeAttention(campaignPath, runDir, state, INVALID_JUDGE_OUTPUT_CODE);
      return;
    }
    // Nothing about the attempt is rewritten: the accepted worker result, the
    // verification records and the gate state stay exactly as a node awaiting
    // its judge leaves them, so a retry in place re-judges instead of re-running.
    transition(runDir, state, "blocked", {
      phase: "judge",
      result: state.result,
      usage: state.usage,
      error: { code: JUDGE_UNAVAILABLE_CODE, message: excerpt(reason) ?? "judge unavailable" },
    }, lock);
    await raiseNodeAttention(campaignPath, runDir, state, JUDGE_UNAVAILABLE_CODE);
    return;
  }
  // The bound rides on the node: the next write — the recovered pending
  // judge below or the re-ask dispatch's own invocation — persists it with
  // the transition it belongs to, leaving no gap either way.
  markJudgeReask(state, reason);
  if (!running) {
    // A verdict recovered after controller loss keeps its durable bound:
    // the drive loop dispatches the one remaining bounded re-ask.
    transition(runDir, state, "pending", { phase: "judge", gate: null, result: state.result, error: null, blockedBy: [] }, lock);
    return;
  }
  await applyJudgeRound(await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaignPath),
    contract, node, state, runDir, running, lock, states, campaignPath, state.result);
}

/**
 * Settle an advisory gate: the verdict is recorded with its findings and the
 * node completes, because the deterministic verification already passed. A
 * verdict that is not a clean pass appends the `gate.advisory` event the run
 * journal keeps for review outcomes.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {JudgeVerdict} verdict
 */
async function settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, verdict) {
  clearJudgeReask(state);
  state.gate = verdict;
  if (verdict.verdict !== "pass") {
    appendTransitionEvent(runDir, state, state.status, state.status, {
      type: "gate.advisory",
      verdict: verdict.verdict,
      summary: verdict.summary,
    }, lock);
  }
  await settleDone(contract, node, state, runDir, lock, states, campaignPath, { phase: "complete", gate: verdict });
}

/** Settle a judge whose provider failed its bounded re-dispatches: blocking review blocks with the work preserved; advisory review completes with the defect recorded. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {string} providerMessage */
export async function settleUnavailableJudge(contract, node, state, runDir, lock, states, campaignPath, providerMessage) {
  if (reviewMode(node.gate) === "advisory") {
    await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, invalidJudgeVerdict(providerMessage));
    await raiseNodeAttention(campaignPath, runDir, state, INVALID_JUDGE_OUTPUT_CODE);
    return;
  }
  transition(runDir, state, "blocked", {
    phase: "judge",
    result: state.result,
    usage: state.usage,
    error: { code: JUDGE_UNAVAILABLE_CODE, message: excerpt(providerMessage) ?? "judge unavailable" },
  }, lock);
  await raiseNodeAttention(campaignPath, runDir, state, JUDGE_UNAVAILABLE_CODE);
}

/** Apply a judge verdict: pass settles done; a rejection citing no judgment item id is a judge protocol failure — one durable bounded re-ask, then blocked judge_protocol attention — and never consumes a revision, at any severity. Under advisory review a fail verdict is recorded and the node still completes. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {unknown} result @param {string} runDir @param {LockHandle} lock @param {Map<string, Job>|null} running @param {Map<string, NodeSnapshot>} states @param {string} campaignPath */
export async function applyJudgeResult(contract, node, state, result, runDir, lock, running, states, campaignPath) {
  /** @type {JudgeVerdict} */
  let verdict;
  try {
    verdict = parseJudge(String(result ?? ""));
  } catch (error) {
    await applyJudgeProtocolFailure(contract, node, state, runDir, running, lock, states, campaignPath, errorMessage(error));
    return;
  }
  state.gate = verdict;
  state.judgeFailures = 0;
  const advisory = reviewMode(node.gate) === "advisory";
  const protocolFailure = verdict.verdict === "fail" && uncitedRejection(verdict, node);
  if (protocolFailure && judgeReaskOutstanding(state)) {
    if (advisory) {
      await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, verdict);
      await raiseNodeAttention(campaignPath, runDir, state, "judge_protocol");
      return;
    }
    transition(runDir, state, "blocked", {
      phase: "judge",
      gate: verdict,
      result: state.result,
      error: { code: "judge_protocol", message: "judge rejection cited no Definition of Done item id after the bounded re-ask" },
    }, lock);
    await raiseNodeAttention(campaignPath, runDir, state, "judge_protocol");
    return;
  }
  if (protocolFailure) {
    markJudgeReask(state, UNCITED_REJECTION_REASON);
    if (!running) {
      // A verdict recovered after controller loss keeps its durable bound:
      // the drive loop dispatches the one remaining bounded re-ask.
      transition(runDir, state, "pending", { phase: "judge", gate: null, result: state.result, error: null, blockedBy: [] }, lock);
      return;
    }
    await applyJudgeRound(await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaignPath),
      contract, node, state, runDir, running, lock, states, campaignPath, state.result);
    return;
  }
  clearJudgeReask(state);
  if (advisory) {
    await settleAdvisoryReview(contract, node, state, runDir, lock, states, campaignPath, verdict);
    return;
  }
  const shouldFail = verdict.verdict === "fail" && verdict.maxSeverity !== "none"
    && (node.gate.failOn ?? ["critical"]).includes(verdict.maxSeverity);
  if (!shouldFail) {
    await settleDone(contract, node, state, runDir, lock, states, campaignPath, { phase: "complete", gate: verdict });
    return;
  }
  applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, {
    code: "revision_cap",
    label: "gate",
    phase: "judge",
  });
}

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
 * Act on what a judge round decided. `startJudge` used to do this itself, which
 * made dispatch depend on both review policy and settlement; the five callers
 * all reach both already, so the decision comes back to them and lands here.
 *
 * @param {import("./dispatch.mjs").JudgeRound} round
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {unknown} workerResult
 * @returns {Promise<void>}
 */
export async function applyJudgeRound(round, contract, node, state, runDir, running, lock, states, campaignPath, workerResult) {
  if (round.kind === "rejected") {
    applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, round.verdict, {
      code: "mechanical_gate_failed",
      label: "mechanical-gate",
    });
    return;
  }
  if (round.kind === "settle") {
    await settleDone(contract, node, state, runDir, lock, states, campaignPath, {
      phase: "complete",
      result: workerResult,
      gate: round.gate,
    });
  }
}
