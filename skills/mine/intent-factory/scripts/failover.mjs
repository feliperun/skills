/**
 * Worker failover edges: declared, synthesized, and cycle-checked.
 *
 * A contract that declares runtimeRules owns its routing outright — nothing
 * here synthesizes an edge behind it, because a declared rule set is a
 * statement about where a run is allowed to spend. A contract that declares
 * none still needs somewhere to go when a worker provider exhausts, so the
 * remaining healthy runtimes become an implicit chain ordered by their
 * declared costRank: cheapest untried runtime first, unranked runtimes last,
 * ties broken by declaration order. Synthesis is worker-only; a judge without
 * a declared rule stays on its gate runtime so a verdict is never quietly
 * arbitrated by a different model than the contract named.
 *
 * This module holds no contract.mjs import on purpose: contract.mjs imports
 * assertNoFailoverCycles from here, so the dependency has to run one way.
 */
import { driverCapabilities } from "./drivers/index.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {{id: string, type: string, runtime?: string, gate: {runtime?: string}}} EdgeNode */

/**
 * Every runtime id in cost order: declared costRank ascending, unranked last,
 * declaration order breaking ties so synthesis stays deterministic.
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
export function rankedRuntimeIds(contract) {
  return Object.entries(contract.runtimes)
    .map(([id, runtime], order) => ({ id, order, rank: runtime.costRank, unranked: runtime.costRank === undefined ? 1 : 0 }))
    .sort((left, right) => left.unranked - right.unranked
      || (left.unranked ? 0 : /** @type {number} */ (left.rank) - /** @type {number} */ (right.rank))
      || left.order - right.order)
    .map((entry) => entry.id);
}

/** Synthesis only fills the gap a contract left; a declared rule set suppresses it. @param {ValidatedContract} contract @returns {boolean} */
export function synthesisEnabled(contract) {
  return contract.runtimeRules.length === 0;
}

/**
 * The full synthesized chain out of one runtime, cheapest first.
 *
 * @param {ValidatedContract} contract
 * @param {"worker"|"judge"} role
 * @param {string} currentRuntime
 * @returns {string[]}
 */
export function synthesizedChain(contract, role, currentRuntime) {
  if (role !== "worker" || !synthesisEnabled(contract)) return [];
  return rankedRuntimeIds(contract).filter((id) => id !== currentRuntime);
}

/**
 * The next synthesized hop: the cheapest runtime this role has not already
 * burned in the current revision, or null when the chain is spent.
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
 * Hop is the failover budget: the runner caps it at the number of declared
 * runtimes so a run cannot walk its runtimes forever. Only an actual edge
 * spends from it. A quota-reset retry stays on the runtime the node already
 * warmed, so it costs no runtime and must cost no hop either — charging it
 * would let one wait consume the budget the later real edge needs, and a
 * two-runtime contract would hit the cap before ever reaching its second
 * runtime. The prior hop comes from the role's live override when one is open
 * in this revision, and otherwise from the high-water mark in its history.
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
 * One-hop failover targets out of `current`, declared rules first and the
 * synthesized chain after. Preflight walks these so every runtime a run could
 * actually spend on is capability-checked before the first provider starts.
 *
 * @param {ValidatedContract} contract
 * @param {{node: EdgeNode, role: "worker"|"judge", runtimeId: string}} current
 * @returns {RuntimeSnapshot[]}
 */
export function failoverTargets(contract, current) {
  /** @type {string[]} */
  const targets = [];
  for (const rule of contract.runtimeRules) {
    const match = rule.match;
    if (match.currentRuntime !== undefined && match.currentRuntime !== current.runtimeId) continue;
    if (match.role !== undefined && match.role !== current.role) continue;
    if (match.id !== undefined && match.id !== current.node.id) continue;
    if (match.type !== undefined && match.type !== current.node.type) continue;
    const declaredRuntime = current.role === "judge" ? current.node.gate.runtime : current.node.runtime;
    if (match.runtime !== undefined && match.runtime !== declaredRuntime) continue;
    targets.push(rule.runtime);
  }
  targets.push(...synthesizedChain(contract, current.role, current.runtimeId));
  return targets.map((id) => runtimeSnapshot(contract, id));
}

/**
 * Every worker edge the contract can take, for reporting and documentation.
 * A contract with declared rules reports exactly those; one without reports
 * the synthesized chain out of every runtime.
 *
 * @param {ValidatedContract} contract
 * @returns {{from: string, to: string, source: "declared"|"synthesized", ruleIndex?: number}[]}
 */
export function failoverEdges(contract) {
  if (!synthesisEnabled(contract)) {
    return contract.runtimeRules.map((rule, ruleIndex) => ({
      from: rule.match.currentRuntime ?? "*",
      to: rule.runtime,
      source: /** @type {"declared"} */ ("declared"),
      ruleIndex,
    }));
  }
  return rankedRuntimeIds(contract).flatMap((from) =>
    synthesizedChain(contract, "worker", from).map((to) => ({
      from,
      to,
      source: /** @type {"synthesized"} */ ("synthesized"),
    })));
}

/**
 * Merge one runtime's capability requirements into the reachable-runtime map.
 * The first snapshot wins; every later requirement set is accumulated, so a
 * runtime reached twice is still checked against both callers' demands.
 *
 * @param {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>} runtimes
 * @param {RuntimeSnapshot} runtime
 * @param {import("./drivers/index.mjs").CapabilityRequirements[]} requiredCapabilitySets
 */
export function addRuntimeRequirement(runtimes, runtime, requiredCapabilitySets) {
  const incoming = requiredCapabilitySets.filter((requirements) => requirements && Object.keys(requirements).length);
  const current = runtimes.get(runtime.id);
  if (!current) runtimes.set(runtime.id, { runtime, requiredCapabilitySets: incoming });
  else runtimes.set(runtime.id, { runtime: current.runtime, requiredCapabilitySets: [...current.requiredCapabilitySets, ...incoming] });
}

/**
 * Reject runtime failover cycles when their current-runtime edges are known.
 *
 * @param {unknown[]} rules
 */
export function assertNoFailoverCycles(rules) {
  const edges = new Map();
  for (const rule of rules) {
    const record = /** @type {Record<string, unknown>} */ (rule);
    const match = /** @type {Record<string, unknown>} */ (record.match);
    if (match.currentRuntime === undefined) continue;
    const current = /** @type {string} */ (match.currentRuntime);
    const target = /** @type {string} */ (record.runtime);
    const targets = edges.get(current) ?? [];
    targets.push(target);
    edges.set(current, targets);
  }
  const visiting = new Set();
  const visited = new Set();
  /** @param {string} runtime */
  const visit = (runtime) => {
    if (visiting.has(runtime)) throw new TypeError(`runtimeRules contain a cyclic failover at ${runtime}`);
    if (visited.has(runtime)) return;
    visiting.add(runtime);
    for (const next of edges.get(runtime) ?? []) visit(next);
    visiting.delete(runtime);
    visited.add(runtime);
  };
  for (const runtime of edges.keys()) visit(runtime);
}

/**
 * Resolve one declared runtime id into the snapshot shape every routing
 * decision hands on, capabilities included.
 *
 * @param {ValidatedContract} contract
 * @param {string} id
 * @returns {RuntimeSnapshot}
 */
export function runtimeSnapshot(contract, id) {
  const runtime = contract.runtimes[id];
  if (!runtime) throw new Error(`unknown persisted runtime: ${id}`);
  return { id, ...runtime, capabilities: driverCapabilities(runtime) };
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
