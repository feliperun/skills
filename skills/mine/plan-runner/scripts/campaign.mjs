import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "./store.mjs";

export const CAMPAIGN_DIR_NAME = "campaigns";
export const CAMPAIGN_FILE = "campaign.json";
export const JOURNAL_FILE = "journal.jsonl";
export const HANDOFF_FILE = "HANDOFF.md";
export const PROJECTION_FILE = "projection.json";
export const HANDOFF_LIMIT = 20;
export const HANDOFF_BYTES = 16 * 1024;
export const JOURNAL_TEXT_BYTES = 2 * 1024;
export const GOAL_TEXT_BYTES = 4 * 1024;
export const RENDER_NOTE_BYTES = 300;
const PROJECTION_LIST_CAP = 60;
const PROJECTION_ACTIVE_CAP = 100;
const JOURNAL_TAIL_BYTES = 4096;
const CRITICAL_FLOOR_BYTES = 512;
const ID_CAP_FLOOR = 48;

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
]);

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{id: string, goal: string, status: "active"|"closed", linkedRunIds: string[], createdAt: string, updatedAt: string, closedAt?: string}} Campaign */
/** @typedef {{type: string, eventId: string, at: string, sessionId?: string, text?: string, tool?: string, transcript?: string|null, transcriptUnavailable?: boolean, format?: string|null, cursor?: string|null, decisionId?: string, supersedes?: string, runId?: string, questionId?: string}} JournalEntry */
/** @typedef {{updatedAt: string|null, decisions: Record<string, JournalEntry>, questions: Record<string, JournalEntry>, constraints: JournalEntry[], intents: JournalEntry[], outcomes: JournalEntry[], sessions: JournalEntry[], next: JournalEntry|null, evicted: Record<string, number>}} Projection */
/** @typedef {{cursor: number, byte: number, size: number, projection: Projection}} ProjectionRecord */
/** @typedef {{id: string, exists: boolean, total: number, summary: string, attention: {id: string, status: string, note: string}[], unreadable: string|null}} RunSummary */
/** @typedef {{campaign: Campaign, updatedAt: string, linkedRuns: RunSummary[], activeDecisions: JournalEntry[], constraints: JournalEntry[], intents: JournalEntry[], outcomes: JournalEntry[], nextEntry: JournalEntry|null, questions: JournalEntry[], sessions: JournalEntry[], totals: {decisions: number, constraints: number, intents: number, outcomes: number, questions: number, sessions: number}, evicted: Record<string, number>}} Handoff */

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
};

/**
 * @param {string} runsDir
 * @returns {string}
 */
export function campaignsDir(runsDir) {
  return join(runsDir, CAMPAIGN_DIR_NAME);
}

/**
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {string}
 */
export function campaignDir(runsDir, campaignId) {
  requireId(campaignId, "campaignId");
  return join(campaignsDir(runsDir), campaignId);
}

/**
 * @param {string} runsDir
 * @param {{campaignId: string, goal: unknown, at?: string}} options
 * @returns {{path: string, campaign: Campaign}}
 */
export function initializeCampaign(runsDir, { campaignId, goal, at = new Date().toISOString() }) {
  requireId(campaignId, "campaignId");
  requireTimestamp(at, "at");
  const path = campaignDir(runsDir, campaignId);
  if (existsSync(path)) throw new Error(`campaign already exists: ${path}`);
  mkdirSync(path, { recursive: true });
  /** @type {Campaign} */
  const campaign = {
    id: campaignId,
    goal: normalizeText(goal, "goal", GOAL_TEXT_BYTES),
    status: "active",
    linkedRunIds: [],
    createdAt: at,
    updatedAt: at,
  };
  writeJsonAtomic(join(path, CAMPAIGN_FILE), campaign);
  appendJournal(path, { type: "campaign.initialized", at, eventId: randomUUID() });
  return { path, campaign };
}

/**
 * @param {string} runsDir
 * @returns {{campaigns: {path: string, campaign: Campaign}[], corrupt: {id: string, path: string, error: Error}[]}}
 */
export function discoverCampaigns(runsDir) {
  const root = campaignsDir(runsDir);
  if (!existsSync(root)) return { campaigns: [], corrupt: [] };
  /** @type {{path: string, campaign: Campaign}[]} */
  const campaigns = [];
  /** @type {{id: string, path: string, error: Error}[]} */
  const corrupt = [];
  for (const name of readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const path = join(root, name);
    if (!existsSync(join(path, CAMPAIGN_FILE))) {
      corrupt.push({ id: name, path, error: new Error(`campaign.json missing in ${path}`) });
      continue;
    }
    try {
      campaigns.push({ path, campaign: readCampaign(path) });
    } catch (error) {
      corrupt.push({ id: name, path, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return { campaigns, corrupt };
}

/**
 * @param {string} runsDir
 * @param {string|null|undefined} [campaignId]
 * @returns {{path: string, campaign: Campaign}}
 */
export function resolveCampaign(runsDir, campaignId) {
  if (campaignId !== undefined && campaignId !== null) {
    requireId(campaignId, "campaignId");
    const path = campaignDir(runsDir, campaignId);
    return { path, campaign: readCampaign(path) };
  }
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  if (corrupt.length) {
    throw new Error(`corrupt campaign entries: ${corrupt.map((entry) => entry.id).join(", ")}`);
  }
  const active = campaigns.filter((entry) => entry.campaign.status === "active");
  if (!active.length) {
    if (campaigns.length) {
      throw new Error(`no active campaign under ${campaignsDir(runsDir)}; all campaigns are closed`);
    }
    throw new Error(`no campaign found under ${campaignsDir(runsDir)}; initialize one with: runner.mjs campaign init`);
  }
  if (active.length > 1) {
    const ids = active.map((entry) => entry.campaign.id).join(", ");
    throw new Error(`multiple campaigns found (${ids}); choose one by id`);
  }
  return active[0];
}

/**
 * @param {string} path
 * @returns {Campaign}
 */
export function readCampaign(path) {
  let campaign;
  try {
    campaign = /** @type {unknown} */ (JSON.parse(readFileSync(join(path, CAMPAIGN_FILE), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`campaign not found: ${path}`);
    throw error;
  }
  validateCampaign(campaign);
  return /** @type {Campaign} */ (campaign);
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
 * @param {{at?: string, eventId?: string}} options
 * @returns {{path: string, campaign: Campaign}}
 */
export function closeCampaign(campaignPath, { at = new Date().toISOString(), eventId = randomUUID() } = {}) {
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign already closed: ${campaign.id}`);
  const closed = /** @type {Campaign} */ ({ ...campaign, status: "closed", closedAt: at, updatedAt: at });
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), closed);
  appendJournal(campaignPath, { type: "campaign.closed", at, eventId });
  return { path: campaignPath, campaign: closed };
}

/**
 * @param {string} campaignPath
 * @param {string} runId
 * @param {string} at
 * @returns {Campaign}
 */
export function registerRun(campaignPath, runId, at = new Date().toISOString()) {
  requireId(runId, "runId");
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  if (campaign.linkedRunIds.includes(runId)) {
    campaign.updatedAt = at;
    writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
    return campaign;
  }
  campaign.linkedRunIds.push(runId);
  campaign.updatedAt = at;
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
  appendJournal(campaignPath, { type: "run.registered", at, eventId: randomUUID(), runId });
  return campaign;
}

/**
 * @param {string} campaignPath
 * @param {string} runsDir
 * @returns {string}
 */
export function renderHandoff(campaignPath, runsDir) {
  const campaign = readCampaign(campaignPath);
  const { state, cursor, byte, size, changed } = readProjectionState(campaignPath, campaign);
  const handoff = handoffFromState(campaign, state, runsDir);
  const text = materializeHandoff(campaignPath, handoff);
  if (changed) writeJsonAtomic(join(campaignPath, PROJECTION_FILE), { cursor, byte, size, projection: state });
  return text;
}

/**
 * @param {string} runDir
 * @returns {string|null}
 */
export function renderRunHandoff(runDir) {
  const contractPath = join(runDir, "contract.json");
  if (!existsSync(contractPath)) return null;
  const contract = /** @type {JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8")));
  if (!contract.campaignId) return null;
  const runsDir = resolve(runDir, "..");
  const path = campaignDir(runsDir, /** @type {string} */ (contract.campaignId));
  if (!existsSync(join(path, CAMPAIGN_FILE))) return null;
  return renderHandoff(path, runsDir);
}

/**
 * @param {string} campaignPath
 * @returns {JournalEntry[]}
 */
function readJournalForDedupe(campaignPath) {
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
      const entry = /** @type {JournalEntry} */ (JSON.parse(line));
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
 * @param {Handoff} handoff
 * @returns {string}
 */
export function fitHandoff(handoff) {
  // The internal LineBudget already bounds every candidate to 16 KiB, so the
  // descending caps exist to shrink entry text until no critical entry is lost,
  // not to shrink the document. Return the first candidate with zero critical
  // loss; cap 0 always preserves at least a bare line per critical entry
  // because every rendered fragment, including identifiers, is bounded.
  for (const cap of [JOURNAL_TEXT_BYTES, 1024, 512, 256, 128, 64, 32, 0]) {
    const rendered = renderBudgeted(handoff, cap);
    if (rendered.criticalLost === 0) return rendered.text;
  }
  return renderBudgeted(handoff, 0).text;
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
 * @param {string} campaignPath
 * @param {Campaign} campaign
 * @returns {{state: Projection, cursor: number, byte: number, size: number, changed: boolean}}
 */
function readProjectionState(campaignPath, campaign) {
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
        const entry = /** @type {JournalEntry} */ (JSON.parse(line));
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
    next.updatedAt = entry.at;
    if (entry.type === "session.attached") next.sessions = pushCapped(next.sessions, entry, "sessions", next.evicted);
    else if (entry.type === "intent") next.intents = pushCapped(next.intents, entry, "intents", next.evicted);
    else if (entry.type === "decision" && entry.decisionId !== undefined) next.decisions = setCapped(next.decisions, entry.decisionId, entry, next.evicted, "decisions");
    else if (entry.type === "supersede" && entry.supersedes !== undefined) delete next.decisions[entry.supersedes];
    else if (entry.type === "constraint") next.constraints = pushCapped(next.constraints, entry, "constraints", next.evicted);
    else if (entry.type === "outcome") next.outcomes = pushCapped(next.outcomes, entry, "outcomes", next.evicted);
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

/**
 * @param {Campaign} campaign
 * @param {Projection} state
 * @param {string} runsDir
 * @returns {Handoff}
 */
function handoffFromState(campaign, state, runsDir) {
  return {
    campaign,
    updatedAt: state.updatedAt ?? campaign.updatedAt,
    linkedRuns: campaign.linkedRunIds.map((runId) => runSummary(join(runsDir, runId))),
    activeDecisions: Object.values(state.decisions),
    constraints: state.constraints,
    intents: lastN(state.intents),
    outcomes: lastN(state.outcomes),
    nextEntry: state.next,
    questions: Object.values(state.questions),
    sessions: state.sessions,
    totals: {
      decisions: Object.keys(state.decisions).length,
      constraints: state.constraints.length,
      intents: state.intents.length,
      outcomes: state.outcomes.length,
      questions: Object.keys(state.questions).length,
      sessions: state.sessions.length,
    },
    evicted: state.evicted,
  };
}

/**
 * @param {string} campaignPath
 * @param {Handoff} handoff
 * @returns {string}
 */
function materializeHandoff(campaignPath, handoff) {
  const text = fitHandoff(handoff);
  writeTextAtomic(join(campaignPath, HANDOFF_FILE), text);
  return text;
}

/**
 * @param {Handoff} handoff
 * @param {number} cap
 * @returns {{text: string, criticalLost: number}}
 */
function renderBudgeted(handoff, cap) {
  const {
    campaign, linkedRuns, activeDecisions, constraints, intents, outcomes, nextEntry, questions, sessions,
    totals = { decisions: 0, constraints: 0, intents: 0, outcomes: 0, questions: 0, sessions: 0 },
    evicted = { sessions: 0, decisions: 0, constraints: 0, questions: 0, intents: 0, outcomes: 0 },
  } = handoff;
  // Identifiers and attention notes keep a floor so critical entries stay
  // recognizable even when the descending text caps reach zero.
  const noteCap = Math.max(Math.min(RENDER_NOTE_BYTES, cap), ID_CAP_FLOOR);
  const idCap = Math.max(cap, ID_CAP_FLOOR);
  const budget = new LineBudget(HANDOFF_BYTES);
  addSection(budget, [
    `# campaign ${boundedText(campaign.id, idCap)} handoff`,
    "",
    `Updated: ${handoff.updatedAt}`,
    "",
    "## Goal",
    "",
    boundedText(campaign.goal, GOAL_TEXT_BYTES),
    "",
  ]);
  // Each critical section reserves a floor for every section that still
  // follows, so one greedy section can never starve a later critical one
  // (including attention-needed linked runs); low-priority history takes
  // whatever remains.
  const attentionPresent = hasAttentionRuns(linkedRuns);
  let sectionsLeft = 5 + (attentionPresent ? 1 : 0);
  const nextSection = () => {
    const left = sectionsLeft;
    sectionsLeft -= 1;
    return left;
  };
  let criticalLost = 0;
  // Stamped like every other journal section: this is the entry most likely to
  // go stale, because it names a run that later runs supersede. Without the
  // timestamp a reader cannot tell it apart from the current frontier.
  criticalLost += criticalSection(budget, "Latest next action", nextEntry ? [nextEntry] : [], (entry) => entryLine(entry, idCap, cap), 0, nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "Session lineage", sessions, (entry) => sessionLine(entry, idCap, cap), totals.sessions - sessions.length + (evicted.sessions ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "Active decisions", activeDecisions, (entry) => decisionLine(entry, idCap, cap), totals.decisions - activeDecisions.length + (evicted.decisions ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "User constraints", constraints, (entry) => entryLine(entry, idCap, cap), totals.constraints - constraints.length + (evicted.constraints ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "Open questions", questions, (entry) => entryLine(entry, idCap, cap), totals.questions - questions.length + (evicted.questions ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += renderLinkedRuns(budget, linkedRuns, noteCap, idCap, attentionPresent ? nextSection() : null, CRITICAL_FLOOR_BYTES);
  lowPriorityLines(budget, "Recent user intents", intents, (entry) => entryLine(entry, idCap, cap), totals.intents - intents.length + (evicted.intents ?? 0));
  lowPriorityLines(budget, "Attempts and outcomes", outcomes, (entry) => outcomeLine(entry, idCap, cap), totals.outcomes - outcomes.length + (evicted.outcomes ?? 0));
  return { text: `${budget.lines.join("\n")}\n`, criticalLost };
}

/**
 * @param {RunSummary[]} linkedRuns
 * @returns {boolean}
 */
function hasAttentionRuns(linkedRuns) {
  return linkedRuns.some((run) => !run.exists || run.unreadable || run.attention.length > 0);
}

/**
 * @param {LineBudget} budget
 * @param {string[]} lines
 * @returns {boolean}
 */
function addSection(budget, lines) {
  if (!lines.length) return true;
  let total = 0;
  for (const line of lines) total += Buffer.byteLength(line, "utf8") + 1;
  if (budget.used + total > budget.limit) return false;
  for (const line of lines) budget.add(line);
  return true;
}

// Critical sections must never be dropped wholesale: when the remaining budget
// cannot hold every entry, keep the latest entries that fit and note the rest.
// Returns 1 when a non-empty section loses every entry (nothing but the
// placeholder was rendered), 0 otherwise; a section that keeps its latest
// entries plus an omission note is considered preserved. The floor keeps later
// critical sections from being starved by earlier greedy ones.
/**
 * @param {LineBudget} budget
 * @param {string} title
 * @param {JournalEntry[]} entries
 * @param {(entry: JournalEntry) => string} lineFor
 * @param {number} omittedCount
 * @param {number} sectionsLeft
 * @param {number} floor
 * @returns {0|1}
 */
function criticalSection(budget, title, entries, lineFor, omittedCount, sectionsLeft, floor) {
  budget.add(`## ${title}`);
  budget.add("");
  if (!entries.length) {
    budget.add("None.");
    budget.add("");
    return 0;
  }
  const kept = budgetedLines(budget, entries.map((entry) => `- ${lineFor(entry)}`), title.toLowerCase(), omittedCount, criticalLimit(budget, sectionsLeft, floor));
  budget.add("");
  return kept === 0 ? 1 : 0;
}

/**
 * @param {LineBudget} budget
 * @param {number} sectionsLeft
 * @param {number} floor
 * @returns {number}
 */
function criticalLimit(budget, sectionsLeft, floor) {
  // An absolute byte ceiling: budgetedLines already compares against the used
  // budget, so the floor reservation must not subtract it a second time.
  return budget.limit - floor * Math.max(0, sectionsLeft - 1);
}

/**
 * @param {LineBudget} budget
 * @param {string} title
 * @param {JournalEntry[]} entries
 * @param {(entry: JournalEntry) => string} lineFor
 * @param {number} omittedCount
 */
function lowPriorityLines(budget, title, entries, lineFor, omittedCount) {
  if (!budget.addAll([`## ${title}`, ""])) return;
  if (!entries.length) {
    budget.addAll(["None.", ""]);
    return;
  }
  budgetedLines(budget, entries.map((entry) => `- ${lineFor(entry)}`), title.toLowerCase(), omittedCount);
  budget.add("");
}

// Keep the latest complete lines that fit; older lines are summarized, never
// silently dropped. Returns the number of entries actually rendered.
/**
 * @param {LineBudget} budget
 * @param {string[]} lines
 * @param {string} label
 * @param {number} omittedCount
 * @param {number} limit
 * @returns {number}
 */
function budgetedLines(budget, lines, label, omittedCount, limit = budget.limit) {
  let kept = 0;
  let projected = budget.used;
  while (kept < lines.length) {
    const bytes = Buffer.byteLength(lines[lines.length - 1 - kept], "utf8") + 1;
    if (projected + bytes > limit) break;
    projected += bytes;
    kept += 1;
  }
  const dropped = lines.length - kept + omittedCount;
  if (dropped > 0) {
    // Reserve room for the omission note so it is never silently dropped.
    while (kept > 0 && projected + Buffer.byteLength(`- ${dropped} earlier ${label} omitted`, "utf8") + 1 > limit) {
      kept -= 1;
      projected -= Buffer.byteLength(lines[lines.length - 1 - kept], "utf8") + 1;
    }
  }
  if (kept === 0) {
    budget.add(`- (none fits the remaining budget)`);
  } else {
    for (let index = lines.length - kept; index < lines.length; index += 1) budget.add(lines[index]);
  }
  if (dropped > 0) budget.add(`- ${dropped} earlier ${label} omitted`);
  return kept;
}

// Linked runs are critical when a run needs attention: losing the whole
// section or every line of an attention group counts as critical loss so the
// cap loop shrinks text until attention-needed states survive. A partially
// kept group (summary plus latest detail lines plus an omission note) is
// considered preserved, matching the other critical sections.
/**
 * @param {LineBudget} budget
 * @param {RunSummary[]} linkedRuns
 * @param {number} noteCap
 * @param {number} idCap
 * @param {number|null} sectionsLeft
 * @param {number} floor
 * @returns {0|1}
 */
function renderLinkedRuns(budget, linkedRuns, noteCap, idCap, sectionsLeft, floor) {
  const runs = buildRunsGroups(linkedRuns, noteCap, idCap);
  if (runs.empty) {
    addSection(budget, ["## Linked runs", "", "No linked runs yet.", ""]);
    return 0;
  }
  const limit = sectionsLeft === null || sectionsLeft === undefined ? budget.limit : criticalLimit(budget, sectionsLeft, floor);
  const headingFits = addSection(budget, ["## Linked runs", ""]);
  const attentionKept = headingFits ? budgetedGroupLines(budget, runs.attention, "attention-needed run states", limit) : 0;
  if (runs.attention.length && attentionKept === 0) return 1;
  if (headingFits) budgetedGroupLines(budget, runs.regular, "run summaries", limit);
  budget.add("");
  return 0;
}

// Runs are rendered as whole groups (summary line plus node detail lines) so a
// run is never cut midway. When a group does not fully fit, its summary line
// and the latest detail lines are kept and the rest is summarized. Returns the
// number of lines actually added to the budget.
/**
 * @param {LineBudget} budget
 * @param {string[][]} groups
 * @param {string} label
 * @param {number} limit
 * @returns {number}
 */
function budgetedGroupLines(budget, groups, label, limit = budget.limit) {
  const rendered = [];
  let projected = budget.used;
  let omitted = 0;
  let added = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const lines = groups[index];
    if (projected + totalLineBytes(lines) <= limit) {
      projected += totalLineBytes(lines);
      rendered.unshift(lines);
      added += lines.length;
      continue;
    }
    const kept = fitGroupLines(lines, projected, limit);
    if (kept.length) {
      projected += totalLineBytes(kept);
      rendered.unshift(kept);
      added += kept.length;
      omitted += lines.length - kept.length;
      continue;
    }
    omitted += lines.length;
    for (let older = index - 1; older >= 0; older -= 1) omitted += groups[older].length;
    break;
  }
  if (omitted > 0) {
    // Reserve room for the omission note so it is never silently dropped.
    while (rendered.length && projected + Buffer.byteLength(`- ${omitted} earlier ${label} omitted`, "utf8") + 1 > limit) {
      const lines = rendered.shift() ?? [];
      projected -= totalLineBytes(lines);
      added -= lines.length;
      omitted += lines.length;
    }
  }
  for (const lines of rendered) {
    for (const line of lines) budget.add(line);
  }
  if (omitted > 0) budget.add(`- ${omitted} earlier ${label} omitted`);
  return added;
}

/**
 * @param {string[]} lines
 * @param {number} projected
 * @param {number} limit
 * @returns {string[]}
 */
function fitGroupLines(lines, projected, limit) {
  const leadBytes = Buffer.byteLength(lines[0], "utf8") + 1;
  if (projected + leadBytes > limit) return [];
  const detail = [];
  projected += leadBytes;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (projected + bytes > limit) break;
    projected += bytes;
    detail.unshift(lines[index]);
  }
  return [lines[0], ...detail];
}

/**
 * @param {string[]} lines
 * @returns {number}
 */
function totalLineBytes(lines) {
  let bytes = 0;
  for (const line of lines) bytes += Buffer.byteLength(line, "utf8") + 1;
  return bytes;
}

/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function sessionLine(entry, idCap, textCap) {
  const tool = boundedText(entry.tool, idCap);
  const sessionId = boundedText(entry.sessionId, idCap);
  const transcript = entry.transcriptUnavailable ? "unavailable" : boundedText(entry.transcript, Math.max(idCap, 128));
  const format = boundedText(entry.format ?? "-", idCap);
  const cursor = boundedText(entry.cursor ?? "-", idCap);
  return `${tool} ${sessionId} · transcript: ${transcript} · format: ${format} · cursor: ${cursor}`;
}

/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function decisionLine(entry, idCap, textCap) {
  return `[${boundedText(entry.decisionId, idCap)}] ${boundedText(entry.text, textCap)} · ${boundedText(entry.sessionId, idCap)} · ${boundedText(entry.at, idCap)}`;
}

/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function entryLine(entry, idCap, textCap) {
  return `${boundedText(entry.text, textCap)} · ${boundedText(entry.sessionId, idCap)} · ${boundedText(entry.at, idCap)}`;
}

/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function outcomeLine(entry, idCap, textCap) {
  const run = entry.runId ? `run ${boundedText(entry.runId, idCap)}: ` : "";
  return `${run}${boundedText(entry.text, textCap)} · ${boundedText(entry.sessionId, idCap)} · ${boundedText(entry.at, idCap)}`;
}

/**
 * @param {RunSummary[]} linkedRuns
 * @param {number} noteCap
 * @param {number} idCap
 * @returns {{empty: boolean, attention: string[][], regular: string[][]}}
 */
function buildRunsGroups(linkedRuns, noteCap, idCap) {
  if (!linkedRuns.length) return { empty: true, attention: [], regular: [] };
  const attention = [];
  const regular = [];
  for (const run of linkedRuns) {
    const id = boundedText(run.id, idCap);
    if (!run.exists) {
      attention.push([`- ${id}: run directory missing`]);
      continue;
    }
    if (run.unreadable) {
      attention.push([`- ${id}: unreadable · ${boundedText(run.unreadable, noteCap)}`]);
      continue;
    }
    if (!run.total) {
      regular.push([`- ${id}: no node states yet`]);
      continue;
    }
    const lines = [`- ${id}: ${boundedText(run.summary, idCap)}`];
    if (run.attention.length) {
      for (const node of run.attention) {
        const nodeId = boundedText(node.id, idCap);
        const status = boundedText(node.status, idCap);
        lines.push(`  - ${nodeId}: ${status}${node.note ? ` · ${boundedText(node.note, noteCap)}` : ""}`);
      }
      attention.push(lines);
    } else {
      regular.push(lines);
    }
  }
  return { empty: false, attention, regular };
}

/**
 * @param {string} runDir
 * @returns {RunSummary}
 */
function runSummary(runDir) {
  const id = basename(runDir);
  const nodeDir = join(runDir, "nodes");
  if (!existsSync(nodeDir)) return { id, exists: false, total: 0, summary: "", attention: [], unreadable: null };
  let nodes;
  try {
    nodes = readdirSync(nodeDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => /** @type {JsonObject} */ (JSON.parse(readFileSync(join(nodeDir, name), "utf8"))));
  } catch (error) {
    return { id, exists: true, total: 0, summary: "unreadable", attention: [], unreadable: `cannot read node states: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!nodes.length) return { id, exists: true, total: 0, summary: "no node states yet", attention: [], unreadable: null };
  const counts = new Map();
  for (const node of nodes) counts.set(/** @type {string} */ (node.status), (counts.get(/** @type {string} */ (node.status)) ?? 0) + 1);
  const summary = `${nodes.length} nodes · ${[...counts].map(([status, count]) => `${count} ${status}`).join(" · ")}`;
  const attention = nodes
    .filter((node) => !["pending", "running", "done"].includes(/** @type {string} */ (node.status)))
    .map((node) => {
      const gate = /** @type {JsonObject|null|undefined} */ (node.gate);
      const error = /** @type {JsonObject|null|undefined} */ (node.error);
      const blockedBy = /** @type {unknown[]|undefined} */ (node.blockedBy);
      const note = typeof gate?.summary === "string" ? gate.summary
        : typeof error?.message === "string" ? error.message
          : blockedBy?.length ? `blocked by ${blockedBy.join(", ")}`
            : typeof node.phase === "string" ? node.phase : "";
      return {
        id: /** @type {string} */ (node.id),
        status: /** @type {string} */ (node.status),
        note,
      };
    });
  return { id, exists: true, total: nodes.length, summary, attention, unreadable: null };
}

class LineBudget {
  /**
   * @param {number} limit
   */
  constructor(limit) {
    /** @type {number} */
    this.limit = limit;
    /** @type {number} */
    this.used = 0;
    /** @type {string[]} */
    this.lines = [];
  }

  /**
   * @param {string} line
   * @returns {boolean}
   */
  fits(line) {
    return this.used + Buffer.byteLength(line, "utf8") + 1 <= this.limit;
  }

  /**
   * @param {string} line
   * @returns {boolean}
   */
  add(line) {
    if (!this.fits(line)) return false;
    this.lines.push(line);
    this.used += Buffer.byteLength(line, "utf8") + 1;
    return true;
  }

  /**
   * @param {string[]} lines
   * @returns {number}
   */
  addAll(lines) {
    let added = 0;
    for (const line of lines) {
      if (!this.add(line)) break;
      added += 1;
    }
    return added;
  }
}

/**
 * @param {JournalEntry[]} entries
 * @returns {JournalEntry[]}
 */
function lastN(entries) {
  return entries.slice(-HANDOFF_LIMIT);
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
function normalizeText(value, label, maxBytes = JOURNAL_TEXT_BYTES) {
  requireText(value, label);
  const collapsed = collapseLines(value);
  if (!collapsed) throw new TypeError(`${label} must not be blank`);
  return boundedText(collapsed, maxBytes);
}

/**
 * @param {string} value
 * @returns {string}
 */
function collapseLines(value) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, " ")
    .replace(/\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedText(value, maxBytes) {
  const text = String(value);
  if (maxBytes <= 0) return "…";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = [];
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes + 3 > maxBytes) break;
    chars.push(char);
    bytes += charBytes;
  }
  return `${chars.join("")}…`;
}

/**
 * @param {unknown} campaign
 */
function validateCampaign(campaign) {
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    throw new TypeError("campaign.json must be an object");
  }
  const record = /** @type {JsonObject} */ (campaign);
  requireId(record.id, "campaign.id");
  requireText(record.goal, "campaign.goal");
  if (record.status !== "active" && record.status !== "closed") {
    throw new TypeError("campaign.status must be active or closed");
  }
  if (!Array.isArray(record.linkedRunIds)) throw new TypeError("campaign.linkedRunIds must be an array");
  for (const runId of record.linkedRunIds) requireId(runId, "campaign.linkedRunIds[]");
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
  if (value === "." || value === "..") {
    throw new TypeError(`${label} must not be "." or ".."`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is string}
 */
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return error.code;
  return undefined;
}
