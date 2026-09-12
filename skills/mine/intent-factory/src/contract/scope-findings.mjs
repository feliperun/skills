/**
 * Advisory scope findings (TECH-SPEC lean, rule 1): unexpected writes on a
 * completed attempt whose controller verification passed are recorded on the
 * node and shown to the judge, never a terminal state.
 */

export const MAX_SCOPE_FINDING_PATHS = 64;

/**
 * @param {{unexpectedPaths: string[]}} scope
 * @returns {{unexpectedPaths: string[]}}
 */
export function scopeFindingFromScope(scope) {
  return { unexpectedPaths: scope.unexpectedPaths.slice(0, MAX_SCOPE_FINDING_PATHS) };
}

/**
 * @param {{unexpectedPaths: string[], unexpectedPathCount?: number}} scope
 * @returns {string}
 */
function describeUnexpectedPaths(scope) {
  const count = scope.unexpectedPathCount ?? scope.unexpectedPaths.length;
  const shown = scope.unexpectedPaths.slice(0, 8).join(", ");
  return `unexpected paths changed (${count}): ${shown}`;
}

/**
 * @param {{unexpectedPaths: string[]}|null|undefined} scopeFindings
 * @returns {string|null}
 */
export function scopeFindingsNote(scopeFindings) {
  const count = scopeFindings?.unexpectedPaths?.length;
  if (!count) return null;
  return `scope: ${count} unexpected path${count === 1 ? "" : "s"}`;
}

/**
 * @param {{unexpectedPaths: string[]}|null|undefined} scopeFindings
 * @returns {string}
 */
export function scopeFindingsPromptSection(scopeFindings) {
  if (!scopeFindings?.unexpectedPaths?.length) return "";
  const list = scopeFindings.unexpectedPaths.map((path) => `- ${path}`).join("\n");
  return `Scope findings (advisory; the controller's verification passed despite writes outside the declared scope):\n${list}`;
}

/**
 * Fold this attempt's unexpected paths into the deterministic
 * verification-failure verdict before it settles, so a red attempt reports
 * them in both of its outcomes: the terminal error message is the verdict
 * summary, and the retry prompt renders the verdict findings. Appending after
 * the fact cannot do it — a rejection that starts its revision clears the
 * scope and the error from the node state (TECH-SPEC lean, rule 1).
 *
 * @param {import("../engine/prompts.mjs").JudgeVerdict} verdict
 * @param {{unexpectedPaths: string[], unexpectedPathCount?: number}|null|undefined} scope
 * @returns {import("../engine/prompts.mjs").JudgeVerdict}
 */
export function verificationFailureWithScope(verdict, scope) {
  if (!scope?.unexpectedPaths?.length) return verdict;
  const described = describeUnexpectedPaths(scope);
  return {
    ...verdict,
    summary: `${verdict.summary} (${described})`,
    findings: [...verdict.findings, {
      severity: "critical",
      description: "the attempt also wrote outside its declared scope",
      evidence: described,
    }],
  };
}
