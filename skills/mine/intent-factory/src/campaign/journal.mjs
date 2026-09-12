/**
 * The campaign journal: an append-only log of material events, and the cursor
 * machinery that lets a session read only what it has not seen.
 *
 * Append-only is the point. A campaign is the durable memory across sessions and
 * across agents, so the journal is never rewritten -- `watchJournal` and
 * `acknowledgeJournalEvent` move a per-session cursor over it instead, keyed by
 * the journal's own `eventId` so two sessions cannot consume each other's place.
 */
import { JOURNAL_FILE, JOURNAL_TEXT_BYTES, JOURNAL_WATCH_CURSOR_DIR, JOURNAL_WATCH_CURSOR_SCHEMA_VERSION } from "./layout.mjs";
import { boundedText, collapseLines } from "../util.mjs";
import { campaignIdOf } from "./record.mjs";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { requireText, requireTimestamp } from "../contract/assert.mjs";
import { writeJsonAtomic } from "../run/store.mjs";

/** @typedef {import("./index.mjs").JournalEntry} JournalEntry */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */

const JOURNAL_TYPES = new Set([
  "campaign.initialized",
  "campaign.closed",
  "run.registered",
  "session.attached",
  "intent",
  "decision",
  "supersede",
  "constraint",
  "outcome",
  "next",
  "open-question",
  "question.resolved",
  "retrospective",
  "liveness",
]);
const SESSION_REQUIRED_TYPES = new Set([
  "session.attached",
  "intent",
  "decision",
  "supersede",
  "constraint",
  "outcome",
  "next",
  "open-question",
  "question.resolved",
  "retrospective",
]);
const ENTRY_SHAPES = {
  "campaign.initialized": ["at", "type", "eventId"],
  "campaign.closed": ["at", "type", "eventId"],
  "run.registered": ["at", "type", "eventId", "runId"],
  "session.attached": ["at", "type", "eventId", "sessionId", "tool", "transcript", "transcriptUnavailable", "format", "cursor"],
  intent: ["at", "type", "eventId", "sessionId", "text"],
  decision: ["at", "type", "eventId", "sessionId", "decisionId", "text"],
  supersede: ["at", "type", "eventId", "sessionId", "supersedes", "text"],
  constraint: ["at", "type", "eventId", "sessionId", "text"],
  outcome: ["at", "type", "eventId", "sessionId", "text", "runId"],
  next: ["at", "type", "eventId", "sessionId", "text"],
  "open-question": ["at", "type", "eventId", "sessionId", "questionId", "text"],
  "question.resolved": ["at", "type", "eventId", "sessionId", "questionId", "text"],
  retrospective: ["at", "type", "eventId", "sessionId", "text"],
  liveness: ["at", "type", "eventId", "campaignId", "runId", "nodeId", "phase", "checkpointsDone", "checkpointsTotal", "runtime", "state", "lastProgressAt", "attention"],
};
/**
 * Fields a liveness fact carried before the budget ceiling was removed. A
 * historical journal (like the live campaign's own) still has lines shaped
 * like the pre-diet fact, so a read path drops them instead of rejecting the
 * whole file; nothing writes them any more.
 */
const LEGACY_LIVENESS_FIELDS = ["weightedUsed", "weightedCap"];
/**
 * @param {JournalEntry} entry
 * @returns {JournalEntry}
 */
export function withoutLegacyLivenessFields(entry) {
  if (entry.type !== "liveness") return entry;
  const cleaned = /** @type {JournalEntry} */ ({ ...entry });
  for (const field of LEGACY_LIVENESS_FIELDS) delete /** @type {JsonObject} */ (cleaned)[field];
  return cleaned;
}
/**
 * @param {string} campaignPath
 * @param {unknown} entry
 * @returns {{entry: JournalEntry, deduplicated: boolean}}
 */
export function appendJournal(campaignPath, entry) {
  validateJournalEntry(entry);
  const normalized = normalizeEntry(/** @type {JournalEntry} */ (entry));
  const journalPath = join(campaignPath, JOURNAL_FILE);
  if (existsSync(journalPath)) {
    for (const existing of readJournalForDedupe(campaignPath)) {
      if (existing.eventId === normalized.eventId) return { entry: existing, deduplicated: true };
    }
  }
  const descriptor = openSync(journalPath, "a");
  try {
    writeFileSync(descriptor, `${JSON.stringify(normalized)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return { entry: normalized, deduplicated: false };
}
/**
 * @param {string} campaignPath
 * @returns {JournalEntry[]}
 */
export function readJournalForDedupe(campaignPath) {
  const path = join(campaignPath, JOURNAL_FILE);
  if (!existsSync(path)) return [];
  /** @type {JournalEntry[]} */
  const entries = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      entries.push(/** @type {JournalEntry} */ (JSON.parse(line)));
    } catch {
      // A corrupt prior line cannot match an event id; appends must not be
      // blocked by it because the journal is the authoritative audit source.
    }
  }
  return entries;
}
/**
 * Incremental read of the campaign journal for a session sync/watch, keyed by
 * the journal's own `eventId`. Legacy `liveness` entries (the old heartbeat
 * mechanism used to append them; nothing does any more) are filtered out: they carry no
 * narrative a session needs to catch up on. Exactly one of `since` (a
 * stateless event id) or `cursor` (a durable per-watcher position) is
 * accepted; `cursor` advances atomically after the unseen list is built
 * unless `readOnly` is set, so a repeated read-only call returns no events.
 *
 * @param {string} campaignPath
 * @param {{since?: string, cursor?: string, readOnly?: boolean}} [options]
 * @returns {{campaignId: string, cursor: {cursorId: string, at: string, eventId: string}|null, events: JournalEntry[]}}
 */
export function watchJournal(campaignPath, options = {}) {
  if ((options.since !== undefined) === (options.cursor !== undefined)) {
    throw new TypeError("watch requires exactly one of --since or --cursor");
  }
  const entries = readJournal(campaignPath)
    .filter((entry) => entry.type !== "liveness")
    .sort(compareJournalPositions);
  let cursorId = null;
  /** @type {{at: string, eventId: string}} */
  let position;
  if (options.since !== undefined) {
    const since = String(options.since);
    const entry = entries.find((candidate) => candidate.eventId === since);
    if (!entry) throw new TypeError("--since event ID is not retained in the journal");
    position = { at: entry.at, eventId: entry.eventId };
  } else {
    cursorId = String(options.cursor);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(cursorId)) throw new TypeError("--cursor must be a safe identifier");
    position = readJournalCursor(campaignPath, cursorId);
  }
  const events = entries.filter((entry) => compareJournalPositions(entry, position) > 0);
  if (cursorId !== null && !options.readOnly && events.length > 0) {
    const last = events[events.length - 1];
    position = { at: last.at, eventId: last.eventId };
    writeJournalCursor(campaignPath, { cursorId, ...position });
  }
  return { campaignId: campaignIdOf(campaignPath), cursor: cursorId === null ? null : { cursorId, ...position }, events };
}
/**
 * Acknowledge one retained journal event by atomically advancing a durable
 * per-session cursor to it. `ack` is the only cursor writer: `watchJournal`
 * only advances when explicitly told to (never in read-only mode). Cursor
 * movement never regresses.
 *
 * @param {string} campaignPath
 * @param {string} cursorId
 * @param {string} eventId
 * @returns {{cursorId: string, at: string, eventId: string}}
 */
export function acknowledgeJournalEvent(campaignPath, cursorId, eventId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(cursorId)) throw new TypeError("--cursor must be a safe identifier");
  if (typeof eventId !== "string" || !eventId.trim()) throw new TypeError("--event-id requires a value");
  const current = readJournalCursor(campaignPath, cursorId);
  const found = readJournal(campaignPath).find((candidate) => candidate.eventId === eventId);
  let position;
  if (found) {
    position = { at: found.at, eventId: found.eventId };
  } else if (current.eventId !== "" && current.eventId === eventId) {
    position = current;
  } else {
    throw new TypeError("--event-id is not retained in the journal");
  }
  if (current.eventId !== "" && compareJournalPositions(position, current) <= 0) position = current;
  if (current.eventId === "" || compareJournalPositions(position, current) > 0) {
    writeJournalCursor(campaignPath, { cursorId, ...position });
  }
  return { cursorId, ...position };
}
/** @param {{at: string, eventId: string}} left @param {{at: string, eventId: string}} right @returns {number} */
function compareJournalPositions(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}
/** @param {string} campaignPath @param {string} cursorId @returns {{at: string, eventId: string}} */
function readJournalCursor(campaignPath, cursorId) {
  const path = join(campaignPath, JOURNAL_WATCH_CURSOR_DIR, `${cursorId}.json`);
  if (!existsSync(path)) return { at: "", eventId: "" };
  const record = /** @type {JsonObject} */ (JSON.parse(readFileSync(path, "utf8")));
  requireText(record.at, "journal watch cursor.at");
  if (typeof record.eventId !== "string") throw new TypeError("journal watch cursor.eventId must be a string");
  return { at: String(record.at), eventId: record.eventId };
}
/** @param {string} campaignPath @param {{cursorId: string, at: string, eventId: string}} position */
function writeJournalCursor(campaignPath, position) {
  const path = join(campaignPath, JOURNAL_WATCH_CURSOR_DIR, `${position.cursorId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, { schemaVersion: JOURNAL_WATCH_CURSOR_SCHEMA_VERSION, ...position, updatedAt: new Date().toISOString() });
}
/**
 * @param {string} campaignPath
 * @returns {JournalEntry[]}
 */
export function readJournal(campaignPath) {
  const path = join(campaignPath, JOURNAL_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  /** @type {JournalEntry[]} */
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) {
      // The newline is written atomically with the entry, so an unterminated
      // final line is never a committed entry; skip it regardless of whether
      // its bytes happen to parse.
      continue;
    }
    try {
      const entry = withoutLegacyLivenessFields(/** @type {JournalEntry} */ (JSON.parse(line)));
      validateJournalEntry(entry);
      entries.push(entry);
    } catch (error) {
      throw new Error(`journal line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries;
}
/**
 * @param {unknown} entry
 */
export function validateJournalEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("journal entry must be an object");
  }
  const record = /** @type {JsonObject} */ (entry);
  const type = /** @type {keyof typeof ENTRY_SHAPES} */ (record.type);
  if (!JOURNAL_TYPES.has(type)) {
    throw new TypeError(`journal entry type must be one of ${[...JOURNAL_TYPES].join(", ")}`);
  }
  const allowed = ENTRY_SHAPES[type];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TypeError(`journal entry ${type} has unexpected field ${key}`);
  }
  requireTimestamp(record.at, "entry.at");
  requireText(record.eventId, "entry.eventId");
  if (SESSION_REQUIRED_TYPES.has(type)) {
    requireText(record.sessionId, "entry.sessionId");
  }
  // "liveness" is a legacy type: the old heartbeat mechanism used to append it and nothing
  // writes it any more, but a durable journal may still carry old entries and
  // reading them must not throw. The shared allowed-field check above already
  // rejects an unexpected key; no deeper shape validation is needed for a type
  // nothing produces.
  if (type === "liveness") return;
  if (type === "session.attached") return validateSessionEntry(record);
  if (type === "run.registered") {
    requireText(record.runId, "entry.runId");
    return;
  }
  if (type === "campaign.initialized" || type === "campaign.closed") return;
  requireText(record.text, "entry.text");
  if (type === "decision") requireText(record.decisionId, "entry.decisionId");
  if (type === "supersede") requireText(record.supersedes, "entry.supersedes");
  if (type === "open-question" || type === "question.resolved") {
    requireText(record.questionId, "entry.questionId");
  }
  if (type === "outcome" && record.runId !== undefined) requireText(record.runId, "entry.runId");
}
/**
 * @param {JsonObject} entry
 */
function validateSessionEntry(entry) {
  requireText(entry.tool, "session.tool");
  requireText(entry.sessionId, "session.sessionId");
  if (typeof entry.transcriptUnavailable !== "boolean") {
    throw new TypeError("session.transcriptUnavailable must be a boolean");
  }
  if (entry.transcriptUnavailable) {
    if (entry.transcript !== null) throw new TypeError("unavailable session must not include a transcript path");
    if (entry.format !== null) throw new TypeError("unavailable session must not include a transcript format");
  } else {
    if (typeof entry.transcript !== "string" || !isAbsolute(entry.transcript)) {
      throw new TypeError("session.transcript must be an absolute path when available");
    }
    if (typeof entry.format !== "string" || !entry.format.trim()) {
      throw new TypeError("session.format must be a non-empty string when a transcript is available");
    }
  }
  if (entry.cursor !== null && entry.cursor !== undefined && (typeof entry.cursor !== "string" || !entry.cursor.trim())) {
    throw new TypeError("session.cursor must be null, omitted, or a non-empty string");
  }
}
/**
 * @param {JournalEntry} entry
 * @returns {JournalEntry}
 */
function normalizeEntry(entry) {
  /** @type {Record<string, unknown>} */
  const normalized = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "string") {
      normalized[key] = key === "text" ? normalizeText(value, "entry.text") : collapseLines(value);
    } else {
      normalized[key] = value;
    }
  }
  return /** @type {JournalEntry} */ (normalized);
}
/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxBytes
 * @returns {string}
 */
export function normalizeText(value, label, maxBytes = JOURNAL_TEXT_BYTES) {
  requireText(value, label);
  const collapsed = collapseLines(value);
  if (!collapsed) throw new TypeError(`${label} must not be blank`);
  return boundedText(collapsed, maxBytes);
}
