import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJsonl,
  acquireControllerLease,
  acquireWatcherLease,
  LeaseBusyError,
  readJson,
  readWatcherLease,
  writeJsonAtomic,
} from "../scripts/store.mjs";
import { PLAN_RUNNER_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract, validateNodeSnapshot } from "../scripts/contract.mjs";
import { detectStalls, invocationAlive, processStartToken, startProcess, terminateInvocation } from "../scripts/supervisor.mjs";
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
    contractVersion: PLAN_RUNNER_VERSION,
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
    scope: null,
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

test("watcher lease takeover reclaims stale ownership without a permanent lock", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-watcher-lease-"));
  const first = acquireWatcherLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_000 });
  const second = acquireWatcherLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_100 });
  assert.equal(second.generation, first.generation + 1);
  first.release();
  const current = readWatcherLease(runDir);
  assert.ok(current && !("invalid" in current));
  assert.equal(current.holderId, second.holderId);
  second.release();
  assert.equal(readWatcherLease(runDir), null);
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

test("stall supervision uses the latest persisted timeout override", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-timeout-override-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.PLAN_RUNNER_MARKER, \"started\"); process.stdin.resume(); setTimeout(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  const previousMarker = process.env.PLAN_RUNNER_MARKER;
  process.env.PLAN_RUNNER_CODEX_BIN = provider;
  process.env.PLAN_RUNNER_MARKER = marker;
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
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.PLAN_RUNNER_MARKER;
    else process.env.PLAN_RUNNER_MARKER = previousMarker;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a persistence failure leaves the gated provider unstarted and terminates its wrapper", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-persistence-barrier-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.PLAN_RUNNER_MARKER, \"started\"); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  const previousMarker = process.env.PLAN_RUNNER_MARKER;
  process.env.PLAN_RUNNER_CODEX_BIN = provider;
  process.env.PLAN_RUNNER_MARKER = marker;
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
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.PLAN_RUNNER_MARKER;
    else process.env.PLAN_RUNNER_MARKER = previousMarker;
  }
});
