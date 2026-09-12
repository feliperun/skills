import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { failoverEdges, nextHop, nextSynthesizedRuntime } from "../../src/engine/failover.mjs";
import { NETWORK_BACKOFF_CAP_MS, NETWORK_MAX_ATTEMPTS, backoffDelayMs, classifyTransition, isRepairable, isTimeoutOrStall, networkBackoffAttempts, quotaResetSchedule } from "../../src/engine/backoff.mjs";
import { fakeCodex, fakeExecJsonl, fixture, packet, withFakeAgy, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState, notifications, failoverContract, RESET_NOW, NETWORK_NOW, NETWORK_DEADLINE, halfJitter } from "../runner-helpers.mjs";
import { preflightContract } from "../../src/engine/live-preflight.mjs";

// Routing: which runtime a role resolves to, and the backoff around it.
// Exhaustion and the failover edge are in failover.test.mjs.

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
    assert.equal(checks[0].harness, "codex");
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
      luna: { harness: "codex", model: "gpt-5.6-luna", executable: "/nonexistent/codex", requiredCapabilities: { sandbox: true } },
      sol: { harness: "codex", model: "gpt-5.6-sol", executable: "/nonexistent/codex" },
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
    runtimes: { jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable } },
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
      runtimes: { jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: staticExecutable } },
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
    runtimes: { jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: provider } },
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
      primary: { harness: "exec-jsonl", model: "primary", vendor: "primary-vendor", executable, fallback: "backup" },
      backup: { harness: "exec-jsonl", model: "backup", vendor: "backup-vendor", executable },
    },
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }), null, 2)}\n`);
  const checks = await preflightContract(path, { static: true });
  assert.deepEqual(checks.map((check) => check.id), ["primary", "backup"]);
});

test("failoverEdges lists one declared edge per runtime, ordered by costRank", () => {
  const contract = failoverContract("runner-declared-failover-", {
    runtimes: {
      mid: { harness: "codex", model: "mid", executable: "/nonexistent/codex", costRank: 2, fallback: "dear" },
      dear: { harness: "codex", model: "dear", executable: "/nonexistent/codex", costRank: 9 },
      cheap: { harness: "codex", model: "cheap", executable: "/nonexistent/codex", costRank: 1, fallback: "dear" },
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
      mid: { harness: "codex", model: "mid", executable: "/nonexistent/codex", costRank: 2, fallback: "target" },
      unranked: { harness: "codex", model: "unranked", executable: "/nonexistent/codex", fallback: "target" },
      astronomical: { harness: "codex", model: "astronomical", executable: "/nonexistent/codex", costRank: Number.MAX_SAFE_INTEGER, fallback: "target" },
      target: { harness: "codex", model: "target", executable: "/nonexistent/codex" },
    },
  });
  assert.deepEqual(
    failoverEdges(contract).map((edge) => edge.from),
    ["mid", "astronomical", "unranked"],
    "every ranked runtime, however costly, still sorts ahead of an unranked one",
  );
});

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
      primary: { harness: "codex", model: "primary", executable: flaky, costRank: 1 },
      spare: { harness: "codex", model: "spare", executable: fakeCodex(directory, "pass"), costRank: 2 },
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
      "primary-worker": { harness: "codex", model: "primary", vendor: "primary-worker-vendor", executable: flaky },
      primary: { harness: "codex", model: "primary", vendor: "primary-judge-vendor", executable: flaky },
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
