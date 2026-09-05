import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveGovernanceMetrics } from "../scripts/heartbeat.mjs";
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
  weightedPerClosedCheckpoint: "down",
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
  budgetDecisionAge: "down",
  budgetHeadroomAtDispatch: "informative",
  budgetExtensionRate: "informative",
  continuationRate: "informative",
  budgetAttentionLatencyP95: "down",
  silentStallRate: "down",
  workerPreambleTokens: "down",
  notifyLatencyP95: "down",
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

/** @returns {Record<string, unknown>} a two-invocation ledger worth 2,000 weighted tokens */
function usageLedger() {
  return {
    schemaVersion: 1,
    epochs: {
      "p4-01": {
        policy: { epoch: "p4-01", cacheReadWeight: 0.1, maxInputTokens: 100_000 },
        invocations: {
          "inv-1": { role: "worker", planPhase: "p4-glm", usage: { inputTokens: 1000, cacheReadInputTokens: 2000 } },
          "inv-2": { role: "judge", planPhase: "p4-glm", usage: { inputTokens: 800, cacheReadInputTokens: 0 } },
        },
      },
    },
  };
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
  const metrics = projectMetrics({ events, takeRunIds, usageLedger: usageLedger() });
  assert.deepEqual(metrics.weightedPerClosedCheckpoint, { value: 2000, direction: "down", count: 2 });
  assert.deepEqual(metrics.wallClockPerClosedCheckpoint, { value: 3300, direction: "down", count: 7 });
  assert.deepEqual(metrics.takesPerClosedCheckpoint, { value: 2, direction: "down", count: 2 });

  // Measured spend with nothing closed is not zero cost per checkpoint: the
  // ratio has no denominator, so it is missing while its records still count.
  const open = projectMetrics({ events: events.filter((event) => event.to !== "done"), takeRunIds, usageLedger: usageLedger() });
  assert.deepEqual(open.weightedPerClosedCheckpoint, { value: null, direction: "down", count: 2 });
  assert.equal(open.takesPerClosedCheckpoint.value, null);

  // A closed checkpoint with no ledger is a missing measurement, never 0 spend.
  const unledgered = projectMetrics({ events, takeRunIds });
  assert.deepEqual(unledgered.weightedPerClosedCheckpoint, { value: null, direction: "down", count: 0 });
  assert.equal(unledgered.takesPerClosedCheckpoint.value, 2);

  // Takes are linked runs, so events alone cannot yield them: without the run
  // ids the indicator is a missing measurement, and the worker dispatches the
  // events do record are never substituted for it.
  assert.deepEqual(projectMetrics({ events, usageLedger: usageLedger() }).takesPerClosedCheckpoint, {
    value: null,
    direction: "down",
    count: 0,
  });
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

test("metrics session indicators grow only on requiresUser involvement", () => {
  const wake = {
    type: "campaign.completed",
    at: at(9),
    campaignId: "c",
    summary: "campaign closed",
    requiresUser: true,
    data: {},
  };
  const progress = { type: "campaign.progress", at: at(1), campaignId: "c", summary: "2/3", requiresUser: false, data: {} };
  const metrics = projectMetrics({ outbox: [progress, { ...progress, at: at(5) }, wake] });
  assert.deepEqual(metrics.sessionWakeCount, { value: 1, direction: "down", count: 3 });
  assert.deepEqual(metrics.sessionContextGrowth, { value: recordTokens(wake), direction: "down", count: 3 });

  // The control session is pull-only: progress never wakes it, so a campaign
  // that only progressed measures zero over the records it did project.
  const pullOnly = projectMetrics({ outbox: [progress, { ...progress, at: at(5) }] });
  assert.deepEqual(pullOnly.sessionWakeCount, { value: 0, direction: "down", count: 2 });
  assert.deepEqual(pullOnly.sessionContextGrowth, { value: 0, direction: "down", count: 2 });

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

test("metrics budget indicators are the governance projection, wrapped with their record counts", () => {
  const events = [
    { at: at(0), node: "a", to: "running", budgetDecision: { extensionAllowanceTokens: 500, inputs: { runtimeId: "glm" } } },
    { at: at(2), node: "a", to: "running", budgetAction: { type: "extension" } },
  ];
  const now = ms(10);
  const governance = deriveGovernanceMetrics({ events, now });
  const metrics = projectMetrics({ events, now });
  assert.deepEqual(metrics.budgetDecisionAge, { value: governance.budgetDecisionAge, direction: "down", count: 1 });
  assert.equal(metrics.budgetDecisionAge.value, 600);
  assert.deepEqual(metrics.budgetHeadroomAtDispatch, { value: 500, direction: "informative", count: 1 });
  assert.deepEqual(metrics.budgetExtensionRate, { value: governance.budgetExtensionRate, direction: "informative", count: 1 });
  assert.equal(metrics.budgetExtensionRate.value, 1);
  assert.deepEqual(metrics.continuationRate, { value: 0, direction: "informative", count: 1 });

  // No decision was recorded: age, headroom and both rates are missing rather
  // than an age of zero or a rate of zero.
  const undecided = projectMetrics({ events: lifecycleEvents(), now });
  for (const indicator of [
    undecided.budgetDecisionAge,
    undecided.budgetHeadroomAtDispatch,
    undecided.budgetExtensionRate,
    undecided.continuationRate,
  ]) {
    assert.deepEqual(indicator.value, null);
    assert.equal(indicator.count, 0);
  }
});

test("metrics budgetAttentionLatencyP95 pairs attention actions with their outbox record", () => {
  const events = [{ at: at(0), node: "a", to: "running", budgetAction: { type: "attention" } }];
  const outbox = [
    { type: "run.attention", at: at(0, 30), requiresUser: true, data: { code: "budget_attention", nodeId: "a" } },
  ];
  const metrics = projectMetrics({ events, outbox });
  assert.deepEqual(metrics.budgetAttentionLatencyP95, { value: 30, direction: "down", count: 1 });

  const unnotified = projectMetrics({ events });
  assert.deepEqual(unnotified.budgetAttentionLatencyP95, { value: null, direction: "down", count: 0 });
});

test("metrics silentStallRate holds its hard target of zero only where facts exist", () => {
  /** @param {string} stamp @returns {Record<string, unknown>} */
  const fact = (stamp) => ({ type: "liveness", eventId: stamp, at: stamp, state: "running" });

  // Two facts one supervisor interval apart: no gap exceeded staleSec, so the
  // hard target is met and the zero is measured.
  const healthy = projectMetrics({ journal: [fact(at(0)), fact(at(10))], staleSec: 2400 });
  assert.deepEqual(healthy.silentStallRate, { value: 0, direction: "down", count: 2 });

  // A gap past staleSec with no covering attention event is a silent stall.
  const stalled = projectMetrics({ journal: [fact(at(0)), fact(at(50))], staleSec: 600 });
  assert.deepEqual(stalled.silentStallRate, { value: 1, direction: "down", count: 2 });

  // The same gap covered by a stale_liveness notification is observed, not silent.
  const covered = projectMetrics({
    journal: [fact(at(0)), fact(at(50))],
    outbox: [{ type: "run.attention", at: at(30), requiresUser: true, data: { code: "stale_liveness" } }],
    staleSec: 600,
  });
  assert.equal(covered.silentStallRate.value, 0);

  // A campaign with no liveness fact has no stall measurement at all.
  assert.deepEqual(projectMetrics().silentStallRate, { value: null, direction: "down", count: 0 });
  assert.deepEqual(projectMetrics({ journal: [fact(at(0))] }).silentStallRate, { value: null, direction: "down", count: 0 });
});

test("metrics workerPreambleTokens is the mean measured preamble per runtime", () => {
  /** @param {string} runtimeId @param {number} preambleTokens @param {number} minute @returns {Record<string, unknown>} */
  const decision = (runtimeId, preambleTokens, minute) => ({
    at: at(minute),
    node: `n-${minute}`,
    to: "running",
    budgetDecision: { extensionAllowanceTokens: 0, inputs: { runtimeId, preambleBytes: preambleTokens * 4, preambleTokens } },
  });
  const metrics = projectMetrics({ events: [decision("glm", 1200, 0), decision("glm", 1400, 1), decision("deepseek-flash", 900, 2)] });
  assert.deepEqual(metrics.workerPreambleTokens, {
    value: { "deepseek-flash": 900, glm: 1300 },
    direction: "down",
    count: 3,
  });

  // A decision recorded without the preflight measurement leaves the indicator
  // missing rather than reporting a preamble of zero.
  const unmeasured = projectMetrics({ events: [{ at: at(0), node: "a", to: "running", budgetDecision: { extensionAllowanceTokens: 0 } }] });
  assert.deepEqual(unmeasured.workerPreambleTokens, { value: null, direction: "down", count: 0 });
});

test("metrics notifyLatencyP95 measures the outbox from projection to delivery", () => {
  const base = { type: "run.attention", campaignId: "c", requiresUser: true, data: {} };
  const metrics = projectMetrics({
    outbox: [
      { ...base, at: at(0), deliveredAt: at(0, 2) },
      { ...base, at: at(1), deliveredAt: at(1, 10) },
      { ...base, at: at(2), deliveredAt: null },
    ],
  });
  assert.deepEqual(metrics.notifyLatencyP95, { value: 10, direction: "down", count: 2 });

  // An outbox that was never drained still wakes the session, but has no
  // latency to report.
  const undelivered = projectMetrics({ outbox: [{ ...base, at: at(0), deliveredAt: null }] });
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
  const input = () => ({ events: lifecycleEvents(), usageLedger: usageLedger(), now });
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
 * `control-state.json`, its usage ledger reduced to each epoch's
 * `cacheReadWeight` and each invocation's input and cache-read tokens, all 89
 * transition events of its 18 linked runs reduced to the fields the projector
 * reads, its 90 notification records reduced likewise, and 3 of its 96 journal
 * entries — the two that bound the campaign and the retrospective that records
 * the baseline. The recorded journal holds no liveness fact, so the ambient
 * indicators are null here exactly as they were there. The document's own
 * `distilledFrom` block states what it was distilled from and what was kept;
 * projected over it, the indicators equal the ones projected over the campaign
 * tree itself. `.runs/` is never a test dependency: the test neither reads it
 * nor writes it.
 */
/**
 * @typedef {{
 *   distilledFrom: {campaignId: string, source: string},
 *   campaign: {id: string, closedAt: string, linkedRunIds: string[]},
 *   controlState: {runs: {id: string, kind: string}[]},
 *   usageLedger: unknown,
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
  writeFileSync(join(campaignPath, "control-state.json"), JSON.stringify(FIXTURE.controlState));
  writeFileSync(join(campaignPath, "usage-ledger.json"), JSON.stringify(FIXTURE.usageLedger));
  writeFileSync(join(campaignPath, "notification-outbox.json"), JSON.stringify(FIXTURE.outbox));
  writeFileSync(join(campaignPath, "journal.jsonl"), FIXTURE.journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  for (const [runId, events] of Object.entries(FIXTURE.runs)) {
    mkdirSync(join(cwd, ".runs", runId), { recursive: true });
    writeFileSync(join(cwd, ".runs", runId, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
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
  const weighted = /** @type {number} */ (metrics.weightedPerClosedCheckpoint.value) * closed;
  assert.ok(Math.abs(weighted - 4_770_000) < 30_000, `weighted input ${weighted} is not the recorded ~4.77M`);
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
  assert.match(lines[0], new RegExp(`${BASELINE_CAMPAIGN} · 18 runs \\(17 takes, 1 repair\\) · 89 events · 20 indicators`, "u"));
  for (const [name, indicator] of Object.entries(metrics)) {
    const line = lines.find((candidate) => candidate.startsWith(name));
    assert.ok(line, `${name} is missing from the report`);
    assert.match(line, new RegExp(`\\b${indicator.direction}\\b`, "u"), `${name} must print its direction`);
    assert.match(line, /· \d+ records?$/u, `${name} must print how many records it was measured from`);
    assert.ok(line.length <= 120, `${name} line is unbounded at ${line.length} chars`);
  }
  // Effectiveness and efficiency are never reported one without the other.
  assert.match(report, /firstPassGateRate\s+up\s+glm53-flash=0 sol-low=1 terra-medium=0/u);
  assert.match(report, /weightedPerClosedCheckpoint\s+down\s+1589132 tokens/u);
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
