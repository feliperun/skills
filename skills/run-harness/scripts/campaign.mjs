import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export const CAMPAIGN_DIR_NAME = "campaigns";
export const CAMPAIGN_FILE = "campaign.json";
export const JOURNAL_FILE = "journal.jsonl";
export const HANDOFF_FILE = "HANDOFF.md";
export const HANDOFF_LIMIT = 20;
export const HANDOFF_BYTES = 16 * 1024;

const JOURNAL_TYPES = new Set([
  "campaign.initialized",
  "run.registered",
  "session.attached",
  "intent",
  "decision",
  "supersede",
  "constraint",
  "outcome",
  "next",
  "open-question",
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
]);

const ENTRY_SHAPES = {
  "campaign.initialized": ["at", "type"],
  "run.registered": ["at", "type", "runId"],
  "session.attached": ["at", "type", "sessionId", "tool", "transcript", "transcriptUnavailable", "format", "cursor"],
  intent: ["at", "type", "sessionId", "text"],
  decision: ["at", "type", "sessionId", "decisionId", "text"],
  supersede: ["at", "type", "sessionId", "supersedes", "text"],
  constraint: ["at", "type", "sessionId", "text"],
  outcome: ["at", "type", "sessionId", "text", "runId"],
  next: ["at", "type", "sessionId", "text"],
  "open-question": ["at", "type", "sessionId", "text"],
};

export function campaignsDir(runsDir) {
  return join(runsDir, CAMPAIGN_DIR_NAME);
}

export function campaignDir(runsDir, campaignId) {
  requireId(campaignId, "campaignId");
  return join(campaignsDir(runsDir), campaignId);
}

export function initializeCampaign(runsDir, { campaignId, goal, at = new Date().toISOString() }) {
  requireId(campaignId, "campaignId");
  requireText(goal, "goal");
  requireTimestamp(at, "at");
  const path = campaignDir(runsDir, campaignId);
  if (existsSync(path)) throw new Error(`campaign already exists: ${path}`);
  mkdirSync(path, { recursive: true });
  const campaign = {
    id: campaignId,
    goal,
    linkedRunIds: [],
    createdAt: at,
    updatedAt: at,
  };
  writeJsonAtomic(join(path, CAMPAIGN_FILE), campaign);
  appendJournal(path, { type: "campaign.initialized", at });
  return { path, campaign };
}

export function discoverCampaigns(runsDir) {
  const root = campaignsDir(runsDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const path = join(root, id);
      const campaignPath = join(path, CAMPAIGN_FILE);
      if (!existsSync(campaignPath)) return null;
      try {
        return { path, campaign: readCampaign(path) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function resolveCampaign(runsDir, campaignId) {
  if (campaignId !== undefined && campaignId !== null) {
    requireId(campaignId, "campaignId");
    const path = campaignDir(runsDir, campaignId);
    return { path, campaign: readCampaign(path) };
  }
  const campaigns = discoverCampaigns(runsDir);
  if (!campaigns.length) {
    throw new Error(`no campaign found under ${campaignsDir(runsDir)}; initialize one with: harness.mjs campaign init`);
  }
  if (campaigns.length > 1) {
    const ids = campaigns.map((entry) => entry.campaign.id).join(", ");
    throw new Error(`multiple campaigns found (${ids}); choose one by id`);
  }
  return campaigns[0];
}

export function readCampaign(path) {
  let campaign;
  try {
    campaign = JSON.parse(readFileSync(join(path, CAMPAIGN_FILE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`campaign not found: ${path}`);
    throw error;
  }
  validateCampaign(campaign);
  return campaign;
}

export function appendJournal(campaignPath, entry) {
  validateJournalEntry(entry);
  const descriptor = openSync(join(campaignPath, JOURNAL_FILE), "a");
  try {
    writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function registerRun(campaignPath, runId, at = new Date().toISOString()) {
  requireId(runId, "runId");
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.linkedRunIds.includes(runId)) {
    campaign.updatedAt = at;
    writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
    return campaign;
  }
  campaign.linkedRunIds.push(runId);
  campaign.updatedAt = at;
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
  appendJournal(campaignPath, { type: "run.registered", at, runId });
  return campaign;
}

export function renderHandoff(campaignPath, runsDir) {
  const campaign = readCampaign(campaignPath);
  const journal = readJournal(campaignPath);
  return materializeHandoff(campaignPath, projectHandoff(campaign, journal, runsDir));
}

export function renderRunHandoff(runDir) {
  const contractPath = join(runDir, "contract.json");
  if (!existsSync(contractPath)) return null;
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  if (!contract.campaignId) return null;
  const runsDir = resolve(runDir, "..");
  const path = campaignDir(runsDir, contract.campaignId);
  if (!existsSync(join(path, CAMPAIGN_FILE))) return null;
  return renderHandoff(path, runsDir);
}

export function readJournal(campaignPath) {
  const path = join(campaignPath, JOURNAL_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      validateJournalEntry(entry);
      entries.push(entry);
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        // A crash between append writes can leave a partial final line.
        continue;
      }
      throw new Error(`journal line ${index + 1} is invalid: ${error.message}`);
    }
  }
  return entries;
}

export function validateJournalEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("journal entry must be an object");
  }
  if (!JOURNAL_TYPES.has(entry.type)) {
    throw new TypeError(`journal entry type must be one of ${[...JOURNAL_TYPES].join(", ")}`);
  }
  const allowed = ENTRY_SHAPES[entry.type];
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) throw new TypeError(`journal entry ${entry.type} has unexpected field ${key}`);
  }
  requireTimestamp(entry.at, "entry.at");
  if (SESSION_REQUIRED_TYPES.has(entry.type)) {
    requireText(entry.sessionId, "entry.sessionId");
  }
  if (entry.type === "session.attached") return validateSessionEntry(entry);
  if (entry.type === "run.registered") {
    requireText(entry.runId, "entry.runId");
    return;
  }
  if (entry.type === "campaign.initialized") return;
  requireText(entry.text, "entry.text");
  if (entry.type === "decision") requireText(entry.decisionId, "entry.decisionId");
  if (entry.type === "supersede") requireText(entry.supersedes, "entry.supersedes");
  if (entry.type === "outcome" && entry.runId !== undefined) requireText(entry.runId, "entry.runId");
}

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

function projectHandoff(campaign, journal, runsDir) {
  const decisions = new Map();
  for (const entry of journal) {
    if (entry.type === "decision") decisions.set(entry.decisionId, entry);
    if (entry.type === "supersede") decisions.delete(entry.supersedes);
  }
  const activeDecisions = lastN([...decisions.values()]);
  const constraints = lastN(journal.filter((entry) => entry.type === "constraint"));
  const outcomes = lastN(journal.filter((entry) => entry.type === "outcome"));
  const intents = lastN(journal.filter((entry) => entry.type === "intent"));
  const nextEntry = journal.findLast((entry) => entry.type === "next") ?? null;
  const questions = lastN(journal.filter((entry) => entry.type === "open-question"));
  const sessions = lastN(journal.filter((entry) => entry.type === "session.attached"));

  return {
    campaign,
    updatedAt: journal.at(-1)?.at ?? campaign.updatedAt,
    linkedRuns: campaign.linkedRunIds.map((runId) => runSummary(join(runsDir, runId))),
    activeDecisions,
    constraints,
    intents,
    outcomes,
    nextEntry,
    questions,
    sessions,
  };
}

function materializeHandoff(campaignPath, handoff) {
  const text = fitHandoff(renderMarkdown(handoff));
  writeTextAtomic(join(campaignPath, HANDOFF_FILE), text);
  return text;
}

function renderMarkdown(handoff) {
  const { campaign, linkedRuns, activeDecisions, constraints, intents, outcomes, nextEntry, questions, sessions } = handoff;
  const lines = [
    `# campaign ${campaign.id} handoff`,
    "",
    `Updated: ${handoff.updatedAt}`,
    "",
    "## Goal",
    "",
    campaign.goal,
    "",
    "## Linked runs",
    "",
  ];
  if (!linkedRuns.length) lines.push("No linked runs yet.");
  for (const run of linkedRuns) lines.push(...renderRunSection(run));
  lines.push("", "## Latest next action", "");
  lines.push(nextEntry ? nextEntry.text : "None.");
  lines.push("", "## Session lineage", "");
  if (!sessions.length) lines.push("None.");
  for (const entry of sessions) {
    const transcript = entry.transcriptUnavailable ? "unavailable" : entry.transcript;
    const format = entry.format ?? "-";
    const cursor = entry.cursor ?? "-";
    lines.push(`- ${entry.tool} ${entry.sessionId} · transcript: ${transcript} · format: ${format} · cursor: ${cursor}`);
  }
  lines.push("", "## Active decisions", "");
  if (!activeDecisions.length) lines.push("None.");
  for (const entry of activeDecisions) {
    lines.push(`- [${entry.decisionId}] ${entry.text} · ${entry.sessionId} · ${entry.at}`);
  }
  lines.push("", "## User constraints", "");
  if (!constraints.length) lines.push("None.");
  for (const entry of constraints) lines.push(`- ${entry.text} · ${entry.sessionId} · ${entry.at}`);
  lines.push("", "## Recent user intents", "");
  if (!intents.length) lines.push("None.");
  for (const entry of intents) lines.push(`- ${entry.text} · ${entry.sessionId} · ${entry.at}`);
  lines.push("", "## Attempts and outcomes", "");
  if (!outcomes.length) lines.push("None.");
  for (const entry of outcomes) {
    const run = entry.runId ? `run ${entry.runId}: ` : "";
    lines.push(`- ${run}${entry.text} · ${entry.sessionId} · ${entry.at}`);
  }
  lines.push("", "## Open questions", "");
  if (!questions.length) lines.push("None.");
  for (const entry of questions) lines.push(`- ${entry.text} · ${entry.sessionId} · ${entry.at}`);
  return `${lines.join("\n")}\n`;
}

function renderRunSection(run) {
  if (!run.exists) {
    return [`- ${run.id}: run directory missing`];
  }
  if (!run.total) {
    return [`- ${run.id}: no node states yet`];
  }
  const lines = [`- ${run.id}: ${run.summary}`];
  for (const node of run.attention) {
    lines.push(`  - ${node.id}: ${node.status}${node.note ? ` · ${node.note}` : ""}`);
  }
  return lines;
}

function runSummary(runDir) {
  const id = basename(runDir);
  const nodeDir = join(runDir, "nodes");
  if (!existsSync(nodeDir)) return { id, exists: false, total: 0, summary: "", attention: [] };
  const nodes = readdirSync(nodeDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(nodeDir, name), "utf8")));
  if (!nodes.length) return { id, exists: true, total: 0, summary: "no node states yet", attention: [] };
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = `${nodes.length} nodes · ${[...counts].map(([status, count]) => `${count} ${status}`).join(" · ")}`;
  const attention = nodes
    .filter((node) => !["pending", "running", "done"].includes(node.status))
    .map((node) => ({
      id: node.id,
      status: node.status,
      note: node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase ?? "",
    }));
  return { id, exists: true, total: nodes.length, summary, attention };
}

function lastN(entries) {
  return entries.slice(-HANDOFF_LIMIT);
}

function fitHandoff(text) {
  if (Buffer.byteLength(text, "utf8") <= HANDOFF_BYTES) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= HANDOFF_BYTES) low = middle;
    else high = middle - 1;
  }
  const bounded = text.slice(0, low);
  const newline = bounded.lastIndexOf("\n");
  return newline >= 0 ? bounded.slice(0, newline + 1) : bounded;
}

function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, "w");
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function validateCampaign(campaign) {
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    throw new TypeError("campaign.json must be an object");
  }
  requireId(campaign.id, "campaign.id");
  requireText(campaign.goal, "campaign.goal");
  if (!Array.isArray(campaign.linkedRunIds)) throw new TypeError("campaign.linkedRunIds must be an array");
  for (const runId of campaign.linkedRunIds) requireId(runId, "campaign.linkedRunIds[]");
}

function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
  if (value === "." || value === "..") {
    throw new TypeError(`${label} must not be "." or ".."`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
}
