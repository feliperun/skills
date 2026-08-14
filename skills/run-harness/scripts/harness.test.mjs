import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  JUDGE_SCHEMA,
  judgePrompt,
  normalizeProviderResult,
  providerCommand,
  renderFindings,
  renderReport,
  renderStatus,
  routeRuntime,
  validateContract,
} from "./lib.mjs";
import { preflightContract, runContract, resumeRun } from "./harness.mjs";
import {
  appendJournal,
  campaignDir,
  HANDOFF_BYTES,
  HANDOFF_LIMIT,
  initializeCampaign,
  readJournal,
  registerRun,
  renderHandoff,
  resolveCampaign,
  validateJournalEntry,
} from "./campaign.mjs";

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

async function withFakeAgy(directory, body) {
  const previous = process.env.HARNESS_AGY_BIN;
  process.env.HARNESS_AGY_BIN = fakeAgy(directory);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_AGY_BIN;
    else process.env.HARNESS_AGY_BIN = previous;
  }
}

function fixture(overrides = {}) {
  return {
    id: "test-run",
    campaignId: "test-campaign",
    goal: "Prove the runner works",
    cwd: ".",
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      luna: { driver: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" },
      sol: { driver: "codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
      opus: { driver: "claude", model: "opus", reasoning: "high" },
      agy: { driver: "agy", model: "gemini-3.7-flash-low" },
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    ...overrides,
  };
}

function packet(overrides = {}) {
  return {
    mode: "execution",
    objective: "Implement it",
    instructions: ["Implement the requested behavior"],
    readFiles: ["contract.json"],
    writeFiles: ["README.md"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: ["node --test skills/run-harness/scripts/harness.test.mjs"],
    ...overrides,
  };
}

function writeContract(directory, value) {
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  const cwd = join(directory, value.cwd ?? ".");
  const runsDir = join(cwd, ".runs");
  const pathForCampaign = campaignDir(runsDir, value.campaignId);
  if (!existsSync(pathForCampaign)) {
    initializeCampaign(runsDir, { campaignId: value.campaignId, goal: value.goal });
  }
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
  const wait = prompt.startsWith("Review node") ? 2000 : 3500;
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

function fakeAgy(directory) {
  const path = join(directory, "fake-agy.mjs");
  writeFileSync(path, `#!/usr/bin/env node
console.log(JSON.stringify({event:"init",conversation_id:"fake-conversation"}));
console.log(JSON.stringify({event:"result",result:{
  conversation_id:"fake-conversation",
  status:"SUCCESS",
  response:"READY",
  usage:{input_tokens:4,output_tokens:1,cache_read_tokens:2}
}}));
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

test("builds agy commands with unambiguous equals-form flags", () => {
  const command = providerCommand(
    { driver: "agy", model: "gemini-3.7-flash-low", reasoning: "xhigh", printTimeout: "30m" },
    "task with spaces",
    { schema: JUDGE_SCHEMA },
  );
  assert.equal(command.executable, "agy");
  assert.ok(command.args.includes("--model=gemini-3.7-flash-low"));
  assert.ok(command.args.includes("--effort=high"));
  assert.ok(command.args.includes("--print-timeout=30m"));
  assert.ok(command.args.includes(`--json-schema=${JSON.stringify(JUDGE_SCHEMA)}`));
  assert.ok(command.args.includes("--print=task with spaces"));
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

test("normalizes Codex, streaming Claude, and agy results", () => {
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

  const agy = [
    { event: "init", conversation_id: "conversation" },
    {
      event: "result",
      result: {
        conversation_id: "conversation",
        status: "SUCCESS",
        response: "ok",
        usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 3 },
      },
    },
  ].map(JSON.stringify).join("\n");
  const normalizedAgy = normalizeProviderResult("agy", agy, 0, null);
  assert.equal(normalizedAgy.status, "done");
  assert.equal(normalizedAgy.result, "ok");
  assert.equal(normalizedAgy.continuationId, "conversation");
  assert.equal(normalizedAgy.usage.cacheReadInputTokens, 3);
});

test("surfaces agy result errors", () => {
  const stream = JSON.stringify({
    event: "result",
    result: { status: "ERROR", response: "", error: "model unavailable", usage: {} },
  });
  const result = normalizeProviderResult("agy", stream, 0, null);
  assert.equal(result.status, "failed");
  assert.equal(result.error.message, "model unavailable");
});

test("selects structured JSON from an agy response with progress prose", () => {
  const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
  const stream = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation",
      status: "SUCCESS",
      response: `Waiting for checks...\n${verdict}\n`,
      usage: {},
    },
  });
  assert.equal(
    normalizeProviderResult("agy", stream, 0, null, { preferStructured: true }).result,
    verdict,
  );
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
      { id: "a", type: "backend", taskPacket: packet({ objective: "a" }), dependsOn: ["b"] },
      { id: "b", type: "backend", taskPacket: packet({ objective: "b" }), dependsOn: ["a"] },
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
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
      taskPacket: packet(),
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
  writeFileSync(join(directory, "work", "README.md"), "read me");
  const path = writeContract(directory, fixture({
    id: "stall-run",
    cwd: "work",
    pollIntervalMs: 10,
    stallTimeoutSec: 0.05,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"] }), gate: false }],
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
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
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  // The worker takes 3.5s of a 5s budget. A node-wide clock leaves the judge
  // 1.5s for work that needs 2s and kills a healthy reviewer.
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
      taskPacket: packet(),
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
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
      taskPacket: packet(),
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

  writeFileSync(join(runDir, "run.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: "earlier" }));
  assert.match(renderStatus(runDir), /build still claims to be running/u);
});

test("report aggregates per-node status, attempts, revisions, and tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-report-"));
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
  const directory = mkdtempSync(join(tmpdir(), "harness-events-"));
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
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id).sort(), ["luna", "sol"]);
  assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
});

test("preflight runs an agy runtime through its native stream protocol", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-preflight-agy-"));
  const path = writeContract(directory, fixture({
    runtimeDefaults: { worker: "agy", judge: "sol" },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const checks = await withFakeAgy(directory, () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id), ["agy"]);
  assert.equal(checks[0].ok, true, checks[0].detail);
});

test("preflight reports a missing credential by variable name only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-preflight-key-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "mechanic", taskPacket: packet(), gate: false }],
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

test("resume doubles the wall-clock budget of a node that exhausted it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-double-"));
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
  assert.equal(resumed.states.get("build").status, "done");
  const stored = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].timeoutSec, 4800, "budget persisted so later resumes keep it");
});

test("findings renders exhausted gate findings ready for a fix node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-findings-"));
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
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    const rendered = renderFindings(result.runDir);
    assert.match(rendered, /## build/u);
    assert.match(rendered, /\[critical\] broken/u);
    assert.match(rendered, /Evidence: test failed/u);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
});

test("maxInputTokens blocks pending nodes once the budget is spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-token-budget-"));
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
  assert.equal(result.states.get("first").status, "done");
  const blocked = result.states.get("second");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error.code, "budget_exceeded");
});

test("a finished run prints the token report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-auto-report-"));
  const path = writeContract(directory, fixture({ pollIntervalMs: 10 }));
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await withFakeCodex(directory, "pass", () => runContract(path));
  } finally {
    process.stdout.write = original;
  }
  assert.ok(writes.some((line) => line.includes("totals · in 10")), "auto-report table");
  assert.ok(writes.some((line) => line.includes("worker complete")), "node note surfaces the worker summary");
});

test("validate warns when a task packet verification command is absent from the Definition of Done", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-cmd-warn-"));
  const value = fixture();
  value.nodes[0].taskPacket = packet({ verification: ["pnpm exec vitest run tests/fixtures/x.test.ts"] });
  value.nodes[0].definitionOfDone = ["It works"];
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path)), path);
  assert.ok(contract.warnings.some((warning) => warning.includes("tests/fixtures/x.test.ts")));
  const clean = fixture();
  clean.nodes[0].taskPacket = packet({ verification: ["pnpm exec vitest run tests/fixtures/y.test.ts"] });
  clean.nodes[0].definitionOfDone = ["tests/fixtures/y.test.ts passes"];
  const cleanPath = writeContract(directory, clean);
  assert.equal(validateContract(JSON.parse(readFileSync(cleanPath)), cleanPath).warnings.length, 0);
});

test("run warns when a node id is already done in another run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-rerun-guard-"));
  const firstPath = writeContract(directory, fixture({ id: "first-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));

  const secondPath = writeContract(directory, fixture({ id: "second-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./harness.mjs", import.meta.url)), "run", secondPath], {
      encoding: "utf8",
    }),
  );
  assert.match(result.stdout, /\[warn\] node build is already done in run first-run/u);
});

test("watch resumes a run whose controller died", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-watch-"));
  const path = writeContract(directory, fixture({ id: "watch-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  // Simulate a controller that died mid-work: the node claims running but the
  // recorded pid is gone.
  orphan(runDir, "build");
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: "earlier" }));

  // The watcher's resumed controller inherits the watcher's environment, so
  // the fake provider must stay installed for the whole watch lifetime.
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, "pass");
  const watcher = spawn(
    process.execPath,
    [fileURLToPath(new URL("./harness.mjs", import.meta.url)), "watch", runDir, "--interval", "0.05"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    let stdout = "";
    watcher.stdout.on("data", (chunk) => { stdout += chunk; });
    const finished = await waitForValue(
      () => (stdout.includes("resumed") && stdout.includes("finished") ? "done" : null),
      20_000,
    );
    assert.equal(finished, "done", stdout);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
    watcher.kill("SIGTERM");
  }
});

test("blocks downstream nodes after a failed dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-dependency-"));
  const path = writeContract(directory, fixture({
    id: "dependency-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet({ objective: "Fail" }), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Never run" }), dependsOn: ["first"], gate: false },
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

test("validate requires a campaignId", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-id-"));
  const value = fixture();
  delete value.campaignId;
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => validateContract(JSON.parse(readFileSync(path)), path), /campaignId/u);

  for (const campaignId of [".", ".."]) {
    const invalid = fixture({ campaignId });
    writeFileSync(path, `${JSON.stringify(invalid, null, 2)}\n`);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path)), path), /campaignId/u);
  }
});

test("validate rejects legacy prompt and promptFile fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-legacy-prompt-"));
  const value = fixture();
  value.nodes[0].prompt = "legacy prompt";
  const promptPath = writeContract(directory, value);
  assert.throws(() => validateContract(JSON.parse(readFileSync(promptPath)), promptPath), /must not use prompt or promptFile/u);

  const fileValue = fixture();
  fileValue.nodes[0].promptFile = "legacy.md";
  const filePath = writeContract(directory, fileValue);
  assert.throws(() => validateContract(JSON.parse(readFileSync(filePath)), filePath), /must not use prompt or promptFile/u);
});

test("validate loads taskPacketFile and renders a closed execution prompt", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-task-packet-file-"));
  writeFileSync(join(directory, "packet.json"), `${JSON.stringify(packet())}\n`);
  const value = fixture();
  value.nodes[0] = { id: "build", type: "backend", taskPacketFile: "packet.json", gate: false };
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path)), path);
  assert.equal(contract.nodes[0].taskPacket.mode, "execution");
  assert.match(contract.nodes[0].prompt, /Closed context/u);
  assert.match(contract.nodes[0].prompt, /BLOCKED_CONTEXT/u);
});

test("validate rejects malformed, escaping, and missing-read-file task packets", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-task-packet-invalid-"));
  const outside = mkdtempSync(join(tmpdir(), "harness-task-packet-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(directory, "outside-link"));
  const cases = [
    [packet({ readFiles: ["../outside"] }), /escapes cwd/u],
    [packet({ writeFiles: ["../outside"] }), /escapes cwd/u],
    [packet({ readFiles: ["outside-link"] }), /escapes cwd/u],
    [packet({ writeFiles: ["outside-link"] }), /escapes cwd/u],
    [packet({ writeFiles: ["."] }), /must name a file/u],
    [packet({ readFiles: ["missing.txt"] }), /does not exist/u],
    [packet({ mode: "discovery", writeFiles: ["README.md"] }), /must be empty for a discovery packet/u],
    [packet({ mode: "execution", readFiles: [] }), /readFiles must not be empty/u],
    [packet({ mode: "execution", writeFiles: [] }), /writeFiles must not be empty/u],
  ];
  for (const [taskPacket, expected] of cases) {
    const value = fixture({ nodes: [{ id: "build", type: "backend", taskPacket, gate: false }] });
    const path = writeContract(directory, value);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path)), path), expected);
  }
});

test("validate rejects new write paths beneath an outward symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-task-packet-symlink-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "harness-task-packet-symlink-target-"));
  symlinkSync(outside, join(directory, "outside-dir"));
  const value = fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["outside-dir/new.txt"] }), gate: false }],
  });
  const path = writeContract(directory, value);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path)), path),
    /escapes cwd/u,
  );
});

test("validate rejects a symlink followed by dotdot escaping cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-task-packet-symlink-dotdot-"));
  const outside = mkdtempSync(join(tmpdir(), "harness-task-packet-symlink-dotdot-target-"));
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(directory, "secret.txt"), "inside secret");
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(join(outside, "sub"), join(directory, "link"));
  const value = fixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ readFiles: ["link/../secret.txt"] }),
      gate: false,
    }],
  });
  const path = writeContract(directory, value);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path)), path),
    /escapes cwd/u,
  );
});

test("judge prompt exposes only the write-file evidence boundary", () => {
  const node = {
    id: "build",
    type: "backend",
    taskPacket: packet(),
    definitionOfDone: ["It works"],
  };
  const prompt = judgePrompt(node, "worker complete");
  assert.match(prompt, /Write files:\n- README\.md/u);
  assert.doesNotMatch(prompt, /Read files/u);
  assert.doesNotMatch(prompt, /contract\.json/u);
});

test("discovery packets render as read-only discovery work", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-discovery-packet-"));
  const value = fixture({
    nodes: [{
      id: "discover",
      type: "backend",
      taskPacket: packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Find the entrypoint" }),
      gate: false,
    }],
  });
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path)), path);
  assert.match(contract.nodes[0].prompt, /read-only/u);
  assert.match(contract.nodes[0].prompt, /Return one JSON task packet/u);
});

test("stored contract inlines the task packet and drops the generated prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-stored-packet-"));
  const path = writeContract(directory, fixture({ id: "stored-packet-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const stored = JSON.parse(readFileSync(join(result.runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].taskPacket.mode, "execution");
  assert.equal(stored.nodes[0].prompt, undefined);
  assert.equal(stored.nodes[0].taskPacketFile, undefined);
  const revalidated = validateContract(stored, join(result.runDir, "contract.json"));
  assert.match(revalidated.nodes[0].prompt, /Closed context/u);
});

test("initializes a campaign with an empty bounded handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-init-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "launch", goal: "Ship the durable handoff" });
  assert.equal(created.campaign.goal, "Ship the durable handoff");
  assert.equal(readJournal(created.path)[0].type, "campaign.initialized");
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /# campaign launch handoff/u);
  assert.match(handoff, /Ship the durable handoff/u);
  assert.match(handoff, /No linked runs yet/u);
});

test("rejects dot and dotdot campaign ids", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-dot-id-"));
  const runsDir = join(directory, ".runs");
  for (const campaignId of [".", ".."]) {
    assert.throws(() => campaignDir(runsDir, campaignId), /campaignId/u);
    assert.throws(
      () => initializeCampaign(runsDir, { campaignId, goal: "Prove bounded campaign paths" }),
      /campaignId/u,
    );
    assert.throws(() => resolveCampaign(runsDir, campaignId), /campaignId/u);
  }
  assert.equal(existsSync(join(runsDir, "campaigns")), false);
});

test("session lineage records transcripts and explicit unavailability", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-session-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "sessions", goal: "Prove lineage" });
  appendJournal(created.path, {
    type: "session.attached",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    tool: "codex",
    transcript: join(directory, "codex-1.jsonl"),
    transcriptUnavailable: false,
    format: "jsonl",
    cursor: "42",
  });
  appendJournal(created.path, {
    type: "session.attached",
    at: new Date().toISOString(),
    sessionId: "claude-1",
    tool: "claude",
    transcript: null,
    transcriptUnavailable: true,
    format: null,
    cursor: null,
  });
  appendJournal(created.path, {
    type: "intent",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Continue without reading the full transcript",
  });
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /Updated: \d{4}-\d{2}-\d{2}T/u);
  assert.match(handoff, /codex codex-1 · transcript: .*codex-1\.jsonl · format: jsonl · cursor: 42/u);
  assert.match(handoff, /claude claude-1 · transcript: unavailable · format: - · cursor: -/u);
  assert.match(handoff, /Recent user intents[\s\S]*Continue without reading the full transcript/u);
});

test("decision supersession removes replaced decisions from the handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-supersede-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "decisions", goal: "Prove supersession" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "decision", at, sessionId: "codex-1", decisionId: "d1", text: "Use JSONL" });
  appendJournal(created.path, { type: "decision", at, sessionId: "codex-1", decisionId: "d2", text: "Use Markdown handoff" });
  appendJournal(created.path, { type: "supersede", at, sessionId: "codex-1", supersedes: "d1", text: "Replaced by d2" });
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /\[d2\] Use Markdown handoff/u);
  assert.doesNotMatch(handoff, /\[d1\] Use JSONL/u);
});

test("handoff projection is bounded to the latest entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-bounded-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "bounded", goal: "Prove bounded projection" });
  for (let index = 0; index < HANDOFF_LIMIT + 5; index += 1) {
    appendJournal(created.path, {
      type: "constraint",
      at: new Date().toISOString(),
      sessionId: "codex-1",
      text: `constraint-${String(index).padStart(3, "0")}`,
    });
  }
  const handoff = renderHandoff(created.path, runsDir);
  assert.doesNotMatch(handoff, /constraint-000/u);
  assert.match(handoff, /constraint-024/u);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
});

test("run registration links the run and handoff reflects fresh node status", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-run-"));
  const path = writeContract(directory, fixture({
    id: "linked-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(path)), path);
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const runsDir = join(directory, ".runs");
  const campaign = resolveCampaign(runsDir, "test-campaign");
  assert.deepEqual(campaign.campaign.linkedRunIds, ["linked-run"]);
  const handoff = renderHandoff(campaign.path, runsDir);
  assert.match(handoff, /## Linked runs/u);
  assert.match(handoff, /- linked-run: 1 nodes · 1 done/u);
});

test("run registration is idempotent across resume", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-idempotent-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "idempotent", goal: "Prove idempotent registration" });
  registerRun(created.path, "same-run");
  registerRun(created.path, "same-run");
  assert.deepEqual(resolveCampaign(runsDir, "idempotent").campaign.linkedRunIds, ["same-run"]);
  assert.equal(readJournal(created.path).filter((entry) => entry.type === "run.registered").length, 1);
});

test("rejects malformed journal events before append", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-invalid-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "invalid", goal: "Prove validation" });
  assert.throws(
    () => validateJournalEntry({ type: "intent", sessionId: "codex-1", text: "missing timestamp" }),
    /entry\.at/u,
  );
  assert.throws(
    () => appendJournal(created.path, { type: "intent", sessionId: "codex-1", text: "missing timestamp" }),
    /entry\.at/u,
  );
  assert.throws(
    () => appendJournal(created.path, { type: "intent", at: new Date().toISOString(), sessionId: "codex-1", text: "" }),
    /entry\.text/u,
  );
  assert.throws(
    () => appendJournal(created.path, { type: "session.attached", at: new Date().toISOString(), sessionId: "codex-1", tool: "codex", transcript: "relative.jsonl", transcriptUnavailable: false, format: "jsonl", cursor: null }),
    /absolute path/u,
  );
});

test("refuses ambiguous campaign discovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-ambiguous-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "alpha", goal: "First" });
  initializeCampaign(runsDir, { campaignId: "beta", goal: "Second" });
  assert.throws(() => resolveCampaign(runsDir), /multiple campaigns found/u);
  assert.equal(resolveCampaign(runsDir, "beta").campaign.id, "beta");
});

test("campaign CLI initializes, attaches, records via stdin, and shows the handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-cli-"));
  const harness = fileURLToPath(new URL("./harness.mjs", import.meta.url));
  const init = spawnSync(process.execPath, [harness, "campaign", "init", "cli", "--cwd", directory, "--goal", "Ship CLI"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /cli initialized/u);

  const attach = spawnSync(process.execPath, [
    harness, "campaign", "attach", "cli", "--cwd", directory,
    "--tool", "codex", "--session-id", "codex-1", "--transcript", join(directory, "transcript.jsonl"),
    "--format", "jsonl", "--cursor", "12",
  ], { encoding: "utf8" });
  assert.equal(attach.status, 0, attach.stderr);

  const record = spawnSync(process.execPath, [
    harness, "campaign", "note", "cli", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "decision", "--decision-id", "d1", "--text", "-",
  ], { encoding: "utf8", input: "Use a bounded handoff" });
  assert.equal(record.status, 0, record.stderr);

  const show = spawnSync(process.execPath, [harness, "campaign", "show", "cli", "--cwd", directory], { encoding: "utf8" });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Use a bounded handoff/u);
  assert.match(show.stdout, /codex codex-1/u);
});

test("campaign CLI refuses a malformed checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-campaign-cli-invalid-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "cli-invalid", goal: "Prove CLI validation" });
  const harness = fileURLToPath(new URL("./harness.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    harness, "campaign", "note", "cli-invalid", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "bogus", "--text", "bad",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--kind must be/u);
});
