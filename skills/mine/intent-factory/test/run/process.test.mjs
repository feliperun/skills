import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../../src/run/store.mjs";
import {
  bootstrapMatchesChild,
  lockPath,
  lockStale,
  pidAlive,
  processStartToken,
  readLock,
} from "../../src/run/lock.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { detectStalls, invocationAlive, monitorInvocation, startProcess, terminateInvocation } from "../../src/engine/process.mjs";

import { fixture, writeContract } from "../helpers.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";

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

// The other half of lock.test.mjs: spawning an invocation behind the gate,
// watching it, detecting a stall, and taking it down.

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
  const job = /** @type {import("../../src/cli.mjs").Job} */ ({
    runtime: { harness: "codex" },
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
  const job = /** @type {import("../../src/cli.mjs").Job} */ ({
    runtime: { harness: "codex" },
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
  const job = /** @type {import("../../src/cli.mjs").Job} */ ({
    runtime: { harness: "claude" },
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
    runtime: { id: "luna", harness: "codex", model: "test" },
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
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
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

test("stall supervision kills a runtime whose harness declares streamed output once it goes quiet past stallTimeoutSec", async () => {
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
    runtime: { id: "luna", harness: "codex", model: "test" },
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
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
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

test("stall supervision never kills a runtime whose harness declares no streamed output; it is bounded by timeoutSec instead", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-stall-non-streaming-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const recording = join(runDir, "recording.jsonl");
  // replay declares streamsOutput: false (measured: replay/bin.mjs writes its
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
  const { contract, node } = validatedRun(runDir, { stallTimeoutSec: 0.05, timeoutSec: 0.6 });
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "replayed", harness: "replay", model: "test", config: { "replay.recording": recording } },
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
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let firstTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      firstTimeout = { currentJob, status, error };
    });
    assert.equal(firstTimeout, undefined, "silence alone must not kill a harness that never reports streamed output");

    // Discriminating check: the gate's stdout/stderr files exist (created
    // empty before spawn) from the very first poll onward, so a streamsOutput
    // implementation that still tracked mtime would record that fixed
    // creation time as "progress" on the first poll and then, finding no
    // further change here 250ms later, would call it stalled — well inside
    // this 0.6s wall-clock budget. The fix must stay silent here.
    await new Promise((resolve) => setTimeout(resolve, 250));
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let secondTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      secondTimeout = { currentJob, status, error };
    });
    assert.equal(secondTimeout, undefined, "a harness that never reports streamed output must survive well past stallTimeoutSec");

    await new Promise((resolve) => setTimeout(resolve, 300));
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let thirdTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      thirdTimeout = { currentJob, status, error };
    });
    assert.ok(thirdTimeout, "the wall-clock budget still applies");
    assert.equal(thirdTimeout.status, "exhausted", "the same silent runtime is bounded by timeoutSec, never by the stall clock");
  } finally {
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a zcode worker runs with the harness's endpoint env overlay applied", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-zcode-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "zcode-worker-marker.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  notify: process.env.INTENT_FACTORY_NOTIFY_BIN ?? null,
  ambient: process.env.INTENT_FACTORY_AMBIENT ?? null,
  baseUrl: process.env.ZCODE_BASE_URL ?? null,
  model: process.env.ZCODE_MODEL ?? null,
  token: process.env.GLM_API_KEY ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
setInterval(() => {}, 1000);
`);
  chmodSync(provider, 0o755);
  const previous = {
    INTENT_FACTORY_ZCODE_BIN: process.env.INTENT_FACTORY_ZCODE_BIN,
    INTENT_FACTORY_MARKER: process.env.INTENT_FACTORY_MARKER,
    INTENT_FACTORY_AMBIENT: process.env.INTENT_FACTORY_AMBIENT,
    INTENT_FACTORY_NOTIFY_BIN: process.env.INTENT_FACTORY_NOTIFY_BIN,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.INTENT_FACTORY_ZCODE_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  process.env.INTENT_FACTORY_AMBIENT = "ambient-value";
  process.env.INTENT_FACTORY_NOTIFY_BIN = provider;
  process.env.ZAI_API_KEY = "zcode-notify-test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "zcode-glm", harness: "zcode", model: "glm-5.3[1m]" },
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
    assert.equal(observed.baseUrl, "https://api.z.ai/api/anthropic", "harness env overlay must still apply");
    assert.equal(observed.model, "glm/glm-5.3", "the [1m] tier marker is stripped before ZCODE_MODEL");
    assert.equal(observed.token, "zcode-notify-test-token");
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
      runtime: { id: "luna", harness: "codex", model: "test" },
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
