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
import {
  campaignStatus,
  configureCampaign,
  detachSelf,
  drainNotifications,
  startCampaign,
  superviseCampaign,
  watchCampaign,
} from "./campaign-autonomy.mjs";
import { syncAgentSignal } from "./signal.mjs";

const NOTE_KINDS = new Set([
  "intent",
  "decision",
  "supersede",
  "constraint",
  "outcome",
  "next",
  "open-question",
  "retrospective",
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
  configure: {
    cwd: { type: "string" },
    plan: { type: "string" },
    contract: { type: "string" },
    "snapshot-version": { type: "string" },
    "source-root": { type: "string" },
  },
  start: { cwd: { type: "string" } },
  supervise: { cwd: { type: "string" }, detach: { type: "boolean" }, interval: { type: "string" }, once: { type: "boolean" } },
  status: { cwd: { type: "string" } },
  drain: { cwd: { type: "string" } },
  watch: { cwd: { type: "string" }, since: { type: "string" }, cursor: { type: "string" } },
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

/** @typedef {{cwd?: string, goal?: string, tool?: string, sessionId?: string, transcript?: string, format?: string, cursor?: string, since?: string, kind?: string, text?: string, runId?: string, supersedes?: string, decisionId?: string, questionId?: string, eventId?: string, noTranscript?: boolean, plan?: string, contract?: string, snapshotVersion?: string, sourceRoot?: string, detach?: boolean, interval?: string, once?: boolean}} CliValues */
/** @typedef {import("./campaign.mjs").Campaign} Campaign */

/**
 * @param {string[]} args
 * @returns {Promise<number|void>}
 */
export async function campaignCli(args) {
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
  if (operation === "configure") return configure(campaignId, values);
  if (operation === "start") return start(campaignId, values);
  if (operation === "supervise") return supervise(campaignId, values);
  if (operation === "status") return status(campaignId, values);
  if (operation === "drain") return drain(campaignId, values);
  if (operation === "watch") return watch(campaignId, values);
  if (operation === "attach") return attach(campaignId, values);
  if (operation === "note") return note(campaignId, values);
  if (operation === "resolve") return resolveQuestion(campaignId, values);
  if (operation === "close") return close(campaignId, values);
  if (operation === "show") return show(campaignId, values);
  return usage();
}

/** @param {string} campaignId @param {CliValues} values */
function configure(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  let plan;
  if (values.plan) plan = JSON.parse(readFileSync(resolve(values.plan), "utf8"));
  const planContract = !values.contract && plan && typeof plan.initialRunContract === "string"
    ? resolve(resolve(values.plan ?? ".", ".."), plan.initialRunContract)
    : undefined;
  const configured = configureCampaign(path, {
    plan,
    initialRunContract: values.contract ? resolve(values.contract) : planContract,
    snapshotVersion: values.snapshotVersion,
    sourceRoot: values.sourceRoot ? resolve(values.sourceRoot) : undefined,
  });
  process.stdout.write(`[campaign] ${campaignId} configured · ${configured.path}\n`);
}

/** @param {string} campaignId @param {CliValues} values */
async function start(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  const started = await startCampaign(path);
  process.stdout.write(`[campaign] ${campaignId} started · ${started.runId}\n`);
}

/** @param {string} campaignId @param {CliValues} values */
async function supervise(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  const intervalMs = values.interval === undefined ? undefined : positiveIntervalMs(values.interval);
  if (values.detach === true) {
    const detached = await detachSelf(path, { intervalMs });
    process.stdout.write(`[campaign] ${campaignId} supervisor detached · pid ${detached.pid}\n`);
    return;
  }
  const result = await superviseCampaign(path, { intervalMs, once: values.once === true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** @param {string} campaignId @param {CliValues} values */
function status(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  process.stdout.write(`${JSON.stringify(campaignStatus(path), null, 2)}\n`);
}

/** @param {string} campaignId @param {CliValues} values */
async function drain(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  process.stdout.write(`${JSON.stringify(await drainNotifications(path))}\n`);
}

/** @param {string} campaignId @param {CliValues} values */
function watch(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  process.stdout.write(`${JSON.stringify(watchCampaign(path, { since: values.since, cursor: values.cursor }))}\n`);
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
  if (syncAgentSignal(runsDir)) process.stdout.write(`[campaign] AGENTS.md signal updated\n`);
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
  if (syncAgentSignal(runsDir)) process.stdout.write(`[campaign] AGENTS.md signal updated\n`);
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

/** @param {string} value @returns {number} */
function positiveIntervalMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError("--interval must be a positive number of seconds");
  return Math.floor(seconds * 1_000);
}

function usage() {
  process.stderr.write(
    "usage: runner.mjs campaign <init|configure|start|supervise|status|drain|watch|attach|note|resolve|close|show|list> <campaign-id> [--cwd <dir>] ...\n",
  );
  process.exitCode = 2;
}
