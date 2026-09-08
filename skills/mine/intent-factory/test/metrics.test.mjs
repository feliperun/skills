import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMetricsJson, renderMetricsReport } from "../scripts/metrics-report.mjs";
import {
  DEFAULT_TOKENIZER_ESTIMATE,
  HEARTBEAT_FRESH_SEC,
  deriveTakeRuns,
  projectMetrics,
  readMetricsSources,
} from "../scripts/metrics.mjs";

/** Every indicator of TECH-SPEC 8.4 with the direction the spec table gives it. */
const DIRECTIONS = {
  wallClockPerClosedCheckpoint: "down",
  takesPerClosedCheckpoint: "down",
  firstPassGateRate: "up",
  judgeInvocationRate: "down",
  blockedContextRate: "down",
  providerFailoverRate: "informative",
  lostTakeRate: "down",
  sessionContextGrowth: "down",
  sessionWakeCount: "down",
  heartbeatStalenessP95: "down",
  ambientCoverage: "up",
  silentStallRate: "down",
  workerPreambleTokens: "down",
  notifyLatencyP95: "down",
  usageTokensByKind: "informative",
  usageCostUsd: "down",
};

/** @param {number} minute @param {number} [second] @returns {string} */
const at = (minute, second = 0) =>
  `2026-09-04T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

/** @param {number} minute @param {number} [second] @returns {number} */
const ms = (minute, second = 0) => Date.parse(at(minute, second));

/**
 * One node lifecycle: two worker takes on `a` (the first lost to an exhausted
 * provider that fails over), one judge take, a pass and a close; one worker
 * take on `b` that settles blocked for missing context.
 *
 * @returns {Record<string, unknown>[]}
 */
function lifecycleEvents() {
  return [
    { at: at(0), node: "a", from: "pending", to: "running", phase: "worker", runtime: "glm" },
    {
      at: at(10),
      node: "a",
      from: "running",
      to: "pending",
      phase: "worker",
      currentRuntime: "glm",
      error: "provider_exhausted",
      override: { nextRuntime: "deepseek-flash", rule: 0, hop: 1 },
    },
    { at: at(20), node: "a", from: "pending", to: "running", phase: "worker", runtime: "deepseek-flash" },
    { at: at(30), node: "a", from: "running", to: "running", phase: "judge", runtime: "sol-medium" },
    { at: at(35), node: "a", from: "running", to: "done", phase: "judge", runtime: "deepseek-flash", verdict: "pass" },
    { at: at(50), node: "b", from: "pending", to: "running", phase: "worker", runtime: "glm" },
    { at: at(55), node: "b", from: "running", to: "blocked", phase: "worker", runtime: "glm", error: "context_missing" },
  ];
}

/** @returns {Record<string, unknown>[]} two usage.jsonl records worth 1,800 input, 2,000 cache-read and 8 output tokens */
function usageRecords() {
  return [
    { invocationId: "inv-1", role: "worker", inputTokens: 1000, cacheReadInputTokens: 2000, outputTokens: 5, costUsd: 0.01 },
    { invocationId: "inv-2", role: "judge", inputTokens: 800, cacheReadInputTokens: 0, outputTokens: 3, costUsd: 0.02 },
  ];
}

/** @param {Record<string, unknown>} record @returns {number} */
const recordTokens = (record) =>
  Math.ceil(
    (Buffer.byteLength(JSON.stringify(record), "utf8") * DEFAULT_TOKENIZER_ESTIMATE.tokens) / DEFAULT_TOKENIZER_ESTIMATE.bytes,
  );

test("metrics per-closed-checkpoint indicators divide campaign totals by closed checkpoints", () => {
  const events = lifecycleEvents();
  // Two operator dispatches at this checkpoint; the three worker dispatches in
  // the events are the finer unit inside them and are not takes.
  const takeRunIds = ["run-initial", "run-take2"];
  const metrics = projectMetrics({ events, takeRunIds });
  assert.deepEqual(metrics.wallClockPerClosedCheckpoint, { value: 3300, direction: "down", count: 7 });
  assert.deepEqual(metrics.takesPerClosedCheckpoint, { value: 2, direction: "down", count: 2 });

  const open = projectMetrics({ events: events.filter((event) => event.to !== "done"), takeRunIds });
  assert.equal(open.takesPerClosedCheckpoint.value, null);

  // Takes are linked runs, so events alone cannot yield them: without the run
  // ids the indicator is a missing measurement, and the worker dispatches the
  // events do record are never substituted for it.
  assert.deepEqual(projectMetrics({ events }).takesPerClosedCheckpoint, {
    value: null,
    direction: "down",
    count: 0,
  });
});

test("metrics usageTokensByKind and usageCostUsd sum the run's usage.jsonl records", () => {
  const metrics = projectMetrics({ usageRecords: usageRecords() });
  assert.deepEqual(metrics.usageTokensByKind, {
    value: { inputTokens: 1800, cacheReadInputTokens: 2000, outputTokens: 8 },
    direction: "informative",
    count: 2,
  });
  assert.deepEqual(metrics.usageCostUsd, { value: 0.03, direction: "down", count: 2 });

  // A record with no measured usage is a missing measurement, never zero spend.
  const unmeasured = projectMetrics({ usageRecords: [] });
  assert.deepEqual(unmeasured.usageTokensByKind, { value: null, direction: "informative", count: 0 });
  assert.deepEqual(unmeasured.usageCostUsd, { value: null, direction: "down", count: 0 });
});

test("metrics firstPassGateRate is reported per lane and never zero without a gate", () => {
  const events = [
    { at: at(0), node: "g1", to: "running", phase: "judge", runtime: "glm" },
    { at: at(5), node: "g1", to: "running", phase: "judge", runtime: "glm", verdict: "fail" },
    { at: at(9), node: "g1", to: "done", phase: "judge", runtime: "glm", verdict: "pass" },
    { at: at(6), node: "g2", to: "done", phase: "judge", runtime: "gemini-flash", planPhase: "p4-gemini", verdict: "pass" },
  ];
  const metrics = projectMetrics({ events });
  assert.deepEqual(metrics.firstPassGateRate, { value: { glm: 0, "p4-gemini": 1 }, direction: "up", count: 2 });

  // A lane that scored 0 is a measured failure; a campaign with no gate at all
  // has no rate to report.
  const ungated = projectMetrics({ events: lifecycleEvents().filter((event) => event.verdict === undefined) });
  assert.deepEqual(ungated.firstPassGateRate, { value: null, direction: "up", count: 0 });
});

test("metrics judgeInvocationRate separates a judge-free close from an unclosed campaign", () => {
  assert.deepEqual(projectMetrics({ events: lifecycleEvents() }).judgeInvocationRate, {
    value: 1,
    direction: "down",
    count: 1,
  });

  // D24: a contract without judgment items closes with zero judge invocations —
  // a measured zero over one closed checkpoint.
  const judgeFree = projectMetrics({
    events: [
      { at: at(0), node: "a", to: "running", phase: "worker", runtime: "glm" },
      { at: at(5), node: "a", to: "done", phase: "worker", runtime: "glm" },
    ],
  });
  assert.deepEqual(judgeFree.judgeInvocationRate, { value: 0, direction: "down", count: 1 });

  const nothingClosed = projectMetrics({ events: [{ at: at(0), node: "a", to: "running", phase: "worker" }] });
  assert.deepEqual(nothingClosed.judgeInvocationRate, { value: null, direction: "down", count: 0 });
});

test("metrics blockedContextRate is measured over settled checkpoints only", () => {
  assert.deepEqual(projectMetrics({ events: lifecycleEvents() }).blockedContextRate, {
    value: 0.5,
    direction: "down",
    count: 2,
  });

  const cleanClose = projectMetrics({ events: [{ at: at(0), node: "a", to: "done", phase: "worker" }] });
  assert.deepEqual(cleanClose.blockedContextRate, { value: 0, direction: "down", count: 1 });

  const running = projectMetrics({ events: [{ at: at(0), node: "a", to: "running", phase: "worker" }] });
  assert.deepEqual(running.blockedContextRate, { value: null, direction: "down", count: 0 });
});

test("metrics providerFailoverRate counts hops that change runtime, informatively", () => {
  assert.deepEqual(projectMetrics({ events: lifecycleEvents() }).providerFailoverRate, {
    value: 0.3333,
    direction: "informative",
    count: 3,
  });

  // A backoff that re-dispatches the same runtime is a retry, not a hop: zero
  // is measured over the one worker dispatch that happened.
  const retried = projectMetrics({
    events: [
      { at: at(0), node: "a", to: "running", phase: "worker", runtime: "glm" },
      { at: at(2), node: "a", to: "pending", phase: "worker", currentRuntime: "glm", error: "network", override: { nextRuntime: "glm" } },
    ],
  });
  assert.deepEqual(retried.providerFailoverRate, { value: 0, direction: "informative", count: 1 });

  assert.deepEqual(projectMetrics().providerFailoverRate, { value: null, direction: "informative", count: 0 });
});

test("metrics lostTakeRate counts takes whose spend bought no result", () => {
  // Measured per worker dispatch, the unit a loss happens in: both the
  // exhausted dispatch on `a` and the blocked-context dispatch on `b` end in
  // an error without settling their node. Takes are the coarser unit and are
  // counted from the linked runs, so they are not this denominator.
  assert.deepEqual(projectMetrics({ events: lifecycleEvents() }).lostTakeRate, {
    value: 0.6667,
    direction: "down",
    count: 3,
  });

  const clean = projectMetrics({
    events: [
      { at: at(0), node: "a", to: "running", phase: "worker", runtime: "glm" },
      { at: at(5), node: "a", to: "done", phase: "worker", runtime: "glm" },
    ],
  });
  assert.deepEqual(clean.lostTakeRate, { value: 0, direction: "down", count: 1 });

  // A dispatch still open at the end of the recording is unknown, not lost —
  // and with no dispatch at all there is nothing to report.
  const noTake = projectMetrics({ events: [{ at: at(0), node: "a", to: "pending", phase: "worker" }] });
  assert.deepEqual(noTake.lostTakeRate, { value: null, direction: "down", count: 0 });
});

test("metrics session indicators count each notified event once, at its first attempt", () => {
  // Only node.terminal, run.terminal and attention are ever notified — progress
  // never is — so every notify.jsonl record is already wake-worthy; a retry of
  // the same event (attempt 2) must not be counted a second time.
  const first = { type: "node.terminal", runId: "r", nodeId: "n", attempt: 1, status: "failed", at: at(1) };
  const retry = { type: "node.terminal", runId: "r", nodeId: "n", attempt: 2, status: "delivered", at: at(1, 5) };
  const metrics = projectMetrics({ notifications: [first, retry] });
  assert.deepEqual(metrics.sessionWakeCount, { value: 1, direction: "down", count: 2 });
  assert.deepEqual(metrics.sessionContextGrowth, { value: recordTokens(first), direction: "down", count: 2 });

  const empty = projectMetrics();
  assert.deepEqual(empty.sessionWakeCount, { value: null, direction: "down", count: 0 });
  assert.deepEqual(empty.sessionContextGrowth, { value: null, direction: "down", count: 0 });
});

test("metrics ambient liveness indicators measure the gaps between liveness facts", () => {
  /** @param {string} stamp @returns {Record<string, unknown>} */
  const fact = (stamp) => ({ type: "liveness", eventId: stamp, at: stamp, state: "running" });
  const journal = [
    { type: "intent", at: at(0), text: "not a liveness fact" },
    fact(at(0, 30)),
    fact(at(0)),
    fact(at(3)),
  ];
  const metrics = projectMetrics({ journal, freshSec: HEARTBEAT_FRESH_SEC });
  // Gaps of 30 s and 150 s: the p95 is the worst age a reader would have seen,
  // and only 60 s of the long gap counts as covered.
  assert.deepEqual(metrics.heartbeatStalenessP95, { value: 150, direction: "down", count: 2 });
  assert.deepEqual(metrics.ambientCoverage, { value: 0.5, direction: "up", count: 2 });

  // One fact is a heartbeat that was never re-read: no gap, so no measurement
  // — not a coverage of zero.
  const single = projectMetrics({ journal: [fact(at(0))] });
  assert.deepEqual(single.heartbeatStalenessP95, { value: null, direction: "down", count: 0 });
  assert.deepEqual(single.ambientCoverage, { value: null, direction: "up", count: 0 });
});

test("metrics silentStallRate is measured only from a legacy journal's liveness facts", () => {
  // The heartbeat mechanism that used to append "liveness" journal entries is
  // gone, and with it the campaign-level watchdog that could cover a gap: any
  // qualifying gap in an old journal's facts is now unconditionally silent.
  /** @param {string} stamp @returns {Record<string, unknown>} */
  const fact = (stamp) => ({ type: "liveness", eventId: stamp, at: stamp, state: "running" });

  // Two facts one supervisor interval apart: no gap exceeded staleSec, so the
  // hard target is met and the zero is measured.
  const healthy = projectMetrics({ journal: [fact(at(0)), fact(at(10))], staleSec: 2400 });
  assert.deepEqual(healthy.silentStallRate, { value: 0, direction: "down", count: 2 });

  // A gap past staleSec is a silent stall: nothing can cover it any more.
  const stalled = projectMetrics({ journal: [fact(at(0)), fact(at(50))], staleSec: 600 });
  assert.deepEqual(stalled.silentStallRate, { value: 1, direction: "down", count: 2 });

  // A campaign with no liveness fact has no stall measurement at all.
  assert.deepEqual(projectMetrics().silentStallRate, { value: null, direction: "down", count: 0 });
  assert.deepEqual(projectMetrics({ journal: [fact(at(0))] }).silentStallRate, { value: null, direction: "down", count: 0 });
});

test("metrics workerPreambleTokens is the mean measured preamble per runtime", () => {
  /** @param {string} runtimeId @param {number} preambleTokens @returns {Record<string, unknown>} */
  const check = (runtimeId, preambleTokens) => ({ id: runtimeId, live: true, usage: { inputTokens: preambleTokens } });
  const preflight = [{ checks: [check("glm", 1200), check("glm", 1400), check("deepseek-flash", 900)] }];
  const metrics = projectMetrics({ preflight });
  assert.deepEqual(metrics.workerPreambleTokens, {
    value: { "deepseek-flash": 900, glm: 1300 },
    direction: "down",
    count: 3,
  });

  // A static preflight check never ran the probe, so it contributes no
  // measurement rather than a preamble of zero.
  const unmeasured = projectMetrics({ preflight: [{ checks: [{ id: "glm", live: false }] }] });
  assert.deepEqual(unmeasured.workerPreambleTokens, { value: null, direction: "down", count: 0 });
});

test("metrics notifyLatencyP95 measures notify.jsonl receipts from first attempt to delivery", () => {
  const base = { type: "attention" };
  const metrics = projectMetrics({
    notifications: [
      { ...base, runId: "a", attempt: 1, status: "failed", at: at(0) },
      { ...base, runId: "a", attempt: 2, status: "delivered", at: at(0, 2) },
      { ...base, runId: "b", attempt: 1, status: "failed", at: at(1) },
      { ...base, runId: "b", attempt: 2, status: "delivered", at: at(1, 10) },
    ],
  });
  assert.deepEqual(metrics.notifyLatencyP95, { value: 10, direction: "down", count: 2 });

  // A receipt that never reaches delivered still wakes the session, but has no
  // latency to report.
  const undelivered = projectMetrics({ notifications: [{ ...base, runId: "c", attempt: 1, status: "failed", at: at(0) }] });
  assert.deepEqual(undelivered.notifyLatencyP95, { value: null, direction: "down", count: 0 });
  assert.equal(undelivered.sessionWakeCount.value, 1);
});

test("metrics projects every indicator of 8.4, null and never zero without records", () => {
  const metrics = projectMetrics();
  assert.deepEqual(Object.keys(metrics).sort(), Object.keys(DIRECTIONS).sort());
  for (const [name, direction] of Object.entries(DIRECTIONS)) {
    const indicator = /** @type {{value: unknown, direction: string, count: number}} */ (
      /** @type {Record<string, unknown>} */ (metrics)[name]
    );
    assert.equal(indicator.value, null, `${name} must be null without a supporting record`);
    assert.equal(indicator.count, 0, `${name} must report zero supporting records`);
    assert.equal(indicator.direction, direction, `${name} direction`);
  }
});

test("metrics projection is pure: identical records yield identical indicators", () => {
  const now = ms(90);
  const input = () => ({ events: lifecycleEvents(), usageRecords: usageRecords(), now });
  assert.deepEqual(projectMetrics(input()), projectMetrics(input()));
  const events = lifecycleEvents();
  const before = JSON.stringify(events);
  projectMetrics({ events });
  assert.equal(JSON.stringify(events), before, "the projector must not mutate its input");
});

/**
 * Baseline reproduction of the campaign the 2026-09-01 retrospective measured.
 *
 * `fixtures/metrics-20260829.json` is one bounded document distilled from the
 * recorded campaign `intent-factory-retrospective-20260829` under `.runs/`:
 * its `campaign.json` verbatim, the `runs[].id` and `runs[].kind` of its
 * `control-state.json`, its usage ledger (the pre-diet record; schema 3 has no
 * ledger, so the workspace below flattens it into `usage.jsonl` records for
 * the projector to read) reduced to each invocation's input and cache-read
 * tokens, all 89 transition events of its 18 linked runs reduced to the fields
 * the projector reads, its 90 notification records reduced likewise, and 3 of
 * its 96 journal entries — the two that bound the campaign and the
 * retrospective that records the baseline. The recorded journal holds no
 * liveness fact, so the ambient indicators are null here exactly as they were
 * there. The document's own `distilledFrom` block states what it was
 * distilled from and what was kept; projected over it, the indicators equal
 * the ones projected over the campaign tree itself. `.runs/` is never a test
 * dependency: the test neither reads it nor writes it.
 */
/**
 * @typedef {{
 *   distilledFrom: {campaignId: string, source: string},
 *   campaign: {id: string, closedAt: string, linkedRunIds: string[]},
 *   controlState: {runs: {id: string, kind: string}[]},
 *   usageLedger: {epochs: Record<string, {invocations: Record<string, {usage: {inputTokens: number|null, cacheReadInputTokens: number|null}}>}>},
 *   journal: unknown[],
 *   outbox: unknown[],
 *   runs: Record<string, unknown[]>,
 * }} BaselineFixture
 */
const FIXTURE = /** @type {BaselineFixture} */ (
  JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/metrics-20260829.json", import.meta.url)), "utf8"))
);
const BASELINE_CAMPAIGN = "intent-factory-retrospective-20260829";
const RUNNER = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));

/** @type {string|null} */
let materialized = null;

/**
 * The distilled campaign laid out on disk the way the CLI reads it, under a
 * temporary `.runs/`, so the command and the readers behind it are exercised
 * end to end without the repository's own run directory. Written once per
 * process, and only under `tmpdir()`.
 *
 * @returns {string}
 */
function baselineWorkspace() {
  if (materialized !== null) return materialized;
  const cwd = mkdtempSync(join(tmpdir(), "metrics-baseline-"));
  const campaignPath = join(cwd, ".runs", "campaigns", BASELINE_CAMPAIGN);
  mkdirSync(campaignPath, { recursive: true });
  writeFileSync(join(campaignPath, "campaign.json"), JSON.stringify(FIXTURE.campaign));
  // control-state.json is legacy: nothing writes it any more, but it is still
  // read for backward compatibility with a campaign that has one, which this
  // distilled baseline does.
  writeFileSync(join(campaignPath, "control-state.json"), JSON.stringify(FIXTURE.controlState));
  // FIXTURE.outbox is kept for provenance (it was part of what the campaign was
  // distilled from) but is never materialized: readMetricsSources reads
  // notify.jsonl per linked run now, and this baseline predates that file.
  writeFileSync(join(campaignPath, "journal.jsonl"), FIXTURE.journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  for (const [runId, events] of Object.entries(FIXTURE.runs)) {
    mkdirSync(join(cwd, ".runs", runId), { recursive: true });
    writeFileSync(join(cwd, ".runs", runId, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
  // schema 3 has no ledger: the pre-diet invocations flatten into usage.jsonl
  // records, all attached to the first linked run since the aggregate totals
  // below never depend on which run an invocation belongs to.
  const firstRunId = FIXTURE.campaign.linkedRunIds[0];
  const usageRecordsList = Object.values(FIXTURE.usageLedger.epochs).flatMap((epoch) => Object.values(epoch.invocations));
  writeFileSync(
    join(cwd, ".runs", firstRunId, "usage.jsonl"),
    usageRecordsList.map((invocation) => `${JSON.stringify({ inputTokens: invocation.usage.inputTokens, cacheReadInputTokens: invocation.usage.cacheReadInputTokens })}\n`).join(""),
  );
  materialized = cwd;
  return cwd;
}

/** @returns {ReturnType<typeof readMetricsSources>} */
function baselineSources() {
  const cwd = baselineWorkspace();
  return readMetricsSources(join(cwd, ".runs", "campaigns", BASELINE_CAMPAIGN), { runsDir: join(cwd, ".runs") });
}

test("metrics takes are linked runs the controller did not generate as repairs", () => {
  const linked = ["initial", "operator-take2", "repair-of-initial"];
  const controlState = {
    runs: [
      { id: "initial", kind: "initial" },
      { id: "repair-of-initial", kind: "repair" },
    ],
  };
  const split = deriveTakeRuns(linked, controlState);
  // A repair is controller-generated recovery, not an operator dispatch at the
  // checkpoint; a run the supervisor never recorded was launched by the
  // operator and counts. The two counts are reported side by side.
  assert.deepEqual(split.takeRunIds, ["initial", "operator-take2"]);
  assert.deepEqual(split.repairRunIds, ["repair-of-initial"]);
  // No recorded control state at all: every linked run is an operator dispatch.
  assert.deepEqual(deriveTakeRuns(linked, null), { takeRunIds: linked, repairRunIds: [] });
  // A repair the campaign never linked cannot subtract from the takes.
  assert.deepEqual(deriveTakeRuns(["initial"], controlState).takeRunIds, ["initial"]);
});

test("metrics baseline fixture declares the campaign it was distilled from", () => {
  assert.equal(FIXTURE.distilledFrom.campaignId, BASELINE_CAMPAIGN);
  assert.match(FIXTURE.distilledFrom.source, /^\.runs\/campaigns\/intent-factory-retrospective-20260829\b/u);
  assert.equal(FIXTURE.campaign.id, BASELINE_CAMPAIGN);
  // One document, not a campaign tree: every linked run's events live in it,
  // and the recorded origin the take derivation reads travels with them.
  assert.deepEqual(Object.keys(FIXTURE.runs).sort(), [...FIXTURE.campaign.linkedRunIds].sort());
  assert.ok(FIXTURE.controlState.runs.some((run) => run.kind === "repair"), "the distilled control state keeps the recorded repair");
});

/**
 * Worker dispatches recorded inside the campaign's repair runs. `lostTakeRate`
 * is measured per dispatch, so its record count is the dispatch count.
 *
 * @param {string[]} runIds
 * @returns {number}
 */
function dispatchesOf(runIds) {
  return runIds.reduce((total, runId) => total + projectMetrics({ events: FIXTURE.runs[runId] }).lostTakeRate.count, 0);
}

test("metrics baseline reproduces the recorded 2026-08-29 campaign", () => {
  const sources = baselineSources();
  const metrics = projectMetrics({ ...sources, now: Date.parse(FIXTURE.campaign.closedAt) });
  // The closed-checkpoint denominator is what the judge rate was measured over.
  const closed = metrics.judgeInvocationRate.count;
  assert.equal(closed, 3, "the campaign closed three checkpoints");
  assert.equal(metrics.usageTokensByKind.value?.inputTokens, 1_746_500, "the flattened ledger's input tokens reach the projector unchanged");
  assert.equal(metrics.usageTokensByKind.value?.cacheReadInputTokens, 30_208_960, "the flattened ledger's cache-read tokens reach the projector unchanged");
  const hours = /** @type {number} */ (metrics.wallClockPerClosedCheckpoint.value) * closed / 3600;
  assert.ok(Math.abs(hours - 81) < 1, `wall clock ${hours}h is not the recorded ~81h`);
  // Takes, in the unit the retrospective counted them: one take is one linked
  // run the controller did not generate as a repair. Derived, not fitted —
  // `control-state.json` records the origin of every run the supervisor
  // dispatched, the one run recorded `repair` is controller-generated recovery
  // of a partial effect rather than an operator dispatch at the checkpoint, and
  // the seventeen runs it never recorded were launched by the operator. So
  // eighteen linked runs minus one repair is the retrospective's seventeen,
  // and the repair is reported separately rather than folded in.
  assert.equal(sources.runIds.length, 18, "the campaign linked eighteen runs");
  assert.equal(sources.repairRunIds.length, 1, "one linked run was controller-generated repair");
  assert.equal(sources.takeRunIds.length, 17, "the campaign recorded seventeen takes");
  assert.deepEqual(
    sources.repairRunIds,
    FIXTURE.controlState.runs.filter((run) => run.kind === "repair").map((run) => run.id),
    "the repair is the run control-state records as one",
  );
  // The indicator is projected from exactly that count, so the report says
  // seventeen where the retrospective said seventeen: 17 takes over 3 closed
  // checkpoints is 5.6667 takes per closed checkpoint.
  assert.deepEqual(metrics.takesPerClosedCheckpoint, { value: 5.6667, direction: "down", count: 17 });
  // Every take did dispatch a worker, and the finer unit is the one the
  // per-dispatch rates are measured over: the same artefacts hold 37 worker
  // dispatches, because a take redispatches its node after a rotation or a
  // failure. That count is reported as those indicators' record count and is
  // never presented as the take count.
  assert.equal(metrics.lostTakeRate.count, 37);
  assert.equal(metrics.providerFailoverRate.count, 37);
  let dispatches = 0;
  for (const runId of sources.takeRunIds) {
    const perTake = projectMetrics({ events: FIXTURE.runs[runId], takeRunIds: [runId] });
    assert.equal(perTake.takesPerClosedCheckpoint.count, 1, `take ${runId} is one take`);
    assert.ok(perTake.lostTakeRate.count >= 1, `take ${runId} dispatched no worker`);
    dispatches += perTake.lostTakeRate.count;
  }
  assert.equal(dispatches + dispatchesOf(sources.repairRunIds), 37, "every dispatch belongs to a take or to the repair");
});

test("metrics baseline report prints every indicator with its value and direction", () => {
  const sources = baselineSources();
  const metrics = projectMetrics(sources);
  const report = renderMetricsReport(sources, metrics);
  const lines = report.trimEnd().split("\n");
  assert.equal(lines.length, Object.keys(metrics).length + 1, "one header plus one line per indicator");
  assert.match(lines[0], new RegExp(`${BASELINE_CAMPAIGN} · 18 runs \\(17 takes, 1 repair\\) · 89 events · 16 indicators`, "u"));
  for (const [name, indicator] of Object.entries(metrics)) {
    const line = lines.find((candidate) => candidate.startsWith(name));
    assert.ok(line, `${name} is missing from the report`);
    assert.match(line, new RegExp(`\\b${indicator.direction}\\b`, "u"), `${name} must print its direction`);
    assert.match(line, /· \d+ records?$/u, `${name} must print how many records it was measured from`);
    assert.ok(line.length <= 120, `${name} line is unbounded at ${line.length} chars`);
  }
  // Effectiveness and efficiency are never reported one without the other.
  assert.match(report, /firstPassGateRate\s+up\s+glm53-flash=0 sol-low=1 terra-medium=0/u);
  assert.match(report, /usageTokensByKind\s+informative\s+inputTokens=1746500 cacheReadInputTokens=30208960 outputTokens=0\s+· 24 records/u);
  // The take line is the retrospective's seventeen over three closed
  // checkpoints, and it prints the take count as its record count.
  assert.match(report, /takesPerClosedCheckpoint\s+down\s+5\.6667\s+· 17 records/u);
  assert.match(report, /heartbeatStalenessP95\s+down\s+no record\s+· 0 records/u);
});

test("metrics command projects a campaign from its recorded artefacts", () => {
  const cwd = baselineWorkspace();
  const sources = baselineSources();
  const expected = renderMetricsJson(sources, projectMetrics(sources));
  const json = spawnSync(process.execPath, [RUNNER, "metrics", BASELINE_CAMPAIGN, "--cwd", cwd, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, expected);
  const machine = JSON.parse(json.stdout);
  assert.equal(machine.schemaVersion, 1);
  assert.deepEqual({ runs: machine.runs, takes: machine.takes, repairs: machine.repairs }, { runs: 18, takes: 17, repairs: 1 });
  const report = spawnSync(process.execPath, [RUNNER, "metrics", BASELINE_CAMPAIGN, "--cwd", cwd], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.stdout, renderMetricsReport(sources, projectMetrics(sources)));
  const unknown = spawnSync(process.execPath, [RUNNER, "metrics", "no-such-campaign", "--cwd", cwd], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /campaign not found/u);
});
