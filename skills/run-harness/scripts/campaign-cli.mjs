import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  appendJournal,
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

export function campaignCli(args) {
  const { positional, values } = parseArgs(args);
  const [operation, campaignId, ...extra] = positional;
  if (!operation || !campaignId || extra.length) return usage();
  if (operation === "init") return init(campaignId, values);
  if (operation === "attach") return attach(campaignId, values);
  if (operation === "note") return note(campaignId, values);
  if (operation === "show") return show(campaignId, values);
  return usage();
}

function init(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = join(cwd, ".runs");
  const goal = textValue(values.goal, "--goal");
  const created = initializeCampaign(runsDir, { campaignId, goal });
  renderHandoff(created.path, runsDir);
  process.stdout.write(`[campaign] ${campaignId} initialized · ${created.path}\n`);
}

function attach(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  const tool = required(values.tool, "--tool");
  const sessionId = required(values.sessionId, "--session-id");
  const unavailable = Boolean(values.noTranscript);
  const transcript = unavailable ? null : values.transcript;
  if (!unavailable && typeof transcript !== "string") {
    throw new TypeError("attach requires --transcript <absolute-path> or --no-transcript");
  }
  appendJournal(path, {
    type: "session.attached",
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

function note(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  const kind = required(values.kind, "--kind");
  if (!NOTE_KINDS.has(kind)) {
    throw new TypeError(`--kind must be one of ${[...NOTE_KINDS].join(", ")}`);
  }
  const entry = {
    type: kind,
    at: new Date().toISOString(),
    sessionId: required(values.sessionId, "--session-id"),
    text: textValue(values.text, "--text"),
  };
  if (kind === "decision") entry.decisionId = required(values.decisionId, "--decision-id");
  if (kind === "supersede") entry.supersedes = required(values.supersedes, "--supersedes");
  if (kind === "outcome" && values.runId !== undefined) entry.runId = required(values.runId, "--run-id");
  appendJournal(path, entry);
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] ${kind} noted\n`);
}

function show(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  process.stdout.write(renderHandoff(path, runsDir));
}

function selectCampaign(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = join(cwd, ".runs");
  return { ...resolveCampaign(runsDir, campaignId), runsDir };
}

function parseArgs(args) {
  const valueFlags = new Set([
    "--cwd",
    "--goal",
    "--tool",
    "--session-id",
    "--transcript",
    "--format",
    "--cursor",
    "--kind",
    "--text",
    "--run-id",
    "--supersedes",
    "--decision-id",
  ]);
  const values = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const key = equals === -1 ? argument : argument.slice(0, equals);
    if (key === "--no-transcript") {
      if (equals !== -1) throw new TypeError(`${key} does not take a value`);
      values.noTranscript = true;
      continue;
    }
    if (!valueFlags.has(key)) throw new TypeError(`unknown option ${key}`);
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) throw new TypeError(`${key} requires a value`);
    values[camelFlag(key)] = value;
  }
  return { positional, values };
}

function camelFlag(flag) {
  return flag.replace(/^--/u, "").replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function textValue(value, label) {
  return required(value === "-" ? readFileSync(0, "utf8").trim() : value, label);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} requires a value`);
  return value;
}

function usage() {
  process.stderr.write(
    "usage: harness.mjs campaign <init|attach|note|show> <campaign-id> [--cwd <dir>] ...\n",
  );
  process.exitCode = 2;
}
