import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, orphan, withFakeCodex, writeContract } from "./helpers.mjs";
import { resumeRun, runContract } from "../scripts/runner.mjs";

/** @param {import("../scripts/runner.mjs").RunOutcome} result @param {string} [id] @returns {import("../scripts/contract.mjs").NodeSnapshot} */
function nodeState(result, id = "build") {
  const state = result.states.get(id);
  if (!state) throw new Error(`missing node state for ${id}`);
  return state;
}

/** @param {string} runDir @param {string} nodeId @returns {string|null} */
function workerStdoutLog(runDir, nodeId = "build") {
  const match = readdirSync(join(runDir, "logs")).filter((name) => name.startsWith(`${nodeId}.`) && name.endsWith(".worker.jsonl")).sort().at(-1);
  return match ? join(runDir, "logs", match) : null;
}

/**
 * Reopen the unknown_effect window left by a controller crash: withhold the
 * settlement and destroy the completed-turn proof so adoption cannot apply.
 *
 * @param {string} runDir @param {string} invocationId @param {string} nodeId
 */
function reopenCrashWindow(runDir, invocationId, nodeId = "build") {
  unlinkSync(join(runDir, "operations", `${invocationId}.settlement.json`));
  const stdout = workerStdoutLog(runDir, nodeId);
  assert.ok(stdout, "worker stdout log is missing");
  writeFileSync(stdout, "");
}

/**
 * Reopen the unknown_effect window but keep the provider thread evidence:
 * withhold the settlement and cut the stream down to the thread.started line
 * so adoption cannot apply while the provider receipt survives.
 *
 * @param {string} runDir @param {string} invocationId @param {string} nodeId
 */
function reopenCrashWindowKeepingThread(runDir, invocationId, nodeId = "build") {
  unlinkSync(join(runDir, "operations", `${invocationId}.settlement.json`));
  const stdout = workerStdoutLog(runDir, nodeId);
  assert.ok(stdout, "worker stdout log is missing");
  const started = readFileSync(stdout, "utf8").split("\n").find((line) => line.includes("thread.started"));
  assert.ok(started, "worker stdout log has no thread.started line");
  writeFileSync(stdout, `${started}\n`);
}

/** @returns {Record<string, unknown>} */
function usagePolicy() {
  return {
    epoch: "intent-settlement-test-v1",
    maxInputTokens: 1_000_000,
    judgeReserveInputTokens: 0,
    maxPhaseInputTokens: 500_000,
    maxInvocationTokens: 500_000,
    cacheReadWeight: 0.1,
  };
}

/** @param {{verification?: Array<{argv: string[]}>}} [overrides] @returns {Record<string, unknown>} */
function packetForFixture(overrides = {}) {
  return {
    mode: "execution",
    objective: "Implement it",
    instructions: ["Implement the requested behavior"],
    readFiles: ["README.md"],
    writeFiles: ["README.md"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: overrides.verification ?? [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(0)"] : ["true"] }],
  };
}

test("every provider invocation persists an intent before spawn and a settlement after the envelope closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-settle-"));
  const path = writeContract(directory, fixture({
    id: "intent-settle-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packetForFixture(), gate: { enabled: true } }],
  }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocations = nodeState(first).invocations ?? [];
  assert.ok(invocations.length >= 2, "expected worker and judge invocations");
  for (const invocation of invocations) {
    const intent = JSON.parse(readFileSync(join(runDir, "operations", `${invocation.id}.intent.json`), "utf8"));
    assert.equal(intent.operationId, invocation.id);
    assert.equal(intent.nodeId, "build");
    assert.equal(intent.role, invocation.role);
    assert.equal(intent.runId, "intent-settle-run");
    assert.match(intent.promptHash, /^[0-9a-f]{64}$/u);
    assert.equal(intent.promptFingerprint, intent.promptHash);
    assert.match(intent.runtimeFingerprint, /^[0-9a-f]{64}$/u);
    if (invocation.role === "worker") {
      assert.ok(intent.scopeSnapshotPath, "worker intents must reference the scope snapshot");
    }
    const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocation.id}.settlement.json`), "utf8"));
    assert.ok(Array.isArray(settlement.receipts));
    assert.ok(settlement.receipts.length >= 3);
    assert.equal(typeof settlement.nextState?.status, "string");
    assert.equal(typeof settlement.nextState?.phase, "string");
  }
});

test("an intent withheld from settlement classifies unknown_effect and resolves through adoption proof exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-adopt-"));
  const policy = usagePolicy();
  const path = writeContract(directory, fixture({ id: "intent-adopt-run", pollIntervalMs: 10, usagePolicy: policy }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);

  unlinkSync(join(runDir, "operations", `${invocationId}.settlement.json`));
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "adopted");
  assert.equal(settlement.unknownEffect, true);
  assert.equal(settlement.classification, "unknown_effect");
  assert.ok(
    settlement.receipts.some((/** @type {{kind: string, ref: string}} */ receipt) => receipt.kind === "provider" && receipt.ref === "fake-thread"),
    "the adopted settlement from a controller-loss window must persist the provider receipt",
  );

  // The completed-turn log proved the effect; usage stays exact-once.
  const ledgerPath = join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json");
  const recorded = Object.keys(JSON.parse(readFileSync(ledgerPath, "utf8")).epochs[/** @type {string} */ (policy.epoch)].invocations);
  assert.equal(recorded.filter((id) => id === invocationId).length, 1);

  // A further resume must not duplicate anything.
  await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const reread = JSON.parse(readFileSync(ledgerPath, "utf8")).epochs[/** @type {string} */ (policy.epoch)].invocations;
  assert.deepEqual(Object.keys(reread).sort(), [...recorded].sort());
});

test("the first terminal settlement from a scope failure persists provider receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-scope-receipts-"));
  const path = writeContract(directory, fixture({
    id: "intent-scope-receipts-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packetForFixture(), gate: false }],
  }));
  const first = await withFakeCodex(directory, "write-unexpected", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const state = nodeState(first);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  const invocationId = state.invocations?.at(-1)?.id;
  assert.ok(invocationId);
  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "failed");
  assert.ok(
    settlement.receipts.some((/** @type {{kind: string, ref: string}} */ receipt) => receipt.kind === "provider" && receipt.ref === "fake-thread"),
    "the scope-failure settlement must persist the provider receipt from the close path",
  );
  assert.ok(settlement.receipts.some((/** @type {{kind: string, ref: string}} */ receipt) => receipt.kind === "stdout"));
});

test("a controller-loss safe replay settlement persists the provider receipt from the surviving stream tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-tail-receipts-"));
  const path = writeContract(directory, fixture({ id: "intent-tail-receipts-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindowKeepingThread(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 2, "the fresh replay attempt must be a new attempt");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "safe_replay");
  assert.ok(
    settlement.receipts.some((/** @type {{kind: string, ref: string}} */ receipt) => receipt.kind === "provider" && receipt.ref === "fake-thread"),
    "the safe replay settlement from a controller-loss window must persist the provider receipt from the surviving tail",
  );

  // Repeated recovery stays idempotent: the resolution is never re-run and no
  // provider attempt is duplicated.
  const resumedAgain = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  assert.equal(nodeState(resumedAgain).invocations?.length, 2, "recovery must not spawn a duplicate attempt");
  const reread = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.deepEqual(reread, settlement);
});

test("a controller-loss reconciled settlement persists the provider receipt from the surviving stream tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-reconcile-tail-receipts-"));
  const failingVerification = [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(1)"] : ["false"] }];
  const path = writeContract(directory, fixture({
    id: "intent-reconcile-tail-receipts-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packetForFixture({ verification: failingVerification }), gate: false }],
  }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindowKeepingThread(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "unknown_effect_reconciled");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "reconciled");
  assert.ok(
    settlement.receipts.some((/** @type {{kind: string, ref: string}} */ receipt) => receipt.kind === "provider" && receipt.ref === "fake-thread"),
    "the reconciled settlement from a controller-loss window must persist the provider receipt from the surviving tail",
  );
});

test("safe replay retries exactly once after deterministic verification passes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-replay-"));
  const path = writeContract(directory, fixture({ id: "intent-safe-replay-run", pollIntervalMs: 10 }));
  // The ambiguous window must prove replay cannot duplicate effects: a worker
  // that wrote nothing leaves the declared workspace untouched.
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 2, "the fresh replay attempt must be a new attempt");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "safe_replay");
  const override = (state.executionOverrides ?? []).find((item) => /** @type {Record<string, unknown>} */ (item).decision === "safe_replay");
  assert.ok(override, "safe replay decision must be recorded durably");

  // The replay attempt itself settles normally when its envelope closes.
  const replayId = state.invocations?.at(-1)?.id;
  assert.ok(replayId && replayId !== invocationId);
  assert.ok(existsSync(join(runDir, "operations", `${replayId}.settlement.json`)));
});

test("declared workspace writes across the ambiguous window reconcile instead of safe replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-declared-write-"));
  const path = writeContract(directory, fixture({ id: "intent-declared-write-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "write-allowed", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  assert.equal(nodeState(first).status, "done");
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "unknown_effect_reconciled");
  assert.match(String(state.error?.message), /duplicate effects/u);
  assert.equal(state.attempt, 1, "a declared write in the window must not schedule a duplicate replay attempt");
  assert.equal(state.invocations?.length, 1, "reconciliation must not spawn a provider attempt");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "reconciled");
  assert.equal(settlement.unknownEffect, true);
});

test("a persisted worker checkpoint is adopted when the provider stream is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-checkpoint-"));
  const path = writeContract(directory, fixture({ id: "intent-checkpoint-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const state = nodeState(first);
  const invocationId = state.invocations?.at(-1)?.id;
  assert.ok(invocationId);
  assert.ok(state.result);
  unlinkSync(join(runDir, "operations", `${invocationId}.settlement.json`));
  const stdout = workerStdoutLog(runDir);
  assert.ok(stdout);
  writeFileSync(stdout, "");
  orphan(runDir, "build", { result: state.result });

  const resumed = await withFakeCodex(directory, "worker-fail", async () => resumeRun(runDir));
  const recovered = nodeState(resumed);
  assert.equal(recovered.status, "done");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.invocations?.length, 1, "checkpoint adoption must not spawn a duplicate provider attempt");
  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "adopted");
  assert.equal(settlement.unknownEffect, true);
});

test("reconcile surfaces a durable blocked finding when deterministic verification fails across the ambiguous window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-reconcile-"));
  const failingVerification = [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(1)"] : ["false"] }];
  const path = writeContract(directory, fixture({
    id: "intent-reconcile-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packetForFixture({ verification: failingVerification }), gate: false }],
  }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "unknown_effect_reconciled");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "reconciled");
  assert.equal(settlement.unknownEffect, true);

  const findings = JSON.parse(readFileSync(join(runDir, "findings.json"), "utf8"));
  const findingNode = /** @type {{id: string, error?: {code?: string}}|undefined} */ (/** @type {{nodes: {id: string}[]}} */ (findings).nodes.find((entry) => entry.id === "build"));
  assert.equal(findingNode?.error?.code, "unknown_effect_reconciled");

  const resumedAgain = await withFakeCodex(directory, "worker-fail", async () => resumeRun(runDir));
  assert.equal(nodeState(resumedAgain).status, "blocked");
  assert.equal(nodeState(resumedAgain).invocations?.length, 1, "reconciled effects must not be replayed on a later resume");
});

test("replayPolicy never forces the reconcile outcome without an automatic retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intent-never-"));
  const path = writeContract(directory, fixture({
    id: "intent-never-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", replayPolicy: "never", taskPacket: packetForFixture(), gate: false }],
  }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", async () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "unknown_effect_reconciled");
  assert.match(String(state.error?.message), /replayPolicy never/u);
  assert.equal(state.attempt, 1, "replayPolicy never must not schedule a fresh attempt");
  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "reconciled");
});
