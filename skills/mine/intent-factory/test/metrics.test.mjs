import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMetricsJson, renderMetricsReport } from "../scripts/metrics-report.mjs";
import { projectMetrics, readMetricsSources } from "../scripts/metrics.mjs";

/** Every indicator of TECH-SPEC lean section 6 with the direction the spec table gives it. */
const DIRECTIONS = {
  nodesDoneRate: "up",
  linkedRunsPerClosedCheckpoint: "down",
  runsPerCampaign: "down",
  wallClockSec: "down",
  usageTokensByKind: "informative",
  usageTokensByKindByRuntime: "informative",
  usageCostUsd: "down",
  blockingJudgeFirstPassRate: "up",
  notifyReceiptRate: "up",
  silentStallRate: "down",
};

/** @param {number} minute @param {number} [second] @returns {string} */
const at = (minute, second = 0) => new Date(Date.parse("2026-09-04T10:00:00.000Z") + (minute * 60 + second) * 1000).toISOString();

/**
 * @param {string} runId @param {string} node @param {string} to
 * @param {{at: string, phase?: string, runtime?: string, verdict?: string}} rest
 * @returns {Record<string, unknown>}
 */
const event = (runId, node, to, rest) => ({ runId, node, to, ...rest });

test("metrics nodesDoneRate is done-at-any-attempt over terminal logical nodes, censoring the rest", () => {
  const nodes = [
    { runId: "r1", id: "a", status: "done" },
    { runId: "r1", id: "b", status: "failed" },
    { runId: "r1", id: "c", status: "pending" },
    { runId: "r1", id: "d", status: "running" },
  ];
  const metrics = projectMetrics({ nodes });
  // Two terminal logical nodes (a, b); c and d are still open and are
  // censored rather than counted as failures.
  assert.deepEqual(metrics.nodesDoneRate, { value: 0.5, direction: "up", count: 2 });

  assert.deepEqual(projectMetrics({ nodes: [{ runId: "r1", id: "a", status: "pending" }] }).nodesDoneRate, {
    value: null,
    direction: "up",
    count: 0,
  });
});

test("metrics nodesDoneRate treats the same id in two runs as two logical nodes", () => {
  const nodes = [
    { runId: "take1", id: "build", status: "failed" },
    { runId: "take2", id: "build", status: "done" },
  ];
  const metrics = projectMetrics({ nodes });
  assert.deepEqual(metrics.nodesDoneRate, { value: 0.5, direction: "up", count: 2 });
});

test("metrics linkedRunsPerClosedCheckpoint divides runs by distinct closed node ids", () => {
  const nodes = [
    { runId: "take1", id: "build", status: "failed" },
    { runId: "take2", id: "build", status: "done" },
    { runId: "take2", id: "ship", status: "done" },
  ];
  const metrics = projectMetrics({ nodes });
  // Two runs over two checkpoints that closed (build, ship): 2 / 2 = 1, even
  // though build needed a second run to land.
  assert.deepEqual(metrics.linkedRunsPerClosedCheckpoint, { value: 1, direction: "down", count: 2 });

  const noneClosed = projectMetrics({ nodes: [{ runId: "take1", id: "build", status: "failed" }] });
  assert.deepEqual(noneClosed.linkedRunsPerClosedCheckpoint, { value: null, direction: "down", count: 0 });
});

test("metrics runsPerCampaign counts distinct run ids across nodes and events", () => {
  const nodes = [{ runId: "take1", id: "build", status: "done" }];
  const events = [event("take2", "ship", "running", { at: at(0) })];
  assert.deepEqual(projectMetrics({ nodes, events }).runsPerCampaign, { value: 2, direction: "down", count: 2 });
  assert.deepEqual(projectMetrics().runsPerCampaign, { value: null, direction: "down", count: 0 });
});

test("metrics wallClockSec spans the earliest to the latest timestamped event", () => {
  const events = [event("r1", "a", "running", { at: at(0) }), event("r1", "a", "done", { at: at(30) })];
  assert.deepEqual(projectMetrics({ events }).wallClockSec, { value: 1800, direction: "down", count: 2 });
  assert.deepEqual(projectMetrics({ events: [event("r1", "a", "running", { at: at(0) })] }).wallClockSec, {
    value: null,
    direction: "down",
    count: 0,
  });
});

test("metrics usageTokensByKind and usageTokensByKindByRuntime sum every linked run's usage.jsonl", () => {
  const usageRecords = [
    { runtimeId: "glm", inputTokens: 1000, cacheReadInputTokens: 2000, outputTokens: 5, costUsd: 0.01, costProvenance: "provider" },
    { runtimeId: "sonnet", inputTokens: 800, cacheReadInputTokens: 0, outputTokens: 3, costUsd: 0.02, costProvenance: "provider" },
  ];
  const metrics = projectMetrics({ usageRecords });
  assert.deepEqual(metrics.usageTokensByKind, {
    value: { inputTokens: 1800, cacheReadInputTokens: 2000, outputTokens: 8 },
    direction: "informative",
    count: 2,
  });
  assert.deepEqual(metrics.usageTokensByKindByRuntime, {
    value: {
      "glm.inputTokens": 1000,
      "glm.cacheReadInputTokens": 2000,
      "glm.outputTokens": 5,
      "sonnet.inputTokens": 800,
      "sonnet.cacheReadInputTokens": 0,
      "sonnet.outputTokens": 3,
    },
    direction: "informative",
    count: 2,
  });

  const empty = projectMetrics({ usageRecords: [] });
  assert.deepEqual(empty.usageTokensByKind, { value: null, direction: "informative", count: 0 });
  assert.deepEqual(empty.usageTokensByKindByRuntime, { value: null, direction: "informative", count: 0 });
});

test("metrics usageCostUsd sums only priced records and counts unknown provenance separately", () => {
  const usageRecords = [
    { runtimeId: "glm", inputTokens: 1, costUsd: 1.5, costProvenance: "provider" },
    { runtimeId: "glm", inputTokens: 1, costUsd: null, costProvenance: "unknown" },
  ];
  const metrics = projectMetrics({ usageRecords });
  assert.deepEqual(metrics.usageCostUsd, { value: 1.5, direction: "down", count: 1, unknownCount: 1 });

  const allUnknown = projectMetrics({ usageRecords: [{ inputTokens: 1, costUsd: null, costProvenance: "unknown" }] });
  assert.deepEqual(allUnknown.usageCostUsd, { value: null, direction: "down", count: 0, unknownCount: 1 });
});

test("metrics blockingJudgeFirstPassRate is measured only over blocking-reviewed nodes, per judge runtime", () => {
  const nodes = [
    { runId: "r1", id: "g1", status: "done", review: "blocking" },
    { runId: "r1", id: "g2", status: "blocked", review: "advisory" },
  ];
  const events = [
    event("r1", "g1", "running", { at: at(0), phase: "judge", runtime: "glm", verdict: "fail" }),
    event("r1", "g1", "done", { at: at(5), phase: "judge", runtime: "glm", verdict: "pass" }),
    // g2 is advisory: its own failing first verdict never counts toward the
    // indicator, however the campaign's blocking gates fared.
    event("r1", "g2", "blocked", { at: at(3), phase: "judge", runtime: "glm", verdict: "fail" }),
  ];
  const metrics = projectMetrics({ nodes, events });
  assert.deepEqual(metrics.blockingJudgeFirstPassRate, { value: { glm: 0 }, direction: "up", count: 1 });

  const noBlocking = projectMetrics({ nodes: [{ runId: "r1", id: "g2", status: "done", review: "advisory" }], events });
  assert.deepEqual(noBlocking.blockingJudgeFirstPassRate, { value: null, direction: "up", count: 0 });
});

test("metrics notifyReceiptRate counts a dedupeKey settled within 60s as satisfied", () => {
  const notifications = [
    { dedupeKey: "node.terminal:r:a:done:1:0", attempt: 1, status: "delivered", at: at(0) },
    // No transport bound settles on the first attempt too.
    { dedupeKey: "node.terminal:r:b:done:1:0", attempt: 1, status: "no_transport", at: at(0) },
    // Failed all three tries, but the third lands inside the 60s window.
    { dedupeKey: "node.terminal:r:c:failed:1:0", attempt: 1, status: "failed", at: at(0) },
    { dedupeKey: "node.terminal:r:c:failed:1:0", attempt: 2, status: "failed", at: at(0, 20) },
    { dedupeKey: "node.terminal:r:c:failed:1:0", attempt: 3, status: "failed", at: at(0, 55) },
    // Delivered, but past the 60s target.
    { dedupeKey: "node.terminal:r:d:done:1:0", attempt: 1, status: "failed", at: at(0) },
    { dedupeKey: "node.terminal:r:d:done:1:0", attempt: 2, status: "delivered", at: at(1, 5) },
    // Never settles at all: retried once and abandoned mid-run.
    { dedupeKey: "node.terminal:r:e:done:1:0", attempt: 1, status: "failed", at: at(0) },
  ];
  const metrics = projectMetrics({ notifications });
  assert.deepEqual(metrics.notifyReceiptRate, { value: 0.6, direction: "up", count: 5 });

  assert.deepEqual(projectMetrics().notifyReceiptRate, { value: null, direction: "up", count: 0 });
});

test("metrics silentStallRate is stalled logical nodes per active run-hour", () => {
  const nodes = [
    { runId: "r1", id: "a", status: "stalled" },
    { runId: "r1", id: "b", status: "done" },
  ];
  const events = [
    // One closed hour of active time on `a`.
    event("r1", "a", "running", { at: at(0) }),
    event("r1", "a", "stalled", { at: at(60) }),
    // A trailing open interval on `b` is not counted: it never closed.
    event("r1", "b", "running", { at: at(70) }),
  ];
  const metrics = projectMetrics({ nodes, events });
  assert.deepEqual(metrics.silentStallRate, { value: 1, direction: "down", count: 1 });

  const noActiveTime = projectMetrics({ nodes: [{ runId: "r1", id: "a", status: "stalled" }] });
  assert.deepEqual(noActiveTime.silentStallRate, { value: null, direction: "down", count: 0 });
});

test("metrics projects every indicator of section 6, null and never zero without records", () => {
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
  assert.deepEqual(metrics.usageCostUsd.unknownCount, 0, "usageCostUsd reports zero unknown invocations without records");
});

test("metrics projection is pure: identical records yield identical indicators", () => {
  const nodes = [{ runId: "r1", id: "a", status: "done" }];
  const events = [event("r1", "a", "running", { at: at(0) }), event("r1", "a", "done", { at: at(5) })];
  const input = () => ({ nodes, events, now: Date.now() });
  assert.deepEqual(projectMetrics(input()), projectMetrics(input()));
  const before = JSON.stringify(events);
  projectMetrics({ events });
  assert.equal(JSON.stringify(events), before, "the projector must not mutate its input");
});

/**
 * Baseline reproduction of this campaign's own recorded runs.
 *
 * `fixtures/lean-campaign-baseline/` is one bounded reduction of
 * `intent-factory-lean-20260905` distilled from `.runs/campaigns/` and every
 * one of its linked runs (read-only, taken 2026-09-08): `campaign.json`'s id
 * and linked run ids, and per run the persisted node snapshots reduced to
 * `id`/`status`/`attempt`/`revisions`/`review`, the transition events reduced
 * to `at`/`node`/`to`/`phase`/`runtime`/`verdict`, and the `usage.jsonl` and
 * `notify.jsonl` records verbatim (already bounded, counters and identifiers
 * only). No prompt, log, worker result or secret is in it. `.runs/` is never
 * a test dependency: the test neither reads it nor writes it.
 */
const FIXTURE_DIR = fileURLToPath(new URL("fixtures/lean-campaign-baseline", import.meta.url));
/** @typedef {{campaign: {id: string, goal: string, status: string, linkedRunIds: string[]}}} BaselineCampaign */
const CAMPAIGN_DOC = /** @type {BaselineCampaign} */ (JSON.parse(readFileSync(join(FIXTURE_DIR, "campaign.json"), "utf8")));
const BASELINE_CAMPAIGN = CAMPAIGN_DOC.campaign.id;
const RUNNER = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));

/** @type {string|null} */
let materialized = null;

/**
 * The distilled campaign laid out on disk the way the CLI reads it, under a
 * temporary `.runs/`, so the command and the readers behind it are exercised
 * end to end without the repository's own run directory.
 *
 * @returns {string}
 */
function baselineWorkspace() {
  if (materialized !== null) return materialized;
  const cwd = mkdtempSync(join(tmpdir(), "metrics-baseline-"));
  const campaignPath = join(cwd, ".runs", "campaigns", BASELINE_CAMPAIGN);
  mkdirSync(campaignPath, { recursive: true });
  writeFileSync(join(campaignPath, "campaign.json"), JSON.stringify(CAMPAIGN_DOC.campaign));
  for (const runId of CAMPAIGN_DOC.campaign.linkedRunIds) {
    const runFixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "runs", `${runId}.json`), "utf8"));
    const runDir = join(cwd, ".runs", runId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), runFixture.events.map((/** @type {unknown} */ record) => `${JSON.stringify(record)}\n`).join(""));
    writeFileSync(join(runDir, "usage.jsonl"), runFixture.usage.map((/** @type {unknown} */ record) => `${JSON.stringify(record)}\n`).join(""));
    writeFileSync(join(runDir, "notify.jsonl"), runFixture.notify.map((/** @type {unknown} */ record) => `${JSON.stringify(record)}\n`).join(""));
    for (const node of runFixture.nodes) writeFileSync(join(runDir, "nodes", `${node.id}.json`), JSON.stringify(node));
  }
  materialized = cwd;
  return cwd;
}

/** @returns {ReturnType<typeof readMetricsSources>} */
function baselineSources() {
  const cwd = baselineWorkspace();
  return readMetricsSources(join(cwd, ".runs", "campaigns", BASELINE_CAMPAIGN), { runsDir: join(cwd, ".runs") });
}

test("metrics baseline fixture declares the campaign it was distilled from", () => {
  assert.equal(CAMPAIGN_DOC.campaign.id, BASELINE_CAMPAIGN);
  assert.ok(CAMPAIGN_DOC.campaign.linkedRunIds.length > 0, "the distilled campaign links at least one run");
});

test("metrics baseline reproduces this campaign's own recorded runs", () => {
  const sources = baselineSources();
  assert.equal(sources.runIds.length, 29, "the campaign linked twenty-nine runs at the time this baseline was taken");
  const metrics = projectMetrics(sources);
  // Pinned from a real projection over the fixture above: change the fixture
  // deliberately, or not at all.
  assert.deepEqual(metrics.nodesDoneRate, { value: 0.1667, direction: "up", count: 54 });
  assert.deepEqual(metrics.linkedRunsPerClosedCheckpoint, { value: 3.2222, direction: "down", count: 9 });
  assert.deepEqual(metrics.runsPerCampaign, { value: 29, direction: "down", count: 29 });
  assert.deepEqual(metrics.wallClockSec, { value: 234235.193, direction: "down", count: 181 });
  assert.deepEqual(metrics.usageTokensByKind, {
    value: { inputTokens: 2179645, cacheReadInputTokens: 365884969, outputTokens: 916437 },
    direction: "informative",
    count: 9,
  });
  assert.deepEqual(metrics.usageCostUsd, { value: 89.8846, direction: "down", count: 6, unknownCount: 3 });
  assert.deepEqual(metrics.blockingJudgeFirstPassRate, { value: { luna: 0, sol: 1 }, direction: "up", count: 2 });
  assert.deepEqual(metrics.notifyReceiptRate, { value: 1, direction: "up", count: 11 });
  assert.deepEqual(metrics.silentStallRate, { value: 0.0906, direction: "down", count: 100 });
});

test("metrics baseline report prints every indicator with its value and direction", () => {
  const sources = baselineSources();
  const metrics = projectMetrics(sources);
  const report = renderMetricsReport(sources, metrics);
  const lines = report.trimEnd().split("\n");
  assert.equal(lines.length, Object.keys(metrics).length + 1, "one header plus one line per indicator");
  assert.match(lines[0], new RegExp(`${BASELINE_CAMPAIGN} · 29 runs · 181 events · 10 indicators`, "u"));
  for (const [name, indicator] of Object.entries(metrics)) {
    const line = lines.find((candidate) => candidate.startsWith(name));
    assert.ok(line, `${name} is missing from the report`);
    assert.match(line, new RegExp(`\\b${indicator.direction}\\b`, "u"), `${name} must print its direction`);
    assert.match(line, /· \d+ records?(?: · \d+ unknown)?$/u, `${name} must print how many records it was measured from`);
    assert.ok(line.length <= 140, `${name} line is unbounded at ${line.length} chars`);
  }
  assert.match(report, /usageCostUsd\s+down\s+89\.8846\s+· 6 records · 3 unknown/u);
});

test("metrics command projects a campaign from its recorded artefacts", () => {
  const cwd = baselineWorkspace();
  const sources = baselineSources();
  const expected = renderMetricsJson(sources, projectMetrics(sources));
  const json = spawnSync(process.execPath, [RUNNER, "metrics", BASELINE_CAMPAIGN, "--cwd", cwd, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, expected);
  const machine = JSON.parse(json.stdout);
  assert.equal(machine.schemaVersion, 2);
  assert.deepEqual({ runs: machine.runs, events: machine.events }, { runs: 29, events: 181 });
  const report = spawnSync(process.execPath, [RUNNER, "metrics", BASELINE_CAMPAIGN, "--cwd", cwd], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.stdout, renderMetricsReport(sources, projectMetrics(sources)));
  const unknown = spawnSync(process.execPath, [RUNNER, "metrics", "no-such-campaign", "--cwd", cwd], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /campaign not found/u);
});
