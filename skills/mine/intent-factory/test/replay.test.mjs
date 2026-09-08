import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJournal, campaignDir, readJournal } from "../scripts/campaign.mjs";
import { driverCapabilities, normalizeProviderResult, providerCommand } from "../scripts/drivers/index.mjs";
import { liveInputTokens, liveSessionMetrics, liveUsage } from "../scripts/drivers/exec-jsonl.mjs";
import { replayDriver } from "../scripts/drivers/replay.mjs";
import { EVENT_MAX_BYTES } from "../scripts/events.mjs";
import { readHeartbeat, rebuildHeartbeat, recordLiveness } from "../scripts/heartbeat.mjs";
import { JUDGE_SCHEMA } from "../scripts/lib.mjs";
import { projectMetrics, readMetricsSources } from "../scripts/metrics.mjs";
import { acknowledgeCampaignEvent, drainNotifications, readNotificationOutbox } from "../scripts/outbox.mjs";
import { runContract, resumeRun } from "../scripts/runner.mjs";
import { integrateAttempt, readIntegrationJournal, recoverIntegrations } from "../scripts/integrate.mjs";
import { createAttemptWorktree, createRunRef, gitHead, runRefName, sealAttempt } from "../scripts/worktree.mjs";
import { fixture, initializeGit, packet, withFakeCodex, writeContract } from "./helpers.mjs";

const bin = fileURLToPath(new URL("../scripts/drivers/replay-bin.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
const zeroUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });

/**
 * The runner spawns the replay executable directly (never through
 * process.execPath), so replay-bin.mjs must stay executable in git
 * (mode 0o755) for every replay test below to run.
 */
function assertExecutable() {
  assert.ok(existsSync(bin), "replay-bin.mjs must exist");
  assert.notEqual(statSync(bin).mode & 0o111, 0, "replay-bin.mjs must be executable (mode 0o755)");
}

/** @param {string} summary @returns {Record<string, unknown>} */
function workerResult(summary) {
  return { status: "done", summary, changedFiles: [], verification: [], artifacts: [], missingContext: [] };
}

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
function envelope(overrides = {}) {
  return {
    status: "done",
    result: "ok",
    continuationId: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
    costUsd: null,
    error: null,
    ...overrides,
  };
}

/** @param {string} directory @param {unknown[]} lines @param {string} [name] @returns {string} */
function writeRecording(directory, lines, name = "recording.jsonl") {
  const path = join(directory, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/** @param {string} path @returns {string|null} */
function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** @param {string} stdout @returns {Record<string, unknown>} */
function parseEnvelopeLine(stdout) {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  assert.ok(line, "stdout must carry one envelope line");
  return /** @type {Record<string, unknown>} */ (JSON.parse(/** @type {string} */ (line)));
}

/**
 * @param {{args?: string[], input?: string, cwd: string}} options
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
function runBin({ args = [], input = "", cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("replay adapter declares explicit capabilities and builds stdin commands", () => {
  assertExecutable();
  const expectedCapabilities = {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: false,
    continuation: true,
    tokenBudget: true,
    costBudget: true,
    usage: true,
    cost: true,
    toolPolicy: false,
  };
  assert.deepEqual(replayDriver.capabilities, expectedCapabilities);
  assert.deepEqual(driverCapabilities({ driver: "replay" }), expectedCapabilities);
  assert.equal(replayDriver.executable({ driver: "replay", model: "m" }), bin, "the sibling replay-bin.mjs is the default executable");
  assert.equal(replayDriver.executable({ driver: "replay", model: "m", executable: "/tmp/custom-replay" }), "/tmp/custom-replay");
  assert.deepEqual(replayDriver.versionArgs({ driver: "replay", model: "m" }), ["--version"]);
  assert.equal(replayDriver.parseVersion("replay 1.0.0"), "replay 1.0.0");

  const recording = join(mkdtempSync(join(tmpdir(), "replay-command-")), "recording.jsonl");
  const runtime = { driver: "replay", model: "replay-model", executable: bin, config: { "replay.recording": recording } };
  const command = providerCommand(runtime, "prompt with spaces", {
    continuationId: "thread-1",
    schema: JUDGE_SCHEMA,
  });
  assert.equal(command.driver, "replay");
  assert.equal(command.model, "replay-model");
  assert.equal(command.executable, bin);
  assert.equal(command.promptTransport, "stdin");
  assert.equal(command.input, "prompt with spaces");
  assert.deepEqual(command.capabilities, expectedCapabilities);
  assert.equal(command.args.includes("prompt with spaces"), false, "the prompt never lands in argv");
  assert.deepEqual(command.args, [
    "--recording",
    recording,
    "--continuation",
    "thread-1",
    "--schema",
  ]);
  assert.deepEqual(providerCommand(runtime, "p", { schemaPath: "/tmp/judge.schema.json" }).args, ["--recording", recording, "--schema"]);
  assert.deepEqual(providerCommand(runtime, "p").args, ["--recording", recording]);
  assert.throws(() => providerCommand({ driver: "replay", model: "m", executable: bin }, "p"), /replay\.recording/u);
});

test("version probe and live preflight bypass never consume the recording", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-preflight-"));
  const recording = writeRecording(directory, [{ envelope: envelope({ result: "first" }) }]);
  const cursorPath = `${recording}.cursor`;
  writeFileSync(cursorPath, "0\n");

  const version = await runBin({ args: ["--version"], cwd: directory });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout, "replay 1.0.0\n");

  const preflight = await runBin({ args: ["--recording", recording], cwd: directory, input: "Respond with exactly INTENT_FACTORY_PREFLIGHT_OK and do not use tools." });
  assert.equal(preflight.code, 0, preflight.stderr);
  assert.deepEqual(JSON.parse(preflight.stdout), {
    status: "done",
    result: "INTENT_FACTORY_PREFLIGHT_OK",
    continuationId: null,
    usage: zeroUsage,
    costUsd: null,
    error: null,
  });
  assert.equal(readFileSync(cursorPath, "utf8"), "0\n", "the preflight answer must not advance the cursor");
  assert.equal(existsSync(`${recording}.invocations.jsonl`), false);
});

test("consumes recording lines strictly in order through the cursor sidecar", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "replay-sequential-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-sequential-rec-"));
  const recording = writeRecording(recordingDir, [
    { envelope: envelope({ result: "first" }) },
    { envelope: envelope({ result: "second" }) },
  ]);
  const cursorPath = `${recording}.cursor`;

  const first = await runBin({ args: ["--recording", recording], cwd: workspace, input: "prompt one" });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(parseEnvelopeLine(first.stdout).result, "first");
  assert.equal(readFileSync(cursorPath, "utf8"), "1\n");
  assert.deepEqual(normalizeProviderResult("replay", first.stdout, first.code, null), envelope({ result: "first" }));

  const second = await runBin({ args: ["--recording", recording], cwd: workspace, input: "prompt two" });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(parseEnvelopeLine(second.stdout).result, "second");
  assert.equal(readFileSync(cursorPath, "utf8"), "2\n");

  const exhausted = await runBin({ args: ["--recording", recording], cwd: workspace, input: "prompt three" });
  assert.equal(exhausted.code, 1);
  const exhaustedEnvelope = parseEnvelopeLine(exhausted.stdout);
  assert.equal(exhaustedEnvelope.status, "failed");
  assert.equal(/** @type {{code?: unknown}} */ (exhaustedEnvelope.error)?.code, "replay_exhausted");
  assert.equal(readFileSync(cursorPath, "utf8"), "2\n", "an exhausted read leaves the cursor untouched");

  const invocations = readFileSync(`${recording}.invocations.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(invocations.map((entry) => entry.index), [0, 1]);
  assert.equal(invocations[0].promptBytes, Buffer.byteLength("prompt one", "utf8"));
  assert.ok(Array.isArray(invocations[0].args));
});

test("applies recorded file writes relative to its cwd", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "replay-writes-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-writes-rec-"));
  const recording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify(workerResult("wrote a file")) }),
    files: [{ path: "out/dir/file.txt", content: "hello replay\n" }],
  }]);
  const result = await runBin({ args: ["--recording", recording], cwd: workspace, input: "write the file" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(workspace, "out/dir/file.txt"), "utf8"), "hello replay\n");
  assert.equal(readIfExists(`${recording}.cursor`), "1\n");
  assert.equal(existsSync(join(recordingDir, "out/dir/file.txt")), false, "files land in the process cwd, not beside the recording");
});

test("honors delayMs and a non-zero exit with no envelope normalizes to invalid_output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "replay-exit-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-exit-rec-"));
  const recording = writeRecording(recordingDir, [{
    envelope: envelope(),
    delayMs: 200,
    stdoutRaw: "",
    exitCode: 1,
  }]);
  const started = Date.now();
  const result = await runBin({ args: ["--recording", recording], cwd: workspace, input: "fail without an envelope" });
  const elapsedMs = Date.now() - started;
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "", "stdoutRaw present verbatim replaces the envelope line");
  assert.ok(elapsedMs >= 180, `delayMs should gate the exit (took ${elapsedMs}ms)`);

  const normalized = normalizeProviderResult("replay", result.stdout, result.code, null);
  assert.equal(normalized.status, "failed");
  assert.equal(normalized.result, null);
  assert.equal(normalized.continuationId, null);
  assert.deepEqual(normalized.usage, zeroUsage);
  assert.equal(normalized.costUsd, null);
  assert.equal(normalized.error?.code, "invalid_output");
  assert.match(normalized.error?.message ?? "", /replay exited with code 1/u);
});

test("stdoutRaw prose normalizes to invalid_output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "replay-prose-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-prose-rec-"));
  const recording = writeRecording(recordingDir, [{
    envelope: envelope(),
    stdoutRaw: "I cannot use tools today.\n",
  }]);
  const result = await runBin({ args: ["--recording", recording], cwd: workspace, input: "prose provider" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "I cannot use tools today.\n");
  const normalized = normalizeProviderResult("replay", result.stdout, result.code, null);
  assert.equal(normalized.status, "failed");
  assert.equal(normalized.error?.code, "invalid_output");
  assert.deepEqual(normalized.usage, zeroUsage);
  assert.match(normalized.error?.message ?? "", /not a valid envelope/u);
});

test("normalize drops unknown fields and never throws on malformed stdout", () => {
  const canonical = envelope();
  const noisy = {
    ...canonical,
    addedByTheProvider: "drop-me",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, noise: 9 },
  };
  assert.deepEqual(normalizeProviderResult("replay", JSON.stringify(noisy), 0, null), canonical);
  assert.equal(normalizeProviderResult("replay", "not json at all", 0, null).status, "failed");
  assert.equal(normalizeProviderResult("replay", "", 0, null).error?.code, "invalid_output");
  assert.equal(normalizeProviderResult("replay", "", 3, null).error?.message, "replay exited with code 3");
  assert.equal(normalizeProviderResult("replay", "", null, "SIGTERM").error?.message, "provider ended after SIGTERM");
  assert.doesNotThrow(() => normalizeProviderResult("replay", "x".repeat(10_000), 0, null));
});

test("live meters treat replay like exec-jsonl: zeros until the terminal envelope", () => {
  const stream = JSON.stringify(envelope({ usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 } }));
  assert.deepEqual(liveUsage("replay", stream), { inputTokens: null, cacheReadInputTokens: null });
  assert.equal(liveInputTokens("replay", stream), 0);
  assert.equal(liveInputTokens("replay", "not json at all"), 0);
  assert.deepEqual(
    liveSessionMetrics("replay", stream),
    { turns: 1, cacheReadInputTokens: 1, toolCalls: 0, completed: true },
    "the single replay envelope proves one completed invocation",
  );
  assert.deepEqual(
    liveSessionMetrics("replay", "not json at all"),
    { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false },
  );
});

test("containment violations fail closed: nothing written, cursor untouched, exit 2", async () => {
  /** @type {{name: string, workspace: string, path: string, target: string}[]} */
  const scenarios = [];

  const traversalName = `replay-traversal-${process.pid}-${Date.now()}.txt`;
  scenarios.push({
    name: ".. traversal",
    workspace: mkdtempSync(join(tmpdir(), "replay-traversal-ws-")),
    path: join("..", traversalName),
    target: join(tmpdir(), traversalName),
  });

  const absoluteTarget = join(mkdtempSync(join(tmpdir(), "replay-absolute-out-")), "escape.txt");
  scenarios.push({
    name: "absolute path",
    workspace: mkdtempSync(join(tmpdir(), "replay-absolute-ws-")),
    path: absoluteTarget,
    target: absoluteTarget,
  });

  const gitWorkspace = mkdtempSync(join(tmpdir(), "replay-git-ws-"));
  mkdirSync(join(gitWorkspace, ".git"));
  scenarios.push({
    name: "metadata root .git",
    workspace: gitWorkspace,
    path: ".git/escape.txt",
    target: join(gitWorkspace, ".git", "escape.txt"),
  });

  const symlinkWorkspace = mkdtempSync(join(tmpdir(), "replay-symlink-ws-"));
  const symlinkOutside = mkdtempSync(join(tmpdir(), "replay-symlink-out-"));
  symlinkSync(symlinkOutside, join(symlinkWorkspace, "alias"));
  scenarios.push({
    name: "symlinked directory outward",
    workspace: symlinkWorkspace,
    path: "alias/escape.txt",
    target: join(symlinkOutside, "escape.txt"),
  });

  for (const scenario of scenarios) {
    const recordingName = `${scenario.name.replace(/\W+/gu, "-").toLowerCase()}.jsonl`;
    const recording = writeRecording(scenario.workspace, [{
      envelope: envelope(),
      files: [{ path: scenario.path, content: "must never be written" }],
    }], recordingName);
    const cursorPath = `${recording}.cursor`;
    writeFileSync(cursorPath, "0\n");
    const result = await runBin({ args: ["--recording", recording], cwd: scenario.workspace, input: `attempt ${scenario.name}` });
    assert.equal(result.code, 2, `${scenario.name} must exit 2`);
    assert.equal(result.stderr, "", `${scenario.name} reports through the envelope, not stderr`);
    const envelopeLine = parseEnvelopeLine(result.stdout);
    assert.equal(envelopeLine.status, "failed", scenario.name);
    assert.equal(/** @type {{code?: unknown}} */ (envelopeLine.error)?.code, "replay_path_escape", scenario.name);
    assert.equal(existsSync(scenario.target), false, `${scenario.name} must write nothing`);
    assert.equal(readFileSync(cursorPath, "utf8"), "0\n", `${scenario.name} must leave the cursor untouched`);
    assert.equal(existsSync(`${recording}.invocations.jsonl`), false, `${scenario.name} must append no invocation`);
    const retry = await runBin({ args: ["--recording", recording], cwd: scenario.workspace, input: `retry ${scenario.name}` });
    assert.equal(retry.code, 2, `${scenario.name} stays deterministic`);
  }
});

test("runContract drives a two-node dependsOn chain through replay worker and judge runtimes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-e2e-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-e2e-rec-"));
  const workerRecording = writeRecording(recordingDir, [
    { envelope: envelope({ result: JSON.stringify(workerResult("build complete")), usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 } }) },
    { envelope: envelope({ result: JSON.stringify(workerResult("ship complete")), usage: { inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 0 } }) },
  ], "worker.jsonl");
  const judgeRecording = writeRecording(recordingDir, [
    { envelope: envelope({ result: JSON.stringify({ verdict: "pass", findings: [], maxSeverity: "none", summary: "ok" }), usage: { inputTokens: 4, outputTokens: 1, cacheReadInputTokens: 0 } }) },
  ], "judge.jsonl");

  const path = writeContract(directory, fixture({
    id: "replay-e2e-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { driver: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { driver: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
    },
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } },
      { id: "ship", type: "backend", dependsOn: ["build"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const build = result.states.get("build");
  const ship = result.states.get("ship");
  assert.ok(build && ship, "both node states must exist");
  assert.equal(result.ok, true);
  assert.equal(build.status, "done");
  assert.equal(ship.status, "done");
  assert.equal(build.gate?.verdict, "pass");
  assert.equal(readFileSync(`${workerRecording}.cursor`, "utf8"), "2\n", "both worker envelopes were consumed");
  assert.equal(readFileSync(`${judgeRecording}.cursor`, "utf8"), "1\n", "the judge envelope was consumed once");
  assert.deepEqual(
    /** @type {{index: number}[]} */ (readFileSync(`${workerRecording}.invocations.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line))).map((entry) => entry.index),
    [0, 1],
  );
});

test("three independent replay nodes run concurrently under maxParallel and each integration is rebuilt on the prior accepted head", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-parallel-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-parallel-rec-"));
  // Long enough that dispatching all three worker processes sequentially
  // (rather than concurrently) would make the later starts land after the
  // earlier one's delay has elapsed, however slow this host's own per-node
  // setup (worktree creation, snapshotting) happens to be.
  const delayMs = 2_000;
  /** @type {Record<string, unknown>} */
  const runtimes = {};
  /** @type {Record<string, unknown>[]} */
  const nodes = [];
  for (const id of ["alpha", "beta", "gamma"]) {
    const recording = writeRecording(recordingDir, [{
      envelope: envelope({ result: JSON.stringify(workerResult(`${id} complete`)) }),
      files: [{ path: `${id}.txt`, content: `${id}\n` }],
      delayMs,
    }], `${id}.jsonl`);
    runtimes[id] = { driver: "replay", model: `${id}-model`, vendor: `${id}-vendor`, config: { "replay.recording": recording } };
    nodes.push({ id, type: "backend", runtime: id, taskPacket: packet({ writeFiles: [`${id}.txt`] }), gate: false });
  }
  const path = writeContract(directory, fixture({
    id: "replay-parallel-run",
    pollIntervalMs: 10,
    maxParallel: 3,
    runtimeDefaults: { worker: "alpha", judge: "alpha" },
    runtimes,
    nodes,
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  /** @type {number[]} */
  const startedAtMs = [];
  for (const id of ["alpha", "beta", "gamma"]) {
    const state = result.states.get(id);
    assert.equal(state?.status, "done");
    const started = Date.parse(state?.invocations?.[0]?.startedAt ?? "");
    assert.ok(Number.isFinite(started), `${id} must record an invocation start time`);
    startedAtMs.push(started);
  }
  // Each later node started before the earlier one's recorded delay could
  // have elapsed: the three worker processes were in flight at once, not
  // dispatched one after another.
  assert.ok(startedAtMs[1] - startedAtMs[0] < delayMs, "beta started while alpha was still in flight");
  assert.ok(startedAtMs[2] - startedAtMs[1] < delayMs, "gamma started while beta was still in flight");
  for (const id of ["alpha", "beta", "gamma"]) {
    assert.equal(showRefFile(directory, runRefName("replay-parallel-run"), `${id}.txt`), `${id}\n`);
  }
  const accepted = readIntegrationJournal(join(directory, ".runs", "replay-parallel-run")).filter((record) => record.status === "accepted");
  assert.equal(accepted.length, 3);
  const tips = new Set(accepted.map((record) => record.previousRunRefTip));
  assert.equal(tips.size, 3, "integration serialized: each candidate was built on the previous one's accepted head, never the same base twice");
});

test("a worker exhaustion fails over its declared one-hop fallback, and the attempt records it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-worker-fallback-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-worker-fallback-rec-"));
  const primaryRecording = writeRecording(recordingDir, [{
    envelope: envelope({ status: "exhausted", result: null, error: { code: "quota_exhausted", message: "quota exhausted" } }),
  }], "primary.jsonl");
  const backupRecording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify(workerResult("backup complete")) }),
  }], "backup.jsonl");
  const path = writeContract(directory, fixture({
    id: "replay-worker-fallback-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "replay", model: "primary-model", vendor: "vendor-primary", fallback: "backup", config: { "replay.recording": primaryRecording } },
      backup: { driver: "replay", model: "backup-model", vendor: "vendor-backup", config: { "replay.recording": backupRecording } },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = result.states.get("build");
  assert.equal(state?.status, "done", state?.error?.message);
  assert.deepEqual((state?.invocations ?? []).map((invocation) => invocation.runtimeId), ["primary", "backup"]);
  assert.equal(state?.routing?.history?.[0]?.nextRuntime, "backup", "the attempt records the one-hop fallback it took");
  assert.equal(state?.routing?.history?.[0]?.hop, 1);
  assert.equal(state?.routing?.history?.[0]?.errorCode, "quota_exhausted");
});

test("a judge fallback to a runtime of a different vendor than the worker that ran is admissible", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-judge-fallback-ok-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-judge-fallback-ok-rec-"));
  const workerRecording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }),
  }], "worker.jsonl");
  const primaryJudgeRecording = writeRecording(recordingDir, [{
    envelope: envelope({ status: "exhausted", result: null, error: { code: "quota_exhausted", message: "quota exhausted" } }),
  }], "judge-primary.jsonl");
  const fallbackJudgeRecording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify({ verdict: "pass", findings: [], maxSeverity: "none", summary: "ok" }) }),
  }], "judge-fallback.jsonl");
  const path = writeContract(directory, fixture({
    id: "replay-judge-fallback-ok-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "worker", judge: "judge-primary" },
    runtimes: {
      worker: { driver: "replay", model: "worker-model", vendor: "vendor-worker", config: { "replay.recording": workerRecording } },
      "judge-primary": { driver: "replay", model: "judge-primary-model", vendor: "vendor-judge-primary", fallback: "judge-fallback", config: { "replay.recording": primaryJudgeRecording } },
      "judge-fallback": { driver: "replay", model: "judge-fallback-model", vendor: "vendor-judge-fallback", config: { "replay.recording": fallbackJudgeRecording } },
    },
    nodes: [{
      id: "build", type: "backend", taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = result.states.get("build");
  assert.equal(state?.status, "done", state?.error?.message);
  assert.equal(state?.gate?.verdict, "pass");
  const judgeInvocations = (state?.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.deepEqual(judgeInvocations.map((invocation) => invocation.runtimeId), ["judge-primary", "judge-fallback"]);
});

test("a judge fallback that would share the vendor of the worker that actually ran is refused, and the node is parked attention", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-judge-fallback-conflict-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-judge-fallback-conflict-rec-"));
  const workerRecording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }),
  }], "worker.jsonl");
  const primaryJudgeRecording = writeRecording(recordingDir, [{
    envelope: envelope({ status: "exhausted", result: null, error: { code: "quota_exhausted", message: "quota exhausted" } }),
  }], "judge-primary.jsonl");
  const fallbackJudgeRecording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify({ verdict: "pass", findings: [], maxSeverity: "none", summary: "ok" }) }),
  }], "judge-fallback.jsonl");
  const path = writeContract(directory, fixture({
    id: "replay-judge-fallback-conflict-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "worker", judge: "judge-primary" },
    runtimes: {
      worker: { driver: "replay", model: "worker-model", vendor: "shared-vendor", config: { "replay.recording": workerRecording } },
      "judge-primary": { driver: "replay", model: "judge-primary-model", vendor: "vendor-judge-primary", fallback: "judge-fallback", config: { "replay.recording": primaryJudgeRecording } },
      "judge-fallback": { driver: "replay", model: "judge-fallback-model", vendor: "shared-vendor", config: { "replay.recording": fallbackJudgeRecording } },
    },
    nodes: [{
      id: "build", type: "backend", taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = result.states.get("build");
  assert.equal(result.ok, false);
  assert.equal(state?.status, "blocked");
  assert.equal(state?.error?.code, "judge_fallback_vendor_conflict");
  // The judge fallback was never invoked: only the primary judge attempt exists.
  const judgeInvocations = (state?.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.deepEqual(judgeInvocations.map((invocation) => invocation.runtimeId), ["judge-primary"]);
});

/**
 * The deterministic cases of the release-1 eval set (TECH-SPEC section 8.3).
 * Every case below is a replay of recorded envelopes through the replay driver
 * — worker and judge alike — so a case can never reach a live provider and two
 * runs of the suite measure the same facts.
 */

const passVerdict = Object.freeze({ verdict: "pass", findings: [], maxSeverity: "none", summary: "ok" });

/** @param {string} id @param {string} text @returns {Record<string, unknown>} */
const provenItem = (id, text) => ({ id, text, proof: { kind: "path", ref: "README.md" } });

/**
 * Drive one contract end to end over the replay driver and return the run, the
 * campaign it registered with, and the recordings both runtimes read from.
 *
 * @param {{id: string, nodes: Record<string, unknown>[], worker: unknown[], judge?: unknown[]}} options
 */
async function driveReplayedContract({ id, nodes, worker, judge = [{ envelope: envelope({ result: JSON.stringify(passVerdict) }) }] }) {
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const workerRecording = writeRecording(recordingDir, worker, "worker.jsonl");
  const judgeRecording = writeRecording(recordingDir, judge, "judge.jsonl");
  const contractPath = writeContract(directory, fixture({
    id,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { driver: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { driver: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
    },
    nodes,
  }));
  const outcome = await runContract(contractPath);
  const runsDir = join(directory, ".runs");
  return {
    directory,
    runsDir,
    campaignPath: campaignDir(runsDir, "test-campaign"),
    contractPath,
    outcome,
    workerRecording,
    judgeRecording,
  };
}

/** @param {string} campaignPath @param {string} runsDir @returns {import("../scripts/metrics.mjs").CampaignMetrics} */
function campaignMetrics(campaignPath, runsDir) {
  return projectMetrics(readMetricsSources(campaignPath, { runsDir }));
}

/** @typedef {{repo: string, runDir: string, id: string, head: string|null}} IntegrationFixture */
/**
 * @typedef {{
 *   verifyCandidate?: import("../scripts/integrate.mjs").CandidateVerifier,
 *   onAccepted?: import("../scripts/integrate.mjs").AcceptedCallback,
 *   onVerificationFailure?: import("../scripts/integrate.mjs").VerificationFailureCallback,
 *   onConflict?: import("../scripts/integrate.mjs").AcceptedCallback,
 *   onConcurrentMove?: import("../scripts/integrate.mjs").ConcurrentMoveCallback,
 *   interrupt?: (stage: string) => void,
 * }} IntegrationFixtureOptions
 */

/** @param {string} id @returns {IntegrationFixture} */
function integrationFixture(id) {
  const repo = mkdtempSync(join(tmpdir(), `${id}-git-`));
  writeFileSync(join(repo, "README.md"), "base\n");
  initializeGit(repo);
  const runDir = join(repo, ".runs", id);
  mkdirSync(runDir, { recursive: true });
  const head = gitHead(repo);
  createRunRef(repo, id, head);
  return { repo, runDir, id, head };
}

/**
 * @param {IntegrationFixture} fixture
 * @param {string} node
 * @param {number} attempt
 * @param {(workspace: string) => void} [write]
 */
function sealFixtureAttempt(fixture, node, attempt, write) {
  const worktree = createAttemptWorktree({ repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: node, attempt });
  write?.(worktree.path);
  const sealed = sealAttempt({ repo: fixture.repo, path: worktree.path, baseSha: worktree.baseSha, runId: fixture.id, nodeId: node, attempt });
  return { worktree, sealed };
}

/**
 * @param {IntegrationFixture} fixture
 * @param {string} node
 * @param {number} attempt
 * @param {(workspace: string) => void} [write]
 * @param {IntegrationFixtureOptions} [options]
 */
async function integrateFixtureAttempt(fixture, node, attempt, write, options = {}) {
  const { worktree, sealed } = sealFixtureAttempt(fixture, node, attempt, write);
  const result = await integrateAttempt({
    repo: fixture.repo,
    runDir: fixture.runDir,
    runId: fixture.id,
    nodeId: node,
    attempt,
    attemptSha: sealed.sha,
    branch: worktree.branch,
    verificationEvidence: { passed: true, commands: [] },
    verifyCandidate: options.verifyCandidate ?? (async () => ({ passed: true, commands: [] })),
    onAccepted: options.onAccepted ?? (async () => {}),
    onVerificationFailure: options.onVerificationFailure ?? (async () => {}),
    onConflict: options.onConflict ?? (async () => {}),
    onConcurrentMove: options.onConcurrentMove ?? (async () => {}),
    interrupt: options.interrupt,
  });
  return { ...result, worktree, sealed };
}

/** @param {string} repo @param {string} ref @param {string} path @returns {string} */
function showRefFile(repo, ref, path) {
  return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8" });
}

test("attempt worktree seals a worker-only file onto its isolated branch and integrated ref", async () => {
  const fixture = integrationFixture("attempt-seal");
  const result = await integrateFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "output.txt"), "worker\n"));
  assert.equal(result.status, "accepted");
  assert.equal(existsSync(join(fixture.repo, "output.txt")), false, "the main tree stays untouched");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "output.txt"), "worker\n");
  assert.equal(result.worktree.branch, `if/${fixture.id}/build/1`);
  assert.equal(result.sealed.empty, false);
  const lastRecord = readIntegrationJournal(fixture.runDir).at(-1);
  assert.ok(lastRecord);
  assert.equal(lastRecord.status, "accepted");
});

test("a replay worker that only writes a file lands it on the integrated branch", async () => {
  const replayed = await driveReplayedContract({
    id: "worker-only-write",
    worker: [{
      envelope: envelope({ result: JSON.stringify(workerResult("file written")) }),
      files: [{ path: "output.txt", content: "from worker\n" }],
    }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["output.txt"] }), gate: false }],
  });
  const state = replayed.outcome.states.get("build");
  assert.equal(replayed.outcome.ok, true);
  assert.equal(existsSync(join(replayed.directory, "output.txt")), false);
  assert.equal(showRefFile(replayed.directory, runRefName("worker-only-write"), "output.txt"), "from worker\n");
  assert.equal(state?.worktree?.status, "removed");
  assert.equal(existsSync(state?.worktree?.path ?? ""), false);
});

test("a Codex-shaped worker writes its result in the attempt worktree and resume replays the accepted transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-isolated-result-"));
  const id = "codex-isolated-result";
  const contractPath = writeContract(directory, fixture({ id, pollIntervalMs: 10 }));
  const previousInterrupt = process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT;
  const runDir = join(directory, ".runs", id);
  try {
    process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT = "after-state";
    await assert.rejects(
      () => withFakeCodex(directory, "write-result", async () => {
        await runContract(contractPath);
      }),
      /integration interrupted after node state write/u,
    );
  } finally {
    if (previousInterrupt === undefined) delete process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT;
    else process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT = previousInterrupt;
  }
  const node = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  const workspace = node.worktree.path;
  assert.ok(workspace.includes(join(".runs", "worktrees", id, `build.${node.attempt}`)));
  assert.equal(existsSync(join(workspace, ".runs", "results", "build.json")), true, "the provider result stayed in the isolated worktree until recovery");
  assert.equal(existsSync(join(runDir, "results", "build.json")), true, "the controller materialized the result into the run directory");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const recovered = resumed.states.get("build");
  assert.equal(recovered?.status, "done");
  assert.equal(recovered?.worktree?.status, "removed");
  assert.equal(existsSync(workspace), false, "recovery removes the completed attempt worktree");
  assert.equal(readIntegrationJournal(runDir).filter((record) => record.status === "accepted").length, 1);
});

test("attempt consumers read the attempt workspace rather than the main tree", async () => {
  const fixture = integrationFixture("attempt-consumer");
  const { worktree } = sealFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "visible.txt"), "attempt\n"));
  assert.equal(readFileSync(join(worktree.path, "visible.txt"), "utf8"), "attempt\n");
  assert.equal(existsSync(join(fixture.repo, "visible.txt")), false);
});

test("two sequential attempts use the first integrated head as the second base", async () => {
  const fixture = integrationFixture("sequential-integrate");
  const first = await integrateFixtureAttempt(fixture, "first", 1, (workspace) => writeFileSync(join(workspace, "first.txt"), "first\n"));
  const second = await integrateFixtureAttempt(fixture, "second", 1, (workspace) => writeFileSync(join(workspace, "second.txt"), "second\n"));
  const records = readIntegrationJournal(fixture.runDir).filter((record) => record.status === "accepted");
  assert.equal(records[1].previousRunRefTip, first.sealed.sha);
  assert.equal(second.status, "accepted");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "first.txt"), "first\n");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "second.txt"), "second\n");
});

test("failed candidate verification leaves the run ref unchanged and keeps the attempt worktree", async () => {
  const fixture = integrationFixture("candidate-failure");
  const before = gitHead(fixture.repo, runRefName(fixture.id));
  const result = await integrateFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "output.txt"), "bad\n"), {
    verifyCandidate: async () => ({ passed: false, error: "candidate failed" }),
  });
  assert.equal(result.status, "verification_failed");
  assert.equal(gitHead(fixture.repo, runRefName(fixture.id)), before);
  assert.equal(gitHead(fixture.repo, `refs/intent-factory/${fixture.id}/candidate`), null);
  assert.equal(existsSync(join(fixture.repo, ".runs", "worktrees", fixture.id, ".candidate")), false);
  assert.equal(existsSync(result.worktree.path), true);
  const lastRecord = readIntegrationJournal(fixture.runDir).at(-1);
  assert.ok(lastRecord);
  assert.equal(lastRecord.status, "failed");
});

test("integration conflict records paths, keeps the attempt, and lets the next node integrate", async () => {
  const fixture = integrationFixture("conflict-integrate");
  const left = sealFixtureAttempt(fixture, "left", 1, (workspace) => writeFileSync(join(workspace, "README.md"), "left\n"));
  const right = sealFixtureAttempt(fixture, "right", 1, (workspace) => writeFileSync(join(workspace, "README.md"), "right\n"));
  await integrateAttempt({
    repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "left", attempt: 1,
    attemptSha: left.sealed.sha, branch: left.worktree.branch, verificationEvidence: { passed: true },
    verifyCandidate: async () => ({ passed: true }),
  });
  /** @type {string[]} */
  let paths = [];
  const conflict = await integrateAttempt({
    repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "right", attempt: 1,
    attemptSha: right.sealed.sha, branch: right.worktree.branch, verificationEvidence: { passed: true },
    verifyCandidate: async () => ({ passed: true }),
    onConflict: async (transaction) => { paths = transaction.conflictingPaths; },
  });
  assert.ok(conflict);
  assert.equal(conflict.status, "conflict");
  assert.ok(paths.includes("README.md"));
  assert.equal(existsSync(right.worktree.path), true);
  const next = await integrateFixtureAttempt(fixture, "next", 1, (workspace) => writeFileSync(join(workspace, "next.txt"), "next\n"));
  assert.equal(next.status, "accepted");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "README.md"), "left\n");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "next.txt"), "next\n");
});

test("prepared recovery never treats an unverified candidate already in the run ref as accepted", async () => {
  const fixture = integrationFixture("prepared-unverified");
  const { worktree, sealed } = sealFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "output.txt"), "unverified\n"));
  await assert.rejects(() => integrateAttempt({
    repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "build", attempt: 1,
    attemptSha: sealed.sha, branch: worktree.branch, verificationEvidence: { passed: true },
    verifyCandidate: async () => ({ passed: true }),
    interrupt: (stage) => { if (stage === "prepared") throw new Error(stage); },
  }), /prepared/u);
  assert.ok(fixture.head);
  execFileSync("git", ["-C", fixture.repo, "update-ref", runRefName(fixture.id), sealed.sha, fixture.head]);
  let verified = false;
  let concurrentMove = false;
  await recoverIntegrations({
    repo: fixture.repo,
    runDir: fixture.runDir,
    runId: fixture.id,
    verifyCandidate: async () => { verified = true; return { passed: true }; },
    onConcurrentMove: async () => { concurrentMove = true; },
  });
  assert.equal(verified, false);
  assert.equal(concurrentMove, true);
  assert.equal(readIntegrationJournal(fixture.runDir).some((record) => record.status === "accepted"), false);
});

test("integration interruptions before ref, after ref, and after state recover idempotently", async () => {
  for (const stage of ["before-ref", "after-ref", "after-state"]) {
    const fixture = integrationFixture(`interrupt-${stage}`);
    let accepted = 0;
    await assert.rejects(() => integrateFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "output.txt"), stage), {
      onAccepted: async () => { accepted += 1; },
      interrupt: (current) => { if (current === stage) throw new Error(stage); },
    }), new RegExp(stage, "u"));
    await recoverIntegrations({
      repo: fixture.repo,
      runDir: fixture.runDir,
      runId: fixture.id,
      verifyCandidate: async () => { throw new Error("verified candidate must not be verified twice"); },
      onAccepted: async () => { accepted += 1; },
    });
    assert.equal(readIntegrationJournal(fixture.runDir).filter((record) => record.status === "accepted").length, 1, stage);
    assert.equal(accepted, stage === "after-state" ? 2 : 1, stage);
  }
});

test("accepted no-change attempt recovery works even when the run ref tip does not move", async () => {
  const fixture = integrationFixture("no-change-recovery");
  const before = gitHead(fixture.repo, runRefName(fixture.id));
  await assert.rejects(() => integrateFixtureAttempt(fixture, "build", 1, undefined, {
    interrupt: (stage) => { if (stage === "after-ref") throw new Error("after-ref"); },
  }), /after-ref/u);
  assert.equal(gitHead(fixture.repo, runRefName(fixture.id)), before);
  await recoverIntegrations({ repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, verifyCandidate: async () => { throw new Error("must reuse verified evidence"); } });
  const records = readIntegrationJournal(fixture.runDir).filter((record) => record.status === "accepted");
  assert.equal(records.length, 1);
  assert.equal(records[0].empty, true);
  assert.equal(gitHead(fixture.repo, runRefName(fixture.id)), before);
});

test("repeated integration records one accepted transaction", async () => {
  const fixture = integrationFixture("repeat-integrate");
  const first = await integrateFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "output.txt"), "once\n"));
  const repeated = await integrateAttempt({
    repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "build", attempt: 1,
    attemptSha: first.sealed.sha, branch: first.worktree.branch, verificationEvidence: { passed: true },
    verifyCandidate: async () => { throw new Error("repeated accepted integration must not verify"); },
  });
  assert.ok(repeated);
  assert.equal(repeated.status, "accepted");
  assert.equal(readIntegrationJournal(fixture.runDir).filter((record) => record.status === "accepted").length, 1);
});

test("D24: a three-node replayed contract without judgment items closes with zero judge invocations", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d24-mechanical-close",
    worker: ["build", "wire", "ship"].map((step) => ({
      envelope: envelope({ result: JSON.stringify(workerResult(`${step} complete`)) }),
    })),
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [provenItem("readme", "README.md exists")], gate: { failOn: ["critical"] } },
      { id: "wire", type: "backend", dependsOn: ["build"], taskPacket: packet(), definitionOfDone: [provenItem("wired", "README.md still exists")], gate: { failOn: ["critical"] } },
      { id: "ship", type: "backend", dependsOn: ["wire"], taskPacket: packet(), definitionOfDone: [provenItem("shipped", "README.md is shipped")], gate: { failOn: ["critical"] } },
    ],
  });
  assert.equal(replayed.outcome.ok, true);
  for (const id of ["build", "wire", "ship"]) {
    const state = replayed.outcome.states.get(id);
    assert.equal(state?.status, "done", `${id} must close`);
    assert.equal(state?.gate?.verdict, "pass", `${id} settles on its mechanical proof`);
  }
  assert.equal(readFileSync(`${replayed.workerRecording}.cursor`, "utf8"), "3\n", "one worker envelope per node");
  assert.equal(existsSync(`${replayed.judgeRecording}.cursor`), false, "the judge recording was never opened");
  assert.equal(existsSync(`${replayed.judgeRecording}.invocations.jsonl`), false, "no judge invocation was recorded");
  const metrics = campaignMetrics(replayed.campaignPath, replayed.runsDir);
  assert.deepEqual(metrics.judgeInvocationRate, { value: 0, direction: "down", count: 3 }, "three closed checkpoints, zero judge dispatches");
});

test("D25: a gate rejection citing no Definition of Done item is invalid", async () => {
  assertExecutable();
  /** @param {string} summary @returns {Record<string, unknown>} */
  const uncitedRejection = (summary) => ({
    envelope: envelope({
      result: JSON.stringify({
        verdict: "fail",
        maxSeverity: "critical",
        summary,
        // Neither field names the judgment item id, which is what makes the
        // rejection unactionable and therefore a judge protocol failure.
        findings: [{ severity: "critical", description: "the change is unconvincing", evidence: "no artefact was cited" }],
      }),
    }),
  });
  const replayed = await driveReplayedContract({
    id: "d25-uncited-rejection",
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
    judge: [uncitedRejection("rejected"), uncitedRejection("rejected again")],
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "reviewed", text: "A judge is convinced by the change", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  });
  const state = replayed.outcome.states.get("build");
  assert.equal(replayed.outcome.ok, false);
  assert.equal(state?.status, "blocked", "an uncited rejection never closes the node");
  assert.equal(state?.error?.code, "judge_protocol", "the rejection is a judge protocol failure, not a verdict");
  assert.equal(state?.revisions ?? 0, 0, "an invalid rejection never consumes a worker revision");
  assert.equal(readFileSync(`${replayed.judgeRecording}.cursor`, "utf8"), "2\n", "exactly one bounded re-ask was spent");
  assert.equal(readFileSync(`${replayed.workerRecording}.cursor`, "utf8"), "1\n", "the worker was never re-dispatched");
});

test("D27: a complete replayed campaign with no requiresUser event has a wake count of zero", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d27-no-wake",
    worker: ["build", "ship"].map((step) => ({ envelope: envelope({ result: JSON.stringify(workerResult(`${step} complete`)) }) })),
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [provenItem("readme", "README.md exists")], gate: { failOn: ["critical"] } },
      { id: "ship", type: "backend", dependsOn: ["build"], taskPacket: packet(), gate: false },
    ],
  });
  assert.equal(replayed.outcome.ok, true);
  const outbox = readNotificationOutbox(replayed.campaignPath);
  assert.ok(outbox.length > 0, "the campaign recorded human-channel events");
  assert.deepEqual(outbox.filter((record) => record.requiresUser === true), [], "a complete run never asks for the session");
  const metrics = campaignMetrics(replayed.campaignPath, replayed.runsDir);
  assert.deepEqual(
    metrics.sessionWakeCount,
    { value: 0, direction: "down", count: outbox.length },
    "a measured zero over the recorded outbox, not a missing measurement",
  );
});

test("D28: a node stuck for 40 minutes shows an aged lastProgressAt without emitting an event", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d28-stuck-node",
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  });
  const facts = readJournal(replayed.campaignPath).filter((entry) => entry.type === "liveness");
  const running = facts[0];
  assert.ok(running, "the replayed run recorded a liveness fact");
  const eventsPath = join(replayed.outcome.runDir, "events.jsonl");
  const eventsBefore = readFileSync(eventsPath, "utf8");
  const outboxBefore = readNotificationOutbox(replayed.campaignPath).length;

  // The supervisor refreshes liveness on its interval; a node that made no
  // progress for 40 minutes refreshes the same lastProgressAt, so the ageing
  // is visible in the heartbeat and nothing is emitted for it.
  const stuckAt = new Date(Date.parse(String(running.at)) + 40 * 60 * 1000).toISOString();
  const { heartbeat } = recordLiveness(
    replayed.campaignPath,
    /** @type {import("../scripts/heartbeat.mjs").LivenessFact} */ ({ ...running, eventId: randomUUID(), at: stuckAt }),
    { generatedAt: stuckAt },
  );
  assert.equal(heartbeat.lastProgressAt, Math.floor(Date.parse(String(running.lastProgressAt)) / 1000), "lastProgressAt did not move");
  assert.ok(heartbeat.generatedAt - heartbeat.lastProgressAt >= 2400, "the heartbeat shows the 40-minute age");
  assert.equal(readFileSync(eventsPath, "utf8"), eventsBefore, "ageing emits no run event");
  assert.equal(readNotificationOutbox(replayed.campaignPath).length, outboxBefore, "ageing emits no human-channel event");
});

test("D29: a heartbeat rebuilt from the journal is byte-identical to the recorded one", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d29-heartbeat-rebuild",
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  });
  const heartbeatPath = join(replayed.campaignPath, "heartbeat.json");
  const recorded = readFileSync(heartbeatPath, "utf8");
  const parsed = readHeartbeat(replayed.campaignPath);
  assert.ok(parsed, "the replayed run left a readable heartbeat");
  const rebuilt = rebuildHeartbeat(replayed.campaignPath, { generatedAt: parsed.generatedAt });
  assert.deepEqual(rebuilt, parsed, "the rebuild derives the same heartbeat object");
  assert.equal(readFileSync(heartbeatPath, "utf8"), recorded, "and writes the same bytes");
});

test("D30: a crash between the fact and the heartbeat write leaves the old heartbeat intact", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d30-crash-between-writes",
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  });
  const heartbeatPath = join(replayed.campaignPath, "heartbeat.json");
  const recorded = readFileSync(heartbeatPath, "utf8");
  const facts = readJournal(replayed.campaignPath).filter((entry) => entry.type === "liveness");
  const newest = facts.at(-1);
  assert.ok(newest, "the replayed run recorded a liveness fact");

  // recordLiveness appends the durable fact first and only then writes the
  // heartbeat: a crash in that window is exactly the journal append alone.
  const crashedAt = new Date(Date.parse(String(newest.at)) + 60 * 1000).toISOString();
  const crashed = /** @type {Record<string, unknown>} */ ({ ...newest, eventId: randomUUID(), at: crashedAt, checkpointsDone: Number(newest.checkpointsDone) + 1 });
  appendJournal(replayed.campaignPath, crashed);
  assert.equal(readFileSync(heartbeatPath, "utf8"), recorded, "the old heartbeat is still pinned, byte for byte");

  const repaired = rebuildHeartbeat(replayed.campaignPath, { generatedAt: crashedAt });
  assert.equal(repaired?.checkpoints.done, Number(newest.checkpointsDone) + 1, "the rebuild recovers the newest durable fact");
  assert.notEqual(readFileSync(heartbeatPath, "utf8"), recorded, "and only the rebuild moves the heartbeat");
});

test("D32: the replayed campaign inbox bounds event size, sets deliveredAt after append, and separates sync from ack", async () => {
  assertExecutable();
  // A configured transport delivers every event type, campaign.progress
  // included (drainNotifications only filters by PUSH_EVENT_TYPES when no
  // executable is configured) — so a transport that always fails leaves
  // every event pending without ever reaching the platform notify adapter
  // the suite's no-op default stands in for.
  const failingTransport = join(mkdtempSync(join(tmpdir(), "d32-failing-transport-")), "fail.sh");
  writeFileSync(failingTransport, "#!/bin/sh\ncat > /dev/null\nexit 1\n");
  chmodSync(failingTransport, 0o755);
  const previousDefaultNotifyBin = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = failingTransport;
  let replayed;
  try {
    replayed = await driveReplayedContract({
      id: "d32-inbox",
      worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
      nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    });
  } finally {
    if (previousDefaultNotifyBin === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousDefaultNotifyBin;
  }
  const appended = readNotificationOutbox(replayed.campaignPath);
  assert.ok(appended.length > 0, "the run appended events to the inbox");
  for (const record of appended) {
    assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= EVENT_MAX_BYTES, `${record.eventId} exceeds the ${EVENT_MAX_BYTES}-byte ceiling`);
    // deliveredAt is stamped by a delivery, never by the append: an event is
    // either still pending or was delivered at or after it was appended.
    assert.ok(record.deliveredAt === null || String(record.deliveredAt) >= record.at, `${record.eventId} was stamped before it was appended`);
  }
  const pending = appended.filter((record) => !record.deliveredAt);
  assert.ok(pending.length > 0, "campaign.progress events are never pushed and stay pending for the pull consumer");

  const transport = join(replayed.directory, "notify-transport.sh");
  writeFileSync(transport, "#!/bin/sh\ncat > /dev/null\nexit 0\n");
  chmodSync(transport, 0o755);
  const previousNotifyBin = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = transport;
  try {
    const drained = await drainNotifications(replayed.campaignPath);
    assert.equal(drained.delivered, pending.length, "the drain delivered exactly what was pending");
    assert.equal(drained.pending, 0, "every appended event was delivered");
  } finally {
    if (previousNotifyBin === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotifyBin;
  }
  for (const record of readNotificationOutbox(replayed.campaignPath)) {
    assert.ok(typeof record.deliveredAt === "string" && record.deliveredAt >= record.at, `${record.eventId} carries deliveredAt only after delivery`);
  }

  const cursorPath = join(replayed.campaignPath, "watch-cursors", "session-d32.json");
  const configured = spawnSync(process.execPath, [runner, "campaign", "configure", "test-campaign", "--cwd", replayed.directory, "--contract", replayed.contractPath], { encoding: "utf8" });
  assert.equal(configured.status, 0, configured.stderr);
  const sync = spawnSync(process.execPath, [runner, "campaign", "sync", "test-campaign", "--cwd", replayed.directory, "--session-id", "d32"], { encoding: "utf8" });
  assert.equal(sync.status, 0, sync.stderr);
  assert.ok(Buffer.byteLength(sync.stdout, "utf8") <= 8000, `sync printed ${Buffer.byteLength(sync.stdout, "utf8")} bytes`);
  assert.equal(existsSync(cursorPath), false, "sync is a read: only ack writes the cursor");

  const acknowledged = readNotificationOutbox(replayed.campaignPath).sort((left, right) => (left.at < right.at ? -1 : 1)).at(-1);
  assert.ok(acknowledged, "there is a newest event to acknowledge");
  const ack = spawnSync(process.execPath, [runner, "campaign", "ack", "test-campaign", "--cwd", replayed.directory, "--session-id", "d32", "--event-id", acknowledged.eventId], { encoding: "utf8" });
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(JSON.parse(readFileSync(cursorPath, "utf8")).eventId, acknowledged.eventId, "ack advanced the durable cursor");
  const afterAck = readFileSync(cursorPath, "utf8");
  assert.deepEqual(
    acknowledgeCampaignEvent(replayed.campaignPath, "session-d32", acknowledged.eventId),
    { cursorId: "session-d32", at: acknowledged.at, eventId: acknowledged.eventId },
  );
  assert.equal(readFileSync(cursorPath, "utf8"), afterAck, "re-acknowledging the same event is a durable no-op");
});

test("preflight --json measures the worker preamble per runtime", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d-preamble-measured",
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  });
  const preflight = spawnSync(process.execPath, [runner, "preflight", "--json", replayed.contractPath], {
    encoding: "utf8",
    env: { ...process.env, INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC: "120" },
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  const payload = /** @type {{checks: {id: string, live: boolean, usage: {inputTokens: number}|null}[]}} */ (JSON.parse(preflight.stdout));
  // The node's gate is disabled and replay-worker declares no fallback, so
  // the reachable-state enumeration has exactly one runtime: replay-judge is
  // never in play for this contract.
  assert.deepEqual(payload.checks.map((check) => check.id).sort(), ["replay-worker"]);
  for (const check of payload.checks) {
    assert.equal(check.live, true, `${check.id} was probed live`);
    assert.equal(typeof check.usage?.inputTokens, "number", `${check.id} reports a measured preamble`);
  }
  // The live probe never consumes the recording, so the measurement costs the
  // eval set nothing and stays deterministic.
  assert.equal(readFileSync(`${replayed.workerRecording}.cursor`, "utf8"), "1\n");

  writeFileSync(join(replayed.outcome.runDir, "preflight.json"), `${JSON.stringify(payload)}\n`);
  const sources = readMetricsSources(replayed.campaignPath, { runsDir: replayed.runsDir });
  assert.equal(sources.preflight.length, 1, "the recorded preflight payload is a metrics source");
  assert.deepEqual(
    projectMetrics(sources).workerPreambleTokens,
    { value: { "replay-worker": 0 }, direction: "down", count: 1 },
    "the indicator is the per-runtime measurement preflight reported",
  );
});

test("sealAttempt seals a worktree that holds the ignored .runs result sidecar", () => {
  // Every real worker writes its result into the attempt-local `.runs/results`
  // sidecar, and every execution repository ignores `.runs/`. Naming the
  // sidecar through an exclude pathspec made `git add` exit 1 with
  // advice.addIgnoredFile, so no non-empty attempt could ever be sealed.
  const fixture = integrationFixture("seal-ignored-sidecar");
  const { sealed, worktree } = sealFixtureAttempt(fixture, "build", 1, (workspace) => {
    writeFileSync(join(workspace, ".gitignore"), ".runs/\n");
    mkdirSync(join(workspace, ".runs", "results"), { recursive: true });
    writeFileSync(join(workspace, ".runs", "results", "build.json"), "{}\n");
    writeFileSync(join(workspace, "README.md"), "sealed\n");
  });
  assert.equal(sealed.empty, false, "the attempt carries the README change");
  const files = execFileSync("git", ["-C", worktree.path, "show", "--name-only", "--format=", sealed.sha], { encoding: "utf8" }).trim().split("\n");
  assert.ok(files.includes("README.md"));
  assert.ok(!files.some((file) => file.startsWith(".runs/")), "the ignored sidecar is never committed");
});
