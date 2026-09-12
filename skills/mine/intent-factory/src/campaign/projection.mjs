/**
 * The journal folded into current state: what is open, what is blocked, who is
 * attached, what was decided.
 *
 * A projection is a cache and is always rebuildable -- it is read incrementally
 * from the last complete journal byte, and a torn write is discarded rather than
 * half-folded. Nothing in the control path depends on it being present.
 */
import { JOURNAL_FILE, JOURNAL_TAIL_BYTES, PROJECTION_ACTIVE_CAP, PROJECTION_FILE, PROJECTION_LIST_CAP } from "./layout.mjs";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { errorCode } from "../util.mjs";
import { join } from "node:path";
import { readJournal, validateJournalEntry, withoutLegacyLivenessFields } from "./journal.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("./index.mjs").JournalEntry} JournalEntry */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./index.mjs").Projection} Projection */
/** @typedef {import("./index.mjs").ProjectionRecord} ProjectionRecord */

/**
 * @param {string} campaignPath
 * @param {Campaign} campaign
 * @returns {{state: Projection, cursor: number, byte: number, size: number, changed: boolean}}
 */
export function readProjectionState(campaignPath, campaign) {
  const path = join(campaignPath, PROJECTION_FILE);
  let stored = null;
  try {
    stored = /** @type {unknown} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const journalPath = join(campaignPath, JOURNAL_FILE);
  const journalSize = existsSync(journalPath) ? statSync(journalPath).size : 0;
  if (validProjectionRecord(stored) && stored.size <= journalSize) {
    try {
      const { entries, nextByte } = readJournalDelta(campaignPath, stored.byte);
      if (!entries.length) return { state: stored.projection, cursor: stored.cursor, byte: nextByte, size: stored.size, changed: false };
      return {
        state: foldEntries(stored.projection, entries),
        cursor: stored.cursor + entries.length,
        byte: nextByte,
        size: journalSize,
        changed: true,
      };
    } catch {
      // A delta that cannot be read means the projection is untrustworthy;
      // fall back to a full reparse of the append-only journal.
    }
  }
  const journal = readJournal(campaignPath);
  return {
    state: projectState(journal),
    cursor: journal.length,
    byte: completeJournalByte(campaignPath),
    size: journalSize,
    changed: true,
  };
}
/**
 * @param {unknown} stored
 * @returns {stored is ProjectionRecord}
 */
function validProjectionRecord(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  const record = /** @type {JsonObject} */ (stored);
  if (!Number.isInteger(record.cursor) || /** @type {number} */ (record.cursor) < 0) return false;
  if (!Number.isInteger(record.byte) || /** @type {number} */ (record.byte) < 0) return false;
  if (!Number.isInteger(record.size) || /** @type {number} */ (record.size) < 0) return false;
  // A record that claims folded entries but has no complete journal bytes is
  // the signature of a stale checkpoint written before the tail scan handled
  // partial lines beyond its window; re-folding from byte 0 would duplicate
  // list-based state. Treat it as untrustworthy and reparse from the journal.
  if (record.byte === 0 && /** @type {number} */ (record.cursor) > 0) return false;
  const state = record.projection;
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const projection = /** @type {JsonObject} */ (state);
  return (
    typeof projection.decisions === "object" && projection.decisions !== null && !Array.isArray(projection.decisions) &&
    typeof projection.questions === "object" && projection.questions !== null && !Array.isArray(projection.questions) &&
    Array.isArray(projection.constraints) &&
    Array.isArray(projection.intents) &&
    Array.isArray(projection.outcomes) &&
    Array.isArray(projection.sessions)
  );
}
/**
 * @param {string} campaignPath
 * @param {number} fromByte
 * @returns {{entries: JournalEntry[], nextByte: number}}
 */
function readJournalDelta(campaignPath, fromByte) {
  const path = join(campaignPath, JOURNAL_FILE);
  let size;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { entries: [], nextByte: fromByte };
    throw error;
  }
  if (fromByte >= size) return { entries: [], nextByte: fromByte };
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - fromByte);
    readSync(descriptor, buffer, 0, buffer.length, fromByte);
    /** @type {JournalEntry[]} */
    const entries = [];
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      let line = buffer.toString("utf8", start, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) {
        const entry = withoutLegacyLivenessFields(/** @type {JournalEntry} */ (JSON.parse(line)));
        validateJournalEntry(entry);
        entries.push(entry);
      }
      start = newline + 1;
    }
    return { entries, nextByte: fromByte + start };
  } finally {
    closeSync(descriptor);
  }
}
/**
 * @param {string} campaignPath
 * @returns {number}
 */
function completeJournalByte(campaignPath) {
  const path = join(campaignPath, JOURNAL_FILE);
  let size;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  if (!size) return 0;
  const descriptor = openSync(path, "r");
  try {
    // Scan backward in bounded windows so a partial trailing line longer than
    // the window cannot hide the boundary of the last complete line.
    let start = Math.max(0, size - JOURNAL_TAIL_BYTES);
    while (true) {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      readSync(descriptor, buffer, 0, length, start);
      if (buffer[buffer.length - 1] === 0x0a) return size;
      const newline = buffer.lastIndexOf(0x0a);
      if (newline !== -1) return start + newline + 1;
      if (start === 0) return 0;
      start = Math.max(0, start - JOURNAL_TAIL_BYTES);
    }
  } finally {
    closeSync(descriptor);
  }
}
/**
 * @returns {Projection}
 */
function emptyProjection() {
  return {
    updatedAt: null,
    decisions: {},
    questions: {},
    constraints: [],
    intents: [],
    outcomes: [],
    sessions: [],
    next: null,
    evicted: {},
  };
}
/**
 * @param {JournalEntry[]} journal
 * @returns {Projection}
 */
function projectState(journal) {
  return foldEntries(emptyProjection(), journal);
}
/**
 * @param {Projection} state
 * @param {JournalEntry[]} entries
 * @returns {Projection}
 */
function foldEntries(state, entries) {
  /** @type {Projection} */
  const next = {
    updatedAt: state.updatedAt,
    decisions: { ...state.decisions },
    questions: { ...state.questions },
    constraints: [...state.constraints],
    intents: [...state.intents],
    outcomes: [...state.outcomes],
    sessions: [...state.sessions],
    next: state.next,
    evicted: { ...state.evicted },
  };
  for (const entry of entries) {
    if (entry.type === "liveness") continue;
    next.updatedAt = entry.at;
    if (entry.type === "session.attached") next.sessions = pushCapped(next.sessions, entry, "sessions", next.evicted);
    else if (entry.type === "intent") next.intents = pushCapped(next.intents, entry, "intents", next.evicted);
    else if (entry.type === "decision" && entry.decisionId !== undefined) next.decisions = setCapped(next.decisions, entry.decisionId, entry, next.evicted, "decisions");
    else if (entry.type === "supersede" && entry.supersedes !== undefined) delete next.decisions[entry.supersedes];
    else if (entry.type === "constraint") next.constraints = pushCapped(next.constraints, entry, "constraints", next.evicted);
    else if (entry.type === "outcome" || entry.type === "retrospective") next.outcomes = pushCapped(next.outcomes, entry, "outcomes", next.evicted);
    else if (entry.type === "next") next.next = entry;
    else if (entry.type === "open-question" && entry.questionId !== undefined) next.questions = setCapped(next.questions, entry.questionId, entry, next.evicted, "questions");
    else if (entry.type === "question.resolved" && entry.questionId !== undefined) delete next.questions[entry.questionId];
  }
  return next;
}
/**
 * @param {JournalEntry[]} list
 * @param {JournalEntry} entry
 * @param {string} key
 * @param {Record<string, number>} evicted
 * @returns {JournalEntry[]}
 */
function pushCapped(list, entry, key, evicted) {
  const next = [...list, entry];
  if (next.length > PROJECTION_LIST_CAP) {
    const dropped = next.length - PROJECTION_LIST_CAP;
    evicted[key] = (evicted[key] ?? 0) + dropped;
    return next.slice(dropped);
  }
  return next;
}
/**
 * @param {Record<string, JournalEntry>} map
 * @param {string} key
 * @param {JournalEntry} entry
 * @param {Record<string, number>} evicted
 * @param {string} evictionKey
 * @returns {Record<string, JournalEntry>}
 */
function setCapped(map, key, entry, evicted, evictionKey) {
  /** @type {Record<string, JournalEntry>} */
  const next = { ...map, [key]: entry };
  const keys = Object.keys(next);
  if (keys.length > PROJECTION_ACTIVE_CAP) {
    const oldest = keys.reduce((left, right) => (next[left].at <= next[right].at ? left : right));
    delete next[oldest];
    evicted[evictionKey] = (evicted[evictionKey] ?? 0) + 1;
  }
  return next;
}
