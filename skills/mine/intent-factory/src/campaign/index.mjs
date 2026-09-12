import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../run/store.mjs";
import { requireId, requireTimestamp } from "../contract/assert.mjs";
import { CAMPAIGN_FILE, GOAL_TEXT_BYTES, PROJECTION_FILE, campaignDir, campaignsDir } from "./layout.mjs";
import { readCampaign } from "./record.mjs";
import { appendJournal, normalizeText, readJournalForDedupe } from "./journal.mjs";
import { readProjectionState } from "./projection.mjs";
import { handoffFromState, materializeHandoff } from "./handoff.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{id: string, goal: string, status: "active"|"closed", linkedRunIds: string[], createdAt: string, updatedAt: string, closedAt?: string}} Campaign */
/** @typedef {{type: string, eventId: string, at: string, sessionId?: string, text?: string, tool?: string, transcript?: string|null, transcriptUnavailable?: boolean, format?: string|null, cursor?: string|null, decisionId?: string, supersedes?: string, runId?: string, questionId?: string, campaignId?: string, nodeId?: string|null, phase?: string, checkpointsDone?: number, checkpointsTotal?: number, runtime?: string|null, state?: string, lastProgressAt?: string, attention?: string|null}} JournalEntry */
/** @typedef {{updatedAt: string|null, decisions: Record<string, JournalEntry>, questions: Record<string, JournalEntry>, constraints: JournalEntry[], intents: JournalEntry[], outcomes: JournalEntry[], sessions: JournalEntry[], next: JournalEntry|null, evicted: Record<string, number>}} Projection */
/** @typedef {{cursor: number, byte: number, size: number, projection: Projection}} ProjectionRecord */
/** @typedef {{id: string, exists: boolean, total: number, summary: string, attention: {id: string, status: string, note: string}[], unreadable: string|null}} RunSummary */
/** @typedef {{campaign: Campaign, updatedAt: string, linkedRuns: RunSummary[], activeDecisions: JournalEntry[], constraints: JournalEntry[], intents: JournalEntry[], outcomes: JournalEntry[], nextEntry: JournalEntry|null, questions: JournalEntry[], sessions: JournalEntry[], totals: {decisions: number, constraints: number, intents: number, outcomes: number, questions: number, sessions: number}, evicted: Record<string, number>}} Handoff */

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
 * @param {string} campaignPath
 * @param {{at?: string, eventId?: string}} options
 * @returns {{path: string, campaign: Campaign}}
 */
export function closeCampaign(campaignPath, { at = new Date().toISOString(), eventId = randomUUID() } = {}) {
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign already closed: ${campaign.id}`);
  if (!readJournalForDedupe(campaignPath).some((entry) => entry.type === "retrospective")) {
    throw new Error(`campaign ${campaign.id} has no recorded retrospective; record one with note --kind retrospective before close`);
  }
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

