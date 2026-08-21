import { Buffer } from "node:buffer";
import { validateTaskPacket } from "./task-packet.mjs";

export const RESULT_LIMITS = Object.freeze({
  bytes: 32 * 1024,
  summaryBytes: 4 * 1024,
  arrayItems: 32,
  itemBytes: 2 * 1024,
  artifactBytes: 16 * 1024,
  missingContextItems: 16,
});

const STATUSES = new Set(["done", "blocked_context"]);

/** @typedef {"done"|"blocked_context"} WorkerResultStatus */

/**
 * The worker-result protocol: exactly one JSON object returned as the only
 * content of the final worker message. `blocked_context` requires at least one
 * missingContext entry; `done` requires none.
 *
 * @typedef {{status: WorkerResultStatus, summary: string, changedFiles: string[], verification: string[], artifacts: string[], missingContext: string[]}} WorkerResult
 */

/**
 * @param {string} value
 * @returns {WorkerResult}
 */
export function parseWorkerResult(value) {
  if (typeof value !== "string") throw new TypeError("worker result must be JSON text");
  if (Buffer.byteLength(value, "utf8") > RESULT_LIMITS.bytes) {
    throw new TypeError(`worker result exceeds ${RESULT_LIMITS.bytes} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`worker result is invalid JSON: ${(error instanceof Error ? error.message : String(error))}`);
  }
  return validateWorkerResult(parsed);
}

/**
 * @param {unknown} value
 * @returns {WorkerResult}
 */
export function validateWorkerResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("worker result must be an object");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const expected = new Set(["status", "summary", "changedFiles", "verification", "artifacts", "missingContext"]);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) throw new TypeError(`worker result has unexpected field ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`worker result.${key} is required`);
  }
  if (record.status !== "done" && record.status !== "blocked_context") {
    throw new TypeError("worker result.status must be done or blocked_context");
  }
  requireText(record.summary, "worker result.summary", RESULT_LIMITS.summaryBytes);
  requireList(record.changedFiles, "worker result.changedFiles", RESULT_LIMITS.arrayItems, RESULT_LIMITS.itemBytes);
  requireList(record.verification, "worker result.verification", RESULT_LIMITS.arrayItems, RESULT_LIMITS.itemBytes);
  requireList(record.artifacts, "worker result.artifacts", RESULT_LIMITS.arrayItems, RESULT_LIMITS.artifactBytes);
  requireList(record.missingContext, "worker result.missingContext", RESULT_LIMITS.missingContextItems, RESULT_LIMITS.itemBytes);
  const missingContext = /** @type {string[]} */ (record.missingContext);
  if (record.status === "blocked_context" && missingContext.length === 0) {
    throw new TypeError("worker result.missingContext must not be empty for blocked_context");
  }
  if (record.status === "done" && missingContext.length > 0) {
    throw new TypeError("worker result.missingContext must be empty for done");
  }
  const normalized = {
    status: /** @type {WorkerResultStatus} */ (record.status),
    summary: /** @type {string} */ (record.summary),
    changedFiles: [.../** @type {string[]} */ (record.changedFiles)],
    verification: [.../** @type {string[]} */ (record.verification)],
    artifacts: [.../** @type {string[]} */ (record.artifacts)],
    missingContext: [...missingContext],
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > RESULT_LIMITS.bytes) {
    throw new TypeError(`worker result exceeds ${RESULT_LIMITS.bytes} bytes`);
  }
  return normalized;
}

/**
 * @param {string|WorkerResult} value
 * @param {string} cwd
 * @returns {WorkerResult & {discoveryPacket: import("./task-packet.mjs").TaskPacket}}
 */
export function parseDiscoveryResult(value, cwd) {
  const result = typeof value === "string" ? parseWorkerResult(value) : validateWorkerResult(value);
  if (result.status !== "done") throw new TypeError("discovery result must have status done");
  if (result.artifacts.length !== 1) throw new TypeError("discovery result must contain exactly one task packet artifact");
  let packet;
  try {
    packet = JSON.parse(result.artifacts[0]);
  } catch (error) {
    throw new TypeError(`discovery task packet artifact is invalid JSON: ${(error instanceof Error ? error.message : String(error))}`);
  }
  validateTaskPacket(packet, 0, cwd);
  if (packet.mode !== "execution") throw new TypeError("discovery task packet artifact must be execution mode");
  const normalized = { ...result };
  Object.defineProperty(normalized, "discoveryPacket", { value: packet, enumerable: false });
  return /** @type {WorkerResult & {discoveryPacket: import("./task-packet.mjs").TaskPacket}} */ (
    /** @type {unknown} */ (normalized)
  );
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxBytes
 */
function requireText(value, label, maxBytes) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxItems
 * @param {number} itemBytes
 */
function requireList(value, label, maxItems, itemBytes) {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be an array with at most ${maxItems} items`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    if (Buffer.byteLength(item, "utf8") > itemBytes) throw new TypeError(`${label}[${index}] exceeds ${itemBytes} bytes`);
  }
}
