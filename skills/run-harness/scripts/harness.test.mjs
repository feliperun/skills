import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  JUDGE_SCHEMA,
  normalizeProviderResult,
  providerCommand,
  renderReport,
  renderStatus,
  routeRuntime,
  validateContract,
} from "./lib.mjs";
import { preflightContract, runContract, resumeRun } from "./harness.mjs";

function orphan(runDir, nodeId, patch = {}) {
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    result: null,
    gate: null,
    ...patch,
  }, null, 2));
}

async function withFakeCodex(directory, mode, body) {
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, mode);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
}

function fixture(overrides = {}) {
  return {
    id: "test-run",
    goal: "Prove the runner works",
    cwd: ".",
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      luna: { driver: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" },
      sol: { driver: "codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
      opus: { driver: "claude", model: "opus", reasoning: "high" },
      flash: {
        driver: "codex",
        model: "deepseek-v4-flash",
        config: { model_provider: "deepseek", "model_providers.deepseek.env_key": "DEEPSEEK_API_KEY" },
      },
    },
    runtimeRules: [
      { match: { type: "frontend" }, runtime: "opus" },
      { match: { type: "mechanic" }, runtime: "flash" },
    ],
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: false }],
    ...overrides,
  };
}

function writeContract(directory, value) {
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function fakeCodex(directory, mode = "pass") {
  const path = join(directory, `fake-codex-${mode}.mjs`);
  writeFileSync(path, `#!/usr/bin/env node
const prompt = process.argv.at(-1);
const mode = ${JSON.stringify(mode)};
console.log(JSON.stringify({type:"thread.started",thread_id:"fake-thread"}));
if (mode === "slow") {
  // The worker eats most of the node budget; the judge must still get its own.
  const wait = prompt.startsWith("Review node") ? 1200 : 3000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}
if (mode === "silent") setTimeout(() => {}, 60_000);
else if (mode === "heartbeat") setInterval(() => console.error("working"), 10);
else if (prompt.includes("FAIL_WORKER") || (mode === "worker-fail" && !prompt.startsWith("Review node")) || (mode === "judge-fail" && prompt.startsWith("Review node"))) {
  console.log(JSON.stringify({type:"turn.failed",error:{message:"deliberate failure"}}));
} else {
  const judge = prompt.startsWith("Review node");
  const text = judge
    ? mode === "critical"
      ? JSON.stringify({verdict:"fail",maxSeverity:"critical",summary:"critical defect",findings:[{severity:"critical",description:"broken",evidence:"test failed"}]})
      : JSON.stringify({verdict:"fail",maxSeverity:"minor",summary:"minor advisory",findings:[{severity:"minor",description:"style",evidence:"line 1"}]})
    : "worker complete";
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
}
`);
  chmodSync(path, 0o755);
  return path;
}

test("routes explicit, matching, and default runtimes", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-route-"));
  const path = writeContract(directory, fixture());
  const contract = validateContract(JSON.parse(readFileSync(path)), path);
  assert.equal(routeRuntime(contract, { id: "a", type: "frontend", gate: {} }).id, "opus");
  assert.equal(routeRuntime(contract, { id: "b", type: "mechanic", gate: {} }).id, "flash");
  assert.equal(routeRuntime(contract, { id: "c", type: "backend", gate: {} }).id, "luna");
  assert.equal(routeRuntime(contract, { id: "d", type: "backend", runtime: "opus", gate: {} }).id, "opus");
});

test("builds custom provider config as command-line overrides", () => {
  const command = providerCommand({ ...fixture().runtimes.flash, sandbox: "danger-full-access" }, "task");
  assert.equal(command.executable, "codex");
  assert.deepEqual(command.args.slice(0, 4), ["exec", "--json", "--sandbox", "danger-full-access"]);
  assert.ok(command.args.includes("model_provider=\"deepseek\""));
  assert.ok(command.args.includes("model=\"deepseek-v4-flash\""));
  assert.ok(command.args.includes("model_providers.deepseek.env_key=\"DEEPSEEK_API_KEY\""));
  assert.ok(!command.args.includes("--profile"));
});

test("uses provider-compatible explicit types in the judge schema", () => {
  assert.equal(JUDGE_SCHEMA.properties.verdict.type, "string");
  assert.equal(JUDGE_SCHEMA.properties.maxSeverity.type, "string");
  assert.equal(JUDGE_SCHEMA.properties.findings.items.properties.severity.type, "string");
});

test("rejects an invalid Codex sandbox", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-sandbox-"));
  const value = fixture();
  value.runtimes.flash.sandbox = "unrestricted";
  const path = writeContract(directory, value);
  assert.throws(() => validateContract(JSON.parse(readFileSync(path)), path), /sandbox is invalid/u);
});

test("normalizes Codex and streaming Claude results", () => {
  const codex = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(normalizeProviderResult("codex", codex, 0, null).status, "done");

  const claude = [
    { type: "system", subtype: "init" },
    { type: "result", result: "ok", is_error: false, session_id: "session", usage: { input_tokens: 3 } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(normalizeProviderResult("claude", claude, 0, null).continuationId, "session");
});

test("selects the last valid JSON block for a Codex judge", () => {
  const verdict = JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "advisory", findings: [
    { severity: "minor", description: "cleanup", evidence: "line 1" },
  ] });
  const stream = [
    { type: "item.completed", item: { type: "agent_message", text: `Review complete.\n\n\`\`\`json\n${verdict}\n\`\`\`` } },
    { type: "item.completed", item: { type: "agent_message", text: "Temporary files are harmless." } },
    { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
  ].map(JSON.stringify).join("\n");
  assert.equal(normalizeProviderResult("codex", stream, 0, null).result, "Temporary files are harmless.");
  assert.equal(normalizeProviderResult("codex", stream, 0, null, { preferStructured: true }).result, verdict);
});

test("normalizes Codex cached token naming", () => {
  const stream = [
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 8, cached_input_tokens: 5, output_tokens: 2 } },
  ].map(JSON.stringify).join("\n");
  assert.equal(normalizeProviderResult("codex", stream, 0, null).usage.cacheReadInputTokens, 5);
});

test("rejects dependency cycles", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-cycle-"));
  const path = writeContract(directory, fixture({
    nodes: [
      { id: "a", type: "backend", prompt: "a", dependsOn: ["b"] },
      { id: "b", type: "backend", prompt: "b", dependsOn: ["a"] },
    ],
  }));
  assert.throws(() => validateContract(JSON.parse(readFileSync(path)), path), /dependency cycle/u);
});

test("runs the CLI through an installed symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-symlink-"));
  const contractPath = writeContract(directory, fixture());
  const link = join(directory, "harness-link.mjs");
  symlinkSync(fileURLToPath(new URL("./harness.mjs", import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, "validate", contractPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "valid\n");
});

test("run --detach leaves a controller that outlives the invoker and completes the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-detach-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath)), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./harness.mjs", import.meta.url)), "run", "--detach", contractPath], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/\[run\] ([a-z0-9-]+) detached · pid (\d+) · (.+)/u);
  assert.ok(match, result.stdout);
  assert.equal(match[1], contract.id);
  assert.equal(match[3], runDir);
  const pid = Number(match[2]);
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
  await waitForValue(() => {
    try {
      process.kill(pid, 0);
      return null;
    } catch {
      return "exited";
    }
  }, 10_000);
});

test("resume --detach restarts a failed node through a detached controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-detach-resume-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath)), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  await withFakeCodex(directory, "worker-fail", () => runContract(contractPath));
  assert.equal(readStatus(nodePath), "failed");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./harness.mjs", import.meta.url)), "resume", "--detach", runDir], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[resume\] detached · pid \d+ · .*/u);
  assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
});

function readStatus(nodePath) {
  try {
    return JSON.parse(readFileSync(nodePath, "utf8")).status;
  } catch {
    return null;
  }
}

async function waitForValue(readValue, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = readValue();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("runs a worker and treats minor judge findings as advisory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-run-"));
  const contract = fixture({
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      prompt: "Implement it",
      definitionOfDone: ["It works"],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  });
  const path = writeContract(directory, contract);
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory);
  try {
    const result = await runContract(path);
    assert.equal(result.ok, true);
    assert.equal(result.states.get("build").status, "done");
    assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /minor advisory/u);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("marks a silent provider stalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-stall-"));
  mkdirSync(join(directory, "work"));
  const path = writeContract(directory, fixture({
    id: "stall-run",
    cwd: "work",
    pollIntervalMs: 10,
    stallTimeoutSec: 0.05,
  }));
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "silent");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(result.states.get("build").status, "stalled");
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("preserves the worker report when the judge provider fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-judge-fail-"));
  const path = writeContract(directory, fixture({
    id: "judge-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: {} }],
  }));
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "judge-fail");
  try {
    const result = await runContract(path);
    const state = result.states.get("build");
    assert.equal(state.status, "failed");
    assert.equal(state.phase, "judge");
    assert.equal(state.result, "worker complete");
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("enforces the wall-clock cap even while output changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-timeout-"));
  const path = writeContract(directory, fixture({
    id: "timeout-run",
    pollIntervalMs: 10,
    stallTimeoutSec: 1,
    timeoutSec: 0.05,
  }));
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "heartbeat");
  try {
    const result = await runContract(path);
    assert.equal(result.states.get("build").status, "exhausted");
    assert.equal(result.states.get("build").error.code, "wall_clock_timeout");
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("spends the wall-clock budget per phase, not per node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-phase-budget-"));
  const path = writeContract(directory, fixture({
    id: "phase-budget-run",
    pollIntervalMs: 10,
    timeoutSec: 4,
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: { failOn: ["critical"] } }],
  }));
  // The worker takes 3s of a 4s budget. A node-wide clock leaves the judge 1s
  // for work that needs 1.2s and kills a healthy reviewer.
  const result = await withFakeCodex(directory, "slow", () => runContract(path));
  const state = result.states.get("build");
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.gate.summary, "minor advisory");
});

test("bounds gate retries and reports exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-retry-"));
  const path = writeContract(directory, fixture({
    id: "retry-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      prompt: "Implement it",
      gate: { failOn: ["critical"], maxRevisions: 1 },
    }],
  }));
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(result.states.get("build").status, "exhausted");
    assert.equal(result.states.get("build").attempt, 2);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("resume adopts an orphaned worker result instead of repeating the work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-resume-"));
  const path = writeContract(directory, fixture({ id: "resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  // A provider that fails every worker call proves the result came from the orphaned log.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.states.get("build").status, "done");
  assert.equal(resumed.states.get("build").result, "worker complete");
  assert.equal(resumed.states.get("build").attempt, 1);
});

test("resume re-judges an adopted worker result for a gated node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-resume-gate-"));
  const path = writeContract(directory, fixture({
    id: "resume-gate-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = resumed.states.get("build");
  assert.equal(state.status, "done");
  assert.equal(state.result, "worker complete");
  assert.equal(state.gate.summary, "minor advisory");
  assert.ok(existsSync(join(runDir, "logs", "build.1.judge.r2.jsonl")), "the second judge log must not overwrite the first");
});

test("resume restarts a node with no usable worker output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-resume-restart-"));
  const path = writeContract(directory, fixture({ id: "resume-restart-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(resumed.states.get("build").status, "done");
  assert.equal(resumed.states.get("build").attempt, 2);
});

test("resume does not re-enable a disabled gate from the stored contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-resume-no-gate-"));
  const path = writeContract(directory, fixture({ id: "resume-no-gate-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  assert.equal(JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")).nodes[0].gate.enabled, false);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(resumed.states.get("build").status, "done");
  const logs = readdirSync(join(runDir, "logs"));
  assert.ok(!logs.some((name) => name.includes("judge")), "a disabled gate must not run a judge after resume");
});

test("gate revisions are not consumed by attempts burned in restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-revisions-"));
  const path = writeContract(directory, fixture({
    id: "revisions-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      prompt: "Implement it",
      definitionOfDone: ["It works"],
      gate: { failOn: ["critical"], maxRevisions: 1 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).attempt, 2);

  const final = await withFakeCodex(directory, "critical", () => resumeRun(runDir));
  assert.equal(final.states.get("build").status, "exhausted");
  assert.equal(final.states.get("build").attempt, 4, "two burned starts plus the gate retry start");
  assert.equal(final.states.get("build").revisions, 1, "one real gate rejection consumed");
});

test("status separates a live running node from an orphaned one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-orphan-"));
  const path = writeContract(directory, fixture({ id: "orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  assert.match(renderStatus(runDir), /Nothing needs you right now/u);

  const reaped = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ pid: reaped.pid, startedAt: "earlier" }));
  assert.match(renderStatus(runDir), /build still claims to be running/u);
});

test("report aggregates per-node status, attempts, revisions, and tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-report-"));
  const path = writeContract(directory, fixture({
    id: "report-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const report = renderReport(runDir);
  assert.match(report, /1 nodes · 1 done/u);
  // The node ends on its judge runtime, and tokens sum worker plus judge.
  assert.match(report, /build\s+done\s+1\s+0\s+codex\/gpt-5\.6-sol/u);
  assert.match(report, /totals · in 20 · out 4 · cache -/u);
});

test("events record attempt, runtime, and gate verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-events-"));
  const path = writeContract(directory, fixture({
    id: "events-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      prompt: "Implement it",
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "critical");
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
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("preflight probes every routed worker and judge runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-preflight-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "backend", prompt: "Implement it", gate: { failOn: ["critical"] } }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id).sort(), ["luna", "sol"]);
  assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
});

test("preflight reports a missing credential by variable name only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-preflight-key-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "mechanic", prompt: "Implement it", gate: false }],
  }));
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
    assert.deepEqual(checks.map((check) => check.id), ["flash"]);
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail, /missing environment variable DEEPSEEK_API_KEY/u);
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("preflight fails a runtime the provider rejects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-preflight-fail-"));
  const path = writeContract(directory, fixture());
  const checks = await withFakeCodex(directory, "worker-fail", () => preflightContract(path));
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail, /deliberate failure/u);
});

test("blocks downstream nodes after a failed dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-dependency-"));
  const path = writeContract(directory, fixture({
    id: "dependency-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", prompt: "Fail", gate: false },
      { id: "second", type: "backend", prompt: "Never run", dependsOn: ["first"], gate: false },
    ],
  }));
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "worker-fail");
  try {
    const result = await runContract(path);
    assert.equal(result.states.get("first").status, "failed");
    assert.equal(result.states.get("second").status, "blocked");
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});
