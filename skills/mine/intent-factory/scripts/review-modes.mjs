/**
 * Review modes for the gate (TECH-SPEC lean, rule 2).
 *
 * Deterministic verification is the gate; model review is advisory unless a
 * node opts into blocking. Three modes:
 *
 *  - `none`      the judge is never dispatched, whatever the checklist says.
 *  - `advisory`  (default) findings are recorded on the node and the node still
 *                settles `done` when its deterministic verification passed; a
 *                review that never produced a verdict completes with
 *                `invalid_judge_output` instead of failing the node.
 *  - `blocking`  findings at or above `failOn` re-dispatch the node, bounded by
 *                `maxRevisions`, and a judge that cannot produce exactly one
 *                valid verdict never silently passes: the node enters attention
 *                as `judge_unavailable` with the completed work preserved, so a
 *                retry in place can re-judge it.
 *
 * The verdict-defect evidence is read here, one step away from the provider
 * boundary: the codex normalizer counts the verdict-shaped agent messages it
 * saw, because selecting the last structured message alone cannot reveal that
 * there were two of them.
 */

import { JUDGE_ENVELOPE_REASON, JUDGE_FINDING_ENVELOPE_REASON } from "./judge-envelope.mjs";

/** Every review mode a gate may declare, plus the disabled-gate equivalent. */
export const REVIEW_MODES = new Set(["none", "advisory", "blocking"]);

/** A gate that does not declare a review mode reviews advisorially. */
const DEFAULT_REVIEW_MODE = "advisory";

/** The gate record a node carries when the judge never returned a usable verdict. */
const INVALID_JUDGE_VERDICT = "invalid_judge_output";

/** The error code a blocking review blocks with when no verdict was produced. */
export const JUDGE_UNAVAILABLE_CODE = "judge_unavailable";

/** Reason recorded on the re-ask an uncited gate-failing rejection spends. */
export const UNCITED_REJECTION_REASON = "uncited judge rejection spent its one bounded re-ask";

/**
 * @param {unknown} value
 * @returns {value is "none"|"advisory"|"blocking"}
 */
function isReviewMode(value) {
  return typeof value === "string" && REVIEW_MODES.has(value);
}

/**
 * The review mode a contract gate declares. `gate: false` (and an omitted
 * gate) is `none`; an enabled gate without `review` is the default advisory.
 *
 * @param {{enabled?: boolean, review?: unknown}|false|undefined|null} gate
 * @returns {"none"|"advisory"|"blocking"}
 */
export function reviewMode(gate) {
  if (!gate || gate.enabled === false) return "none";
  return isReviewMode(gate.review) ? gate.review : DEFAULT_REVIEW_MODE;
}

/**
 * The review mode recorded on a node snapshot, when the node was gated at all.
 *
 * @param {{review?: unknown}} node
 * @returns {"none"|"advisory"|"blocking"|null}
 */
function nodeReviewMode(node) {
  return isReviewMode(node.review) ? node.review : null;
}

/**
 * Whether the evidence one judge invocation produced is exactly one usable
 * verdict. Anything else — no verdict at all, several of them, a stream that
 * never reached its terminal envelope, or a phase killed on its wall clock —
 * is a judge protocol defect that earns the one bounded re-ask.
 *
 * @param {{status?: string, result?: unknown, judgeCandidates?: number, error?: {code?: string, message?: string}|null}} envelope
 * @returns {{ok: true, result: unknown, candidates: number}|{ok: false, reason: string}}
 */
export function judgeVerdictEvidence(envelope) {
  const status = String(envelope?.status ?? "");
  if (status !== "done" && status !== "no-op") {
    const message = envelope?.error?.message;
    return { ok: false, reason: message || `the judge phase ended ${status || "without an outcome"}` };
  }
  const candidates = envelope.judgeCandidates;
  if (candidates === 0) return { ok: false, reason: "the judge returned no verdict in its final messages" };
  if (typeof candidates === "number" && candidates > 1) {
    return { ok: false, reason: `the judge returned ${candidates} separate verdicts` };
  }
  return { ok: true, result: envelope.result, candidates: typeof candidates === "number" ? candidates : 1 };
}

/**
 * The gate record for a review that never arbitrated anything: no findings, no
 * severity, no verdict the node could be failed on.
 *
 * @param {string} reason
 * @returns {{verdict: typeof INVALID_JUDGE_VERDICT, maxSeverity: "none", summary: string, findings: {severity: "minor"|"major"|"critical", description: string, evidence: string}[]}}
 */
export function invalidJudgeVerdict(reason) {
  const summary = boundedSummary(`judge produced no usable verdict: ${reason}`);
  return { verdict: INVALID_JUDGE_VERDICT, maxSeverity: "none", summary, findings: [] };
}

/** @param {string} text @returns {string} */
function boundedSummary(text) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= 1024 ? text : `${bytes.subarray(0, 1023).toString("utf8")}…`;
}

/**
 * The node note a review leaves on the status surfaces: advisory findings that
 * a gate summary would otherwise hide, an invalid verdict on a node that still
 * completed, and the blocking review that is waiting for a judge.
 *
 * @param {{status?: string, review?: unknown, gate?: {verdict?: unknown, findings?: unknown[]}|null, error?: {code?: string}|null}} node
 * @returns {string|null}
 */
export function reviewNote(node) {
  const verdict = /** @type {{verdict?: unknown, findings?: unknown[]}|null} */ (node.gate ?? null);
  if (verdict?.verdict === INVALID_JUDGE_VERDICT) return "judge: invalid output";
  if (node.status === "blocked" && node.error?.code === JUDGE_UNAVAILABLE_CODE) {
    return `needs you: ${JUDGE_UNAVAILABLE_CODE.replace(/_/g, " ")}`;
  }
  if (nodeReviewMode(node) === "advisory" && verdict?.verdict === "fail") {
    const count = Array.isArray(verdict.findings) ? verdict.findings.length : 0;
    if (count > 0) return `advisory: ${count} finding${count === 1 ? "" : "s"}`;
  }
  return null;
}

/**
 * The instruction appended to a re-asked judge prompt. An uncited rejection
 * gets the citation rule; a verdict discarded by its envelope gets the size
 * rule, because a concise re-issue is the whole defect; every other protocol
 * defect gets the one-verdict rule, because the judge already saw the citation
 * rule and ignored it.
 *
 * @param {string|undefined} reason the reason recorded with the spent re-ask
 * @returns {string}
 */
export function judgeReaskInstruction(reason) {
  if (reason === UNCITED_REJECTION_REASON) {
    return "\n\nYour previous fail verdict cited no Definition of Done item id. Protocol: every finding of a fail verdict must cite the id of the judgment item it addresses. Deterministic items are already proven by the controller and must not be re-arbitrated. Re-issue the verdict JSON with every finding citing the judgment item id it addresses.";
  }
  if (reason === JUDGE_ENVELOPE_REASON || reason === JUDGE_FINDING_ENVELOPE_REASON) {
    return "\n\nYour previous verdict did arrive, and its content was discarded unread: it overshot the envelope the schema states. Protocol: keep the arbitration exactly as it is and re-issue the same verdict JSON inside the envelope — a shorter `summary`, and findings whose `description` and `evidence` fit their limits. Do not drop a finding to make room; shorten its prose.";
  }
  return "\n\nYour previous response did not carry exactly one usable verdict. Protocol: the verdict is one JSON object matching the required schema, and it must be the only content of your final message — no prose before or after it, and no second verdict. Re-issue the verdict JSON now.";
}
