/**
 * Metrics projector (TECH-SPEC section 8.4). One pure function over the four
 * recorded sources of a campaign — the run `events.jsonl`, `usage-ledger.json`,
 * the notification outbox and the campaign journal — returning every release-1
 * indicator in one object, so effectiveness (`firstPassGateRate`,
 * `ambientCoverage`) and efficiency (`weightedPerClosedCheckpoint`,
 * `takesPerClosedCheckpoint`) are always reported together and never one
 * without the other.
 *
 * `projectMetrics` takes already-parsed records and never a filesystem path,
 * which keeps every indicator testable without fixtures on disk. Each
 * indicator carries its value, the direction that counts as better, and the
 * number of records the value was computed from. An indicator with no
 * supporting record is `null`, never `0`: a missing measurement and a measured
 * zero are different facts.
 *
 * A campaign is measured in two units and they are not interchangeable: a
 * *take* is one operator dispatch at a checkpoint, which is one linked run the
 * controller did not generate as a repair (`deriveTakeRuns`), while a *worker
 * dispatch* is one transition into `running` inside such a run. The report
 * prints the take and repair counts in its header and every indicator's own
 * record count beside its value, so the two are never read as one number.
 *
 * The second half of this module is the `runner.mjs metrics` command: reading
 * a campaign's artefacts and parsing the command's flags live here so the
 * router stays one line per subcommand, while `metrics-report.mjs` decides how
 * the projection is printed.
 *
 * The budget and liveness subset is not reimplemented here — it comes from
 * `deriveGovernanceMetrics` (`heartbeat.mjs`), the single source of those six
 * indicators; this module only wraps its values with their record counts. The
 * preamble, session and liveness measurements come from `metrics-evals.mjs`,
 * which owns what each of those indicators is measured from.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { campaignDir, readCampaign, readJournal } from "./campaign.mjs";
import { CAMPAIGN_STATE_FILE } from "./campaign-autonomy.mjs";
import { deriveGovernanceMetrics } from "./heartbeat.mjs";
import {
  countAttentionOutbox,
  coverageOf,
  countNonterminalFacts,
  jsonObjectOf,
  livenessFactsOf,
  livenessGapsOf,
  percentile95,
  preambleTokensByRuntime,
  PREFLIGHT_FILE,
  round4,
  sessionUsageOf,
  timestampMs,
} from "./metrics-evals.mjs";
import { renderMetricsJson, renderMetricsReport } from "./metrics-report.mjs";
import { readNotificationOutbox } from "./outbox.mjs";

/** Heartbeat age, in seconds, below which a reader is considered covered (Addendum 01 section 8). */
export const HEARTBEAT_FRESH_SEC = 60;
/** Bytes-to-tokens estimate used when the caller supplies none, in the shape budget profiles use. */
export const DEFAULT_TOKENIZER_ESTIMATE = { bytes: 4, tokens: 1 };

const CLOSED_STATUSES = new Set(["done", "no-op"]);
const SETTLED_STATUSES = new Set(["done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);
const BLOCKED_CONTEXT_CODE = "context_missing";
const UNKNOWN_LANE = "unknown";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"down"|"up"|"informative"} Direction */
/** @typedef {{value: number|null, direction: Direction, count: number}} Indicator */
/** @typedef {{value: Record<string, number>|null, direction: Direction, count: number}} GroupedIndicator */
/** @typedef {{atMs: number, index: number, event: JsonObject}} NodeEvent */

/**
 * @typedef {{
 *   events?: unknown[],
 *   takeRunIds?: string[]|null,
 *   usageLedger?: unknown,
 *   outbox?: unknown[],
 *   journal?: unknown[],
 *   preflight?: unknown[],
 *   now?: number,
 *   staleSec?: number,
 *   freshSec?: number,
 *   tokenizerEstimate?: {bytes: number, tokens: number},
 * }} MetricsInput
 */

/**
 * @typedef {{
 *   weightedPerClosedCheckpoint: Indicator,
 *   wallClockPerClosedCheckpoint: Indicator,
 *   takesPerClosedCheckpoint: Indicator,
 *   firstPassGateRate: GroupedIndicator,
 *   judgeInvocationRate: Indicator,
 *   blockedContextRate: Indicator,
 *   providerFailoverRate: Indicator,
 *   lostTakeRate: Indicator,
 *   sessionContextGrowth: Indicator,
 *   sessionWakeCount: Indicator,
 *   heartbeatStalenessP95: Indicator,
 *   ambientCoverage: Indicator,
 *   budgetDecisionAge: Indicator,
 *   budgetHeadroomAtDispatch: Indicator,
 *   budgetExtensionRate: Indicator,
 *   continuationRate: Indicator,
 *   budgetAttentionLatencyP95: Indicator,
 *   silentStallRate: Indicator,
 *   workerPreambleTokens: GroupedIndicator,
 *   notifyLatencyP95: Indicator,
 * }} CampaignMetrics
 */

/**
 * Project every release-1 indicator from one campaign's recorded artefacts.
 * Pure and deterministic: identical records yield identical output, rates and
 * percentiles round to 4 decimals, and durations are seconds.
 *
 * Denominators are the campaign's own units. A *closed checkpoint* is a node
 * that reached `done` or `no-op`. A *take* is one operator dispatch at a
 * checkpoint — one linked campaign run that the controller did not generate as
 * a repair — so it is counted from `takeRunIds`, which `deriveTakeRuns` reads
 * off `campaign.json` and `control-state.json`. Transition events cannot yield
 * it: a run redispatches its worker after a rotation or a failure, so the
 * events hold the finer unit, the *worker dispatch* (a transition into
 * `running` whose phase is not the judge). Without `takeRunIds` the take count
 * is unmeasured and its indicator is null, never the dispatch count standing
 * in for it. `providerFailoverRate` and `lostTakeRate` stay per dispatch,
 * because a failover hop and a worker attempt that bought nothing both happen
 * inside a take; each reports its dispatch count as its record count.
 *
 * @param {MetricsInput} [input]
 * @returns {CampaignMetrics}
 */
export function projectMetrics({
  events = [],
  takeRunIds = null,
  usageLedger = null,
  outbox = [],
  journal = [],
  preflight = [],
  now = Date.now(),
  staleSec,
  freshSec = HEARTBEAT_FRESH_SEC,
  tokenizerEstimate = DEFAULT_TOKENIZER_ESTIMATE,
} = {}) {
  const byNode = eventsByNode(events);
  const lifecycle = lifecycleOf(byNode);
  const usage = weightedUsageOf(usageLedger);
  const span = eventSpanOf(events);
  const gates = firstPassGateRateByLane(byNode);
  const livenessFacts = livenessFactsOf(journal);
  const gaps = livenessGapsOf(livenessFacts);
  const session = sessionUsageOf(outbox, tokenizerEstimate);
  const closed = lifecycle.closed;
  const takes = Array.isArray(takeRunIds) ? takeRunIds.length : null;
  // staleSec left undefined keeps heartbeat.mjs's own GOVERNANCE_STALE_SEC.
  const governance = deriveGovernanceMetrics({ events, livenessFacts, outbox, now, staleSec });
  const decisions = countDecisions(events);
  const preamble = preambleTokensByRuntime(events, preflight);
  return {
    weightedPerClosedCheckpoint: measured("down", usage.invocations, closed === 0 ? null : usage.weighted / closed),
    wallClockPerClosedCheckpoint: measured("down", span.count, closed === 0 || span.seconds === null ? null : span.seconds / closed),
    takesPerClosedCheckpoint: measured("down", takes ?? 0, takes === null || closed === 0 ? null : takes / closed),
    firstPassGateRate: grouped("up", gates.count, gates.value),
    judgeInvocationRate: measured("down", closed, closed === 0 ? null : lifecycle.judgeDispatches / closed),
    blockedContextRate: measured("down", lifecycle.settled, lifecycle.settled === 0 ? null : lifecycle.blockedContext / lifecycle.settled),
    providerFailoverRate: measured("informative", lifecycle.dispatches, lifecycle.dispatches === 0 ? null : lifecycle.failoverHops / lifecycle.dispatches),
    lostTakeRate: measured("down", lifecycle.dispatches, lifecycle.dispatches === 0 ? null : lifecycle.lostDispatches / lifecycle.dispatches),
    sessionContextGrowth: measured("down", session.count, session.tokens),
    sessionWakeCount: measured("down", session.count, session.wakes),
    heartbeatStalenessP95: measured("down", gaps.length, percentile95(gaps)),
    ambientCoverage: measured("up", gaps.length, coverageOf(gaps, freshSec)),
    budgetDecisionAge: measured("down", decisions, governance.budgetDecisionAge),
    budgetHeadroomAtDispatch: measured("informative", decisions, governance.budgetHeadroomAtDispatch),
    budgetExtensionRate: measured("informative", decisions, governance.budgetExtensionRate),
    continuationRate: measured("informative", decisions, governance.continuationRate),
    budgetAttentionLatencyP95: measured("down", countAttentionOutbox(outbox), governance.budgetAttentionLatencyP95),
    // Hard target zero (Addendum 02): a measured zero means every liveness gap
    // was covered, so it survives only while there are facts to measure.
    silentStallRate: measured("down", countNonterminalFacts(livenessFacts), governance.silentStallRate),
    workerPreambleTokens: grouped("down", preamble.count, preamble.value),
    notifyLatencyP95: measured("down", session.latencies.length, percentile95(session.latencies)),
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
 * Group the events that name a node, ordered by timestamp with the recorded
 * order breaking ties, so a take can be paired with the event that ends it.
 *
 * @param {unknown[]} events
 * @returns {Map<string, NodeEvent[]>}
 */
function eventsByNode(events) {
  /** @type {Map<string, NodeEvent[]>} */
  const byNode = new Map();
  events.forEach((raw, index) => {
    const event = jsonObjectOf(raw);
    if (event === null || typeof event.node !== "string") return;
    const list = byNode.get(event.node) ?? [];
    list.push({ atMs: timestampMs(event.at), index, event });
    byNode.set(event.node, list);
  });
  for (const list of byNode.values()) list.sort((left, right) => orderOf(left) - orderOf(right) || left.index - right.index);
  return byNode;
}

/** @param {NodeEvent} entry @returns {number} */
function orderOf(entry) {
  return Number.isFinite(entry.atMs) ? entry.atMs : 0;
}

/**
 * Count the campaign's lifecycle units from the transition events: closed and
 * settled checkpoints, worker and judge takes, the takes that bought nothing
 * and the provider failover hops.
 *
 * A take is lost when the event that ends it carries an error code and did not
 * settle the node — the invocation was spent and produced no result. A take
 * still open at the end of the recording is unknown, never lost.
 *
 * @param {Map<string, NodeEvent[]>} byNode
 * @returns {{closed: number, settled: number, blockedContext: number, dispatches: number, judgeDispatches: number, lostDispatches: number, failoverHops: number}}
 */
function lifecycleOf(byNode) {
  /** @type {Set<string>} */
  const closed = new Set();
  /** @type {Set<string>} */
  const settled = new Set();
  /** @type {Set<string>} */
  const blockedContext = new Set();
  let dispatches = 0;
  let judgeDispatches = 0;
  let lostDispatches = 0;
  let failoverHops = 0;
  for (const [node, entries] of byNode) {
    for (let index = 0; index < entries.length; index += 1) {
      const event = entries[index].event;
      if (event.to === "running") {
        if (event.phase === "judge") judgeDispatches += 1;
        else {
          dispatches += 1;
          if (isLostDispatch(entries[index + 1])) lostDispatches += 1;
        }
      }
      if (isFailoverHop(event)) failoverHops += 1;
      if (typeof event.to === "string" && CLOSED_STATUSES.has(event.to)) closed.add(node);
      if (typeof event.to === "string" && SETTLED_STATUSES.has(event.to)) settled.add(node);
      if (event.to === "blocked" && event.error === BLOCKED_CONTEXT_CODE) blockedContext.add(node);
    }
  }
  return {
    closed: closed.size,
    settled: settled.size,
    blockedContext: blockedContext.size,
    dispatches,
    judgeDispatches,
    lostDispatches,
    failoverHops,
  };
}

/**
 * @param {NodeEvent|undefined} next
 * @returns {boolean}
 */
function isLostDispatch(next) {
  if (next === undefined) return false;
  const { event } = next;
  if (typeof event.error !== "string" || event.error === "") return false;
  return !(typeof event.to === "string" && CLOSED_STATUSES.has(event.to));
}

/**
 * A provider failover hop is a routed transition whose override sends the node
 * to a runtime other than the one it was on; a retry or backoff on the same
 * runtime is not a hop (ADR-0022).
 *
 * @param {JsonObject} event
 * @returns {boolean}
 */
function isFailoverHop(event) {
  const override = jsonObjectOf(event.override);
  if (override === null || typeof override.nextRuntime !== "string") return false;
  const current = typeof event.currentRuntime === "string" ? event.currentRuntime : event.runtime;
  return typeof current === "string" && override.nextRuntime !== current;
}

/**
 * Wall-clock span of the recording, in seconds, with the number of timestamped
 * events it was measured from. A single event spans nothing measurable.
 *
 * @param {unknown[]} events
 * @returns {{seconds: number|null, count: number}}
 */
function eventSpanOf(events) {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const raw of events) {
    const event = jsonObjectOf(raw);
    if (event === null) continue;
    const atMs = timestampMs(event.at);
    if (!Number.isFinite(atMs)) continue;
    count += 1;
    if (atMs < earliest) earliest = atMs;
    if (atMs > latest) latest = atMs;
  }
  return count < 2 ? { seconds: null, count: 0 } : { seconds: (latest - earliest) / 1000, count };
}

/**
 * Total weighted input tokens of the usage ledger: every invocation of every
 * epoch, weighted by that epoch's own `cacheReadWeight`, exactly as the budget
 * ledger accounts for spend.
 *
 * @param {unknown} usageLedger
 * @returns {{weighted: number, invocations: number}}
 */
function weightedUsageOf(usageLedger) {
  const ledger = jsonObjectOf(usageLedger);
  const epochs = ledger === null ? null : jsonObjectOf(ledger.epochs);
  let weighted = 0;
  let invocations = 0;
  if (epochs === null) return { weighted, invocations };
  for (const rawEpoch of Object.values(epochs)) {
    const epoch = jsonObjectOf(rawEpoch);
    if (epoch === null) continue;
    const records = jsonObjectOf(epoch.invocations);
    if (records === null) continue;
    const policy = jsonObjectOf(epoch.policy);
    const cacheReadWeight = policy === null ? 1 : numberOf(policy.cacheReadWeight, 1);
    for (const rawInvocation of Object.values(records)) {
      const invocation = jsonObjectOf(rawInvocation);
      const usage = invocation === null ? null : jsonObjectOf(invocation.usage);
      if (usage === null) continue;
      invocations += 1;
      weighted += weightedInput({
        inputTokens: numberOf(usage.inputTokens, 0),
        cacheReadInputTokens: numberOf(usage.cacheReadInputTokens, 0),
      }, cacheReadWeight);
    }
  }
  return { weighted, invocations };
}

/**
 * Fraction of gated checkpoints whose first recorded verdict passed, per lane.
 * The lane is the node's per-runtime phase label, falling back to the runtime
 * that produced the verdict (TECH-SPEC section 10.1).
 *
 * @param {Map<string, NodeEvent[]>} byNode
 * @returns {{value: Record<string, number>, count: number}}
 */
function firstPassGateRateByLane(byNode) {
  /** @type {Map<string, {gated: number, passed: number}>} */
  const lanes = new Map();
  let gated = 0;
  for (const entries of byNode.values()) {
    const first = entries.find(({ event }) => typeof event.verdict === "string");
    if (first === undefined) continue;
    gated += 1;
    const lane = laneOf(first.event);
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

/** @param {JsonObject} event @returns {string} */
function laneOf(event) {
  if (typeof event.planPhase === "string" && event.planPhase !== "") return event.planPhase;
  if (typeof event.runtime === "string" && event.runtime !== "") return event.runtime;
  return UNKNOWN_LANE;
}

/**
 * @param {unknown[]} events
 * @returns {number}
 */
function countDecisions(events) {
  let count = 0;
  for (const raw of events) {
    const event = jsonObjectOf(raw);
    if (event !== null && jsonObjectOf(event.budgetDecision) !== null) count += 1;
  }
  return count;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOf(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Weighted input for one recorded usage, comparable with the live meter and
 * the campaign cap: cache reads count at the campaign `cacheReadWeight`, not
 * raw. The ledger projection above and the runner's budget accounting agree on
 * what a campaign spent because both weigh an invocation here.
 *
 * @param {{inputTokens?: number|null, cacheReadInputTokens?: number|null}|null|undefined} usage
 * @param {number} cacheReadWeight
 * @returns {number}
 */
export function weightedInput(usage, cacheReadWeight) {
  return Math.round(((usage?.inputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0) * cacheReadWeight) * 1000) / 1000;
}

/** Flags of `runner.mjs metrics`, declared here so the router only names them. */
/** @type {import("node:util").ParseArgsOptionsConfig} */
export const METRICS_OPTIONS = { cwd: { type: "string" }, json: { type: "boolean" } };

const RUNS_DIR_NAME = ".runs";
const RUN_EVENTS_FILE = "events.jsonl";
const USAGE_LEDGER_FILE = "usage-ledger.json";
/** Recorded origin of a run the controller generated to recover a partial effect. */
const REPAIR_KIND = "repair";

/**
 * @typedef {{
 *   campaignId: string,
 *   runIds: string[],
 *   takeRunIds: string[],
 *   repairRunIds: string[],
 *   events: unknown[],
 *   usageLedger: unknown,
 *   outbox: unknown[],
 *   journal: unknown[],
 *   preflight: unknown[],
 * }} MetricsSources
 */

/**
 * Split a campaign's linked runs into takes and repairs. A take is an operator
 * dispatch at a checkpoint; a repair is controller-generated recovery of a
 * partial effect, so it is not one. The rule is mechanical and reads only
 * recorded facts: `control-state.json` records the origin of every run the
 * supervisor itself dispatched, a linked run whose recorded kind is `repair`
 * is a repair, and a linked run the supervisor never recorded was launched by
 * the operator and counts. Repairs are reported alongside takes, never folded
 * into them: the two are different facts about the same campaign.
 *
 * @param {string[]} linkedRunIds
 * @param {unknown} controlState `control-state.json`, or null when unrecorded.
 * @returns {{takeRunIds: string[], repairRunIds: string[]}}
 */
export function deriveTakeRuns(linkedRunIds, controlState) {
  const recorded = jsonObjectOf(controlState)?.runs;
  const runs = Array.isArray(recorded) ? recorded : [];
  /** @type {Set<string>} */
  const repairs = new Set();
  for (const run of runs) {
    const entry = jsonObjectOf(run);
    if (entry?.kind === REPAIR_KIND && typeof entry.id === "string") repairs.add(entry.id);
  }
  return {
    takeRunIds: linkedRunIds.filter((runId) => !repairs.has(runId)),
    repairRunIds: linkedRunIds.filter((runId) => repairs.has(runId)),
  };
}

/**
 * Read the recorded sources of one campaign: the transition events and
 * recorded `preflight --json` payload of every linked run, plus the campaign's
 * usage ledger, notification outbox and journal. A missing artefact reads as
 * empty, which the projector reports as a missing measurement and never as a
 * measured zero — a run whose phase start recorded no `preflight.json` leaves
 * the preamble to whatever its dispatches recorded.
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
  const preflight = [];
  for (const runId of campaign.linkedRunIds) {
    for (const record of readJsonlRecords(join(runsDir, runId, RUN_EVENTS_FILE))) events.push(record);
    const payload = readJsonFile(join(runsDir, runId, PREFLIGHT_FILE));
    if (payload !== null) preflight.push(payload);
  }
  return {
    campaignId: campaign.id,
    runIds: [...campaign.linkedRunIds],
    ...deriveTakeRuns([...campaign.linkedRunIds], readJsonFile(join(campaignPath, CAMPAIGN_STATE_FILE))),
    events,
    usageLedger: readJsonFile(join(campaignPath, USAGE_LEDGER_FILE)),
    outbox: readNotificationOutbox(campaignPath),
    journal: readJournal(campaignPath),
    preflight,
  };
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

/** @param {string} path @returns {unknown} */
function readJsonFile(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
