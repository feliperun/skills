import { basename, dirname, join } from "node:path";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { discoverCampaigns } from "../campaign/index.mjs";
import { campaignDir, campaignsDir } from "../campaign/layout.mjs";
import { readJsonTolerant } from "../util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM_POLL_MS = 700;
const STREAM_PING_MS = 15_000;
const SNAPSHOT_MAX_BYTES = 200 * 1024;
const LOG_TAIL_MAX_LINES = 200;
const LOG_TAIL_MAX_BYTES = 24 * 1024;
const OUTPUT_TAIL_MAX_BYTES = 4 * 1024;
const PROMPT_MAX_CHARS = 8 * 1024;
const HANDOFF_MAX_CHARS = 16 * 1024;
const DIFF_PATH_CAP = 400;
const GOAL_MAX_CHARS = 200;
const TERMINAL_STATUSES = new Set(["done", "no-op", "failed", "blocked", "exhausted", "stalled", "canceled", "cancelled"]);
const HAPPY_TERMINAL = new Set(["done", "no-op"]);
const RESUME_STATES = new Set(["blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);

/** @typedef {{campaignId?: string|null, runId?: string|null, nodeId?: string|null}} Selection */
/** @typedef {{path: string, campaign: import("../campaign/index.mjs").Campaign}} CampaignEntry */

/** Last complete JSONL entries of an append-only file; a torn trailing line is dropped, not fatal. @param {string} path @param {number} maxEntries @param {number} [maxBytes] @returns {Record<string, unknown>[]} */
export function tailJsonl(path, maxEntries, maxBytes = 32 * 1024) {
  const entries = [];
  for (const line of linesInWindow(path, maxBytes)) {
    try {
      entries.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)));
    } catch {
      // dropped: torn by a concurrent append
    }
  }
  return entries.slice(-maxEntries);
}

/** Last complete text lines of a file, read from the end without loading the whole file. @param {string} path @param {number} maxLines @param {number} maxBytes @returns {string[]} */
function tailTextLines(path, maxLines, maxBytes) {
  return linesInWindow(path, maxBytes).slice(-maxLines);
}

/** Every complete, non-blank line within the trailing `maxBytes` window of a file. @param {string} path @param {number} maxBytes @returns {string[]} */
function linesInWindow(path, maxBytes) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const readLength = Math.min(stat.size, maxBytes);
  const bytes = readLength > 0 ? readWindow(path, readLength, stat.size - readLength) : Buffer.alloc(0);
  let text = bytes.toString("utf8");
  if (stat.size > maxBytes) text = text.slice(text.indexOf("\n") + 1);
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/** @param {string} path @param {number} length @param {number} position @returns {Buffer} */
function readWindow(path, length, position) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const filled = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** @param {string} value @param {number} maxChars @returns {string} */
function truncateChars(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join("")}…`;
}

/** @param {string} value @returns {string} */
function oneLine(value) {
  return truncateChars(String(value ?? "").replace(/\s+/gu, " ").trim(), GOAL_MAX_CHARS);
}

/** @param {string|null|undefined} startIso @param {string|null|undefined} endIso @returns {number|null} */
function elapsedMsBetween(startIso, endIso) {
  const start = Date.parse(startIso ?? "");
  if (!Number.isFinite(start)) return null;
  const end = endIso ? Date.parse(endIso) : Date.now();
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** @param {string[]} paths @returns {string} */
function fileSignature(paths) {
  return paths.map((path) => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${path}:-`;
    }
  }).join("|");
}

/** @param {string} runDir @returns {Record<string, any>|null} */
function readRunStatus(runDir) {
  const status = readJsonTolerant(join(runDir, "status.json"));
  return status && typeof status === "object" && Array.isArray(/** @type {any} */ (status).nodes) ? /** @type {any} */ (status) : null;
}

/** @param {string} runDir @returns {string|null} */
function lastEventAt(runDir) {
  const tail = tailJsonl(join(runDir, "events.jsonl"), 1);
  return typeof tail[0]?.at === "string" ? /** @type {string} */ (tail[0].at) : null;
}

/** The runs-table row for one run, read from `status.json` and `run.json`; unreadable is listed flagged `corrupt`, never thrown. @param {string} runsDir @param {string} runId @returns {Record<string, unknown>} */
function runSummary(runsDir, runId) {
  const runDir = join(runsDir, runId);
  const status = readRunStatus(runDir);
  if (!status) return { id: runId, corrupt: "status.json missing or unparsable" };
  const meta = /** @type {{startedAt?: unknown}|null} */ (readJsonTolerant(join(runDir, "run.json")));
  const nodes = /** @type {Record<string, any>[]} */ (status.nodes);
  const nodesDone = nodes.filter((node) => node.status === "done" || node.status === "no-op").length;
  const attempts = nodes.reduce((max, node) => Math.max(max, node.attempt ?? 0), 0);
  const terminal = nodes.length > 0 && nodes.every((node) => TERMINAL_STATUSES.has(node.status));
  const attentionNode = nodes.find((node) => RESUME_STATES.has(node.status));
  const startedAt = typeof meta?.startedAt === "string" ? meta.startedAt : null;
  const updatedAt = lastEventAt(runDir) ?? startedAt;
  return {
    id: runId,
    corrupt: null,
    campaignId: typeof status.campaignId === "string" ? status.campaignId : null,
    goal: oneLine(typeof status.goal === "string" ? status.goal : ""),
    nodesDone,
    nodesTotal: nodes.length,
    attempts,
    elapsedMs: elapsedMsBetween(startedAt, terminal ? updatedAt : null),
    costUsd: typeof status.usage?.costUsd === "number" ? status.usage.costUsd : null,
    startedAt,
    updatedAt,
    controllerActive: status.controller?.state === "active",
    state: attentionNode ? "attention" : terminal ? "done" : "active",
  };
}

/** "Needs you" items across a campaign's linked runs: one per attention-state node plus one per orphaned running node, each carrying the exact command that resolves it. @param {string} runsDir @param {string[]} runIds @returns {Record<string, unknown>[]} */
function needsYouItems(runsDir, runIds) {
  const items = [];
  for (const runId of runIds) {
    const runDir = join(runsDir, runId);
    const status = readRunStatus(runDir);
    if (!status) continue;
    const controllerActive = status.controller?.state === "active";
    for (const node of /** @type {Record<string, any>[]} */ (status.nodes)) {
      if (RESUME_STATES.has(node.status)) {
        const reconcile = node.errorCode === "unknown_effect_reconciled";
        items.push({
          runId,
          nodeId: node.id,
          status: node.status,
          errorCode: node.errorCode ?? null,
          note: node.note ?? null,
          command: reconcile ? `resume ${runDir} --reconcile ${node.id}` : `resume ${runDir}`,
        });
      } else if (node.status === "running" && !controllerActive) {
        items.push({
          runId,
          nodeId: node.id,
          status: "orphaned",
          errorCode: null,
          note: "the controller process is gone while this node still claims to be running",
          command: `resume ${runDir}`,
        });
      }
    }
  }
  return items;
}

/** The "now" strip: the run with a live controller, or the most recently updated run when the campaign is idle. @param {string} runsDir @param {Record<string, any>[]} runs @returns {Record<string, unknown>} */
function nowStrip(runsDir, runs) {
  const readable = runs.filter((run) => !/** @type {any} */ (run).corrupt);
  const active = /** @type {any} */ (readable.find((run) => /** @type {any} */ (run).controllerActive));
  if (active) {
    const runDir = join(runsDir, active.id);
    const status = readRunStatus(runDir);
    const runningNode = status?.nodes.find((/** @type {any} */ node) => node.status === "running") ?? null;
    const startedAt = runningNode ? /** @type {any} */ (readJsonTolerant(join(runDir, "nodes", `${runningNode.id}.json`)))?.startedAt ?? null : null;
    return {
      state: "active",
      runId: active.id,
      nodeId: runningNode?.id ?? null,
      elapsedMs: startedAt ? elapsedMsBetween(startedAt, null) : null,
      costUsd: active.costUsd,
      updatedAt: active.updatedAt,
    };
  }
  const idle = readable.slice().sort((left, right) => String(/** @type {any} */ (right).updatedAt ?? "").localeCompare(String(/** @type {any} */ (left).updatedAt ?? "")))[0];
  return { state: "idle", runId: idle ? /** @type {any} */ (idle).id : null, updatedAt: idle ? /** @type {any} */ (idle).updatedAt : null };
}

/** @param {Record<string, any>|null|undefined} verification */
function verificationTab(verification) {
  if (!verification || !Array.isArray(verification.commands)) return null;
  return {
    passed: verification.passed ?? null,
    commands: verification.commands.map((command) => {
      const last = Array.isArray(command.attempts) ? command.attempts.at(-1) : null;
      return {
        command: Array.isArray(command.argv) ? command.argv.join(" ") : "",
        passed: command.passed ?? last?.passed ?? null,
        durationMs: last?.durationMs ?? null,
        outputTail: truncateChars(`${last?.stdout ?? ""}${last?.stderr ? `\n${last.stderr}` : ""}`.trim(), OUTPUT_TAIL_MAX_BYTES),
      };
    }),
  };
}

/** @param {Record<string, any>|null|undefined} scope */
function diffTab(scope) {
  if (!scope) return null;
  const changed = Array.isArray(scope.changedPaths) ? scope.changedPaths : [];
  const unexpected = Array.isArray(scope.unexpectedPaths) ? scope.unexpectedPaths : [];
  const count = scope.changedPathCount ?? changed.length;
  return {
    stat: `${count} file${count === 1 ? "" : "s"} changed${unexpected.length ? ` · ${unexpected.length} unexpected` : ""}`,
    files: changed.slice(0, DIFF_PATH_CAP),
    unexpected: unexpected.slice(0, DIFF_PATH_CAP),
    truncated: changed.length > DIFF_PATH_CAP,
  };
}

/** @param {Record<string, any>|null|undefined} gate */
function findingsTab(gate) {
  if (!gate) return null;
  return {
    verdict: gate.verdict ?? null,
    maxSeverity: gate.maxSeverity ?? null,
    summary: gate.summary ?? null,
    findings: (Array.isArray(gate.findings) ? gate.findings : []).map((finding) => ({
      severity: finding.severity,
      description: finding.description,
      evidence: truncateChars(finding.evidence ?? "", 1024),
    })),
  };
}

/** @param {Record<string, any>[]} invocations @returns {Record<string, any>|undefined} */
function lastWorkerInvocation(invocations) {
  return [...(Array.isArray(invocations) ? invocations : [])].reverse().find((invocation) => invocation.role === "worker");
}

/** @param {string} runDir @param {Record<string, any>} node @returns {{lines: string[], path: string|null}} */
function workerLogTab(runDir, node) {
  const worker = lastWorkerInvocation(node.invocations);
  if (!worker?.stdoutPath) return { lines: [], path: null };
  return { lines: tailTextLines(worker.stdoutPath, LOG_TAIL_MAX_LINES, LOG_TAIL_MAX_BYTES), path: basename(worker.stdoutPath) };
}

/** @param {Record<string, any>} node @returns {string|null} */
function promptTab(node) {
  const worker = lastWorkerInvocation(node.invocations);
  if (!worker?.promptPath || !existsSync(worker.promptPath)) return null;
  try {
    return truncateChars(readFileSync(worker.promptPath, "utf8"), PROMPT_MAX_CHARS);
  } catch {
    return null;
  }
}

/** The five drawer tabs for one node. @param {string} runDir @param {string} nodeId @returns {Record<string, unknown>|null} */
function nodeDetail(runDir, nodeId) {
  const node = readJsonTolerant(join(runDir, "nodes", `${nodeId}.json`));
  if (!node || typeof node !== "object") return null;
  const record = /** @type {Record<string, any>} */ (node);
  return {
    id: nodeId,
    log: workerLogTab(runDir, record),
    verification: verificationTab(record.verification),
    diff: diffTab(record.scope),
    findings: findingsTab(record.gate),
    prompt: promptTab(record),
  };
}

/** The drawer's node-row summary: `status.json`'s node entry merged with the node JSON's own fields. @param {string} runDir @param {Record<string, any>} statusNode @returns {Record<string, unknown>} */
function nodeRow(runDir, statusNode) {
  const node = /** @type {Record<string, any>} */ (readJsonTolerant(join(runDir, "nodes", `${statusNode.id}.json`)) ?? {});
  const closed = TERMINAL_STATUSES.has(statusNode.status);
  return {
    id: statusNode.id,
    status: statusNode.status,
    attempt: statusNode.attempt,
    revisions: statusNode.revisions,
    model: node.runtime?.model ?? null,
    elapsedMs: elapsedMsBetween(node.startedAt, closed ? node.updatedAt : null),
    costUsd: typeof node.costUsd === "number" ? node.costUsd : null,
    verdict: node.gate?.verdict ?? null,
    note: statusNode.note ?? null,
    errorCode: statusNode.errorCode ?? null,
    blockedBy: statusNode.blockedBy ?? [],
  };
}

/** @param {string} runsDir @param {string} runId @param {string|null} nodeId @returns {Record<string, unknown>|null} */
function runDrawer(runsDir, runId, nodeId) {
  const runDir = join(runsDir, runId);
  const status = readRunStatus(runDir);
  if (!status) return null;
  const nodes = /** @type {Record<string, any>[]} */ (status.nodes).map((node) => nodeRow(runDir, node));
  const selectedNodeId = nodeId && nodes.some((node) => node.id === nodeId) ? nodeId : null;
  return {
    runId,
    goal: typeof status.goal === "string" ? status.goal : "",
    campaignId: status.campaignId ?? null,
    nodes,
    selectedNodeId,
    detail: selectedNodeId ? nodeDetail(runDir, selectedNodeId) : null,
  };
}

/** @param {string} campaignPath @returns {string|null} */
function readHandoff(campaignPath) {
  const path = join(campaignPath, "HANDOFF.md");
  if (!existsSync(path)) return null;
  try {
    return truncateChars(readFileSync(path, "utf8"), HANDOFF_MAX_CHARS);
  } catch {
    return null;
  }
}

/** Shrink the payload, in order, until it fits the 200 KB ceiling: the open drawer's log tail, its verification output tails, its prompt, then the handoff text. @param {Record<string, any>} payload @returns {Record<string, unknown>} */
function boundSnapshot(payload) {
  const fits = () => Buffer.byteLength(JSON.stringify(payload), "utf8") <= SNAPSHOT_MAX_BYTES;
  if (fits()) return payload;
  const detail = payload.drawer?.detail;
  if (detail?.log?.lines) detail.log.lines = detail.log.lines.slice(-20);
  if (fits()) return payload;
  if (detail?.verification?.commands) detail.verification.commands = detail.verification.commands.map((/** @type {any} */ command) => ({ ...command, outputTail: truncateChars(command.outputTail, 200) }));
  if (fits()) return payload;
  if (detail?.prompt) detail.prompt = truncateChars(detail.prompt, 500);
  if (fits()) return payload;
  if (payload.handoff) payload.handoff = truncateChars(payload.handoff, 500);
  if (fits()) return payload;
  payload.runs = payload.runs.slice(0, 20);
  return payload;
}

/** The declared campaign id when it exists, else the active campaign, else the first one. @param {CampaignEntry[]} campaigns @param {string|null|undefined} campaignId @returns {CampaignEntry|null} */
function resolveCampaign(campaigns, campaignId) {
  if (campaignId) {
    const declared = campaigns.find(({ campaign }) => campaign.id === campaignId);
    if (declared) return declared;
  }
  return campaigns.find(({ campaign }) => campaign.status === "active") ?? campaigns[0] ?? null;
}

/** The full page snapshot: campaign list, the selected campaign's now strip, needs-you items, runs table and (when open) the drawer detail and handoff text. Read-only, bounded to ~200 KB. @param {string} runsDir @param {Selection} [selection] @returns {Record<string, unknown>} */
export function buildSnapshot(runsDir, selection = {}) {
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  const campaignList = campaigns.map(({ campaign }) => ({ id: campaign.id, goal: oneLine(campaign.goal), status: campaign.status }));
  const entry = resolveCampaign(campaigns, selection.campaignId);
  const selectedId = entry?.campaign.id ?? null;
  const linkedRunIds = entry ? entry.campaign.linkedRunIds : [];
  const runs = linkedRunIds.map((runId) => runSummary(runsDir, runId))
    .sort((left, right) => String(/** @type {any} */ (right).updatedAt ?? "").localeCompare(String(/** @type {any} */ (left).updatedAt ?? "")));
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaigns: campaignList,
    corrupt: corrupt.map((entry_) => entry_.id),
    selectedCampaignId: selectedId,
    now: entry ? nowStrip(runsDir, runs) : { state: "idle", runId: null, updatedAt: null },
    needsYou: entry ? needsYouItems(runsDir, linkedRunIds) : [],
    runs,
    drawer: (entry && selection.runId && linkedRunIds.includes(selection.runId)) ? runDrawer(runsDir, selection.runId, selection.nodeId ?? null) : null,
    handoff: entry ? readHandoff(campaignDir(runsDir, entry.campaign.id)) : null,
  };
  return boundSnapshot(payload);
}

/** Cheap fingerprint of every file a snapshot for this selection depends on, so the stream can skip re-sending an unchanged snapshot. @param {string} runsDir @param {Selection} selection @returns {string} */
export function snapshotSignature(runsDir, selection) {
  const { campaigns } = discoverCampaigns(runsDir);
  const parts = [fileSignature([campaignsDir(runsDir)])];
  for (const { path } of campaigns) parts.push(fileSignature([join(path, "campaign.json")]));
  const entry = resolveCampaign(campaigns, selection.campaignId);
  if (!entry) return parts.join("\n");
  parts.push(fileSignature([join(entry.path, "HANDOFF.md")]));
  for (const runId of entry.campaign.linkedRunIds) {
    const runDir = join(runsDir, runId);
    const nodeFiles = existsSync(join(runDir, "nodes")) ? readdirSync(join(runDir, "nodes")).filter((name) => name.endsWith(".json")).sort().map((name) => join(runDir, "nodes", name)) : [];
    parts.push(fileSignature([join(runDir, "status.json"), join(runDir, "run.json"), join(runDir, "notify.jsonl"), join(runDir, "events.jsonl"), ...nodeFiles]));
  }
  if (selection.runId && selection.nodeId && entry.campaign.linkedRunIds.includes(selection.runId)) {
    const runDir = join(runsDir, selection.runId);
    const node = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runDir, "nodes", `${selection.nodeId}.json`)));
    const worker = node ? lastWorkerInvocation(node.invocations) : null;
    parts.push(fileSignature(/** @type {string[]} */ ([worker?.stdoutPath, worker?.promptPath].filter((value) => typeof value === "string"))));
  }
  return parts.join("\n");
}

/** @param {URL} url @param {string} key @returns {string|null} */
function safeParam(url, key) {
  const value = url.searchParams.get(key);
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value) ? value : null;
}

/** @param {URL} url @returns {{campaignId: string|null, runId: string|null, nodeId: string|null}} */
function selectionOf(url) {
  return { campaignId: safeParam(url, "campaign"), runId: safeParam(url, "run"), nodeId: safeParam(url, "node") };
}

/** Read-only dashboard server bound to localhost: the static page, a snapshot endpoint for polling clients and an SSE stream. @param {{runsDir: string, port?: number, host?: string, pollMs?: number}} options @returns {import("node:http").Server} */
export function startServer({ runsDir, port = 4173, host = "127.0.0.1", pollMs = STREAM_POLL_MS }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") return sendFile(response, join(HERE, "index.html"), "text/html; charset=utf-8");
      if (url.pathname === "/api/snapshot") return sendJson(response, buildSnapshot(runsDir, selectionOf(url)));
      if (url.pathname === "/api/stream") return streamSnapshots(request, response, runsDir, selectionOf(url), pollMs);
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(port, host);
  return server;
}

/** Pushes a fresh snapshot on connect and whenever the selection's signature changes. @param {import("node:http").IncomingMessage} request @param {import("node:http").ServerResponse} response @param {string} runsDir @param {Selection} selection @param {number} pollMs */
function streamSnapshots(request, response, runsDir, selection, pollMs) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let lastSignature = "";
  const push = () => {
    const signature = snapshotSignature(runsDir, selection);
    if (signature === lastSignature) return;
    lastSignature = signature;
    response.write(`event: update\ndata: ${JSON.stringify(buildSnapshot(runsDir, selection))}\n\n`);
  };
  push();
  const poll = setInterval(() => {
    try { push(); } catch (error) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
    }
  }, pollMs);
  const ping = setInterval(() => response.write(`: ping ${Date.now()}\n\n`), STREAM_PING_MS);
  const stop = () => { clearInterval(poll); clearInterval(ping); };
  request.on("close", stop);
  response.on("close", stop);
}

/** @param {import("node:http").ServerResponse} response @param {string} path @param {string} type */
function sendFile(response, path, type) {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(readFileSync(path));
}

/** @param {import("node:http").ServerResponse} response @param {unknown} payload */
function sendJson(response, payload) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function main() {
  const arguments_ = process.argv.slice(2);
  let port = 4173;
  let cwd = process.cwd();
  for (let index = 0; index < arguments_.length; index += 2) {
    if (arguments_[index] === "--port") port = Number(arguments_[index + 1]);
    if (arguments_[index] === "--cwd") cwd = arguments_[index + 1];
  }
  const runsDir = join(cwd, ".runs");
  const server = startServer({ runsDir, port });
  server.on("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`intent-factory dashboard on http://127.0.0.1:${actualPort} (runs: ${runsDir})\n`);
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
