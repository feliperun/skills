import { normalizeProviderResult, probeRuntime } from "./drivers/index.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {{driver?: string, model?: string, vendor: string, tier?: number|string, costRank?: number, [key: string]: unknown}} RuntimeLike */
/** @typedef {{runtimes: Record<string, RuntimeLike>, runtimeDefaults?: {worker?: string, judge?: string}, nodes?: {id: string, runtime?: string, gate: {enabled: boolean, runtime?: string}}[]}} RuntimeContract */
/** @typedef {{available: boolean, exhaustedUntil: string|null, reason: string}} RuntimeAvailability */

/**
 * Candidates used when a contract omits its runtime catalogue. The catalogue
 * only names adapters; availability still comes from the installed binary.
 */
export const DISCOVERY_RUNTIME_DEFINITIONS = Object.freeze({
  glm: { driver: "glm", model: "glm-5.3", vendor: "zhipu", tier: 1, costRank: 1 },
  agy: { driver: "agy", model: "gemini-3.7-flash-low", vendor: "google", tier: 1, costRank: 1 },
  codex: { driver: "codex", model: "gpt-5.6", vendor: "openai", tier: 2, costRank: 2 },
  claude: { driver: "claude", model: "claude-sonnet-5", vendor: "anthropic", tier: 2, costRank: 2 },
});

/**
 * Normalize a provider envelope or recorded provider response into the
 * availability shape used by discovery and routing.
 *
 * @param {string|{driver: string}} runtimeOrDriver
 * @param {unknown} response
 * @param {number|null} [exitCode]
 * @param {string|null} [signal]
 * @returns {RuntimeAvailability}
 */
export function normalizeProviderAvailability(runtimeOrDriver, response, exitCode = 0, signal = null) {
  let envelope;
  try {
    envelope = isEnvelope(response)
      ? response
      : normalizeProviderResult(runtimeOrDriver, String(response ?? ""), exitCode, signal);
  } catch (error) {
    return { available: false, exhaustedUntil: null, reason: error instanceof Error ? error.message : "provider_unavailable" };
  }
  const error = envelope.error && typeof envelope.error === "object"
    ? /** @type {Record<string, unknown>} */ (envelope.error)
    : null;
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const text = `${code} ${message}`;
  if (envelope.status === "done" || envelope.status === "no-op") return { available: true, exhaustedUntil: null, reason: "ready" };
  if (envelope.status === "exhausted" || /quota|rate.?limit|usage limit|limit exhausted|1310/iu.test(text)) {
    return { available: false, exhaustedUntil: exhaustedUntilOf(envelope), reason: code || "quota_exhausted" };
  }
  if (/auth|credential|unauthori[sz]ed|forbidden|invalid.*(?:key|token)|(?:api|access) key|login/iu.test(text)) {
    return { available: false, exhaustedUntil: null, reason: "authentication_failed" };
  }
  return { available: false, exhaustedUntil: null, reason: code || "provider_unavailable" };
}

/** @param {unknown} envelope @returns {string|null} */
export function exhaustedUntilOf(envelope) {
  if (!isEnvelope(envelope)) return null;
  const error = envelope.error && typeof envelope.error === "object"
    ? /** @type {Record<string, unknown>} */ (envelope.error)
    : null;
  return normalizeReset(envelope.exhaustedUntil ?? error?.resetAt ?? extractReset(typeof error?.message === "string" ? error.message : ""));
}

/**
 * Discover runtime binaries without sending a model prompt. Tests can pass
 * recorded responses so no network call is needed.
 *
 * @param {Record<string, import("./drivers/index.mjs").DriverRuntime>} runtimes
 * @param {{cwd?: string, responses?: Record<string, unknown>, exitCodes?: Record<string, number|null>, signals?: Record<string, string|null>}} [options]
 * @returns {Promise<Record<string, RuntimeAvailability>>}
 */
export async function discoverRuntimes(runtimes, options = {}) {
  const entries = await Promise.all(Object.entries(runtimes).map(async ([id, runtime]) => {
    const response = options.responses?.[id];
    if (response !== undefined) {
      return [id, normalizeProviderAvailability(runtime, response, options.exitCodes?.[id] ?? 0, options.signals?.[id] ?? null)];
    }
    const probe = await probeRuntime(runtime, { cwd: options.cwd });
    return [id, probe.availability ?? (probe.ok
      ? { available: true, exhaustedUntil: null, reason: "ready" }
      : { available: false, exhaustedUntil: null, reason: probe.detail ?? "provider_unavailable" })];
  }));
  return Object.fromEntries(entries);
}

/**
 * Compose only omitted assignments. Explicit node and default declarations are
 * copied exactly; callers persist the returned pair in run state.
 *
 * @param {RuntimeContract} contract
 * @param {Record<string, RuntimeAvailability>} availability
 * @returns {Record<string, {worker: string, judge: string}>}
 */
export function composeAssignments(contract, availability = {}) {
  const candidates = Object.entries(contract.runtimes)
    .filter(([id]) => isAvailable(availability[id]))
    .map(([id, runtime], order) => ({ id, runtime, order }));
  /** @type {Record<string, {worker: string, judge: string}>} */
  const assignments = {};
  for (const node of contract.nodes ?? []) {
    const worker = node.runtime ?? contract.runtimeDefaults?.worker ?? cheapest(candidates)?.id;
    if (!worker || !contract.runtimes[worker]) throw new Error(`runtime_assignment_worker_unavailable: no available worker runtime for node ${node.id}`);
    const judge = node.gate.runtime ?? contract.runtimeDefaults?.judge
      ?? strongest(candidates, contract.runtimes[worker].vendor)?.id;
    if (node.gate.enabled && (!judge || !contract.runtimes[judge])) {
      throw new Error(`runtime_assignment_judge_unavailable: no available cross-vendor judge for node ${node.id} and worker ${worker}`);
    }
    const workerRuntime = contract.runtimes[worker];
    const judgeRuntime = judge ? contract.runtimes[judge] : undefined;
    if (node.gate.enabled && workerRuntime && judgeRuntime && judgeRuntime.vendor === workerRuntime.vendor) {
      throw new Error(`runtime_assignment_judge_unavailable: no available cross-vendor judge for node ${node.id} and worker ${worker}`);
    }
    assignments[node.id] = { worker, judge: judge ?? worker };
  }
  return assignments;
}

/**
 * Select an unattempted, available runtime in the current tier. Judge
 * candidates remain admissible only when their vendor differs from the worker
 * runtime that actually ran the node.
 *
 * @param {RuntimeContract} contract
 * @param {{assignments?: {worker?: string, judge?: string}, availability?: Record<string, RuntimeAvailability>}} stateRouting
 * @param {"worker"|"judge"} role
 * @param {string} current
 * @param {Iterable<string>} attempted
 * @returns {string|null}
 */
export function nextSameTierRuntime(contract, stateRouting, role, current, attempted) {
  const currentRuntime = contract.runtimes[current];
  if (!currentRuntime) return null;
  const workerId = stateRouting.assignments?.worker;
  const workerVendor = workerId ? contract.runtimes[workerId]?.vendor : null;
  const used = new Set(attempted);
  return Object.entries(contract.runtimes)
    .filter(([id, runtime]) => id !== current && !used.has(id) && sameTier(runtime, currentRuntime))
    .filter(([id]) => isAvailable(stateRouting.availability?.[id]))
    .filter(([, runtime]) => role !== "judge" || runtime.vendor !== workerVendor)
    .sort((left, right) => runtimeOrder(left[1]) - runtimeOrder(right[1]))
    .map(([id]) => id)
    .at(0) ?? null;
}

/** @param {RuntimeLike} left @param {RuntimeLike} right @returns {boolean} */
function sameTier(left, right) {
  return left.tier !== undefined || right.tier !== undefined
    ? left.tier === right.tier
    : (left.costRank ?? Number.MAX_SAFE_INTEGER) === (right.costRank ?? Number.MAX_SAFE_INTEGER);
}

/** @param {RuntimeLike} runtime @returns {number} */
function runtimeOrder(runtime) {
  return runtime.costRank ?? Number.MAX_SAFE_INTEGER;
}

/** @param {{id: string, runtime: RuntimeLike, order: number}[]} candidates @returns {{id: string, runtime: RuntimeLike, order: number}|null} */
function cheapest(candidates) {
  return [...candidates].sort((left, right) => tierOrder(left.runtime) - tierOrder(right.runtime)
    || runtimeOrder(left.runtime) - runtimeOrder(right.runtime)
    || left.order - right.order).at(0) ?? null;
}

/** @param {{id: string, runtime: RuntimeLike, order: number}[]} candidates @param {string} vendor @returns {{id: string, runtime: RuntimeLike, order: number}|null} */
function strongest(candidates, vendor) {
  return [...candidates].filter(({ runtime }) => runtime.vendor !== vendor)
    .sort((left, right) => tierOrder(right.runtime) - tierOrder(left.runtime)
      || runtimeOrder(right.runtime) - runtimeOrder(left.runtime)
      || left.order - right.order).at(0) ?? null;
}

/** @param {RuntimeLike} runtime @returns {number} */
function tierOrder(runtime) {
  return typeof runtime.tier === "number" ? runtime.tier : runtime.costRank ?? Number.MAX_SAFE_INTEGER;
}

/** @param {RuntimeAvailability|undefined} availability @returns {boolean} */
function isAvailable(availability) {
  if (!availability) return false;
  if (availability.available === true) return !availability.exhaustedUntil || Date.parse(availability.exhaustedUntil) <= Date.now();
  return Boolean(availability.exhaustedUntil && Date.parse(availability.exhaustedUntil) <= Date.now());
}

/** @param {unknown} value @returns {value is {status: string, error?: unknown, exhaustedUntil?: unknown}} */
function isEnvelope(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof /** @type {Record<string, unknown>} */ (value).status === "string");
}

/** @param {unknown} value @returns {string|null} */
function normalizeReset(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** @param {string} text @returns {string|null} */
function extractReset(text) {
  const match = /reset(?:s| at| on)?\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?)/iu.exec(text);
  if (!match) return null;
  const value = match[1].includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/u.test(match[1]) ? match[1] : `${match[1].replace(" ", "T")}Z`;
  return normalizeReset(value);
}
