/**
 * Verification schema that is not part of a task packet (TECH-SPEC section 6.2,
 * rule 12).
 *
 * `contract.finalVerification` is the contract-wide proof that the phase as a
 * whole closes: the controller runs it before the judge on the phase-terminal
 * node (the node no other node depends on) and on any targeted-fix node, so no
 * final checkpoint is ever approved on partial verification. The persisted
 * node-snapshot shape for verification evidence lives here too, next to the
 * schema it records.
 */

import { Buffer } from "node:buffer";
import { validateVerificationCommands } from "./verification.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {import("./verification.mjs").VerificationCommand} VerificationCommand */

/**
 * Validate the optional contract-level `finalVerification` field. It carries
 * the full verification-command schema and nothing else.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {VerificationCommand[]|undefined}
 */
export function validateFinalVerification(value, label = "contract.finalVerification") {
  if (value === undefined) return undefined;
  return validateVerificationCommands(value, label);
}

/**
 * The contract's `finalVerification` commands when this node is the one that
 * closes the phase, otherwise none. A node is phase-terminal when no other
 * node in the contract depends on it; a targeted-fix node always qualifies
 * because it is the whole of its own contract's work.
 *
 * @param {{finalVerification?: VerificationCommand[], nodes: {id: string, dependsOn: string[]}[]}} contract
 * @param {{id: string, targetedFix?: boolean}} node
 * @returns {VerificationCommand[]}
 */
export function finalVerificationCommands(contract, node) {
  const commands = contract.finalVerification ?? [];
  if (commands.length === 0) return [];
  if (node.targetedFix === true) return commands;
  const hasDependant = contract.nodes.some((candidate) => candidate.dependsOn.includes(node.id));
  return hasDependant ? [] : commands;
}

/**
 * @param {unknown} value
 */
export function validateVerificationSnapshot(value) {
  assertObject(value, "node snapshot.verification");
  if (typeof value.passed !== "boolean" || !Array.isArray(value.commands) || value.commands.length > 32) {
    throw new TypeError("node snapshot.verification is invalid");
  }
  if (value.completed !== undefined && typeof value.completed !== "boolean") throw new TypeError("node snapshot.verification.completed is invalid");
  if (value.attempts !== undefined) {
    if (!Array.isArray(value.attempts) || value.attempts.length > 16) throw new TypeError("node snapshot.verification.attempts is invalid");
    const attempts = /** @type {unknown[]} */ (value.attempts);
    for (const [index, attempt] of attempts.entries()) validateVerificationAttempt(attempt, `node snapshot.verification.attempts[${index}]`);
  }
  if (value.error !== undefined && (typeof value.error !== "string" || Buffer.byteLength(value.error, "utf8") > 4096)) {
    throw new TypeError("node snapshot.verification.error is invalid");
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateVerificationAttempt(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set([
    "invocationId", "commandIndex", "attempt", "pid", "processStartToken", "processGroupId",
    "startedAt", "deadlineAt", "status", "completedAt", "result",
  ]), label);
  requireString(value.invocationId, `${label}.invocationId`);
  nonNegativeInteger(value.commandIndex, `${label}.commandIndex`);
  positiveInteger(value.attempt, `${label}.attempt`);
  if (value.pid !== null) requireInteger(value.pid, `${label}.pid`);
  if (value.processGroupId !== null) requireInteger(value.processGroupId, `${label}.processGroupId`);
  if (value.processStartToken !== null) requireString(value.processStartToken, `${label}.processStartToken`);
  requireTimestamp(value.startedAt, `${label}.startedAt`);
  requireTimestamp(value.deadlineAt, `${label}.deadlineAt`);
  if (!["active", "closed", "failed", "crashed", "canceled"].includes(/** @type {string} */ (value.status))) throw new TypeError(`${label}.status is invalid`);
  if (value.completedAt !== null) requireTimestamp(value.completedAt, `${label}.completedAt`);
  if (value.result !== null) {
    assertObject(value.result, `${label}.result`);
    const result = /** @type {JsonObject} */ (value.result);
    for (const key of ["stdout", "stderr", "error"]) {
      if (result[key] !== null && result[key] !== undefined && (typeof result[key] !== "string" || Buffer.byteLength(result[key], "utf8") > 2048)) throw new TypeError(`${label}.result.${key} is invalid`);
    }
    if (typeof result.passed !== "boolean") throw new TypeError(`${label}.result.passed is invalid`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is JsonObject}
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

/**
 * @param {JsonObject} value
 * @param {Set<string>} allowed
 * @param {string} label
 */
function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireInteger(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function nonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}
