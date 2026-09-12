import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJson, writeJsonAtomic } from "../../src/run/store.mjs";
import {
  LockBusyError,
  acquire,
  bootstrapMatchesChild,
  lockPath,
  lockStale,
  pidAlive,
  processStartToken,
  readLock,
} from "../../src/run/lock.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { resumeRun, runContract } from "../../src/cli.mjs";
import { detectStalls, invocationAlive, monitorInvocation, startProcess, terminateInvocation } from "../../src/engine/process.mjs";

import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";

// A pid the kernel will not hand out while the test runs: its holder is dead.
const DEAD_PID = 2_147_483_647;

/** @param {string} runDir @returns {import("../../src/run/lock.mjs").LockRecord|null} */
function lockRecord(runDir) {
  const value = readLock(runDir);
  return value && !("invalid" in value) ? value : null;
}

/**
 * @param {string} runDir
 * @param {Record<string, unknown>} [overrides]
 * @returns {{contract: import("../../src/contract/index.mjs").ValidatedContract, node: import("../../src/contract/index.mjs").ValidatedNode}}
 */
function validatedRun(runDir, overrides = {}) {
  const contractPath = writeContract(runDir, fixture({ pollIntervalMs: 10, ...overrides }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  if (!node) throw new Error("fixture has no build node");
  return { contract, node };
}

/**
 * @param {import("../../src/contract/index.mjs").ValidatedNode} node
 * @param {unknown[]} executionOverrides
 * @returns {import("../../src/contract/index.mjs").NodeSnapshot}
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
  const lockUrl = new URL("../../src/run/lock.mjs", import.meta.url).href;
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

// The controller lock: acquisition, staleness, takeover, pid reuse.
// Invocation processes and stall detection are in process.test.mjs.

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
    harness: "codex",
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
