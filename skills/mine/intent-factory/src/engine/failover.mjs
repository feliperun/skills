/**
 * Worker and judge failover: one declared hop per runtime.
 *
 * Each runtime may declare `fallback`, naming at most one other runtime. A
 * role that exhausts its current runtime gets exactly that one hop — never a
 * chain, never a synthesized ordering over every other runtime in the
 * contract. Reachability is therefore always one enumeration away: the
 * runtime a role started on, and (if declared) the runtime its `fallback`
 * names. contract.mjs validates the field is never a self-loop; because a
 * hop is bounded at one, a multi-runtime cycle is structurally impossible.
 */
import { harnessCapabilities } from "../harnesses/index.mjs";
import { nextSameTierRuntime } from "./runtime-discovery.mjs";
import { routeRuntime } from "../contract/runtime.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {{id: string, type: string, runtime?: string, gate: {runtime?: string}}} EdgeNode */

/**
 * Every runtime id in cost order: declared costRank ascending, unranked last,
 * declaration order breaking ties so reporting stays deterministic.
 *
 * "Unranked last" is a separate sort key rather than a sentinel rank, because
 * costRank only has to be a finite non-negative number — a contract may
 * legitimately declare Number.MAX_SAFE_INTEGER or more, and any sentinel drawn
 * from the same number line would tie with it or lose to it. Ranked runtimes
 * therefore sort ahead of unranked ones by construction, whatever they cost.
 *
 * @param {ValidatedContract} contract
 * @returns {string[]}
 */
function rankedRuntimeIds(contract) {
  return Object.entries(contract.runtimes)
    .map(([id, runtime], order) => ({ id, order, rank: runtime.costRank, unranked: runtime.costRank === undefined ? 1 : 0 }))
    .sort((left, right) => left.unranked - right.unranked
      || (left.unranked ? 0 : /** @type {number} */ (left.rank) - /** @type {number} */ (right.rank))
      || left.order - right.order)
    .map((entry) => entry.id);
}

/**
 * The one-hop chain out of a runtime: its declared `fallback`, or nothing.
 *
 * @param {ValidatedContract} contract
 * @param {"worker"|"judge"} role unused; kept for signature stability across callers
 * @param {string} currentRuntime
 * @returns {string[]}
 */
export function synthesizedChain(contract, role, currentRuntime) {
  const fallback = contract.runtimes[currentRuntime]?.fallback;
  return fallback ? [fallback] : [];
}

/**
 * The next hop out of `currentRuntime`, or null when its one declared
 * fallback has already been attempted this revision.
 *
 * @param {ValidatedContract} contract
 * @param {"worker"|"judge"} role
 * @param {string} currentRuntime
 * @param {Iterable<string|null>} [attempted]
 * @returns {string|null}
 */
export function nextSynthesizedRuntime(contract, role, currentRuntime, attempted = []) {
  const spent = new Set(attempted);
  return synthesizedChain(contract, role, currentRuntime).find((id) => !spent.has(id)) ?? null;
}

/**
 * The hop number to record for this exhaustion, in the role's current revision.
 *
 * Hop is the failover budget: bounded at one, so a run cannot walk its
 * runtimes forever. Only an actual edge spends from it. A quota-reset retry
 * stays on the runtime the node already warmed, so it costs no runtime and
 * must cost no hop either — charging it would let one wait consume the
 * budget the later real edge needs.
 *
 * @param {{routing?: {currentOverride?: {role?: string, revision?: number, hop?: number}|null, history?: {role?: string, revision?: number, hop?: number}[]}|null}} state
 * @param {"worker"|"judge"} role
 * @param {number} revision
 * @param {{kind: "reset"|"failover"}} schedule
 * @returns {number}
 */
export function nextHop(state, role, revision, schedule) {
  const override = state.routing?.currentOverride;
  const previousHop = override?.role === role && (override.revision ?? revision) === revision
    ? override.hop ?? 0
    : Math.max(0, ...(state.routing?.history ?? [])
      .filter((entry) => entry.role === role && (entry.revision ?? revision) === revision)
      .map((entry) => entry.hop ?? 0));
  return schedule.kind === "reset" ? previousHop : previousHop + 1;
}

/**
 * The one-hop failover target out of `current`, if its runtime declares one.
 * Preflight walks this so the runtime a run could actually spend on is
 * capability-checked before the first provider starts — and only this one
 * hop, never the fallback's own fallback, since a node can take only one hop.
 *
 * @param {ValidatedContract} contract
 * @param {{node: EdgeNode, role: "worker"|"judge", runtimeId: string}} current
 * @param {{routing?: {assignments?: {worker?: string, judge?: string}, availability?: Record<string, {available: boolean, exhaustedUntil: string|null, reason: string}>}}|null} [state]
 * @returns {RuntimeSnapshot[]}
 */
export function failoverTargets(contract, current, state = null) {
  const declared = synthesizedChain(contract, current.role, current.runtimeId);
  if (declared.length) return declared.map((id) => runtimeSnapshot(contract, id));
  const attempted = new Set([current.runtimeId]);
  const composed = state ? nextSameTierRuntime(contract, state.routing ?? {}, current.role, current.runtimeId, attempted) : null;
  return composed ? [runtimeSnapshot(contract, composed)] : [];
}

/**
 * Every declared fallback edge, for reporting and documentation.
 *
 * @param {ValidatedContract} contract
 * @returns {{from: string, to: string, source: "declared"}[]}
 */
export function failoverEdges(contract) {
  return rankedRuntimeIds(contract)
    .filter((id) => contract.runtimes[id].fallback)
    .map((id) => ({ from: id, to: /** @type {string} */ (contract.runtimes[id].fallback), source: /** @type {"declared"} */ ("declared") }));
}

/**
 * Merge one runtime's capability requirements into the reachable-runtime map.
 * The first snapshot wins; every later requirement set is accumulated, so a
 * runtime reached twice is still checked against both callers' demands.
 *
 * @param {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("../harnesses/index.mjs").CapabilityRequirements[]}>} runtimes
 * @param {RuntimeSnapshot} runtime
 * @param {import("../harnesses/index.mjs").CapabilityRequirements[]} requiredCapabilitySets
 */
export function addRuntimeRequirement(runtimes, runtime, requiredCapabilitySets) {
  const incoming = requiredCapabilitySets.filter((requirements) => requirements && Object.keys(requirements).length);
  const current = runtimes.get(runtime.id);
  if (!current) runtimes.set(runtime.id, { runtime, requiredCapabilitySets: incoming });
  else runtimes.set(runtime.id, { runtime: current.runtime, requiredCapabilitySets: [...current.requiredCapabilitySets, ...incoming] });
}

/**
 * Resolve one declared runtime id into the snapshot shape every routing
 * decision hands on, capabilities and vendor included.
 *
 * @param {ValidatedContract} contract
 * @param {string} id
 * @returns {RuntimeSnapshot}
 */
export function runtimeSnapshot(contract, id) {
  const runtime = contract.runtimes[id];
  if (!runtime) throw new Error(`unknown persisted runtime: ${id}`);
  return { id, ...runtime, capabilities: harnessCapabilities(runtime) };
}

/**
 * A node parked on a failover or quota-reset backoff is not schedulable yet.
 * The window belongs to the role that opened it, so a worker backoff never
 * holds back a judge on the same node.
 *
 * @param {{routing?: {currentOverride?: {role?: string, backoffUntil?: string}|null}|null}} state
 * @param {string} phase
 * @returns {boolean}
 */
export function routingBackoffActive(state, phase) {
  const override = state.routing?.currentOverride;
  return Boolean(override?.role === phase && override.backoffUntil && Date.parse(override.backoffUntil) > Date.now());
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {"worker"|"judge"} role
 * @returns {RuntimeSnapshot}
 */
export function routeRuntimeForState(contract, node, state, role) {
  const override = state.routing?.currentOverride;
  if (override?.role === role && contract.runtimes[override.runtime]) {
    const runtime = contract.runtimes[override.runtime];
    return { id: override.runtime, ...runtime, capabilities: harnessCapabilities(runtime) };
  }
  const assigned = state.routing?.assignments?.[role];
  if (assigned && contract.runtimes[assigned]) {
    const runtime = contract.runtimes[assigned];
    return { id: assigned, ...runtime, capabilities: harnessCapabilities(runtime) };
  }
  return /** @type {RuntimeSnapshot} */ (routeRuntime(contract, node, role));
}
