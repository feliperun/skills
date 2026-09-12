/**
 * Metrics projector (TECH-SPEC lean section 6). One pure function over a
 * campaign's own recorded artefacts — every linked run's persisted node
 * snapshots, `events.jsonl`, `usage.jsonl` and `notify.jsonl` — returning
 * exactly the indicators section 6 measures at close. Nothing here estimates
 * a token count or reads a heartbeat: every value comes from a record the
 * platform already wrote for another reason (a node snapshot, a transition,
 * a priced invocation, a delivery receipt).
 *
 * `projectMetrics` takes already-parsed records and never a filesystem path,
 * which keeps every indicator testable without fixtures on disk. Each
 * indicator carries its value, the direction that counts as better, and the
 * number of records it was computed from. An indicator with no supporting
 * record is `null`, never `0`: a missing measurement and a measured zero are
 * different facts.
 *
 * A *logical node* is a contract node id within one run (TECH-SPEC section
 * 6): the same id in two different runs is two logical nodes, because a
 * fresh run re-authors the work rather than resuming it. A *checkpoint* is
 * coarser — the node id alone, deduplicated across every linked run — and is
 * what `linkedRunsPerClosedCheckpoint` divides the run count by: normally the
 * same node closes in the one run that carries it, and the ratio drifts above
 * 1 only when a whole run had to be re-authored after a failure that
 * `resume` could not repair.
 *
 * The second half of this module is the `runner.mjs metrics` command: reading
 * a campaign's linked runs and parsing the command's flags live here, while
 * `metrics-report.mjs` decides how the projection is printed.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { campaignDir, readCampaign } from "./index.mjs";
import { jsonObjectOf, round4, timestampMs } from "./metrics-evals.mjs";
import { MAX_ATTEMPTS as NOTIFY_MAX_ATTEMPTS } from "../notify/index.mjs";
import { renderMetricsJson, renderMetricsReport } from "../report/metrics-report.mjs";

/** Node statuses that are not terminal: everything else settles a logical node. */
const OPEN_STATUSES = new Set(["pending", "running"]);
/** Terminal statuses that count as the node's work having landed. */
const DONE_STATUSES = new Set(["done", "no-op"]);
/** Gate review that blocks the node on a failing verdict (TECH-SPEC lean, rule 2). */
const BLOCKING_REVIEW = "blocking";
/** A receipt this settled: delivered, no transport bound, or the retry budget spent. */
const SETTLED_NOTIFY_STATUSES = new Set(["delivered", "no_transport"]);
/** Target latency for a terminal/attention event to carry a settled receipt (TECH-SPEC section 6). */
const NOTIFY_TARGET_SEC = 60;
const SECONDS_PER_HOUR = 3600;
/** A usage record with no provider-reported cost is `unknown` provenance (`appendUsageRecord`). */
const UNKNOWN_COST_PROVENANCE = "unknown";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"down"|"up"|"informative"} Direction */
/** @typedef {{value: number|null, direction: Direction, count: number}} Indicator */
/** @typedef {Indicator & {unknownCount: number}} CostIndicator */
/** @typedef {{value: Record<string, number>|null, direction: Direction, count: number}} GroupedIndicator */
/** @typedef {{atMs: number, index: number, event: JsonObject}} RunEvent */
/** @typedef {{runId: string, id: string, status: string, attempt?: number|null, revisions?: number|null, review?: string|null}} RunNode */

/**
 * @typedef {{
 *   events?: unknown[],
 *   usageRecords?: unknown[],
 *   notifications?: unknown[],
 *   nodes?: RunNode[],
 *   now?: number,
 * }} MetricsInput
 */

/**
 * @typedef {{
 *   nodesDoneRate: Indicator,
 *   linkedRunsPerClosedCheckpoint: Indicator,
 *   runsPerCampaign: Indicator,
 *   wallClockSec: Indicator,
 *   usageTokensByKind: GroupedIndicator,
 *   usageTokensByKindByRuntime: GroupedIndicator,
 *   usageCostUsd: CostIndicator,
 *   blockingJudgeFirstPassRate: GroupedIndicator,
 *   notifyReceiptRate: Indicator,
 *   silentStallRate: Indicator,
 * }} CampaignMetrics
 */

/**
 * Project every section-6 indicator from one campaign's recorded artefacts.
 * Pure and deterministic: identical records yield identical output, rates
 * round to 4 decimals, and durations are seconds.
 *
 * @param {MetricsInput} [input]
 * @returns {CampaignMetrics}
 */
export function projectMetrics({ events = [], usageRecords = [], notifications = [], nodes = [], now = Date.now() } = {}) {
  void now;
  const eventList = events.map(jsonObjectOf).filter((event) => event !== null);
  const nodesDone = nodesDoneRateOf(nodes);
  const runs = runsPerCampaignOf(nodes, eventList);
  const closedCheckpoints = closedCheckpointsOf(nodes);
  const span = eventSpanOf(eventList);
  const usage = usageTotalsOf(usageRecords);
  const gates = blockingJudgeFirstPassRateOf(nodes, eventList);
  const notify = notifyReceiptRateOf(notifications);
  const stalls = silentStallRateOf(nodes, eventList);
  return {
    nodesDoneRate: measured("up", nodesDone.terminal, nodesDone.terminal === 0 ? null : nodesDone.done / nodesDone.terminal),
    linkedRunsPerClosedCheckpoint: measured("down", closedCheckpoints, closedCheckpoints === 0 ? null : runs / closedCheckpoints),
    runsPerCampaign: measured("down", runs, runs === 0 ? null : runs),
    wallClockSec: measured("down", span.count, span.seconds),
    usageTokensByKind: grouped("informative", usage.tokenCount, usage.tokensByKind),
    usageTokensByKindByRuntime: grouped("informative", usage.tokenCount, usage.tokensByKindByRuntime),
    usageCostUsd: { ...measured("down", usage.costCount, usage.costCount === 0 ? null : usage.costUsd), unknownCount: usage.unknownCount },
    blockingJudgeFirstPassRate: grouped("up", gates.count, gates.value),
    notifyReceiptRate: measured("up", notify.count, notify.count === 0 ? null : notify.satisfied / notify.count),
    silentStallRate: measured("down", stalls.activeIntervals, stalls.activeHours === 0 ? null : stalls.stalled / stalls.activeHours),
  };
}

/**
 * Wrap one scalar indicator. A count of zero is a missing measurement and
 * yields a null value whatever was computed; a non-finite value is missing too.
 *
 * @param {Direction} direction
 * @param {number} count
 * @param {number|null} value
 * @returns {Indicator}
 */
function measured(direction, count, value) {
  const missing = count === 0 || value === null || !Number.isFinite(value);
  return { value: missing ? null : round4(/** @type {number} */ (value)), direction, count };
}

/**
 * Wrap one indicator reported per group (lane or runtime). The empty group map
 * is a missing measurement, not a measured zero.
 *
 * @param {Direction} direction
 * @param {number} count
 * @param {Record<string, number>} value
 * @returns {GroupedIndicator}
 */
function grouped(direction, count, value) {
  return { value: count === 0 || Object.keys(value).length === 0 ? null : value, direction, count };
}

/**
 * Logical nodes done at any attempt, over logical nodes that reached a
 * terminal state. A node still `pending` or `running` at close is censored:
 * it counts toward neither side (TECH-SPEC section 6 denominators).
 *
 * @param {RunNode[]} nodes
 * @returns {{done: number, terminal: number}}
 */
function nodesDoneRateOf(nodes) {
  let done = 0;
  let terminal = 0;
  for (const node of nodes) {
    if (OPEN_STATUSES.has(node.status)) continue;
    terminal += 1;
    if (DONE_STATUSES.has(node.status)) done += 1;
  }
  return { done, terminal };
}

/**
 * Distinct checkpoints (node ids, deduplicated across every linked run) that
 * closed at least once.
 *
 * @param {RunNode[]} nodes
 * @returns {number}
 */
function closedCheckpointsOf(nodes) {
  const closed = new Set();
  for (const node of nodes) if (DONE_STATUSES.has(node.status)) closed.add(node.id);
  return closed.size;
}

/**
 * @param {RunNode[]} nodes
 * @param {JsonObject[]} events
 * @returns {number}
 */
function runsPerCampaignOf(nodes, events) {
  const runIds = new Set();
  for (const node of nodes) runIds.add(node.runId);
  for (const event of events) if (typeof event.runId === "string") runIds.add(event.runId);
  return runIds.size;
}

/**
 * Wall-clock span of the recording, in seconds, with the number of timestamped
 * events it was measured from. A single event spans nothing measurable.
 *
 * @param {JsonObject[]} events
 * @returns {{seconds: number|null, count: number}}
 */
function eventSpanOf(events) {
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
  return count < 2 ? { seconds: null, count: 0 } : { seconds: (latest - earliest) / 1000, count };
}

/**
 * Tokens by kind and total cost across every linked run's usage records, both
 * as a campaign total and broken out per runtime (TECH-SPEC section 6). A
 * record contributes exactly what it recorded: uncached input, cache-read
 * input and output tokens are independent totals. Cost sums only records
 * whose provenance is not `unknown` (`appendUsageRecord` sets `unknown`
 * exactly when the provider reported no cost); every other record's
 * invocation is counted separately rather than folded into a measured zero.
 *
 * @param {unknown[]} usageRecords
 * @returns {{tokensByKind: Record<string, number>, tokensByKindByRuntime: Record<string, number>, tokenCount: number, costUsd: number|null, costCount: number, unknownCount: number}}
 */
function usageTotalsOf(usageRecords) {
  const tokensByKind = { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
  /** @type {Record<string, number>} */
  const tokensByKindByRuntime = {};
  let tokenCount = 0;
  let costUsd = 0;
  let costCount = 0;
  let unknownCount = 0;
  const kinds = /** @type {("inputTokens"|"cacheReadInputTokens"|"outputTokens")[]} */ (["inputTokens", "cacheReadInputTokens", "outputTokens"]);
  for (const raw of usageRecords) {
    const record = jsonObjectOf(raw);
    if (record === null) continue;
    let measuredAny = false;
    const runtime = typeof record.runtimeId === "string" && record.runtimeId !== "" ? record.runtimeId : null;
    for (const kind of kinds) {
      if (typeof record[kind] !== "number" || !Number.isFinite(record[kind])) continue;
      const value = /** @type {number} */ (record[kind]);
      tokensByKind[kind] += value;
      if (runtime !== null) tokensByKindByRuntime[`${runtime}.${kind}`] = (tokensByKindByRuntime[`${runtime}.${kind}`] ?? 0) + value;
      measuredAny = true;
    }
    if (measuredAny) tokenCount += 1;
    if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== UNKNOWN_COST_PROVENANCE) {
      costUsd += record.costUsd;
      costCount += 1;
    } else {
      unknownCount += 1;
    }
  }
  return { tokensByKind, tokensByKindByRuntime, tokenCount, costUsd: costCount === 0 ? null : costUsd, costCount, unknownCount };
}

/**
 * Fraction of blocking-gated checkpoints whose first recorded verdict passed,
 * per lane (the judge runtime that produced it). A node under `advisory` or
 * `none` review never blocks the campaign on a fail, so it is not what this
 * indicator measures (TECH-SPEC section 6, "Blocking judge first-pass rate").
 *
 * @param {RunNode[]} nodes
 * @param {JsonObject[]} events
 * @returns {{value: Record<string, number>, count: number}}
 */
function blockingJudgeFirstPassRateOf(nodes, events) {
  /** @type {Map<string, string|null>} */
  const reviewByKey = new Map();
  for (const node of nodes) reviewByKey.set(`${node.runId}:${node.id}`, node.review ?? null);
  const byKey = groupEventsByRunNode(events);
  /** @type {Map<string, {gated: number, passed: number}>} */
  const lanes = new Map();
  let gated = 0;
  for (const [key, entries] of byKey) {
    if (reviewByKey.get(key) !== BLOCKING_REVIEW) continue;
    const first = entries.find(({ event }) => typeof event.verdict === "string");
    if (first === undefined) continue;
    gated += 1;
    const lane = typeof first.event.runtime === "string" && first.event.runtime !== "" ? first.event.runtime : "unknown";
    const tally = lanes.get(lane) ?? { gated: 0, passed: 0 };
    tally.gated += 1;
    if (first.event.verdict === "pass") tally.passed += 1;
    lanes.set(lane, tally);
  }
  /** @type {Record<string, number>} */
  const value = {};
  for (const lane of [...lanes.keys()].sort()) {
    const tally = /** @type {{gated: number, passed: number}} */ (lanes.get(lane));
    value[lane] = round4(tally.passed / tally.gated);
  }
  return { value, count: gated };
}

/**
 * Fraction of notified events (grouped by `dedupeKey`, one per logical
 * terminal/attention transition) that reached a settled receipt — delivered,
 * no transport bound, or failed after the bounded retry budget — within
 * `NOTIFY_TARGET_SEC` of the first attempt (TECH-SPEC section 6).
 *
 * @param {unknown[]} notifications
 * @returns {{satisfied: number, count: number}}
 */
function notifyReceiptRateOf(notifications) {
  /** @type {Map<string, JsonObject[]>} */
  const byKey = new Map();
  for (const raw of notifications) {
    const record = jsonObjectOf(raw);
    if (record === null || typeof record.dedupeKey !== "string" || record.dedupeKey === "") continue;
    const list = byKey.get(record.dedupeKey) ?? [];
    list.push(record);
    byKey.set(record.dedupeKey, list);
  }
  let satisfied = 0;
  let count = 0;
  for (const receipts of byKey.values()) {
    const first = receipts.find((receipt) => receipt.attempt === 1);
    if (first === undefined) continue;
    count += 1;
    const firstAtMs = timestampMs(first.at);
    const settled = receipts.find((receipt) => isSettledReceipt(receipt));
    if (settled === undefined) continue;
    const settledAtMs = timestampMs(settled.at);
    if (!Number.isFinite(firstAtMs) || !Number.isFinite(settledAtMs)) continue;
    const deltaSec = (settledAtMs - firstAtMs) / 1000;
    if (deltaSec >= 0 && deltaSec <= NOTIFY_TARGET_SEC) satisfied += 1;
  }
  return { satisfied, count };
}

/**
 * @param {JsonObject} receipt
 * @returns {boolean}
 */
function isSettledReceipt(receipt) {
  if (typeof receipt.status !== "string") return false;
  if (SETTLED_NOTIFY_STATUSES.has(receipt.status)) return true;
  return receipt.status === "failed" && receipt.attempt === NOTIFY_MAX_ATTEMPTS;
}

/**
 * Silent stalls (logical nodes the controller killed for provider silence)
 * per active run-hour. Active time is the sum of every closed `running`
 * interval recorded in `events.jsonl`; a `stalled` status is the controller's
 * own record that a running interval went silent past its timeout, so this
 * needs no heartbeat of its own (TECH-SPEC section 6, hard target zero).
 *
 * @param {RunNode[]} nodes
 * @param {JsonObject[]} events
 * @returns {{stalled: number, activeHours: number, activeIntervals: number}}
 */
function silentStallRateOf(nodes, events) {
  const stalled = nodes.filter((node) => node.status === "stalled").length;
  const byKey = groupEventsByRunNode(events);
  let activeSeconds = 0;
  let activeIntervals = 0;
  for (const entries of byKey.values()) {
    for (let index = 0; index < entries.length; index += 1) {
      const event = entries[index].event;
      if (event.to !== "running") continue;
      const next = entries[index + 1];
      if (next === undefined) continue;
      const startMs = entries[index].atMs;
      const endMs = next.atMs;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
      activeSeconds += (endMs - startMs) / 1000;
      activeIntervals += 1;
    }
  }
  return { stalled, activeHours: activeSeconds / SECONDS_PER_HOUR, activeIntervals };
}

/**
 * Group transition events by run and node, ordered by timestamp with the
 * recorded order breaking ties, so a running interval can be paired with the
 * event that ends it.
 *
 * @param {JsonObject[]} events
 * @returns {Map<string, RunEvent[]>}
 */
function groupEventsByRunNode(events) {
  /** @type {Map<string, RunEvent[]>} */
  const byKey = new Map();
  events.forEach((event, index) => {
    if (typeof event.node !== "string") return;
    const key = `${typeof event.runId === "string" ? event.runId : ""}:${event.node}`;
    const list = byKey.get(key) ?? [];
    list.push({ atMs: timestampMs(event.at), index, event });
    byKey.set(key, list);
  });
  for (const list of byKey.values()) list.sort((left, right) => orderOf(left) - orderOf(right) || left.index - right.index);
  return byKey;
}

/** @param {RunEvent} entry @returns {number} */
function orderOf(entry) {
  return Number.isFinite(entry.atMs) ? entry.atMs : 0;
}

/** Flags of `runner.mjs metrics`, declared here so the router only names them. */
/** @type {import("node:util").ParseArgsOptionsConfig} */
export const METRICS_OPTIONS = { cwd: { type: "string" }, json: { type: "boolean" } };

const RUNS_DIR_NAME = ".runs";
const RUN_EVENTS_FILE = "events.jsonl";
const USAGE_LOG_FILE = "usage.jsonl";
const NOTIFY_LOG_FILE = "notify.jsonl";
const NODES_DIR_NAME = "nodes";

/**
 * @typedef {{
 *   campaignId: string,
 *   runIds: string[],
 *   events: unknown[],
 *   usageRecords: unknown[],
 *   notifications: unknown[],
 *   nodes: RunNode[],
 * }} MetricsSources
 */

/**
 * Read the recorded sources of one campaign: every linked run's persisted
 * node snapshots, transition events (tagged with the run id, since a node id
 * is only unique within one run), `usage.jsonl` and `notify.jsonl`. A missing
 * artefact reads as empty, which the projector reports as a missing
 * measurement and never as a measured zero.
 *
 * @param {string} campaignPath
 * @param {{runsDir?: string}} [options]
 * @returns {MetricsSources}
 */
export function readMetricsSources(campaignPath, { runsDir = join(campaignPath, "..", "..") } = {}) {
  const campaign = readCampaign(campaignPath);
  /** @type {unknown[]} */
  const events = [];
  /** @type {unknown[]} */
  const usageRecords = [];
  /** @type {unknown[]} */
  const notifications = [];
  /** @type {RunNode[]} */
  const nodes = [];
  for (const runId of campaign.linkedRunIds) {
    for (const record of readJsonlRecords(join(runsDir, runId, RUN_EVENTS_FILE))) events.push({ ...jsonObjectOf(record), runId });
    for (const record of readJsonlRecords(join(runsDir, runId, USAGE_LOG_FILE))) usageRecords.push(record);
    for (const record of readJsonlRecords(join(runsDir, runId, NOTIFY_LOG_FILE))) notifications.push(record);
    for (const node of readRunNodes(join(runsDir, runId, NODES_DIR_NAME))) nodes.push({ ...node, runId });
  }
  return { campaignId: campaign.id, runIds: [...campaign.linkedRunIds], events, usageRecords, notifications, nodes };
}

/**
 * Persisted node snapshots of one run, reduced to the fields metrics reads.
 * Reading is tolerant of a run directory with no `nodes/` yet (freshly
 * dispatched) and of a snapshot that fails to parse (never blocks a report on
 * a torn write).
 *
 * @param {string} nodesDir
 * @returns {Omit<RunNode, "runId">[]}
 */
function readRunNodes(nodesDir) {
  if (!existsSync(nodesDir)) return [];
  /** @type {Omit<RunNode, "runId">[]} */
  const nodes = [];
  for (const name of readdirSync(nodesDir)) {
    if (!name.endsWith(".json")) continue;
    let record;
    try {
      record = jsonObjectOf(JSON.parse(readFileSync(join(nodesDir, name), "utf8")));
    } catch {
      continue;
    }
    if (record === null || typeof record.id !== "string" || typeof record.status !== "string") continue;
    nodes.push({
      id: record.id,
      status: record.status,
      attempt: typeof record.attempt === "number" ? record.attempt : null,
      revisions: typeof record.revisions === "number" ? record.revisions : null,
      review: typeof record.review === "string" ? record.review : null,
    });
  }
  return nodes;
}

/**
 * `runner.mjs metrics <campaign-id> [--cwd <dir>] [--json]`: project the
 * campaign's recorded artefacts and return what the command prints. Reading
 * only, and never a write: a report of a closed campaign must not touch it.
 *
 * @param {string} campaignId
 * @param {{cwd?: unknown, json?: unknown}} [values]
 * @returns {string}
 */
export function renderCampaignMetrics(campaignId, values = {}) {
  const runsDir = join(resolve(typeof values.cwd === "string" && values.cwd !== "" ? values.cwd : process.cwd()), RUNS_DIR_NAME);
  const sources = readMetricsSources(campaignDir(runsDir, campaignId), { runsDir });
  const metrics = projectMetrics(sources);
  return values.json === true ? renderMetricsJson(sources, metrics) : renderMetricsReport(sources, metrics);
}

/**
 * Records of one JSONL artefact. An unterminated final line was never a
 * committed record — the newline is written with the record — so it is skipped
 * rather than parsed.
 *
 * @param {string} path
 * @returns {unknown[]}
 */
function readJsonlRecords(path) {
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
