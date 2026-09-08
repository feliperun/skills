import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
import { MAX_NOTE_LENGTH, renderReportJson, renderStatusJson } from "./render.mjs";
import {
  cancelRun,
  detectStalls,
  invocationAlive,
  invocationResult,
  livenessState,
  monitorInvocation,
  preflightContract,
  runContract,
  resumeRun,
  startProcess,
  terminateInvocation,
} from "./runner.mjs";
import { processStartToken } from "./lock.mjs";
import { failoverEdges, nextHop, nextSynthesizedRuntime } from "./failover.mjs";
import { NETWORK_BACKOFF_CAP_MS, NETWORK_MAX_ATTEMPTS, backoffDelayMs, classifyTransition, isRepairable, isTimeoutOrStall, networkBackoffAttempts, quotaResetSchedule } from "./backoff.mjs";
import { captureWorkspaceSnapshot } from "./verification.mjs";
import { attemptWorktreePath, runRefName } from "./worktree.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, bootstrapPath, cleanupBootstrapAttempts, writeJsonAtomic } from "./store.mjs";
import { getDriver } from "./drivers/index.mjs";
import {
  closeResult,
  delay,
  ensureAttemptWorktree,
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

/** @param {string} runDir @returns {Record<string, unknown>[]} */
function notifications(runDir) {
  const path = join(runDir, "notify.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * A completed run merges its work onto the run ref, not into the shared
 * repository's own working tree: the isolated attempt worktree that made the
 * change is already removed by the time the run finishes.
 * @param {string} repo @param {string} ref @param {string} path @returns {string}
 */
function showRefFile(repo, ref, path) {
  return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8" });
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

/**
 * A codex-shaped provider for the durable worker-result protocol: the worker
 * prompt carries the canonical result-file path, and each mode proves one
 * recovery property. "file-first" writes a result file that differs from its
 * final message, "missing-then-mutates" completes the first worker turn with
 * no message and no file then mutates the workspace during the one-turn
 * materialization, "missing-then-file-vs-message" materializes a file that
 * contradicts its final message, "missing-then-noop" ends the one result-only
 * turn with neither file nor message, and "revision-regrinds" writes a
 * counter-suffixed result per worker run so a gate revision must clear the
 * stale file.
 *
 * @param {string} directory
 * @param {"file-first"|"missing-then-mutates"|"missing-then-file-vs-message"|"missing-then-noop"|"revision-regrinds"} mode
 * @returns {string}
 */
function resultFileCodex(directory, mode) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-result-file-")), `result-file-${mode}.mjs`);
  const workerCounter = join(directory, ".runs", `result-file-${mode}-workers`);
  const judgeCounter = join(directory, ".runs", `result-file-${mode}-judges`);
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const resultless = mode === "missing-then-mutates" || mode === "missing-then-file-vs-message" || mode === "missing-then-noop";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const materialization = prompt.startsWith("The implementation is already complete");
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const result = (summary) => JSON.stringify({ status: "done", summary, changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "result-file-thread" }));
    if (resultless && !materialization && !judge) {
      // Worker completes with usage but no final message and no canonical result file.
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
      return;
    }
    if (mode === "missing-then-mutates" && materialization) {
      writeFileSync("unexpected.txt", "outside the materialization authority\\n");
    }
    if (mode === "missing-then-file-vs-message" && materialization) {
      // The one result-only turn writes a canonical file that contradicts its
      // own final message: only the file is authoritative.
      if (resultPath) writeFileSync(resultPath, result("materialized from file"));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result("materialized from message") } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 6, output_tokens: 1 } }));
      return;
    }
    if (mode === "missing-then-noop" && materialization) {
      // The one result-only turn ends without the canonical file or any message.
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 6, output_tokens: 1 } }));
      return;
    }
    if (judge) {
      appendFileSync(${JSON.stringify(judgeCounter)}, "x\\n");
      const run = readFileSync(${JSON.stringify(judgeCounter)}, "utf8").trim().split("\\n").length;
      const text = run === 1
        ? JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "critical defect", findings: [{ severity: "critical", description: "broken [works]", evidence: "test failed" }] })
        : JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
      return;
    }
    appendFileSync(${JSON.stringify(workerCounter)}, "x\\n");
    const run = readFileSync(${JSON.stringify(workerCounter)}, "utf8").trim().split("\\n").length;
    const summary = mode === "file-first" ? "from message" : \`worker attempt \${run}\`;
    if (resultPath) writeFileSync(resultPath, result(mode === "file-first" ? "from file" : \`worker attempt \${run}\`));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result(summary) } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @param {string} directory @param {"file-first"|"missing-then-mutates"|"missing-then-file-vs-message"|"missing-then-noop"|"revision-regrinds"} mode @param {string} path @returns {Promise<import("./runner.mjs").RunOutcome>} */
async function withResultFileCodex(directory, mode, path) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = resultFileCodex(directory, mode);
  try {
    return await runContract(path);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-mode provider whose judge always rejects the judgment item it is
 * asked to arbitrate with a cited critical finding, so the rejection is a
 * legitimate gate revision rather than an uncited protocol failure.
 *
 * @param {string} directory
 * @returns {string}
 */
function citedGateCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-cited-gate-")), "cited-gate.mjs");
  const workerCounter = join(directory, ".runs", "cited-gate-workers");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    if (!prompt.startsWith("Review node")) {
      const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
      appendFileSync(${JSON.stringify(workerCounter)}, "x\\n");
      const run = readFileSync(${JSON.stringify(workerCounter)}, "utf8").trim().split("\\n").length;
      const result = JSON.stringify({ status: "done", summary: \`worker attempt \${run}\`, changedFiles: [], verification: [], artifacts: [], missingContext: [] });
      if (resultPath) writeFileSync(resultPath, result);
      console.log(JSON.stringify({ type: "thread.started", thread_id: "cited-gate-thread" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
      return;
    }
    const text = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "judgment item [works] is not satisfied", findings: [{ severity: "critical", description: "item [works] is not satisfied", evidence: "quality is below the bar for works" }] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "cited-gate-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} fn @returns {Promise<T>} */
async function withCitedGateCodex(directory, fn) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = citedGateCodex(directory);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-mode provider whose judge returns a cited minor advisory verdict
 * that settles below failOn critical, with the same usage shape as the
 * generic fake codex so token-total assertions keep holding under the
 * conditional judge (uncited fail verdicts are now protocol failures).
 *
 * @param {string} directory
 * @returns {string}
 */
function advisoryGateCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-advisory-gate-")), "advisory-gate.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const text = judge
      ? JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor advisory", findings: [{ severity: "minor", description: "minor advisory on [works]", evidence: "advisory" }] })
      : JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (!judge && resultPath) writeFileSync(resultPath, text);
    console.log(JSON.stringify({ type: "thread.started", thread_id: "advisory-gate-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} fn @returns {Promise<T>} */
async function withAdvisoryGateCodex(directory, fn) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = advisoryGateCodex(directory);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-mode provider whose judge rejects the judgment item it is asked to
 * arbitrate with a cited critical finding, so the rejection is a legitimate
 * gate revision rather than an uncited protocol failure.
 *
 * @param {string} directory
 * @returns {string}
 */
function brokenGateCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-broken-gate-")), "broken-gate.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const text = judge
      ? JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "critical defect", findings: [{ severity: "critical", description: "broken [works]", evidence: "test failed" }] })
      : JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (!judge && resultPath) writeFileSync(resultPath, text);
    console.log(JSON.stringify({ type: "thread.started", thread_id: "broken-gate-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} fn @returns {Promise<T>} */
async function withBrokenGateCodex(directory, fn) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = brokenGateCodex(directory);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

test("runs the CLI through an installed symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-symlink-"));
  const contractPath = writeContract(directory, fixture({
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["build"], gate: false },
    ],
  }));
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
  execFileSync("git", ["-C", directory, "add", ".gitignore"]);
  execFileSync("git", ["-C", directory, "-c", "user.email=doctor@example.test", "-c", "user.name=doctor", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
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

test("doctor reports an unborn repository as a failing git check", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-unborn-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory], { encoding: "utf8" });
  const payload = /** @type {{schemaVersion: number, ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.ok, false, "an unborn repository must not report doctor as healthy");
  const gitCheck = payload.checks.find((check) => check.name === "git");
  assert.ok(gitCheck, "git check present");
  assert.equal(gitCheck.ok, false);
  assert.match(gitCheck.detail, /at least one commit/u);
  assert.equal(readdirSync(directory).sort().join(","), ".git,.gitignore", "doctor creates no run state");
});

test("doctor does not fail a driver resolved through an explicit executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-override-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  execFileSync("git", ["-C", directory, "add", ".gitignore"]);
  execFileSync("git", ["-C", directory, "-c", "user.email=doctor@example.test", "-c", "user.name=doctor", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const worker = join(directory, "my-worker.mjs");
  writeFileSync(worker, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('my-worker 1.0.0');\n");
  chmodSync(worker, 0o755);
  const contract = join(directory, "contract.json");
  writeFileSync(contract, `${JSON.stringify({
    schemaVersion: 3,
    contractVersion: "0.1.0",
    id: "doctor-run",
    campaignId: "doctor-campaign",
    goal: "doctor",
    cwd: ".",
    runtimeDefaults: { worker: "wrapped", judge: "wrapped" },
    runtimes: { wrapped: { driver: "exec-jsonl", model: "m", vendor: "wrapped-vendor", executable: "./my-worker.mjs" } },
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
  assert.equal(statusPayload.controller.state, "none");
  assert.equal(statusPayload.nodes[0].status, "done");
  const report = spawnSync(process.execPath, [cli, "report", "--json", runDir], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  const reportPayload = JSON.parse(report.stdout);
  assert.equal(reportPayload.schemaVersion, 1);
  assert.equal(reportPayload.totals.inputTokens, 10);
  assert.equal(reportPayload.nodes[0].revisions, 0);
});

test("incident freeze rejects resume mutations while status and report remain readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-incident-freeze-"));
  const path = writeContract(directory, fixture({ id: "incident-freeze-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(runDir, "incident-freeze.json"), "{}\n");
  await assert.rejects(
    () => resumeRun(runDir),
    (error) => error instanceof Error && /** @type {{code?: string}} */ (error).code === "incident_frozen",
  );
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  for (const command of ["status", "report"]) {
    const result = spawnSync(process.execPath, [cli, command, "--json", runDir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
  }
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
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
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
  const path = writeContract(directory, fixture({
    id: "protocol-failover-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "first", judge: "judge" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second },
      judge: { driver: "codex", model: "judge", vendor: "openai-judge" },
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

test("a retried attempt continues from the previous attempt's sealed worktree instead of a fresh cut from the integration head", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-continue-sealed-"));
  const path = writeContract(directory, fixture({
    id: "continue-sealed-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ writeFiles: ["README.md", "carried.txt"], verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "continuation-carries-file", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.attempt, 2);
  assert.equal(state.revisions, 1);
  assert.equal(state.worktree?.previousAttempt, 1, "the second attempt's worktree records which sealed attempt it continues");
  assert.ok(state.worktree?.path && existsSync(state.worktree.path), "the exhausted attempt keeps its worktree for inspection");
  assert.equal(
    readFileSync(join(state.worktree.path, "carried.txt"), "utf8"),
    "attempt-1\n",
    "attempt 2 began from attempt 1's sealed edit rather than a fresh cut from the integration head",
  );
});

test("oversized judge prompt fails before judge spawn or persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-prompt-cap-"));
  const path = writeContract(directory, fixture({
    id: "judge-prompt-cap-run",
    pollIntervalMs: 10,
    // The judge must be required (a judgment item) for the prompt cap to bite:
    // a purely mechanical Definition of Done now settles without a judge.
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: /** @type {import("./definition-of-done.mjs").DefinitionOfDoneItem[]} */ ([
        { id: "huge-0", text: "x".repeat(2 * 1024), judgment: true },
        ...Array.from({ length: 40 }, (_, index) => ({ id: `huge-${index + 1}`, text: "y".repeat(2 * 1024), proof: { kind: "command", ref: "true" } })),
      ]),
      taskPacket: packet(),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "judge prompt cap records an error");
  assert.equal(state.error.code, "judge_prompt_too_large");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0);
});

test("skips the judge when every Definition of Done item is mechanical", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-mechanical-gate-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-mechanical-gate-out-"));
  const script = join(outDir, "mechanical-proof.mjs");
  const marker = join(outDir, "proved.txt");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "proved");\n`);
  const fake = join(directory, "mechanical-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("mechanical-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "mech" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "mech", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "mechanical-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "marker", text: "marker file exists", proof: { kind: "command", ref: `${process.execPath} ${script}` } }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass", "the mechanical gate records a green verdict");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge invocation for a purely mechanical Definition of Done");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  assert.equal(readFileSync(marker, "utf8"), "proved", "the mechanical proof command ran in the contract workspace");
});

test("invokes the judge with the deterministic checklist when a judgment item exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judgment-gate-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judgment-gate-out-"));
  writeFileSync(join(directory, "proved.txt"), "proved");
  const promptPath = join(outDir, "judge-prompt.txt");
  const fake = join(directory, "judgment-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("judgment-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    writeFileSync(${JSON.stringify(promptPath)}, request.prompt);
    const result = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "quality passes", findings: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judgment-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [
        { id: "proved", text: "marker file exists", proof: { kind: "path", ref: "proved.txt" } },
        { id: "quality", text: "the result is high quality", judgment: true },
      ],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 1, "the judgment item invokes the judge");
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.judge.jsonl")), true, "judge protocol events are persisted");
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /Judgment items — arbitrate only these:\n- \[quality\]/u);
  assert.match(prompt, /Deterministic items — already proven by the controller/u);
  assert.match(prompt, /- \[proved\] PASS — marker file exists \(proof: path proved\.txt\)/u);
  assert.match(prompt, /do not re-arbitrate them/u);
  assert.match(prompt, /Arbitrate only the judgment items/u);
});

test("a failing mechanical proof rejects the worker generation without any judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-mechanical-fail-"));
  const fake = join(directory, "mechanical-fail-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("mechanical-fail-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "mech" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "mech", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "mechanical-fail-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "must-pass", text: "the check passes", proof: { kind: "command", ref: `${process.execPath} -e ${JSON.stringify("process.exit(3)")}` } }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "mechanical_gate_failed");
  assert.equal(state.revisions, 1, "a failing mechanical proof consumes a bounded revision like deterministic verification");
  assert.equal(state.attempt, 2);
  assert.equal(state.gate?.verdict, "fail");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge was ever invoked");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("an uncited judge rejection re-asks once then blocks attention without consuming a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptOne = join(outDir, "judge-prompt-1.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(promptOne)} : ${JSON.stringify(promptTwo)}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(state.attempt, 1);
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});

test("skips the judge for an empty Definition of Done checklist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-empty-dod-gate-"));
  const judgeCalls = join(directory, ".runs", "empty-dod-judge-calls.txt");
  const fake = join(directory, "empty-dod-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("empty-dod-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    appendFileSync(${JSON.stringify(judgeCalls)}, "x\\n");
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "unexpected-judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: "not a structured judge result", continuationId: "unexpected-judge", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "empty-dod-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass", "an empty checklist settles mechanically with a green verdict");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "an empty Definition of Done never invokes the judge");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")), "no judge protocol events for an empty Definition of Done");
  assert.ok(!existsSync(judgeCalls), "the judge provider is never spawned for an empty Definition of Done");
});

test("an uncited fail below the gate failOn threshold is a judge protocol failure, not a pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-below-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-below-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptOne = join(outDir, "judge-prompt-1.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  // A minor verdict sits below every failOn set a blocking review may declare,
  // so an uncited minor rejection isolates the protocol rule from the threshold.
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor but uncited", findings: [{ severity: "minor", description: "the work needs rework", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-below-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-below-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(promptOne)} : ${JSON.stringify(promptTwo)}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-below-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(state.attempt, 1);
  assert.equal(state.gate?.verdict, "fail", "the below-threshold verdict is recorded");
  assert.equal(state.gate?.maxSeverity, "minor", "an uncited fail below failOn is a protocol failure, not a pass");
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "the bounded re-ask still applies below the failOn threshold");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});

test("a judge protocol re-ask over a mixed checklist neither reruns mechanical proofs nor consumes a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-mixed-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-mixed-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const proofRuns = join(outDir, "proof-runs.txt");
  const proofScript = join(outDir, "counting-proof.mjs");
  // Passes on its first execution and fails on every later one, so a re-ask
  // that reran it would turn the mechanical gate red instead of blocking.
  writeFileSync(proofScript, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(proofRuns)}, "x\\n");\nprocess.exit(readFileSync(${JSON.stringify(proofRuns)}, "utf8").trim().split("\\n").filter(Boolean).length > 1 ? 1 : 0);\n`);
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-mixed-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-mixed-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(join(outDir, "judge-prompt-1.txt"))} : ${JSON.stringify(join(outDir, "judge-prompt-2.txt"))}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-mixed-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [
        { id: "proved", text: "the proof command runs", proof: { kind: "command", ref: `${process.execPath} ${proofScript}` } },
        { id: "quality", text: "the result is high quality", judgment: true },
      ],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "the judge protocol failure never consumes a worker revision");
  assert.equal(state.attempt, 1);
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal(readFileSync(proofRuns, "utf8").trim().split("\n").filter(Boolean).length, 1, "the mechanical proof runs exactly once and is not rerun by the re-ask");
  assert.match(readFileSync(join(outDir, "judge-prompt-2.txt"), "utf8"), /already proven by the controller/u);
});

test("the judge re-ask bound survives a controller crash in either gap because it is persisted with the node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-reask-durable-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-reask-durable-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const runDir = join(directory, ".runs", "judge-reask-durable-run");
  // Crash images the controller itself persisted, taken at the two instants a
  // standalone marker left open: the write that dispatches the bounded re-ask,
  // and the moment its verdict is durable while the blocked transition is not.
  // Each excludes what no successor controller inherits: the dead controller's
  // lock, its in-flight atomic temporaries and its file locks.
  const dispatchGap = join(directory, ".runs", "judge-reask-dispatch-gap");
  const verdictGap = join(directory, ".runs", "judge-reask-verdict-gap");
  /** @param {string} source @returns {boolean} */
  const inherited = (source) => !source.endsWith(".tmp") && !source.endsWith(".lock") && !source.endsWith("controller.lock");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "durable-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("durable-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(join(outDir, "judge-prompt-1.txt"))} : ${JSON.stringify(promptTwo)}, request.prompt);
    // The re-ask is in flight and its verdict is not written yet: this is the
    // image a controller loss leaves behind between dispatch and verdict.
    if (count === 1) cpSync(${JSON.stringify(runDir)}, ${JSON.stringify(dispatchGap)}, { recursive: true, filter: ${inherited.toString()} });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: ${JSON.stringify(uncited)}, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-reask-durable-run",
    // Wide enough that the closed re-ask stays durable-but-unapplied for a
    // whole poll interval, the window the verdict-gap image is taken in.
    pollIntervalMs: 250,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const nodePath = join(runDir, "nodes", "build.json");
  let capturedVerdictGap = false;
  const capturing = setInterval(() => {
    if (capturedVerdictGap) return;
    let persisted;
    try { persisted = JSON.parse(readFileSync(nodePath, "utf8")); } catch { return; }
    const last = /** @type {Record<string, unknown>[]} */ (persisted.invocations ?? []).at(-1);
    const spent = /** @type {Record<string, unknown>[]} */ (persisted.executionOverrides ?? []).some((item) => item.kind === "judge-reask");
    if (!spent || persisted.status !== "running" || last?.phase !== "judge" || last?.status !== "closed") return;
    capturedVerdictGap = true;
    cpSync(runDir, verdictGap, { recursive: true, filter: inherited });
  }, 5);
  const state = nodeState(await runContract(path).finally(() => clearInterval(capturing)));
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal(existsSync(join(runDir, "judge-reask")), false, "the bound is node state, not a standalone marker beside it");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);

  // Gap one: the write that spends the bound is the write that dispatches the
  // re-ask, so no crash image can hold one without the other.
  const dispatched = JSON.parse(readFileSync(join(dispatchGap, "nodes", "build.json"), "utf8"));
  assert.ok(
    /** @type {Record<string, unknown>[]} */ (dispatched.executionOverrides).some((item) => item.kind === "judge-reask"),
    "the crash image carries the bound in the node snapshot",
  );
  assert.equal(
    /** @type {Record<string, unknown>[]} */ (dispatched.invocations).filter((item) => item.phase === "judge").length,
    2,
    "the same atomic write carries the re-ask that bound permits",
  );
  const afterDispatch = nodeState(await resumeRun(dispatchGap));
  assert.equal(afterDispatch.status, "blocked", afterDispatch.error?.message);
  assert.equal(afterDispatch.phase, "judge");
  assert.equal(afterDispatch.error?.code, "judge_protocol", "the replayed re-ask blocks instead of asking a second one");
  assert.equal(afterDispatch.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(afterDispatch.attempt, 1, "the recovered re-ask does not burn a worker attempt");
  assert.equal((afterDispatch.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((afterDispatch.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "recovery replays the interrupted re-ask exactly once");

  // Gap two: the re-ask verdict is durable and the blocked transition is not,
  // so recovery reads the spent bound from the node and blocks rather than
  // treating the second uncited verdict as a first failure.
  assert.ok(capturedVerdictGap, "the controller persisted the re-ask verdict before the blocked transition");
  const afterVerdict = nodeState(await resumeRun(verdictGap));
  assert.equal(afterVerdict.status, "blocked", afterVerdict.error?.message);
  assert.equal(afterVerdict.phase, "judge");
  assert.equal(afterVerdict.error?.code, "judge_protocol", "the recovered second uncited verdict is not a first failure");
  assert.equal(afterVerdict.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal((afterVerdict.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "the recovered verdict settles the node without another judge invocation");
  assert.ok(notifications(verdictGap).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
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

test("an unexpected write on green verification is an advisory finding, not a terminal failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-"));
  writeFileSync(join(directory, "preexisting.txt"), "keep me\n");
  const path = writeContract(directory, fixture({
    id: "scope-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.error, null, "an advisory scope finding records no terminal error");
  assert.ok(state.scope, "scope snapshot persisted");
  assert.ok(state.scope.unexpectedPaths.includes("unexpected.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["unexpected.txt"]);
  assert.equal(readFileSync(join(directory, "preexisting.txt"), "utf8"), "keep me\n", "pre-existing dirt is preserved");
  assert.equal(existsSync(join(result.runDir, "findings.json")), false, "a done run leaves no findings artifact");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const finding = events.find((event) => event.type === "scope.finding");
  assert.ok(finding, "a scope.finding event is appended");
  assert.deepEqual(finding.unexpectedPaths, ["unexpected.txt"]);
  assert.equal(finding.unexpectedPathCount, 1);

  const cleanDirectory = mkdtempSync(join(tmpdir(), "runner-scope-clean-"));
  writeFileSync(join(cleanDirectory, "preexisting.txt"), "keep me\n");
  const cleanPath = writeContract(cleanDirectory, fixture({
    id: "scope-clean-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const clean = await withFakeCodex(cleanDirectory, "pass", () => runContract(cleanPath));
  assert.equal(nodeState(clean).status, "done");
  assert.equal(nodeState(clean).scopeFindings, undefined, "a clean attempt records no scope finding");

  // The same advisory outcome reaches a gated node: the judge is told about
  // the unexpected paths and the finding stays visible in status, where the
  // gate summary would otherwise be the whole node note.
  const gatedDirectory = mkdtempSync(join(tmpdir(), "runner-scope-gated-"));
  const gatedPath = writeContract(gatedDirectory, fixture({
    id: "scope-gated-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const gated = await withFakeCodex(gatedDirectory, "write-unexpected-judge-prompt", () => runContract(gatedPath));
  const gatedState = nodeState(gated);
  assert.equal(gatedState.status, "done", gatedState.error?.message);
  assert.deepEqual(gatedState.scopeFindings?.unexpectedPaths, ["unexpected.txt"], "a gated done node keeps its advisory finding");
  assert.equal(gatedState.gate?.verdict, "fail", "the advisory gate verdict is recorded");
  assert.equal(gatedState.gate?.summary, "minor advisory");
  const seenByJudge = readFileSync(join(gatedDirectory, ".runs", "judge-prompt.txt"), "utf8");
  assert.match(seenByJudge, /Scope findings/u);
  assert.match(seenByJudge, /- unexpected\.txt/u);

  // One stable format for a node that carries both: the scope note, then the
  // review note, then the gate summary it would otherwise hide.
  const note = /scope: 1 unexpected path · advisory: 1 finding · minor advisory/u;
  const status = renderStatus(gated.runDir);
  assert.match(status, note);
  const payload = /** @type {{nodes: {id: string, note: string, scopeFindings: string[]|null}[]}} */ (JSON.parse(renderStatusJson(gated.runDir)));
  assert.equal(payload.nodes[0].note, "scope: 1 unexpected path · advisory: 1 finding · minor advisory");
  assert.deepEqual(payload.nodes[0].scopeFindings, ["unexpected.txt"]);
  // STATUS.md is the artifact the campaign reads: it shows the same note.
  const statusArtifact = readFileSync(join(gated.runDir, "STATUS.md"), "utf8");
  assert.match(statusArtifact, note);
  assert.match(renderReport(gated.runDir), /scope: 1 unexpected path · advisory: 1 finding/u);

  // A gate summary longer than the note budget cannot make the surfaces
  // disagree: the summary is the part the bound cuts, and the JSON carries the
  // very string the tables render.
  const longDirectory = mkdtempSync(join(tmpdir(), "runner-scope-gated-long-"));
  const longPath = writeContract(longDirectory, fixture({
    id: "scope-gated-long-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const long = await withFakeCodex(longDirectory, "write-unexpected-long-review", () => runContract(longPath));
  assert.equal(nodeState(long).status, "done", nodeState(long).error?.message);
  const longNote = /** @type {string} */ (JSON.parse(renderStatusJson(long.runDir)).nodes[0].note);
  assert.equal(longNote.length, MAX_NOTE_LENGTH, "the note is bounded to the width every surface shows");
  assert.match(longNote, /^scope: 1 unexpected path · advisory: 1 finding · /u, "the advisory markers survive a cut summary");
  assert.ok(longNote.endsWith("…"), "a cut summary is marked as cut");
  for (const [surface, text] of [
    ["the status table", renderStatus(long.runDir)],
    ["STATUS.md", readFileSync(join(long.runDir, "STATUS.md"), "utf8")],
    ["the report", renderReport(long.runDir)],
  ]) {
    assert.ok(text.includes(longNote), `${surface} shows the same bounded note`);
  }
});

test("an incomplete worker that writes outside scope still fails with unexpected_write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-incomplete-"));
  const path = writeContract(directory, fixture({
    id: "scope-incomplete-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-failed", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write", "the provider failure must not displace the scope verdict");
  assert.match(state.error?.message ?? "", /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "only a completed attempt earns an advisory finding");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));
});

test("a scope violation on failed verification keeps the failure and appends the unexpected paths to the message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-red-"));
  const path = writeContract(directory, fixture({
    id: "scope-red-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(1)"] }] }),
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.match(state.error.message, /unexpected paths changed/u);
  assert.match(state.error.message, /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "a failed attempt never gets an advisory finding");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));
});

test("a done envelope whose worker result is not done still fails with unexpected_write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-blocked-result-"));
  const path = writeContract(directory, fixture({
    id: "scope-blocked-result-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-blocked-context", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write", "a blocked_context result is not completed work and cannot defer the scope verdict");
  assert.match(state.error?.message ?? "", /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "only an accepted worker result earns an advisory finding");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));

  // An unparseable result behind a done envelope is the same verdict: the
  // envelope alone never earns the deferred scope decision, so the paths stay
  // terminal instead of vanishing into an invalid-result repair.
  const invalidDirectory = mkdtempSync(join(tmpdir(), "runner-scope-invalid-result-"));
  const invalidPath = writeContract(invalidDirectory, fixture({
    id: "scope-invalid-result-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const invalid = await withFakeCodex(invalidDirectory, "write-unexpected-invalid-result", () => runContract(invalidPath));
  const invalidState = nodeState(invalid);
  assert.equal(invalidState.status, "failed");
  assert.equal(invalidState.error?.code, "unexpected_write");
  assert.equal(invalidState.scopeFindings, undefined);
});

test("a done envelope without the canonical result file keeps the terminal unexpected_write", async () => {
  // The final message alone is not accepted work: the controller materializes
  // the canonical file from it only after the scope gate, so an attempt that
  // also wrote outside its scope never reaches verification or a finding.
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-message-only-"));
  const path = writeContract(directory, fixture({
    id: "scope-message-only-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-message-only", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write", "a done envelope without the canonical file cannot defer the scope verdict");
  assert.match(state.error?.message ?? "", /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "no advisory finding without an accepted worker result");
  assert.equal(existsSync(join(result.runDir, "results", "build.json")), false, "the envelope result was never materialized");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));
});

test("a scope violation on a gated red attempt reaches the retry prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-red-revision-"));
  const path = writeContract(directory, fixture({
    id: "scope-red-revision-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(1)"] }] }),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-revision", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.attempt, 2, "the gate spent its revision before stopping");
  assert.equal(state.status, "exhausted", state.error?.message);
  assert.equal(state.error?.code, "verification_failed");
  assert.match(state.error?.message ?? "", /unexpected paths changed/u);
  assert.match(state.error?.message ?? "", /unexpected-2\.txt/u);
  assert.equal(state.scopeFindings, undefined, "a failed attempt never gets an advisory finding");
  // The next attempt is dispatched before the terminal branch, so the paths
  // have to travel inside the verdict: the node state that carried them is
  // cleared by the time the revision starts.
  const retryPrompt = readFileSync(join(directory, ".runs", "scope-retry-prompt.txt"), "utf8");
  assert.match(retryPrompt, /quality gate rejected/u);
  assert.match(retryPrompt, /unexpected paths changed/u);
  assert.match(retryPrompt, /unexpected-1\.txt/u);
});

test("a worker-created symlink cannot authorize its target, but is advisory on green verification", async () => {
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
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt"]);
  assert.equal(showRefFile(directory, runRefName("scope-new-symlink-run"), "outside.txt"), "unauthorized target\n");
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["outside.txt"]);
});

test("retargeting a contained alias cannot authorize the new target, but is advisory on green verification", async () => {
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
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["outside.txt"]);
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
  assert.equal(showRefFile(directory, runRefName("scope-contained-alias-run"), "src.txt"), "authorized target\n");
});

test("a file write root matches exactly that path in the scope gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-file-root-"));
  writeFileSync(join(directory, "notes.md"), "before\n");
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["notes.md"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-file-root-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-file-root", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.roots, ["notes.md"]);
  assert.equal(state.scope?.unexpectedPaths.length, 0);
  assert.equal(state.scopeFindings, undefined);
  assert.equal(showRefFile(directory, runRefName("scope-file-root-run"), "notes.md"), "in the file root\n");
});

test("a file write root does not authorize a sibling file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-file-root-sibling-"));
  writeFileSync(join(directory, "notes.md"), "before\n");
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["notes.md"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-file-root-sibling-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-outside-file-root", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.ok(state.scope?.unexpectedPaths.includes("sibling.md"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["sibling.md"]);
});

test("a file write root does not authorize a path beneath a same-named directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-file-root-nested-"));
  writeFileSync(join(directory, "notes.md"), "before\n");
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["notes.md"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-file-root-nested-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-under-file-root", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.fileRoots, ["notes.md"], "the boundary records the root that named a file");
  assert.ok(state.scope?.unexpectedPaths.includes("notes.md/nested.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["notes.md/nested.txt"]);
});

test("accepts parallel execution now that attempt worktrees provide isolation", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-max-parallel-"));
  const path = writeContract(directory, fixture({ maxParallel: 2 }));
  assert.equal(validateContract(JSON.parse(readFileSync(path, "utf8")), path).maxParallel, 2);
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
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "silent");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(nodeState(result).status, "stalled");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("preserves the worker report when the judge provider fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-fail-"));
  const path = writeContract(directory, fixture({
    id: "judge-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { review: "blocking", failOn: ["major", "critical"] } }],
  }));
  const result = await withFakeCodex(directory, "judge-fail", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "one bounded judge retry before blocking");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
});

test("a judge whose tool host is disabled never yields a verdict and blocks as judge_unavailable after one retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-tool-host-"));
  const path = writeContract(directory, fixture({
    id: "judge-tool-host-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { review: "blocking", failOn: ["major", "critical"] } }],
  }));
  const result = await withFakeCodex(directory, "judge-tool-host-disabled", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.match(state.error?.message ?? "", /code-mode host is disabled/u);
  assert.equal(state.gate, null, "no fabricated verdict is ever adopted");
  const judgeInvocations = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judgeInvocations.length, 2, "exactly one bounded judge retry after the first tool-host failure");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_unavailable"));
});

/**
 * A codex-shaped provider whose judge produces one review-protocol defect.
 * `two-verdicts` streams two agent messages that each carry a verdict,
 * `empty-output` ends a finished turn without any verdict, and `no-terminal`
 * streams a verdict but never its terminal envelope. With `again` the defect
 * repeats on the bounded re-ask; otherwise the re-ask returns a clean verdict.
 *
 * @param {string} directory
 * @param {"two-verdicts"|"empty-output"|"no-terminal"|"two-verdicts-then-fail"} defect
 * @param {{again?: boolean}} [options]
 * @returns {string}
 */
function judgeDefectCodex(directory, defect, options = {}) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-judge-defect-")), `judge-defect-${defect}.mjs`);
  const calls = join(directory, ".runs", `judge-defect-${defect}${options.again ? "-again" : ""}-judges`);
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const defect = ${JSON.stringify(defect)};
const again = ${options.again ? "true" : "false"};
const calls = ${JSON.stringify(calls)};
if (process.argv.includes("--version")) {
  console.log("judge-defect 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const verdict = (summary) => JSON.stringify({ verdict: "pass", maxSeverity: "none", summary, findings: [] });
  const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
  console.log(JSON.stringify({ type: "thread.started", thread_id: "defect-thread" }));
  if (!prompt.startsWith("Review node")) {
    const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  appendFileSync(calls, "x\\n");
  const run = readFileSync(calls, "utf8").trim().split("\\n").filter(Boolean).length;
  if (run > 1 && !again && defect !== "two-verdicts-then-fail") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("clean re-ask") } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
    return;
  }
  if (defect === "two-verdicts-then-fail" && run > 1) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "re-ask provider died" } }));
    return;
  }
  if (defect === "two-verdicts") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("first verdict") } }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("second verdict") } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
    return;
  }
  if (defect === "no-terminal") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("clean but unsealed") } }));
    return;
  }
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
});
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {"two-verdicts"|"empty-output"|"no-terminal"|"two-verdicts-then-fail"} defect @param {{again?: boolean}} options @param {() => T | Promise<T>} runner @returns {Promise<T>} */
async function withJudgeDefectCodex(directory, defect, options, runner) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = judgeDefectCodex(directory, defect, options);
  try {
    return await runner();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-shaped provider whose worker finishes at once and whose judge keeps
 * emitting nothing past any wall-clock budget, so the judge phase is killed.
 *
 * @param {string} directory
 * @returns {string}
 */
function stallingJudgeCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-judge-stall-")), "judge-stall.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("judge-stall 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
  console.log(JSON.stringify({ type: "thread.started", thread_id: "stall-thread" }));
  if (!prompt.startsWith("Review node")) {
    const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
});
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} runner @returns {Promise<T>} */
async function withStallingJudgeCodex(directory, runner) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = stallingJudgeCodex(directory);
  try {
    return await runner();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

test("default review is advisory and the node records that it reviewed advisorially", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-default-"));
  const path = writeContract(directory, fixture({
    id: "review-default-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["minor", "major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withAdvisoryGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.review, "advisory", "an omitted review mode reviews advisorially");
  assert.equal(state.revisions, 0, "an advisory finding never consumes a revision");
  assert.equal(state.gate?.verdict, "fail");
  assert.equal(state.gate?.findings.length, 1);
});

test("an advisory fail verdict reaches done with findings and a gate.advisory event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-advisory-"));
  const path = writeContract(directory, fixture({
    id: "review-advisory-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "advisory", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(state.status, "done");
  assert.equal(state.review, "advisory");
  assert.equal(state.revisions, 0, "an advisory review never consumes a revision");
  assert.equal(state.gate?.verdict, "fail", "the fail verdict is recorded with its findings");
  assert.equal(state.gate?.maxSeverity, "critical");
  assert.equal(state.gate?.findings[0].description, "broken [works]");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const advisory = events.find((event) => event.type === "gate.advisory");
  assert.ok(advisory, "the advisory settle appends a gate.advisory event");
  assert.equal(advisory.verdict, "fail");
  assert.equal(advisory.node, "build");
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /advisory: 1 finding/u, "the status note leads with the advisory finding the gate summary would hide");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-dispatched");
});

test("blocking review is unchanged: a cited fail at the threshold consumes its revision and exhausts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-blocking-"));
  const path = writeContract(directory, fixture({
    id: "review-blocking-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, false);
  assert.equal(state.status, "exhausted");
  assert.equal(state.review, "blocking");
  assert.equal(state.error?.code, "revision_cap");
  assert.equal(state.revisions, 0);
  assert.equal(state.attempt, 1, "maxRevisions 0 grants no revision");
});

test("review none skips the judge and settles on the mechanical verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-none-"));
  const path = writeContract(directory, fixture({
    id: "review-none-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "none" },
    }],
  }));
  // A provider whose judge would reject everything proves the judge never runs.
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(state.status, "done");
  assert.equal(state.review, "none");
  assert.equal(state.gate?.verdict, "pass", "the checklist settles mechanically");
  assert.equal(state.gate?.findings.length, 0);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge is ever dispatched");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("two separate agent-message verdicts re-ask once and the re-ask recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-two-verdicts-"));
  const path = writeContract(directory, fixture({
    id: "review-two-verdicts-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.revisions, 0, "a judge protocol defect never consumes a revision");
  assert.equal(state.attempt, 1);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask");
  assert.equal(state.gate?.summary, "clean re-ask");
});

test("a provider failure on the bounded re-ask settles instead of dispatching a third judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-reask-fail-"));
  const path = writeContract(directory, fixture({
    id: "review-reask-fail-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts-then-fail", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge", "the node is left exactly as one awaiting its judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "the failed re-ask settles instead of buying a third judge");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
});

test("an empty judge output re-asks once and the re-ask recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-empty-output-"));
  const path = writeContract(directory, fixture({
    id: "review-empty-output-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "empty-output", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask after empty output");
  assert.equal(state.gate?.summary, "clean re-ask");
});

test("a missing terminal envelope re-asks once and the re-ask recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-no-terminal-"));
  const path = writeContract(directory, fixture({
    id: "review-no-terminal-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "no-terminal", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask after an incomplete stream");
  assert.equal(state.gate?.summary, "clean re-ask");
});

test("a judge timeout re-asks once then blocks as judge_unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-judge-timeout-"));
  const path = writeContract(directory, fixture({
    id: "review-judge-timeout-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      timeoutSec: 1,
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withStallingJudgeCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "the wall-clock kill earns exactly one bounded re-ask");
  assert.equal(state.gate, null, "no verdict is fabricated for a judge that never returned one");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_unavailable"));
});

test("advisory review settles invalid_judge_output and completes with the work recorded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-invalid-advisory-"));
  const path = writeContract(directory, fixture({
    id: "review-invalid-advisory-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "advisory", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts", { again: true }, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.gate?.verdict, "invalid_judge_output");
  assert.equal(state.gate?.findings.length, 0, "an invalid verdict records no findings");
  assert.match(state.gate?.summary ?? "", /2 separate verdicts/u);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "gate.advisory" && event.verdict === "invalid_judge_output"));
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "invalid_judge_output"), "the defective review is never silent");
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /judge: invalid output/u);
});

test("blocking review enters judge_unavailable with the worker result and verification preserved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-invalid-blocking-"));
  const path = writeContract(directory, fixture({
    id: "review-invalid-blocking-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts", { again: true }, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge", "the node is left exactly as one awaiting its judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal(state.gate, null, "the gate state stays empty until a verdict exists");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete", "the accepted worker result is preserved");
  assert.equal(state.verification?.passed, true, "the verification records are preserved");
  assert.equal(state.revisions, 0, "a review that never arbitrated consumes no revision");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_unavailable"));
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /needs you: judge unavailable/u);
});

test("a verification proof reuses the recorded result and executes nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-proof-reuse-"));
  // Writing into the run directory keeps the counter outside the workspace
  // snapshot, so the scope gate never sees the probe.
  const executions = join(directory, ".runs", "proof-reuse-run", "verification-executions");
  const path = writeContract(directory, fixture({
    id: "proof-reuse-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({
        verification: [{ argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(executions)}, "x\\n")`] }],
      }),
      definitionOfDone: [
        { id: "verified", text: "the controller verification passed", proof: { kind: "verification", ref: 0 } },
        { id: "works", text: "It works", judgment: true },
      ],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withAdvisoryGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  // Phase 1 added a second, independent run of the same verification
  // commands: the integration transaction re-verifies the sealed candidate
  // in its own scratch worktree before advancing the run ref. The judge's
  // "verified" proof still reuses the attempt's own recorded result rather
  // than triggering a run of its own — the candidate check is the only
  // reason this count is 2, not 1.
  assert.equal(readFileSync(executions, "utf8").trim().split("\n").filter(Boolean).length, 2, "the judge's verification proof reused the recorded result; only the candidate integration check re-ran the command");
  const proof = state.gate?.findings ?? [];
  assert.equal(proof.length, 1, "the advisory verdict is the only finding on the node");
  const prompt = readFileSync(join(result.runDir, "logs", "build.1.judge.jsonl"), "utf8");
  assert.ok(prompt.length > 0);
});


test("enforces the wall-clock cap even while output changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-"));
  const path = writeContract(directory, fixture({
    id: "timeout-run",
    pollIntervalMs: 10,
    stallTimeoutSec: 1,
    timeoutSec: 0.05,
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "heartbeat");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result).status, "exhausted");
    const timedOut = nodeState(result);
    assert.ok(timedOut.error, "timeout records an error");
    assert.equal(timedOut.error.code, "wall_clock_timeout");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("spends the wall-clock budget per phase, not per node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-budget-"));
  const path = writeContract(directory, fixture({
    id: "phase-budget-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: { failOn: ["critical"] } }],
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
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  assert.equal(result.ok, false);
  assert.equal(nodeState(result).status, "exhausted");
  assert.equal(nodeState(result).attempt, 2);
});

test("resume adopts an orphaned worker result instead of repeating the work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-"));
  const path = writeContract(directory, fixture({ id: "resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  unlinkSync(join(runDir, "results", "build.json"));
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
  // git tracks no empty directory: a placeholder makes "src" survive into
  // the isolated attempt worktree the alias symlink must resolve against.
  writeFileSync(join(directory, "src", ".keep"), "");
  symlinkSync("src", join(directory, "alias"));
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-symlink-root-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const workspace = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).worktree.path;
  writeFileSync(join(workspace, "src", "allowed.txt"), "allowed\n");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume source identity uses the pre-execution symlink boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-scope-boundary-"));
  mkdirSync(join(directory, "src"));
  // git tracks no empty directory: a placeholder makes "src" survive into
  // the isolated attempt worktree the alias symlink must resolve against.
  writeFileSync(join(directory, "src", ".keep"), "");
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
  // The retarget above changes the shared repository the fingerprint warning
  // reads; the scope gate itself compares the isolated attempt worktree, so
  // the same retarget is reproduced there for the recovered attempt to see.
  const workspace = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).worktree.path;
  unlinkSync(join(workspace, "alias"));
  symlinkSync("outside", join(workspace, "alias"));
  writeFileSync(join(workspace, "alias", "unauthorized.txt"), "unauthorized target\n");
  // Workers and the orchestrator commit between attempts, so a changed tree
  // fingerprint is a surfaced warning, never a refusal.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.ok(
    (metadata.identityWarnings ?? []).some((/** @type {string} */ warning) => warning.includes("fingerprint")),
    "the fingerprint mismatch is recorded on the run",
  );
  assert.match(readFileSync(join(runDir, "STATUS.md"), "utf8"), /fingerprint changed since the run started/u);
  assert.equal(resumed.ok, false, "the orphaned attempt still fails instead of passing silently");
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

test("resume refuses a head that is not a descendant of the recorded one", async () => {
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
  orphan(runDir, "build");
  // An unrelated history: not a descendant of the head the run was recorded
  // at, so the tree the run would continue on is not the one the work was
  // authorized against.
  execFileSync("git", ["-C", work, "checkout", "-q", "--orphan", "stray"]);
  execFileSync("git", ["-C", work, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-q", "-m", "unrelated history"]);
  await assert.rejects(
    () => withFakeCodex(directory, "worker-fail", () => resumeRun(runDir)),
    /source drift detected in gitHead; resume refused/u,
  );
});

test("resume adopts a completed orphan judge without running it twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-gate-"));
  const path = writeContract(directory, fixture({
    id: "resume-gate-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{id: string, attempt: number, invocations: Array<{id: string, phase: string, stdoutPath: string}>, worktree?: import("./contract.mjs").WorktreeState|null}} */
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const judgeInvocation = state.invocations.at(-1);
  assert.ok(judgeInvocation, "persisted judge invocation exists");
  writeFileSync(judgeInvocation.stdoutPath, "not a structured judge result\n");
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({ ...state, status: "running", phase: "judge", worktree }, null, 2));

  const resumed = await withAdvisoryGateCodex(directory, () => resumeRun(runDir));
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
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const started = join(directory, ".runs", "provider-started");
  const release = join(directory, ".runs", "provider-release");
  const slow = fakeCodex(directory, "wait-for-release");
  const first = spawn(process.execPath, [runner, "resume", runDir], {
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: slow },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // A freshly spawned `resume` controller spends several seconds in startup
    // (identity probing, snapshots) before its first provider spawn, so the
    // lock-held observation needs a wider window than the 5s default.
    await waitForValue(() => {
      try {
        return existsSync(started)
          && first.exitCode === null
          && JSON.parse(readFileSync(join(runDir, "controller.lock"), "utf8")).pid === first.pid
          ? "held"
          : null;
      } catch {
        return null;
      }
    }, 20_000);
    const second = spawn(process.execPath, [runner, "resume", runDir], {
      env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const secondResult = await closeResult(second);
    assert.notEqual(secondResult.code, 0, secondResult.stderr);
    assert.match(secondResult.stderr, /lock/u);
    writeFileSync(release, "release");
    const firstResult = await closeResult(first);
    assert.equal(firstResult.code, 0, `${firstResult.stderr}\n${firstResult.stdout}`);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    writeFileSync(release, "release");
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
  writeFileSync(join(runDir, "controller.lock"), JSON.stringify({
    schemaVersion: 1,
    pid: childPid(controller),
    processStartToken: processStartToken(childPid(controller)),
    startedAt: new Date(now - 100).toISOString(),
    hostname: "test-host",
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
  // The synthetic invocation below fabricates a fresh attempt by hand; a real
  // attempt start clears the previous attempt's canonical result file, so the
  // fabricated one must not inherit it.
  rmSync(join(runDir, "results", "build.json"), { force: true });
  state.worktree = ensureAttemptWorktree(runDir, state);
  const snapshotPath = join(runDir, "logs", "active-orphan.snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(captureWorkspaceSnapshot(state.worktree.path)));
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

test("resume terminates an interrupted verification attempt and re-runs the phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-resume-"));
  const path = writeContract(directory, fixture({ id: "verification-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const now = Date.now();
  state.worktree = ensureAttemptWorktree(runDir, state);
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
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    worktree,
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: timeoutAt, reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt: new Date().toISOString(), workspace: worktree?.path ?? invocation.workspace }],
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
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    worktree,
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
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "judge",
    worktree,
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
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).attempt, 2);

  // The judge must cite the judgment item id it rejects: an uncited rejection
  // is a protocol failure (bounded re-ask, then attention), never a revision.
  const final = await withCitedGateCodex(directory, () => resumeRun(runDir));
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
    schemaVersion: 3,
    contractVersion: "0.1.0",
    pid: 2_147_483_647,
    startedAt: "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run", contractId: "orphan-run", campaignId: "test-campaign" },
  }));
  assert.match(renderStatus(runDir), /build still claims to be running/u);
});

test("status --json flags an orphaned running node with controller state none", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-json-"));
  const path = writeContract(directory, fixture({ id: "orphan-json-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const payload = /** @type {{controller: {state: string}, summary: string, nodes: {id: string, status: string}[]}} */ (JSON.parse(renderStatusJson(runDir)));
  assert.equal(payload.controller.state, "none", "a missing controller lock while a node claims running must be machine-readable");
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
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
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const started = events.find((event) => event.to === "running" && event.phase === "worker");
  assert.equal(started.attempt, 1);
  assert.equal(started.runtime, "luna");
  const rejected = events.find((event) => event.to === "exhausted");
  assert.equal(rejected.verdict, "fail");
  assert.equal(rejected.error, "revision_cap");
  assert.equal(rejected.phase, "judge");
});

test("runner notifies node.terminal and run.terminal only, never a running node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-progress-emission-"));
  const path = writeContract(directory, fixture({
    id: "progress-emission-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const notifier = join(directory, "notify-success.mjs");
  writeFileSync(notifier, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  let result;
  try {
    result = await withFakeCodex(directory, "pass", () => runContract(path));
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
  }
  assert.equal(result.ok, true);
  const receipts = notifications(result.runDir);
  assert.deepEqual(receipts.map((event) => event.type), ["node.terminal", "run.terminal"]);
  assert.deepEqual(receipts.map((event) => event.status), ["delivered", "delivered"]);
  // The template renders counters and identifiers only, never a model note.
  assert.equal(receipts[0].summary, "node build done · run progress-emission-run · attempt 1");
  assert.equal(receipts[0].nodeId, "build");
  assert.equal(receipts[0].nodeStatus, "done");
  assert.equal(receipts[0].errorCode, null);
  assert.equal(receipts[1].summary, "run progress-emission-run done · 1/1 nodes");
  assert.deepEqual([receipts[1].done, receipts[1].total], [1, 1]);
});

test("idle polls emit no notification, and resume never re-notifies an already-terminal node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-progress-idle-"));
  const path = writeContract(directory, fixture({
    id: "progress-idle-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const started = join(directory, ".runs", "provider-started");
  const release = join(directory, ".runs", "provider-release");
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "wait-for-release");
  try {
    const pending = runContract(path);
    await waitForValue(() => (existsSync(started) ? "started" : null));
    // Let several controller polls pass while the node stays running: idle
    // passes must not create any notify.jsonl entry.
    await delay(200);
    assert.equal(existsSync(join(directory, ".runs", "progress-idle-run", "notify.jsonl")), false, "a running node emits no notification");
    writeFileSync(release, "release");
    const runDir = (await pending).runDir;
    let receipts = notifications(runDir);
    assert.deepEqual(receipts.map((event) => event.type), ["node.terminal", "run.terminal"]);

    // Rewind the finished node to running and resume. The provider that would
    // fail any fresh worker proves the result is adopted, and the node's
    // terminal notification must not be sent a second time.
    orphan(runDir, "build");
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    assert.equal(resumed.ok, true);
    assert.equal(nodeState(resumed).status, "done");
    receipts = notifications(runDir);
    assert.equal(receipts.filter((event) => event.type === "node.terminal").length, 1, "resume must not duplicate the node's terminal notification");
    assert.equal(receipts.filter((event) => event.type === "run.terminal").length, 1, "resume must not duplicate the run's terminal notification");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
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
    nodes: [{ id: "build", type: "mechanic", taskPacket: packet(), runtime: "flash", gate: false }],
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
    runtimeDefaults: {},
    runtimes: {
      luna: { driver: "codex", model: "gpt-5.6-luna", requiredCapabilities: { sandbox: true } },
      sol: { driver: "codex", model: "gpt-5.6-sol" },
    },
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      requiredCapabilities: { sandbox: false },
      gate: false,
    }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  // With no declared rules the worker's synthesized chain reaches sol as well,
  // so both runtimes are capability-checked against the node's demand before
  // anything spends — and the codex sandbox conflicts with sandbox=false on both.
  assert.deepEqual(checks.map((check) => check.ok), [false, false]);
  assert.match(checks[0].detail ?? "", /requirement 2: sandbox=false/u);
});

test("live preflight proves generation, redacts failures, and static mode stays mutation-free", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-preflight-"));
  const executable = fakeExecJsonl(directory, "secret");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const previous = process.env.INTENT_FACTORY_TEST_LIVE_SECRET;
  process.env.INTENT_FACTORY_TEST_LIVE_SECRET = "preflight-secret-value";
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
      runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: staticExecutable } },
      nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    }), null, 2)}\n`);
    const staticChecks = await preflightContract(staticPath, { static: true });
    assert.equal(staticChecks[0].ok, true);
    assert.equal(staticChecks[0].live, undefined);
    assert.equal(existsSync(join(directory, ".runs")), false);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_TEST_LIVE_SECRET;
    else process.env.INTENT_FACTORY_TEST_LIVE_SECRET = previous;
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
    notify: process.env.INTENT_FACTORY_NOTIFY_BIN ?? null,
    ambient: process.env.INTENT_FACTORY_AMBIENT ?? null,
  }));
  const result = JSON.stringify({ status: "done", summary: "ok", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "fake-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 }, costUsd: 0.01 }));
}
`);
  chmodSync(provider, 0o755);
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: provider } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  const previousAmbient = process.env.INTENT_FACTORY_AMBIENT;
  process.env.INTENT_FACTORY_NOTIFY_BIN = provider;
  process.env.INTENT_FACTORY_AMBIENT = "ambient-value";
  try {
    const checks = await preflightContract(path);
    assert.equal(checks[0].ok, true, checks[0].detail ?? undefined);
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.notify, null, "INTENT_FACTORY_NOTIFY_BIN must not reach the live preflight provider");
    assert.equal(observed.ambient, "ambient-value", "ambient runtime variables must survive");
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
    if (previousAmbient === undefined) delete process.env.INTENT_FACTORY_AMBIENT;
    else process.env.INTENT_FACTORY_AMBIENT = previousAmbient;
  }
});

test("preflight deduplicates initial runtimes and follows failover targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-reachable-"));
  const executable = fakeExecJsonl(directory, "pass");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "exec-jsonl", model: "primary", vendor: "primary-vendor", executable, fallback: "backup" },
      backup: { driver: "exec-jsonl", model: "backup", vendor: "backup-vendor", executable },
    },
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }), null, 2)}\n`);
  const checks = await preflightContract(path, { static: true });
  assert.deepEqual(checks.map((check) => check.id), ["primary", "backup"]);
});

test("provider exhaustion follows the declared one-hop fallback without consuming revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-one-hop-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-one-hop-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.nextRuntime), ["second"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.hop), [1]);
});

test("a second exhaustion after the one declared hop blocks at the hop cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-hop-cap-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "exhausted");
  const third = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-hop-cap-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second, fallback: "third" },
      third: { driver: "codex", model: "third", executable: third },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "provider_failover_hop_cap");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
});

test("provider exhaustion without a rule is terminal and cycles do not reuse a runtime", async () => {
  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-failover-no-rule-"));
  const exhausted = fakeCodex(terminalDirectory, "exhausted");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "failover-no-rule-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: { first: { driver: "codex", model: "first", executable: exhausted } },
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
      first: { driver: "codex", model: "first", executable: cycleFirst, fallback: "second" },
      second: { driver: "codex", model: "second", executable: cycleSecond, fallback: "first" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const cycle = nodeState(await runContract(cyclePath));
  assert.equal(cycle.status, "exhausted");
  assert.equal(cycle.error?.code, "provider_failover_cycle");
  assert.deepEqual((cycle.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
});

test("a declared fallback reschedules immediately with no backoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-backoff-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-backoff-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.routing?.history?.[0]?.backoffSec, 0);
  assert.ok(Date.parse(state.routing?.history?.[0]?.backoffUntil ?? "") <= Date.now());
});

test("recovered provider exhaustion does not charge persisted usage or cost twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-no-double-charge-"));
  const executable = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-no-double-charge-run",
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { driver: "codex", model: "worker", executable } },
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
  const judgeSecond = advisoryGateCodex(directory);
  const path = writeContract(directory, fixture({
    id: "failover-judge-run",
    runtimeDefaults: { worker: "worker", judge: "judge-first" },
    runtimes: {
      worker: { driver: "codex", model: "worker", executable: worker },
      "judge-first": { driver: "codex", model: "judge-first", executable: judgeFirst, vendor: "openai-judge", fallback: "judge-second" },
      "judge-second": { driver: "codex", model: "judge-second", executable: judgeSecond, vendor: "openai-judge" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(/** @type {{status?: string}|null} */ (state.result)?.status, "done");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["worker", "judge-first", "judge-second"]);
  assert.equal(state.routing?.history?.[0]?.role, "judge");
});

test("persists and recovers cost exactly once and reports totals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-recovery-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const executable = fakeExecJsonl(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "cost-recovery-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: {} }],
  }));
  const runDir = (await runContract(path)).runDir;
  const first = nodeState(await resumeRun(runDir));
  assert.equal(first.costUsd, 0.02);
  assert.deepEqual((first.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
  const usageRecords = readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(usageRecords.map((record) => record.costUsd), [0.01, 0.01]);
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
  crashed.worktree = ensureAttemptWorktree(runDir, crashed);
  crashed.invocations = [{ ...worker, status: "closed", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null }, costUsd: null }];
  writeFileSync(nodePath, JSON.stringify(crashed, null, 2));
  const recovered = nodeState(await resumeRun(runDir));
  assert.equal(recovered.costUsd, 0.02);
  assert.deepEqual((recovered.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
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
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const rendered = renderFindings(result.runDir);
  assert.match(rendered, /## build/u);
  assert.match(rendered, /\[critical\] broken/u);
  assert.match(rendered, /Evidence: test failed/u);
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
      definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "critical");
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
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
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

test("a scope finding still persists the usage its invocation spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-usage-"));
  const path = writeContract(directory, fixture({
    id: "scope-usage-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["unexpected.txt"]);
  assert.equal(state.usage?.inputTokens, 10, "transcript usage survives the scope finding");
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
  const result = await withFakeCodex(directory, "token-flood-timeout", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "wall_clock_timeout");
  assert.ok((state.usage?.inputTokens ?? 0) > 0, "killed worker reports its observed input tokens");
});

/** @param {string} prefix @param {Record<string, unknown>} overrides @returns {import("./contract.mjs").ValidatedContract} */
function failoverContract(prefix, overrides) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = writeContract(directory, fixture({
    id: `${prefix}contract`,
    runtimeDefaults: { worker: "mid", judge: "mid" },
    nodes: [{ id: "build", type: "backend", runtime: "mid", taskPacket: packet(), gate: false }],
    ...overrides,
  }));
  return validateContract(JSON.parse(readFileSync(path, "utf8")), path);
}

test("failoverEdges lists one declared edge per runtime, ordered by costRank", () => {
  const contract = failoverContract("runner-declared-failover-", {
    runtimes: {
      mid: { driver: "codex", model: "mid", costRank: 2, fallback: "dear" },
      dear: { driver: "codex", model: "dear", costRank: 9 },
      cheap: { driver: "codex", model: "cheap", costRank: 1, fallback: "dear" },
    },
  });
  assert.deepEqual(
    failoverEdges(contract),
    [
      { from: "cheap", to: "dear", source: "declared" },
      { from: "mid", to: "dear", source: "declared" },
    ],
    "edges are ordered by the declaring runtime's own costRank, cheapest first",
  );
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid"), "dear");
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid", ["dear"]), null, "a spent hop routes nowhere");
  // A declared `fallback` is a property of the runtime, not the role: a judge
  // reaches the same one-hop edge a worker would. Judge admissibility (the
  // vendor-conflict refusal) is resolved at routing time in runner.mjs, not
  // in this role-agnostic edge lookup — phase 1 removed the worker-only cut.
  assert.equal(nextSynthesizedRuntime(contract, "judge", "mid"), "dear");
});

test("an unranked runtime's declared edge sorts after every ranked runtime", () => {
  // costRank only has to be a finite non-negative number, so a contract may
  // declare one at or past any sentinel a ranked-last encoding could pick.
  const contract = failoverContract("runner-unranked-failover-", {
    runtimes: {
      mid: { driver: "codex", model: "mid", costRank: 2, fallback: "target" },
      unranked: { driver: "codex", model: "unranked", fallback: "target" },
      astronomical: { driver: "codex", model: "astronomical", costRank: Number.MAX_SAFE_INTEGER, fallback: "target" },
      target: { driver: "codex", model: "target" },
    },
  });
  assert.deepEqual(
    failoverEdges(contract).map((edge) => edge.from),
    ["mid", "astronomical", "unranked"],
    "every ranked runtime, however costly, still sorts ahead of an unranked one",
  );
});

// A fixed clock keeps these cases deterministic: the schedule is judged against
// now at both ends, so wall-clock drift must not decide the assertions.
const RESET_NOW = Date.parse("2026-09-04T06:00:00.000Z");

test("a quota reset before the node deadline schedules the retry at the reset time", () => {
  const resetAt = "2026-09-04T12:00:00.000Z";
  const deadline = "2026-09-04T18:00:00.000Z";
  assert.deepEqual(quotaResetSchedule({ error: { code: "quota_exhausted", resetAt } }, deadline, RESET_NOW), { kind: "reset", at: resetAt });
  assert.deepEqual(quotaResetSchedule({ resetAt: Date.parse(resetAt) }, deadline, RESET_NOW), { kind: "reset", at: resetAt });
  assert.deepEqual(quotaResetSchedule({ resetAt }, null, RESET_NOW), { kind: "reset", at: resetAt }, "a node with no deadline can always wait");
});

test("a quota reset at or after the node deadline takes the failover edge", () => {
  const deadline = "2026-09-04T12:00:00.000Z";
  assert.deepEqual(quotaResetSchedule({ error: { resetAt: "2026-09-04T18:00:00.000Z" } }, deadline, RESET_NOW), { kind: "failover" });
  assert.deepEqual(quotaResetSchedule({ resetAt: deadline }, deadline, RESET_NOW), { kind: "failover" }, "a reset exactly at the deadline is too late");
  assert.deepEqual(quotaResetSchedule({ error: { code: "quota_exhausted" } }, deadline, RESET_NOW), { kind: "failover" }, "no announced reset always fails over");
  assert.deepEqual(quotaResetSchedule({ resetAt: "not a time" }, deadline, RESET_NOW), { kind: "failover" });
  assert.deepEqual(quotaResetSchedule(null, deadline, RESET_NOW), { kind: "failover" });
});

test("a quota reset at or before now takes the failover edge instead of hot-looping", () => {
  const deadline = "2026-09-04T18:00:00.000Z";
  // A stale reset would otherwise park the phase on a zero-length backoff and
  // re-invoke the exhausted runtime at once, forever if the provider repeats it.
  assert.deepEqual(quotaResetSchedule({ resetAt: "2026-09-04T05:00:00.000Z" }, deadline, RESET_NOW), { kind: "failover" }, "a reset already in the past buys no wait");
  assert.deepEqual(quotaResetSchedule({ error: { resetAt: new Date(RESET_NOW) } }, deadline, RESET_NOW), { kind: "failover" }, "a reset exactly at now buys no wait");
  assert.deepEqual(quotaResetSchedule({ resetAt: RESET_NOW + 1 }, deadline, RESET_NOW), { kind: "reset", at: new Date(RESET_NOW + 1).toISOString() }, "one millisecond of wait still beats a hop");
});

test("a quota reset retry spends no failover hop", () => {
  const reset = /** @type {const} */ ({ kind: "reset" });
  const failover = /** @type {const} */ ({ kind: "failover" });
  const parked = { routing: { currentOverride: { role: "worker", revision: 0, hop: 1 }, history: [{ role: "worker", revision: 0, hop: 1 }] } };
  assert.equal(nextHop({ routing: null }, "worker", 0, failover), 1, "the first real edge is hop 1");
  assert.equal(nextHop({ routing: null }, "worker", 0, reset), 0, "a reset retry off a fresh node stays at hop 0");
  assert.equal(nextHop(parked, "worker", 0, reset), 1, "waiting again never advances the budget");
  assert.equal(nextHop(parked, "worker", 0, failover), 2, "only an actual edge advances it");
  // The regression the hop cap made possible: with two runtimes the cap is 2,
  // so charging a reset retry would push the following real edge to 2 and get
  // it rejected before the second runtime was ever tried.
  assert.equal(nextHop({ routing: { currentOverride: { role: "worker", revision: 0, hop: nextHop({ routing: null }, "worker", 0, reset) } } }, "worker", 0, failover), 1);
  assert.equal(nextHop({ routing: { history: [{ role: "worker", revision: 0, hop: 3 }, { role: "judge", revision: 0, hop: 9 }] } }, "worker", 0, failover), 4, "another role's hops are not this role's budget");
  assert.equal(nextHop({ routing: { history: [{ role: "worker", revision: 0, hop: 3 }] } }, "worker", 1, failover), 1, "a new revision starts its budget over");
});

const NETWORK_NOW = Date.parse("2026-09-04T06:00:00.000Z");
const NETWORK_DEADLINE = "2026-09-04T12:00:00.000Z";
/** Fixed jitter draw: the classification under test, not the random number generator. */
const halfJitter = () => 0.5;

test("network backoff classifies a dropped connection but hands node-owned deadlines straight to failover", () => {
  const options = { now: NETWORK_NOW, random: halfJitter, deadline: NETWORK_DEADLINE };
  assert.deepEqual(
    classifyTransition({ status: "failed", error: { code: "provider_error", message: "socket hang up" } }, options),
    { kind: "reset", at: new Date(NETWORK_NOW + 750).toISOString(), reason: "network_backoff" },
    "a CLI that reports only prose is still classified off its message",
  );
  assert.equal(classifyTransition({ error: { code: "ECONNRESET", message: "" } }, options).reason, "network_backoff", "an error class needs no message");
  assert.equal(classifyTransition({ error: { code: "provider_error", message: "boom" } }, { ...options, exitCode: 28 }).reason, "network_backoff", "a timeout exit code is enough on its own");
  assert.deepEqual(
    classifyTransition({ error: { code: "provider_error", message: "deliberate failure" } }, { ...options, exitCode: 1 }),
    { kind: "failover", reason: "provider" },
    "a provider CLI exits 1 for everything, so exit 1 is evidence of nothing",
  );
  for (const error of [
    { code: "wall_clock_timeout", message: "worker ran longer than 30s" },
    { code: "progress_stalled", message: "allowed workspace scope made no progress" },
    { code: "stall_timeout", message: "no provider output for 30s" },
  ]) {
    assert.equal(isTimeoutOrStall(error), true, `${error.code} is the node's own deadline`);
    assert.equal(classifyTransition({ error }, options).reason, "provider", `${error.code} never buys a network wait`);
  }
  assert.equal(isTimeoutOrStall({ code: "ECONNRESET", message: "socket hang up" }), false);
  assert.equal(
    classifyTransition({ error: { code: "unexpected_write", message: "verification log mentions connection reset by peer" } }, options).reason,
    "provider",
    "a failure the run imposed on itself keeps its own settlement, whatever its message quotes",
  );
  assert.equal(
    classifyTransition({ resetAt: "2026-09-04T07:00:00.000Z", error: { code: "ECONNRESET", message: "" } }, options).reason,
    "quota_reset",
    "an announced reset instant outranks a guessed wait",
  );
});

test("network backoff windows grow exponentially, stay jittered, and cap at two minutes", () => {
  assert.equal(backoffDelayMs(0, () => 0), 500);
  assert.equal(backoffDelayMs(0, () => 1), 1_000);
  assert.equal(backoffDelayMs(1, () => 0), 1_000);
  assert.equal(backoffDelayMs(2, () => 1), 4_000);
  assert.equal(backoffDelayMs(20, () => 1), NETWORK_BACKOFF_CAP_MS, "the cap holds however far the exponent runs");
  assert.equal(backoffDelayMs(20, () => 0), NETWORK_BACKOFF_CAP_MS / 2);
  // No wait may round to zero: a zero-length backoff parks the phase and
  // re-invokes the same failing runtime in the same tick, forever.
  for (let attempt = 0; attempt < 8; attempt += 1) assert.ok(backoffDelayMs(attempt, () => 0) > 0, `attempt ${attempt} waited nothing`);
});

test("network backoff spends three attempts on the warm runtime before it takes the failover edge", () => {
  const envelope = { status: "failed", error: { code: "provider_error", message: "connection reset by peer" } };
  const options = { now: NETWORK_NOW, random: halfJitter, deadline: NETWORK_DEADLINE };
  /** @param {number} count @param {string} [errorCode] */
  const parked = (count, errorCode = "network_backoff:provider_error") => ({
    routing: {
      history: Array.from({ length: count }, () => ({ role: "worker", revision: 0, runtime: "first", nextRuntime: "first", errorCode })),
      currentOverride: null,
    },
  });
  for (let spent = 0; spent < NETWORK_MAX_ATTEMPTS; spent += 1) {
    const attempt = networkBackoffAttempts(parked(spent), "worker", 0);
    assert.equal(attempt, spent, "the attempt budget is read back off the durable node");
    assert.equal(classifyTransition(envelope, { ...options, attempt }).kind, "reset");
  }
  assert.deepEqual(classifyTransition(envelope, { ...options, attempt: NETWORK_MAX_ATTEMPTS }), { kind: "failover", reason: "network_backoff" });
  assert.equal(networkBackoffAttempts(parked(3), "judge", 0), 0, "another role's waits are not this role's budget");
  assert.equal(networkBackoffAttempts(parked(3), "worker", 1), 0, "a new revision starts its budget over");
  assert.equal(networkBackoffAttempts(parked(3, "quota_exhausted"), "worker", 0), 0, "a quota wait is not a network wait");
  assert.deepEqual(
    classifyTransition(envelope, { ...options, deadline: new Date(NETWORK_NOW + 100).toISOString() }),
    { kind: "failover", reason: "network_backoff" },
    "a wait the node cannot outlive is not a recovery",
  );
  assert.equal(nextHop({ routing: null }, "worker", 0, classifyTransition(envelope, options)), 0, "staying on the warm runtime costs no hop");
});

test("an unspent repair keeps the worker result on its provider and a spent one takes the failover edge", () => {
  assert.equal(isRepairable({ gate: { enabled: true, maxRevisions: 1 } }, { revisions: 0 }), true);
  assert.equal(isRepairable({ gate: { enabled: true, maxRevisions: 1 } }, { revisions: 1 }), false);
  assert.equal(isRepairable({ gate: { enabled: true, maxRevisions: 0 } }, { revisions: 0 }), false);
  assert.equal(isRepairable({ gate: { enabled: true } }, { revisions: 0 }), true, "one repair by default");
  assert.equal(isRepairable({ gate: { enabled: false, maxRevisions: 3 } }, { revisions: 0 }), false, "a gateless node has no repair to spend");
});

test("a transient network failure retries on the warm runtime before it spends a failover hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-network-backoff-"));
  // The counter lives outside the workspace: a provider that writes into the
  // contract cwd trips the unexpected-write gate before the network path runs.
  const outside = mkdtempSync(join(tmpdir(), "runner-network-calls-"));
  const calls = join(outside, "network-calls.txt");
  const flaky = join(outside, "flaky-provider.mjs");
  writeFileSync(flaky, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("flaky 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(calls)}, "call\\n");
  const seen = readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length;
  console.log(JSON.stringify({ type: "thread.started", thread_id: "flaky" }));
  if (seen === 1) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "socket hang up: connection reset by peer" } }));
    process.exit(1);
  }
  const text = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
});
`);
  chmodSync(flaky, 0o755);
  const path = writeContract(directory, fixture({
    id: "network-backoff-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "codex", model: "primary", executable: flaky, costRank: 1 },
      spare: { driver: "codex", model: "spare", executable: fakeCodex(directory, "pass"), costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["primary", "primary"], "the warm runtime gets the retry, not the spare");
  const history = state.routing?.history ?? [];
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "failed");
  assert.equal(history[0].errorCode, "network_backoff:provider_error", "the wait is countable and the provider's own code stays visible");
  assert.equal(history[0].nextRuntime, "primary");
  assert.equal(history[0].hop, 0, "a network wait spends no failover hop");
  const waited = history[0].backoffSec ?? 0;
  assert.ok(waited > 0 && waited <= 1, `unexpected backoff ${waited}`);
});

test("a judge that lost its socket takes the network backoff, not its one judge_unavailable re-dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-network-backoff-"));
  // Outside the workspace: a provider that writes into the contract cwd trips
  // the unexpected-write gate before the network path ever runs.
  const outside = mkdtempSync(join(tmpdir(), "runner-judge-network-calls-"));
  const calls = join(outside, "judge-calls.txt");
  const flaky = join(outside, "flaky-judge.mjs");
  writeFileSync(flaky, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("flaky 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  console.log(JSON.stringify({ type: "thread.started", thread_id: "flaky" }));
  if (!prompt.startsWith("Review node")) {
    const text = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  appendFileSync(${JSON.stringify(calls)}, "judge\\n");
  const seen = readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length;
  if (seen === 1) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "socket hang up: connection reset by peer" } }));
    process.exit(1);
  }
  const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
});
`);
  chmodSync(flaky, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-network-backoff-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: { worker: "primary-worker", judge: "primary" },
    runtimes: {
      "primary-worker": { driver: "codex", model: "primary", vendor: "primary-worker-vendor", executable: flaky },
      primary: { driver: "codex", model: "primary", vendor: "primary-judge-vendor", executable: flaky },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.judgeFailures ?? 0, 0, "a network wait spends none of the judge_unavailable budget");
  const history = (state.routing?.history ?? []).filter((entry) => entry.role === "judge");
  assert.equal(history.length, 1);
  assert.equal(history[0].errorCode, "network_backoff:provider_error");
  assert.equal(history[0].nextRuntime, "primary", "the judge stays on the runtime the gate named");
  assert.equal(history[0].hop, 0, "a network wait spends no failover hop");
  assert.ok(!notifications(result.runDir).some((event) => event.type === "attention"), "a recovered socket raises no attention");
});

test("quota exhaustion with no declared fallback leaves the node exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-no-fallback-quota-"));
  const exhausted = fakeCodex(directory, "quota-429");
  const path = writeContract(directory, fixture({
    id: "no-fallback-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "mid", judge: "mid" },
    runtimes: {
      mid: { driver: "codex", model: "mid", executable: exhausted, costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", runtime: "mid", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "exhausted", "a runtime with no declared fallback has nowhere to hop");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["mid"]);
});

test("quota exhaustion routes through the declared failover edge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-quota-failover-"));
  const primary = fakeCodex(directory, "quota-429");
  const backup = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "quota-failover-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "codex", model: "primary", executable: primary, fallback: "backup" },
      backup: { driver: "codex", model: "backup", executable: backup },
    },
    nodes: [{ id: "build", type: "backend", runtime: "primary", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["primary", "backup"]);
  assert.equal(state.routing?.history?.length ?? 0, 1);
  assert.equal(state.routing?.history?.[0]?.nextRuntime, "backup");
  assert.equal(state.routing?.history?.[0]?.errorCode, "quota_exhausted");
  const first = state.invocations?.[0];
  assert.ok(first, "first invocation exists");
  const settlement = JSON.parse(readFileSync(join(result.runDir, "operations", `${first.id}.settlement.json`), "utf8"));
  assert.equal(settlement.error?.code, "quota_exhausted");
});

test("liveness state reports paused_quota only while a provider backoff is pending and failed once exhaustion is terminal", async () => {
  // A quota reset announced inside the node's deadline holds its node pending
  // on a future backoffUntil, so liveness must report paused_quota for that
  // shape and only that shape. Terminal exhaustion with no failover route
  // derives failed even when the error is quota-flavored: the run is not
  // waiting for a provider to come back, it is over.
  //
  // Carve-out: the codex driver's turn.failed quota branch never threads the
  // provider's resetAt into the envelope's error (drivers are out of scope
  // for this phase), so a fake codex cannot make classifyTransition see a
  // reset window and exercise this end to end through runContract. This
  // exercises livenessState directly against the exact shape the runner
  // persists for a pending phase parked on a future routing backoff.
  const pendingWithActiveBackoff = /** @type {Map<string, import("./contract.mjs").NodeSnapshot>} */ (new Map([["build", {
    status: "pending",
    phase: "worker",
    routing: { currentOverride: { role: "worker", backoffUntil: new Date(Date.now() + 60_000).toISOString() } },
  }]]));
  assert.equal(livenessState(pendingWithActiveBackoff), "paused_quota");

  const pendingWithElapsedBackoff = /** @type {Map<string, import("./contract.mjs").NodeSnapshot>} */ (new Map([["build", {
    status: "pending",
    phase: "worker",
    routing: { currentOverride: { role: "worker", backoffUntil: new Date(Date.now() - 1_000).toISOString() } },
  }]]));
  assert.notEqual(livenessState(pendingWithElapsedBackoff), "paused_quota");

  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-liveness-terminal-"));
  const quotaPrimary = fakeCodex(terminalDirectory, "quota-429");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "liveness-quota-terminal-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: { primary: { driver: "codex", model: "primary", executable: quotaPrimary } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const terminalResult = await runContract(terminalPath);
  const terminalState = nodeState(terminalResult);
  assert.equal(terminalState.status, "exhausted", terminalState.error?.message);
  assert.equal(terminalState.error?.code, "quota_exhausted");
  assert.equal(
    livenessState(terminalResult.states),
    "failed",
    "terminal quota exhaustion without a failover route reports failed, never a live quota pause",
  );
});

test("reuses one worker continuation per ordered phase", async () => {
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
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
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
  const usageRecords = readFileSync(join(result.runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(usageRecords.length, 2);
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
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "exec-jsonl", model: "same-model", vendor: "primary-vendor", executable },
      backup: { driver: "exec-jsonl", model: "same-model", vendor: "backup-vendor", executable },
    },
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
  // carries the prior node's structured summary forward instead of reusing
  // its session.
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
  assert.match(requests[1].prompt, /Prior structured node summaries/u);
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
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
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
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
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
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
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
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
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

test("resume re-dispatches a capped live continuation as a fresh attempt in a fresh worktree", async () => {
  // Attempt isolation (TECH-SPEC lean v0.3, F23) ties continuation identity to
  // the attempt's own worktree: a timed-out invocation's continuation never
  // survives into the next attempt's fresh worktree, so resume re-dispatches
  // it as attempt plus one instead of resuming the capped provider session.
  const directory = mkdtempSync(join(tmpdir(), "runner-live-continuation-"));
  const path = writeContract(directory, fixture({
    id: "live-continuation-run",
    timeoutSec: 1,
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
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  try {
    const result = await withFakeCodex(directory, "pass", () => runContract(path));
    const events = readFileSync(delivered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "node.terminal" && event.nodeId === "build"));
    assert.ok(events.some((event) => event.type === "run.terminal" && event.runId === "run-notifications"));
    const receipts = notifications(result.runDir);
    assert.ok(receipts.every((receipt) => receipt.status === "delivered"), "every event this transport received is recorded delivered");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
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

test("run warnings ignore a historical snapshot from an older capability schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-old-snapshot-"));
  const firstPath = writeContract(directory, fixture({ id: "old-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));
  const oldNodePath = join(directory, ".runs", "old-run", "nodes", "build.json");
  const oldNode = JSON.parse(readFileSync(oldNodePath, "utf8"));
  delete oldNode.runtime.capabilities.toolPolicy;
  writeFileSync(oldNodePath, `${JSON.stringify(oldNode)}\n`);

  const secondPath = writeContract(directory, fixture({ id: "current-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", secondPath],
    { encoding: "utf8" },
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /old-run/u);
});


test("detached resume surfaces bootstrap failure before reporting success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-failure-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-failure-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  metadata.sourceIdentity.cwd = "/unexpected-source";
  writeFileSync(join(runDir, "run.json"), JSON.stringify(metadata));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
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
    { env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: errorNonce, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.notEqual(errorResult.status, 0);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${errorNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, errorNonce)), false);

  const timeoutNonce = "22222222-2222-4222-8222-222222222222";
  const timeoutResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: timeoutNonce, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
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
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "worker-fail");
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
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
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

test("worker invocations send no tool policy to a driver that cannot enforce it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-tool-policy-"));
  const marker = join(directory, ".runs", "tool-policy-request.json");
  const provider = join(directory, "policy-provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("policy-provider 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(marker)}, input);
    const result = JSON.stringify({ status: "done", summary: "ok", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: null, usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
  });
}
`);
  chmodSync(provider, 0o755);
  const path = writeContract(directory, fixture({
    id: "tool-policy-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: provider } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  assert.equal(nodeState(result).status, "done");
  const request = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(
    "toolPolicy" in request,
    false,
    "an adapter without an enforceable hook surface receives no policy to pretend with; enforcement lives on the claude-compatible --settings boundary",
  );
});

test("finalVerification runs on the phase-terminal node and not on its dependencies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-terminal-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-terminal-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["build"], gate: false },
    ],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const build = nodeState(result, "build");
  const ship = nodeState(result, "ship");
  assert.equal(build.status, "done");
  assert.equal(ship.status, "done");
  assert.equal(build.verification?.commands?.length, 1, "a node with a dependant runs only its packet verification");
  assert.equal(ship.verification?.commands?.length, 2, "the phase-terminal node also runs the contract finalVerification");
  assert.deepEqual(ship.verification?.commands?.[1].argv, [process.execPath, "-e", "process.exit(0)"]);
});

test("a failing finalVerification stops the phase-terminal node before the judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-fail-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-fail-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(3)"] }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "final verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.equal(state.verification?.passed, false);
  assert.equal(state.verification?.commands?.[0].passed, true, "the packet verification still passed");
  assert.equal(state.verification?.commands?.[1].passed, false);
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("a contract without finalVerification leaves controller verification untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-absent-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-absent-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(result).status, "done");
  assert.equal(nodeState(result).verification?.commands?.length, 1);
});

const RUNNER_CLI = fileURLToPath(new URL("./runner.mjs", import.meta.url));

test("a single-node contract validates without warning and contract prune is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-single-node-"));
  const serial = writeContract(directory, fixture({ id: "single-node-run" }));

  for (const argv of [["validate", serial], ["contract", "validate", serial]]) {
    const result = spawnSync(process.execPath, [RUNNER_CLI, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "valid\n", "a single-node contract is simply valid");
  }

  const contractPath = join(directory, "targeted.json");
  writeJsonAtomic(contractPath, fixture({ id: "targeted-field-run", nodes: [{ id: "build", type: "backend", targetedFix: true, taskPacket: packet(), gate: false }] }));
  const rejected = spawnSync(process.execPath, [RUNNER_CLI, "validate", contractPath], { encoding: "utf8" });
  assert.equal(rejected.status, 1, rejected.stdout);
  assert.match(rejected.stderr, /nodes\[0\] has unexpected field targetedFix/u, "the targeted-fix node field is gone");

  const pruned = spawnSync(process.execPath, [RUNNER_CLI, "contract", "prune", join(directory, ".runs", "single-node-run"), "--out", join(directory, "out.json")], { encoding: "utf8" });
  assert.equal(pruned.status, 2, pruned.stdout);
  assert.match(pruned.stderr, /usage: runner.mjs contract validate/u, "contract prune is not a command any more");
  assert.equal(existsSync(join(directory, "out.json")), false, "no continuation contract is written");
});

/**
 * Rewrite a persisted node snapshot the way the failure being resumed would
 * have left it.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {{status: string, code: string, message?: string, blockedBy?: string[], attempt?: number}} failure
 * @returns {void}
 */
function persistFailure(runDir, nodeId, failure) {
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({
    ...state,
    status: failure.status,
    phase: failure.status === "blocked" ? "dependency" : "worker",
    result: null,
    gate: null,
    verification: null,
    scopeFindings: null,
    attempt: failure.attempt ?? state.attempt,
    blockedBy: failure.blockedBy ?? [],
    error: { code: failure.code, message: failure.message ?? failure.code.replace(/_/g, " ") },
  }, null, 2));
}

/**
 * A codex-shaped provider whose worker prompts are logged before it completes,
 * so a test can read the prompt a retry in place regenerated.
 *
 * @param {string} directory
 * @returns {{executable: string, log: string}}
 */
function promptLoggingCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-prompt-log-")), "prompt-log.mjs");
  const log = join(directory, ".runs", "worker-prompts.txt");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.startsWith("Review node")) {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] }) } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
      return;
    }
    appendFileSync(${JSON.stringify(log)}, input);
    const result = JSON.stringify({ status: "done", summary: "retried worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    const resultPath = /canonical result file: (\\S+\\.json)/.exec(input)?.[1];
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, log };
}

/** @template T @param {string} executable @param {() => T | Promise<T>} body @returns {Promise<T>} */
async function withCodexBinary(executable, body) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = executable;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/** @param {string} runDir @returns {{identityWarnings?: string[], sourceIdentity: {gitHead: string|null}}} */
function runMetadata(runDir) {
  return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
}

/** @param {string} runDir @returns {string[]} */
function recoveryDecisions(runDir) {
  try {
    return readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => /** @type {{recovery?: string}} */ (JSON.parse(line)).recovery ?? "");
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * A codex whose first judge turn returns two verdicts (blocking review blocks
 * as judge_unavailable) and whose later judge turns return exactly one clean
 * verdict, so the same provider can drive the resume that re-judges it.
 *
 * @param {string} directory
 * @returns {string}
 */
function retryJudgeCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "retry-judge-")), "retry-judge.mjs");
  const judges = join(directory, ".runs", "retry-judge-calls");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const judges = ${JSON.stringify(judges)};
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean re-judge", findings: [] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "retry-judge-thread" }));
    if (!prompt.startsWith("Review node")) {
      const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
      const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
      if (resultPath) writeFileSync(resultPath, result);
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
      return;
    }
    appendFileSync(judges, "x\\n");
    const run = readFileSync(judges, "utf8").trim().split("\\n").filter(Boolean).length;
    if (run <= 2) {
      // The first round and its bounded re-ask both return two verdicts: that
      // is the judge_unavailable boundary the resume has to clear.
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
    } else {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
    }
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

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
