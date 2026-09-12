import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { validateContract } from "../contract/index.mjs";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { lockStale, pidAlive, readLock } from "../run/lock.mjs";
import { scopeFindingsNote } from "../contract/scope-findings.mjs";
import { reviewNote } from "../contract/review-modes.mjs";
import { validateNodeSnapshot, validateRunMetadata } from "../contract/snapshot.mjs";
import { compactCost, compactTokens, truncateChars } from "../util.mjs";

/** Advisory ceiling for status.json (TECH-SPEC lean, rule 5); never enforced destructively. */
const STATUS_JSON_MAX_BYTES = 200 * 1024;
const STATUS_POINTER_FILE = "status.json";
const STATUS_POINTER_MAX_BYTES = 1024;
const POINTER_STRING_CHARS = 64;
const POINTER_ATTENTION_CHARS = 80;

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").NodeStatus} NodeStatus */
/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} StatusPayloadUsage */
/** @typedef {{id: string, status: NodeStatus, phase: string|null, executionPhase: string|null, runtime: string|null, continuation: string, attempt: number, revisions: number, startedAt: string|null, updatedAt: string|null, usage: StatusPayloadUsage|null, costUsd: number|null, verdict: string|null, pendingHandoff: {runtime: string, reason: string}|null, note: string|null, scopeFindings: string[]|null, errorCode: string|null, blockedBy: string[]}} StatusPayloadNode */
/** @typedef {{schemaVersion: 1, run: string, contractId: string, campaignId: string, goal: string, usage: {inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null}, controller: JsonObject, identityWarnings: string[], summary: string, nodes: StatusPayloadNode[]}} StatusPayload */

const MARK = {
  pending: "[ ]",
  running: "[>]",
  done: "[+]",
  "no-op": "[.]",
  blocked: "[!]",
  failed: "[x]",
  exhausted: "[$]",
  stalled: "[~]",
  canceled: "[/]",
};

/**
 * `status <run-dir>`: everything the operator needs, in the same order as
 * the dashboard page (TECH-SPEC lean, section 4's last paragraph) —
 * needs-you, now, nodes, cost. Every cell comes from the same payload
 * `status --json` and the per-run `status.json` file emit
 * (`buildStatusPayload`); `nodes` and `identityWarnings` from `loadRun` are
 * used only for the two facts the payload does not carry: throwing on an
 * invalid persisted snapshot, and `controllerStatus`'s lock read.
 *
 * @param {string} runDir
 * @returns {string}
 */
export function renderStatus(runDir) {
  const { contract, nodes, identityWarnings } = loadRun(runDir);
  const usage = readRunUsage(runDir);
  const payload = buildStatusPayload(runDir, contract, nodes, identityWarnings, usage);
  const controller = controllerStatus(runDir, nodes);
  const now = Date.now();

  const lines = [`# run ${payload.run}`, "", payload.goal, "", `controller: ${controller.line}`, ""];

  lines.push("## Needs you", "");
  const attention = payload.nodes.filter((node) => !["pending", "running", "done", "no-op"].includes(node.status));
  const orphans = controller.status.state !== "active" ? payload.nodes.filter((node) => node.status === "running").map((node) => node.id) : [];
  if (!attention.length && !orphans.length && !identityWarnings.length) lines.push("Nothing needs you right now.");
  if (orphans.length) lines.push(`- [>] the run process is gone while ${orphans.join(", ")} still claims to be running. Those nodes are orphans, not live work. Resume the run directory to adopt whatever their workers finished.`);
  for (const warning of identityWarnings) lines.push(`- [~] ${warning}`);
  for (const node of attention) lines.push(`- ${MARK[node.status] ?? "[?]"} ${node.id}: ${node.note ?? node.status}`);
  lines.push("", "## Now", "", nowLine(payload, now), "", "## Nodes", "");

  const widths = [3, 24, 9, 3, 28, 8, 6, 6, 6, 10, 9, MAX_NOTE_LENGTH];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  lines.push("```", row(["", "NODE", "STATE", "TRY", "RUNTIME", "ELAPSED", "IN", "CACHE", "OUT", "USD", "VERDICT", "NOTE"]), row(widths.map((width) => "-".repeat(width))));
  for (const node of payload.nodes) {
    lines.push(row([
      MARK[node.status] ?? "[?]",
      node.id,
      node.status,
      node.attempt ?? 0,
      node.runtime ?? "-",
      formatElapsed(node, now),
      compactTokens(node.usage?.inputTokens),
      compactTokens(node.usage?.cacheReadInputTokens),
      compactTokens(node.usage?.outputTokens),
      compactCost(node.costUsd),
      node.verdict ?? "-",
      node.note ?? "-",
    ]));
  }
  lines.push("```", "", "## Cost", "", `in ${compactTokens(usage.inputTokens)} · out ${compactTokens(usage.outputTokens)} · cache ${compactTokens(usage.cacheReadInputTokens)} · cost ${compactCost(usage.costUsd)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The node the operator should look at right now, formatted the same way
 * the dashboard's now strip is (TECH-SPEC lean, section 4, item 1): the
 * active node's elapsed time and cost so far, or an idle line once every
 * node has settled.
 *
 * @param {StatusPayload} payload
 * @param {number} now epoch ms
 * @returns {string}
 */
function nowLine(payload, now) {
  const active = activeStatusNode(payload.nodes);
  if (active) return `now: ${active.id} ${active.status} (${formatElapsed(active, now)}) · ${active.runtime ?? "-"} · ${compactCost(active.costUsd)}`;
  const allTerminal = payload.nodes.every((node) => ["done", "no-op"].includes(node.status));
  return allTerminal ? `now: idle · run done · ${compactCost(payload.usage.costUsd)}` : "now: idle";
}

/**
 * A node's wall-clock elapsed time: `startedAt` to `updatedAt` once it has
 * settled into a terminal state, `startedAt` to `now` while it is still
 * live (running, blocked or stalled), `-` before it ever started.
 *
 * @param {{status: string, startedAt: string|null, updatedAt: string|null}} node
 * @param {number} now epoch ms
 * @returns {string}
 */
function formatElapsed(node, now) {
  if (!node.startedAt) return "-";
  const start = Date.parse(node.startedAt);
  if (!Number.isFinite(start)) return "-";
  const terminal = ["done", "no-op", "failed", "exhausted", "canceled"].includes(node.status);
  const end = terminal && node.updatedAt ? Date.parse(node.updatedAt) : now;
  return formatDuration(Math.max(0, (Number.isFinite(end) ? end : now) - start));
}

/** @param {number} ms @returns {string} */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * JSON status for `status --json`: stable, machine-readable, no rendering.
 *
 * @param {string} runDir
 * @returns {string}
 */
export function renderStatusJson(runDir) {
  const { contract, nodes, identityWarnings } = loadRun(runDir);
  const usage = readRunUsage(runDir);
  const payload = buildStatusPayload(runDir, contract, nodes, identityWarnings, usage);
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * The status.json payload shared by the CLI (`status --json`, reading from
 * disk) and the controller's per-tick writer (in-memory node states): every
 * field is a durable fact, never a rendering choice.
 *
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {NodeSnapshot[]} nodes
 * @param {string[]} identityWarnings
 * @param {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null}} usage
 * @returns {StatusPayload}
 */
function buildStatusPayload(runDir, contract, nodes, identityWarnings, usage) {
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  return {
    schemaVersion: 1,
    run: basename(runDir),
    contractId: contract.id,
    campaignId: contract.campaignId,
    goal: contract.goal,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      costUsd: usage.costUsd,
    },
    controller: controllerStatus(runDir, nodes).status,
    identityWarnings,
    summary: [...counts].map(([status, count]) => `${count} ${status}`).join(" · "),
    nodes: nodes.map((node) => ({
      id: node.id,
      status: node.status,
      phase: contract.nodes.find((candidate) => candidate.id === node.id)?.phase ?? null,
      executionPhase: node.phase,
      runtime: node.runtime ? `${node.runtime.harness}/${node.runtime.model}` : null,
      continuation: continuationMode(node),
      attempt: node.attempt,
      revisions: node.revisions,
      startedAt: node.startedAt ?? null,
      updatedAt: node.updatedAt ?? null,
      usage: node.usage ? { inputTokens: node.usage.inputTokens ?? null, outputTokens: node.usage.outputTokens ?? null, cacheReadInputTokens: node.usage.cacheReadInputTokens ?? null } : null,
      costUsd: typeof node.costUsd === "number" ? node.costUsd : null,
      verdict: node.gate?.verdict ?? null,
      pendingHandoff: pendingHandoff(node),
      note: statusNote(node),
      scopeFindings: node.scopeFindings?.unexpectedPaths ?? null,
      errorCode: node.error?.code ?? null,
      blockedBy: node.blockedBy ?? [],
    })),
  };
}

/**
 * The node the operator should look at right now: the first node that is
 * running, else the first in an attention state, else null. Generic over the
 * node shape so both the raw `NodeSnapshot[]` (`derivePointer`) and the
 * `status.json` payload's nodes (`nowLine`) share this one rule.
 *
 * @template {{status: NodeStatus}} T
 * @param {T[]} nodes
 * @returns {T|null}
 */
function activeStatusNode(nodes) {
  return nodes.find((node) => node.status === "running")
    ?? nodes.find((node) => !["pending", "running", "done", "no-op"].includes(node.status))
    ?? null;
}

/**
 * The bounded pointer record written to `.runs/status.json`: enough for a
 * quick ambient read (statusline, a stale watcher) without opening the
 * per-run status.json. Bounded the same way heartbeat.json used to be, so a
 * cheap bounded read stays valid for any reader still built that way.
 * `generatedAt` is unix seconds, not ISO: the statusline's no-jq fallback has
 * no clock and only jq's builtin `now` can compute an age from a live clock,
 * and neither path needs a `date` process to read an integer. `elapsedSec`
 * is likewise precomputed here (as of `generatedAt`, not live) so the
 * statusline never has to subtract two timestamps to show it — it just
 * prints the integer, whichever reader it is.
 *
 * @param {JsonObject} payload the per-run status.json payload
 * @param {NodeSnapshot[]} nodes
 * @param {number} generatedAt unix seconds
 * @returns {JsonObject}
 */
function derivePointer(payload, nodes, generatedAt) {
  const active = activeStatusNode(nodes);
  const done = nodes.filter((node) => node.status === "done" || node.status === "no-op").length;
  const attentionNodes = nodes.filter((node) => !["pending", "running", "done", "no-op"].includes(node.status));
  const attentionNode = attentionNodes[0] ?? null;
  const state = attentionNode ? "attention" : nodes.every((node) => ["done", "no-op"].includes(node.status)) ? "done" : "active";
  const activeStartedAt = active?.startedAt ? Math.floor(Date.parse(active.startedAt) / 1000) : null;
  const usage = /** @type {{costUsd: number|null}} */ (payload.usage);
  const pointer = {
    schemaVersion: 1,
    runId: payload.run,
    campaignId: payload.campaignId,
    state,
    checkpoints: { done, total: nodes.length },
    activeNode: active ? truncateChars(active.id, POINTER_STRING_CHARS) : null,
    runtime: active?.runtime ? truncateChars(`${active.runtime.harness}/${active.runtime.model}`, POINTER_STRING_CHARS) : null,
    elapsedSec: activeStartedAt !== null && Number.isFinite(activeStartedAt) ? Math.max(0, generatedAt - activeStartedAt) : null,
    costUsd: typeof usage.costUsd === "number" ? Math.round(usage.costUsd * 100) / 100 : null,
    needsYou: attentionNodes.length,
    attention: attentionNode ? truncateChars(statusNote(attentionNode) ?? attentionNode.status, POINTER_ATTENTION_CHARS) : null,
    generatedAt,
  };
  return pointer;
}

/**
 * Write status.json for one run (bounded advisory ceiling) and the
 * `.runs/status.json` pointer to it (bounded to 1 KiB, mirroring the old
 * heartbeat.json contract), atomically. Called each controller tick and at
 * run terminal (TECH-SPEC lean, rule 5).
 *
 * @param {string} runDir
 * @param {string} runsDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 */
export function writeStatusArtifacts(runDir, runsDir, contract, states) {
  const nodes = /** @type {NodeSnapshot[]} */ (contract.nodes.map((node) => states.get(node.id)).filter((node) => node !== undefined));
  const runMetadata = /** @type {{identityWarnings?: string[]}} */ (readJson(join(runDir, "run.json")) ?? {});
  const usage = readRunUsage(runDir);
  const payload = buildStatusPayload(runDir, contract, nodes, runMetadata.identityWarnings ?? [], usage);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > STATUS_JSON_MAX_BYTES) {
    process.stderr.write(`[warn] status.json for ${basename(runDir)} exceeds the ${STATUS_JSON_MAX_BYTES}-byte advisory ceiling\n`);
  }
  writeJsonAtomic(join(runDir, STATUS_POINTER_FILE), payload);
  const pointer = derivePointer(payload, nodes, Math.floor(Date.now() / 1000));
  const pointerSerialized = JSON.stringify(pointer);
  if (Buffer.byteLength(pointerSerialized, "utf8") <= STATUS_POINTER_MAX_BYTES) {
    writeJsonAtomic(join(runsDir, STATUS_POINTER_FILE), pointer);
  } else {
    process.stderr.write(`[warn] .runs/status.json pointer for ${basename(runDir)} exceeds ${STATUS_POINTER_MAX_BYTES} bytes; left unwritten\n`);
  }
}

/**
 * The controller line: `active pid N since T` for a live lock, or
 * `stale pid N (dead|restarted) last tick T` once its holder is proven dead
 * or the pid was recycled — `T` is then the newest node update, since the
 * dead controller's own lock carries no useful clock. No lock at all (a run
 * that never started, or one that shut down cleanly) reports `none`.
 *
 * @param {string} runDir
 * @param {NodeSnapshot[]} nodes
 * @returns {{line: string, status: {state: "active"|"stale"|"none", pid: number|null, since: string|null, lastTick: string|null}}}
 */
function controllerStatus(runDir, nodes) {
  const lock = readLock(runDir);
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) {
    return { line: "none", status: { state: "none", pid: null, since: null, lastTick: null } };
  }
  const record = /** @type {import("../run/lock.mjs").LockRecord} */ (lock);
  if (!lockStale(record)) {
    return {
      line: `active pid ${record.pid} since ${record.startedAt}`,
      status: { state: "active", pid: record.pid, since: record.startedAt, lastTick: null },
    };
  }
  const lastTick = nodes.reduce((latest, node) => (node.updatedAt && node.updatedAt > latest ? node.updatedAt : latest), "") || null;
  const reason = pidAlive(record.pid) ? "restarted" : "dead";
  return {
    line: `stale pid ${record.pid} (${reason}) last tick ${lastTick ?? "-"}`,
    status: { state: "stale", pid: record.pid, since: record.startedAt, lastTick },
  };
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function renderReport(runDir) {
  const { contract, nodes } = loadRun(runDir);
  const usage = readRunUsage(runDir);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 7, 7, 28, 10, 10, 10, 20, 64];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  /** @type {import("../contract/index.mjs").Usage & {costUsd: number|null}} */
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: null };
  const costs = nodes.map(costProjection);
  const aggregateCost = aggregateCostProjection(costs);
  const lines = [`# run ${basename(runDir)}`, "", `${nodes.length} nodes · ${summary} · in ${compactTokens(usage.inputTokens)} · out ${compactTokens(usage.outputTokens)} · cache ${compactTokens(usage.cacheReadInputTokens)} · cost ${compactCost(usage.costUsd)}`, "", "```", row(["", "NODE", "STATE", "TRY", "REV", "RUNTIME", "IN", "OUT", "CACHE", "COST", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const [index, node] of nodes.entries()) {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (Object.keys(totals).filter((key) => key !== "costUsd"))) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
    const cost = costs[index];
    const runtime = node.runtime ? `${node.runtime.harness}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const note = scopeFindingsNote(node.scopeFindings)
      ? nodeNote(node)
      : `phase ${planNode?.phase ?? "-"} · ${continuationMode(node)} · ${nodeNote(node)}`;
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, node.attempt ?? 0, node.revisions ?? 0, runtime, compactTokens(usage.inputTokens), compactTokens(usage.outputTokens), compactTokens(usage.cacheReadInputTokens), formatCost(cost), note]));
  }
  totals.costUsd = aggregateCost.costUsd;
  lines.push("```", "", `totals · in ${compactTokens(totals.inputTokens)} · out ${compactTokens(totals.outputTokens)} · cache ${compactTokens(totals.cacheReadInputTokens)} · cost ${formatCost(aggregateCost)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * JSON report for `report --json`: totals and per-node usage, no rendering.
 *
 * @param {string} runDir
 * @returns {string}
 */
export function renderReportJson(runDir) {
  const { contract, nodes } = loadRun(runDir);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  /** @type {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null, costStatus: string}} */
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: null, costStatus: "ambiguous" };
  const costs = nodes.map(costProjection);
  const listed = nodes.map((node, index) => {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (["inputTokens", "outputTokens", "cacheReadInputTokens"])) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
    const cost = costs[index];
    return {
      id: node.id,
      status: node.status,
      phase: contract.nodes.find((candidate) => candidate.id === node.id)?.phase ?? null,
      executionPhase: node.phase,
      runtime: node.runtime ? `${node.runtime.harness}/${node.runtime.model}` : null,
      attempt: node.attempt,
      revisions: node.revisions,
      usage,
      costUsd: cost.costUsd,
      costStatus: cost.status,
      continuation: continuationMode(node),
      note: nodeNote(node),
    };
  });
  const aggregateCost = aggregateCostProjection(costs);
  totals.costUsd = aggregateCost.costUsd;
  totals.costStatus = aggregateCost.status;
  const payload = {
    schemaVersion: 1,
    run: basename(runDir),
    contractId: contract.id,
    campaignId: contract.campaignId,
    summary: [...counts].map(([status, count]) => `${count} ${status}`).join(" · "),
    totals,
    nodes: listed,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function renderFindings(runDir) {
  const { nodes } = loadRun(runDir);
  const sections = [];
  for (const node of nodes) {
    const gate = node.gate;
    if (node.status !== "exhausted" || !gate?.findings?.length) continue;
    const listed = gate.findings.map((finding) => `- [${finding.severity}] ${finding.description}\n  Evidence: ${finding.evidence}`).join("\n");
    sections.push(`## ${node.id}\n\nGate verdict: ${gate.verdict} (${gate.maxSeverity}). ${gate.summary}\n\n${listed}`);
  }
  return sections.length ? `${sections.join("\n\n")}\n` : "no exhausted gate findings to act on\n";
}

/**
 * @param {string} runDir
 * @returns {{contract: ValidatedContract, nodes: NodeSnapshot[], identityWarnings: string[]}}
 */
function loadRun(runDir) {
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(/** @type {import("../contract/index.mjs").JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8"))), contractPath, { persisted: true });
  const metadata = validateRunMetadata(readJson(join(runDir, "run.json")));
  return { contract, nodes: readNodes(runDir, contract), identityWarnings: metadata.identityWarnings ?? [] };
}

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @returns {NodeSnapshot[]}
 */
function readNodes(runDir, contract) {
  const nodeDir = join(runDir, "nodes");
  const names = readdirSync(nodeDir).filter((name) => name.endsWith(".json"));
  const expected = new Map(contract.nodes.map((node) => [`${node.id}.json`, node]));
  for (const name of names) if (!expected.has(name)) throw new TypeError(`unexpected persisted node snapshot ${name}`);
  return contract.nodes.map((node) => {
    const name = `${node.id}.json`;
    if (!names.includes(name)) throw new TypeError(`missing persisted node snapshot ${name}`);
    return validateNodeSnapshot(/** @type {import("../contract/index.mjs").JsonObject} */ (JSON.parse(readFileSync(join(nodeDir, name), "utf8"))), node);
  });
}

/**
 * Tokens by kind and cost across the run's usage.jsonl records. Missing or
 * unparsable lines are skipped; a missing file yields zero totals.
 *
 * @param {string} runDir
 * @returns {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null}}
 */
function readRunUsage(runDir) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: /** @type {number|null} */ (null) };
  const path = join(runDir, "usage.jsonl");
  if (!existsSync(path)) return totals;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const value = /** @type {Record<string, unknown>} */ (record);
    if (typeof value.inputTokens === "number") totals.inputTokens += value.inputTokens;
    if (typeof value.outputTokens === "number") totals.outputTokens += value.outputTokens;
    if (typeof value.cacheReadInputTokens === "number") totals.cacheReadInputTokens += value.cacheReadInputTokens;
    if (typeof value.costUsd === "number") totals.costUsd = (totals.costUsd ?? 0) + value.costUsd;
  }
  return totals;
}

/** @param {NodeSnapshot} node @returns {string} */
function continuationMode(node) {
  return node.invocations?.at(-1)?.continuationMode ?? "fresh";
}

/**
 * A worker routing override waiting to be consumed by the node's next attempt —
 * set by `handoff` (manual) or provider failover.
 *
 * @param {NodeSnapshot} node
 * @returns {{runtime: string, reason: string}|null}
 */
function pendingHandoff(node) {
  const override = node.routing?.currentOverride;
  if (override?.role !== "worker") return null;
  return { runtime: override.runtime, reason: override.reason };
}

/** Segments of a node note are joined by this separator. */
const NOTE_SEPARATOR = " · ";

/**
 * The longest note a status surface shows. It is the width the status tables
 * render, so a bounded note never has to be cut again on its way into a cell
 * and the JSON carries exactly the string the tables do.
 */
export const MAX_NOTE_LENGTH = 64;

/**
 * Joins the note segments into one note bounded to `maxLength`, cutting the
 * trailing segment first: the leading scope and review markers are what the
 * operator and the campaign match on, so a long gate summary or error is the
 * part that yields, and every surface shows the same bounded string.
 *
 * @param {(string|null|undefined)[]} segments
 * @param {number} [maxLength]
 * @returns {string|null}
 */
function boundedNote(segments, maxLength = MAX_NOTE_LENGTH) {
  const parts = segments.filter(Boolean);
  if (!parts.length) return null;
  const note = parts.join(NOTE_SEPARATOR);
  if (note.length <= maxLength) return note;
  const head = parts.slice(0, -1).join(NOTE_SEPARATOR);
  const tail = /** @type {string} */ (parts.at(-1));
  const room = maxLength - (head ? head.length + NOTE_SEPARATOR.length : 0);
  const cut = `${tail.slice(0, Math.max(0, room - 1))}…`;
  if (head && cut.length > 1) return `${head}${NOTE_SEPARATOR}${cut}`;
  return `${note.slice(0, maxLength - 1)}…`;
}

/**
 * The note a status surface shows for a node: gate summary or error, led by
 * any advisory scope finding and by the review outcome, so a gated done node
 * cannot hide an advisory finding or an invalid verdict behind its gate
 * summary (TECH-SPEC lean, rules 1 and 2). The order is the stable format
 * every surface shares: `scope: N unexpected paths · <review note> · <gate
 * summary or error>`, bounded so the tables and the JSON cannot disagree.
 *
 * @param {NodeSnapshot} node
 * @returns {string|null}
 */
export function statusNote(node) {
  const scope = scopeFindingsNote(node.scopeFindings);
  const review = reviewNote(node);
  const detail = node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase;
  const note = boundedNote([review, detail]);
  if (!scope) return note;
  return boundedNote([scope, note]);
}

/**
 * A scope finding is advisory, so the node keeps its own note; the finding
 * still has to stay visible on a gated node, where the gate summary would
 * otherwise be the whole note (TECH-SPEC lean, rule 1).
 *
 * @param {NodeSnapshot} node
 * @returns {string}
 */
function nodeNote(node) {
  const note = statusNote(node);
  if (note) return note;
  if (typeof node.result === "string" && node.result.trim()) return node.result.trim();
  return node.phase ?? "-";
}

/** @typedef {{costUsd: number|null, status: "known"|"estimated"|"ambiguous"}} CostProjection */

/**
 * Project cost only from durable snapshot evidence. Invocation costs are
 * provider-reported; a standalone node total has no provider attribution and
 * remains an estimate. Missing or mismatched evidence is ambiguous.
 *
 * @param {NodeSnapshot} node
 * @returns {CostProjection}
 */
function costProjection(node) {
  const nodeCost = finiteCost(node.costUsd);
  const invocations = Array.isArray(node.invocations) ? node.invocations : [];
  const invocationCosts = invocations.map((invocation) => finiteCost(invocation.costUsd));

  if (invocations.length > 0) {
    if (!invocationCosts.every((cost) => cost !== null)) return { costUsd: null, status: "ambiguous" };
    const reportedCost = invocationCosts.reduce((total, cost) => total + /** @type {number} */ (cost), 0);
    if (nodeCost !== null && !sameCost(nodeCost, reportedCost)) return { costUsd: null, status: "ambiguous" };
    return { costUsd: nodeCost ?? reportedCost, status: "known" };
  }

  if (nodeCost !== null) return { costUsd: nodeCost, status: "estimated" };
  return { costUsd: null, status: "ambiguous" };
}

/** @param {CostProjection[]} costs @returns {CostProjection} */
function aggregateCostProjection(costs) {
  if (costs.length === 0 || costs.some((cost) => cost.status === "ambiguous")) {
    return { costUsd: null, status: "ambiguous" };
  }
  const costUsd = costs.every((cost) => typeof cost.costUsd === "number")
    ? costs.reduce((total, cost) => total + /** @type {number} */ (cost.costUsd), 0)
    : null;
  return {
    costUsd,
    status: costs.some((cost) => cost.status === "estimated") ? "estimated" : "known",
  };
}

/** @param {unknown} value @returns {number|null} */
function finiteCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {number} left @param {number} right @returns {boolean} */
function sameCost(left, right) {
  return Math.abs(left - right) <= 1e-9;
}

/** @param {CostProjection} projection @returns {string} */
function formatCost(projection) {
  return `${compactCost(projection.costUsd)} (${projection.status})`;
}

/**
 * @param {string} value
 * @param {number} width
 * @returns {string}
 */
function fit(value, width) {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (clean.length <= width) return clean + " ".repeat(width - clean.length);
  return `${clean.slice(0, Math.max(0, width - 2))}..`.padEnd(width, " ");
}
