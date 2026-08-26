import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { validateContract, validateNodeSnapshot, validateRunMetadata } from "./contract.mjs";
import { leaseHealthy, readJson, readLease } from "./store.mjs";

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
  const { contract, nodes } = loadRun(runDir);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 28, 7, 24];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  const lines = [`# run ${basename(runDir)}`, "", contract.goal, "", `${nodes.length} nodes · ${summary}`, "", "```", row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const note = node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase ?? "-";
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, runtime, node.attempt ?? 0, note]));
  }
  lines.push("```", "", "## Needs you", "");
  const attention = nodes.filter((node) => !["pending", "running", "done"].includes(node.status));
  const orphans = !leaseHealthy(readLease(runDir)) ? nodes.filter((node) => node.status === "running").map((node) => node.id) : [];
  if (!attention.length && !orphans.length) lines.push("Nothing needs you right now.");
  if (orphans.length) lines.push(`- [>] the run process is gone while ${orphans.join(", ")} still claims to be running. Those nodes are orphans, not live work. Resume the run directory to adopt whatever their workers finished.`);
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
  const { contract, nodes } = loadRun(runDir);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const payload = {
    schemaVersion: 1,
    run: basename(runDir),
    contractId: contract.id,
    campaignId: contract.campaignId,
    goal: contract.goal,
    leaseHealthy: leaseHealthy(readLease(runDir)),
    summary: [...counts].map(([status, count]) => `${count} ${status}`).join(" · "),
    nodes: nodes.map((node) => ({
      id: node.id,
      status: node.status,
      phase: node.phase,
      runtime: node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : null,
      attempt: node.attempt,
      revisions: node.revisions,
      note: node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function renderReport(runDir) {
  const { nodes } = loadRun(runDir);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 7, 7, 28, 10, 10, 10, 36];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  /** @type {import("./contract.mjs").Usage} */
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  const lines = [`# run ${basename(runDir)}`, "", `${nodes.length} nodes · ${summary}`, "", "```", row(["", "NODE", "STATE", "TRY", "REV", "RUNTIME", "IN", "OUT", "CACHE", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const node of nodes) {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (Object.keys(totals))) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, node.attempt ?? 0, node.revisions ?? 0, runtime, compactTokens(usage.inputTokens), compactTokens(usage.outputTokens), compactTokens(usage.cacheReadInputTokens), nodeNote(node)]));
  }
  lines.push("```", "", `totals · in ${compactTokens(totals.inputTokens)} · out ${compactTokens(totals.outputTokens)} · cache ${compactTokens(totals.cacheReadInputTokens)}`);
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
  /** @type {import("./contract.mjs").Usage} */
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  const listed = nodes.map((node) => {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (Object.keys(totals))) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
    return {
      id: node.id,
      status: node.status,
      phase: node.phase,
      runtime: node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : null,
      attempt: node.attempt,
      revisions: node.revisions,
      usage,
      note: nodeNote(node),
    };
  });
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
 * @returns {{contract: ValidatedContract, nodes: NodeSnapshot[]}}
 */
function loadRun(runDir) {
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(/** @type {import("./contract.mjs").JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8"))), contractPath, { persisted: true });
  validateRunMetadata(readJson(join(runDir, "run.json")));
  return { contract, nodes: readNodes(runDir, contract) };
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
 * @param {NodeSnapshot} node
 * @returns {string}
 */
function nodeNote(node) {
  if (node.gate?.summary) return node.gate.summary;
  if (node.error?.message) return node.error.message;
  if (node.blockedBy?.length) return `blocked by ${node.blockedBy.join(", ")}`;
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
