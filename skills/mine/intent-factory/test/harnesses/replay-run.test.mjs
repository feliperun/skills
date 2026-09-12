import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { harnessCapabilities, normalizeProviderResult, probeRuntime, providerCommand } from "../../src/harnesses/index.mjs";
import { liveInputTokens, liveSessionMetrics, liveUsage } from "../../src/harnesses/exec-jsonl/index.mjs";
import { replayHarness } from "../../src/harnesses/replay/index.mjs";
import { JUDGE_SCHEMA } from "../../src/engine/prompts.mjs";
import { projectMetrics, readMetricsSources } from "../../src/campaign/metrics.mjs";
import { runContract, resumeRun } from "../../src/cli.mjs";
import { integrateAttempt, readIntegrationJournal, recoverIntegrations } from "../../src/repo/integrate.mjs";
import { createAttemptWorktree, createRunRef, gitHead, runRefName, sealAttempt } from "../../src/repo/worktree.mjs";

import { fixture, initializeGit, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { captureWorkspaceSnapshot } from "../../src/repo/workspace.mjs";
import { acknowledgeJournalEvent, readJournal } from "../../src/campaign/journal.mjs";
import { campaignDir } from "../../src/campaign/layout.mjs";

const bin = fileURLToPath(new URL("../../src/harnesses/replay/bin.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
const zeroUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });

/**
 * The runner spawns the replay executable directly (never through
 * process.execPath), so replay/bin.mjs must stay executable in git
 * (mode 0o755) for every replay test below to run.
 */
function assertExecutable() {
  assert.ok(existsSync(bin), "replay/bin.mjs must exist");
  assert.notEqual(statSync(bin).mode & 0o111, 0, "replay/bin.mjs must be executable (mode 0o755)");
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

/** @param {string} path @returns {Record<string, unknown>[]} */
function readJsonlRecords(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
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

// The other half of replay.test.mjs: whole runs driven through the replay
// harness -- dependency chains, parallelism, failover, integration.

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
      worker: { harness: "replay", model: "worker-model", vendor: "vendor-worker", config: { "replay.recording": workerRecording } },
      "judge-primary": { harness: "replay", model: "judge-primary-model", vendor: "vendor-judge-primary", fallback: "judge-fallback", config: { "replay.recording": primaryJudgeRecording } },
      "judge-fallback": { harness: "replay", model: "judge-fallback-model", vendor: "vendor-judge-fallback", config: { "replay.recording": fallbackJudgeRecording } },
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
      worker: { harness: "replay", model: "worker-model", vendor: "shared-vendor", config: { "replay.recording": workerRecording } },
      "judge-primary": { harness: "replay", model: "judge-primary-model", vendor: "vendor-judge-primary", fallback: "judge-fallback", config: { "replay.recording": primaryJudgeRecording } },
      "judge-fallback": { harness: "replay", model: "judge-fallback-model", vendor: "shared-vendor", config: { "replay.recording": fallbackJudgeRecording } },
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
 * Every case below is a replay of recorded envelopes through the replay harness
 * — worker and judge alike — so a case can never reach a live provider and two
 * runs of the suite measure the same facts.
 */

const passVerdict = Object.freeze({ verdict: "pass", findings: [], maxSeverity: "none", summary: "ok" });

/** @param {string} id @param {string} text @returns {Record<string, unknown>} */
const provenItem = (id, text) => ({ id, text, proof: { kind: "path", ref: "README.md" } });

/**
 * Drive one contract end to end over the replay harness and return the run, the
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
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
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

/** @param {string} campaignPath @param {string} runsDir @returns {import("../../src/campaign/metrics.mjs").CampaignMetrics} */
function campaignMetrics(campaignPath, runsDir) {
  return projectMetrics(readMetricsSources(campaignPath, { runsDir }));
}

/** @typedef {{repo: string, runDir: string, id: string, head: string|null}} IntegrationFixture */
/**
 * @typedef {{
 *   verifyCandidate?: import("../../src/repo/integrate.mjs").CandidateVerifier,
 *   onAccepted?: import("../../src/repo/integrate.mjs").AcceptedCallback,
 *   onVerificationFailure?: import("../../src/repo/integrate.mjs").VerificationFailureCallback,
 *   onConflict?: import("../../src/repo/integrate.mjs").AcceptedCallback,
 *   onConcurrentMove?: import("../../src/repo/integrate.mjs").ConcurrentMoveCallback,
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

test("a retried attempt continues from the previous attempt's sealed sha instead of the integration head", async () => {
  const fixture = integrationFixture("continue-after-verification-failure");
  const first = await integrateFixtureAttempt(fixture, "build", 1, (workspace) => writeFileSync(join(workspace, "first.txt"), "first\n"), {
    verifyCandidate: async () => ({ passed: false, error: "candidate failed" }),
  });
  assert.equal(first.status, "verification_failed", "the failed candidate never moves the run ref");
  assert.equal(first.sealed.empty, false);

  const worktree2 = createAttemptWorktree({
    repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "build", attempt: 2, base: first.sealed.sha,
  });
  assert.equal(worktree2.baseSha, first.sealed.sha, "the second attempt's base is the first attempt's sealed sha, not the run ref tip");
  assert.equal(readFileSync(join(worktree2.path, "first.txt"), "utf8"), "first\n", "the second attempt starts from the first attempt's sealed edit");
  writeFileSync(join(worktree2.path, "second.txt"), "second\n");
  const sealed2 = sealAttempt({ repo: fixture.repo, path: worktree2.path, baseSha: worktree2.baseSha, runId: fixture.id, nodeId: "build", attempt: 2 });
  const result2 = await integrateAttempt({
    repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "build", attempt: 2,
    attemptSha: sealed2.sha, branch: worktree2.branch, verificationEvidence: { passed: true },
    verifyCandidate: async () => ({ passed: true }),
  });
  assert.ok(result2);
  assert.equal(result2.status, "accepted");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "first.txt"), "first\n", "the accepted candidate carries the continued attempt's whole history");
  assert.equal(showRefFile(fixture.repo, runRefName(fixture.id), "second.txt"), "second\n");
});

test("an attempt that sealed nothing leaves the next attempt cut from the integration head", () => {
  const fixture = integrationFixture("no-continuation-when-empty");
  const { sealed } = sealFixtureAttempt(fixture, "build", 1);
  assert.equal(sealed.empty, true, "an attempt with no edits seals empty");
  const worktree2 = createAttemptWorktree({ repo: fixture.repo, runDir: fixture.runDir, runId: fixture.id, nodeId: "build", attempt: 2 });
  assert.equal(worktree2.baseSha, gitHead(fixture.repo, runRefName(fixture.id)), "with nothing sealed, the next attempt is cut from the run ref tip as before");
});

test("an attempt worktree links the repository's node_modules as a symlink, and the workspace snapshot excludes it", () => {
  const repo = mkdtempSync(join(tmpdir(), "node-modules-symlink-git-"));
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  initializeGit(repo);
  const runId = "node-modules-symlink";
  const runDir = join(repo, ".runs", runId);
  mkdirSync(runDir, { recursive: true });
  createRunRef(repo, runId, gitHead(repo));
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = () => {};\n");

  const worktree = createAttemptWorktree({ repo, runDir, runId, nodeId: "build", attempt: 1 });
  const linkPath = join(worktree.path, "node_modules");
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true, "node_modules is linked, never copied");
  assert.equal(readFileSync(join(linkPath, "left-pad", "index.js"), "utf8"), "module.exports = () => {};\n", "the linked tree is readable through the symlink");

  const snapshot = captureWorkspaceSnapshot(worktree.path);
  assert.ok(
    !snapshot.entries.some((entry) => entry.path === "node_modules" || entry.path.startsWith("node_modules/")),
    "the workspace snapshot never captures node_modules, symlinked or not, and never reports it as a symlink escape",
  );
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
  const events = readJsonlRecords(join(replayed.outcome.runDir, "events.jsonl"));
  assert.deepEqual(events.filter((event) => event.phase === "judge"), [], "three closed checkpoints, zero judge dispatches");
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

test("D27: a complete replayed campaign notifies once per terminal node plus once for the run, all delivered", async () => {
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
  const notifications = readJsonlRecords(join(replayed.outcome.runDir, "notify.jsonl"));
  assert.ok(notifications.length > 0, "the run recorded notify receipts");
  assert.deepEqual(notifications.filter((record) => record.status !== "delivered"), [], "the suite's no-op transport delivers every receipt");
  assert.deepEqual(new Set(notifications.map((record) => record.type)), new Set(["node.terminal", "run.terminal"]), "a clean run never raises attention");
  const metrics = campaignMetrics(replayed.campaignPath, replayed.runsDir);
  assert.deepEqual(
    metrics.notifyReceiptRate,
    { value: 1, direction: "up", count: notifications.length },
    "every notified event settled (delivered) on its first attempt",
  );
});

test("D32: notify.jsonl bounds retries against a failing transport, and sync/ack use journal event ids", async () => {
  assertExecutable();
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
  const receipts = readJsonlRecords(join(replayed.outcome.runDir, "notify.jsonl"));
  assert.ok(receipts.length > 0, "the run appended notify receipts");
  assert.deepEqual(receipts.filter((record) => record.status !== "failed"), [], "a failing transport never marks a receipt delivered");
  /** @type {Map<string, number>} */
  const attemptsByEvent = new Map();
  for (const receipt of receipts) {
    const key = `${receipt.type}:${receipt.runId}:${receipt.nodeId ?? ""}`;
    attemptsByEvent.set(key, (attemptsByEvent.get(key) ?? 0) + 1);
  }
  for (const [key, count] of attemptsByEvent) assert.ok(count <= 3, `${key} exceeded the bounded retry budget: ${count}`);

  const sync = spawnSync(process.execPath, [runner, "campaign", "sync", "test-campaign", "--cwd", replayed.directory, "--session-id", "d32"], { encoding: "utf8" });
  assert.equal(sync.status, 0, sync.stderr);
  assert.ok(Buffer.byteLength(sync.stdout, "utf8") <= 8000, `sync printed ${Buffer.byteLength(sync.stdout, "utf8")} bytes`);
  const cursorPath = join(replayed.campaignPath, "watch-cursors", "session-d32.json");
  assert.equal(existsSync(cursorPath), false, "sync is a read: only ack writes the cursor");

  const newestEntry = readJournal(replayed.campaignPath).at(-1);
  assert.ok(newestEntry, "the campaign journal recorded at least one event");
  const ack = spawnSync(process.execPath, [runner, "campaign", "ack", "test-campaign", "--cwd", replayed.directory, "--session-id", "d32", "--event-id", newestEntry.eventId], { encoding: "utf8" });
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(JSON.parse(readFileSync(cursorPath, "utf8")).eventId, newestEntry.eventId, "ack advanced the durable cursor");
  const afterAck = readFileSync(cursorPath, "utf8");
  assert.deepEqual(
    acknowledgeJournalEvent(replayed.campaignPath, "session-d32", newestEntry.eventId),
    { cursorId: "session-d32", at: newestEntry.at, eventId: newestEntry.eventId },
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
  // eval set nothing and stays deterministic. `metrics` no longer reads
  // `preflight.json` (TECH-SPEC lean section 6 sources are usage.jsonl, node
  // state, notify.jsonl, events.jsonl and the journal), so this checks only
  // the preflight command's own reporting.
  assert.equal(readFileSync(`${replayed.workerRecording}.cursor`, "utf8"), "1\n");
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
    symlinkSync(fixture.repo, join(workspace, "node_modules"));
  });
  assert.equal(sealed.empty, false, "the attempt carries the README change");
  const files = execFileSync("git", ["-C", worktree.path, "show", "--name-only", "--format=", sealed.sha], { encoding: "utf8" }).trim().split("\n");
  assert.ok(files.includes("README.md"));
  assert.ok(!files.some((file) => file.startsWith(".runs/")), "the ignored sidecar is never committed");
  assert.ok(!files.includes("node_modules"), "the node_modules link is never committed");
});
