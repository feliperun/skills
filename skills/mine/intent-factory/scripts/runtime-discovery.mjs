import { normalizeProviderAvailability, probeRuntime } from "./harnesses/index.mjs";

// Availability normalization belongs to the adapter registry, which is where
// each provider's own exhaustion, balance, and authentication wording is
// already classified. Re-exported here so discovery callers keep one import
// site; a second copy of these two functions is how they drift apart.
export { exhaustedUntilOf, normalizeProviderAvailability } from "./harnesses/index.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {{harness?: string, model?: string, vendor: string, tier?: number|string, costRank?: number, [key: string]: unknown}} RuntimeLike */
/** @typedef {{runtimes: Record<string, RuntimeLike>, runtimeDefaults?: {worker?: string, judge?: string}, nodes?: {id: string, runtime?: string, gate: {enabled: boolean, runtime?: string}}[]}} RuntimeContract */
/** @typedef {{available: boolean, exhaustedUntil: string|null, reason: string}} RuntimeAvailability */
/** @typedef {{harness: string, model: string, vendor: string, tier: number, costRank: number, config?: Record<string, unknown>}} DiscoveryRuntime */

/**
 * Candidates used when a contract omits its runtime catalogue. The catalogue
 * only names harnesses; availability still comes from the installed binary.
 *
 * Every id is `<harness>-<model>`, saying out loud what the fields already
 * say: `harness` is the harness that runs the turn, `model` is what that
 * harness asks, and the two vary independently — DeepSeek answers through the
 * `dsh` harness, GLM through `zcode`. An id naming only one half (the bare
 * `glm` this catalogue used to carry, which was at once a model family, a
 * vendor, and an adapter name) hides which harness a recorded run used. The
 * separator is a dash because `contract.mjs` admits no `:` in an id.
 *
 * Declaration order is the tie-break `composeAssignments` applies inside a
 * tier, so the cheap harnesses lead: the first available tier-1 entry works
 * and the strongest available entry of another vendor judges.
 *
 * @type {Readonly<Record<string, DiscoveryRuntime>>}
 */
export const DISCOVERY_RUNTIME_DEFINITIONS = Object.freeze({
  // `dsh` defaults no vendor and no provider route, so both are declared here
  // or nothing can build a command from this entry.
  "dsh-deepseek": {
    harness: "dsh",
    model: "deepseek-flash",
    vendor: "deepseek",
    config: { provider: "deepseek-official", "api_key.env_key": "DEEPSEEK_API_KEY" },
    tier: 1,
    costRank: 1,
  },
  "zcode-glm": {
    harness: "zcode",
    model: "glm-5.3",
    vendor: "zhipu",
    config: { "auth_token.env_key": "ZAI_API_KEY" },
    tier: 1,
    costRank: 1,
  },
  "agy-gemini": { harness: "agy", model: "gemini-3.8-flash-low", vendor: "google", tier: 1, costRank: 1 },
  "codex-gpt": { harness: "codex", model: "gpt-5.6", vendor: "openai", tier: 2, costRank: 2 },
  "claude-sonnet": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic", tier: 2, costRank: 2 },
});

/**
 * Discover runtime binaries without sending a model prompt. Tests can pass
 * recorded responses so no network call is needed.
 *
 * @param {Record<string, import("./harnesses/index.mjs").HarnessRuntime>} runtimes
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

