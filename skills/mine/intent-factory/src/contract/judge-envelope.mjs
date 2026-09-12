/**
 * The judge verdict envelope: the limits `parseJudge` enforces and the reasons
 * it rejects by.
 *
 * They live apart from the parser because the judge prompt must render the same
 * numbers. A judge that is never told the limit can only be discarded by it: a
 * thorough arbitration that overshoots the envelope is rejected unread, and the
 * bounded re-ask repeats the defect, because nothing in the prompt said what to
 * shorten. One source keeps the advertised envelope and the enforced one
 * unable to drift.
 */

/** The verdict envelope, in the units `parseJudge` measures: bytes, and a count. */
export const JUDGE_LIMITS = {
  summaryBytes: 4 * 1024,
  findings: 32,
  descriptionBytes: 2 * 1024,
  evidenceBytes: 4 * 1024,
};

/** The reason `parseJudge` throws when the verdict envelope itself overshoots. */
export const JUDGE_ENVELOPE_REASON = "judge result exceeds limits";

/** The reason `parseJudge` throws when a single finding overshoots the envelope. */
export const JUDGE_FINDING_ENVELOPE_REASON = "judge finding exceeds limits";
