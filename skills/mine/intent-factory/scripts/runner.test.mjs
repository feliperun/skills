import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  renderFindings,
  renderReport,
  renderStatus,
  validateContract,
} from "./lib.mjs";
import { renderReportJson, renderStatusJson } from "./render.mjs";
import { cancelRun, preflightContract, runContract, resumeRun, superviseRun } from "./runner.mjs";
import { invocationAlive, invocationResult, processStartToken } from "./supervisor.mjs";
import { captureWorkspaceSnapshot } from "./verification.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, bootstrapPath, cleanupBootstrapAttempts, writeJsonAtomic } from "./store.mjs";
import { getDriver } from "./drivers/index.mjs";
import {
  closeResult,
  fakeCodex,
  fakeExecJsonl,
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

/**
 * @param {string} directory
 * @param {{emitSessionId?: boolean, costUsd?: number}} [options]
 * @returns {{executable: string, requestLog: string}}
 */
function fakeClaudeLike(directory, options = {}) {
  const executable = join(directory, "fake-claude-like.mjs");
  const requestLog = join(mkdtempSync(join(tmpdir(), "runner-fake-claude-log-")), "provider-requests.jsonl");
  const emitSessionId = options.emitSessionId !== false;
  const costUsd = options.costUsd ?? 0.2;
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("fake-claude-like 1.0.0");
else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ args, prompt: input }) + "\\n");
    const result = JSON.stringify({ status: "done", summary: "fake provider complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "result", result, ${emitSessionId ? 'session_id: args.includes("--resume") ? "session-2" : "session-1",' : ""} usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: ${costUsd} }));
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, requestLog };
}

/** @param {string[]} args @param {string} flag @returns {string|null} */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] ?? null;
}

test("runs the CLI through an installed symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-symlink-"));
  const contractPath = writeContract(directory, fixture());
  const link = join(directory, "runner-link.mjs");
  symlinkSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, "validate", contractPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^valid \(1 warning\)\n\[warn\] single-node contract/u);
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
    maxInputTokens: 1_000_000,
    usagePolicy: false,
    runtimeDefaults: { worker: "wrapped", judge: "wrapped" },
    runtimes: { wrapped: { driver: "exec-jsonl", model: "m", executable: "./my-worker.mjs" } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", phase: "doctor", dependsOn: [], taskPacket: packet(), gate: false }],
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
  // Default repeat is 1: the last worker attempt's single command run replaces
  // the phase state.
  assert.equal(state.verification.commands[0].attempts.length, 1);
  assert.equal(state.verification.completed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  assert.equal(state.verification.attempts.length, 1);
  assert.equal(new Set(state.verification.attempts.map((attempt) => attempt.invocationId)).size, 1);
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
  const scopeFindings = /** @type {{nodes: {id: string, unexpectedPaths?: string[]}[]}} */ (
    JSON.parse(readFileSync(join(directory, ".runs", "scope-run", "findings.json"), "utf8"))
  );
  assert.deepEqual(scopeFindings.nodes[0].unexpectedPaths, ["unexpected.txt"]);

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

test("a worker-created symlink cannot authorize its target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-new-symlink-"));
  writeFileSync(join(directory, "outside.txt"), "baseline\n");
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-new-symlink-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "new-symlink-escape", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt"]);
  assert.equal(readFileSync(join(directory, "outside.txt"), "utf8"), "unauthorized target\n");
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
});

test("retargeting a contained alias cannot authorize the new target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-retargeted-symlink-"));
  writeFileSync(join(directory, "src.txt"), "source\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  symlinkSync("src.txt", join(directory, "alias.txt"));
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-retargeted-symlink-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "retargeted-symlink-escape", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
});

test("a pre-existing contained alias remains an authorized write path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-contained-alias-"));
  writeFileSync(join(directory, "src.txt"), "source\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  symlinkSync("src.txt", join(directory, "alias.txt"));
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-contained-alias-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "contained-alias", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.equal(readFileSync(join(directory, "src.txt"), "utf8"), "authorized target\n");
});

test("autonomous heartbeats observe progress made through a contained alias", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-alias-heartbeat-"));
  mkdirSync(join(directory, "src"));
  symlinkSync("src", join(directory, "alias"));
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-alias-heartbeat-run",
    pollIntervalMs: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacket,
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "alias-heartbeat", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.ok((state.progress?.heartbeatCount ?? 0) > 0);
  assert.ok(state.scope?.boundary?.roots.includes("alias"));
  assert.ok(state.scope?.boundary?.roots.includes("src"));
  assert.ok(readFileSync(join(directory, "src", "progress.txt"), "utf8"));
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
    /driver probe unavailable for luna; resume refused/u,
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

test("resume accepts allowed changes reached through an autonomous symlink root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-symlink-root-"));
  mkdirSync(join(directory, "src"));
  symlinkSync("src", join(directory, "alias"));
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-symlink-root-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(directory, "src", "allowed.txt"), "allowed\n");
  orphan(runDir, "build");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume source identity uses the pre-execution symlink boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-scope-boundary-"));
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "outside"));
  writeFileSync(join(directory, "outside", "baseline.txt"), "outside\n");
  symlinkSync("src", join(directory, "alias"));
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-scope-boundary-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const persisted = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.deepEqual(persisted.scope.boundary.roots, ["alias", "src"]);
  unlinkSync(join(directory, "alias"));
  symlinkSync("outside", join(directory, "alias"));
  writeFileSync(join(directory, "alias", "unauthorized.txt"), "unauthorized target\n");
  orphan(runDir, "build");
  await assert.rejects(
    () => withFakeCodex(directory, "worker-fail", () => resumeRun(runDir)),
    /source drift detected in dirtyTreeFingerprint/u,
  );
});

test("resume fails closed when the persisted scope boundary is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-missing-scope-boundary-"));
  const path = writeContract(directory, fixture({ id: "resume-missing-scope-boundary-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  state.scope = null;
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  await assert.rejects(
    () => withFakeCodex(directory, "pass", () => resumeRun(runDir)),
    /persisted worker scope boundary|scope boundary/u,
  );
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
    usagePolicy: { epoch: "resume-invalid-restart", maxInputTokens: 1000, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1000, maxInvocationTokens: 500, cacheReadWeight: 0.1 },
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
  const ledgerPath = join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  delete ledger.epochs["resume-invalid-restart"].invocations[judgeInvocation.id];
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 2, "an unusable worker forces a full worker restart");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 40, "the orphan judge usage is charged before the replacement phase");
  const recoveredLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const recoveredEntries = Object.values(recoveredLedger.epochs["resume-invalid-restart"].invocations);
  assert.equal(recoveredEntries.length, 4, "four invocation usages are present exactly once");
  assert.ok(final.executionOverrides, "execution overrides persisted");
  assert.equal(final.executionOverrides.filter((item) => item.invocationId === judgeInvocation.id).length, 1);
  const resumedAgain = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const finalAgain = nodeState(resumedAgain);
  assert.ok(finalAgain.usage, "usage persisted on second resume");
  assert.equal(finalAgain.usage.inputTokens, 40, "the second resume does not charge the judge again");
  const resumedLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(Object.keys(resumedLedger.epochs["resume-invalid-restart"].invocations).length, Object.keys(recoveredLedger.epochs["resume-invalid-restart"].invocations).length, "a second resume does not add a ledger entry");
});

test("resume restarts a node with no usable worker output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-restart-"));
  const path = writeContract(directory, fixture({ id: "resume-restart-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 2);
});

test("orphan worker failure usage is recovered into the campaign ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-failure-usage-"));
  const path = writeContract(directory, fixture({
    id: "orphan-failure-usage-run",
    pollIntervalMs: 10,
    usagePolicy: { epoch: "orphan-failure-usage", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
  }));
  const runDir = await withFakeCodex(directory, "failure-with-usage", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations[0];
  const { usage: _usage, costUsd: _cost, ...withoutAccounting } = invocation;
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    usage: undefined,
    costUsd: undefined,
    invocations: [{ ...withoutAccounting, status: "closed", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null }, costUsd: null }],
  }, null, 2));
  const ledgerPath = join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  ledger.epochs["orphan-failure-usage"].invocations = {};
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.deepEqual(final.usage, { inputTokens: 15, outputTokens: 5, cacheReadInputTokens: 2 });
  const finalLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(Object.keys(finalLedger.epochs["orphan-failure-usage"].invocations).length, 2);
  assert.deepEqual(finalLedger.epochs["orphan-failure-usage"].invocations[invocation.id].usage, { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 });
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
  /** @param {import("node:child_process").ChildProcess} child */
  const childExit = (child) => new Promise((resolve) => child.once("exit", resolve));
  const controllerExit = childExit(controller);
  const providerExit = childExit(provider);
  const verificationExit = childExit(verificationProcess);
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const invocation = {
    id: "cancel-provider",
    pid: childPid(provider),
    processGroupId: process.platform === "win32" ? null : childPid(provider),
    processStartToken: processStartToken(childPid(provider)),
    driver: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
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
    await Promise.all([controllerExit, providerExit, verificationExit]);
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
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
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

test("resume applies the persisted progress heartbeat to a noisy live worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-progress-resume-"));
  mkdirSync(join(directory, "src"));
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["src"] });
  const path = writeContract(directory, fixture({
    id: "live-progress-resume-run",
    pollIntervalMs: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacket,
      progressPolicy: { graceSec: 300, intervalSec: 120, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const stdoutPath = join(runDir, "logs", "active-progress.jsonl");
  writeFileSync(stdoutPath, "working\n");
  const child = spawn(process.execPath, ["-e", `const fs = require("node:fs"); setInterval(() => fs.appendFileSync(${JSON.stringify(stdoutPath)}, "working\\n"), 5);`], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const snapshotPath = join(runDir, "logs", "active-progress.snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(captureWorkspaceSnapshot(directory)));
  const now = new Date().toISOString();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.progress = {
    ...state.progress,
    revision: 0,
    heartbeatCount: 2,
    dryHeartbeatCount: 2,
    nextCheckAt: new Date(Date.now() - 1_000).toISOString(),
  };
  state.invocations = [{
    id: "live-progress",
    pid: childPid(child),
    processGroupId: process.platform === "win32" ? null : childPid(child),
    processStartToken: processStartToken(childPid(child)),
    driver: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
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
    assert.equal(final.status, "stalled");
    assert.equal(final.error?.code, "progress_stalled");
    assert.equal(final.progress?.dryHeartbeatCount, 3);
    assert.equal(final.invocations?.[0]?.status, "closed");
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
    // The fabricated crashed attempt is preserved and the phase re-runs once
    // (default repeat 1).
    assert.equal(final.verification.attempts.length, 2);
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

test("resume gives a never-started pending node zero usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-never-started-"));
  const path = writeContract(directory, fixture({ id: "resume-never-started-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "waiting",
    attempt: 0,
    invocations: [],
    usage: undefined,
    costUsd: undefined,
    result: null,
    verification: null,
    gate: null,
    error: null,
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.deepEqual(nodeState(resumed).usage, { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 });
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

test("live preflight proves generation, redacts failures, and static mode stays mutation-free", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-preflight-"));
  const executable = fakeExecJsonl(directory, "secret");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const previous = process.env.PLAN_RUNNER_TEST_LIVE_SECRET;
  process.env.PLAN_RUNNER_TEST_LIVE_SECRET = "preflight-secret-value";
  try {
    const checks = await preflightContract(path);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].version, "fake-jsonl 1.0.0");
    assert.equal(checks[0].liveStatus, "failed");
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail ?? "", /402/u);
    assert.doesNotMatch(checks[0].detail ?? "", /preflight-secret-value/u);
    assert.equal(existsSync(join(directory, ".runs")), false);

    const staticExecutable = fakeExecJsonl(directory, "pass");
    const staticPath = join(directory, "static-contract.json");
    writeFileSync(staticPath, `${JSON.stringify(fixture({
      runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
      runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: staticExecutable } },
      runtimeRules: [],
      nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    }), null, 2)}\n`);
    const staticChecks = await preflightContract(staticPath, { static: true });
    assert.equal(staticChecks[0].ok, true);
    assert.equal(staticChecks[0].live, undefined);
    assert.equal(existsSync(join(directory, ".runs")), false);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_TEST_LIVE_SECRET;
    else process.env.PLAN_RUNNER_TEST_LIVE_SECRET = previous;
  }
});

test("live preflight providers never receive the controller-only notification transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-preflight-notify-env-"));
  const marker = join(directory, "preflight-env.json");
  const provider = join(directory, "preflight-provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("preflight-provider 1.0.0");
} else {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    notify: process.env.PLAN_RUNNER_NOTIFY_BIN ?? null,
    ambient: process.env.PLAN_RUNNER_AMBIENT ?? null,
  }));
  const result = JSON.stringify({ status: "done", summary: "ok", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "fake-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 }, costUsd: 0.01 }));
}
`);
  chmodSync(provider, 0o755);
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: provider } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const previousNotify = process.env.PLAN_RUNNER_NOTIFY_BIN;
  const previousAmbient = process.env.PLAN_RUNNER_AMBIENT;
  process.env.PLAN_RUNNER_NOTIFY_BIN = provider;
  process.env.PLAN_RUNNER_AMBIENT = "ambient-value";
  try {
    const checks = await preflightContract(path);
    assert.equal(checks[0].ok, true, checks[0].detail ?? undefined);
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.notify, null, "PLAN_RUNNER_NOTIFY_BIN must not reach the live preflight provider");
    assert.equal(observed.ambient, "ambient-value", "ambient runtime variables must survive");
  } finally {
    if (previousNotify === undefined) delete process.env.PLAN_RUNNER_NOTIFY_BIN;
    else process.env.PLAN_RUNNER_NOTIFY_BIN = previousNotify;
    if (previousAmbient === undefined) delete process.env.PLAN_RUNNER_AMBIENT;
    else process.env.PLAN_RUNNER_AMBIENT = previousAmbient;
  }
});

test("preflight deduplicates initial runtimes and follows failover targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-reachable-"));
  const executable = fakeExecJsonl(directory, "pass");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "exec-jsonl", model: "primary", executable },
      backup: { driver: "exec-jsonl", model: "backup", executable },
    },
    runtimeRules: [{ match: { currentRuntime: "primary", status: "failed" }, runtime: "backup" }],
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }), null, 2)}\n`);
  const checks = await preflightContract(path, { static: true });
  assert.deepEqual(checks.map((check) => check.id), ["primary", "backup"]);
});

test("provider exhaustion follows multiple declared runtimes without consuming revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-multi-hop-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "exhausted");
  const third = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-multi-hop-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first },
      second: { driver: "codex", model: "second", executable: second },
      third: { driver: "codex", model: "third", executable: third },
    },
    runtimeRules: [
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second" },
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "second" }, runtime: "third" },
    ],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second", "third"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.nextRuntime), ["second", "third"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.hop), [1, 2]);
});

test("provider exhaustion without a rule is terminal and cycles do not reuse a runtime", async () => {
  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-failover-no-rule-"));
  const exhausted = fakeCodex(terminalDirectory, "exhausted");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "failover-no-rule-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: { first: { driver: "codex", model: "first", executable: exhausted } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const terminal = nodeState(await runContract(terminalPath));
  assert.equal(terminal.status, "exhausted");
  assert.equal(terminal.routing?.history?.length ?? 0, 0);

  const cycleDirectory = mkdtempSync(join(tmpdir(), "runner-failover-cycle-"));
  const cycleFirst = fakeCodex(cycleDirectory, "exhausted");
  const cycleSecond = fakeCodex(cycleDirectory, "exhausted");
  const cyclePath = writeContract(cycleDirectory, fixture({
    id: "failover-cycle-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: cycleFirst },
      second: { driver: "codex", model: "second", executable: cycleSecond },
    },
    runtimeRules: [
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second" },
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "second" }, runtime: "first" },
    ],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const cycle = nodeState(await runContract(cyclePath));
  assert.equal(cycle.status, "exhausted");
  assert.equal(cycle.error?.code, "provider_failover_cycle");
  assert.deepEqual((cycle.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
});

test("provider failover persists and honors backoff before rescheduling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-backoff-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-backoff-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first },
      second: { driver: "codex", model: "second", executable: second },
    },
    runtimeRules: [{ match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second", backoffSec: 0.05 }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const started = Date.now();
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.routing?.history?.[0]?.backoffSec, 0.05);
  assert.ok(Date.parse(state.routing?.history?.[0]?.backoffUntil ?? "") <= Date.now());
  assert.ok(Date.now() - started >= 40);
});

test("recovered provider exhaustion does not charge persisted usage or cost twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-no-double-charge-"));
  const executable = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-no-double-charge-run",
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { driver: "codex", model: "worker", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = (await runContract(path)).runDir;
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations[0];
  const usage = { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 };
  const costUsd = 0.01;
  writeFileSync(invocation.stdoutPath, `${JSON.stringify({ type: "turn.failed", error: { code: "budget_exceeded", message: "budget_exceeded" } })}\n`);
  const recovered = {
    ...state,
    status: "running",
    phase: "worker",
    result: null,
    gate: null,
    error: null,
    usage,
    costUsd,
    invocations: [{ ...invocation, status: "closed", usage, costUsd, closedAt: new Date().toISOString(), exitCode: 0, signal: null }],
  };
  writeFileSync(nodePath, JSON.stringify(recovered, null, 2));
  const final = nodeState(await resumeRun(runDir));
  assert.equal(final.status, "exhausted");
  assert.deepEqual(final.usage, usage);
  assert.equal(final.costUsd, costUsd);
});

test("ordinary provider failure usage is counted from its invocation once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failure-usage-once-"));
  const path = writeContract(directory, fixture({
    id: "failure-usage-once-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "failure-with-usage", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.deepEqual(state.usage, { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 });
  assert.deepEqual(state.invocations?.map((invocation) => invocation.usage), [{ inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 }]);
});

test("judge provider failover preserves the completed worker result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-judge-"));
  const worker = fakeCodex(directory, "pass");
  const judgeFirst = fakeCodex(directory, "exhausted");
  const judgeSecond = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-judge-run",
    runtimeDefaults: { worker: "worker", judge: "judge-first" },
    runtimes: {
      worker: { driver: "codex", model: "worker", executable: worker },
      "judge-first": { driver: "codex", model: "judge-first", executable: judgeFirst },
      "judge-second": { driver: "codex", model: "judge-second", executable: judgeSecond },
    },
    runtimeRules: [{ match: { role: "judge", status: "exhausted", errorCode: "provider_error", currentRuntime: "judge-first" }, runtime: "judge-second" }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(/** @type {{status?: string}|null} */ (state.result)?.status, "done");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["worker", "judge-first", "judge-second"]);
  assert.equal(state.routing?.history?.[0]?.role, "judge");
});

test("rejects monetary budgets when a reachable runtime cannot return cost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-capability-"));
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    maxCostUsd: 0.01,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path, { static: true }));
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail ?? "", /cost=false/u);
  await assert.rejects(() => withFakeCodex(directory, "pass", () => runContract(path)), /cost capability/u);
  assert.equal(existsSync(join(directory, ".runs")), false);
});

test("persists and recovers cost exactly once and reports totals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-recovery-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const executable = fakeExecJsonl(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "cost-recovery-run",
    pollIntervalMs: 10,
    usagePolicy: { epoch: "cost-recovery", maxInputTokens: 100, judgeReserveInputTokens: 10, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const runDir = (await runContract(path)).runDir;
  const first = nodeState(await resumeRun(runDir));
  assert.equal(first.costUsd, 0.02);
  assert.deepEqual((first.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  assert.deepEqual(Object.values(ledger.epochs["cost-recovery"].invocations).map((invocation) => invocation.costUsd), [0.01, 0.01]);
  assert.equal(JSON.parse(renderReportJson(runDir)).totals.costUsd, 0.02);
  assert.match(renderReport(runDir), /cost \$0\.020000/u);
  const nodePath = join(runDir, "nodes", "build.json");
  const crashed = JSON.parse(readFileSync(nodePath, "utf8"));
  const worker = /** @type {Record<string, unknown>[]} */ (crashed.invocations).find((invocation) => invocation.phase === "worker");
  crashed.status = "running";
  crashed.phase = "worker";
  crashed.result = null;
  crashed.gate = null;
  crashed.costUsd = undefined;
  crashed.usage = undefined;
  crashed.invocations = [{ ...worker, status: "closed", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null }, costUsd: null }];
  writeFileSync(nodePath, JSON.stringify(crashed, null, 2));
  const recovered = nodeState(await resumeRun(runDir));
  assert.equal(recovered.costUsd, 0.02);
  assert.deepEqual((recovered.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
});

test("blocks new work at contract and node monetary budgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-budget-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const executable = fakeExecJsonl(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "cost-budget-run",
    maxCostUsd: 0.01,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(nodeState(result, "first").status, "done");
  assert.equal(nodeState(result, "second").status, "blocked");
  assert.equal(nodeState(result, "second").error?.code, "cost_budget_exceeded");

  const nodeBudgetPath = writeContract(directory, fixture({
    id: "node-cost-budget-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", maxCostUsd: 0.01, taskPacket: packet(), gate: {} }],
  }));
  const nodeBudget = await runContract(nodeBudgetPath);
  assert.equal(nodeState(nodeBudget).status, "blocked");
  assert.equal(nodeState(nodeBudget).error?.code, "cost_budget_exceeded");
});

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

test("a finished run with non-done nodes writes a findings.json handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-artifact-"));
  const path = writeContract(directory, fixture({
    id: "findings-artifact-run",
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
    const artifact = JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8"));
    assert.equal(artifact.run, "findings-artifact-run");
    assert.equal(artifact.goal, "Prove the runner works");
    assert.match(artifact.summary, /1 exhausted/u);
    assert.equal(artifact.nodes.length, 1);
    const node = artifact.nodes[0];
    assert.equal(node.id, "build");
    assert.equal(node.status, "exhausted");
    assert.equal(node.error.code, "revision_cap");
    assert.equal(node.gate.maxSeverity, "critical");
    assert.equal(node.gate.findings[0].evidence, "test failed");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("a fully done run writes no findings.json", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-clean-"));
  const path = writeContract(directory, fixture({ id: "findings-clean-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(result).status, "done");
  assert.equal(existsSync(join(result.runDir, "findings.json")), false);
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
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "critical", async () => (await runContract(path)).runDir);
  assert.equal(existsSync(join(runDir, "findings.json")), true, "the exhausted run wrote the artifact");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(existsSync(join(runDir, "findings.json")), false, "a done run leaves no stale artifact");
});

test("usagePolicy blocks pending nodes once the weighted budget is spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-token-budget-"));
  const path = writeContract(directory, fixture({
    id: "budget-run",
    usagePolicy: { epoch: "test-budget", maxInputTokens: 5, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
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

test("a scope-gate failure still persists the usage its invocation spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-usage-"));
  const path = writeContract(directory, fixture({
    id: "scope-usage-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.equal(state.usage?.inputTokens, 10, "transcript usage survives the scope failure");
  const invocation = state.invocations?.at(-1);
  assert.equal(invocation?.usage?.inputTokens, 10, "invocation record carries the same usage");
});

test("a wall-clock kill persists usage backfilled from the transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-usage-"));
  const path = writeContract(directory, fixture({
    id: "timeout-usage-run",
    pollIntervalMs: 10,
    timeoutSec: 1,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ objective: "Flood tokens" }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "wall_clock_timeout");
  assert.ok((state.usage?.inputTokens ?? 0) > 0, "killed worker reports its observed input tokens");
});

test("per-node maxInputTokens terminates an active worker over its cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-node-cap-"));
  const path = writeContract(directory, fixture({
    id: "node-cap-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Flood tokens" }),
      maxInputTokens: 500,
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "token_budget_exceeded");
  assert.ok((state.usage?.inputTokens ?? 0) >= 500, "usage observed before the kill is persisted");
});

test("campaign maxInputTokens stops a running worker once the budget is spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cap-"));
  const path = writeContract(directory, fixture({
    id: "campaign-cap-run",
    maxInputTokens: 2000,
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ objective: "Flood tokens" }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "budget_exceeded");
  assert.equal(result.ok, false);
  assert.ok((state.usage?.inputTokens ?? 0) > 0, "stopped worker still reports its spend");
});

test("native rollout-budget exhaustion charges the declared ceiling when Codex omits usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rollout-budget-accounting-"));
  const path = writeContract(directory, fixture({
    id: "rollout-budget-accounting-run",
    usagePolicy: { epoch: "rollout-budget-accounting", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "rollout-budget", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.deepEqual(state.usage, { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 0 });
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  assert.deepEqual(Object.values(ledger.epochs["rollout-budget-accounting"].invocations).map((entry) => entry.usage), [
    { inputTokens: 50, outputTokens: null, cacheReadInputTokens: null },
  ]);
});

test("reuses one worker continuation per ordered phase and charges the campaign ledger once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-reuse-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-reuse-run",
    usagePolicy: { epoch: "phase-reuse", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet({ objective: "Continue it" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, "phase-thread"]);
  assert.deepEqual(result.states.get("second")?.invocations?.map((invocation) => invocation.continuationMode), ["reuse"]);
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  assert.equal(Object.keys(ledger.epochs["phase-reuse"].invocations).length, 2);
  assert.equal(JSON.parse(renderReportJson(result.runDir)).campaignUsage, 2.2);
  assert.equal(JSON.parse(renderReportJson(result.runDir)).campaignRawInput, 4);
});

test("rotates a phase continuation at the soft boundary with a deterministic handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-rotate-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-rotate-run",
    usagePolicy: { epoch: "phase-rotate", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet({ objective: "Continue it" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, null]);
  assert.match(requests[1].prompt, /Prior structured node summaries/u);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
});

test("does not reuse a phase continuation after a runtime identity change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-runtime-identity-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-runtime-identity-run",
    usagePolicy: { epoch: "phase-runtime-identity", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "exec-jsonl", model: "same-model", executable },
      backup: { driver: "exec-jsonl", model: "same-model", executable },
    },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", runtime: "primary", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", runtime: "backup", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, null]);
  // The runtime identity changed between the two nodes, so the second worker
  // is composed from the portable continuation capsule instead of reusing or
  // rotating the prior session.
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "fresh");
  assert.match(requests[1].prompt, /Portable continuation capsule \(digest /u);
});

test("selects the latest phase continuation by invocation chronology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-chronology-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  const continuationId = request.continuationId ? request.continuationId + "-next" : "phase-1";
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-chronology-run",
    usagePolicy: { epoch: "phase-chronology", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", executable } },
    runtimeRules: [],
    nodes: [
      { id: "third", type: "backend", phase: "implementation", dependsOn: ["second"], taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, "phase-1", "phase-1-next"]);
});

test("Claude phase reuse passes the first explicit session through --resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-claude-phase-reuse-"));
  const fake = fakeClaudeLike(directory);
  const path = writeContract(directory, fixture({
    id: "claude-phase-reuse-run",
    usagePolicy: false,
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, "session-1"]);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "reuse");
});

test("a completed phase without a continuation ID remains a fresh invocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-no-id-"));
  const fake = fakeClaudeLike(directory, { emitSessionId: false });
  const path = writeContract(directory, fixture({
    id: "phase-no-id-run",
    usagePolicy: false,
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, null]);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "fresh");
});

test("a non-continuing runtime gets a deterministic fresh phase handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-no-continuation-"));
  const fake = fakeClaudeLike(directory);
  const adapter = getDriver("claude");
  const previous = adapter.capabilities.continuation;
  adapter.capabilities.continuation = false;
  try {
    const path = writeContract(directory, fixture({
      id: "phase-no-continuation-run",
      usagePolicy: false,
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
      runtimeRules: [],
      nodes: [
        { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
        { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
      ],
    }));
    const result = await runContract(path);
    const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, null]);
    assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
    assert.match(requests[1].prompt, /fresh provider session/u);
  } finally {
    adapter.capabilities.continuation = previous;
  }
});

test("Claude and GLM receive the smallest positive remaining monetary allowance", async () => {
  for (const driver of ["claude", "glm"]) {
    const directory = mkdtempSync(join(tmpdir(), `runner-${driver}-cost-cap-`));
    const fake = fakeClaudeLike(directory, { costUsd: 0.2 });
    const path = writeContract(directory, fixture({
      id: `${driver}-cost-cap-run`,
      maxCostUsd: 0.7,
      usagePolicy: { epoch: `${driver}-cost-cap`, maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { driver, model: "test-model", executable: fake.executable } },
      runtimeRules: [],
      nodes: [
        { id: "first", type: "backend", phase: "implementation", maxCostUsd: 0.6, taskPacket: packet(), gate: false },
        { id: "second", type: "backend", phase: "implementation", maxCostUsd: 2, dependsOn: ["first"], taskPacket: packet(), gate: false },
      ],
    }));
    const result = await runContract(path);
    assert.equal(result.ok, true);
    const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--max-budget-usd")), ["0.6", "0.5"]);
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--max-invocation-tokens")), [null, null]);
  }
});

test("retains a live Codex continuation before capped logs are truncated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-continuation-"));
  const path = writeContract(directory, fixture({
    id: "live-continuation-run",
    usagePolicy: { epoch: "live-continuation", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    timeoutSec: 1,
    pollIntervalMs: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "thread-large-timeout");
  try {
    const first = await runContract(path);
    const firstState = nodeState(first);
    assert.equal(firstState.status, "exhausted");
    assert.equal(firstState.invocations?.[0]?.continuationId, "fake-thread");
    assert.deepEqual(firstState.invocations?.[0]?.usage, { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 1 });
    const firstLedger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
    assert.equal(Object.keys(firstLedger.epochs["live-continuation"].invocations).length, 1, "timeout usage reaches the campaign ledger");
    const resumed = await resumeRun(first.runDir);
    assert.equal(nodeState(resumed).status, "done");
    const finalLedger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
    assert.equal(Object.keys(finalLedger.epochs["live-continuation"].invocations).length, 2, "resumed invocation is ledgered once");
    assert.match(readFileSync(join(directory, ".runs", "resume-continuation.txt"), "utf8"), /resume --json .* fake-thread /u);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
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

test("ordinary runs deliver bounded node and run terminal notifications", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-run-notifications-"));
  const path = writeContract(directory, fixture({ id: "run-notifications", pollIntervalMs: 10 }));
  const delivered = join(directory, "delivered.jsonl");
  const notifier = join(directory, "notify.mjs");
  writeFileSync(notifier, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(delivered)}, input); });\n`);
  chmodSync(notifier, 0o755);
  const previous = process.env.PLAN_RUNNER_NOTIFY_BIN;
  process.env.PLAN_RUNNER_NOTIFY_BIN = notifier;
  try {
    await withFakeCodex(directory, "pass", () => runContract(path));
    const events = readFileSync(delivered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "node.terminal" && event.data.nodeId === "build"));
    assert.ok(events.some((event) => event.type === "run.terminal" && event.data.runId === "run-notifications"));
    assert.ok(events.every((event) => event.deliveredAt === null), "delivery payload is the durable pre-delivery event");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_NOTIFY_BIN;
    else process.env.PLAN_RUNNER_NOTIFY_BIN = previous;
  }
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
  assert.match(result.stdout, /\[warn\] single-node contract/u);
});

test("run warnings ignore an unrelated historical run with an obsolete contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-obsolete-"));
  const currentPath = writeContract(directory, fixture({ id: "current-run", pollIntervalMs: 10 }));
  const obsoleteRun = join(directory, ".runs", "obsolete-run");
  mkdirSync(join(obsoleteRun, "nodes"), { recursive: true });
  writeFileSync(join(obsoleteRun, "contract.json"), "{ this is obsolete and invalid JSON\n");
  writeFileSync(join(obsoleteRun, "nodes", "old-node.json"), "{}\n");
  const result = await withFakeCodex(directory, "pass", () => spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", currentPath],
    { encoding: "utf8" },
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /obsolete-run/u);
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

test("supervise continues when a stale-lease resume loses to a concurrently healthy controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-supervise-lease-race-"));
  const path = writeContract(directory, fixture({ id: "supervise-lease-race-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...metadata, pid: 2_147_483_647 }));

  // The supervisor sees a stale controller lease and spawns a detached resume.
  writeJsonAtomic(join(runDir, "controller-lease.json"), {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "stale-holder",
    generation: 1,
    pid: 2_147_483_647,
    processStartToken: null,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    renewedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:01.000Z",
  });
  // Hold the controller lease mutation lock before the supervisor starts so the
  // detached resume deterministically loses the takeover instead of stealing the
  // stale lease while the test installs the concurrent healthy controller.
  const lockPath = join(runDir, "controller-lease.json.lock");
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    holderId: "test-lock-holder",
    expiresAt: new Date(Date.now() + 4_000).toISOString(),
  })}\n`, { flag: "wx", mode: 0o600 });

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
    const resumed = await waitForValue(() => (stdout.includes("controller lease expired · resumed") ? "resumed" : null), 20_000);
    assert.equal(resumed, "resumed", stdout);

    // A concurrently healthy controller owns the run lease. The detached resume
    // loses the lease race and supervision must continue without attention.
    writeJsonAtomic(join(runDir, "controller-lease.json"), {
      schemaVersion: 1,
      contractVersion: "0.1.0",
      holderId: "concurrent-controller",
      generation: 2,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    unlinkSync(lockPath);

    const contended = await waitForValue(() => (stdout.includes("lease contended") ? "contended" : null), 20_000);
    assert.equal(contended, "contended", stdout);
    assert.equal(existsSync(join(runDir, "supervisor-attention.json")), false, "benign lease contention must not raise attention");
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
    try { unlinkSync(lockPath); } catch {}
    supervisor.kill("SIGTERM");
  }
});

test("supervisor persists and delivers attention when resume is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-supervisor-attention-"));
  const path = writeContract(directory, fixture({ id: "supervisor-attention-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  metadata.sourceIdentity.cwd = "/unexpected-source";
  writeFileSync(join(runDir, "run.json"), JSON.stringify(metadata));
  const delivered = join(directory, "attention.jsonl");
  const notifier = join(directory, "notify-attention.mjs");
  writeFileSync(notifier, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(delivered)}, input); });\n`);
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.PLAN_RUNNER_NOTIFY_BIN;
  const previousCodex = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_NOTIFY_BIN = notifier;
  process.env.PLAN_RUNNER_CODEX_BIN = fakeCodex(directory, "pass");
  try {
    await superviseRun(runDir, 0.01);
    const attention = JSON.parse(readFileSync(join(runDir, "supervisor-attention.json"), "utf8"));
    assert.equal(attention.code, "resume_failed");
    const events = readFileSync(delivered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "run.attention" && event.data.code === "resume_failed"));
  } finally {
    if (previousNotify === undefined) delete process.env.PLAN_RUNNER_NOTIFY_BIN;
    else process.env.PLAN_RUNNER_NOTIFY_BIN = previousNotify;
    if (previousCodex === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previousCodex;
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
    const artifact = /** @type {{nodes: Array<{id: string, error: {code: string}, blockedBy?: string[]}>}} */ (JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8")));
    assert.equal(artifact.nodes.length, 2);
    const blockedNode = artifact.nodes.find((node) => node.id === "second");
    assert.ok(blockedNode, "blocked node recorded in the artifact");
    assert.equal(blockedNode.error.code, "dependency_failed");
    assert.deepEqual(blockedNode.blockedBy, ["first"]);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});
