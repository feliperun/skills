/**
 * Minimal deterministic event projector (TECH-SPEC section 3.1, Addendum 01
 * section 7). Every controller and supervisor enqueue is projected through
 * this module before it reaches the bounded campaign outbox: summary and next
 * come from fixed per-type templates and counters, never from model text
 * (rule 6), and requiresUser is explicit on every record and true only for
 * the three actionable cases (blocking question, exhausted routes with no
 * failover edge, campaign completion).
 */

import { createHash, randomUUID } from "node:crypto";

export const EVENT_SCHEMA_VERSION = 1;
export const EVENT_MAX_BYTES = 1024;
export const EVENT_DATA_MAX_BYTES = 512;

const EVENT_TYPES = new Set([
  "campaign.progress",
  "campaign.attention",
  "campaign.completed",
  "run.attention",
  "run.terminal",
  "node.terminal",
]);

const NEXT_PHRASES = new Set([
  "no action: pull-only progress",
  "run resume or supervise",
  "answer the blocking question",
  "campaign closed",
]);

const BLOCKING_CODE_TOKENS = ["blocked_context", "open-question"];
const EXHAUSTED_NO_FAILOVER_CODES = new Set([
  "provider_exhausted",
  "provider_exhausted_without_declared_failover",
  "provider_failover_cycle",
  "provider_failover_hop_cap",
  "provider_unavailable",
  "quota_exhausted",
  "payment_required",
  "rate_limit",
  "usage_limit",
]);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;
const RECORD_FIELDS = new Set(["schemaVersion", "eventId", "type", "campaignId", "runId", "nodeId", "at", "summary", "next", "requiresUser", "data"]);
const IDENTIFIER_MAX_BYTES = 256;

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{schemaVersion: 1, eventId: string, type: string, campaignId: string, runId: string|null, nodeId: string|null, at: string, summary: string, next: string, requiresUser: boolean, data: JsonObject}} ProjectedEvent */

/**
 * Classify an event by type, error code, and the remaining-failover-edge fact
 * the enqueue site holds. The blocking class covers a worker that returned
 * blocked_context (persisted as context_missing by the runner) and any
 * open-question code; the exhausted class covers provider exhaustion and is
 * actionable only when the enqueue site established that no unused failover
 * edge remains (remainingEdges === 0). A raw provider-class code projected
 * before the supervisor has evaluated configured failover routes carries no
 * remaining-edge fact and therefore never requires the user here.
 *
 * @param {string} type
 * @param {string|null|undefined} errorCode
 * @param {number|null|undefined} [remainingEdges]
 * @returns {{requiresUser: boolean, next: string}}
 */
export function classifyEvent(type, errorCode, remainingEdges) {
  const code = String(errorCode ?? "").toLowerCase();
  if (type === "campaign.completed") return { requiresUser: true, next: "campaign closed" };
  if (code === "context_missing" || BLOCKING_CODE_TOKENS.some((token) => code.includes(token))) {
    return { requiresUser: true, next: "answer the blocking question" };
  }
  if (EXHAUSTED_NO_FAILOVER_CODES.has(code) && remainingEdges === 0) return { requiresUser: true, next: "run resume or supervise" };
  return { requiresUser: false, next: "no action: pull-only progress" };
}

/**
 * @typedef {{type: string, campaignId: string, runId?: string|null, nodeId?: string|null, at?: string, key?: string, remainingEdges?: number|null, counters?: {done?: number, total?: number, attempt?: number, revisions?: number}, identifiers?: {runtimeId?: string|null, errorCode?: string|null}, data?: JsonObject}} ProjectEventInput
 */

/**
 * Derive one canonical bounded event record. The caller supplies the raw
 * material facts; eventId is generated here (deterministically from the
 * caller's enqueue key when one is given, else a fresh UUID), runId and
 * nodeId are carried into the record, and summary, next and requiresUser are
 * computed here. data is bounded to EVENT_DATA_MAX_BYTES and the canonical
 * JSON of the whole record is bounded to EVENT_MAX_BYTES: when the record is
 * oversized, summary is truncated first and data second.
 *
 * @param {ProjectEventInput} [options]
 * @returns {ProjectedEvent}
 */
export function projectEvent(options) {
  const {
    type,
    campaignId,
    runId = null,
    nodeId = null,
    at = new Date().toISOString(),
    key,
    remainingEdges,
    counters = {},
    identifiers = {},
    data = {},
  } = /** @type {ProjectEventInput} */ (options ?? {});
  if (!EVENT_TYPES.has(type)) throw new TypeError(`projectEvent: unknown event type ${type}`);
  if (typeof campaignId !== "string" || !campaignId.trim()) throw new TypeError("projectEvent: campaignId must be a non-empty string");
  if (typeof at !== "string" || !ISO_TIMESTAMP.test(at)) throw new TypeError("projectEvent: at must be an ISO-8601 timestamp");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("projectEvent: data must be a plain object");
  const countersValue = sanitizeCounters(counters);
  const identifiersValue = sanitizeIdentifiers(identifiers);
  const edgeCount = Number.isInteger(remainingEdges) && /** @type {number} */ (remainingEdges) >= 0 ? Number(remainingEdges) : undefined;
  const classified = classifyEvent(type, identifiersValue.errorCode, edgeCount);
  const runIdValue = runId === null || runId === undefined || String(runId).trim() === "" ? null : boundedText(runId, IDENTIFIER_MAX_BYTES);
  const nodeIdValue = nodeId === null || nodeId === undefined || String(nodeId).trim() === "" ? null : boundedText(nodeId, IDENTIFIER_MAX_BYTES);
  const eventIdValue = typeof key === "string" && key.length > 0 ? stableId(`${type}:${key}`) : randomUUID();
  let summary = renderSummary({
    type,
    campaignId: boundedText(campaignId, IDENTIFIER_MAX_BYTES),
    runId: runIdValue,
    nodeId: nodeIdValue,
    counters: countersValue,
    identifiers: identifiersValue,
  });
  let boundedData = boundData(data);
  /** @type {(candidateSummary: string, candidateData: JsonObject) => ProjectedEvent} */
  const build = (candidateSummary, candidateData) => ({
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: eventIdValue,
    type,
    campaignId,
    runId: runIdValue,
    nodeId: nodeIdValue,
    at,
    summary: candidateSummary,
    next: classified.next,
    requiresUser: classified.requiresUser,
    data: candidateData,
  });
  let record = build(summary, boundedData);
  if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  summary = shrinkSummary(summary, boundedData, build);
  record = build(summary, boundedData);
  if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  boundedData = shrinkData(boundedData, summary, build);
  record = build(summary, boundedData);
  if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  // The canonical record now carries runId/nodeId, so after data is at its
  // minimum the summary must shrink against that minimal data before a record
  // with long identifiers can fit.
  summary = shrinkSummary(summary, boundedData, build);
  record = build(summary, boundedData);
  if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  throw new TypeError(`projectEvent: canonical event exceeds ${EVENT_MAX_BYTES} bytes even fully truncated`);
}

/**
 * The persisted outbox shape: the canonical projected fields plus the
 * delivery envelope. Every field is optional here so any outbox record —
 * including one read back from disk — can be bounded without a cast.
 *
 * @typedef {{schemaVersion?: number, eventId?: string, type?: string, campaignId?: string, runId?: string|null, nodeId?: string|null, at?: string, summary?: string, next?: string, requiresUser?: boolean, data?: JsonObject, deliveredAt?: string|null, attempts?: number, lastError?: string|null, coalesceKey?: string}} PersistedEvent
 */

/**
 * Bound one persisted notification record — a projected event plus the
 * delivery envelope the outbox appends (deliveredAt, attempts, lastError and
 * the progress coalesce key) — to EVENT_MAX_BYTES. The canonical event is
 * already bounded when it is projected, so the envelope is the only field set
 * that can push a persisted record past the ceiling; it shrinks first
 * (lastError, then the coalesce key) and the summary only after that. The
 * record is mutated in place and returned, so no event is ever dropped as a
 * side effect of carrying delivery metadata.
 *
 * @param {PersistedEvent} record
 * @returns {PersistedEvent}
 */
export function boundEventRecord(record) {
  if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  if (typeof record.lastError === "string") {
    const kept = fitText(record, record.lastError, (value) => { record.lastError = value; });
    if (kept === "") record.lastError = null;
    if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  }
  if (typeof record.coalesceKey === "string") {
    const kept = fitText(record, record.coalesceKey, (value) => { record.coalesceKey = value; });
    if (kept === "") delete record.coalesceKey;
    if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  }
  if (typeof record.summary === "string" && record.summary.length > 0) {
    const kept = fitText(record, record.summary, (value) => { record.summary = value; });
    // validateEvent requires a non-empty summary: keep the ellipsis marker.
    if (kept === "") record.summary = "…";
    if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  }
  if (record.data && typeof record.data === "object" && Object.keys(record.data).length > 0) {
    // Last resort before failing: the bounded data object is replaced by its
    // minimal truncated form, which validateEvent still accepts.
    record.data = { truncated: true };
    if (bytesOf(record) <= EVENT_MAX_BYTES) return record;
  }
  throw new TypeError(`boundEventRecord: persisted record exceeds ${EVENT_MAX_BYTES} bytes even fully bounded`);
}

/**
 * Largest byte-prefix of `text` that keeps `record` inside EVENT_MAX_BYTES
 * once `apply` writes it back. The field is left holding that prefix.
 *
 * @param {PersistedEvent} record
 * @param {string} text
 * @param {(value: string) => void} apply
 * @returns {string}
 */
function fitText(record, text, apply) {
  let low = 0;
  let high = bytesOfText(text);
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = sliceText(text, middle);
    apply(candidate);
    if (bytesOf(record) <= EVENT_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  apply(best);
  return best;
}

/**
 * Strict validation of one projected record. Rejects unknown fields, missing
 * fields and out-of-contract values with a TypeError.
 *
 * @param {unknown} value
 * @returns {value is ProjectedEvent}
 */
export function validateEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("event record must be an object");
  }
  const record = /** @type {JsonObject} */ (value);
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.has(key)) throw new TypeError(`event record has unexpected field ${key}`);
  }
  if (record.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new TypeError(`event record.schemaVersion must be ${EVENT_SCHEMA_VERSION}`);
  }
  const type = /** @type {unknown} */ (record.type);
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
    throw new TypeError(`event record.type must be one of ${[...EVENT_TYPES].join(", ")}`);
  }
  const campaignId = /** @type {unknown} */ (record.campaignId);
  if (typeof campaignId !== "string" || !campaignId.trim()) {
    throw new TypeError("event record.campaignId must be a non-empty string");
  }
  const eventId = /** @type {unknown} */ (record.eventId);
  if (typeof eventId !== "string" || !eventId.trim() || eventId.length > 128) {
    throw new TypeError("event record.eventId must be a non-empty identifier");
  }
  for (const field of ["runId", "nodeId"]) {
    const value = /** @type {unknown} */ (record[field]);
    if (value !== null && typeof value !== "string") {
      throw new TypeError(`event record.${field} must be a string or null`);
    }
  }
  const at = /** @type {unknown} */ (record.at);
  if (typeof at !== "string" || !ISO_TIMESTAMP.test(at)) {
    throw new TypeError("event record.at must be an ISO-8601 timestamp");
  }
  const summary = /** @type {unknown} */ (record.summary);
  if (typeof summary !== "string" || !summary.trim()) {
    throw new TypeError("event record.summary must be a non-empty string");
  }
  const next = /** @type {unknown} */ (record.next);
  if (typeof next !== "string" || !NEXT_PHRASES.has(next)) {
    throw new TypeError(`event record.next must be one of ${[...NEXT_PHRASES].join(", ")}`);
  }
  const requiresUser = /** @type {unknown} */ (record.requiresUser);
  if (typeof requiresUser !== "boolean") {
    throw new TypeError("event record.requiresUser must be a boolean");
  }
  const data = /** @type {unknown} */ (record.data);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("event record.data must be a plain object");
  }
  if (bytesOfText(JSON.stringify(data)) > EVENT_DATA_MAX_BYTES) {
    throw new TypeError(`event record.data exceeds ${EVENT_DATA_MAX_BYTES} bytes`);
  }
  if (bytesOf(record) > EVENT_MAX_BYTES) {
    throw new TypeError(`event record exceeds ${EVENT_MAX_BYTES} bytes`);
  }
  return true;
}

/** @param {{type: string, campaignId: string, runId: string|null, nodeId: string|null, counters: Record<string, number>, identifiers: Record<string, string|null>}} input @returns {string} */
function renderSummary({ type, campaignId, runId, nodeId, counters, identifiers }) {
  const attempt = counters.attempt ?? 0;
  const revisions = counters.revisions ?? 0;
  const runtimeId = identifiers.runtimeId ?? null;
  const errorCode = identifiers.errorCode ?? null;
  const runtimePart = runtimeId === null ? "" : ` · runtime ${runtimeId}`;
  const codePart = errorCode === null ? "" : ` · ${errorCode}`;
  switch (type) {
    case "campaign.progress": {
      const subject = nodeId !== null ? `node ${nodeId}` : runId !== null ? `run ${runId}` : campaignId;
      return `${subject} progress · attempt ${attempt} · revisions ${revisions}${runtimePart}`;
    }
    case "node.terminal": {
      const subject = nodeId !== null ? `node ${nodeId}` : runId !== null ? `run ${runId}` : campaignId;
      return `${subject} terminal · attempt ${attempt} · revisions ${revisions}${codePart}`;
    }
    case "run.terminal": {
      const done = counters.done ?? 0;
      const total = counters.total ?? 0;
      return `run ${runId} terminal · ${done}/${total} done${total > done ? " · attention" : ""}`;
    }
    case "run.attention": {
      const nodePart = nodeId === null ? "" : ` · node ${nodeId}`;
      return `run ${runId} attention${nodePart}${codePart}`;
    }
    case "campaign.attention":
      return `campaign ${campaignId} attention${codePart}`;
    case "campaign.completed":
      return `campaign ${campaignId} completed`;
    default:
      throw new TypeError(`projectEvent: unknown event type ${type}`);
  }
}

/** @param {Record<string, unknown>|undefined} counters @returns {Record<string, number>} */
function sanitizeCounters(counters) {
  const value = counters && typeof counters === "object" && !Array.isArray(counters) ? counters : {};
  /** @type {Record<string, number>} */
  const result = {};
  for (const key of ["done", "total", "attempt", "revisions"]) {
    const raw = Number(value[key]);
    result[key] = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
  }
  return result;
}

/** @param {Record<string, unknown>|undefined} identifiers @returns {Record<string, string|null>} */
function sanitizeIdentifiers(identifiers) {
  const value = identifiers && typeof identifiers === "object" && !Array.isArray(identifiers) ? identifiers : {};
  return {
    runtimeId: optionalText(value.runtimeId),
    errorCode: optionalText(value.errorCode),
  };
}

/** @param {unknown} value @returns {string|null} */
function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length === 0 ? null : boundedText(text, IDENTIFIER_MAX_BYTES);
}

/** @param {unknown} data @returns {JsonObject} */
function boundData(data) {
  const text = JSON.stringify(data);
  if (bytesOfText(text) <= EVENT_DATA_MAX_BYTES) return /** @type {JsonObject} */ (data);
  return truncatedObject(text, EVENT_DATA_MAX_BYTES);
}

/**
 * Largest byte-prefix of the summary (with an ellipsis marker) that keeps the
 * record inside EVENT_MAX_BYTES with the current data.
 *
 * @param {string} summary
 * @param {JsonObject} data
 * @param {(summary: string, data: JsonObject) => ProjectedEvent} build
 * @returns {string}
 */
function shrinkSummary(summary, data, build) {
  const fixed = bytesOf(build("", data));
  const available = EVENT_MAX_BYTES - fixed;
  const minimum = 4;
  if (available <= minimum) return summary;
  let low = 1;
  let high = Math.min(bytesOfText(summary), available);
  let best = summary;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = sliceText(summary, middle);
    if (bytesOf(build(candidate, data)) <= EVENT_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Shrink data (via the bounded truncated-object form) until the record fits
 * with the current summary, then hand back the largest data that fits.
 *
 * @param {JsonObject} data
 * @param {string} summary
 * @param {(summary: string, data: JsonObject) => ProjectedEvent} build
 * @returns {JsonObject}
 */
function shrinkData(data, summary, build) {
  const originalText = JSON.stringify(data);
  const originalBytes = bytesOfText(originalText);
  const fixed = bytesOf(build(summary, {}));
  const available = EVENT_MAX_BYTES - fixed;
  if (available <= 8) return /** @type {JsonObject} */ ({});
  let low = 8;
  let high = Math.min(EVENT_DATA_MAX_BYTES, originalBytes);
  let best = /** @type {JsonObject} */ ({});
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = middle >= originalBytes ? data : truncatedObject(originalText, middle);
    if (bytesOf(build(summary, candidate)) <= EVENT_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Replace an oversized data object with the deterministic bounded
 * truncated-object form whose canonical JSON fits maxBytes.
 *
 * @param {string} text @param {number} maxBytes @returns {JsonObject}
 */
function truncatedObject(text, maxBytes) {
  let summary = sliceText(text, Math.max(8, maxBytes - 24));
  for (;;) {
    const candidate = /** @type {JsonObject} */ ({ truncated: true, summary });
    if (bytesOf(candidate) <= maxBytes || bytesOfText(summary) <= 8) return candidate;
    summary = sliceText(summary, bytesOfText(summary) - 16);
  }
}

/** @param {unknown} value @returns {number} */
function bytesOf(value) {
  return bytesOfText(canonicalJson(value));
}

/** @param {string} text @returns {number} */
function bytesOfText(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Byte-exact prefix truncation with an ellipsis marker: the result never
 * exceeds maxBytes.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function sliceText(text, maxBytes) {
  if (bytesOfText(text) <= maxBytes || maxBytes <= 0) return maxBytes <= 0 ? "" : text;
  if (maxBytes < 4) return "";
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes - 3);
  return `${buffer.toString("utf8")}…`;
}

/** @param {string} value @param {number} maxBytes @returns {string} */
function boundedText(value, maxBytes) {
  const text = value === null || value === undefined ? "" : String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ");
  return sliceText(text, maxBytes);
}

/** @param {string} value @returns {string} */
function stableId(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical JSON with object keys sorted, used for byte measurements and for
 * stable serialization checks.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
