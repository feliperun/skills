import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract, resumeRun } from "../src/cli.mjs";

import { fakeCodex, fixture, orphan, packet, withFakeCodex, writeContract } from "./helpers.mjs";
import { nodeState, notifications, withResultFileCodex, withAdvisoryGateCodex } from "./runner-helpers.mjs";
import { invocationResult } from "../src/engine/process.mjs";

test("runs a worker and treats minor judge findings as advisory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-run-"));
  const contract = fixture({
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  });
  const path = writeContract(directory, contract);
  const result = await withAdvisoryGateCodex(directory, () => runContract(path));
  assert.equal(result.ok, true);
  assert.equal(nodeState(result).status, "done");
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /minor advisory/u);
});

test("runs a full contract through the generic exec-jsonl harness end to end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-jsonl-run-"));
  const fake = join(directory, "fake-jsonl.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-jsonl 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.type !== "run.request" || request.schemaVersion !== 1) process.exit(2);
  const judge = request.prompt.startsWith("Review node");
  const result = judge
    ? JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor advisory", findings: [{ severity: "minor", description: "style on [works]", evidence: "line 1" }] })
    : JSON.stringify({ status: "done", summary: "jsonl worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "jsonl-thread" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "message", text: "working" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "jsonl-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 }, costUsd: 0.01 }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "jsonl-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 1);
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.maxSeverity, "minor");
  assert.equal(state.gate?.summary, "minor advisory");
  assert.equal(state.usage?.inputTokens, 10, "worker and judge usage both accrue");
  assert.equal(state.usage?.outputTokens, 4);
  assert.equal(state.usage?.cacheReadInputTokens, 2);
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /minor advisory/u);
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.worker.jsonl")), true, "normalized protocol events are persisted");
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.judge.jsonl")), true, "judge protocol events are persisted");
});

test("blocks a structured blocked_context worker result without invoking a judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-blocked-context-"));
  const path = writeContract(directory, fixture({
    id: "blocked-context-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const result = await withFakeCodex(directory, "blocked-context", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "blocked node records an error");
  assert.equal(state.error.code, "context_missing");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  const artifact = JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8"));
  assert.equal(artifact.nodes[0].error.code, "context_missing");
  assert.deepEqual(artifact.nodes[0].missingContext, ["missing.txt"]);
});

test("discovery blocked_context maps to the blocked terminal state, not an invalid-result retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-discovery-blocked-context-"));
  const path = writeContract(directory, fixture({
    id: "discovery-blocked-context-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "discover",
      type: "backend",
      taskPacket: packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Find the entrypoint" }),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "blocked-context", () => runContract(path));
  const state = nodeState(result, "discover");
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "discovery blocked node records an error");
  assert.equal(state.error.code, "context_missing");
  assert.deepEqual(/** @type {{missingContext: string[]}} */ (state.result).missingContext, ["missing.txt"]);
  assert.equal(state.attempt, 1);
  assert.equal(state.revisions, 0);
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("resume preserves a terminal blocked_context node without re-running or judging it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-blocked-context-"));
  const path = writeContract(directory, fixture({
    id: "resume-blocked-context-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const runDir = await withFakeCodex(directory, "blocked-context", async () => (await runContract(path)).runDir);

  // A provider that would complete the node proves the blocked outcome is not re-executed.
  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "resumed blocked node records an error");
  assert.equal(state.error.code, "context_missing");
  assert.deepEqual(/** @type {{missingContext: string[]}} */ (state.result).missingContext, ["missing.txt"]);
  assert.equal(state.attempt, 1);
  assert.ok(!readdirSync(join(resumed.runDir, "logs")).some((name) => name.includes("judge")));
});

test("worker result with prose before the JSON still parses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-prose-json-"));
  const path = writeContract(directory, fixture({
    id: "prose-json-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "prose-json", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{status: string}} */ (state.result).status, "done");
  assert.deepEqual(
    JSON.parse(readFileSync(join(result.runDir, "results", "build.json"), "utf8")),
    state.result,
    "a valid provider fallback is durably materialized in the run-owned result file",
  );
});

test("canonical worker result file wins over the redundant provider message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-result-file-first-"));
  const path = writeContract(directory, fixture({
    id: "result-file-first-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "file-first", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "from file", "the run-owned file is authoritative over the final message");
});

test("result-only materialization rejects workspace mutation outside its authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-result-mutates-"));
  const path = writeContract(directory, fixture({
    id: "result-mutates-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-mutates", path);
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.match(state.error?.message ?? "", /result materialization changed workspace paths/u);
  assert.equal((state.invocations ?? []).length, 2, "exactly one result-only continuation ran");
});

test("resume adoption treats the canonical result file as primary evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-file-first-"));
  const path = writeContract(directory, fixture({
    id: "resume-file-first-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  // The provider message and its operation settlement both say "worker
  // complete"; the canonical file is rewritten to disagree.
  writeFileSync(join(runDir, "results", "build.json"), JSON.stringify({
    status: "done", summary: "from canonical file", changedFiles: [], verification: [], artifacts: [], missingContext: [],
  }));
  orphan(runDir, "build");

  // With the provider stream intact, adoption must still follow the file.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "from canonical file");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume adoption follows the canonical file when the provider stream is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-file-only-"));
  const path = writeContract(directory, fixture({
    id: "resume-file-only-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(runDir, "results", "build.json"), JSON.stringify({
    status: "done", summary: "from canonical file", changedFiles: [], verification: [], artifacts: [], missingContext: [],
  }));
  // Removing the transcript leaves only the settlement and the file; without
  // the file this would restart completed work instead of adopting it.
  for (const name of readdirSync(join(runDir, "logs"))) {
    if (name.endsWith(".worker.jsonl")) unlinkSync(join(runDir, "logs", name));
  }
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "from canonical file");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume judge recovery surfaces an invalid canonical result file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-judge-invalid-file-"));
  const path = writeContract(directory, fixture({
    id: "resume-judge-invalid-file-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  // The judge completed, but the durable result file is corrupt. Presence is
  // authoritative: judge-phase recovery must not fall back to the worker
  // transcript, which still holds a valid final message.
  writeFileSync(join(runDir, "results", "build.json"), "not the result protocol\n");
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "failed", "the transcript result must not be adopted through judge recovery");
  assert.equal(state.result, null);
  assert.equal(state.revisions, 1, "the invalid durable record consumed the gate revision");
  assert.equal((state.invocations ?? []).length, 3, "the revision retried the worker exactly once");
});

test("resume of an interrupted result materialization adopts the file with strict scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-materialized-"));
  const path = writeContract(directory, fixture({
    id: "resume-materialized-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-file-vs-message", path);
  assert.equal(nodeState(result).status, "done");
  // The controller "crashes" after the one result-only turn: rewind the node
  // to running so resume must recover the materialization invocation itself.
  orphan(result.runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(result.runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "materialized from file", "the canonical file outranks the recovered provider message");
  assert.equal((state.invocations ?? []).length, 2, "recovery schedules no fresh worker");
  assert.equal(state.attempt, 1);
});

test("resume of an interrupted result materialization rejects declared-path mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-materialized-mutation-"));
  const path = writeContract(directory, fixture({
    id: "resume-materialized-mutation-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-file-vs-message", path);
  orphan(result.runDir, "build");
  // README.md is a declared packet write file: the lenient worker check would
  // accept this change, but a result-only turn had no authority to make it.
  // The mutation lands in the recreated attempt worktree, the workspace
  // recovery actually compares against, not the shared repository.
  const workspace = JSON.parse(readFileSync(join(result.runDir, "nodes", "build.json"), "utf8")).worktree.path;
  writeFileSync(join(workspace, "README.md"), "mutated across the recovery window\\n");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(result.runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.match(state.error?.message ?? "", /result materialization changed workspace paths/u);
});

test("resume of a resultless materialization turn fails terminally instead of rerunning the worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-materialized-noop-"));
  const path = writeContract(directory, fixture({
    id: "resume-materialized-noop-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-noop", path);
  assert.equal(nodeState(result).status, "failed");
  assert.equal(nodeState(result).error?.code, "missing_worker_result");
  orphan(result.runDir, "build");

  // A provider that would happily run a generic worker must never be invoked:
  // the single result-only turn was already spent.
  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(result.runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "missing_worker_result");
  assert.equal((state.invocations ?? []).length, 2, "no third invocation was spawned");
  assert.equal(state.attempt, 1);
});

test("a gate revision clears the stale canonical result file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-result-regrind-"));
  const path = writeContract(directory, fixture({
    id: "result-regrind-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { review: "blocking", failOn: ["major", "critical"] } }],
  }));
  const result = await withResultFileCodex(directory, "revision-regrinds", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 1);
  assert.equal(
    /** @type {{summary: string}} */ (state.result).summary,
    "worker attempt 2",
    "the fresh worker attempt must not reuse the previous attempt's result file",
  );
});

test("invalid worker result consumes a bounded revision before failing terminally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-invalid-result-"));
  const path = writeContract(directory, fixture({
    id: "invalid-result-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 1 } }],
  }));
  const result = await withFakeCodex(directory, "prose-retry", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 1);
  assert.equal(state.attempt, 2);
});

test("a spent repair blocks on protocol_failure and raises attention when no failover edge remains", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-invalid-result-terminal-"));
  const path = writeContract(directory, fixture({
    id: "invalid-result-terminal-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await withFakeCodex(directory, "prose-retry", () => runContract(path));
  const state = nodeState(result);
  // One runtime, no revision left: there is nowhere to route the protocol
  // failure, so the node stops visibly rather than filing a quiet exhaustion.
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "invalid worker result records an error");
  assert.equal(state.error.code, "protocol_failure");
  assert.equal(state.revisions, 0);
  assert.equal(state.routing?.history?.length ?? 0, 0, "a blocked protocol failure records no route");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "protocol_failure"));
});

test("a second unparseable worker result takes the failover edge before it blocks with attention", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-protocol-failover-"));
  const first = fakeCodex(directory, "prose-retry");
  const second = fakeCodex(directory, "prose-retry");
  const judge = fakeCodex(directory, "prose-retry");
  const path = writeContract(directory, fixture({
    id: "protocol-failover-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "first", judge: "judge" },
    runtimes: {
      first: { harness: "codex", model: "first", executable: first, fallback: "second" },
      second: { harness: "codex", model: "second", executable: second },
      judge: { harness: "codex", model: "judge", executable: judge, vendor: "openai-judge" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "protocol_failure");
  assert.equal(state.revisions, 0, "a protocol failover never consumes a gate revision");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
  const history = state.routing?.history ?? [];
  assert.equal(history.length, 1, "exactly one edge before the chain is spent");
  assert.equal(history[0].errorCode, "protocol_failure");
  assert.equal(history[0].nextRuntime, "second");
  assert.equal(history[0].hop, 1);
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "protocol_failure"));
});

test("provider diagnostics stay bounded and recovery consumes only a bounded tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-raw-bounded-"));
  const path = writeContract(directory, fixture({ id: "raw-bounded-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "large-output", () => runContract(path));
  const logs = readdirSync(join(result.runDir, "logs"));
  const rawPath = logs.find((name) => name.endsWith(".worker.jsonl"));
  assert.ok(rawPath);
  const raw = readFileSync(join(result.runDir, "logs", rawPath));
  assert.ok(raw.length <= 512 * 1024);
  assert.ok(raw.toString().includes("turn.completed"));
  const boundedInput = `${"x".repeat(700000)}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "tail", changedFiles: [], verification: [], artifacts: [], missingContext: [] }) } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`;
  const recoveryPath = join(directory, "recovery.jsonl");
  writeFileSync(recoveryPath, boundedInput);
  const recovered = invocationResult({ stdoutPath: recoveryPath }, { harness: "codex", model: "test" }, { preferStructured: false });
  assert.ok(recovered, "recovery returns an envelope");
  assert.equal(recovered.status, "done");
});

test("a continuation attempt adopts an existing canonical worker result instead of deleting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-continuation-adopts-"));
  const path = writeContract(directory, fixture({
    id: "continuation-adopts-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  // Rewind to a pending continuation boundary with a valid canonical result
  // already on disk, exactly as if the controller planned a continuation
  // after a completed worker turn.
  const preWritten = { status: "done", summary: "pre-written canonical result", changedFiles: [], verification: [], artifacts: [], missingContext: [] };
  writeFileSync(join(runDir, "results", "build.json"), JSON.stringify(preWritten));
  const nodePath = join(runDir, "nodes", "build.json");
  const persisted = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...persisted,
    status: "pending",
    phase: "worker",
    attempt: 1,
    result: null,
    gate: null,
    error: null,
    verification: null,
  }, null, 2));

  // The continuation attempt fails at the provider, yet the durable result
  // file must survive startWorker and be adopted through the done path.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "pre-written canonical result", "the continuation adopts the existing canonical result");
  assert.equal(
    JSON.parse(readFileSync(join(runDir, "results", "build.json"), "utf8")).summary,
    "pre-written canonical result",
    "startWorker never cleared the valid canonical file",
  );
});
