import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { jsonObjectOf, round4, timestampMs } from "../skills/mine/intent-factory/scripts/metrics-evals.mjs";

/**
 * Indicator projection from one run's own recorded artefacts —
 * `events.jsonl` and `usage.jsonl` only, never a node snapshot — and the
 * comparator between two already-projected reports. Same discipline as
 * `skills/mine/intent-factory/scripts/metrics.mjs`: every indicator carries
 * its `value`, the `direction` that counts as better, and the `count` of
 * records it was computed from, and an indicator with no supporting record
 * is `null`, never `0`.
 */

/** Transition statuses that have not settled yet; a node still on one of these is excluded from every indicator below. */
const EVAL_OPEN_STATUSES = new Set(["pending", "running"]);
/** Terminal transition statuses that count as the checkpoint having closed. */
const EVAL_DONE_STATUSES = new Set(["done", "no-op"]);
/** Terminal transition status a worker result of `blocked_context` is recorded as (`node.mjs`'s `terminalErrorCode`). */
const EVAL_BLOCKED_STATUS = "blocked";
/** Error code a transition event carries when a worker's malformed reply forced a failover hop (`node.mjs`, `applyInvalidWorkerResult`). */
const PROTOCOL_FAILURE_ERROR = "protocol_failure";
/** A usage record with no provider-reported cost is `unknown` provenance (`appendUsageRecord`). */
const EVAL_UNKNOWN_COST_PROVENANCE = "unknown";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"down"|"up"|"informative"} EvalDirection */
/** @typedef {{value: number|null, direction: EvalDirection, count: number}} EvalIndicator */
/** @typedef {{value: Record<string, number>|null, direction: EvalDirection, count: number}} EvalGroupedIndicator */

/**
 * @typedef {{
 *   costPerClosedCheckpoint: EvalIndicator,
 *   firstPassGateRate: EvalGroupedIndicator,
 *   judgeInvocationRate: EvalIndicator,
 *   revisionsPerDone: EvalIndicator,
 *   blockedContextRate: EvalIndicator,
 *   wallClockPerClosedCheckpoint: EvalIndicator,
 *   providerFailoverRate: EvalIndicator,
 *   protocolFailureRate: EvalIndicator,
 * }} EvalReport
 */

/**
 * Project every indicator from one run's `events.jsonl` and `usage.jsonl`,
 * already parsed. Pure and deterministic. `firstPassGateRate` groups by
 * `taskKind`, which here is the node's own id: neither file this reads
 * carries a coarser task-category field than the node identifier itself.
 *
 * @param {{events?: unknown[], usageRecords?: unknown[]}} [sources]
 * @returns {EvalReport}
 */
export function projectEvalIndicators({ events = [], usageRecords = [] } = {}) {
  const eventList = events.map(jsonObjectOf).filter((event) => event !== null);
  const usageList = usageRecords.map(jsonObjectOf).filter((record) => record !== null);
  const byNode = groupEvalEventsByNode(eventList);
  /** @type {Map<string, JsonObject>} */
  const terminalByNode = new Map();
  for (const [node, entries] of byNode) {
    const terminal = terminalEvalEventOf(entries);
    if (terminal !== null) terminalByNode.set(node, terminal);
  }
  const closedCheckpoints = new Set([...terminalByNode].filter(([, event]) => EVAL_DONE_STATUSES.has(/** @type {string} */ (event.to))).map(([node]) => node));

  const cost = evalUsageCostOf(usageList);
  const gates = evalFirstPassGateRateOf(byNode);
  const judgedNodes = evalJudgeInvocationNodeIdsOf(usageList);
  const judgedClosed = [...closedCheckpoints].filter((node) => judgedNodes.has(node)).length;
  const revisionsSum = [...closedCheckpoints].reduce((sum, node) => sum + evalRevisionsOf(/** @type {JsonObject} */ (terminalByNode.get(node))), 0);
  const blocked = [...terminalByNode.values()].filter((event) => event.to === EVAL_BLOCKED_STATUS).length;
  const spanSeconds = evalEventSpanSecondsOf(eventList);
  const workerRuntimesByNode = evalWorkerRuntimesByNodeOf(byNode);
  const failoverNodes = [...workerRuntimesByNode.values()].filter((runtimes) => runtimes.size > 1).length;
  const protocolFailures = eventList.filter((event) => event.error === PROTOCOL_FAILURE_ERROR).length;

  return {
    costPerClosedCheckpoint: evalMeasured("down", closedCheckpoints.size, closedCheckpoints.size === 0 || cost.count === 0 ? null : cost.total / closedCheckpoints.size),
    firstPassGateRate: evalGrouped("up", gates.count, gates.value),
    judgeInvocationRate: evalMeasured("up", closedCheckpoints.size, closedCheckpoints.size === 0 ? null : judgedClosed / closedCheckpoints.size),
    revisionsPerDone: evalMeasured("down", closedCheckpoints.size, closedCheckpoints.size === 0 ? null : revisionsSum / closedCheckpoints.size),
    blockedContextRate: evalMeasured("down", terminalByNode.size, terminalByNode.size === 0 ? null : blocked / terminalByNode.size),
    wallClockPerClosedCheckpoint: evalMeasured("down", closedCheckpoints.size, spanSeconds === null || closedCheckpoints.size === 0 ? null : spanSeconds / closedCheckpoints.size),
    providerFailoverRate: evalMeasured("down", workerRuntimesByNode.size, workerRuntimesByNode.size === 0 ? null : failoverNodes / workerRuntimesByNode.size),
    protocolFailureRate: evalMeasured("down", usageList.length, usageList.length === 0 ? null : protocolFailures / usageList.length),
  };
}

/**
 * Wrap one scalar indicator. A count of zero is a missing measurement and
 * yields a null value whatever was computed; a non-finite value is missing too.
 *
 * @param {EvalDirection} direction
 * @param {number} count
 * @param {number|null} value
 * @returns {EvalIndicator}
 */
function evalMeasured(direction, count, value) {
  const missing = count === 0 || value === null || !Number.isFinite(value);
  return { value: missing ? null : round4(/** @type {number} */ (value)), direction, count };
}

/**
 * Wrap one indicator reported per group (here, per taskKind). The empty
 * group map is a missing measurement, not a measured zero.
 *
 * @param {EvalDirection} direction
 * @param {number} count
 * @param {Record<string, number>} value
 * @returns {EvalGroupedIndicator}
 */
function evalGrouped(direction, count, value) {
  return { value: count === 0 || Object.keys(value).length === 0 ? null : value, direction, count };
}

/**
 * Group transition events by node, ordered by timestamp with the recorded
 * order breaking ties.
 *
 * @param {JsonObject[]} events
 * @returns {Map<string, {atMs: number, index: number, event: JsonObject}[]>}
 */
function groupEvalEventsByNode(events) {
  /** @type {Map<string, {atMs: number, index: number, event: JsonObject}[]>} */
  const byNode = new Map();
  events.forEach((event, index) => {
    if (typeof event.node !== "string") return;
    const list = byNode.get(event.node) ?? [];
    list.push({ atMs: timestampMs(event.at), index, event });
    byNode.set(event.node, list);
  });
  for (const list of byNode.values()) list.sort((left, right) => evalOrderOf(left) - evalOrderOf(right) || left.index - right.index);
  return byNode;
}

/** @param {{atMs: number}} entry @returns {number} */
function evalOrderOf(entry) {
  return Number.isFinite(entry.atMs) ? entry.atMs : 0;
}

/**
 * The last recorded event for one node whose `to` has settled — a node still
 * `pending` or `running` has not reached a terminal state yet and is excluded.
 *
 * @param {{event: JsonObject}[]} entries
 * @returns {JsonObject|null}
 */
function terminalEvalEventOf(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const to = entries[index].event.to;
    if (typeof to === "string" && !EVAL_OPEN_STATUSES.has(to)) return entries[index].event;
  }
  return null;
}

/**
 * @param {JsonObject} terminalEvent
 * @returns {number}
 */
function evalRevisionsOf(terminalEvent) {
  return typeof terminalEvent.revisions === "number" && Number.isFinite(terminalEvent.revisions) ? terminalEvent.revisions : 0;
}

/**
 * Total cost across every usage record whose provenance is not `unknown`
 * (`appendUsageRecord` sets `unknown` exactly when the provider reported no
 * cost); every other record's invocation happened but contributes no cost.
 *
 * @param {JsonObject[]} usageRecords
 * @returns {{total: number, count: number}}
 */
function evalUsageCostOf(usageRecords) {
  let total = 0;
  let count = 0;
  for (const record of usageRecords) {
    if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== EVAL_UNKNOWN_COST_PROVENANCE) {
      total += record.costUsd;
      count += 1;
    }
  }
  return { total, count };
}

/**
 * Node ids with at least one `role: "judge"` usage record.
 *
 * @param {JsonObject[]} usageRecords
 * @returns {Set<string>}
 */
function evalJudgeInvocationNodeIdsOf(usageRecords) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const record of usageRecords) if (record.role === "judge" && typeof record.nodeId === "string") ids.add(record.nodeId);
  return ids;
}

/**
 * Fraction of gated taskKinds (here, node ids) whose first recorded verdict
 * passed. `taskKind` is the node id because `events.jsonl`/`usage.jsonl`
 * carry no coarser task-category field to group by.
 *
 * @param {Map<string, {event: JsonObject}[]>} byNode
 * @returns {{value: Record<string, number>, count: number}}
 */
function evalFirstPassGateRateOf(byNode) {
  /** @type {Record<string, number>} */
  const value = {};
  let count = 0;
  for (const [node, entries] of byNode) {
    const first = entries.find(({ event }) => typeof event.verdict === "string");
    if (first === undefined) continue;
    count += 1;
    value[node] = first.event.verdict === "pass" ? 1 : 0;
  }
  return { value, count };
}

/**
 * Wall-clock span of the recording, in seconds. A single timestamped event
 * spans nothing measurable.
 *
 * @param {JsonObject[]} events
 * @returns {number|null}
 */
function evalEventSpanSecondsOf(events) {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const event of events) {
    const atMs = timestampMs(event.at);
    if (!Number.isFinite(atMs)) continue;
    count += 1;
    if (atMs < earliest) earliest = atMs;
    if (atMs > latest) latest = atMs;
  }
  return count < 2 ? null : (latest - earliest) / 1000;
}

/**
 * Distinct runtime ids a node's `phase: "worker"` transitions ran on. More
 * than one means the node failed over to a different provider mid-flight.
 *
 * @param {Map<string, {event: JsonObject}[]>} byNode
 * @returns {Map<string, Set<string>>}
 */
function evalWorkerRuntimesByNodeOf(byNode) {
  /** @type {Map<string, Set<string>>} */
  const workerRuntimesByNode = new Map();
  for (const [node, entries] of byNode) {
    /** @type {Set<string>} */
    const runtimes = new Set();
    for (const { event } of entries) if (event.phase === "worker" && typeof event.runtime === "string") runtimes.add(event.runtime);
    if (runtimes.size > 0) workerRuntimesByNode.set(node, runtimes);
  }
  return workerRuntimesByNode;
}

/**
 * Read one run's own `events.jsonl` and `usage.jsonl`, unparsed into the
 * shape `projectEvalIndicators` takes. A missing artefact reads as empty,
 * which the projector reports as a missing measurement and never as a
 * measured zero.
 *
 * @param {string} runDir
 * @returns {{events: unknown[], usageRecords: unknown[]}}
 */
export function readEvalRunSources(runDir) {
  return {
    events: readEvalJsonlRecords(join(runDir, "events.jsonl")),
    usageRecords: readEvalJsonlRecords(join(runDir, "usage.jsonl")),
  };
}

/**
 * Merge several runs' already-read sources into one. A campaign built from
 * more than one sequential orchestrator run (one directory per attempt, each
 * with its own `events.jsonl`/`usage.jsonl`) has no single run directory
 * that holds every record, so `--project` reads each directory separately
 * with `readEvalRunSources` and merges here before `projectEvalIndicators`
 * regroups everything by node and timestamp; which source contributed a
 * given record does not matter past this point.
 *
 * @param {{events: unknown[], usageRecords: unknown[]}[]} sourcesList
 * @returns {{events: unknown[], usageRecords: unknown[]}}
 */
export function mergeEvalRunSources(sourcesList) {
  return {
    events: sourcesList.flatMap((sources) => sources.events),
    usageRecords: sourcesList.flatMap((sources) => sources.usageRecords),
  };
}

/**
 * Records of one JSONL artefact. An unterminated final line was never a
 * committed record, so it is skipped rather than parsed.
 *
 * @param {string} path
 * @returns {unknown[]}
 */
function readEvalJsonlRecords(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  /** @type {unknown[]} */
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) continue;
    records.push(JSON.parse(lines[index]));
  }
  return records;
}

/**
 * One indicator's value, reduced to a plain number when it can stand on one
 * side of a subtraction. A grouped indicator's per-taskKind map, or a
 * missing (`null`) measurement, is not — comparing either against a number
 * never yields a numeric delta.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function evalComparableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @typedef {{
 *   before: {value: unknown, count: number},
 *   after: {value: unknown, count: number},
 *   direction: EvalDirection,
 *   delta: number|null,
 *   comparable: boolean,
 * }} EvalIndicatorComparison
 */

/**
 * Compare one indicator between two already-projected reports. A `null`
 * indicator (no supporting record) compared against a measured number, or a
 * grouped indicator's map compared against anything, never produces a
 * numeric delta — it reports `comparable: false` instead of a delta that
 * would silently read as zero.
 *
 * @param {JsonObject|undefined} before
 * @param {JsonObject|undefined} after
 * @returns {EvalIndicatorComparison}
 */
function compareEvalIndicator(before, after) {
  const beforeNumber = evalComparableNumber(before?.value);
  const afterNumber = evalComparableNumber(after?.value);
  const comparable = beforeNumber !== null && afterNumber !== null;
  return {
    before: { value: before?.value ?? null, count: typeof before?.count === "number" ? before.count : 0 },
    after: { value: after?.value ?? null, count: typeof after?.count === "number" ? after.count : 0 },
    direction: /** @type {EvalDirection} */ (after?.direction ?? before?.direction ?? "informative"),
    delta: comparable ? round4(/** @type {number} */ (afterNumber) - /** @type {number} */ (beforeNumber)) : null,
    comparable,
  };
}

/**
 * Compare every indicator of two already-projected reports (the `--compare`
 * CLI command's core). The two reports need not share the same indicator
 * set — an indicator present on only one side still gets an entry, missing
 * on the other side.
 *
 * @param {JsonObject} before
 * @param {JsonObject} after
 * @returns {Record<string, EvalIndicatorComparison>}
 */
export function compareEvalReports(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  /** @type {Record<string, EvalIndicatorComparison>} */
  const comparison = {};
  for (const name of [...names].sort()) {
    comparison[name] = compareEvalIndicator(jsonObjectOf(before[name]) ?? undefined, jsonObjectOf(after[name]) ?? undefined);
  }
  return comparison;
}

/**
 * Render `--compare`'s comparison as the human-readable report.
 *
 * @param {Record<string, EvalIndicatorComparison>} comparison
 * @returns {string}
 */
export function renderEvalComparisonReport(comparison) {
  const lines = [];
  for (const [name, entry] of Object.entries(comparison)) {
    lines.push(name);
    lines.push(`  before: ${JSON.stringify(entry.before.value)} (n=${entry.before.count})`);
    lines.push(`  after:  ${JSON.stringify(entry.after.value)} (n=${entry.after.count})`);
    lines.push(`  delta:  ${entry.comparable ? entry.delta : "sem base de comparacao"}`);
    lines.push(`  melhora conta como: ${entry.direction}`);
  }
  return `${lines.join("\n")}\n`;
}
