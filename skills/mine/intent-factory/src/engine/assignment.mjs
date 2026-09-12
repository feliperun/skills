/**
 * Who runs a node, and what a failed dependency costs its dependants.
 *
 * `runtimeAssignments` composes the worker/judge pair only for the roles a
 * contract left open, from the runtimes available right now -- which is why it
 * is called on a fresh run *and* on a resume, and why it lives in neither.
 * `blockDependents` walks the DAG forward from a terminal failure so a node
 * whose dependency died never dispatches at all.
 */
import { TERMINAL } from "./prompts.mjs";
import { composeAssignments, discoverRuntimes } from "./runtime-discovery.mjs";
import { transition } from "./state.mjs";

/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

/**
 * Resolve role assignments once at run creation. Discovery is used only for
 * omitted roles; the resulting pair is persisted so resume is deterministic.
 *
 * @param {ValidatedContract} contract
 * @returns {Promise<{assignments: Record<string, {worker: string, judge: string, composedWorker: boolean, composedJudge: boolean}>, availability: Record<string, import("./runtime-discovery.mjs").RuntimeAvailability>}>}
 */
export async function runtimeAssignments(contract) {
  const needsComposition = contract.nodes.some((node) =>
    (node.runtime === undefined && contract.runtimeDefaults?.worker === undefined)
    || (node.gate.enabled && node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined));
  const availability = needsComposition ? await discoverRuntimes(contract.runtimes, { cwd: contract.cwd }) : {};
  const assignments = composeAssignments(contract, availability);
  return {
    assignments: Object.fromEntries(Object.entries(assignments).map(([nodeId, assignment]) => {
      const node = contract.nodes.find((candidate) => candidate.id === nodeId);
      return [nodeId, {
        ...assignment,
        composedWorker: node?.runtime === undefined && contract.runtimeDefaults?.worker === undefined,
        composedJudge: Boolean(node?.gate.enabled && node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined),
      }];
    })),
    availability,
  };
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 */
export function blockDependents(contract, runDir, states, lock) {
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state) continue;
    if (state.status !== "pending") continue;
    const blockedBy = node.dependsOn.filter((id) => TERMINAL.has(states.get(id)?.status ?? "") && states.get(id)?.status !== "done");
    if (blockedBy.length) transition(runDir, state, "blocked", { phase: "dependency", blockedBy, error: { code: "dependency_failed", message: `blocked by ${blockedBy.join(", ")}` } }, lock);
  }
}
