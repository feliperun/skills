import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseFlags } from "node:util";
import {
  closeCampaign,
  discoverCampaigns,
  initializeCampaign,
  renderHandoff,
  resolveCampaign,
} from "../campaign/index.mjs";
import { lockStale, readLock } from "../run/lock.mjs";
import { syncAgentSignal } from "../repo/signal.mjs";
import { acknowledgeJournalEvent, appendJournal, readJournal, watchJournal } from "../campaign/journal.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { readJsonTolerant } from "../util.mjs";

const SYNC_OUTPUT_MAX_BYTES = 8000;
const DEFAULT_WAKE_POLL_MS = 30_000;
const WAKE_IDLE_AFTER_MS = 20 * 60_000;
const TERMINAL_NODE_STATUSES = new Set(["done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);
const ATTENTION_NODE_STATUSES = new Set(["failed", "exhausted", "stalled", "canceled", "cancelled"]);

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
  watch: { cwd: { type: "string" }, wake: { type: "boolean" }, interval: { type: "string" }, once: { type: "boolean" } },
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
  sync: { cwd: { type: "string" }, "session-id": { type: "string" } },
  ack: { cwd: { type: "string" }, "session-id": { type: "string" }, "event-id": { type: "string" } },
};

/** @typedef {{cwd?: string, goal?: string, tool?: string, sessionId?: string, transcript?: string, format?: string, cursor?: string, since?: string, kind?: string, text?: string, runId?: string, supersedes?: string, decisionId?: string, questionId?: string, eventId?: string, noTranscript?: boolean, wake?: boolean, interval?: string, once?: boolean}} CliValues */
/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */

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
  if (operation === "watch") return watch(campaignId, values);
  if (operation === "attach") return attach(campaignId, values);
  if (operation === "note") return note(campaignId, values);
  if (operation === "resolve") return resolveQuestion(campaignId, values);
  if (operation === "close") return close(campaignId, values);
  if (operation === "show") return show(campaignId, values);
  if (operation === "sync") return sync(campaignId, values);
  if (operation === "ack") return ack(campaignId, values);
  return usage();
}

/**
 * `campaign watch <id> --wake`: poll the campaign's linked runs' status.json
 * files and print exactly one line per actionable change (TECH-SPEC lean,
 * rule 6 and section 5 row 2b). Replaces the harness-side
 * `watch-campaign.mjs` monitor and the old pull-based outbox watch.
 *
 * @param {string} campaignId
 * @param {CliValues} values
 */
async function watch(campaignId, values) {
  if (values.wake !== true) throw new TypeError("watch requires --wake");
  const { path, runsDir } = selectCampaign(campaignId, values);
  const pollMs = values.interval === undefined ? DEFAULT_WAKE_POLL_MS : positiveIntervalMs(values.interval);
  await watchCampaignWake(path, runsDir, { pollMs, once: values.once === true });
}

/**
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {{pollMs?: number, once?: boolean, now?: () => number, sleep?: (ms: number) => Promise<void>, emit?: (line: string) => void}} [options]
 * @returns {Promise<void>}
 */
async function watchCampaignWake(campaignPath, runsDir, options = {}) {
  const pollMs = options.pollMs ?? DEFAULT_WAKE_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const emit = options.emit ?? ((line) => process.stdout.write(`${line}\n`));
  /** @type {Map<string, string>} */
  const runSignatures = new Map();
  /** @type {Set<string>} */
  const announced = new Set();
  let lastActiveAt = now();
  let first = true;
  for (;;) {
    const campaign = readCampaign(campaignPath);
    if (campaign.status !== "active") {
      emit(`campaign-watch: ${campaign.id} is ${campaign.status}; stopping`);
      return;
    }
    let anyActive = false;
    for (const runId of campaign.linkedRunIds) {
      const status = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runsDir, runId, "status.json")));
      if (!status || !Array.isArray(status.nodes)) continue;
      const terminal = status.nodes.every((/** @type {any} */ node) => TERMINAL_NODE_STATUSES.has(String(node.status)));
      const signature = status.nodes.map((/** @type {any} */ node) => `${node.id}:${node.status}:${node.errorCode ?? ""}`).join("|");
      const previous = runSignatures.get(runId);
      runSignatures.set(runId, signature);
      if (!terminal) {
        anyActive = true;
        const lock = readLock(join(runsDir, runId));
        const stale = !lock || /** @type {{invalid?: true}} */ (lock).invalid || lockStale(lock);
        const key = `stale:${runId}`;
        if (stale && !first) {
          if (!announced.has(key)) {
            announced.add(key);
            emit(`campaign-watch: ${runId} has non-terminal nodes but no live controller; resume it`);
          }
        } else announced.delete(key);
      }
      if (!first && previous !== signature) {
        for (const node of status.nodes) {
          const attention = ATTENTION_NODE_STATUSES.has(String(node.status))
            || (node.status === "blocked" && !(Array.isArray(node.blockedBy) && node.blockedBy.length > 0));
          const key = `node:${runId}:${node.id}:${node.status}:${node.errorCode ?? ""}`;
          if (attention && !announced.has(key)) {
            announced.add(key);
            emit(`campaign-watch: ${runId} node ${node.id} ${node.status}${node.errorCode ? ` [${node.errorCode}]` : ""}${node.note ? ` ${node.note}` : ""}`);
          }
        }
      }
      if (terminal) {
        const key = `terminal:${runId}`;
        if (!announced.has(key)) {
          announced.add(key);
          emit(`campaign-watch: ${runId} terminal · ${status.summary ?? ""}`);
        }
      }
    }
    const nowMs = now();
    if (anyActive) lastActiveAt = nowMs;
    else if (!first && nowMs - lastActiveAt >= WAKE_IDLE_AFTER_MS) {
      const key = `idle:${Math.floor((nowMs - lastActiveAt) / WAKE_IDLE_AFTER_MS)}`;
      if (!announced.has(key)) {
        announced.add(key);
        emit(`campaign-watch: ${campaign.id} active but no run has been active for ${Math.round((nowMs - lastActiveAt) / 60_000)} min; dispatch the next step`);
      }
    }
    first = false;
    if (options.once === true) return;
    await sleep(pollMs);
  }
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
 * User-pull campaign sync: attach the session once per day when it is not
 * attached yet, then print the campaign status header, the newest linked
 * run's status.json summary, and the unseen journal events after the session
 * cursor. sync never writes the cursor: only `ack` does.
 *
 * @param {string} campaignId
 * @param {CliValues} values
 */
function sync(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  const sessionId = required(values.sessionId, "--session-id");
  const cursorId = sessionCursorId(sessionId);
  attachSessionOnceDaily(path, runsDir, sessionId);
  const campaign = readCampaign(path);
  const seen = watchJournal(path, { cursor: cursorId, readOnly: true });
  const header = `campaign ${campaign.id} · status ${campaign.status}`;
  const runLine = latestRunStatusLine(runsDir, campaign);
  let output = `${header}\n${runLine}\n`;
  let index = 0;
  for (; index < seen.events.length; index += 1) {
    const event = seen.events[index];
    const line = `${event.at} ${event.type} ${journalEntryText(event)}\n`;
    if (Buffer.byteLength(output + line, "utf8") <= SYNC_OUTPUT_MAX_BYTES - 64) output += line;
    else break;
  }
  if (index < seen.events.length) output += `sync truncated: ${seen.events.length - index} more events\n`;
  process.stdout.write(output);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function ack(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  const sessionId = required(values.sessionId, "--session-id");
  const eventId = required(values.eventId, "--event-id");
  const cursorId = sessionCursorId(sessionId);
  const position = acknowledgeJournalEvent(path, cursorId, eventId);
  process.stdout.write(`[campaign] session ${sessionId} acknowledged up to ${position.eventId}\n`);
}

/**
 * @param {string} runsDir
 * @param {Campaign} campaign
 * @returns {string}
 */
function latestRunStatusLine(runsDir, campaign) {
  const runId = campaign.linkedRunIds.at(-1);
  if (!runId) return "run: none linked yet";
  const status = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runsDir, runId, "status.json")));
  if (!status) return `run ${runId}: no status.json yet`;
  const controllerState = status.controller?.state ?? "none";
  return `run ${runId} · ${status.summary ?? ""} · controller ${controllerState}`;
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function journalEntryText(entry) {
  if (typeof entry.text === "string" && entry.text) return entry.text;
  if (entry.type === "session.attached") return `session ${entry.sessionId} attached (${entry.tool})`;
  if (entry.type === "run.registered") return `run ${entry.runId} registered`;
  return String(entry.type);
}

/**
 * Append one session.attached journal entry per day when the session has no
 * attach for today yet. The entry reuses the attach journal shape with
 * --no-transcript semantics: no transcript path is known here, so the record
 * is transcriptUnavailable with null transcript and format. The tool is
 * inherited from the session's newest recorded attach (fallback "sync") so
 * the session lineage stays truthful.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {string} sessionId
 */
function attachSessionOnceDaily(campaignPath, runsDir, sessionId) {
  const attaches = readJournal(campaignPath).filter(
    (entry) => entry.type === "session.attached" && entry.sessionId === sessionId,
  );
  const newest = attaches.at(-1);
  if (newest !== undefined && localDay(String(newest.at)) === localDay(new Date().toISOString())) return;
  const tool = typeof newest?.tool === "string" && newest.tool.trim() ? newest.tool : "sync";
  appendJournal(campaignPath, {
    type: "session.attached",
    eventId: randomUUID(),
    at: new Date().toISOString(),
    sessionId,
    tool,
    transcript: null,
    transcriptUnavailable: true,
    format: null,
    cursor: null,
  });
  renderHandoff(campaignPath, runsDir);
}

/** @param {string} sessionId @returns {string} */
function sessionCursorId(sessionId) {
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(sessionId)) {
    throw new TypeError("--session-id must be letters, digits, dots, underscores or dashes");
  }
  return `session-${sessionId}`;
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
 * @param {string} iso
 * @returns {string}
 */
function localDay(iso) {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
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
    "usage: runner.mjs campaign <init|watch|attach|note|resolve|close|show|list|sync|ack> <campaign-id> [--cwd <dir>] ...\n",
  );
  process.exitCode = 2;
}
