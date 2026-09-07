import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import { runContract } from "../scripts/runner.mjs";
import { fixture, packet, writeContract } from "./helpers.mjs";

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
    maxInvocationTokens: 4096,
    maxCostUsd: 0.25,
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
    "--max-invocation-tokens",
    "4096",
    "--max-cost-usd",
    "0.25",
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
      "replay-worker": { driver: "replay", model: "replay-worker-model", config: { "replay.recording": workerRecording } },
      "replay-judge": { driver: "replay", model: "replay-judge-model", config: { "replay.recording": judgeRecording } },
    },
    runtimeRules: [],
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
      "replay-worker": { driver: "replay", model: "replay-worker-model", config: { "replay.recording": workerRecording } },
      "replay-judge": { driver: "replay", model: "replay-judge-model", config: { "replay.recording": judgeRecording } },
    },
    runtimeRules: [],
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
  const crashed = /** @type {Record<string, unknown>} */ ({ ...newest, eventId: randomUUID(), at: crashedAt, weightedUsed: Number(newest.weightedUsed) + 7 });
  appendJournal(replayed.campaignPath, crashed);
  assert.equal(readFileSync(heartbeatPath, "utf8"), recorded, "the old heartbeat is still pinned, byte for byte");

  const repaired = rebuildHeartbeat(replayed.campaignPath, { generatedAt: crashedAt });
  assert.equal(repaired?.weightedUsed, Number(newest.weightedUsed) + 7, "the rebuild recovers the newest durable fact");
  assert.notEqual(readFileSync(heartbeatPath, "utf8"), recorded, "and only the rebuild moves the heartbeat");
});

test("D32: the replayed campaign inbox bounds event size, sets deliveredAt after append, and separates sync from ack", async () => {
  assertExecutable();
  const replayed = await driveReplayedContract({
    id: "d32-inbox",
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("build complete")) }) }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  });
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

test("preflight --json measures the worker preamble per runtime and outranks the recorded guess", async () => {
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
  assert.deepEqual(payload.checks.map((check) => check.id).sort(), ["replay-judge", "replay-worker"]);
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
    { value: { "replay-judge": 0, "replay-worker": 0 }, direction: "down", count: 2 },
    "the indicator is the per-runtime measurement preflight reported",
  );

  /** @param {string} runtimeId @param {number} preambleTokens @returns {Record<string, unknown>} */
  const dispatch = (runtimeId, preambleTokens) => ({
    at: "2026-09-05T00:00:00.000Z",
    node: runtimeId,
    to: "running",
    budgetDecision: { extensionAllowanceTokens: 0, inputs: { runtimeId, preambleBytes: preambleTokens * 4, preambleTokens } },
  });
  const mixed = projectMetrics({ events: [dispatch("replay-worker", 9999), dispatch("unmeasured", 4000)], preflight: [payload] });
  assert.deepEqual(
    mixed.workerPreambleTokens,
    { value: { "replay-judge": 0, "replay-worker": 0, unmeasured: 4000 }, direction: "down", count: 3 },
    "a measured runtime never falls back to its recorded guess; an unmeasured one still reports",
  );
});
