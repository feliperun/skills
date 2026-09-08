import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { campaignsDir, discoverCampaigns } from "../scripts/campaign.mjs";
import { lockPath, lockStale, readLock } from "../scripts/lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERVIEW_TAIL_BYTES = 32 * 1024;
const JOURNAL_TAIL_ENTRIES = 80;
const EVENTS_TAIL_ENTRIES = 40;
/** How often a stream connection re-checks the on-disk signature. */
export const STREAM_POLL_MS = 700;
/** Keep-alive comment interval so proxies and browsers never drop an idle stream. */
const STREAM_PING_MS = 15_000;
const TERMINAL = new Set(["done", "failed", "blocked", "exhausted", "cancelled", "canceled", "no-op"]);

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJsonTolerant(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read the last complete JSONL entries of an append-only journal without
 * loading the whole file. Partially written trailing lines are dropped.
 *
 * @param {string} path
 * @param {number} maxEntries
 * @param {number} maxBytes
 * @returns {Record<string, unknown>[]}
 */
export function tailJsonl(path, maxEntries, maxBytes = OVERVIEW_TAIL_BYTES) {
  if (!existsSync(path)) return [];
  /** @type {Buffer} */
  let bytes = Buffer.alloc(0);
  const handle = statSync(path);
  const readLength = Math.min(handle.size, maxBytes);
  if (readLength > 0) bytes = readWindow(path, readLength, handle.size - readLength);
  let text = bytes.toString("utf8");
  const skipped = handle.size > maxBytes ? text.indexOf("\n") + 1 : 0;
  text = text.slice(skipped);
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)));
    } catch {
      // A line torn by a concurrent append is dropped, not fatal.
    }
  }
  return entries.slice(-maxEntries);
}

/**
 * @param {string} path
 * @param {number} length
 * @param {number} position
 * @returns {Buffer}
 */
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

/**
 * Node status counts plus freshness for one run directory, read from raw
 * snapshots only: safe against runs that fail full contract validation.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {{id: string, goal: string, nodeCounts: Record<string, number>, nodeStates: string[], updatedAt: string|null, corrupt: string|null}}
 */
export function runOverview(runsDir, runId) {
  const runDir = join(runsDir, runId);
  const contract = /** @type {{goal?: unknown}|null} */ (readJsonTolerant(join(runDir, "contract.json")));
  const nodeCounts = /** @type {Record<string, number>} */ ({});
  const nodeStates = /** @type {string[]} */ ([]);
  let updatedAt = null;
  for (const node of readNodeSnapshots(runDir)) {
    const status = typeof node.status === "string" ? node.status : "unknown";
    nodeCounts[status] = (nodeCounts[status] ?? 0) + 1;
    nodeStates.push(status);
    if (typeof node.updatedAt === "string" && node.updatedAt > (updatedAt ?? "")) updatedAt = node.updatedAt;
  }
  return {
    id: runId,
    goal: typeof contract?.goal === "string" ? contract.goal : "",
    nodeCounts,
    nodeStates,
    updatedAt,
    corrupt: contract ? null : "contract.json missing or unparsable",
  };
}

/**
 * @param {string} runDir
 * @returns {Record<string, any>[]}
 */
function readNodeSnapshots(runDir) {
  const nodeDir = join(runDir, "nodes");
  if (!existsSync(nodeDir)) return [];
  /** @type {Record<string, any>[]} */
  const nodes = [];
  for (const name of readdirSync(nodeDir).filter((candidate) => candidate.endsWith(".json")).sort()) {
    const node = readJsonTolerant(join(nodeDir, name));
    if (node && typeof node === "object") nodes.push(/** @type {Record<string, any>} */ (node));
  }
  return nodes;
}

/**
 * @param {string} runsDir
 * @returns {{schemaVersion: 1, generatedAt: string, activeCampaignId: string|null, campaigns: unknown[], corrupt: string[]}}
 */
export function buildOverview(runsDir) {
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  const listed = campaigns.map(({ path, campaign }) => {
    const runs = campaign.linkedRunIds.map((runId) => runOverview(runsDir, runId));
    return {
      id: campaign.id,
      status: campaign.status,
      goal: campaign.goal,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      runCount: runs.length,
      nodeCounts: sumCounts(runs.map((run) => run.nodeCounts)),
      nodeStates: runs.flatMap((run) => run.nodeStates),
      weightedInputTokens: campaignWeightedUsage(path),
      live: runs.some((run) => (run.nodeCounts.running ?? 0) > 0),
    };
  });
  const active = listed.find((entry) => entry.status === "active");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activeCampaignId: active ? active.id : null,
    campaigns: listed,
    corrupt: corrupt.map((entry) => entry.id),
  };
}

/**
 * Weighted campaign usage across every epoch in its ledger, using each
 * epoch's own cache weight. Zero when no ledger exists yet.
 *
 * @param {string} campaignPath
 * @returns {number}
 */
function campaignWeightedUsage(campaignPath) {
  const ledger = /** @type {{epochs?: Record<string, {policy?: {cacheReadWeight?: number}, invocations?: Record<string, {usage?: {inputTokens?: number, cacheReadInputTokens?: number}}>}>}}|null} */ (readJsonTolerant(join(campaignPath, "usage-ledger.json")));
  let weighted = 0;
  for (const epoch of Object.values(ledger?.epochs ?? {})) {
    const weight = epoch.policy?.cacheReadWeight ?? 0;
    for (const invocation of Object.values(epoch.invocations ?? {})) {
      weighted += (invocation.usage?.inputTokens ?? 0) + (invocation.usage?.cacheReadInputTokens ?? 0) * weight;
    }
  }
  return Math.round(weighted);
}

/**
 * Full detail payload for one campaign: projection, ledger, notifications,
 * journal tail and per-run state read from raw snapshots (never through
 * contract validation, which costs seconds per run). There is no more
 * campaign-level heartbeat: `heartbeat` stays null so the page falls back to
 * deriving "now" from the linked runs' own node snapshots, as it already does
 * whenever no heartbeat was ever recorded.
 *
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {Record<string, unknown>}
 */
export function buildCampaignDetail(runsDir, campaignId) {
  const campaignPath = join(campaignsDir(runsDir), campaignId);
  const campaign = /** @type {Record<string, unknown>|null} */ (readJsonTolerant(join(campaignPath, "campaign.json")));
  if (!campaign) throw new Error(`unknown campaign ${campaignId}`);
  const projection = /** @type {{projection?: Record<string, unknown>}|null} */ (readJsonTolerant(join(campaignPath, "projection.json")));
  const folded = projection?.projection ?? {};
  const linkedRunIds = Array.isArray(campaign.linkedRunIds) ? /** @type {string[]} */ (campaign.linkedRunIds) : [];
  const runs = linkedRunIds
    .map((runId) => runDetailCached(runsDir, runId))
    .sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaign,
    heartbeat: null,
    next: folded.next ?? null,
    decisions: latestById(folded.decisions, 50),
    questions: latestById(folded.questions, 20),
    constraints: orderedList(folded.constraints),
    intents: orderedList(folded.intents),
    outcomes: orderedList(folded.outcomes, 40),
    sessions: orderedList(folded.sessions),
    ledger: ledgerSummary(join(campaignPath, "usage-ledger.json")),
    outbox: notificationsSummary(runsDir, linkedRunIds),
    journalTail: tailJsonl(join(campaignPath, "journal.jsonl"), JOURNAL_TAIL_ENTRIES, 512 * 1024)
      .filter((entry) => entry.type !== "liveness")
      .reverse(),
    runs,
  };
}

/** @type {Map<string, {signature: string, payload: Record<string, unknown>}>} */
const runDetailCache = new Map();

/**
 * @param {string} runsDir
 * @param {string} runId
 * @returns {Record<string, unknown>}
 */
function runDetailCached(runsDir, runId) {
  const runDir = join(runsDir, runId);
  const signature = runSignature(runDir);
  const cached = runDetailCache.get(runDir);
  if (cached && cached.signature === signature) return cached.payload;
  const payload = runDetail(runsDir, runId);
  runDetailCache.set(runDir, { signature, payload });
  return payload;
}

/**
 * Cheap fingerprint of everything runDetail reads: metadata, contract, lock,
 * node snapshots and the events journal.
 *
 * @param {string} runDir
 * @returns {string}
 */
function runSignature(runDir) {
  return fileSignature([
    join(runDir, "run.json"),
    join(runDir, "contract.json"),
    join(runDir, "status.json"),
    join(runDir, "notify.jsonl"),
    lockPath(runDir),
    join(runDir, "events.jsonl"),
    ...(existsSync(join(runDir, "nodes")) ? readdirSync(join(runDir, "nodes")).filter((name) => name.endsWith(".json")).sort().map((name) => join(runDir, "nodes", name)) : []),
  ]);
}

/**
 * @param {string[]} paths
 * @returns {string}
 */
function fileSignature(paths) {
  const parts = [];
  for (const path of paths) {
    try {
      const stat = statSync(path);
      parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${path}:-`);
    }
  }
  return parts.join("|");
}

/**
 * Everything the stream watches for one campaign: its own files plus every
 * linked run. Any change here is pushed to connected browsers.
 *
 * @param {string} runsDir
 * @param {string|null} campaignId
 * @returns {string}
 */
export function campaignSignature(runsDir, campaignId) {
  const parts = [fileSignature([campaignsDir(runsDir)])];
  const campaignsRoot = campaignsDir(runsDir);
  if (existsSync(campaignsRoot)) {
    for (const name of readdirSync(campaignsRoot)) parts.push(fileSignature([join(campaignsRoot, name, "campaign.json")]));
  }
  if (campaignId) {
    const campaignPath = join(campaignsRoot, campaignId);
    parts.push(fileSignature(["journal.jsonl", "projection.json", "usage-ledger.json"].map((name) => join(campaignPath, name))));
    const campaign = /** @type {{linkedRunIds?: unknown}|null} */ (readJsonTolerant(join(campaignPath, "campaign.json")));
    for (const runId of Array.isArray(campaign?.linkedRunIds) ? /** @type {string[]} */ (campaign.linkedRunIds) : []) parts.push(runSignature(join(runsDir, runId)));
  }
  return parts.join("\n");
}

/**
 * Raw run detail: contract plan (tolerant), controller status, node snapshots
 * projected to what the page shows, and the events tail. A run whose files
 * are unreadable is still listed, flagged `corrupt`.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {Record<string, unknown>}
 */
function runDetail(runsDir, runId) {
  const runDir = join(runsDir, runId);
  const contract = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runDir, "contract.json")));
  if (!contract) return { id: runId, corrupt: "contract.json missing or unparsable", nodes: [], eventsTail: [] };
  const planNodes = new Map((Array.isArray(contract.nodes) ? contract.nodes : []).map((/** @type {Record<string, any>} */ node) => [node.id, node]));
  const weight = typeof contract.usagePolicy?.cacheReadWeight === "number" ? contract.usagePolicy.cacheReadWeight : 1;
  const nodes = readNodeSnapshots(runDir).map((node) => projectNode(node, planNodes.get(node.id) ?? {}, contract, weight));
  const counts = /** @type {Record<string, number>} */ ({});
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  const eventsTail = tailJsonl(join(runDir, "events.jsonl"), EVENTS_TAIL_ENTRIES).reverse();
  const lastEvent = eventsTail[0];
  const terminal = nodes.length > 0 && nodes.every((node) => TERMINAL.has(node.status));
  let controllerActive = false;
  try {
    const lock = readLock(runDir);
    controllerActive = Boolean(lock) && !/** @type {{invalid?: true}} */ (lock).invalid && !lockStale(lock);
  } catch { controllerActive = false; }
  const totals = nodes.reduce((acc, node) => ({
    inputTokens: acc.inputTokens + (node.usage?.inputTokens ?? 0),
    outputTokens: acc.outputTokens + (node.usage?.outputTokens ?? 0),
    cacheReadInputTokens: acc.cacheReadInputTokens + (node.usage?.cacheReadInputTokens ?? 0),
    weightedInputTokens: acc.weightedInputTokens + node.weightedInputTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, weightedInputTokens: 0 });
  return {
    id: runId,
    corrupt: null,
    goal: typeof contract.goal === "string" ? contract.goal : "",
    campaignId: contract.campaignId ?? null,
    summary: Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(" · "),
    terminal,
    controllerActive,
    usagePolicy: contract.usagePolicy ?? false,
    maxInputTokens: contract.maxInputTokens ?? null,
    totals,
    startedAt: runStartedAt(runDir),
    updatedAt: nodes.reduce((latest, node) => (node.updatedAt && node.updatedAt > latest ? node.updatedAt : latest), ""),
    nodes,
    eventsTail,
    lastEventAt: typeof lastEvent?.at === "string" ? lastEvent.at : null,
  };
}

/**
 * @param {Record<string, any>} node
 * @param {Record<string, any>} plan
 * @param {Record<string, any>} contract
 * @param {number} weight
 */
function projectNode(node, plan, contract, weight) {
  const usage = node.usage && typeof node.usage === "object" ? node.usage : null;
  const weighted = Math.round((usage?.inputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0) * weight);
  const invocations = Array.isArray(node.invocations) ? node.invocations : [];
  const last = invocations[invocations.length - 1];
  const budget = node.budgetState && typeof node.budgetState === "object" ? node.budgetState : null;
  const decision = node.budgetDecision && typeof node.budgetDecision === "object" ? node.budgetDecision : null;
  return {
    id: node.id,
    status: typeof node.status === "string" ? node.status : "unknown",
    phase: plan.phase ?? null,
    executionPhase: node.phase ?? null,
    runtime: node.runtime?.id ?? plan.runtime ?? contract.runtimeDefaults?.worker ?? null,
    model: node.runtime?.model ?? null,
    attempt: node.attempt ?? 0,
    revisions: node.revisions ?? 0,
    invocations: invocations.length,
    continuation: last?.continuationMode ?? null,
    usage,
    weightedInputTokens: weighted,
    costUsd: typeof node.costUsd === "number" ? node.costUsd : null,
    gate: node.gate ? { verdict: node.gate.verdict ?? null, maxSeverity: node.gate.maxSeverity ?? null, summary: node.gate.summary ?? null, findings: Array.isArray(node.gate.findings) ? node.gate.findings.length : 0 } : null,
    error: node.error ? { code: node.error.code ?? null, message: node.error.message ?? null } : null,
    blockedBy: Array.isArray(node.blockedBy) ? node.blockedBy : [],
    budget: budget ? {
      capTokens: budget.currentCapTokens ?? null,
      hardCapTokens: decision?.hardCapTokens ?? null,
      initialTokens: decision?.initialAllocationTokens ?? null,
      segment: budget.segment ?? 1,
      maxSegments: decision?.maxSegments ?? 1,
      status: budget.status ?? null,
      pendingSegment: budget.pendingSegment ? budget.pendingSegment.segment : null,
    } : null,
    dependsOn: Array.isArray(plan.dependsOn) ? plan.dependsOn : [],
    startedAt: node.startedAt ?? null,
    updatedAt: node.updatedAt ?? null,
    note: node.gate?.summary ?? node.error?.message ?? (Array.isArray(node.blockedBy) && node.blockedBy.length ? `blocked by ${node.blockedBy.join(", ")}` : null) ?? node.phase ?? "",
  };
}

/**
 * @param {string} runDir
 * @returns {string|null}
 */
function runStartedAt(runDir) {
  const metadata = /** @type {{startedAt?: unknown}|null} */ (readJsonTolerant(join(runDir, "run.json")));
  if (typeof metadata?.startedAt === "string") return metadata.startedAt;
  let earliest = null;
  for (const node of readNodeSnapshots(runDir)) {
    if (typeof node.startedAt === "string" && (earliest === null || node.startedAt < earliest)) earliest = node.startedAt;
  }
  return earliest;
}

/**
 * @param {unknown} section
 * @param {number} [limit]
 * @returns {Record<string, unknown>[]}
 */
function latestById(section, limit) {
  const entries = Array.isArray(section) ? /** @type {Record<string, unknown>[]} */ (section) : Object.values(/** @type {Record<string, Record<string, unknown>>} */ (section ?? {}));
  return entries.sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? ""))).slice(0, limit ?? entries.length);
}

/**
 * @param {unknown} section
 * @param {number} [limit]
 * @returns {Record<string, unknown>[]}
 */
function orderedList(section, limit) {
  const entries = Array.isArray(section) ? /** @type {Record<string, unknown>[]} */ (section) : [];
  const ordered = entries.slice().sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
  return limit === undefined ? ordered : ordered.slice(0, limit);
}

/**
 * Per-epoch usage roll-up: weighted, conservative and by role.
 *
 * @param {string} ledgerPath
 * @returns {{epochs: unknown[]}}
 */
function ledgerSummary(ledgerPath) {
  const ledger = /** @type {{epochs?: Record<string, {policy?: Record<string, unknown>, invocations?: Record<string, {role?: string, usage?: {inputTokens?: number, cacheReadInputTokens?: number}}>}>}}|null} */ (readJsonTolerant(ledgerPath));
  const epochs = [];
  for (const [epoch, entry] of Object.entries(ledger?.epochs ?? {})) {
    const weight = typeof entry.policy?.cacheReadWeight === "number" ? /** @type {number} */ (entry.policy.cacheReadWeight) : 0;
    let weighted = 0;
    let conservative = 0;
    /** @type {Record<string, number>} */
    const byRole = {};
    /** @type {Record<string, number>} */
    const weightedByRole = {};
    const invocations = Object.values(entry.invocations ?? {});
    for (const invocation of invocations) {
      const input = invocation.usage?.inputTokens ?? 0;
      const cache = invocation.usage?.cacheReadInputTokens ?? 0;
      const role = invocation.role ?? "unknown";
      weighted += input + cache * weight;
      conservative += input + cache;
      byRole[role] = (byRole[role] ?? 0) + 1;
      weightedByRole[role] = (weightedByRole[role] ?? 0) + input + cache * weight;
    }
    epochs.push({
      epoch,
      policy: entry.policy ?? null,
      invocations: invocations.length,
      weightedInputTokens: Math.round(weighted),
      conservativeInputTokens: conservative,
      byRole,
      weightedByRole: Object.fromEntries(Object.entries(weightedByRole).map(([role, value]) => [role, Math.round(value)])),
    });
  }
  return { epochs };
}

/**
 * Notify receipts across every linked run's `notify.jsonl`, reshaped into the
 * same pending/recent split the page already renders: a `failed` receipt is
 * the last attempt the controller recorded for that event and stays pending
 * until a later attempt in the same file supersedes it, while a `delivered`
 * or `no_transport` receipt is terminal.
 *
 * @param {string} runsDir
 * @param {string[]} linkedRunIds
 * @returns {{pending: Record<string, unknown>[], recent: Record<string, unknown>[], pendingCount: number}}
 */
function notificationsSummary(runsDir, linkedRunIds) {
  /** @type {Record<string, unknown>[]} */
  const receipts = [];
  for (const runId of linkedRunIds) {
    for (const entry of tailJsonl(join(runsDir, runId, "notify.jsonl"), 200)) receipts.push({ ...entry, runId });
  }
  receipts.sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")));
  const pendingAll = receipts.filter((entry) => entry.status === "failed");
  const settled = receipts.filter((entry) => entry.status === "delivered" || entry.status === "no_transport").slice(-10).reverse();
  return { pending: pendingAll.slice(-20).reverse(), recent: settled, pendingCount: pendingAll.length };
}

/**
 * @param {Record<string, number>[]} counts
 * @returns {Record<string, number>}
 */
function sumCounts(counts) {
  /** @type {Record<string, number>} */
  const total = {};
  for (const entry of counts) for (const [status, count] of Object.entries(entry)) total[status] = (total[status] ?? 0) + count;
  return total;
}

/**
 * Snapshot pushed to every stream client: the overview plus the selected
 * campaign's detail, or a bounded error for an unknown campaign.
 *
 * @param {string} runsDir
 * @param {string|null} campaignId
 * @returns {Record<string, unknown>}
 */
export function buildSnapshot(runsDir, campaignId) {
  const overview = buildOverview(runsDir);
  const selected = campaignId ?? overview.activeCampaignId ?? /** @type {any} */ (overview.campaigns[0])?.id ?? null;
  let detail = null;
  let error = null;
  if (selected) {
    try {
      detail = buildCampaignDetail(runsDir, selected);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), runsDir, selected, overview, detail, error };
}

/**
 * Read-only dashboard server bound to localhost: the static UI, two JSON
 * endpoints for polling clients and a Server-Sent Events stream that pushes a
 * fresh snapshot whenever a watched file under .runs changes.
 *
 * @param {{runsDir: string, port?: number, host?: string, pollMs?: number}} options
 * @returns {import("node:http").Server}
 */
export function startServer({ runsDir, port = 4173, host = "127.0.0.1", pollMs = STREAM_POLL_MS }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") return sendFile(response, join(HERE, "index.html"), "text/html; charset=utf-8");
      if (url.pathname === "/api/overview") return sendJson(response, buildOverview(runsDir));
      if (url.pathname === "/api/snapshot") return sendJson(response, buildSnapshot(runsDir, campaignParam(url)));
      if (url.pathname === "/api/stream") return streamSnapshots(request, response, runsDir, campaignParam(url), pollMs);
      const detail = url.pathname.match(/^\/api\/campaigns\/([a-z0-9][a-z0-9._-]*)$/);
      if (detail) return sendJson(response, buildCampaignDetail(runsDir, detail[1]));
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

/**
 * @param {URL} url
 * @returns {string|null}
 */
function campaignParam(url) {
  const value = url.searchParams.get("campaign");
  return value && /^[a-z0-9][a-z0-9._-]*$/u.test(value) ? value : null;
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} runsDir
 * @param {string|null} campaignId
 * @param {number} pollMs
 */
function streamSnapshots(request, response, runsDir, campaignId, pollMs) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let lastSignature = "";
  let watchedCampaignId = campaignId;
  const push = () => {
    if (!watchedCampaignId) watchedCampaignId = buildOverview(runsDir).activeCampaignId;
    const signature = campaignSignature(runsDir, watchedCampaignId);
    if (signature === lastSignature) return;
    lastSignature = signature;
    response.write(`event: update\ndata: ${JSON.stringify(buildSnapshot(runsDir, watchedCampaignId))}\n\n`);
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

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} path
 * @param {string} type
 */
function sendFile(response, path, type) {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(readFileSync(path));
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {unknown} payload
 */
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
