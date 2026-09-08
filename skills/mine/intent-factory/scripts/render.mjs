import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { validateContract, validateNodeSnapshot, validateRunMetadata } from "./contract.mjs";
import { readJson } from "./store.mjs";
import { lockStale, pidAlive, readLock } from "./lock.mjs";
import { scopeFindingsNote } from "./scope-findings.mjs";
import { reviewNote } from "./review-modes.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./contract.mjs").NodeStatus} NodeStatus */

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
 * @param {string} runDir
 * @returns {string}
 */
export function renderStatus(runDir) {
  const { contract, nodes, identityWarnings } = loadRun(runDir);
  const usage = readRunUsage(runDir);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  // The note carries every advisory marker a node earned (scope finding,
  // review verdict, gate summary), so the cell holds the composed note whole.
  const widths = [3, 24, 9, 28, 7, 64];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  const controller = controllerStatus(runDir, nodes);
  const lines = [`# run ${basename(runDir)}`, "", contract.goal, "", `${nodes.length} nodes · ${summary} · in ${compactTokens(usage.inputTokens)} · out ${compactTokens(usage.outputTokens)} · cache ${compactTokens(usage.cacheReadInputTokens)} · cost ${compactCost(usage.costUsd)}`, "", `controller: ${controller.line}`, "", "```", row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const handoff = pendingHandoff(node);
    const detail = statusNote(node) ?? "-";
    // A scope finding leads the note and drops the phase boilerplate: the
    // operator has to see it, and the fixed cell cannot hold both.
    const baseNote = scopeFindingsNote(node.scopeFindings)
      ? detail
      : `phase ${planNode?.phase ?? "-"} · ${continuationMode(node)} · ${detail}`;
    const note = handoff ? `handoff→${handoff.runtime} · ${baseNote}` : baseNote;
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, runtime, node.attempt ?? 0, note]));
  }
  lines.push("```", "", "## Needs you", "");
  const attention = nodes.filter((node) => !["pending", "running", "done"].includes(node.status));
  const orphans = controller.status.state !== "active" ? nodes.filter((node) => node.status === "running").map((node) => node.id) : [];
  if (!attention.length && !orphans.length && !identityWarnings.length) lines.push("Nothing needs you right now.");
  if (orphans.length) lines.push(`- [>] the run process is gone while ${orphans.join(", ")} still claims to be running. Those nodes are orphans, not live work. Resume the run directory to adopt whatever their workers finished.`);
  for (const warning of identityWarnings) lines.push(`- [~] ${warning}`);
  for (const node of attention) lines.push(`- ${MARK[node.status] ?? "[?]"} ${node.id}: ${node.gate?.summary ?? node.error?.message ?? node.status}`);
  return `${lines.join("\n")}\n`;
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
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const payload = {
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
      runtime: node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : null,
      continuation: continuationMode(node),
      attempt: node.attempt,
      revisions: node.revisions,
      pendingHandoff: pendingHandoff(node),
      note: statusNote(node),
      scopeFindings: node.scopeFindings?.unexpectedPaths ?? null,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
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
  const record = /** @type {import("./lock.mjs").LockRecord} */ (lock);
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
  /** @type {import("./contract.mjs").Usage & {costUsd: number|null}} */
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: null };
  const costs = nodes.map(costProjection);
  const aggregateCost = aggregateCostProjection(costs);
  const lines = [`# run ${basename(runDir)}`, "", `${nodes.length} nodes · ${summary} · in ${compactTokens(usage.inputTokens)} · out ${compactTokens(usage.outputTokens)} · cache ${compactTokens(usage.cacheReadInputTokens)} · cost ${compactCost(usage.costUsd)}`, "", "```", row(["", "NODE", "STATE", "TRY", "REV", "RUNTIME", "IN", "OUT", "CACHE", "COST", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const [index, node] of nodes.entries()) {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (Object.keys(totals).filter((key) => key !== "costUsd"))) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
    const cost = costs[index];
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
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
      runtime: node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : null,
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
  const contract = validateContract(/** @type {import("./contract.mjs").JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8"))), contractPath, { persisted: true });
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
    return validateNodeSnapshot(/** @type {import("./contract.mjs").JsonObject} */ (JSON.parse(readFileSync(join(nodeDir, name), "utf8"))), node);
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function compactTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** @param {number|null|undefined} value @returns {string} */
function compactCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "-";
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
