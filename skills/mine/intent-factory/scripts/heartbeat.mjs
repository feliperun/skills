import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendJournal, readJournal } from "./campaign.mjs";
import { writeJsonAtomic, writeTextAtomic } from "./store.mjs";

export const HEARTBEAT_FILE = "heartbeat.json";
export const HEARTBEAT_MAX_BYTES = 1024;
export const HEARTBEAT_SCHEMA_VERSION = 1;
export const HEARTBEAT_STATES = ["running", "waiting_gate", "blocked", "paused_quota", "done", "failed"];
export const LIVENESS_JOURNAL_TYPE = "liveness";
export const GOVERNANCE_METRICS_FILE = "governance-metrics.json";

const IDENTIFIER_BYTES = 128;
const STRING_FIELD_CHARS = 64;
const ATTENTION_CHARS = 80;
const GOVERNANCE_STALE_SEC = 2400;
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;
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
  "lastProgressAt",
  "attention",
  "generatedAt",
]);

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{type: "liveness", eventId: string, at: string, campaignId: string, runId: string, nodeId: string|null, phase: string, checkpointsDone: number, checkpointsTotal: number, runtime: string|null, state: string, lastProgressAt: string, attention: string|null}} LivenessFact */
/** @typedef {{schemaVersion: 1, campaignId: string, phase: string, checkpoints: {done: number, total: number}, activeNode: string|null, runtime: string|null, state: string, lastProgressAt: number, attention: string|null, generatedAt: number}} Heartbeat */

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
    lastProgressAt: unixSeconds(fact.lastProgressAt, "lastProgressAt"),
    attention: fact.attention === null ? null : truncateChars(fact.attention, ATTENTION_CHARS),
    generatedAt: unixSeconds(generatedAt, "generatedAt"),
  };
  const sorted = /** @type {Heartbeat} */ (sortObjectKeys(heartbeat));
  assertBounded(JSON.stringify(sorted), "heartbeat");
  return sorted;
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
  const payload = `${JSON.stringify(sortObjectKeys(heartbeat))}\n`;
  assertBounded(payload, "heartbeat.json");
  writeTextAtomic(heartbeatPath(campaignPath), payload);
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
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
    return Math.floor(ms / 1000);
  }
  if (!isStrictIsoTimestamp(String(value))) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  return Math.floor(Date.parse(String(value)) / 1000);
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
  if (!isStrictIsoTimestamp(value)) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
}

/**
 * Accept only the ISO-8601 shapes the runtime itself writes: full date and
 * time with optional 1-3 digit fraction and Z or numeric zone. Values like
 * "2026-09-02 12:00:00" that Date.parse happens to tolerate are rejected.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isStrictIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_8601_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
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

/**
 * Pure, deterministic projection of the run governance metrics (Addendum 02
 * B4.6). Inputs are timestamps and structured fields only; prose is never
 * parsed. Rates are rounded to 4 decimals.
 *
 * @param {{events?: unknown[], livenessFacts?: unknown[], outbox?: unknown[], now?: number, staleSec?: number}} [input]
 * @returns {{silentStallRate: number}}
 */
export function deriveGovernanceMetrics({ events = [], livenessFacts = [], outbox = [], now = Date.now(), staleSec = GOVERNANCE_STALE_SEC } = {}) {
  return {
    silentStallRate: silentStallRateOf(livenessFacts, outbox, staleSec),
  };
}

/**
 * Write the governance metrics for a campaign atomically next to its
 * heartbeat. The derivation is pure; this call only persists it.
 *
 * @param {string} campaignPath
 * @param {ReturnType<typeof deriveGovernanceMetrics>} metrics
 */
export function writeGovernanceMetrics(campaignPath, metrics) {
  writeJsonAtomic(join(campaignPath, GOVERNANCE_METRICS_FILE), metrics);
}

/**
 * Fraction of consecutive liveness facts of a nonterminal run whose gap
 * exceeded staleSec with no stale_liveness event between them. Terminal facts
 * (done/failed) end the measured sequence; 0 when there are no qualifying
 * gaps.
 *
 * @param {unknown[]} livenessFacts
 * @param {unknown[]} outbox
 * @param {number} staleSec
 * @returns {number}
 */
function silentStallRateOf(livenessFacts, outbox, staleSec) {
  /** @type {{atMs: number, eventId: string}[]} */
  const facts = [];
  for (const rawFact of livenessFacts) {
    const fact = jsonObjectOf(rawFact);
    if (fact === null || fact.type !== LIVENESS_JOURNAL_TYPE || typeof fact.at !== "string") continue;
    if (fact.state === "done" || fact.state === "failed") continue;
    const atMs = timestampMs(fact.at);
    if (!Number.isFinite(atMs)) continue;
    facts.push({ atMs, eventId: String(fact.eventId ?? "") });
  }
  facts.sort((left, right) => left.atMs - right.atMs || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
  let gaps = 0;
  let silent = 0;
  for (let index = 0; index + 1 < facts.length; index += 1) {
    const gapSeconds = (facts[index + 1].atMs - facts[index].atMs) / 1000;
    if (!(gapSeconds > staleSec)) continue;
    gaps += 1;
    if (!hasCoveringAttention(outbox, facts[index].atMs, facts[index + 1].atMs)) silent += 1;
  }
  return gaps === 0 ? 0 : round4(silent / gaps);
}

/**
 * @param {unknown[]} outbox
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {boolean}
 */
function hasCoveringAttention(outbox, fromMs, toMs) {
  for (const rawEvent of outbox) {
    const event = jsonObjectOf(rawEvent);
    if (event === null || event.type !== "run.attention") continue;
    const data = jsonObjectOf(event.data);
    if (data === null || data.code !== "stale_liveness") continue;
    const atMs = timestampMs(event.at);
    if (Number.isFinite(atMs) && atMs > fromMs && atMs <= toMs) return true;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {JsonObject|null}
 */
function jsonObjectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {JsonObject} */ (value) : null;
}

/** @param {unknown} value @returns {number} */
function timestampMs(value) {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** @param {number} value @returns {number} */
function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
