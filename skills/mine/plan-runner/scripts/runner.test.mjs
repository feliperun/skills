import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  renderFindings,
  renderReport,
  renderStatus,
  validateContract,
} from "./lib.mjs";
import { renderStatusJson } from "./render.mjs";
import { cancelRun, preflightContract, runContract, resumeRun } from "./runner.mjs";
import { invocationAlive, invocationResult, processStartToken } from "./supervisor.mjs";
import { captureWorkspaceSnapshot } from "./verification.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, bootstrapPath, cleanupBootstrapAttempts } from "./store.mjs";
import {
  closeResult,
  fakeCodex,
  fixture,
  initializeGit,
  orphan,
  packet,
  readStatus,
  waitForValue,
  withFakeAgy,
  withFakeCodex,
  writeContract,
} from "../test/helpers.mjs";

/** @param {import("./runner.mjs").RunOutcome} result @param {string} [id] @returns {import("./contract.mjs").NodeSnapshot} */
function nodeState(result, id = "build") {
  const state = result.states.get(id);
  if (!state) throw new Error(`missing node state for ${id}`);
  return state;
}

/** @param {import("node:child_process").ChildProcess} child @returns {number} */
function childPid(child) {
  if (child.pid === undefined) throw new Error("child pid unavailable");
  return child.pid;
}

test("runs the CLI through an installed symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-symlink-"));
  const contractPath = writeContract(directory, fixture());
  const link = join(directory, "runner-link.mjs");
  symlinkSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, "validate", contractPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "valid\n");
});

test("doctor checks repository prerequisites without mutating anything", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  const payload = /** @type {{schemaVersion: number, ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  const names = payload.checks.map((check) => check.name);
  assert.ok(names.includes("git repository"));
  assert.ok(names.includes(".runs ignored"));
  const runsIgnored = payload.checks.find((check) => check.name === ".runs ignored");
  assert.ok(runsIgnored, ".runs ignored check present");
  assert.equal(runsIgnored.ok, true);
  assert.equal(payload.checks.some((check) => check.detail.includes("required by contract")), false, "no contract means no required driver");
  assert.equal(readdirSync(directory).sort().join(","), ".git,.gitignore", "doctor creates no run state");
});

test("doctor does not fail a driver resolved through an explicit executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-override-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const worker = join(directory, "my-worker.mjs");
  writeFileSync(worker, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('my-worker 1.0.0');\n");
  chmodSync(worker, 0o755);
  const contract = join(directory, "contract.json");
  writeFileSync(contract, `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    id: "doctor-run",
    campaignId: "doctor-campaign",
    goal: "doctor",
    cwd: ".",
    runtimeDefaults: { worker: "wrapped", judge: "wrapped" },
    runtimes: { wrapped: { driver: "exec-jsonl", model: "m", executable: "./my-worker.mjs" } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", dependsOn: [], taskPacket: packet(), gate: false }],
  })}\n`);
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory, contract], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const payload = /** @type {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.ok, true);
  const binaryCheck = payload.checks.find((check) => check.name === "binary exec-jsonl");
  assert.ok(binaryCheck, "exec-jsonl binary check present");
  assert.equal(binaryCheck.ok, true);
  assert.match(binaryCheck.detail, /override/u);
});

test("status --json and report --json emit stable machine-readable output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-json-status-"));
  const path = writeContract(directory, fixture({
    id: "json-status-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const status = spawnSync(process.execPath, [cli, "status", "--json", runDir], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.schemaVersion, 1);
  assert.equal(statusPayload.run, "json-status-run");
  assert.equal(statusPayload.leaseHealthy, false);
  assert.equal(statusPayload.nodes[0].status, "done");
  const report = spawnSync(process.execPath, [cli, "report", "--json", runDir], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  const reportPayload = JSON.parse(report.stdout);
  assert.equal(reportPayload.schemaVersion, 1);
  assert.equal(reportPayload.totals.inputTokens, 10);
  assert.equal(reportPayload.nodes[0].revisions, 0);
});

test("cancel subcommand terminates a stale running node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-cli-"));
  const path = writeContract(directory, fixture({
    id: "cancel-cli-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "cancel", runDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const node = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(node.status, "canceled");
  assert.equal(readFileSync(join(runDir, "cancel.request.json"), "utf8").length > 0, true);
});

test("run --detach leaves a controller that outlives the invoker and completes the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-detach-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", "--detach", contractPath], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/\[run\] ([a-z0-9-]+) detached · pid (\d+) · (.+)/u);
  assert.ok(match, result.stdout);
  assert.equal(match[1], contract.id);
  assert.equal(match[3], runDir);
  const pid = Number(match[2]);
  try {
    // The invoker is already gone; the controller must still be alive while the run is in flight.
    const alive = await waitForValue(() => {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch {
        return readStatus(nodePath) === "done" ? "done" : null;
      }
    }, 10_000);
    assert.ok(alive === "alive" || alive === "done", `detached controller died while the run was in flight: ${alive}`);
    assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
    assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).pid, pid);
  } finally {
    cleanupBootstrapAttempts(runDir);
    const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    if (invocationAlive({ pid, processStartToken: metadata.processStartToken })) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});

test("resume --detach restarts a failed node through a detached controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-detach-resume-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  await withFakeCodex(directory, "worker-fail", () => runContract(contractPath));
  assert.equal(readStatus(nodePath), "failed");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[resume\] detached · pid \d+ · .*/u);
  assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
});

test("runs a worker and treats minor judge findings as advisory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-run-"));
  const contract = fixture({
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: ["It works"],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  });
  const path = writeContract(directory, contract);
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory);
  try {
    const result = await runContract(path);
    assert.equal(result.ok, true);
    assert.equal(nodeState(result).status, "done");
    assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /minor advisory/u);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("runs a full contract through the generic exec-jsonl driver end to end", async () => {
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
    ? JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor advisory", findings: [{ severity: "minor", description: "style", evidence: "line 1" }] })
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
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
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

test("invalid worker result without revisions fails terminally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-invalid-result-terminal-"));
  const path = writeContract(directory, fixture({
    id: "invalid-result-terminal-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await withFakeCodex(directory, "prose-retry", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "invalid worker result records an error");
  assert.equal(state.error.code, "invalid_worker_result");
  assert.equal(state.revisions, 0);
});

test("fails deterministic verification before the judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-fail-"));
  const path = writeContract(directory, fixture({
    id: "verification-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }), gate: {} }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  assert.ok(state.verification, "verification state persisted");
  assert.ok(state.verification.commands, "verification commands persisted");
  assert.equal(state.verification.commands[0].attempts.length, 2);
  assert.equal(state.verification.completed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  assert.equal(state.verification.attempts.length, 2);
  assert.equal(new Set(state.verification.attempts.map((attempt) => attempt.invocationId)).size, 2);
  assert.ok(state.verification.attempts.every((attempt) => attempt.status === "failed" && Number.isInteger(attempt.pid) && Number.isInteger(attempt.processGroupId)));
  assert.equal(state.attempt, 2);
  assert.equal(state.revisions, 1);
  assert.ok(state.gate, "verification failure still records a gate");
  assert.equal(state.gate.verdict, "fail");
  assert.equal(state.gate.maxSeverity, "critical");
  assert.match(state.gate.findings[0].evidence, /exit=2/u);
});

test("oversized judge prompt fails before judge spawn or persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-prompt-cap-"));
  const path = writeContract(directory, fixture({
    id: "judge-prompt-cap-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", definitionOfDone: ["x".repeat(2 * 1024)].concat(Array.from({ length: 40 }, () => "y".repeat(2 * 1024))), taskPacket: packet(), gate: {} }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "judge prompt cap records an error");
  assert.equal(state.error.code, "judge_prompt_too_large");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0);
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
  const recovered = invocationResult({ stdoutPath: recoveryPath }, { driver: "codex", model: "test" }, { preferStructured: false });
  assert.ok(recovered, "recovery returns an envelope");
  assert.equal(recovered.status, "done");
});

test("fails closed on unexpected writes and preserves pre-existing dirt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-"));
  writeFileSync(join(directory, "preexisting.txt"), "keep me\n");
  const path = writeContract(directory, fixture({
    id: "scope-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "unexpected write records an error");
  assert.equal(state.error.code, "unexpected_write");
  assert.ok(state.scope, "scope snapshot persisted");
  assert.ok(state.scope.unexpectedPaths.includes("unexpected.txt"));

  const cleanDirectory = mkdtempSync(join(tmpdir(), "runner-scope-clean-"));
  writeFileSync(join(cleanDirectory, "preexisting.txt"), "keep me\n");
  const cleanPath = writeContract(cleanDirectory, fixture({
    id: "scope-clean-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const clean = await withFakeCodex(cleanDirectory, "pass", () => runContract(cleanPath));
  assert.equal(nodeState(clean).status, "done");
});

test("rejects parallel execution until isolation exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-max-parallel-"));
  const path = writeContract(directory, fixture({ maxParallel: 2 }));
  assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /maxParallel must be 1/u);
});

test("marks a silent provider stalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-stall-"));
  mkdirSync(join(directory, "work"));
  writeFileSync(join(directory, "work", "README.md"), "read me");
  const path = writeContract(directory, fixture({
    id: "stall-run",
    cwd: "work",
    pollIntervalMs: 10,
    stallTimeoutSec: 0.05,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"] }), gate: false }],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "silent");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(nodeState(result).status, "stalled");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("preserves the worker report when the judge provider fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-fail-"));
  const path = writeContract(directory, fixture({
    id: "judge-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "judge-fail");
  try {
    const result = await runContract(path);
    const state = nodeState(result);
    assert.equal(state.status, "failed");
    assert.equal(state.phase, "judge");
    assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("enforces the wall-clock cap even while output changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-"));
  const path = writeContract(directory, fixture({
    id: "timeout-run",
    pollIntervalMs: 10,
    stallTimeoutSec: 1,
    timeoutSec: 0.05,
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "heartbeat");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result).status, "exhausted");
    const timedOut = nodeState(result);
    assert.ok(timedOut.error, "timeout records an error");
    assert.equal(timedOut.error.code, "wall_clock_timeout");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("spends the wall-clock budget per phase, not per node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-budget-"));
  const path = writeContract(directory, fixture({
    id: "phase-budget-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  // The worker takes 3.5s of a 5s budget. A node-wide clock leaves the judge
  // 1.5s for work that needs 2s and kills a healthy reviewer.
  const result = await withFakeCodex(directory, "slow", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.ok(state.gate, "judge gate recorded");
  assert.equal(state.gate.summary, "minor advisory");
});

test("bounds gate retries and reports exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-retry-"));
  const path = writeContract(directory, fixture({
    id: "retry-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      gate: { failOn: ["critical"], maxRevisions: 1 },
    }],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(nodeState(result).status, "exhausted");
    assert.equal(nodeState(result).attempt, 2);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("resume adopts an orphaned worker result instead of repeating the work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-"));
  const path = writeContract(directory, fixture({ id: "resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  // A provider that fails every worker call proves the result came from the orphaned log.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "worker complete");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume refuses a driver that was known but is now unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-driver-drift-"));
  const path = writeContract(directory, fixture({ id: "resume-driver-drift-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  await assert.rejects(
    () => withFakeCodex(directory, "version-fail", () => resumeRun(runDir)),
    /source drift detected in driverVersions/u,
  );
});

test("resume permits worker edits only to packet write files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-write-boundary-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "resume-write-boundary-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "write-allowed", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
});

test("resume rejects source drift outside packet write files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-unexpected-drift-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "resume-unexpected-drift-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(work, "unexpected.txt"), "not in packet\n");
  orphan(runDir, "build");
  await assert.rejects(() => withFakeCodex(directory, "worker-fail", () => resumeRun(runDir)), /source drift detected in dirtyTreeFingerprint/u);
});

test("resume adopts a completed orphan judge without running it twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-gate-"));
  const path = writeContract(directory, fixture({
    id: "resume-gate-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
  assert.ok(state.gate, "adopted gate recorded");
  assert.equal(state.gate.summary, "minor advisory");
  assert.equal(existsSync(join(runDir, "logs", "build.1.judge.r2.jsonl")), false, "a completed judge must be adopted once");
});

test("invalid orphan judge output is rejudged without charging worker usage twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-invalid-judge-"));
  const path = writeContract(directory, fixture({
    id: "resume-invalid-judge-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{invocations: Array<{id: string, phase: string, stdoutPath: string}>}} */
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const judgeInvocation = state.invocations.at(-1);
  assert.ok(judgeInvocation, "persisted judge invocation exists");
  writeFileSync(judgeInvocation.stdoutPath, "not a structured judge result\n");
  writeFileSync(nodePath, JSON.stringify({ ...state, status: "running", phase: "judge" }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 30, "worker usage is not added again while rejudging");
  assert.ok(final.executionOverrides, "execution overrides persisted");
  assert.equal(final.executionOverrides.filter((item) => item.invocationId === judgeInvocation.id).length, 1);
  const resumedAgain = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const finalAgain = nodeState(resumedAgain);
  assert.ok(finalAgain.usage, "usage persisted on second resume");
  assert.equal(finalAgain.usage.inputTokens, 30, "a second resume does not charge the orphan judge again");
});

test("invalid orphan judge usage survives a full worker restart exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-invalid-restart-"));
  const path = writeContract(directory, fixture({
    id: "resume-invalid-restart-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{invocations: Array<{id: string, phase: string, stdoutPath: string, usage?: unknown}>}} */
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const judgeInvocation = state.invocations.at(-1);
  const workerInvocation = state.invocations.find((invocation) => invocation.phase === "worker");
  assert.ok(judgeInvocation && workerInvocation, "persisted judge and worker invocations exist");
  writeFileSync(workerInvocation.stdoutPath, "not a provider stream\n");
  writeFileSync(judgeInvocation.stdoutPath, [
    { type: "thread.started", thread_id: "orphan-judge" },
    { type: "item.completed", item: { type: "agent_message", text: "not a structured verdict" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  const { usage: _judgeUsage, ...judgeWithoutUsage } = judgeInvocation;
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "judge",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
    invocations: state.invocations.map((invocation) => invocation.id === judgeInvocation.id ? judgeWithoutUsage : invocation),
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 2, "an unusable worker forces a full worker restart");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 40, "the orphan judge usage is charged before the replacement worker");
  assert.ok(final.executionOverrides, "execution overrides persisted");
  assert.equal(final.executionOverrides.filter((item) => item.invocationId === judgeInvocation.id).length, 1);
  const resumedAgain = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const finalAgain = nodeState(resumedAgain);
  assert.ok(finalAgain.usage, "usage persisted on second resume");
  assert.equal(finalAgain.usage.inputTokens, 40, "the second resume does not charge the judge again");
});

test("resume restarts a node with no usable worker output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-restart-"));
  const path = writeContract(directory, fixture({ id: "resume-restart-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 2);
});

test("simultaneous resumes allow one controller and reject the other", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-concurrent-resume-"));
  const path = writeContract(directory, fixture({ id: "concurrent-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const slow = fakeCodex(directory, "slow");
  const first = spawn(process.execPath, [runner, "resume", runDir], {
    env: { ...process.env, PLAN_RUNNER_CODEX_BIN: slow },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForValue(() => {
      try {
        return JSON.parse(readFileSync(join(runDir, "controller-lease.json"), "utf8")).pid === first.pid ? "held" : null;
      } catch {
        return null;
      }
    }, 5_000);
    const second = spawn(process.execPath, [runner, "resume", runDir], {
      env: { ...process.env, PLAN_RUNNER_CODEX_BIN: fakeCodex(directory, "pass") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [firstResult, secondResult] = await Promise.all([closeResult(first), closeResult(second)]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.notEqual(secondResult.code, 0, secondResult.stderr);
    assert.match(secondResult.stderr, /lease/u);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    try { first.kill("SIGKILL"); } catch {}
  }
});

test("cancelRun confirms controller death and terminates every recorded provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-confirmation-"));
  const path = writeContract(directory, fixture({ id: "cancel-confirmation-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const controller = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const invocation = {
    id: "cancel-provider",
    pid: childPid(provider),
    processGroupId: process.platform === "win32" ? null : childPid(provider),
    processStartToken: processStartToken(childPid(provider)),
    driver: "codex",
    runtimeId: "luna",
    phase: "worker",
    promptPath: null,
    stdoutPath: join(runDir, "logs", "missing.jsonl"),
    stderrPath: null,
    startedAt,
    updatedAt: startedAt,
    deadlineAt: new Date(now + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
  };
  state.status = "running";
  state.phase = "worker";
  state.verification = {
    passed: false,
    completed: false,
    commands: [],
    attempts: [{
      invocationId: "cancel-verification",
      commandIndex: 0,
      attempt: 1,
      pid: childPid(verificationProcess),
      processGroupId: process.platform === "win32" ? null : childPid(verificationProcess),
      processStartToken: processStartToken(childPid(verificationProcess)),
      startedAt,
      deadlineAt: new Date(now + 60_000).toISOString(),
      status: "active",
      completedAt: null,
      result: null,
    }],
  };
  writeFileSync(nodePath, JSON.stringify({ ...state, invocations: [invocation] }, null, 2));
  writeFileSync(join(runDir, "controller-lease.json"), JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "controller-under-test",
    generation: 1,
    pid: childPid(controller),
    processStartToken: processStartToken(childPid(controller)),
    acquiredAt: new Date(now - 100).toISOString(),
    renewedAt: new Date(now - 100).toISOString(),
    expiresAt: new Date(now + 250).toISOString(),
  }, null, 2));
  try {
    await cancelRun(runDir);
    assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).status, "canceled");
    assert.equal(invocationAlive({ pid: childPid(controller), processStartToken: processStartToken(childPid(controller)) }), false);
    assert.equal(invocationAlive(invocation), false);
    assert.equal(invocationAlive({ pid: childPid(verificationProcess), processStartToken: processStartToken(childPid(verificationProcess)) }), false);
    assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).verification.attempts[0].status, "canceled");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(controller) : -childPid(controller), "SIGKILL"); } catch {}
    try { process.kill(process.platform === "win32" ? childPid(provider) : -childPid(provider), "SIGKILL"); } catch {}
    try { process.kill(process.platform === "win32" ? childPid(verificationProcess) : -childPid(verificationProcess), "SIGKILL"); } catch {}
  }
});

test("resume adopts a still-live orphan invocation after its stream completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-orphan-"));
  const path = writeContract(directory, fixture({ id: "live-orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const stdoutPath = join(runDir, "logs", "active-orphan.jsonl");
  const stream = [
    { type: "thread.started", thread_id: "orphan-thread" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "adopted worker", changedFiles: [], verification: [], artifacts: [], missingContext: [] }) } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const child = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(stdoutPath)}, ${JSON.stringify(stream)}), 50); setTimeout(() => {}, 10000)`], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const snapshotPath = join(runDir, "logs", "active-orphan.snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(captureWorkspaceSnapshot(directory)));
  const now = new Date().toISOString();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.invocations = [{
    id: "live-orphan",
    pid: childPid(child),
    processGroupId: process.platform === "win32" ? null : childPid(child),
    processStartToken: processStartToken(childPid(child)),
    driver: "codex",
    runtimeId: "luna",
    phase: "worker",
    promptPath: null,
    stdoutPath,
    stderrPath: null,
    startedAt: now,
    updatedAt: now,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
    snapshotPath,
  }];
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "done");
    assert.equal(/** @type {{summary: string}} */ (final.result).summary, "adopted worker");
    assert.ok(final.invocations, "adopted invocation persisted");
    assert.equal(final.invocations.length, 1);
    assert.equal(final.invocations[0].id, "live-orphan");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(child) : -childPid(child), "SIGKILL"); } catch {}
  }
});

test("resume terminates an interrupted verification attempt and re-runs the phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-resume-"));
  const path = writeContract(directory, fixture({ id: "verification-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const now = Date.now();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.verification = {
    passed: false,
    completed: false,
    commands: [],
    attempts: [{
      invocationId: "crashed-verification",
      commandIndex: 0,
      attempt: 1,
      pid: childPid(verificationProcess),
      processGroupId: process.platform === "win32" ? null : childPid(verificationProcess),
      processStartToken: processStartToken(childPid(verificationProcess)),
      startedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 60_000).toISOString(),
      status: "active",
      completedAt: null,
      result: null,
    }],
  };
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "done");
    assert.ok(final.verification, "verification state persisted");
    assert.equal(final.verification.passed, true);
    assert.ok(final.verification.attempts, "verification attempts persisted");
    assert.equal(final.verification.attempts[0].status, "crashed");
    assert.equal(final.verification.attempts.length, 3);
    assert.equal(final.revisions, 0);
    assert.equal(invocationAlive({ pid: childPid(verificationProcess), processStartToken: processStartToken(childPid(verificationProcess)) }), false);
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(verificationProcess) : -childPid(verificationProcess), "SIGKILL"); } catch {}
  }
});

test("verification output beyond the snapshot budget does not crash the controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-large-"));
  const path = writeContract(directory, fixture({
    id: "verification-large-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000))"] }] }),
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.ok(state.verification, "verification state persisted");
  assert.equal(state.verification.passed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  const boundedAttempt = state.verification.attempts[0];
  assert.ok(boundedAttempt.result, "bounded attempt result persisted");
  assert.ok(Buffer.byteLength(boundedAttempt.result.stdout, "utf8") <= 2 * 1024);
  assert.ok(Buffer.byteLength(boundedAttempt.result.stderr, "utf8") <= 2 * 1024);
});

test("resume rejects a dead completion whose persisted close time is past the absolute deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-deadline-"));
  const path = writeContract(directory, fixture({
    id: "resume-deadline-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations.at(-1);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const timeoutAt = new Date(Date.now() - 10_000).toISOString();
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: timeoutAt, reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt: new Date().toISOString() }],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 2, "an overdue completion is restarted rather than adopted");
});

test("resume adopts a dead completion closed before its deadline after downtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-downtime-"));
  const path = writeContract(directory, fixture({
    id: "resume-downtime-run",
    timeoutSec: 10,
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations.at(-1);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const closedAt = new Date(Date.now() - 19_000).toISOString();
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: new Date(Date.now() - 20_000).toISOString(), reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt }],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 1, "a completion closed before the deadline remains adoptable after downtime");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 10);
});

test("resume preserves a durable pending judge phase instead of resetting to worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-pending-judge-"));
  const path = writeContract(directory, fixture({
    id: "resume-pending-judge-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "judge",
    result: { status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] },
    gate: null,
  }, null, 2));

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 1, "the pending judge does not repeat the worker attempt");
});

test("resume does not re-enable a disabled gate from the stored contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-no-gate-"));
  const path = writeContract(directory, fixture({ id: "resume-no-gate-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  assert.equal(JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")).nodes[0].gate.enabled, false);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  const logs = readdirSync(join(runDir, "logs"));
  assert.ok(!logs.some((name) => name.includes("judge")), "a disabled gate must not run a judge after resume");
});

test("gate revisions are not consumed by attempts burned in restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-revisions-"));
  const path = writeContract(directory, fixture({
    id: "revisions-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: ["It works"],
      gate: { failOn: ["critical"], maxRevisions: 1 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).attempt, 2);

  const final = await withFakeCodex(directory, "critical", () => resumeRun(runDir));
  assert.equal(nodeState(final).status, "exhausted");
  assert.equal(nodeState(final).attempt, 4, "two burned starts plus the gate retry start");
  assert.equal(nodeState(final).revisions, 1, "one real gate rejection consumed");
});

test("status separates a live running node from an orphaned one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-"));
  const path = writeContract(directory, fixture({ id: "orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  assert.match(renderStatus(runDir), /build still claims to be running/u);

  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    pid: 2_147_483_647,
    startedAt: "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run", contractId: "orphan-run", campaignId: "test-campaign" },
  }));
  assert.match(renderStatus(runDir), /build still claims to be running/u);
});

test("status --json flags an orphaned running node with leaseHealthy false", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-json-"));
  const path = writeContract(directory, fixture({ id: "orphan-json-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const payload = /** @type {{leaseHealthy: boolean, summary: string, nodes: {id: string, status: string}[]}} */ (JSON.parse(renderStatusJson(runDir)));
  assert.equal(payload.leaseHealthy, false, "a missing controller lease while a node claims running must be machine-readable");
  assert.equal(payload.nodes.find((node) => node.id === "build")?.status, "running");
});

test("status and resume reject unknown persisted protocol fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-validation-"));
  const path = writeContract(directory, fixture({ id: "persisted-validation-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({ ...node, typo: true }));
  assert.throws(() => renderStatus(runDir), /node snapshot has unexpected field typo/u);
  writeFileSync(nodePath, JSON.stringify(node));
  writeFileSync(nodePath, JSON.stringify({ ...node, id: "other" }));
  assert.throws(() => renderStatus(runDir), /node snapshot\.id does not match/u);
  assert.throws(() => renderReport(runDir), /node snapshot\.id does not match/u);
  assert.throws(() => renderFindings(runDir), /node snapshot\.id does not match/u);
  await assert.rejects(() => resumeRun(runDir), /node snapshot\.id does not match/u);
  writeFileSync(nodePath, JSON.stringify(node));

  const runPath = join(runDir, "run.json");
  const metadata = JSON.parse(readFileSync(runPath, "utf8"));
  writeFileSync(runPath, JSON.stringify({ ...metadata, typo: true }));
  assert.throws(() => renderStatus(runDir), /run metadata has unexpected field typo/u);
  await assert.rejects(() => resumeRun(runDir), /run metadata has unexpected field typo/u);
});

test("report aggregates per-node status, attempts, revisions, and tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-report-"));
  const path = writeContract(directory, fixture({
    id: "report-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const report = renderReport(runDir);
  assert.match(report, /1 nodes · 1 done/u);
  // The node ends on its judge runtime, and tokens sum worker plus judge.
  assert.match(report, /build\s+done\s+1\s+0\s+codex\/gpt-5\.6-sol/u);
  assert.match(report, /totals · in 20 · out 4 · cache -/u);
});

test("events record attempt, runtime, and gate verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-events-"));
  const path = writeContract(directory, fixture({
    id: "events-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const started = events.find((event) => event.to === "running" && event.phase === "worker");
    assert.equal(started.attempt, 1);
    assert.equal(started.runtime, "luna");
    const rejected = events.find((event) => event.to === "exhausted");
    assert.equal(rejected.verdict, "fail");
    assert.equal(rejected.error, "revision_cap");
    assert.equal(rejected.phase, "judge");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("preflight probes every routed worker and judge runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id).sort(), ["luna", "sol"]);
  assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
});

test("preflight runs an agy runtime through its native stream protocol", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-agy-"));
  const path = writeContract(directory, fixture({
    runtimeDefaults: { worker: "agy", judge: "sol" },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const checks = await withFakeAgy(directory, () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id), ["agy"]);
  assert.equal(checks[0].ok, true, checks[0].detail ?? undefined);
});

test("preflight reports a missing credential by variable name only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-key-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "mechanic", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
    assert.deepEqual(checks.map((check) => check.id), ["flash"]);
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].driver, "codex");
    assert.match(checks[0].executable, /fake-codex-pass\.mjs$/u);
    assert.equal(checks[0].model, "deepseek-v4-flash");
    assert.equal(checks[0].version, "fake-codex 1.0.0");
    assert.match(checks[0].detail ?? "", /missing environment variable DEEPSEEK_API_KEY/u);
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("preflight fails a runtime the provider rejects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-fail-"));
  const path = writeContract(directory, fixture());
  const checks = await withFakeCodex(directory, "version-fail", () => preflightContract(path));
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail ?? "", /deliberate failure/u);
});

test("preflight preserves conflicting runtime and node capability requirements", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-capabilities-"));
  const path = writeContract(directory, fixture({
    runtimes: {
      luna: { driver: "codex", model: "gpt-5.6-luna", requiredCapabilities: { sandbox: true } },
      sol: { driver: "codex", model: "gpt-5.6-sol" },
    },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      requiredCapabilities: { sandbox: false },
      gate: false,
    }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail ?? "", /requirement 2: sandbox=false/u);
});

test("resume doubles the wall-clock budget of a node that exhausted it", async () => {
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
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).executionOverrides.at(-1).timeoutSec, 4800, "budget override is persisted in execution state");
});

test("findings renders exhausted gate findings ready for a fix node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-"));
  const path = writeContract(directory, fixture({
    id: "findings-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    const rendered = renderFindings(result.runDir);
    assert.match(rendered, /## build/u);
    assert.match(rendered, /\[critical\] broken/u);
    assert.match(rendered, /Evidence: test failed/u);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("maxInputTokens blocks pending nodes once the budget is spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-token-budget-"));
  const path = writeContract(directory, fixture({
    id: "budget-run",
    maxInputTokens: 5,
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Implement it too" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, false);
  assert.equal(nodeState(result, "first").status, "done");
  const blocked = nodeState(result, "second");
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.error, "budget block records an error");
  assert.equal(blocked.error.code, "budget_exceeded");
});

test("a finished run prints the token report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-auto-report-"));
  const path = writeContract(directory, fixture({ pollIntervalMs: 10 }));
  const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const result = await withFakeCodex(directory, "pass", () => spawnSync(process.execPath, [runner, "run", path], { encoding: "utf8" }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /totals · in 10/u, "auto-report table");
  assert.match(result.stdout, /worker complete/u, "node note surfaces the worker summary");
});
test("run warns when a node id is already done in another run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-guard-"));
  const firstPath = writeContract(directory, fixture({ id: "first-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));

  const secondPath = writeContract(directory, fixture({ id: "second-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", secondPath], {
      encoding: "utf8",
    }),
  );
  assert.match(result.stdout, /\[warn\] node build is already done in run first-run/u);
});

test("supervise resumes a run whose controller died", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-supervise-"));
  const path = writeContract(directory, fixture({ id: "supervise-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  // Simulate a controller that died mid-work: the node claims running but the
  // recorded pid is gone.
  orphan(runDir, "build");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...metadata, pid: 2_147_483_647 }));

  // The supervisor's resumed controller inherits the supervisor's environment, so
  // the fake provider must stay installed for the whole supervise lifetime.
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "pass");
  const supervisor = spawn(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "supervise", runDir, "--interval", "0.05"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    let stdout = "";
    supervisor.stdout.on("data", (chunk) => { stdout += chunk; });
    const finished = await waitForValue(
      () => (stdout.includes("resumed") && stdout.includes("finished") ? "done" : null),
      20_000,
    );
    assert.equal(finished, "done", stdout);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
    supervisor.kill("SIGTERM");
  }
});

test("detached resume surfaces bootstrap failure before reporting success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-failure-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-failure-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  metadata.sourceIdentity.cwd = "/unexpected-source";
  writeFileSync(join(runDir, "run.json"), JSON.stringify(metadata));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
    env: { ...process.env, PLAN_RUNNER_CODEX_BIN: fakeCodex(directory, "pass") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source drift detected in cwd/u);
  const bootstrapFailed = await waitForValue(
    () => {
      try { return readFileSync(join(runDir, "bootstrap.json"), "utf8").includes('"status": "failed"') ? "failed" : null; } catch { return null; }
    },
    15_000,
  );
  assert.equal(bootstrapFailed, "failed");
  assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith("bootstrap.json.")), [], "failed detached attempts are cleaned up");
});

test("bootstrap attempt cleanup leaves concurrent failure temp writes intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-cleanup-race-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-cleanup-race-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const temporary = join(runDir, `bootstrap.json.${process.pid}.7a6b4a44-77a7-47a7-97a7-7a7a7a7a7a7a.tmp`);
  const staleAttempt = bootstrapAttemptPath(runDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  writeFileSync(temporary, JSON.stringify({ status: "failed" }));
  writeFileSync(staleAttempt, "{}");
  cleanupBootstrapAttempts(runDir);
  assert.equal(existsSync(staleAttempt), false);
  assert.equal(existsSync(temporary), true);
  renameSync(temporary, bootstrapPath(runDir));
  assert.equal(JSON.parse(readFileSync(bootstrapPath(runDir), "utf8")).status, "failed");
});

test("detached ACK timeout and parse errors clean only their nonce attempt and ACK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-ack-cleanup-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-ack-cleanup-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const errorNonce = "11111111-1111-4111-8111-111111111111";
  writeFileSync(bootstrapAckPath(runDir, errorNonce), "not json\n");
  const errorResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, PLAN_RUNNER_BOOTSTRAP_NONCE: errorNonce, PLAN_RUNNER_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.notEqual(errorResult.status, 0);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${errorNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, errorNonce)), false);

  const timeoutNonce = "22222222-2222-4222-8222-222222222222";
  const timeoutResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, PLAN_RUNNER_BOOTSTRAP_NONCE: timeoutNonce, PLAN_RUNNER_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.equal(timeoutResult.status, 0, timeoutResult.stderr);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${timeoutNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, timeoutNonce)), false);
});

test("blocks downstream nodes after a failed dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-dependency-"));
  const path = writeContract(directory, fixture({
    id: "dependency-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet({ objective: "Fail" }), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Never run" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "worker-fail");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result, "first").status, "failed");
    assert.equal(nodeState(result, "second").status, "blocked");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});
