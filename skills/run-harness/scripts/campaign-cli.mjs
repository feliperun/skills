import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseFlags } from "node:util";
import {
  appendJournal,
  closeCampaign,
  discoverCampaigns,
  initializeCampaign,
  renderHandoff,
  resolveCampaign,
} from "./campaign.mjs";

const NOTE_KINDS = new Set([
  "intent",
  "decision",
  "supersede",
  "constraint",
  "outcome",
  "next",
  "open-question",
]);

/** Flags that only apply to a single note kind; rejected for every other kind. */
const NOTE_KIND_FLAGS = {
  decision: ["decision-id"],
  supersede: ["supersedes"],
  "open-question": ["question-id"],
  outcome: ["run-id"],
};

/** Flags are scoped to the operations that declare them; all other flags are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  list: { cwd: { type: "string" } },
  init: { cwd: { type: "string" }, goal: { type: "string" } },
  attach: {
    cwd: { type: "string" },
    tool: { type: "string" },
    "session-id": { type: "string" },
    transcript: { type: "string" },
    "no-transcript": { type: "boolean" },
    format: { type: "string" },
    cursor: { type: "string" },
    "event-id": { type: "string" },
  },
  note: {
    cwd: { type: "string" },
    "session-id": { type: "string" },
    kind: { type: "string" },
    text: { type: "string" },
    "event-id": { type: "string" },
    "decision-id": { type: "string" },
    supersedes: { type: "string" },
    "question-id": { type: "string" },
    "run-id": { type: "string" },
  },
  resolve: {
    cwd: { type: "string" },
    "session-id": { type: "string" },
    "question-id": { type: "string" },
    text: { type: "string" },
    "event-id": { type: "string" },
  },
  close: { cwd: { type: "string" }, "event-id": { type: "string" } },
  show: { cwd: { type: "string" } },
};

/** @typedef {{cwd?: string, goal?: string, tool?: string, sessionId?: string, transcript?: string, format?: string, cursor?: string, kind?: string, text?: string, runId?: string, supersedes?: string, decisionId?: string, questionId?: string, eventId?: string, noTranscript?: boolean}} CliValues */
/** @typedef {import("./campaign.mjs").Campaign} Campaign */

/**
 * @param {string[]} args
 * @returns {number|void}
 */
export function campaignCli(args) {
  const operation = args[0];
  if (!operation || !(operation in OPERATION_OPTIONS)) return usage();
  const { positional, values } = parseArgs(args.slice(1), operation);
  const [campaignId, ...extra] = positional;
  if (operation === "list") {
    if (campaignId !== undefined || extra.length) return usage();
    return listCampaigns(values);
  }
  if (!campaignId || extra.length) return usage();
  if (operation === "init") return init(campaignId, values);
  if (operation === "attach") return attach(campaignId, values);
  if (operation === "note") return note(campaignId, values);
  if (operation === "resolve") return resolveQuestion(campaignId, values);
  if (operation === "close") return close(campaignId, values);
  if (operation === "show") return show(campaignId, values);
  return usage();
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function init(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = join(cwd, ".runs");
  const goal = textValue(values.goal, "--goal");
  const created = initializeCampaign(runsDir, { campaignId, goal });
  renderHandoff(created.path, runsDir);
  process.stdout.write(`[campaign] ${campaignId} initialized · ${created.path}\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function attach(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  requireActive(campaign);
  const tool = required(values.tool, "--tool");
  const sessionId = required(values.sessionId, "--session-id");
  const unavailable = Boolean(values.noTranscript);
  const transcript = unavailable ? null : values.transcript;
  if (!unavailable && typeof transcript !== "string") {
    throw new TypeError("attach requires --transcript <absolute-path> or --no-transcript");
  }
  appendJournal(path, {
    type: "session.attached",
    eventId: values.eventId ?? randomUUID(),
    at: new Date().toISOString(),
    sessionId,
    tool,
    transcript,
    transcriptUnavailable: unavailable,
    format: unavailable ? null : (values.format ?? null),
    cursor: values.cursor ?? null,
  });
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] session ${sessionId} attached to ${campaignId}\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function note(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  requireActive(campaign);
  const kind = required(values.kind, "--kind");
  if (!NOTE_KINDS.has(kind)) {
    throw new TypeError(`--kind must be one of ${[...NOTE_KINDS].join(", ")}`);
  }
  for (const [kindName, flags] of Object.entries(NOTE_KIND_FLAGS)) {
    if (kindName === kind) continue;
    for (const flag of flags) {
      const present = /** @type {Record<string, unknown>} */ (values)[camelFlag(`--${flag}`)];
      if (present !== undefined) {
        throw new TypeError(`--${flag} is only valid for --kind ${kindName}`);
      }
    }
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    type: kind,
    eventId: values.eventId ?? randomUUID(),
    at: new Date().toISOString(),
    sessionId: required(values.sessionId, "--session-id"),
    text: textValue(values.text, "--text"),
  };
  if (kind === "decision") entry.decisionId = required(values.decisionId, "--decision-id");
  if (kind === "supersede") entry.supersedes = required(values.supersedes, "--supersedes");
  if (kind === "open-question") entry.questionId = required(values.questionId, "--question-id");
  if (kind === "outcome" && values.runId !== undefined) entry.runId = required(values.runId, "--run-id");
  appendJournal(path, entry);
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] ${kind} noted\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function resolveQuestion(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  requireActive(campaign);
  const questionId = required(values.questionId, "--question-id");
  appendJournal(path, {
    type: "question.resolved",
    eventId: values.eventId ?? randomUUID(),
    at: new Date().toISOString(),
    sessionId: required(values.sessionId, "--session-id"),
    questionId,
    text: textValue(values.text, "--text"),
  });
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] question ${questionId} resolved\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function close(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  const closed = closeCampaign(path, { eventId: values.eventId ?? randomUUID() });
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] ${closed.campaign.id} closed\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function show(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  process.stdout.write(renderHandoff(path, runsDir));
}

/**
 * @param {CliValues} values
 */
function listCampaigns(values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = join(cwd, ".runs");
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  if (!campaigns.length && !corrupt.length) {
    process.stdout.write("[campaign] none\n");
    return;
  }
  for (const { campaign, path } of campaigns) {
    const updated = campaign.updatedAt;
    process.stdout.write(
      `[campaign] ${campaign.id} · ${campaign.status} · ${campaign.linkedRunIds.length} linked runs · updated ${updated} · ${path}\n`,
    );
  }
  for (const entry of corrupt) {
    process.stdout.write(`[campaign] ${entry.id} · corrupt · ${entry.error.message} · ${entry.path}\n`);
  }
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 * @returns {{path: string, runsDir: string, campaign: Campaign}}
 */
function selectCampaign(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = join(cwd, ".runs");
  return { ...resolveCampaign(runsDir, campaignId), runsDir };
}

/**
 * @param {Campaign} campaign
 */
function requireActive(campaign) {
  if (campaign.status !== "active") throw new Error(`campaign is closed: ${campaign.id}`);
}

/**
 * Strict per-operation parsing with node:util.parseArgs: unknown options,
 * missing values, and extra positionals are rejected; flags are scoped to the
 * operation that declares them.
 *
 * @param {string[]} args
 * @param {keyof typeof OPERATION_OPTIONS} operation
 * @returns {{positional: string[], values: CliValues}}
 */
function parseArgs(args, operation) {
  const parsed = parseFlags({
    args,
    options: OPERATION_OPTIONS[operation],
    allowPositionals: true,
    strict: true,
  });
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const [key, value] of Object.entries(parsed.values)) values[camelFlag(`--${key}`)] = value;
  return { positional: parsed.positionals, values: /** @type {CliValues} */ (values) };
}

/**
 * @param {string} flag
 * @returns {string}
 */
function camelFlag(flag) {
  return flag.replace(/^--/u, "").replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function textValue(value, label) {
  return required(value === "-" ? readFileSync(0, "utf8").trim() : value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} requires a value`);
  return value;
}

function usage() {
  process.stderr.write(
    "usage: harness.mjs campaign <init|attach|note|resolve|close|show|list> <campaign-id> [--cwd <dir>] ...\n",
  );
  process.exitCode = 2;
}
