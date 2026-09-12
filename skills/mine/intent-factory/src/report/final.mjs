/**
 * The run's closing artifacts: the final status table, the report, and
 * `findings.json`. Written once when the controller settles, from the persisted
 * node snapshots alone.
 *
 * This is presentation. It lived inside the engine only because that is where
 * the loop happened to end; nothing in the control path reads what it writes.
 */
import { compactCost, compactTokens, errorCode } from "../util.mjs";
import { basename, join } from "node:path";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../run/store.mjs";
import { scopeFindingsNote } from "../contract/scope-findings.mjs";
import { MARK, fit, statusNote, writeStatusArtifacts } from "./render.mjs";
import { unlinkSync } from "node:fs";

/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

/**
 * @param {string} runDir
 * @param {string} runsDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle|null} [lock]
 */
export function render(runDir, runsDir, contract, states, lock = null) {
  lock?.assert();
  writeTextAtomic(join(runDir, "STATUS.md"), renderFinalStatus(runDir, contract, states));
  writeStatusArtifacts(runDir, runsDir, contract, states);
}
/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
function renderFinalStatus(runDir, contract, states) {
  const nodes = /** @type {NodeSnapshot[]} */ (contract.nodes.map((node) => states.get(node.id)).filter((node) => node !== undefined));
  const runMetadata = /** @type {{identityWarnings?: string[]}} */ (readJson(join(runDir, "run.json")) ?? {});
  const identityWarnings = runMetadata.identityWarnings ?? [];
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  // The note carries every advisory marker a node earned (scope finding,
  // review verdict, gate summary), so the cell holds the composed note whole.
  const widths = [3, 24, 9, 28, 7, 64];
  /** @param {unknown[]} cells */
  const row = (cells) => cells.map((cell, index) => fit(String(cell ?? ""), widths[index])).join(" ");
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    contract.goal,
    "",
    `${nodes.length} nodes · ${summary}`,
    "",
    "```",
    row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]),
    row(widths.map((width) => "-".repeat(width))),
  ];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.harness}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const detail = statusNote(node) ?? "-";
    // A scope finding leads the note and drops the phase boilerplate: the
    // operator has to see it, and the fixed cell cannot hold both.
    const note = scopeFindingsNote(node.scopeFindings)
      ? detail
      : `${detail} · phase ${planNode?.phase ?? "-"} · ${node.invocations?.at(-1)?.continuationMode ?? "fresh"}`;
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, runtime, node.attempt ?? 0, note]));
  }
  lines.push("```", "", "## Needs you", "");
  const attention = nodes.filter((node) => !["pending", "running", "done"].includes(node.status));
  if (!attention.length && !identityWarnings.length) lines.push("Nothing needs you right now.");
  for (const warning of identityWarnings) lines.push(`- [~] ${warning}`);
  for (const node of attention) lines.push(`- ${MARK[node.status] ?? "[?]"} ${node.id}: ${node.gate?.summary ?? node.error?.message ?? node.status}`);
  return `${lines.join("\n")}\n`;
}
/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
export function renderFinalReport(runDir, contract, states) {
  const nodes = /** @type {NodeSnapshot[]} */ (contract.nodes.map((node) => states.get(node.id)).filter((node) => node !== undefined));
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 7, 7, 28, 10, 10, 10, 12, 64];
  /** @param {unknown[]} cells */
  const row = (cells) => cells.map((cell, index) => fit(String(cell ?? ""), widths[index])).join(" ");
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let totalCostUsd = null;
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    `${nodes.length} nodes · ${summary}`,
    "",
    "```",
    row(["", "NODE", "STATE", "TRY", "REV", "RUNTIME", "IN", "OUT", "CACHE", "COST", "NOTE"]),
    row(widths.map((width) => "-".repeat(width))),
  ];
  for (const node of nodes) {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    if (typeof node.costUsd === "number" && Number.isFinite(node.costUsd)) totalCostUsd = (totalCostUsd ?? 0) + node.costUsd;
    const runtime = node.runtime ? `${node.runtime.harness}/${node.runtime.model}` : "-";
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    const detail = node.gate?.summary ?? node.error?.message ?? (node.blockedBy?.length ? node.blockedBy.join(", ") : null) ?? (typeof node.result === "string" && node.result.trim() ? node.result.trim() : node.phase ?? "-");
    // The advisory scope finding leads the note, as it does in STATUS.md.
    const note = scopeFindingsNote(node.scopeFindings)
      ? `${scopeFindingsNote(node.scopeFindings)} · ${detail}`
      : `${detail} · phase ${planNode?.phase ?? "-"} · ${node.invocations?.at(-1)?.continuationMode ?? "fresh"}`;
    lines.push(row([
      MARK[node.status] ?? "[?]",
      node.id,
      node.status,
      node.attempt ?? 0,
      node.revisions ?? 0,
      runtime,
      compactTokens(usage.inputTokens),
      compactTokens(usage.outputTokens),
      compactTokens(usage.cacheReadInputTokens),
      compactCost(node.costUsd),
      note,
    ]));
  }
  lines.push("```", "", `totals · in ${compactTokens(totals.inputTokens)} · out ${compactTokens(totals.outputTokens)} · cache ${compactTokens(totals.cacheReadInputTokens)} · cost ${compactCost(totalCostUsd)}`);
  return `${lines.join("\n")}\n`;
}
/**
 * Consolidated terminal-state handoff: one bounded JSON snapshot in the run
 * dir so a triage session never loads full run state. Nodes stay the source
 * of truth; this file is a snapshot of the moment the run finished. Written
 * when any node ended non-done; removed when a later resume drives the run
 * fully done, so a stale snapshot cannot outlive the state it described.
 *
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {Map<string, NodeSnapshot>} states
 */
export function writeFindingsArtifact(runDir, contract, states) {
  const failing = [...states.values()].filter((state) => state.status !== "done");
  const path = join(runDir, "findings.json");
  if (!failing.length) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return;
  }
  const counts = new Map();
  for (const state of states.values()) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  writeJsonAtomic(path, {
    schemaVersion: 1,
    run: contract.id,
    goal: contract.goal,
    summary: [...counts].map(([status, count]) => `${count} ${status}`).join(" · "),
    nodes: failing.map((state) => ({
      id: state.id,
      status: state.status,
      attempt: state.attempt,
      revisions: state.revisions,
      error: state.error,
      gate: state.gate,
      ...(state.blockedBy?.length ? { blockedBy: state.blockedBy } : {}),
      ...missingContextOf(state),
      ...unexpectedPathsOf(state),
    })),
  });
}
/**
 * @param {NodeSnapshot} state
 * @returns {{missingContext?: string[]}}
 */
function missingContextOf(state) {
  const result = /** @type {{missingContext?: unknown}|null} */ (state.result);
  if (result && Array.isArray(result.missingContext) && result.missingContext.length) {
    return { missingContext: result.missingContext.map(String) };
  }
  return {};
}
/**
 * An `unexpected_write` failure is only actionable with the offending paths,
 * and the bounded error message truncates them. Carry a bounded list into the
 * artifact so triage never has to open the node file.
 *
 * @param {NodeSnapshot} state
 * @returns {{unexpectedPaths?: string[]}}
 */
function unexpectedPathsOf(state) {
  const scope = /** @type {{unexpectedPaths?: unknown}|null|undefined} */ (state.scope);
  if (scope && Array.isArray(scope.unexpectedPaths) && scope.unexpectedPaths.length) {
    return { unexpectedPaths: scope.unexpectedPaths.slice(0, 16).map(String) };
  }
  return {};
}
