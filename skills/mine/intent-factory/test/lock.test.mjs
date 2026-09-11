import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJson, writeJsonAtomic } from "../scripts/store.mjs";
import {
  LockBusyError,
  acquire,
  bootstrapMatchesChild,
  lockPath,
  lockStale,
  pidAlive,
  processStartToken,
  readLock,
} from "../scripts/lock.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract, validateNodeSnapshot } from "../scripts/contract.mjs";
import { resumeRun, runContract } from "../scripts/runner.mjs";
import {
  detectStalls,
  invocationAlive,
  monitorInvocation,
  startProcess,
  terminateInvocation,
} from "../scripts/node.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "./helpers.mjs";

// A pid the kernel will not hand out while the test runs: its holder is dead.
const DEAD_PID = 2_147_483_647;

/** @param {string} runDir @returns {import("../scripts/lock.mjs").LockRecord|null} */
function lockRecord(runDir) {
  const value = readLock(runDir);
  return value && !("invalid" in value) ? value : null;
}

/**
 * @param {string} runDir
 * @param {Record<string, unknown>} [overrides]
 * @returns {{contract: import("../scripts/contract.mjs").ValidatedContract, node: import("../scripts/contract.mjs").ValidatedNode}}
 */
function validatedRun(runDir, overrides = {}) {
  const contractPath = writeContract(runDir, fixture({ pollIntervalMs: 10, ...overrides }));
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

const CONTENDER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const gate = new Int32Array(workerData.gate);
import(workerData.lockUrl).then((lockModule) => {
  parentPort.postMessage({ ready: true });
  Atomics.wait(gate, 0, 0, 10_000);
  try {
    const handle = lockModule.acquire(workerData.runDir);
    parentPort.postMessage({ won: true, pid: handle.pid });
  } catch (error) {
    parentPort.postMessage({ won: false, name: error.name, message: error.message });
  }
}).catch((error) => parentPort.postMessage({ won: false, name: "ImportError", message: String(error && error.message) }));
`;

/**
 * Start `count` real contenders that all reach acquire() before any of them is
 * allowed to run: worker threads, not long-running children.
 * @param {string} runDir
 * @param {number} count
 * @returns {Promise<{won: boolean, pid?: number, name?: string, message?: string}[]>}
 */
async function raceForLock(runDir, count) {
  const gate = new SharedArrayBuffer(4);
  const open = new Int32Array(gate);
  const lockUrl = new URL("../scripts/lock.mjs", import.meta.url).href;
  const workers = Array.from({ length: count }, () => new Worker(CONTENDER_SOURCE, {
    eval: true,
    workerData: { runDir, lockUrl, gate },
  }));
  /** @type {{won: boolean, pid?: number, name?: string, message?: string}[]} */
  const outcomes = [];
  let ready = 0;
  try {
    await new Promise((settle, fail) => {
      for (const worker of workers) {
        worker.on("error", fail);
        worker.on("message", (message) => {
          if (message.ready) {
            ready += 1;
            if (ready === count) {
              Atomics.store(open, 0, 1);
              Atomics.notify(open, 0);
            }
            return;
          }
          outcomes.push(message);
          if (outcomes.length === count) settle(undefined);
        });
      }
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return outcomes;
}

test("acquire creates the lock and a second acquirer sees it as busy", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-busy-"));
  const handle = acquire(runDir, { pid: process.pid });
  try {
    assert.equal(handle.pid, process.pid);
    assert.equal(handle.current.pid, process.pid);
    const onDisk = lockRecord(runDir);
    assert.equal(onDisk?.pid, process.pid);
    assert.throws(() => acquire(runDir, { pid: process.pid }), LockBusyError);
    handle.assert();
  } finally {
    handle.release();
  }
  assert.equal(readLock(runDir), null);
});

test("readLock reports absent, invalid and present distinctly", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-read-"));
  assert.equal(readLock(runDir), null);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(lockPath(runDir), "{not json");
  assert.deepEqual(readLock(runDir), { invalid: true });
});

test("a lock whose holder pid is dead is stale and gets taken over", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-dead-pid-"));
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: DEAD_PID,
    processStartToken: null,
    startedAt: new Date(0).toISOString(),
    hostname: "dead-host",
  });
  assert.equal(lockStale(readLock(runDir)), true);
  const handle = acquire(runDir, { pid: process.pid });
  try {
    assert.equal(handle.pid, process.pid);
    assert.equal(lockRecord(runDir)?.pid, process.pid);
  } finally {
    handle.release();
  }
});

test("a lock whose recorded start token no longer matches is stale (pid reuse)", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-token-mismatch-"));
  // The pid is alive (it is this very process) but the token on record does
  // not match what the live process actually carries: the pid was recycled.
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: process.pid,
    processStartToken: "not-the-real-token",
    startedAt: new Date(0).toISOString(),
    hostname: "old-host",
  });
  assert.equal(pidAlive(process.pid), true);
  assert.equal(lockStale(readLock(runDir)), true);
  const handle = acquire(runDir, { pid: process.pid, processStartToken: processStartToken(process.pid) });
  try {
    assert.equal(lockRecord(runDir)?.processStartToken, processStartToken(process.pid));
  } finally {
    handle.release();
  }
});

test("release only removes a lock this handle still owns", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-release-guard-"));
  const handle = acquire(runDir, { pid: process.pid });
  // A successor overwrote the name after this handle's record was captured;
  // release() must recognize it is no longer the same record and leave it be.
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: DEAD_PID,
    processStartToken: null,
    startedAt: new Date(1000).toISOString(),
    hostname: "successor-host",
  });
  handle.release();
  assert.equal(lockRecord(runDir)?.pid, DEAD_PID);
});

test("assert() throws once the lock this handle installed is gone", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-assert-"));
  const handle = acquire(runDir, { pid: process.pid });
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: DEAD_PID,
    processStartToken: null,
    startedAt: new Date(1000).toISOString(),
    hostname: "successor-host",
  });
  assert.throws(() => handle.assert(), /controller lock was lost/u);
});

test("exactly one of two concurrent contenders wins an uncontended lock", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-race-fresh-"));
  const outcomes = await raceForLock(runDir, 2);
  const winners = outcomes.filter((outcome) => outcome.won);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  const loser = outcomes.find((outcome) => !outcome.won);
  assert.equal(loser?.name, "LockBusyError");
  assert.equal(lockRecord(runDir)?.pid, winners[0].pid);
});

test("exactly one of two concurrent contenders takes over a stale lock", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-race-stale-"));
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: DEAD_PID,
    processStartToken: null,
    startedAt: new Date(0).toISOString(),
    hostname: "dead-host",
  });
  const outcomes = await raceForLock(runDir, 2);
  const winners = outcomes.filter((outcome) => outcome.won);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  const loser = outcomes.find((outcome) => !outcome.won);
  assert.equal(loser?.name, "LockBusyError");
  // The takeover installed exactly the winner's record — not a corrupted mix
  // of the two contenders' writes.
  const onDisk = lockRecord(runDir);
  assert.equal(onDisk?.pid, winners[0].pid);
});

test("resume reaps an orphaned detached invocation on takeover", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lock-reap-orphan-"));
  const contractPath = writeContract(directory, fixture({
    id: "reap-orphan-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, timeoutSec: 1 }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(contractPath)).runDir);

  // A provider process that survives independently of its controller: its own
  // process group, still running, exactly like the gate wrapper spawns one.
  const orphanProvider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const orphanPid = orphanProvider.pid;
  if (orphanPid === undefined) throw new Error("orphan provider pid unavailable");
  const orphanExit = new Promise((resolve) => orphanProvider.once("exit", resolve));

  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const now = Date.now();
  const startedAt = new Date(now - 60_000).toISOString();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.gate = null;
  state.invocations = [{
    id: "orphan-invocation",
    pid: orphanPid,
    processGroupId: process.platform === "win32" ? null : orphanPid,
    processStartToken: processStartToken(orphanPid),
    driver: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: "reap-orphan-run",
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
    // The deadline is already behind us: the dead controller never got to
    // notice, so the takeover is what has to catch it and reap the process.
    deadlineAt: new Date(now - 1_000).toISOString(),
    updatedAt: startedAt,
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
  }];
  writeFileSync(nodePath, JSON.stringify(state, null, 2));

  // The controller that dispatched this invocation is gone: its lock is stale.
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: DEAD_PID,
    processStartToken: null,
    startedAt: new Date(now - 120_000).toISOString(),
    hostname: "dead-host",
  });

  assert.equal(invocationAlive({ pid: orphanPid, processGroupId: orphanPid }), true, "the orphan provider is alive before takeover");
  try {
    const result = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
    await orphanExit;
    assert.equal(invocationAlive({ pid: orphanPid, processGroupId: orphanPid }), false, "takeover reaped the orphaned detached invocation");
    // A synthetic invocation has no real worker scope snapshot, so recovery
    // cannot prove replay safety and stops at blocked rather than adopting or
    // restarting — the point under test is that the orphan was reaped and the
    // takeover proceeded to recover the node at all, not the recovery verdict.
    assert.notEqual(result.states.get("build")?.status, "running");
  } finally {
    try { process.kill(process.platform === "win32" ? orphanPid : -orphanPid, "SIGKILL"); } catch {}
  }
});

test("atomic JSON and JSONL recovery never leaves a partial authoritative record", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-store-atomic-"));
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
  const runDir = mkdtempSync(join(tmpdir(), "lock-jsonl-recovery-"));
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

test("darwin process start token is a stable, non-null fingerprint for a live process", { skip: process.platform !== "darwin" }, () => {
  const first = processStartToken(process.pid);
  assert.notEqual(first, null);
  assert.equal(processStartToken(process.pid), first);
});

test("darwin process start token differs for a pid recycled by a later-started process (real child)", { skip: process.platform !== "darwin" }, async () => {
  const first = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const firstPid = first.pid;
  if (firstPid === undefined) throw new Error("first child pid unavailable");
  const firstToken = processStartToken(firstPid);
  assert.notEqual(firstToken, null);
  first.kill("SIGKILL");
  await new Promise((resolve) => first.once("exit", resolve));
  // Force a different start second before the pid (if reused) reappears, so a
  // real recycle would carry a different lstart token.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const secondPid = second.pid;
  if (secondPid === undefined) throw new Error("second child pid unavailable");
  try {
    const secondToken = processStartToken(secondPid);
    assert.notEqual(secondToken, null);
    if (secondPid === firstPid) {
      assert.notEqual(secondToken, firstToken, "the kernel reused the pid: the fingerprint must catch it");
    }
  } finally {
    second.kill("SIGKILL");
    await new Promise((resolve) => second.once("exit", resolve));
  }
});

test("two synthetic records with different tokens are a mismatch, not just an unequal-string coincidence", () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const bootstrapRecord = { pid: process.pid, nonce, processStartToken: "synthetic-token-a" };
  assert.equal(bootstrapMatchesChild(bootstrapRecord, process.pid, nonce, "synthetic-token-b"), false, "different synthetic tokens must not match");
  assert.equal(bootstrapMatchesChild(bootstrapRecord, process.pid, nonce, "synthetic-token-a"), true, "identical synthetic tokens still match");

  // The same distinction, exercised through lockStale via a captured lock
  // record: a recorded token that disagrees with what the live pid actually
  // carries now (injected here as a synthetic mismatch, standing in for a
  // real pid-reuse token change) makes the lock stale even though the pid
  // itself is alive.
  const runDir = mkdtempSync(join(tmpdir(), "lock-token-injected-"));
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: process.pid,
    processStartToken: "synthetic-token-a",
    startedAt: new Date(0).toISOString(),
    hostname: "old-host",
  });
  const recorded = readLock(runDir);
  assert.notEqual(processStartToken(process.pid), "synthetic-token-a", "the live token must genuinely disagree with the synthetic one");
  assert.equal(pidAlive(process.pid), true);
  assert.equal(lockStale(recorded), true, "a live pid with a mismatched recorded token is still stale");
});

test("process start token is null on platforms other than linux and darwin", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    assert.equal(processStartToken(process.pid), null);
  } finally {
    Object.defineProperty(process, "platform", /** @type {PropertyDescriptor} */ (original));
  }
});

test("monitorInvocation reads bounded live evidence and never throws", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-monitor-invocation-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  writeFileSync(stdout, [
    { type: "thread.started", thread_id: "live-thread" },
    { type: "item.completed", item: { type: "tool_call" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const job = /** @type {import("../scripts/runner.mjs").Job} */ ({
    runtime: { driver: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.deepEqual(monitorInvocation(job), { continuationId: "live-thread", turns: 1, cacheReadInputTokens: 80, toolCalls: 1, completed: false });
  assert.deepEqual(
    monitorInvocation({ ...job, paths: { ...job.paths, stdout: join(logs, "missing.jsonl") } }),
    { continuationId: null, turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false },
    "a missing transcript meters as zero without throwing",
  );
});

test("monitorInvocation keeps counting codex turns after the transcript outgrows any fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-monitor-fat-codex-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const fatItem = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(4096) } });
  const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 150_000 } });
  const first = [];
  for (let index = 0; index < 40; index += 1) first.push(fatItem, turn);
  writeFileSync(stdout, `${first.join("\n")}\n`);
  const job = /** @type {import("../scripts/runner.mjs").Job} */ ({
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
  const runDir = mkdtempSync(join(tmpdir(), "lock-monitor-fat-claude-"));
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
  const job = /** @type {import("../scripts/runner.mjs").Job} */ ({
    runtime: { driver: "claude" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 90, "assistant turns past the old window still count");
  assert.equal(observed.cacheReadInputTokens, 123_456, "the terminal result total replaces the per-turn sum");
});

test("stall supervision uses the latest persisted timeout override", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-timeout-override-"));
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
    /** @type {{currentJob: import("../scripts/runner.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
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

test("stall supervision kills a runtime whose driver declares streamed output once it goes quiet past stallTimeoutSec", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-stall-streaming-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const provider = join(runDir, "provider.mjs");
  // Writes once, immediately, then never again: codex declares streamsOutput
  // (confirmed by reading its adapter's `--json` transport), so this alone
  // must be enough for the stall clock to start and then expire.
  writeFileSync(provider, "#!/usr/bin/env node\nprocess.stdout.write(\"{}\\n\"); process.stdin.resume(); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  const { contract, node } = validatedRun(runDir, { stallTimeoutSec: 0.05 });
  const state = nodeSnapshot(node, []);
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
    onInvocation: () => {},
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(statSync(job.paths.stdout).size > 0, "the provider must have written its one line by now");
    // A poll loop calls detectStalls repeatedly; the first call after output
    // appears only records it as progress; a stall is only real once a later
    // poll finds nothing new.
    await detectStalls(contract, new Map([["build", job]]), async () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    /** @type {{currentJob: import("../scripts/runner.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let timeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      timeout = { currentJob, status, error };
    });
    assert.ok(timeout, "stall supervisor reported a timeout");
    assert.equal(timeout.status, "stalled");
    assert.match(timeout.error.message, /no provider output/u);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("stall supervision never kills a runtime whose driver declares no streamed output; it is bounded by timeoutSec instead", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-stall-non-streaming-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const recording = join(runDir, "recording.jsonl");
  // replay declares streamsOutput: false (measured: replay-bin.mjs writes its
  // one envelope line only after delayMs). 5s comfortably outlasts every
  // wait below, so the process is still silent-on-disk at both checkpoints.
  writeFileSync(recording, `${JSON.stringify({
    envelope: {
      status: "done", result: "late", continuationId: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: null, error: null,
    },
    delayMs: 5_000,
  })}\n`);
  const { contract, node } = validatedRun(runDir, { stallTimeoutSec: 0.05, timeoutSec: 0.3 });
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "replayed", driver: "replay", model: "test", config: { "replay.recording": recording } },
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(statSync(job.paths.stdout, { throwIfNoEntry: false })?.size ?? 0, 0, "the replay process has written nothing yet");
    /** @type {{currentJob: import("../scripts/runner.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let firstTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      firstTimeout = { currentJob, status, error };
    });
    assert.equal(firstTimeout, undefined, "silence alone must not kill a driver that never reports streamed output");

    await new Promise((resolve) => setTimeout(resolve, 250));
    /** @type {{currentJob: import("../scripts/runner.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let secondTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      secondTimeout = { currentJob, status, error };
    });
    assert.ok(secondTimeout, "the wall-clock budget still applies");
    assert.equal(secondTimeout.status, "exhausted", "the same silent runtime is bounded by timeoutSec, never by the stall clock");
  } finally {
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a glm worker runs with the driver's endpoint env overlay applied", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-glm-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "glm-worker-marker.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  notify: process.env.INTENT_FACTORY_NOTIFY_BIN ?? null,
  ambient: process.env.INTENT_FACTORY_AMBIENT ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  model: process.env.ANTHROPIC_MODEL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
setInterval(() => {}, 1000);
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
    // The fake provider creates the marker before it finishes writing it, so an
    // existence check alone races the write under parallel load; wait until the
    // file parses.
    const deadline = Date.now() + 5_000;
    let observed = null;
    while (observed === null && Date.now() < deadline) {
      try { observed = JSON.parse(readFileSync(marker, "utf8")); } catch { observed = null; }
      if (observed === null) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(observed, "the fake provider wrote its marker within five seconds");
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
  const runDir = mkdtempSync(join(tmpdir(), "lock-persistence-barrier-"));
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
