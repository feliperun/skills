import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runContract, resumeRun } from "../../src/cli.mjs";
import { fakeCodex, fixture, initializeGit, orphan, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState, persistFailure, promptLoggingCodex, withCodexBinary, runMetadata, recoveryDecisions, retryJudgeCodex } from "../runner-helpers.mjs";



test("resume keeps the bounded wall-clock budget of a node that exhausted it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-double-"));
  const path = writeContract(directory, fixture({ id: "double-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "exhausted",
    error: { code: "wall_clock_timeout", message: "worker ran longer than 2400s" },
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  const stored = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].timeoutSec, undefined, "the original contract remains immutable");
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).executionOverrides?.some(/** @param {Record<string, unknown>} item */ (item) => item.kind === "timeout"), false, "resume does not create an automatic timeout override");
});


test("resume removes a stale findings.json after driving the run to done", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-resume-"));
  const path = writeContract(directory, fixture({
    id: "findings-resume-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }],
      // Blocking is what exhausts the run: the advisory default would settle
      // the rejected node done and leave no artifact for the resume to clear.
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "critical", async () => (await runContract(path)).runDir);
  assert.equal(existsSync(join(runDir, "findings.json")), true, "the exhausted run wrote the artifact");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(existsSync(join(runDir, "findings.json")), false, "a done run leaves no stale artifact");
});


test("resume re-dispatches a capped live continuation as a fresh attempt in a fresh worktree", async () => {
  // Attempt isolation (TECH-SPEC lean v0.3, F23) ties continuation identity to
  // the attempt's own worktree: a timed-out invocation's continuation never
  // survives into the next attempt's fresh worktree, so resume re-dispatches
  // it as attempt plus one instead of resuming the capped provider session.
  const directory = mkdtempSync(join(tmpdir(), "runner-live-continuation-"));
  const path = writeContract(directory, fixture({
    id: "live-continuation-run",
    // A generous wall-clock budget, not the minimal 1s: the fake's progress
    // burst must finish writing its usage-bearing turn.failed line well
    // before the cap fires even when the host is under load, or the kill
    // races the write and the invocation's usage is backfilled as null.
    timeoutSec: 3,
    pollIntervalMs: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "thread-large-timeout");
  try {
    const first = await runContract(path);
    const firstState = nodeState(first);
    assert.equal(firstState.status, "exhausted");
    assert.equal(firstState.invocations?.[0]?.continuationId, "fake-thread");
    assert.deepEqual(firstState.invocations?.[0]?.usage, { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 1 });
    const firstUsage = readFileSync(join(first.runDir, "usage.jsonl"), "utf8").trim().split("\n");
    assert.equal(firstUsage.length, 1, "timeout usage reaches usage.jsonl");
    const resumed = await resumeRun(first.runDir);
    const resumedState = nodeState(resumed);
    assert.equal(resumedState.status, "done");
    assert.equal(resumedState.attempt, 2, "the capped invocation is re-dispatched as attempt plus one");
    assert.equal(resumedState.invocations?.at(-1)?.continuationMode, "fresh", "the new attempt's worktree starts a fresh session, never a resume");
    const finalUsage = readFileSync(join(first.runDir, "usage.jsonl"), "utf8").trim().split("\n");
    assert.equal(finalUsage.length, 2, "resumed invocation is recorded once");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});


test("resume re-judges a judge_unavailable node instead of re-dispatching a worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-judge-unavailable-"));
  const path = writeContract(directory, fixture({
    id: "retry-judge-unavailable-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const provider = retryJudgeCodex(directory);
  const blocked = await withCodexBinary(provider, () => runContract(path));
  const state = nodeState(blocked);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.error?.code, "judge_unavailable");
  const workerTurns = (state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length;
  assert.equal(workerTurns, 1);

  // The same provider now answers with one verdict: the resume re-judges the
  // preserved work instead of spending a second worker attempt on it.
  const resumed = await withCodexBinary(provider, () => resumeRun(blocked.runDir));
  const after = nodeState(resumed);
  assert.equal(after.status, "done", after.error?.message);
  assert.equal((after.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, workerTurns, "the worker is never re-run");
  assert.equal(after.attempt, 1, "a re-judge is adoption, not a new attempt");
  assert.equal(after.previousAttempt, undefined, "a re-judge carries no previous-attempt section");
  assert.equal(resumed.ok, true);
});


test("resume retries a failed node as attempt 2 with a bounded previous attempt section", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-attempt-two-"));
  const path = writeContract(directory, fixture({
    id: "retry-attempt-two-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: ["false"] }] }),
      gate: false,
    }],
  }));
  const failed = await withFakeCodex(directory, "worker-fail", () => runContract(path));
  assert.equal(nodeState(failed).status, "failed");
  assert.equal(nodeState(failed).attempt, 1);
  // A provider-level failure never reaches verification; patch in the shape a
  // real declared-command failure would have persisted, to prove the section
  // names the failing command when one is on disk.
  const nodePath = join(failed.runDir, "nodes", "build.json");
  const persistedNode = JSON.parse(readFileSync(nodePath, "utf8"));
  persistedNode.verification = {
    passed: false,
    completed: true,
    commands: [{ argv: ["false"], passed: false, attempts: [{ passed: false, stdout: "", stderr: "", error: null, exitCode: 1, signal: null, timedOut: false, durationMs: 1 }] }],
  };
  writeFileSync(nodePath, JSON.stringify(persistedNode, null, 2));

  const provider = promptLoggingCodex(directory);
  const resumed = await withCodexBinary(provider.executable, () => resumeRun(failed.runDir));
  const after = nodeState(resumed);
  assert.equal(after.attempt, 2, "the retry is attempt plus one");
  assert.equal(after.revisions, 0, "the gate-rejection counter is not touched by a retry");
  const section = /** @type {string} */ (after.previousAttempt);
  assert.ok(section.startsWith("## Previous attempt"), "the section carries the heading");
  assert.match(section, /Attempt 1 failed; this is attempt 2/u);
  assert.match(section, /Error: provider_error/u);
  assert.match(section, /Failing verification:\n- false/u, "the failing verification command is named");
  assert.ok(Buffer.byteLength(section, "utf8") <= 8 * 1024, "the whole section stays within 8 KiB");
  const prompt = readFileSync(provider.log, "utf8");
  assert.match(prompt, /## Previous attempt[\s\S]*Error: provider_error/u, "the regenerated worker prompt carries the section");
});


test("resume retries stalled and canceled nodes in place", async () => {
  for (const [status, code] of [["stalled", "progress_stalled"], ["canceled", "canceled"]]) {
    const directory = mkdtempSync(join(tmpdir(), `retry-${status}-`));
    const path = writeContract(directory, fixture({ id: `retry-${status}-run`, pollIntervalMs: 10 }));
    const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
    persistFailure(runDir, "build", { status, code });
    const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
    const state = nodeState(resumed);
    assert.equal(state.status, "done", state.error?.message);
    assert.equal(state.attempt, 2, `a ${status} node is re-dispatched as attempt plus one`);
    assert.match(/** @type {string} */ (state.previousAttempt), new RegExp(`Error: ${code}`, "u"), `the ${status} failure travels with the retry`);
  }
});


test("resume retries a dependency_failed node once its dependency is retried", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-dependency-"));
  const path = writeContract(directory, fixture({
    id: "retry-dependency-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet({ objective: "First" }), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Second" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const failed = await withFakeCodex(directory, "worker-fail", () => runContract(path));
  assert.equal(nodeState(failed, "first").status, "failed");
  assert.equal(nodeState(failed, "second").status, "blocked");
  assert.equal(nodeState(failed, "second").error?.code, "dependency_failed");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(failed.runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed, "first").status, "done");
  assert.equal(nodeState(resumed, "first").attempt, 2);
  assert.equal(nodeState(resumed, "second").status, "done");
  assert.equal(nodeState(resumed, "second").attempt, 1, "the dependant is dispatched for its first attempt");
  assert.equal(nodeState(resumed, "second").previousAttempt, undefined, "a node that never ran carries no failure");
});


test("resume --node limits the retry to the node and the nodes that depend on it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-node-target-"));
  const path = writeContract(directory, fixture({
    id: "retry-node-target-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet({ objective: "Alpha" }), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ objective: "Beta" }), gate: false },
      { id: "gamma", type: "backend", taskPacket: packet({ objective: "Gamma" }), dependsOn: ["beta"], gate: false },
    ],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  // alpha is an unrelated failure elsewhere in the same run, not a dependency
  // of the targeted node: it must stay untouched by a `--node beta` retry.
  persistFailure(runDir, "alpha", { status: "failed", code: "provider_error", attempt: 1 });
  persistFailure(runDir, "beta", { status: "failed", code: "provider_error", attempt: 1 });
  persistFailure(runDir, "gamma", { status: "blocked", code: "dependency_failed", blockedBy: ["beta"] });

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir, { node: "beta" }));
  const alpha = nodeState(resumed, "alpha");
  assert.equal(alpha.status, "failed", "a node outside the target keeps its failure");
  assert.equal(alpha.attempt, 1, "no attempt is spent outside the target");
  assert.equal(nodeState(resumed, "beta").status, "done", "the targeted node is retried");
  assert.equal(nodeState(resumed, "beta").attempt, 2);
  assert.equal(nodeState(resumed, "gamma").status, "done", "a dependant of the target is retried with it");
  assert.equal(resumed.ok, false, "the untouched failure keeps the run in attention");
});


test("resume leaves unknown_effect_reconciled alone and retries it only with --reconcile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-reconcile-"));
  const path = writeContract(directory, fixture({ id: "retry-reconcile-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  persistFailure(runDir, "build", { status: "blocked", code: "unknown_effect_reconciled" });

  const left = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(left).status, "blocked", "the stop boundary holds without the flag");
  assert.equal(nodeState(left).error?.code, "unknown_effect_reconciled");
  assert.equal(nodeState(left).attempt, 1, "the boundary is not crossed by an ordinary resume");
  assert.ok(!recoveryDecisions(runDir).includes("reconcile_acknowledged"), "no acknowledgement is invented");

  const reconciled = await withFakeCodex(directory, "pass", () => resumeRun(runDir, { reconcile: "build" }));
  assert.equal(nodeState(reconciled).status, "done", nodeState(reconciled).error?.message);
  assert.ok(recoveryDecisions(runDir).includes("reconcile_acknowledged"), "the acknowledgement is recorded in events.jsonl");
});


test("resume accepts a descendant head and records it on the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-descendant-head-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "retry-descendant-head-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const recorded = runMetadata(runDir).sourceIdentity.gitHead;
  assert.ok(recorded, "the run records the head it started from");
  orphan(runDir, "build");
  // A worker or the orchestrator committed between attempts: the branch moved
  // on from the recorded head, which is what a retry in place expects.
  execFileSync("git", ["-C", work, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "committed between attempts"]);
  const head = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.notEqual(head, recorded);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(runMetadata(runDir).sourceIdentity.gitHead, head, "the new head is recorded on the run");
});
