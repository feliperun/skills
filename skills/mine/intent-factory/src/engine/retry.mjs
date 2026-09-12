/**
 * Retry in place (TECH-SPEC lean v0.3, rule 4 and decision 9.3).
 *
 * A retry is the same run and the same node: attempt plus one, in the same run
 * directory, with the failure attached. Instructions are frozen per run, so the
 * packet never changes; what changes is the prompt, which carries a bounded
 * `Previous attempt` section for the worker and for the judge.
 *
 * Resume adopts completed work first — an orphaned running node as before, and
 * a blocking review that never produced a verdict (`judge_unavailable`) is
 * re-judged from the preserved worker result instead of being reset or
 * re-dispatched to a worker — and only then re-dispatches ordinary failures.
 * Two stop boundaries are crossed by an explicit flag alone: a node blocked
 * with `unknown_effect_reconciled` needs `--reconcile <node>`, and an
 * exhausted run budget needs `--max-input-tokens <n>`.
 */
import { Buffer } from "node:buffer";

/** Heading of the section appended to a retried attempt's worker and judge prompt. */
const PREVIOUS_ATTEMPT_HEADING = "Previous attempt";

/** Hard ceiling for the whole `Previous attempt` section, in bytes. */
const PREVIOUS_ATTEMPT_MAX_BYTES = 8 * 1024;

/**
 * Node statuses an ordinary resume re-dispatches as attempt plus one.
 * `blocked` is deliberately absent: only its two error codes have a retry
 * meaning, and `context_missing` stays terminal.
 */
const RETRYABLE_STATUSES = new Set(["failed", "stalled", "exhausted", "canceled"]);

/**
 * @param {{status?: string, error?: {code?: string}|null}} state
 * @returns {boolean}
 */
function isJudgeUnavailable(state) {
  return state.status === "blocked" && state.error?.code === "judge_unavailable";
}

/**
 * @param {{status?: string, error?: {code?: string}|null}} state
 * @returns {boolean}
 */
function isDependencyFailed(state) {
  return state.status === "blocked" && state.error?.code === "dependency_failed";
}

/**
 * @param {{status?: string, error?: {code?: string}|null}} state
 * @returns {boolean}
 */
export function isUnknownEffectStop(state) {
  return state.status === "blocked" && state.error?.code === "unknown_effect_reconciled";
}

/**
 * @param {{status?: string, error?: {code?: string}|null}} state
 * @returns {boolean}
 */
function isRetryableFailure(state) {
  return RETRYABLE_STATUSES.has(/** @type {string} */ (state.status)) || isDependencyFailed(state);
}

/**
 * The node a `--node` flag names plus every node that transitively depends on
 * it: a retried dependency re-opens its dependants, so they are part of the
 * same retry.
 *
 * @param {{id: string, dependsOn?: string[]}[]} planNodes
 * @param {string} nodeId
 * @returns {Set<string>}
 */
function retryTargets(planNodes, nodeId) {
  const targets = new Set([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of planNodes) {
      if (targets.has(node.id)) continue;
      if ((node.dependsOn ?? []).some((dependency) => targets.has(dependency))) {
        targets.add(node.id);
        grew = true;
      }
    }
  }
  return targets;
}

/**
 * Decide, per node, what a resume does with it. Everything classified
 * `recover` keeps today's recovery behaviour (orphan adoption, re-judge of
 * finished work, pending re-dispatch). `hold` leaves the persisted state
 * exactly as it is and reports attention: resetting it would either replay an
 * unknown effect or re-dispatch work the operator did not ask for.
 *
 * @param {{nodes: {id: string, dependsOn?: string[]}[]}} contract
 * @param {Map<string, import("../contract/index.mjs").NodeSnapshot>} states
 * @param {{node?: string, reconcile?: string}} [options]
 * @returns {{actions: Map<string, "recover"|"retry"|"rejudge"|"hold">, attention: {id: string, reason: string}[], targets: Set<string>|null}}
 */
export function planResumeRetry(contract, states, options = {}) {
  const targets = options.node ? retryTargets(contract.nodes, options.node) : null;
  /** @type {Map<string, "recover"|"retry"|"rejudge"|"hold">} */
  const actions = new Map();
  /** @type {{id: string, reason: string}[]} */
  const attention = [];
  /** @type {(node: string, state: import("../contract/index.mjs").NodeSnapshot) => "recover"|"retry"|"rejudge"|"hold"} */
  const classify = (node, state) => {
    if (isJudgeUnavailable(state)) {
      // Adoption before retry: the worker result and the verification records
      // are on disk, so only the arbitration is missing.
      if (targets && !targets.has(node)) return hold(node, "its unresolved review is outside this retry");
      return "rejudge";
    }
    if (isUnknownEffectStop(state)) {
      // Stop boundary: only an explicit acknowledgement re-dispatches it.
      return options.reconcile === node
        ? "retry"
        : hold(node, "an unknown workspace effect needs an explicit `resume --reconcile`");
    }
    if (!isRetryableFailure(state)) return "recover";
    if (targets && !targets.has(node)) return hold(node, "it is outside the `--node` retry");
    return "retry";
  };
  /** @type {(id: string, reason: string) => "hold"} */
  const hold = (id, reason) => {
    attention.push({ id, reason });
    return "hold";
  };
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state) continue;
    actions.set(node.id, classify(node.id, state));
  }
  // A node blocked on a failed dependency is retried only when the dependency
  // it waited on is retried too; otherwise it keeps its boundary.
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state || !isDependencyFailed(state) || actions.get(node.id) !== "retry") continue;
    const waitedOnRetried = (state.blockedBy ?? []).every((id) => actions.get(id) === "retry" || states.get(id)?.status === "done");
    if (!waitedOnRetried) {
      actions.set(node.id, hold(node.id, "the dependency it waited on is not part of this retry"));
    }
  }
  return { actions, attention, targets };
}

/**
 * The bounded `Previous attempt` section for a node about to be re-dispatched:
 * the error code and message, the judge findings, the scope findings, and the
 * failing verification commands with a bounded output tail.
 *
 * @param {import("../contract/index.mjs").NodeSnapshot} state
 * @returns {string|null} null when the node carries no failure evidence
 */
export function renderPreviousAttemptSection(state) {
  /** @type {string[]} */
  const parts = [];
  const attempt = state.attempt ?? 0;
  // A node that never started an attempt has no failure to carry: its blocked
  // dependency is already visible in the graph.
  if (attempt === 0) return null;
  parts.push(`Attempt ${attempt} failed; this is attempt ${attempt + 1}. The packet is unchanged.`);
  if (state.error?.code || state.error?.message) {
    parts.push(`Error: ${state.error?.code ?? "unknown"}${state.error?.message ? ` — ${bounded(state.error.message, 1024)}` : ""}`);
  }
  const findings = state.gate?.findings ?? [];
  if (findings.length) {
    parts.push(`Judge findings (verdict ${state.gate?.verdict ?? "unknown"}, maxSeverity ${state.gate?.maxSeverity ?? "none"}):`);
    for (const finding of findings) {
      parts.push(`- [${finding.severity}] ${bounded(finding.description, 1024)}`);
      if (finding.evidence) parts.push(`  Evidence: ${bounded(finding.evidence, 1024)}`);
    }
  }
  const unexpected = state.scopeFindings?.unexpectedPaths ?? [];
  if (unexpected.length) parts.push(`Scope findings (paths outside the declared boundary): ${unexpected.map((path) => bounded(path, 256)).join(", ")}`);
  const failing = (state.verification?.commands ?? []).filter((command) => !command.passed);
  if (failing.length) {
    parts.push("Failing verification:");
    for (const command of failing) {
      parts.push(`- ${command.argv.join(" ")}`);
      const last = command.attempts?.at(-1);
      if (last?.stdout) parts.push(`  stdout tail: ${indent(last.stdout)}`);
      if (last?.stderr) parts.push(`  stderr tail: ${indent(last.stderr)}`);
      if (typeof last?.exitCode === "number" && last.exitCode !== 0) parts.push(`  exit code: ${last.exitCode}`);
    }
  }
  if (parts.length === 1) return null;
  return boundSection([`## ${PREVIOUS_ATTEMPT_HEADING}`, "", ...parts].join("\n"));
}

/**
 * Append the section to a regenerated prompt. A prompt that already carries it
 * (a gate revision re-rendered after a resume) is left alone.
 *
 * @param {string} prompt
 * @param {string|undefined} section
 * @returns {string}
 */
export function appendPreviousAttempt(prompt, section) {
  if (!section || prompt.includes(`## ${PREVIOUS_ATTEMPT_HEADING}`)) return prompt;
  return `${prompt}\n\n${section}`;
}

/**
 * @param {string} text
 * @returns {string} the text bounded to the section ceiling, with a marker
 */
function boundSection(text) {
  if (Buffer.byteLength(text, "utf8") <= PREVIOUS_ATTEMPT_MAX_BYTES) return text;
  const marker = "\n… (previous attempt section truncated)";
  const room = PREVIOUS_ATTEMPT_MAX_BYTES - Buffer.byteLength(marker, "utf8") - 1;
  const cut = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  return `${cut}${marker}`;
}

/** @param {string} text @param {number} maxBytes @returns {string} */
function bounded(text, maxBytes) {
  const bytes = Buffer.from(String(text ?? ""), "utf8");
  return bytes.length <= maxBytes ? String(text) : `${bytes.subarray(0, maxBytes - 1).toString("utf8")}…`;
}

/** Collapse a persisted output tail onto one indented line. @param {string} text @returns {string} */
function indent(text) {
  return bounded(String(text ?? "").replace(/\s+/gu, " ").trim(), 1024);
}
