import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJsonl,
  acquireControllerLease,
  acquireSupervisorLease,
  LeaseBusyError,
  readJson,
  readSupervisorLease,
  writeJsonAtomic,
} from "../scripts/store.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract, validateNodeSnapshot } from "../scripts/contract.mjs";
import { detectStalls, invocationAlive, monitorInvocation, processStartToken, startProcess, terminateInvocation } from "../scripts/supervisor.mjs";
import { captureWorkspaceSnapshot } from "../scripts/verification.mjs";
import { fixture, packet, writeContract } from "./helpers.mjs";

/**
 * @param {string} runDir
 * @returns {{contract: import("../scripts/contract.mjs").ValidatedContract, node: import("../scripts/contract.mjs").ValidatedNode}}
 */
function validatedRun(runDir) {
  const contractPath = writeContract(runDir, fixture({ pollIntervalMs: 10 }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  if (!node) throw new Error("fixture has no build node");
  return { contract, node };
}

/**
 * @param {import("../scripts/contract.mjs").ValidatedNode} node
 * @param {unknown[]} executionOverrides
 * @returns {import("../scripts/contract.mjs").NodeSnapshot}
 */
function nodeSnapshot(node, executionOverrides) {
  const now = new Date().toISOString();
  return validateNodeSnapshot({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    id: node.id,
    type: node.type,
    sourceIdentity: node.sourceIdentity,
    packetHash: node.packetHash,
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: now,
    updatedAt: now,
    result: null,
    gate: null,
    error: null,
    invocations: [],
    executionOverrides,
    verification: null,
    scope: {
      boundary: {
        schemaVersion: 1,
        files: [...(node.taskPacket.writeFiles ?? [])],
        roots: [...(node.taskPacket.writeRoots ?? [])],
        fileOrigins: [...(node.taskPacket.writeFiles ?? [])].map((literal) => ({ literal, paths: [literal] })),
        rootOrigins: [...(node.taskPacket.writeRoots ?? [])].map((literal) => ({ literal, paths: [literal] })),
      },
      changedPaths: [],
      unexpectedPaths: [],
      changedPathCount: 0,
      unexpectedPathCount: 0,
      truncated: false,
    },
  }, node);
}

test("simultaneous controllers have one exclusive lease and stale takeover increments generation", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-lease-"));
  const first = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_000 });
  assert.throws(
    () => acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_010 }),
    (error) => error instanceof LeaseBusyError,
  );
  const second = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_100 });
  assert.equal(second.generation, first.generation + 1);
  assert.notEqual(second.holderId, first.holderId);
  second.release();
});

test("a delayed heartbeat renews its own expired lease instead of declaring it lost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-heartbeat-delay-"));
  const lease = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100 });
  let lost = false;
  lease.startHeartbeat(() => { lost = true; });
  try {
    // Simulate a heartbeat delayed past the TTL: the lease on disk is ours but expired.
    writeJsonAtomic(join(runDir, "controller-lease.json"), {
      ...lease.current,
      renewedAt: new Date(Date.now() - 10_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(lost, false);
    const actual = /** @type {{expiresAt: string, holderId: string}} */ (readJson(join(runDir, "controller-lease.json")));
    assert.ok(Date.parse(actual.expiresAt) > Date.now());
    assert.equal(actual.holderId, lease.current.holderId);
    lease.assert();
  } finally {
    lease.release();
  }
});

test("lease heartbeat expiry is authoritative even when the old PID is still alive", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-heartbeat-"));
  const first = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100, now: 1_000 });
  writeJsonAtomic(join(runDir, "controller-lease.json"), {
    ...first.current,
    renewedAt: new Date(500).toISOString(),
    expiresAt: new Date(900).toISOString(),
  });
  const second = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100, now: 1_000 });
  assert.equal(second.generation, first.generation + 1);
  assert.equal(invocationAlive({ pid: process.pid, processStartToken: processStartToken(process.pid) }), true);
  second.release();
});

test("supervisor lease takeover reclaims stale ownership without a permanent lock", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-supervisor-lease-"));
  const first = acquireSupervisorLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_000 });
  const second = acquireSupervisorLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_100 });
  assert.equal(second.generation, first.generation + 1);
  first.release();
  const current = readSupervisorLease(runDir);
  assert.ok(current && !("invalid" in current));
  assert.equal(current.holderId, second.holderId);
  second.release();
  assert.equal(readSupervisorLease(runDir), null);
});

test("atomic JSON and JSONL recovery never leaves a partial authoritative record", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-store-"));
  const jsonPath = join(runDir, "run.json");
  const jsonlPath = join(runDir, "events.jsonl");
  writeJsonAtomic(jsonPath, { generation: 1, state: "ready" });
  writeJsonAtomic(jsonPath, { generation: 2, state: "done" });
  appendJsonl(jsonlPath, { to: "running" });
  appendJsonl(jsonlPath, { to: "done" });
  assert.deepEqual(readJson(jsonPath), { generation: 2, state: "done" });
  assert.deepEqual(readFileSync(jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [{ to: "running" }, { to: "done" }]);
});

test("JSONL append recovers a truncated final record before appending", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-jsonl-recovery-"));
  const jsonlPath = join(runDir, "events.jsonl");
  writeFileSync(jsonlPath, `${JSON.stringify({ to: "running" })}\n{"to":"partial`);
  appendJsonl(jsonlPath, { to: "done" });
  assert.deepEqual(readFileSync(jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [{ to: "running" }, { to: "done" }]);
});

test("termination escalates from SIGTERM to SIGKILL for a provider that ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("child pid unavailable");
  const invocation = {
    id: "ignored-term",
    pid,
    processGroupId: process.platform === "win32" ? null : pid,
    processStartToken: processStartToken(pid),
  };
  try {
    await terminateInvocation(invocation, { graceMs: 25, killGraceMs: 500 });
    assert.equal(invocationAlive(invocation), false);
  } finally {
    try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {}
  }
});

test("portable PID reuse defense rejects a mismatched Linux process start token", { skip: process.platform !== "linux" }, () => {
  assert.equal(invocationAlive({ pid: process.pid, processStartToken: "definitely-not-this-process" }), false);
});

test("monitorInvocation reads bounded live evidence and never throws", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-monitor-invocation-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  writeFileSync(stdout, [
    { type: "thread.started", thread_id: "live-thread" },
    { type: "item.completed", item: { type: "tool_call" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const job = /** @type {import("../scripts/supervisor.mjs").Job} */ ({
    runtime: { driver: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.deepEqual(monitorInvocation(job), { continuationId: "live-thread", turns: 1, cacheReadInputTokens: 80, toolCalls: 1 });
  assert.deepEqual(
    monitorInvocation({ ...job, paths: { ...job.paths, stdout: join(logs, "missing.jsonl") } }),
    { continuationId: null, turns: 0, cacheReadInputTokens: 0, toolCalls: 0 },
    "a missing transcript meters as zero without throwing",
  );
});

test("monitorInvocation keeps counting codex turns after the transcript outgrows any fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-monitor-fat-codex-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const fatItem = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(4096) } });
  const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 150_000 } });
  const first = [];
  for (let index = 0; index < 40; index += 1) first.push(fatItem, turn);
  writeFileSync(stdout, `${first.join("\n")}\n`);
  const job = /** @type {import("../scripts/supervisor.mjs").Job} */ ({
    runtime: { driver: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.equal(monitorInvocation(job).turns, 40, "the first observation consumes the padded prefix");
  const second = [];
  for (let index = 0; index < 40; index += 1) second.push(turn);
  appendFileSync(stdout, `${second.join("\n")}\n`);
  assert.ok(statSync(stdout).size > 128 * 1024, "the transcript outgrew the old fixed live window");
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 80, "the rotation turn threshold stays observable on a fat transcript");
  assert.equal(observed.cacheReadInputTokens, 150_000, "cumulative codex cache-read counters compose as a max, not a sum");
});

test("monitorInvocation observes claude turns and the session total beyond a fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-monitor-fat-claude-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const lines = [];
  for (let index = 0; index < 90; index += 1) {
    // Fat content pushes the threshold-crossing turns past 128 KiB of log.
    const text = index < 40 ? "z".repeat(4096) : "done";
    lines.push(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }], usage: { input_tokens: 1, cache_read_input_tokens: 1_000 } },
    }));
  }
  lines.push(JSON.stringify({ type: "result", session_id: "fat-session", usage: { input_tokens: 9, cache_read_input_tokens: 123_456 } }));
  writeFileSync(stdout, `${lines.join("\n")}\n`);
  assert.ok(statSync(stdout).size > 128 * 1024, "the transcript outgrew the old fixed live window");
  const job = /** @type {import("../scripts/supervisor.mjs").Job} */ ({
    runtime: { driver: "claude" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 90, "assistant turns past the old window still count");
  assert.equal(observed.cacheReadInputTokens, 123_456, "the terminal result total replaces the per-turn sum");
});

test("stall supervision uses the latest persisted timeout override", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-timeout-override-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.INTENT_FACTORY_MARKER, \"started\"); process.stdin.resume(); setTimeout(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  const previousMarker = process.env.INTENT_FACTORY_MARKER;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, [
    { kind: "timeout", timeoutSec: 5, at: new Date().toISOString(), reason: "old" },
    { kind: "timeout", timeoutSec: 0.05, at: new Date().toISOString(), reason: "latest" },
  ]);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", driver: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => assert.equal(existsSync(marker), false, "provider must not start before invocation persistence"),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    /** @type {{currentJob: import("../scripts/supervisor.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
  let timeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      timeout = { currentJob, status, error };
    });
    assert.ok(timeout, "stall supervisor reported a timeout");
    assert.equal(timeout.status, "exhausted");
    assert.match(timeout.error.message, /0\.05s/u);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.INTENT_FACTORY_MARKER;
    else process.env.INTENT_FACTORY_MARKER = previousMarker;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a glm worker runs with the driver's endpoint env overlay applied", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-glm-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-env.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
const marker = process.env.INTENT_FACTORY_MARKER;
const temporary = \`${"${marker}"}.${"${process.pid}"}.tmp\`;
writeFileSync(temporary, JSON.stringify({
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  model: process.env.ANTHROPIC_MODEL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
renameSync(temporary, marker);
process.stdin.resume();
`);
  chmodSync(provider, 0o755);
  const previous = {
    INTENT_FACTORY_GLM_BIN: process.env.INTENT_FACTORY_GLM_BIN,
    INTENT_FACTORY_MARKER: process.env.INTENT_FACTORY_MARKER,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.INTENT_FACTORY_GLM_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  process.env.ZAI_API_KEY = "glm-test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
  process.env.ANTHROPIC_BASE_URL = "https://ambient.example/api";
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "glm", driver: "glm", model: "glm-5.3[1m]" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.baseUrl, "https://api.z.ai/api/anthropic", "endpoint overlay replaces the ambient base URL");
    assert.equal(observed.model, "glm-5.3[1m]");
    assert.equal(observed.token, "glm-test-token");
    assert.equal(observed.apiKey, null, "ambient Anthropic key is removed, not inherited");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("worker providers never receive the controller-only notification transport", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-notify-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-env.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
const marker = process.env.INTENT_FACTORY_MARKER;
const temporary = \`${"${marker}"}.${"${process.pid}"}.tmp\`;
writeFileSync(temporary, JSON.stringify({
  notify: process.env.INTENT_FACTORY_NOTIFY_BIN ?? null,
  ambient: process.env.INTENT_FACTORY_AMBIENT ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  model: process.env.ANTHROPIC_MODEL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
renameSync(temporary, marker);
process.stdin.resume();
`);
  chmodSync(provider, 0o755);
  const previous = {
    INTENT_FACTORY_GLM_BIN: process.env.INTENT_FACTORY_GLM_BIN,
    INTENT_FACTORY_MARKER: process.env.INTENT_FACTORY_MARKER,
    INTENT_FACTORY_AMBIENT: process.env.INTENT_FACTORY_AMBIENT,
    INTENT_FACTORY_NOTIFY_BIN: process.env.INTENT_FACTORY_NOTIFY_BIN,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.INTENT_FACTORY_GLM_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  process.env.INTENT_FACTORY_AMBIENT = "ambient-value";
  process.env.INTENT_FACTORY_NOTIFY_BIN = provider;
  process.env.ZAI_API_KEY = "glm-notify-test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "glm", driver: "glm", model: "glm-5.3[1m]" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.notify, null, "INTENT_FACTORY_NOTIFY_BIN must not reach the worker provider");
    assert.equal(observed.ambient, "ambient-value", "ambient runtime variables must survive");
    assert.equal(observed.baseUrl, "https://api.z.ai/api/anthropic", "driver env overlay must still apply");
    assert.equal(observed.model, "glm-5.3[1m]");
    assert.equal(observed.token, "glm-notify-test-token");
    assert.equal(observed.apiKey, null, "ambient Anthropic key is removed, not inherited");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a persistence failure leaves the gated provider unstarted and terminates its wrapper", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-persistence-barrier-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.INTENT_FACTORY_MARKER, \"started\"); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  const previousMarker = process.env.INTENT_FACTORY_MARKER;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  let persistedInvocation;
  try {
    assert.throws(() => startProcess({
      contract,
      node,
      state,
      runtime: { id: "luna", driver: "codex", model: "test" },
      prompt: "task",
      paths: {
        prompt: join(logs, "worker.prompt"),
        stdout: join(logs, "worker.jsonl"),
        stderr: join(logs, "worker.err"),
      },
      phase: "worker",
      onInvocation: (invocation) => {
        persistedInvocation = invocation;
        throw new Error("persistence failed");
      },
    }), /persistence failed/u);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(marker), false);
    assert.equal(invocationAlive(persistedInvocation), false);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.INTENT_FACTORY_MARKER;
    else process.env.INTENT_FACTORY_MARKER = previousMarker;
  }
});

test("autonomous progress stalls on unchanged allowed scope despite noisy stdout and resets on a real change", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-progress-heartbeat-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  mkdirSync(join(runDir, "src"));
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "console.log('working'); setInterval(() => console.log('working'), 5);\n");
  chmodSync(provider, 0o755);
  const autonomousPacket = packet({ mode: "autonomous", writeRoots: ["src"] });
  delete autonomousPacket.writeFiles;
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  const contractPath = writeContract(runDir, fixture({
    pollIntervalMs: 5,
    stallTimeoutSec: 30,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacket,
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 2 },
      gate: false,
    }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  const state = nodeSnapshot(node, []);
  let baseline;
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", driver: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: (_invocation, currentJob) => {
      baseline = captureWorkspaceSnapshot(contract.cwd);
      currentJob.scopeBaseline = baseline;
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    /** @type {{status: "exhausted"|"stalled", error: {code: string}}|undefined} */
    let outcome;
    await detectStalls(contract, new Map([["build", job]]), async (_job, status, error) => {
      outcome = { status, error };
    });
    assert.equal(state.progress?.dryHeartbeatCount, 1);
    assert.equal(outcome, undefined);
    writeFileSync(join(runDir, "src", "progress.txt"), "progress\n");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await detectStalls(contract, new Map([["build", job]]), async (_job, status, error) => {
      outcome = { status, error };
    });
    assert.equal(state.progress?.dryHeartbeatCount, 0);
    assert.equal(outcome, undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await detectStalls(contract, new Map([["build", job]]), async (_job, status, error) => {
      outcome = { status, error };
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await detectStalls(contract, new Map([["build", job]]), async (_job, status, error) => {
      outcome = { status, error };
    });
    const stalledOutcome = /** @type {{status: "exhausted"|"stalled", error: {code: string}}} */ (/** @type {unknown} */ (outcome));
    assert.equal(stalledOutcome.status, "stalled");
    assert.equal(stalledOutcome.error.code, "progress_stalled");
    assert.equal(job.closed, true);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("progress deadline and dry count survive a worker restart while judges remain exempt", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-progress-resume-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  mkdirSync(join(runDir, "src"));
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  const autonomousPacket = packet({ mode: "autonomous", writeRoots: ["src"] });
  delete autonomousPacket.writeFiles;
  const contractPath = writeContract(runDir, fixture({
    pollIntervalMs: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacket,
      progressPolicy: { graceSec: 300, intervalSec: 120, maxDryHeartbeats: 3 },
      gate: {},
    }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  const state = nodeSnapshot(node, []);
  state.progress = {
    revision: 0,
    heartbeatCount: 2,
    dryHeartbeatCount: 1,
    progressSignature: "persisted",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    nextCheckAt: "2026-01-01T00:00:01.000Z",
  };
  const baseline = captureWorkspaceSnapshot(contract.cwd);
  const worker = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", driver: "codex", model: "worker" },
    prompt: "task",
    paths: { prompt: join(logs, "worker.prompt"), stdout: join(logs, "worker.jsonl"), stderr: join(logs, "worker.err") },
    phase: "worker",
    onInvocation: (_invocation, job) => { job.scopeBaseline = baseline; },
  });
  try {
    assert.equal(state.progress.heartbeatCount, 2);
    assert.equal(state.progress.dryHeartbeatCount, 1);
    assert.equal(state.progress.nextCheckAt, "2026-01-01T00:00:01.000Z");
    await terminateInvocation(worker.invocation, { graceMs: 25, killGraceMs: 500 });
    const judge = startProcess({
      contract,
      node,
      state,
      runtime: { id: "luna", driver: "codex", model: "judge" },
      prompt: "Review node",
      paths: { prompt: join(logs, "judge.prompt"), stdout: join(logs, "judge.jsonl"), stderr: join(logs, "judge.err") },
      phase: "judge",
      onInvocation: () => {},
    });
    try {
      assert.equal(state.progress.heartbeatCount, 2);
      assert.equal(state.progress.dryHeartbeatCount, 1);
    } finally {
      await terminateInvocation(judge.invocation, { graceMs: 25, killGraceMs: 500 });
    }
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    try { await terminateInvocation(worker.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});
