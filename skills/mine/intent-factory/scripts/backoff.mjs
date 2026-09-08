/**
 * How a transient failure becomes a route.
 *
 * Two failures look alike from the controller's side — the invocation came
 * back without a usable result — and they want opposite treatments. A dropped
 * socket is the network's problem, and the runtime the node already warmed is
 * still the cheapest place to finish: wait, then ask it again. A provider that
 * cannot hold the result protocol is the provider's problem, and asking it a
 * third time buys nothing: change provider, or stop and say so.
 *
 * Everything here is a pure decision. Persisting it — the routing history,
 * the override, the node transition — stays in runner.mjs, so this module can
 * be tested without a run directory, a lease, or a provider.
 */
import { nextHop, nextSynthesizedRuntime, synthesizedChain } from "./failover.mjs";
import { nextSameTierRuntime } from "./runtime-discovery.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./contract.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {{code: string, message: string}} RouteError */
/** @typedef {"quota_reset"|"network_backoff"|"protocol_failure"|"provider"} TransitionReason */
/** @typedef {{kind: "reset", at: string, reason: TransitionReason}|{kind: "failover", reason: TransitionReason}} Transition */

/**
 * A node whose failure is the run's own doing never fails over: it already
 * spent the budget the edge would be charged against.
 */
export const NON_FAILOVER_CODES = new Set([
  "revision_cap", "verification_failed", "budget_exceeded", "wall_clock_timeout",
  "progress_stalled", "cancellation", "unexpected_write", "scope_violation",
  "permission_denied", "permission_required", "authority_denied", "authority_required",
  "authorization_required", "authentication_failed", "budget_attention", "cost_budget_exceeded",
  "token_budget_exceeded", "rollout_budget_exhausted",
]);

/** Network attempts on one runtime before the node gives up on it and hops. */
export const NETWORK_MAX_ATTEMPTS = 3;

/** First network wait, doubled per attempt. */
export const NETWORK_BACKOFF_BASE_MS = 1_000;

/** No single network wait exceeds two minutes, however many attempts remain. */
export const NETWORK_BACKOFF_CAP_MS = 120_000;

/**
 * Error codes a node owns rather than the network: its own wall-clock budget,
 * its own progress rule, its own operator. Their messages routinely contain
 * "timeout" or "reset", so they are excluded by code before any message is
 * read — otherwise a node that died on its own deadline would be handed three
 * more waits and die on it again.
 */
const NODE_DEADLINE_CODES = new Set([
  "wall_clock_timeout", "progress_stalled", "stall_timeout", "progress_snapshot_invalid",
  "token_budget_exceeded", "budget_exceeded", "cancellation",
]);

/** Error codes providers and Node itself report for a broken connection. */
const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND",
  "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "EPROTO", "UND_ERR_SOCKET",
  "network_error", "provider_unreachable", "service_unavailable", "gateway_timeout",
]);

/**
 * Message fragments that identify a transport failure when the provider
 * reported no machine-readable code — the common case for a CLI that prints
 * whatever its HTTP client said and exits.
 */
const NETWORK_PATTERNS = [
  /\becon(nreset|nrefused|naborted)\b/i,
  /\be(timedout|notfound|ai_again|netunreach|hostunreach|pipe)\b/i,
  /socket hang ?up/i,
  /connection (reset|refused|closed|aborted|error)/i,
  /network (error|is unreachable|unreachable|timeout)/i,
  /(fetch|request) failed/i,
  /temporary failure in name resolution/i,
  /\b(502|503|504)\b|bad gateway|service unavailable|gateway time-?out/i,
  /tls (handshake|connect) (timeout|error)/i,
];

/**
 * Exit codes that mean the transport failed, not the task.
 *
 * Only an explicit set counts. A provider CLI exits 1 for everything from a
 * dropped socket to a refused prompt, so treating a generic failure code as
 * transient would put every real failure through three pointless waits before
 * it could be reported. curl's connect (7), timeout (28), TLS (35), empty
 * reply (52) and receive (56) codes, sysexits EX_TEMPFAIL (75), and the
 * timeout(1) kill code (124) are unambiguous.
 */
export const TRANSIENT_EXIT_CODES = new Set([7, 28, 35, 52, 56, 75, 124]);

/**
 * Is this failure one the node imposed on itself rather than one the network
 * imposed on the node?
 *
 * @param {RouteError|null|undefined} error
 * @returns {boolean}
 */
export function isTimeoutOrStall(error) {
  return NODE_DEADLINE_CODES.has(String(error?.code ?? ""));
}

/**
 * @param {RouteError|null|undefined} error
 * @param {number|null|undefined} exitCode
 * @returns {boolean}
 */
function isNetworkFailure(error, exitCode) {
  if (isTimeoutOrStall(error)) return false;
  const code = String(error?.code ?? "");
  // A failure the run imposed on itself keeps its own settlement even when its
  // message happens to quote a socket error out of some tool's log.
  if (NON_FAILOVER_CODES.has(code)) return false;
  if (NETWORK_CODES.has(code)) return true;
  const message = String(error?.message ?? "");
  if (message && NETWORK_PATTERNS.some((pattern) => pattern.test(message))) return true;
  return typeof exitCode === "number" && TRANSIENT_EXIT_CODES.has(exitCode);
}

/**
 * The wait before network attempt `attempt` (0-based): exponential, capped,
 * and jittered over the top half of the window.
 *
 * The jitter is equal rather than full because a wait must never round to
 * zero. A zero-length backoff parks the phase and re-invokes the same failing
 * runtime in the same tick — the hot loop quotaResetSchedule already refuses
 * to open for a stale reset instant.
 *
 * @param {number} attempt
 * @param {() => number} [random]
 * @returns {number} milliseconds
 */
export function backoffDelayMs(attempt, random = Math.random) {
  const window = Math.min(NETWORK_BACKOFF_CAP_MS, NETWORK_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(window / 2 + random() * (window / 2));
}

/**
 * Marker prefix a network wait writes into its routing-history errorCode, in
 * front of whatever the provider actually reported.
 *
 * The routing history schema has no field for "why we stayed", and the
 * provider's own code is not enough to reconstruct one: a CLI that reports
 * `provider_error` with a dropped-socket message is classified off the
 * message, and the message is not persisted. Tagging the code keeps the
 * provider's answer visible and makes the attempt countable.
 */
export const NETWORK_BACKOFF_CODE = "network_backoff";

/**
 * @param {string} code provider error code for a wait being recorded
 * @returns {string} the errorCode to persist in the routing history
 */
export function networkBackoffErrorCode(code) {
  return `${NETWORK_BACKOFF_CODE}:${code}`;
}

/**
 * How many network waits this role already spent in this revision.
 *
 * The count is read back off the durable routing history — the node snapshot
 * is the only thing that survives a controller crash, so the attempt budget
 * has to live there too rather than in controller memory.
 *
 * @param {NodeSnapshot|{routing?: {history?: unknown[]}|null}} state
 * @param {"worker"|"judge"} role
 * @param {number} revision
 * @returns {number}
 */
export function networkBackoffAttempts(state, role, revision) {
  const history = /** @type {Record<string, unknown>[]} */ (state.routing?.history ?? []);
  return history.filter((entry) => entry.role === role
    && (entry.revision ?? 0) === revision
    && String(entry.errorCode ?? "").startsWith(`${NETWORK_BACKOFF_CODE}:`)).length;
}

/**
 * Classify one unusable invocation into the transition it earns.
 *
 * Order matters. An announced quota reset wins outright: the provider named
 * the instant it will work again, which is cheaper and more certain than any
 * guess. Otherwise a transport failure with attempts left buys a wait on the
 * runtime already warmed. Everything else — including a transport failure that
 * has spent its attempts, or whose wait would outlive the node's own deadline
 * — takes the failover edge.
 *
 * @param {unknown} envelope provider envelope for the unusable invocation
 * @param {{deadline?: string|number|Date|null, exitCode?: number|null, attempt?: number, now?: number, random?: () => number}} [options]
 * @returns {Transition}
 */
export function classifyTransition(envelope, options = {}) {
  const { deadline = null, exitCode = null, attempt = 0, now = Date.now(), random = Math.random } = options;
  const reset = quotaResetSchedule(envelope, deadline, now);
  if (reset.kind === "reset") return { ...reset, reason: "quota_reset" };
  const record = /** @type {Record<string, unknown>} */ (envelope ?? {});
  const error = /** @type {RouteError|null} */ (record.error ?? null);
  if (!isNetworkFailure(error, exitCode)) return { kind: "failover", reason: "provider" };
  if (attempt >= NETWORK_MAX_ATTEMPTS) return { kind: "failover", reason: "network_backoff" };
  const at = now + backoffDelayMs(attempt, random);
  // A wait the node cannot outlive is not a recovery: hop instead of dying parked.
  const deadlineMs = deadline instanceof Date ? deadline.getTime() : typeof deadline === "number" ? deadline : Date.parse(String(deadline));
  if (Number.isFinite(deadlineMs) && at >= deadlineMs) return { kind: "failover", reason: "network_backoff" };
  return { kind: "reset", at: new Date(at).toISOString(), reason: "network_backoff" };
}

/**
 * @param {Record<string, unknown>|undefined} state
 * @param {number} fallback
 * @returns {number}
 */
export function latestTimeoutSec(state, fallback) {
  const overrides = /** @type {unknown[]} */ (state?.executionOverrides ?? []);
  const override = [...overrides].reverse().find((item) =>
    item && typeof item === "object" &&
    /** @type {Record<string, unknown>} */ (item).kind === "timeout" &&
    typeof /** @type {Record<string, unknown>} */ (item).timeoutSec === "number" &&
    Number.isFinite(/** @type {Record<string, unknown>} */ (item).timeoutSec),
  );
  return override ? /** @type {number} */ (/** @type {Record<string, unknown>} */ (override).timeoutSec) : fallback;
}

/**
 * Decide what a worker exhaustion envelope buys us: a wait or a failover.
 *
 * A provider that announces when its quota resets is telling us the cheapest
 * possible recovery — keep the runtime the node already warmed and retry at
 * that instant, spending nothing in between. A reset is only worth waiting on
 * inside a window bounded at both ends. It must land strictly after now: a
 * reset already in the past buys no wait at all, and honouring one would park
 * the phase on a zero-length backoff and re-invoke the same exhausted runtime
 * immediately, so a provider that keeps echoing a stale instant would hot-loop
 * on it. It must also land strictly before the node's own deadline; a reset at
 * or after it would have the node sit out its whole budget and die waiting.
 * Outside that window — and for an envelope with no announced reset, or an
 * unparseable one — the caller takes its declared or synthesized failover edge.
 *
 * @param {unknown} envelope provider envelope for the exhausted invocation
 * @param {string|number|Date|null|undefined} deadline node wall-clock deadline
 * @param {number} [now] epoch ms the reset is judged against
 * @returns {{kind: "reset", at: string}|{kind: "failover"}}
 */
export function quotaResetSchedule(envelope, deadline, now = Date.now()) {
  const record = /** @type {Record<string, unknown>} */ (envelope ?? {});
  const error = /** @type {Record<string, unknown>} */ (record.error ?? {});
  const resetAt = epochMs(record.resetAt ?? error.resetAt);
  if (resetAt === null || resetAt <= now) return { kind: "failover" };
  const deadlineMs = epochMs(deadline);
  if (deadlineMs !== null && resetAt >= deadlineMs) return { kind: "failover" };
  return { kind: "reset", at: new Date(resetAt).toISOString() };
}

/** @param {unknown} value @returns {number|null} */
function epochMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The node's wall-clock deadline: when its own timeout budget runs out. @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @returns {string|null} */
export function nodeDeadlineAt(contract, node, state) {
  const startedAt = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
  if (!Number.isFinite(startedAt)) return null;
  return new Date(startedAt + latestTimeoutSec(state, node.timeoutSec ?? contract.timeoutSec) * 1_000).toISOString();
}

/**
 * The transition a transient network failure earns, or null when the failure
 * is not the network's doing and belongs to its caller's own settlement.
 *
 * Every unusable invocation asks this first, whatever role produced it. A
 * judge that lost its socket is no more unavailable than a worker that lost
 * one: it gets the same bounded waits on the runtime it already warmed, and
 * only what survives them is the judge's own failure to report.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {"worker"|"judge"} role
 * @param {unknown} envelope
 * @param {number|null} exitCode
 * @returns {Transition|null}
 */
export function networkTransition(contract, node, state, role, envelope, exitCode) {
  const transition = classifyTransition(envelope, {
    deadline: nodeDeadlineAt(contract, node, state),
    exitCode,
    attempt: networkBackoffAttempts(state, role, state.revisions ?? 0),
  });
  return transition.reason === "network_backoff" ? transition : null;
}

/**
 * Does a worker result that failed to parse still have its repair attempt?
 *
 * The first unparseable result is worth one bounded re-ask on the same
 * provider: the task packet is intact and the model only has to re-emit it.
 * The second is evidence about the provider, not the packet.
 *
 * @param {ValidatedNode|{gate: {enabled?: boolean, maxRevisions?: number}}} node
 * @param {{revisions?: number}} state
 * @returns {boolean}
 */
export function isRepairable(node, state) {
  return Boolean(node.gate.enabled) && (state.revisions ?? 0) < (node.gate.maxRevisions ?? 1);
}

/**
 * Resolve one transition into a concrete route: which runtime runs next, what
 * hop it costs, how long the node waits first, and whether any edge remains.
 *
 * A reset — quota or network — stays on the current runtime and therefore
 * costs no hop; only an actual edge spends from the failover budget.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {"worker"|"judge"} role
 * @param {RouteError} error
 * @param {string} current
 * @param {Transition} schedule
 * @param {number} [now] epoch ms the backoff window is measured from
 * @returns {{blocked: RouteError|null, nextRuntime: string, ruleIndex: number|undefined, revision: number, hop: number, backoffSec: number, backoffUntil: string, composed: boolean}}
 */
export function planRoute(contract, node, state, role, error, current, schedule, now = Date.now()) {
  const revision = state.revisions ?? 0;
  const attempted = new Set((state.invocations ?? [])
    .filter((invocation) => invocation.phase === role && (invocation.revision === undefined || invocation.revision === revision))
    .map((invocation) => invocation.runtimeId)
    .filter((id) => typeof id === "string"));
  // The runtime's own declared fallback is the only edge that exists: one
  // hop, never a chain over every other runtime in the contract.
  const actualWorker = [...(state.invocations ?? [])].reverse().find((invocation) => invocation.phase === "worker")?.runtimeId;
  const routing = state.routing?.assignments
    ? { ...state.routing, assignments: { ...state.routing.assignments, ...(actualWorker ? { worker: actualWorker } : {}) } }
    : state.routing ?? {};
  const declaredFallback = contract.runtimes[current]?.fallback !== undefined;
  const explicitFallbackUsed = (state.routing?.history ?? []).some((entry) =>
    entry.role === role
    && entry.nextRuntime
    && contract.runtimes[entry.runtime]?.fallback === entry.nextRuntime);
  const composedAssignment = role === "worker" ? state.routing?.assignments?.composedWorker === true : state.routing?.assignments?.composedJudge === true;
  const dynamicComposed = composedAssignment && !declaredFallback && !explicitFallbackUsed;
  // The declared candidate is resolved unfiltered so an already-attempted
  // edge is reported as a cycle rather than silently read back as "no edge
  // declared" — nextSynthesizedRuntime's own attempted-filter would otherwise
  // make that distinction unreachable.
  const declaredCandidate = synthesizedChain(contract, role, current)[0] ?? null;
  const fallback = nextSynthesizedRuntime(contract, role, current, attempted)
    ?? (dynamicComposed ? nextSameTierRuntime(contract, routing, role, current, attempted) : null);
  const hop = nextHop(state, role, revision, schedule);
  const nextRuntime = schedule.kind === "reset" ? current : fallback ?? current;
  const blocked = schedule.kind === "reset"
    ? null
    : fallback === null
      ? declaredCandidate !== null && attempted.has(declaredCandidate)
        ? { code: "provider_failover_cycle", message: `runtime ${declaredCandidate} was already attempted in ${role} revision ${revision}` }
        : { code: dynamicComposed ? "runtime_tier_exhausted" : error.code, message: dynamicComposed ? `no available runtime remains in tier ${String(contract.runtimes[current]?.tier ?? "unknown")} for ${role}` : error.message }
      : hop > 1 && !dynamicComposed
        ? { code: "provider_failover_hop_cap", message: "provider failover exceeded the one-hop cap" }
        : null;
  const backoffSec = schedule.kind === "reset"
    ? Math.max(0, (Date.parse(schedule.at) - now) / 1_000)
    : 0;
  const backoffUntil = schedule.kind === "reset" ? schedule.at : new Date(now + backoffSec * 1_000).toISOString();
  return { blocked, nextRuntime, ruleIndex: undefined, revision, hop, backoffSec, backoffUntil, composed: composedAssignment };
}

/**
 * Build the durable routing records for one planned route: the history entry
 * that says what happened, and the override that says where the phase goes.
 *
 * A network wait tags its history errorCode so the node carries its own
 * attempt count across a controller crash; see NETWORK_BACKOFF_CODE.
 *
 * @param {NodeSnapshot} state
 * @param {{role: "worker"|"judge", error: RouteError, current: string, plan: ReturnType<typeof planRoute>, schedule: Transition, usage?: unknown, costUsd?: number|null, status: string, now: number}} options
 * @returns {{routing: {history: unknown[], currentOverride: unknown}, override: unknown, errorCode: string}}
 */
export function buildRouting(state, { role, error, current, plan, schedule, usage, costUsd, status, now }) {
  const errorCode = schedule.kind === "reset" && schedule.reason === "network_backoff"
    ? networkBackoffErrorCode(error.code)
    : error.code;
  const shared = {
    at: new Date(now).toISOString(),
    role,
    nextRuntime: plan.nextRuntime,
    rule: plan.ruleIndex,
    ruleIndex: plan.ruleIndex,
    revision: plan.revision,
    hop: plan.hop,
    backoffSec: plan.backoffSec,
    backoffUntil: plan.backoffUntil,
    usage,
    costUsd,
  };
  const override = { ...shared, runtime: plan.nextRuntime, reason: routeReason(schedule, role, current, error) };
  return {
    routing: {
      history: [...(state.routing?.history ?? []), { ...shared, runtime: current, status, errorCode }].slice(-MAX_ROUTING_HISTORY),
      currentOverride: override,
    },
    override,
    errorCode,
  };
}

/** Routing history is bounded so a long-lived node cannot grow its snapshot without limit. */
const MAX_ROUTING_HISTORY = 64;

/**
 * The override reason recorded on the node, in the operator's words.
 *
 * @param {Transition} schedule
 * @param {"worker"|"judge"} role
 * @param {string} current
 * @param {RouteError} error
 * @returns {string}
 */
function routeReason(schedule, role, current, error) {
  if (schedule.kind === "reset" && schedule.reason === "quota_reset") {
    return `${role} provider ${current} quota resets at ${schedule.at}: ${error.message}`;
  }
  if (schedule.kind === "reset") return `${role} provider ${current} hit a transient network failure, retrying at ${schedule.at}: ${error.message}`;
  if (schedule.reason === "network_backoff") return `${role} provider ${current} kept failing on the network: ${error.message}`;
  if (schedule.reason === "protocol_failure") return `${role} provider ${current} could not hold the result protocol: ${error.message}`;
  return `${role} provider ${current} exhausted: ${error.message}`;
}
