import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { closeResult, fixture, orphan, packet, withFakeCodex, writeContract } from "./helpers.mjs";
import { renderStatus, renderStatusJson } from "../scripts/render.mjs";
import { handoffRun, resumeRun, runContract } from "../scripts/runner.mjs";
import { buildCapsule } from "../scripts/capsule.mjs";
import { acquireControllerLease } from "../scripts/store.mjs";

const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));

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
 * @template T
 * @param {Record<string, string|undefined>} values
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function withEnv(values, body) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Self-contained provider fake for either harness. Every received prompt is
 * appended to `logPath` so tests can inspect the composed handoff prompt.
 *
 * @param {"codex"|"claude"} driver
 * @param {string} logPath
 * @returns {string}
 */
function fakeProvider(driver, logPath) {
  const path = join(mkdtempSync(join(tmpdir(), `runner-fake-${driver}-handoff-`)), `fake-${driver}.mjs`);
  const codex = driver === "codex";
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log(${JSON.stringify(`fake-${driver} 1.0.0`)});
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ driver: ${JSON.stringify(driver)}, argv: process.argv.slice(1), prompt: input }) + "\\n");
    const judge = input.startsWith("Review node");
    const text = judge
      ? JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] })
      : JSON.stringify({ status: "done", summary: "continued on the new harness", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
${codex ? `    console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 1 } }));` : `    console.log(JSON.stringify({ type: "result", result: text, session_id: "fake-session", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1 }, total_cost_usd: 0 }));`}
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Run the `handoff` CLI subcommand against a run directory.
 *
 * @param {string} runDir @param {{node: string, runtime: string, reason?: string}} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
async function handoffCli(runDir, options) {
  const args = [runner, "handoff", runDir, "--node", options.node, "--runtime", options.runtime];
  if (options.reason) args.push("--reason", options.reason);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const result = await closeResult(child);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} logPath @param {"codex"|"claude"} driver @returns {{driver: string, prompt: string, argv: string[]}[]} */
function readPrompts(logPath, driver) {
  return readFileSync(logPath, "utf8").trim().split("\n")
    .map((line) => /** @type {{driver: string, prompt: string, argv: string[]}} */ (JSON.parse(line)))
    .filter((entry) => entry.driver === driver);
}

test("handoff routes the next worker attempt to claude and composes its prompt from the capsule", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-to-claude-"));
  const promptLog = join(mkdtempSync(join(tmpdir(), "runner-handoff-prompts-")), "prompts.jsonl");
  const codexBin = fakeProvider("codex", promptLog);
  const claudeBin = fakeProvider("claude", promptLog);
  const path = writeContract(directory, fixture({ id: "handoff-to-claude-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  assert.equal(nodeState(first).status, "done");

  // Reopen the unknown_effect window while the node still holds its settled
  // result, record the handoff, then mark it orphaned so the resume must replay.
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);

  const cli = await handoffCli(runDir, { node: "build", runtime: "opus", reason: "prefer the claude harness for this node" });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /\[handoff\] node build → opus/u);
  assert.match(cli.stdout, /capsule .*capsules.*build\.1\.json/u);

  const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(state.routing.currentOverride.role, "worker");
  assert.equal(state.routing.currentOverride.runtime, "opus");
  assert.match(state.routing.currentOverride.reason, /claude harness/u);
  assert.equal(state.routing.history.at(-1)?.runtime, "luna");
  assert.equal(state.routing.history.at(-1)?.nextRuntime, "opus");
  const handoffCapsule = JSON.parse(readFileSync(join(runDir, "capsules", "build.1.json"), "utf8"));
  assert.equal(handoffCapsule.nextAction, "prefer the claude harness for this node");
  assert.match(handoffCapsule.continuationHint, /handoff from luna to opus/u);

  const statusPayload = JSON.parse(renderStatusJson(runDir));
  const listed = /** @type {{id: string, pendingHandoff: {runtime: string, reason: string}|null}} */ (statusPayload.nodes.find((/** @type {{id: string}} */ entry) => entry.id === "build"));
  assert.equal(listed.pendingHandoff?.runtime, "opus");
  assert.match(renderStatus(runDir), /handoff→opus/u);

  orphan(runDir, "build");
  const resumed = await withEnv({ PLAN_RUNNER_CODEX_BIN: codexBin, PLAN_RUNNER_CLAUDE_BIN: claudeBin }, () => resumeRun(runDir));
  const replayed = nodeState(resumed);
  assert.equal(replayed.status, "done");
  assert.equal(replayed.attempt, 2, "the cross-harness replay must be a fresh attempt");
  const handoffInvocation = replayed.invocations?.at(-1);
  assert.equal(handoffInvocation?.runtimeId, "opus");
  assert.equal(handoffInvocation?.driver, "claude");
  assert.equal(handoffInvocation?.continuationMode, "fresh");

  const capsuleFile = JSON.parse(readFileSync(join(runDir, "capsules", "build.1.json"), "utf8"));
  const claudePrompts = readPrompts(promptLog, "claude").filter((entry) => entry.prompt.includes("Continue node build"));
  assert.ok(claudePrompts.length >= 1, "the replayed worker must receive exactly one capsule-composed prompt");
  const prompt = claudePrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Portable continuation capsule \(digest /u);
  assert.ok(prompt.includes(String(capsuleFile.digest)), "the prompt must carry the persisted capsule digest");
  assert.ok(prompt.includes("Implement it"), "the prompt must carry the capsule objective");
  assert.ok(!prompt.includes("worker complete"), "the prompt must not leak prior transcript summaries");

  const settlement = JSON.parse(readFileSync(join(runDir, "operations", `${invocationId}.settlement.json`), "utf8"));
  assert.equal(settlement.status, "safe_replay");
});

test("handoff routes the next worker attempt back to codex symmetrically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-to-codex-"));
  const promptLog = join(mkdtempSync(join(tmpdir(), "runner-handoff-prompts-codex-")), "prompts.jsonl");
  const codexBin = fakeProvider("codex", promptLog);
  const claudeBin = fakeProvider("claude", promptLog);
  const path = writeContract(directory, fixture({
    id: "handoff-to-codex-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "opus", judge: "sol" },
  }));
  const first = await withEnv({ PLAN_RUNNER_CLAUDE_BIN: claudeBin }, () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  assert.equal(nodeState(first).status, "done");
  assert.equal(nodeState(first).invocations?.at(-1)?.driver, "claude");

  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);

  const cli = await handoffCli(runDir, { node: "build", runtime: "luna" });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /node build → luna/u);

  orphan(runDir, "build");
  const resumed = await withEnv({ PLAN_RUNNER_CODEX_BIN: codexBin, PLAN_RUNNER_CLAUDE_BIN: claudeBin }, () => resumeRun(runDir));
  const replayed = nodeState(resumed);
  assert.equal(replayed.status, "done");
  assert.equal(replayed.attempt, 2);
  const handoffInvocation = replayed.invocations?.at(-1);
  assert.equal(handoffInvocation?.runtimeId, "luna");
  assert.equal(handoffInvocation?.driver, "codex");
  assert.equal(handoffInvocation?.continuationMode, "fresh");

  const codexPrompts = readPrompts(promptLog, "codex").filter((entry) => entry.prompt.includes("Continue node build"));
  assert.ok(codexPrompts.length >= 1, "the replayed codex worker must receive a capsule-composed prompt");
  assert.match(codexPrompts.at(-1)?.prompt ?? "", /Portable continuation capsule \(digest /u);
});

test("handoff keeps a same-runtime replay fresh and schedules it on resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-same-runtime-"));
  const promptLog = join(mkdtempSync(join(tmpdir(), "runner-handoff-prompts-same-")), "prompts.jsonl");
  const codexBin = fakeProvider("codex", promptLog);
  const path = writeContract(directory, fixture({ id: "handoff-same-runtime-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;

  const cli = await handoffCli(runDir, { node: "build", runtime: "luna", reason: "fresh same-runtime review" });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /digest [0-9a-f]{64}/u);
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).status, "pending");

  const resumed = await withEnv({ PLAN_RUNNER_CODEX_BIN: codexBin }, () => resumeRun(runDir));
  const replayed = nodeState(resumed);
  assert.equal(replayed.status, "done");
  assert.equal(replayed.attempt, 2);
  assert.equal(replayed.invocations?.at(-1)?.continuationMode, "fresh");
  const prompts = readPrompts(promptLog, "codex").filter((entry) => entry.prompt.includes("Continue node build"));
  assert.match(prompts.at(-1)?.prompt ?? "", /Portable continuation capsule \(digest /u);
  assert.ok(!prompts.at(-1)?.argv?.includes("resume"));
});

test("handoff refuses a reconciled unknown-effect checkpoint even with a durable capsule", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-reconciled-"));
  const failingVerification = [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(1)"] : ["false"] }];
  const path = writeContract(directory, fixture({
    id: "handoff-reconciled-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: failingVerification }), gate: false }],
  }));
  const first = await withFakeCodex(directory, "pass", () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "blocked");
  assert.equal(nodeState(resumed).error?.code, "unknown_effect_reconciled");

  // A stale durable capsule must not make the reconciled checkpoint handoff-able.
  mkdirSync(join(runDir, "capsules"), { recursive: true });
  const staleCapsule = buildCapsule({
    runId: basename(runDir),
    nodeId: "build",
    attemptId: "build.1",
    objective: "stale reconciled capsule",
    constraints: [],
    decisions: [],
    nonGoals: [],
    changedFiles: [],
    worktreeIdentity: { gitHead: null, dirty: false },
    receipts: [],
    verifications: [],
    artifacts: [],
    blockers: [],
    nextAction: "stale",
    usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null },
    costUsd: null,
    budgetRemaining: null,
    continuationHint: null,
  });
  writeFileSync(join(runDir, "capsules", "build.1.json"), JSON.stringify(staleCapsule));

  const cli = await handoffCli(runDir, { node: "build", runtime: "opus" });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /reconciled/u);
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).status, "blocked");
});

test("handoff refuses a reconciled settlement even when the node status is not blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-reconciled-state-"));
  const failingVerification = [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(1)"] : ["false"] }];
  const path = writeContract(directory, fixture({
    id: "handoff-reconciled-state-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: failingVerification }), gate: false }],
  }));
  const first = await withFakeCodex(directory, "pass", () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const invocationId = nodeState(first).invocations?.at(-1)?.id;
  assert.ok(invocationId);
  reopenCrashWindow(runDir, invocationId);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "blocked");
  assert.equal(nodeState(resumed).error?.code, "unknown_effect_reconciled");

  // A drifted node state (e.g. a pre-fix handoff publish) must not become
  // handoff-able: the reconciled settlement is the guard, not the error code.
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({ ...state, status: "pending", phase: "waiting", error: null }, null, 2));

  const cli = await handoffCli(runDir, { node: "build", runtime: "opus" });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /settled checkpoint|reconciled/u);
  assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).status, "pending", "a refused handoff must not mutate the node state");
});

test("handoff is serialized against the controller lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-lease-"));
  const path = writeContract(directory, fixture({ id: "handoff-lease-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const lease = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 60_000 });
  try {
    const cli = await handoffCli(runDir, { node: "build", runtime: "opus" });
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /lease/u);
  } finally {
    lease.release();
  }
  const after = await handoffCli(runDir, { node: "build", runtime: "opus" });
  assert.equal(after.code, 0, after.stderr);
});

test("a crash between the capsule write and the state publish leaves the old safe state and a durable capsule", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-crash-boundary-"));
  const path = writeContract(directory, fixture({ id: "handoff-crash-boundary-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;
  const nodePath = join(runDir, "nodes", "build.json");
  const settled = JSON.parse(readFileSync(nodePath, "utf8"));
  assert.equal(settled.status, "done");

  // Force the state publish to fail after the capsule write, as if the
  // controller died on the write boundary. A read-only nodes directory blocks
  // the node write while the capsules directory stays writable.
  const nodesDir = join(runDir, "nodes");
  chmodSync(nodesDir, 0o555);
  await assert.rejects(
    () => handoffRun(runDir, { node: "build", runtime: "opus", reason: "crash boundary" }),
    /EACCES|permission denied/u,
  );
  chmodSync(nodesDir, 0o755);

  // The capsule is durable with the handoff intent...
  const capsule = JSON.parse(readFileSync(join(runDir, "capsules", "build.1.json"), "utf8"));
  assert.equal(capsule.nextAction, "crash boundary");
  // ...and the node remains the old safe state.
  assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).status, "done");

  const cli = await handoffCli(runDir, { node: "build", runtime: "opus" });
  assert.equal(cli.code, 0, cli.stderr);
  const published = JSON.parse(readFileSync(nodePath, "utf8"));
  assert.equal(published.status, "pending");
  assert.equal(published.routing.currentOverride.runtime, "opus");
  assert.ok(existsSync(join(runDir, "capsules", "build.1.json")));

  // The published pending routing override must reference the durable capsule:
  // schedulability is only granted after the capsule write is durable.
  const capsuleFile = JSON.parse(readFileSync(join(runDir, "capsules", "build.1.json"), "utf8"));
  const handoffEvent = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)))
    .filter((event) => event.from === "done" && event.to === "pending")
    .at(-1);
  assert.equal((/** @type {Record<string, unknown>|undefined} */ (handoffEvent?.override))?.capsuleDigest, capsuleFile.digest, "the published handoff must reference the durable capsule digest");
});

test("handoff refuses without a settled checkpoint and without flags", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-handoff-refused-"));
  const path = writeContract(directory, fixture({ id: "handoff-refused-run", pollIntervalMs: 10 }));
  const first = await withFakeCodex(directory, "pass", async () => runContract(path));
  const runDir = /** @type {import("../scripts/runner.mjs").RunOutcome} */ (first).runDir;

  // Strip every settled checkpoint marker: capsules, settlements, and the
  // accepted result in the node snapshot.
  rmSync(join(runDir, "capsules"), { recursive: true, force: true });
  for (const name of readdirSync(join(runDir, "operations"))) {
    if (name.endsWith(".settlement.json")) unlinkSync(join(runDir, "operations", name));
  }
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({ ...state, status: "pending", phase: "waiting", result: null, gate: null }, null, 2));

  const refused = await handoffCli(runDir, { node: "build", runtime: "opus" });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no settled checkpoint/u);

  const unknownRuntime = await handoffCli(runDir, { node: "build", runtime: "nonexistent" });
  assert.notEqual(unknownRuntime.code, 0);
  assert.match(unknownRuntime.stderr, /unknown runtime/u);

  const unknownNode = await handoffCli(runDir, { node: "ghost", runtime: "opus" });
  assert.notEqual(unknownNode.code, 0);
  assert.match(unknownNode.stderr, /unknown node/u);
});
