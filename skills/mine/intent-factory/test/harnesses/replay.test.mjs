import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { harnessCapabilities, normalizeProviderResult, probeRuntime, providerCommand } from "../../src/harnesses/index.mjs";
import { liveInputTokens, liveSessionMetrics, liveUsage } from "../../src/harnesses/exec-jsonl/index.mjs";
import { replayHarness } from "../../src/harnesses/replay/index.mjs";
import { JUDGE_SCHEMA } from "../../src/engine/prompts.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { readIntegrationJournal } from "../../src/repo/integrate.mjs";
import { runRefName } from "../../src/repo/worktree.mjs";

import { fixture, packet, writeContract } from "../helpers.mjs";
import { assertExecutable, envelope, workerResult, writeRecording } from "./replay-helpers.mjs";

const bin = fileURLToPath(new URL("../../src/harnesses/replay/bin.mjs", import.meta.url));
const zeroUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });

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

// The replay adapter itself: capabilities, the recording cursor, containment.
// Runs driven end to end through it are in replay-run.test.mjs.

/** @param {string} repo @param {string} ref @param {string} path @returns {string} */
function showRefFile(repo, ref, path) {
  return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8" });
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
    streamsOutput: false,
  };
  assert.deepEqual(replayHarness.capabilities, expectedCapabilities);
  assert.deepEqual(harnessCapabilities({ harness: "replay" }), expectedCapabilities);
  assert.equal(replayHarness.executable({ harness: "replay", model: "m" }), bin, "the sibling replay/bin.mjs is the default executable");
  assert.equal(replayHarness.executable({ harness: "replay", model: "m", executable: "/tmp/custom-replay" }), "/tmp/custom-replay");
  assert.deepEqual(replayHarness.versionArgs({ harness: "replay", model: "m" }), ["--version"]);
  assert.equal(replayHarness.parseVersion("replay 1.0.0"), "replay 1.0.0");

  const recording = join(mkdtempSync(join(tmpdir(), "replay-command-")), "recording.jsonl");
  const runtime = { harness: "replay", model: "replay-model", executable: bin, config: { "replay.recording": recording } };
  const command = providerCommand(runtime, "prompt with spaces", {
    continuationId: "thread-1",
    schema: JUDGE_SCHEMA,
  });
  assert.equal(command.harness, "replay");
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
  assert.throws(() => providerCommand({ harness: "replay", model: "m", executable: bin }, "p"), /replay\.recording/u);
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

test("replay.probe config carries a simulated version-probe outcome to --replay-probe, distinct reasons for balance and quota", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-probe-"));

  assert.deepEqual(replayHarness.versionArgs({ harness: "replay", model: "m" }), ["--version"]);
  const balanceArgs = replayHarness.versionArgs({
    harness: "replay",
    model: "m",
    config: { "replay.probe": { exitCode: 1, stderr: "Error: Insufficient Balance" } },
  });
  assert.deepEqual(balanceArgs, ["--version", "--replay-probe", JSON.stringify({ exitCode: 1, stderr: "Error: Insufficient Balance" })]);
  assert.throws(
    () => replayHarness.versionArgs({ harness: "replay", model: "m", config: { "replay.probe": "not-an-object" } }),
    /replay\.probe.*must be an object/u,
  );

  const balance = await runBin({ args: balanceArgs, cwd: directory });
  assert.equal(balance.code, 1);
  assert.match(balance.stderr, /Insufficient Balance/u);

  const quotaArgs = replayHarness.versionArgs({
    harness: "replay",
    model: "m",
    config: { "replay.probe": { exitCode: 1, stderr: "Rate limit exceeded. Your limit will reset at 2026-01-01 00:00:00" } },
  });
  const quota = await runBin({ args: quotaArgs, cwd: directory });
  assert.equal(quota.code, 1);
  assert.match(quota.stderr, /reset at 2026-01-01/u);

  const balanceProbe = await probeRuntime({
    harness: "replay",
    model: "m",
    executable: bin,
    config: { "replay.probe": { exitCode: 1, stderr: "Error: Insufficient Balance" } },
  });
  assert.deepEqual(balanceProbe.availability, { available: false, exhaustedUntil: null, reason: "insufficient_balance" });

  const quotaProbe = await probeRuntime({
    harness: "replay",
    model: "m",
    executable: bin,
    config: { "replay.probe": { exitCode: 1, stderr: "Rate limit exceeded. Your limit will reset at 2026-01-01 00:00:00" } },
  });
  assert.deepEqual(quotaProbe.availability, { available: false, exhaustedUntil: "2026-01-01T00:00:00.000Z", reason: "quota_exhausted" });

  const missingProbe = await probeRuntime({
    harness: "replay",
    model: "m",
    executable: join(directory, "does-not-exist-replay-bin"),
  });
  assert.equal(missingProbe.availability?.reason, "not_found");
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

test("recording lines may carry error.resetAt and exhaustedUntil, optionally, and reject the wrong type", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "replay-reset-schema-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-reset-schema-rec-"));

  const withBoth = writeRecording(recordingDir, [{
    envelope: envelope({
      status: "exhausted",
      result: null,
      error: { code: "quota_exhausted", message: "m", resetAt: "2026-09-10T12:00:00.000Z" },
      exhaustedUntil: "2026-09-10T12:00:00.000Z",
    }),
  }], "with-both.jsonl");
  const both = await runBin({ args: ["--recording", withBoth], cwd: workspace, input: "p" });
  assert.equal(both.code, 0, both.stderr);
  const bothEnvelope = /** @type {{error: {resetAt: unknown}, exhaustedUntil: unknown}} */ (parseEnvelopeLine(both.stdout));
  assert.equal(bothEnvelope.error.resetAt, "2026-09-10T12:00:00.000Z");
  assert.equal(bothEnvelope.exhaustedUntil, "2026-09-10T12:00:00.000Z");

  const withoutEither = writeRecording(recordingDir, [{ envelope: envelope() }], "without-either.jsonl");
  const neither = await runBin({ args: ["--recording", withoutEither], cwd: workspace, input: "p" });
  assert.equal(neither.code, 0, neither.stderr);

  const badResetAt = writeRecording(recordingDir, [{
    envelope: envelope({ error: { code: "quota_exhausted", message: "m", resetAt: 123 } }),
  }], "bad-reset-at.jsonl");
  const badReset = await runBin({ args: ["--recording", badResetAt], cwd: workspace, input: "p" });
  assert.equal(badReset.code, 2);
  assert.match(badReset.stderr, /error\.resetAt must be a string or null/u);

  const badExhaustedUntil = writeRecording(recordingDir, [{
    envelope: envelope({ exhaustedUntil: 123 }),
  }], "bad-exhausted-until.jsonl");
  const badExhausted = await runBin({ args: ["--recording", badExhaustedUntil], cwd: workspace, input: "p" });
  assert.equal(badExhausted.code, 2);
  assert.match(badExhausted.stderr, /exhaustedUntil must be a string or null/u);
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

test("normalize keeps error.resetAt and exhaustedUntil in exactly the ProviderEnvelope shape, and still drops unknown fields alongside them", () => {
  const withReset = envelope({
    status: "exhausted",
    result: null,
    error: { code: "quota_exhausted", message: "quota resets shortly", resetAt: "2026-09-10T12:00:00.000Z" },
    exhaustedUntil: "2026-09-10T12:00:00.000Z",
  });
  assert.deepEqual(normalizeProviderResult("replay", JSON.stringify(withReset), 0, null), withReset);

  // A recorded envelope that carries neither field must not grow them: the
  // canonical shape declares both optional, and normalize must not invent an
  // `undefined`-valued key no real harness would ever emit.
  const withoutReset = envelope({ status: "failed", result: null, error: { code: "provider_exhausted", message: "no reset announced" } });
  assert.deepEqual(normalizeProviderResult("replay", JSON.stringify(withoutReset), 0, null), withoutReset);
  assert.ok(!Object.hasOwn(normalizeProviderResult("replay", JSON.stringify(withoutReset), 0, null), "exhaustedUntil"));
  assert.ok(!Object.hasOwn(/** @type {object} */ (normalizeProviderResult("replay", JSON.stringify(withoutReset), 0, null).error), "resetAt"));

  // An explicit null is a real, distinct value on the canonical shape (a
  // provider that carries the field but has nothing to announce), and must
  // survive normalization rather than being dropped like a truly unknown key.
  const explicitNulls = envelope({ error: { code: "provider_exhausted", message: "no reset announced", resetAt: null }, exhaustedUntil: null });
  const normalizedNulls = normalizeProviderResult("replay", JSON.stringify(explicitNulls), 0, null);
  assert.equal(normalizedNulls.exhaustedUntil, null);
  assert.equal(normalizedNulls.error?.resetAt, null);

  // Fields with the wrong type are exactly as invalid as a malformed core
  // field: the whole envelope fails closed rather than silently coercing.
  const badResetAt = { ...envelope(), error: { code: "quota_exhausted", message: "m", resetAt: 12345 } };
  assert.equal(normalizeProviderResult("replay", JSON.stringify(badResetAt), 0, null).error?.code, "invalid_output");
  const badExhaustedUntil = { ...envelope(), exhaustedUntil: 12345 };
  assert.equal(normalizeProviderResult("replay", JSON.stringify(badExhaustedUntil), 0, null).error?.code, "invalid_output");
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
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
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
    runtimes[id] = { harness: "replay", model: `${id}-model`, vendor: `${id}-vendor`, config: { "replay.recording": recording } };
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
      primary: { harness: "replay", model: "primary-model", vendor: "vendor-primary", fallback: "backup", config: { "replay.recording": primaryRecording } },
      backup: { harness: "replay", model: "backup-model", vendor: "vendor-backup", config: { "replay.recording": backupRecording } },
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

test("a quota exhaustion carrying a scheduled reset resumes the same runtime instead of failing over", async () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-quota-reset-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "replay-quota-reset-rec-"));
  // Comfortably inside the node's deadline (2_400s by default), and generous
  // enough that the first worker invocation's own process spawn cannot eat
  // into it: classifyTransition reads resetAt only once the first envelope
  // comes back, and it must still be in the future at that moment for the
  // reset branch (rather than an immediate failover) to fire.
  const resetAt = new Date(Date.now() + 3_000).toISOString();
  const primaryRecording = writeRecording(recordingDir, [
    { envelope: envelope({ status: "exhausted", result: null, error: { code: "quota_exhausted", message: "quota resets shortly", resetAt } }) },
    { envelope: envelope({ result: JSON.stringify(workerResult("build complete after the reset")) }) },
  ], "primary.jsonl");
  const backupRecording = writeRecording(recordingDir, [{
    envelope: envelope({ result: JSON.stringify(workerResult("backup complete")) }),
  }], "backup.jsonl");
  const path = writeContract(directory, fixture({
    id: "replay-quota-reset-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { harness: "replay", model: "primary-model", vendor: "vendor-primary", fallback: "backup", config: { "replay.recording": primaryRecording } },
      backup: { harness: "replay", model: "backup-model", vendor: "vendor-backup", config: { "replay.recording": backupRecording } },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = result.states.get("build");
  assert.equal(state?.status, "done", state?.error?.message);
  assert.deepEqual(
    (state?.invocations ?? []).map((invocation) => invocation.runtimeId),
    ["primary", "primary"],
    "the announced reset waits out the same runtime rather than spending the declared fallback",
  );
  assert.equal(state?.routing?.history?.length, 1);
  assert.equal(state?.routing?.history?.[0]?.nextRuntime, "primary");
  assert.equal(state?.routing?.history?.[0]?.hop, 0, "a reset stays on the current runtime and costs no failover hop");
  assert.equal(state?.routing?.history?.[0]?.errorCode, "quota_exhausted");
  assert.equal(existsSync(`${backupRecording}.cursor`), false, "the fallback runtime was never invoked");
});
