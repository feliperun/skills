/**
 * A declared runtime: its fields, the harness names it may name, whether its
 * permission mode can execute a command, and how a role resolves to one.
 *
 * Split out because both the contract validator and the snapshot validator need
 * it -- a persisted `runtime` on a node snapshot is the shape the contract
 * declared -- and the snapshot validator should not import the contract
 * validator to reach it.
 */
import { assertObject, nonNegativeNumber, positiveInteger, rejectUnknown, requireId, requireString, requireStringArray } from "./assert.mjs";
import { composeAssignments } from "../engine/runtime-discovery.mjs";
import { harnessCapabilities, resolvePermissionExecution, resolveVendor, validateCapabilityRequirements } from "../harnesses/index.mjs";
import { stableJson } from "../util.mjs";
/** @typedef {import("./index.mjs").NodeStatus} NodeStatus */
/** @typedef {import("../engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */

/** @typedef {import("./index.mjs").CapabilityRequirements} CapabilityRequirements */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./index.mjs").ValidatedRuntime} ValidatedRuntime */

const RUNTIME_FIELDS = new Set([
  "harness", "model", "reasoning", "sandbox", "permissionMode", "config", "printTimeout", "tools",
  "executable", "args", "versionArgs", "maxArgvPromptBytes", "requiredCapabilities", "costRank",
  "fallback", "vendor", "tier",
]);
const RUNTIME_HARNESSES = new Set(["claude", "codex", "agy", "dsh", "zcode", "exec-jsonl", "replay"]);
const SNAPSHOT_RUNTIME_FIELDS = new Set(["id", ...RUNTIME_FIELDS, "capabilities"]);
const CAPABILITY_FIELDS = new Set([
  "structuredOutput", "promptTransport", "sandbox", "permissions", "continuation", "tokenBudget", "costBudget",
  "usage", "cost", "toolPolicy", "streamsOutput", "maxArgvPromptBytes",
]);
/** @typedef {{id: string, type?: string, runtime?: string, gate: {runtime?: string}, status?: NodeStatus, errorCode?: string, currentRuntime?: string}} RoutableNode */
/** @typedef {{status?: NodeStatus, errorCode?: string, currentRuntime?: string, assignment?: string, availability?: Record<string, RuntimeAvailability>}} RoutingEvent */
/**
 * Resolve which runtime is currently assigned to a role. There is no dynamic
 * rerouting here — rerouting is owned entirely by `planRoute` (backoff.mjs),
 * which walks the one declared `fallback` hop off the current runtime.
 *
 * @param {ValidatedContract} contract @param {RoutableNode} node @param {"worker"|"judge"} role @param {RoutingEvent} event
 */
export function routeRuntime(contract, node, role = "worker", event = {}) {
  if (role !== "worker" && role !== "judge") throw new TypeError("route role must be worker or judge");
  const initialRuntimeId = role === "judge"
    ? node.gate.runtime ?? contract.runtimeDefaults?.judge
    : node.runtime ?? contract.runtimeDefaults?.worker;
  const composed = !initialRuntimeId && event.availability
    ? composeAssignments(contract, event.availability)[node.id]?.[role]
    : undefined;
  const runtimeId = event.currentRuntime ?? node.currentRuntime ?? event.assignment ?? composed ?? initialRuntimeId;
  requireRuntime(contract.runtimes, runtimeId, "routing current runtime");
  const runtime = contract.runtimes[/** @type {string} */ (runtimeId)];
  return { id: runtimeId, ...runtime, capabilities: harnessCapabilities(runtime) };
}
/**
 * @param {string} id
 * @param {unknown} runtime
 * @returns {ValidatedRuntime}
 */
export function validateRuntime(id, runtime) {
  requireId(id, `runtime ${id}`);
  assertObject(runtime, `runtime ${id}`);
  rejectUnknown(runtime, RUNTIME_FIELDS, `runtime ${id}`);
  validateRuntimeValues(runtime, `runtime ${id}`, runtime.harness === "exec-jsonl");
  const vendor = resolveVendor(/** @type {{harness: string, vendor?: string, config?: Record<string, unknown>}} */ (runtime));
  if (!vendor) throw new TypeError(`runtime ${id} has no resolvable vendor`);
  return /** @type {ValidatedRuntime} */ ({ ...runtime, vendor });
}
/**
 * @param {JsonObject} runtime
 * @param {string} label
 * @param {boolean} executableRequired
 */
function validateRuntimeValues(runtime, label, executableRequired) {
  const harness = runtime.harness;
  if (typeof harness !== "string" || !RUNTIME_HARNESSES.has(harness)) throw new TypeError(`${label}.harness is invalid`);
  requireString(runtime.model, `${label}.model`);
  if (runtime.reasoning !== undefined) requireString(runtime.reasoning, `${label}.reasoning`);
  if (runtime.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(/** @type {string} */ (runtime.sandbox))) {
    throw new TypeError(`${label}.sandbox is invalid`);
  }
  if (runtime.permissionMode !== undefined) requireString(runtime.permissionMode, `${label}.permissionMode`);
  if (runtime.config !== undefined && (!runtime.config || typeof runtime.config !== "object" || Array.isArray(runtime.config))) {
    throw new TypeError(`${label}.config must be an object`);
  }
  if (runtime.printTimeout !== undefined) requireString(runtime.printTimeout, `${label}.printTimeout`);
  if (runtime.tools !== undefined) requireStringArray(runtime.tools, `${label}.tools`);
  if (runtime.executable !== undefined) requireString(runtime.executable, `${label}.executable`);
  if (runtime.args !== undefined) requireStringArray(runtime.args, `${label}.args`);
  if (runtime.versionArgs !== undefined) requireStringArray(runtime.versionArgs, `${label}.versionArgs`);
  if (runtime.maxArgvPromptBytes !== undefined) positiveInteger(runtime.maxArgvPromptBytes, `${label}.maxArgvPromptBytes`);
  if (runtime.costRank !== undefined) nonNegativeNumber(runtime.costRank, `${label}.costRank`);
  if (runtime.tier !== undefined && !(
    (typeof runtime.tier === "number" && Number.isInteger(runtime.tier) && runtime.tier >= 0)
    || (typeof runtime.tier === "string" && runtime.tier.trim())
  )) throw new TypeError(`${label}.tier must be a non-negative integer or non-empty string`);
  if (runtime.fallback !== undefined) requireString(runtime.fallback, `${label}.fallback`);
  if (runtime.vendor !== undefined) requireString(runtime.vendor, `${label}.vendor`);
  validateCapabilityRequirements(
    /** @type {import("../harnesses/index.mjs").CapabilityRequirements|undefined} */ (runtime.requiredCapabilities),
    `${label}.requiredCapabilities`,
  );
  // The provider route belongs to the adapter, not to arbitrary provider
  // config: `sdk` hands it to `initialize` verbatim, so a dsh runtime without
  // one cannot start a turn.
  if (harness === "dsh") requireString(/** @type {Record<string, unknown>|undefined} */ (runtime.config)?.provider, `${label}.config.provider`);
  if (executableRequired && runtime.executable === undefined) requireString(runtime.executable, `${label}.executable`);
}
/**
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {string} runtimeId
 * @param {number} index
 * @param {string} nodeId
 * @param {string} label
 */
export function assertRuntimeExecutesCommands(runtimes, runtimeId, index, nodeId, label) {
  const runtime = runtimes[runtimeId];
  const execution = resolvePermissionExecution(runtime);
  if (execution.executes) return;
  throw new TypeError(
    `nodes[${index}] (${nodeId}) has verification but ${label} ${runtimeId} uses ${execution.field}=${execution.mode}; ${runtime.harness} executes commands only in ${execution.executingModes.join(", ")}`,
  );
}
/**
 * @param {unknown} value
 * @param {string} label
 */
export function validateSnapshotRuntime(value, label) {
  if (value === null) return;
  assertObject(value, label);
  rejectUnknown(value, SNAPSHOT_RUNTIME_FIELDS, label);
  requireId(value.id, `${label}.id`);
  validateRuntimeValues(value, label, value.harness === "exec-jsonl");
  validateCapabilities(/** @type {JsonObject} */ (value.capabilities), `${label}.capabilities`);
  const expected = harnessCapabilities(/** @type {{harness: string}} */ (value));
  if (stableJson(value.capabilities) !== stableJson(expected)) {
    throw new TypeError(`${label}.capabilities does not match its harness`);
  }
}
/**
 * @param {JsonObject} value
 * @param {string} label
 */
export function validateCapabilities(value, label) {
  assertObject(value, label);
  rejectUnknown(value, CAPABILITY_FIELDS, label);
  for (const name of ["structuredOutput", "sandbox", "permissions", "continuation", "tokenBudget", "costBudget", "usage", "cost", "toolPolicy", "streamsOutput"]) {
    if (typeof value[name] !== "boolean") throw new TypeError(`${label}.${name} must be boolean`);
  }
  if (!["stdin", "argv"].includes(/** @type {string} */ (value.promptTransport))) {
    throw new TypeError(`${label}.promptTransport is invalid`);
  }
  if (value.maxArgvPromptBytes !== undefined) {
    positiveInteger(value.maxArgvPromptBytes, `${label}.maxArgvPromptBytes`);
  }
}
/**
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {unknown} id
 * @param {string} label
 */
export function requireRuntime(runtimes, id, label) {
  if (typeof id !== "string" || !runtimes[id]) throw new TypeError(`${label} names an unknown runtime`);
}
