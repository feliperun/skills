import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendJournal, readJournal } from "./campaign.mjs";
import { writeJsonAtomic } from "./store.mjs";

export const HEARTBEAT_FILE = "heartbeat.json";
export const HEARTBEAT_MAX_BYTES = 1024;
export const HEARTBEAT_SCHEMA_VERSION = 1;
export const HEARTBEAT_STATES = ["running", "waiting_gate", "blocked", "paused_quota", "done", "failed"];
export const LIVENESS_JOURNAL_TYPE = "liveness";

const IDENTIFIER_BYTES = 128;
const STRING_FIELD_CHARS = 64;
const ATTENTION_CHARS = 80;
const STATE_SET = new Set(HEARTBEAT_STATES);
const LIVENESS_FIELDS = new Set([
  "type",
  "eventId",
  "at",
  "campaignId",
  "runId",
  "nodeId",
  "phase",
  "checkpointsDone",
  "checkpointsTotal",
  "runtime",
  "state",
  "weightedUsed",
  "weightedCap",
  "lastProgressAt",
  "attention",
]);
const HEARTBEAT_FIELDS = new Set([
  "schemaVersion",
  "campaignId",
  "phase",
  "checkpoints",
  "activeNode",
  "runtime",
  "state",
  "weightedUsed",
  "weightedCap",
  "lastProgressAt",
  "attention",
  "generatedAt",
]);

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{type: "liveness", eventId: string, at: string, campaignId: string, runId: string, nodeId: string|null, phase: string, checkpointsDone: number, checkpointsTotal: number, runtime: string|null, state: string, weightedUsed: number, weightedCap: number, lastProgressAt: string, attention: string|null}} LivenessFact */
/** @typedef {{schemaVersion: 1, campaignId: string, phase: string, checkpoints: {done: number, total: number}, activeNode: string|null, runtime: string|null, state: string, weightedUsed: number, weightedCap: number, lastProgressAt: number, attention: string|null, generatedAt: number}} Heartbeat */

/**
 * Validate one liveness journal fact. Rejects unknown fields, missing fields
 * and out-of-contract values with a TypeError.
 *
 * @param {unknown} value
 */
export function validateLivenessFact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("liveness fact must be an object");
  }
  const fact = /** @type {JsonObject} */ (value);
  for (const key of Object.keys(fact)) {
    if (!LIVENESS_FIELDS.has(key)) throw new TypeError(`liveness fact has unexpected field ${key}`);
  }
  if (fact.type !== LIVENESS_JOURNAL_TYPE) {
    throw new TypeError(`liveness fact.type must be "${LIVENESS_JOURNAL_TYPE}"`);
  }
  requireTimestampString(fact.at, "liveness.at");
  requireNonEmptyString(fact.eventId, "liveness.eventId");
  requireIdentifier(fact.campaignId, "liveness.campaignId");
  requireIdentifier(fact.runId, "liveness.runId");
  optionalIdentifier(fact.nodeId, "liveness.nodeId");
  requireIdentifier(fact.phase, "liveness.phase");
  optionalIdentifier(fact.runtime, "liveness.runtime");
  requireNonNegativeInteger(fact.checkpointsDone, "liveness.checkpointsDone");
  requireNonNegativeInteger(fact.checkpointsTotal, "liveness.checkpointsTotal");
  requireNonNegativeInteger(fact.weightedUsed, "liveness.weightedUsed");
  requireNonNegativeInteger(fact.weightedCap, "liveness.weightedCap");
  if (!STATE_SET.has(/** @type {string} */ (fact.state))) {
    throw new TypeError(`liveness.state must be one of ${HEARTBEAT_STATES.join(", ")}`);
  }
  requireTimestampString(fact.lastProgressAt, "liveness.lastProgressAt");
  optionalBoundedString(fact.attention, "liveness.attention", ATTENTION_CHARS);
}

/**
 * Derive the bounded heartbeat object from one validated liveness fact. The
 * canonical key-sorted serialization must fit HEARTBEAT_MAX_BYTES; an
 * oversized derivation throws a TypeError naming the byte count.
 *
 * @param {LivenessFact} fact
 * @param {{generatedAt?: string|number|Date}} [options]
 * @returns {Heartbeat}
 */
export function deriveHeartbeat(fact, { generatedAt = new Date().toISOString() } = {}) {
  /** @type {Heartbeat} */
  const heartbeat = {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    campaignId: fact.campaignId,
    phase: truncateChars(fact.phase, STRING_FIELD_CHARS),
    checkpoints: { done: fact.checkpointsDone, total: fact.checkpointsTotal },
    activeNode: fact.nodeId === null ? null : truncateChars(fact.nodeId, STRING_FIELD_CHARS),
    runtime: fact.runtime === null ? null : truncateChars(fact.runtime, STRING_FIELD_CHARS),
    state: fact.state,
    weightedUsed: fact.weightedUsed,
    weightedCap: fact.weightedCap,
    lastProgressAt: unixSeconds(fact.lastProgressAt, "lastProgressAt"),
    attention: fact.attention === null ? null : truncateChars(fact.attention, ATTENTION_CHARS),
    generatedAt: unixSeconds(generatedAt, "generatedAt"),
  };
  assertBounded(JSON.stringify(sortObjectKeys(heartbeat)), "heartbeat");
  return heartbeat;
}

/**
 * Append the liveness fact to the journal first and only then write the
 * derived heartbeat atomically. When the append throws, the error propagates
 * and heartbeat.json stays pinned at its previous value.
 *
 * @param {string} campaignPath
 * @param {LivenessFact} fact
 * @param {{generatedAt?: string|number|Date, eventId?: string}} [options]
 * @returns {{entry: LivenessFact, heartbeat: Heartbeat, path: string}}
 */
export function recordLiveness(campaignPath, fact, { generatedAt = new Date().toISOString(), eventId } = {}) {
  const pending = /** @type {LivenessFact} */ (eventId === undefined ? fact : { ...fact, eventId });
  const appended = appendJournal(campaignPath, pending);
  const entry = /** @type {LivenessFact} */ (appended.entry);
  const heartbeat = deriveHeartbeat(entry, { generatedAt });
  writeBoundedHeartbeat(campaignPath, heartbeat);
  return { entry, heartbeat, path: heartbeatPath(campaignPath) };
}

/**
 * Rebuild heartbeat.json from the journal alone using the newest liveness
 * fact by file order. Returns null and writes nothing without a liveness fact.
 *
 * @param {string} campaignPath
 * @param {{generatedAt?: string|number|Date}} [options]
 * @returns {Heartbeat|null}
 */
export function rebuildHeartbeat(campaignPath, { generatedAt = new Date().toISOString() } = {}) {
  let newest = null;
  for (const entry of readJournal(campaignPath)) {
    if (entry.type === LIVENESS_JOURNAL_TYPE) newest = /** @type {LivenessFact} */ (entry);
  }
  if (newest === null) return null;
  const heartbeat = deriveHeartbeat(newest, { generatedAt });
  writeBoundedHeartbeat(campaignPath, heartbeat);
  return heartbeat;
}

/**
 * Read the parsed heartbeat, or null when the file is missing, unparsable,
 * oversized or fails shape validation. Never throws.
 *
 * @param {string} campaignPath
 * @returns {Heartbeat|null}
 */
export function readHeartbeat(campaignPath) {
  try {
    const path = heartbeatPath(campaignPath);
    if (!existsSync(path)) return null;
    if (statSync(path).size > HEARTBEAT_MAX_BYTES) return null;
    const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(path, "utf8")));
    return validateHeartbeat(parsed) ? /** @type {Heartbeat} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} campaignPath
 * @returns {string}
 */
function heartbeatPath(campaignPath) {
  return join(campaignPath, HEARTBEAT_FILE);
}

/**
 * @param {string} campaignPath
 * @param {Heartbeat} heartbeat
 */
function writeBoundedHeartbeat(campaignPath, heartbeat) {
  const payload = `${JSON.stringify(heartbeat, null, 2)}\n`;
  assertBounded(payload, "heartbeat.json");
  writeJsonAtomic(heartbeatPath(campaignPath), heartbeat);
}

/**
 * @param {string} serialized
 * @param {string} label
 */
function assertBounded(serialized, label) {
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > HEARTBEAT_MAX_BYTES) {
    throw new TypeError(`${label} exceeds ${HEARTBEAT_MAX_BYTES} bytes: ${bytes}`);
  }
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function truncateChars(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

/**
 * @param {string|number|Date} value
 * @param {string} label
 * @returns {number}
 */
function unixSeconds(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative integer of seconds`);
    }
    return value;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  return Math.floor(ms / 1000);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map((item) => sortObjectKeys(item));
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const sorted = {};
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortObjectKeys(record[key]);
  }
  return sorted;
}

/**
 * @param {unknown} value
 * @returns {value is Heartbeat}
 */
function validateHeartbeat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {JsonObject} */ (value);
  for (const key of Object.keys(record)) {
    if (!HEARTBEAT_FIELDS.has(key)) return false;
  }
  if (record.schemaVersion !== HEARTBEAT_SCHEMA_VERSION) return false;
  if (!isIdentifierString(record.campaignId)) return false;
  if (!isBoundedNonEmptyString(record.phase, STRING_FIELD_CHARS)) return false;
  const checkpoints = record.checkpoints;
  if (!checkpoints || typeof checkpoints !== "object" || Array.isArray(checkpoints)) return false;
  const checkpointRecord = /** @type {JsonObject} */ (checkpoints);
  if (Object.keys(checkpointRecord).length !== 2) return false;
  if (!isNonNegativeInteger(checkpointRecord.done) || !isNonNegativeInteger(checkpointRecord.total)) return false;
  if (!isNullableBoundedString(record.activeNode, STRING_FIELD_CHARS)) return false;
  if (!isNullableBoundedString(record.runtime, STRING_FIELD_CHARS)) return false;
  if (!STATE_SET.has(/** @type {string} */ (record.state))) return false;
  if (!isNonNegativeInteger(record.weightedUsed) || !isNonNegativeInteger(record.weightedCap)) return false;
  if (!isNonNegativeInteger(record.lastProgressAt) || !isNonNegativeInteger(record.generatedAt)) return false;
  if (record.attention !== null && (typeof record.attention !== "string" || Array.from(record.attention).length > ATTENTION_CHARS)) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isIdentifierString(value) {
  return typeof value === "string" && Boolean(value.trim()) && Buffer.byteLength(value, "utf8") <= IDENTIFIER_BYTES;
}

/**
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {boolean}
 */
function isBoundedNonEmptyString(value, maxChars) {
  return typeof value === "string" && Boolean(value.trim()) && Array.from(value).length <= maxChars;
}

/**
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {boolean}
 */
function isNullableBoundedString(value, maxChars) {
  return value === null || isBoundedNonEmptyString(value, maxChars);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireIdentifier(value, label) {
  requireNonEmptyString(value, label);
  if (Buffer.byteLength(/** @type {string} */ (value), "utf8") > IDENTIFIER_BYTES) {
    throw new TypeError(`${label} must not exceed ${IDENTIFIER_BYTES} bytes`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function optionalIdentifier(value, label) {
  if (value === null) return;
  requireIdentifier(value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxChars
 */
function optionalBoundedString(value, label, maxChars) {
  if (value === null) return;
  if (typeof value !== "string") throw new TypeError(`${label} must be null or a string`);
  if (Array.from(value).length > maxChars) throw new TypeError(`${label} must not exceed ${maxChars} characters`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireTimestampString(value, label) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}
