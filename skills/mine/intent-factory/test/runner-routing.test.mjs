import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightContract, runContract } from "../src/cli.mjs";
import { livenessState } from "../src/engine/lifecycle.mjs";
import { failoverEdges, nextHop, nextSynthesizedRuntime } from "../src/engine/failover.mjs";
import { NETWORK_BACKOFF_CAP_MS, NETWORK_MAX_ATTEMPTS, backoffDelayMs, classifyTransition, isRepairable, isTimeoutOrStall, networkBackoffAttempts, quotaResetSchedule } from "../src/engine/backoff.mjs";
import { getHarness } from "../src/harnesses/index.mjs";
import { fakeCodex, fakeExecJsonl, fixture, packet, withFakeAgy, withFakeCodex, writeContract } from "./helpers.mjs";
import { nodeState, notifications, fakeClaudeLike, flagValue, failoverContract, RESET_NOW, NETWORK_NOW, NETWORK_DEADLINE, halfJitter } from "./runner-helpers.mjs";



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


test("quota exhaustion with no declared fallback leaves the node exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-no-fallback-quota-"));
  const exhausted = fakeCodex(directory, "quota-429");
  const path = writeContract(directory, fixture({
    id: "no-fallback-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "mid", judge: "mid" },
    runtimes: {
      mid: { harness: "codex", model: "mid", executable: exhausted, costRank: 2 },
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
      primary: { harness: "codex", model: "primary", executable: primary, fallback: "backup" },
      backup: { harness: "codex", model: "backup", executable: backup },
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
  // Carve-out: the codex harness's turn.failed quota branch never threads the
  // provider's resetAt into the envelope's error (harnesses are out of scope
  // for this phase), so a fake codex cannot make classifyTransition see a
  // reset window and exercise this end to end through runContract. This
  // exercises livenessState directly against the exact shape the runner
  // persists for a pending phase parked on a future routing backoff.
  const pendingWithActiveBackoff = /** @type {Map<string, import("../src/contract/index.mjs").NodeSnapshot>} */ (new Map([["build", {
    status: "pending",
    phase: "worker",
    routing: { currentOverride: { role: "worker", backoffUntil: new Date(Date.now() + 60_000).toISOString() } },
  }]]));
  assert.equal(livenessState(pendingWithActiveBackoff), "paused_quota");

  const pendingWithElapsedBackoff = /** @type {Map<string, import("../src/contract/index.mjs").NodeSnapshot>} */ (new Map([["build", {
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
    runtimes: { primary: { harness: "codex", model: "primary", executable: quotaPrimary } },
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
    runtimes: { jsonl: { harness: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
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
      primary: { harness: "exec-jsonl", model: "same-model", vendor: "primary-vendor", executable },
      backup: { harness: "exec-jsonl", model: "same-model", vendor: "backup-vendor", executable },
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
    runtimes: { jsonl: { harness: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
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
    runtimes: { provider: { harness: "claude", model: "test-model", permissionMode: "bypassPermissions", executable: fake.executable } },
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
    runtimes: { provider: { harness: "claude", model: "test-model", permissionMode: "bypassPermissions", executable: fake.executable } },
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
  const adapter = getHarness("claude");
  const previous = adapter.capabilities.continuation;
  adapter.capabilities.continuation = false;
  try {
    const path = writeContract(directory, fixture({
      id: "phase-no-continuation-run",
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { harness: "claude", model: "test-model", permissionMode: "bypassPermissions", executable: fake.executable } },
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


test("worker invocations send no tool policy to a harness that cannot enforce it", async () => {
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
    runtimes: { jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: provider } },
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
