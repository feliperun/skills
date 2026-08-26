import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  const campaign = readCampaignUsage(runDir, contract);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 28, 7, 24];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  const lines = [`# run ${basename(runDir)}`, "", contract.goal, "", `${nodes.length} nodes · ${summary} · campaign ${compactTokens(campaign.budgetInputTokens)} weighted input · workers ${campaign.remainingWorkerAllowance === null ? "unlimited" : compactTokens(campaign.remainingWorkerAllowance)} · judge reserve ${campaign.judgeReserveInputTokens === null ? "-" : compactTokens(campaign.judgeReserveInputTokens)}`, "", "```", row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const handoff = pendingHandoff(node);
    const baseNote = `phase ${planNode?.phase ?? "-"} · ${continuationMode(node)} · ${node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase ?? "-"}`;
    const note = handoff ? `handoff→${handoff.runtime} · ${baseNote}` : baseNote;
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
  const campaign = readCampaignUsage(runDir, contract);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const payload = {
    schemaVersion: 1,
    run: basename(runDir),
    contractId: contract.id,
    campaignId: contract.campaignId,
    goal: contract.goal,
    usagePolicy: contract.usagePolicy,
    campaignUsage: campaign.budgetInputTokens,
    campaignRawInput: campaign.conservativeInputTokens,
    remainingWorkerAllowance: campaign.remainingWorkerAllowance,
    judgeReserveInputTokens: campaign.judgeReserveInputTokens,
    leaseHealthy: leaseHealthy(readLease(runDir)),
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
  const { contract, nodes } = loadRun(runDir);
  const campaign = readCampaignUsage(runDir, contract);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 7, 7, 28, 10, 10, 10, 20, 36];
  /** @type {(cells: unknown[]) => string} */
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  /** @type {import("./contract.mjs").Usage & {costUsd: number|null}} */
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: null };
  const costs = nodes.map(costProjection);
  const aggregateCost = aggregateCostProjection(costs);
  const lines = [`# run ${basename(runDir)}`, "", `${nodes.length} nodes · ${summary} · campaign ${compactTokens(campaign.budgetInputTokens)} weighted input · workers ${campaign.remainingWorkerAllowance === null ? "unlimited" : compactTokens(campaign.remainingWorkerAllowance)} · judge reserve ${campaign.judgeReserveInputTokens === null ? "-" : compactTokens(campaign.judgeReserveInputTokens)}`, "", "```", row(["", "NODE", "STATE", "TRY", "REV", "RUNTIME", "IN", "OUT", "CACHE", "COST", "NOTE"]), row(widths.map((width) => "-".repeat(width)))];
  for (const [index, node] of nodes.entries()) {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (Object.keys(totals).filter((key) => key !== "costUsd"))) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
    const cost = costs[index];
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, node.attempt ?? 0, node.revisions ?? 0, runtime, compactTokens(usage.inputTokens), compactTokens(usage.outputTokens), compactTokens(usage.cacheReadInputTokens), formatCost(cost), `phase ${planNode?.phase ?? "-"} · ${continuationMode(node)} · ${nodeNote(node)}`]));
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
  const campaign = readCampaignUsage(runDir, contract);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: null, costStatus: "ambiguous" };
  const costs = nodes.map(costProjection);
  const listed = nodes.map((node, index) => {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens"]) totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
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
    usagePolicy: contract.usagePolicy,
    campaignUsage: campaign.budgetInputTokens,
    campaignRawInput: campaign.conservativeInputTokens,
    remainingWorkerAllowance: campaign.remainingWorkerAllowance,
    judgeReserveInputTokens: campaign.judgeReserveInputTokens,
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
  const contract = validateContract(/** @type {import("./contract.mjs").JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8"))), contractPath);
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

/** @param {string} runDir @param {ValidatedContract} contract */
function readCampaignUsage(runDir, contract) {
  const policy = contract.usagePolicy;
  const empty = {
    conservativeInputTokens: 0,
    budgetInputTokens: 0,
    remainingWorkerAllowance: policy === false ? null : policy.maxInputTokens - policy.judgeReserveInputTokens,
    judgeReserveInputTokens: policy === false ? null : policy.judgeReserveInputTokens,
  };
  if (policy === false) return empty;
  const path = join(runDir, "..", "campaigns", contract.campaignId, "usage-ledger.json");
  if (!existsSync(path)) return empty;
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  const epoch = ledger.epochs?.[policy.epoch];
  if (!epoch) return empty;
  let total = 0;
  let budget = 0;
  for (const invocation of Object.values(epoch.invocations ?? {})) {
    const usage = invocation.usage ?? {};
    const conservative = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
    total += conservative;
    budget = Math.round((budget + (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) * policy.cacheReadWeight) * 1_000_000) / 1_000_000;
  }
  return {
    conservativeInputTokens: total,
    budgetInputTokens: budget,
    remainingWorkerAllowance: Math.max(0, policy.maxInputTokens - policy.judgeReserveInputTokens - budget),
    judgeReserveInputTokens: policy.judgeReserveInputTokens,
  };
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
