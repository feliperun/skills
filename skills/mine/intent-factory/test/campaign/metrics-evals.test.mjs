import test from "node:test";
import assert from "node:assert/strict";

import { compareEvalReports, projectEvalIndicators } from "../../../../../evals/metrics.mjs";

/** @param {number} minute @param {number} [second] @returns {string} */
const at = (minute, second = 0) => new Date(Date.parse("2026-09-10T10:00:00.000Z") + (minute * 60 + second) * 1000).toISOString();

test("evals null vs zero", () => {
  const empty = projectEvalIndicators({ events: [], usageRecords: [] });
  // Every indicator with nothing recorded to support it is null, never 0,
  // even the rate-shaped indicators whose "0/0" would otherwise read as a
  // real, measured zero.
  assert.equal(empty.costPerClosedCheckpoint.value, null);
  assert.equal(empty.costPerClosedCheckpoint.count, 0);
  assert.equal(empty.firstPassGateRate.value, null);
  assert.equal(empty.judgeInvocationRate.value, null);
  assert.equal(empty.revisionsPerDone.value, null);
  assert.equal(empty.blockedContextRate.value, null);
  assert.equal(empty.wallClockPerClosedCheckpoint.value, null);
  assert.equal(empty.providerFailoverRate.value, null);
  assert.equal(empty.protocolFailureRate.value, null);

  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
  ];
  const usageRecords = [{ nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 0, costProvenance: "provider" }];
  const measured = projectEvalIndicators({ events, usageRecords });
  // With one closed checkpoint and one zero-cost invocation, the ratio is a
  // real measured 0, not a missing measurement: it must stay distinct from
  // the null case above rather than collapsing onto the same value.
  assert.equal(measured.costPerClosedCheckpoint.value, 0);
  assert.equal(measured.costPerClosedCheckpoint.count, 1);
  assert.notEqual(measured.costPerClosedCheckpoint.value, empty.costPerClosedCheckpoint.value);

  const comparison = compareEvalReports(empty, measured);
  // Comparing a null indicator against a measured number never yields a
  // numeric delta.
  assert.equal(comparison.costPerClosedCheckpoint.delta, null);
  assert.equal(comparison.costPerClosedCheckpoint.comparable, false);
  // Two measured zeros compare as a real, zero delta.
  const bothMeasured = compareEvalReports(measured, measured);
  assert.equal(bothMeasured.costPerClosedCheckpoint.delta, 0);
  assert.equal(bothMeasured.costPerClosedCheckpoint.comparable, true);
});

test("evals costPerClosedCheckpoint divides known-provenance cost by closed checkpoints, excluding open nodes", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(1) },
  ];
  const usageRecords = [
    { nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 4, costProvenance: "provider" },
    { nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 10, costProvenance: "unknown" },
  ];
  const report = projectEvalIndicators({ events, usageRecords });
  assert.deepEqual(report.costPerClosedCheckpoint, { value: 4, direction: "down", count: 1 });
});

test("evals firstPassGateRate groups by taskKind (the node id) and keys off the first recorded verdict", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "running", phase: "judge", runtime: "opus", verdict: "fail", at: at(1) },
    { node: "build", from: "running", to: "running", phase: "judge", runtime: "opus", verdict: "pass", at: at(2) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "opus", at: at(3) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "ship", from: "running", to: "running", phase: "judge", runtime: "opus", verdict: "pass", at: at(1) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "opus", at: at(2) },
  ];
  const report = projectEvalIndicators({ events, usageRecords: [] });
  assert.deepEqual(report.firstPassGateRate, { value: { build: 0, ship: 1 }, direction: "up", count: 2 });
});

test("evals blockedContextRate counts a blocked-context terminal transition among every terminal node, done or not", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "blocked", phase: "complete", runtime: "sonnet", at: at(1) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
  ];
  const report = projectEvalIndicators({ events, usageRecords: [] });
  assert.deepEqual(report.blockedContextRate, { value: 0.5, direction: "down", count: 2 });
});

test("evals providerFailoverRate counts a node whose worker phase ran on more than one runtime", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "primary", at: at(0) },
    { node: "build", from: "running", to: "running", phase: "worker", runtime: "backup", at: at(1) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "backup", at: at(2) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "primary", at: at(0) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "primary", at: at(1) },
  ];
  const report = projectEvalIndicators({ events, usageRecords: [] });
  assert.deepEqual(report.providerFailoverRate, { value: 0.5, direction: "down", count: 2 });
});

test("evals compareEvalReports reports a real numeric delta when both sides are measured", () => {
  const before = projectEvalIndicators({
    events: [
      { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
      { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    ],
    usageRecords: [{ nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 10, costProvenance: "provider" }],
  });
  const after = projectEvalIndicators({
    events: [
      { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
      { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    ],
    usageRecords: [{ nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 6, costProvenance: "provider" }],
  });
  const comparison = compareEvalReports(before, after);
  assert.deepEqual(comparison.costPerClosedCheckpoint, {
    before: { value: 10, count: 1 },
    after: { value: 6, count: 1 },
    direction: "down",
    delta: -4,
    comparable: true,
  });
});
