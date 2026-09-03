import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign, JOURNAL_FILE } from "../scripts/campaign.mjs";
import {
  GOVERNANCE_METRICS_FILE,
  HEARTBEAT_FILE,
  HEARTBEAT_MAX_BYTES,
  deriveGovernanceMetrics,
  deriveHeartbeat,
  readHeartbeat,
  rebuildHeartbeat,
  recordLiveness,
  validateLivenessFact,
  writeGovernanceMetrics,
} from "../scripts/heartbeat.mjs";
import { PUSH_EVENT_TYPES, loadNotifyAdapters, pushNotification, routeNotification } from "../scripts/notify/index.mjs";
import { createMacosNotifier } from "../scripts/notify/os-macos.mjs";

/** @typedef {import("../scripts/heartbeat.mjs").LivenessFact} LivenessFact */

const EMISSION_AT = "2026-09-02T12:00:00.000Z";
const SECOND_AT = "2026-09-02T12:05:00.000Z";
const PROGRESS_AT = "2026-09-02T11:50:00.000Z";

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {LivenessFact}
 */
function makeFact(overrides = {}) {
  return /** @type {LivenessFact} */ ({
    type: "liveness",
    eventId: "live-1",
    at: EMISSION_AT,
    campaignId: "hb",
    runId: "run-a",
    nodeId: "node-a",
    phase: "P2",
    checkpointsDone: 3,
    checkpointsTotal: 7,
    runtime: "codex",
    state: "running",
    weightedUsed: 2_340_112,
    weightedCap: 6_000_000,
    lastProgressAt: PROGRESS_AT,
    attention: null,
    ...overrides,
  });
}

/**
 * @returns {{directory: string, runsDir: string, created: {path: string}}}
 */
function makeCampaign() {
  const directory = mkdtempSync(join(tmpdir(), "heartbeat-core-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "hb", goal: "Prove the derived heartbeat" });
  return { directory, runsDir, created };
}

/** @param {string} campaignPath @returns {string[]} */
function leftoverTemps(campaignPath) {
  return readdirSync(campaignPath).filter((name) => name.startsWith("heartbeat.json."));
}

test("heartbeat atomic write journals the liveness fact before emitting the file", () => {
  const { created } = makeCampaign();
  const heartbeatPath = join(created.path, HEARTBEAT_FILE);
  assert.equal(existsSync(heartbeatPath), false);
  assert.equal(readHeartbeat(created.path), null);
  const fact = makeFact();
  assert.doesNotThrow(() => validateLivenessFact(fact));
  const recorded = recordLiveness(created.path, fact, { generatedAt: EMISSION_AT, eventId: "live-1" });
  const journal = readFileSync(join(created.path, JOURNAL_FILE), "utf8");
  assert.match(journal, /"type":"liveness"/u);
  assert.match(journal, /"eventId":"live-1"/u);
  assert.equal(existsSync(heartbeatPath), true);
  assert.equal(recorded.path, heartbeatPath);
  assert.equal(recorded.entry.type, "liveness");
  assert.equal(recorded.heartbeat.schemaVersion, 1);
  assert.deepEqual(leftoverTemps(created.path), []);
  const stored = JSON.parse(readFileSync(heartbeatPath, "utf8"));
  assert.deepEqual(stored, recorded.heartbeat);
  assert.deepEqual(readHeartbeat(created.path), recorded.heartbeat);
});

test("heartbeat bounded derivation keeps the file at most 1024 bytes and oversized derivations throw", () => {
  const { created } = makeCampaign();
  const wide = makeFact({
    eventId: "wide-1",
    campaignId: "c".repeat(128),
    runId: "r".repeat(128),
    nodeId: "n".repeat(128),
    phase: "p".repeat(128),
    runtime: "t".repeat(128),
    attention: "A".repeat(80),
  });
  const heartbeat = deriveHeartbeat(wide, { generatedAt: EMISSION_AT });
  assert.ok(Buffer.byteLength(JSON.stringify(heartbeat), "utf8") <= HEARTBEAT_MAX_BYTES);
  assert.equal(heartbeat.phase, "p".repeat(64));
  assert.equal(heartbeat.activeNode, "n".repeat(64));
  assert.equal(heartbeat.runtime, "t".repeat(64));
  assert.equal(heartbeat.attention, "A".repeat(80));
  recordLiveness(created.path, wide, { generatedAt: EMISSION_AT, eventId: "wide-1" });
  assert.ok(statSync(join(created.path, HEARTBEAT_FILE)).size <= HEARTBEAT_MAX_BYTES);

  const maxWeight = 9_007_199_254_740_991;
  const oversized = makeFact({
    eventId: "wide-2",
    campaignId: "😀".repeat(32),
    runId: "😀".repeat(32),
    nodeId: "😀".repeat(32),
    phase: "😀".repeat(32),
    runtime: "😀".repeat(32),
    attention: "😀".repeat(80),
    checkpointsDone: maxWeight,
    checkpointsTotal: maxWeight,
    weightedUsed: maxWeight,
    weightedCap: maxWeight,
  });
  const before = readFileSync(join(created.path, HEARTBEAT_FILE));
  assert.throws(
    () => deriveHeartbeat(oversized, { generatedAt: EMISSION_AT }),
    (error) => error instanceof TypeError && /1024/u.test(error.message) && /bytes/u.test(error.message),
  );
  assert.throws(
    () => recordLiveness(created.path, oversized, { generatedAt: EMISSION_AT, eventId: "wide-2" }),
    TypeError,
  );
  assert.deepEqual(readFileSync(join(created.path, HEARTBEAT_FILE)), before);
  assert.deepEqual(leftoverTemps(created.path), []);
});

test("heartbeat progress source records observed progress, not emission time", () => {
  const { created } = makeCampaign();
  const fact = makeFact({ eventId: "progress-1", lastProgressAt: PROGRESS_AT, at: SECOND_AT });
  const { heartbeat } = recordLiveness(created.path, fact, { generatedAt: EMISSION_AT, eventId: "progress-1" });
  assert.equal(heartbeat.lastProgressAt, Math.floor(Date.parse(PROGRESS_AT) / 1000));
  assert.equal(heartbeat.generatedAt, Math.floor(Date.parse(EMISSION_AT) / 1000));
  assert.notEqual(heartbeat.lastProgressAt, heartbeat.generatedAt);
  const stored = readHeartbeat(created.path);
  assert.ok(stored !== null);
  assert.equal(stored.lastProgressAt, heartbeat.lastProgressAt);
});

test("heartbeat rebuild reproduces the recorded file byte-identically from the journal", () => {
  const { created } = makeCampaign();
  const heartbeatPath = join(created.path, HEARTBEAT_FILE);
  recordLiveness(created.path, makeFact({ eventId: "r1" }), { generatedAt: EMISSION_AT, eventId: "r1" });
  recordLiveness(created.path, makeFact({
    eventId: "r2",
    checkpointsDone: 5,
    state: "waiting_gate",
    attention: "waiting on the gate",
  }), { generatedAt: SECOND_AT, eventId: "r2" });
  const recorded = readFileSync(heartbeatPath, "utf8");
  unlinkSync(heartbeatPath);
  const rebuilt = rebuildHeartbeat(created.path, { generatedAt: SECOND_AT });
  assert.ok(rebuilt !== null);
  assert.equal(rebuilt.attention, "waiting on the gate");
  assert.deepEqual(readFileSync(heartbeatPath, "utf8"), recorded);
  assert.deepEqual(readHeartbeat(created.path), rebuilt);
  assert.deepEqual(leftoverTemps(created.path), []);

  const empty = makeCampaign();
  assert.equal(rebuildHeartbeat(empty.created.path, { generatedAt: EMISSION_AT }), null);
  assert.equal(existsSync(join(empty.created.path, HEARTBEAT_FILE)), false);
});

test("heartbeat pinned on failure leaves the previous heartbeat file untouched", () => {
  const { created } = makeCampaign();
  const heartbeatPath = join(created.path, HEARTBEAT_FILE);
  recordLiveness(created.path, makeFact({ eventId: "good-1" }), { generatedAt: EMISSION_AT, eventId: "good-1" });
  const before = readFileSync(heartbeatPath);
  assert.throws(
    () => recordLiveness(created.path, makeFact({ eventId: "bad-1", state: "bogus" }), { generatedAt: EMISSION_AT, eventId: "bad-1" }),
    TypeError,
  );
  assert.deepEqual(readFileSync(heartbeatPath), before);
  assert.doesNotMatch(readFileSync(join(created.path, JOURNAL_FILE), "utf8"), /"eventId":"bad-1"/u);

  const journalPath = join(created.path, JOURNAL_FILE);
  unlinkSync(journalPath);
  mkdirSync(journalPath);
  assert.throws(() => recordLiveness(created.path, makeFact({ eventId: "bad-2" }), { generatedAt: EMISSION_AT, eventId: "bad-2" }));
  assert.deepEqual(readFileSync(heartbeatPath), before);
  assert.deepEqual(leftoverTemps(created.path), []);
});

test("heartbeat canonical write produces key-sorted compact bytes within 1 KiB", () => {
  const { created } = makeCampaign();
  const heartbeatPath = join(created.path, HEARTBEAT_FILE);
  const recorded = recordLiveness(created.path, makeFact({ eventId: "canonical-1" }), { generatedAt: EMISSION_AT, eventId: "canonical-1" });
  const text = readFileSync(heartbeatPath, "utf8");
  assert.ok(Buffer.byteLength(text, "utf8") <= HEARTBEAT_MAX_BYTES, "the written bytes stay inside 1 KiB");
  assert.equal(text, `${JSON.stringify(recorded.heartbeat)}\n`, "the file is exactly the compact key-sorted serialization plus one newline");
  const stored = JSON.parse(text);
  assert.deepEqual(Object.keys(stored), [...Object.keys(stored)].sort(), "the top-level keys are sorted");
  assert.deepEqual(stored, recorded.heartbeat);
  assert.equal(text.startsWith('{"activeNode":'), true);
  assert.deepEqual(readHeartbeat(created.path), recorded.heartbeat);
  assert.deepEqual(leftoverTemps(created.path), []);
});

test("heartbeat strict timestamps reject non-ISO values", () => {
  assert.doesNotThrow(() => validateLivenessFact(makeFact()));
  assert.doesNotThrow(() => validateLivenessFact(makeFact({ at: "2026-09-02T12:00:00.5+02:00" })));
  for (const at of ["2026-09-02 12:00:00", "September 2, 2026", "2026-09-02T12:00:00", "2026-09-02T12:00:00Z "]) {
    assert.throws(() => validateLivenessFact(makeFact({ at })), TypeError, `at ${JSON.stringify(at)} must be rejected`);
  }
  assert.throws(() => validateLivenessFact(makeFact({ lastProgressAt: "2026-09-02 12:00:00" })), TypeError);
  assert.throws(
    () => deriveHeartbeat(makeFact(), { generatedAt: "2026-09-02 12:00:00" }),
    (error) => error instanceof TypeError && /ISO-8601/u.test(error.message),
  );
  assert.doesNotThrow(() => deriveHeartbeat(makeFact(), { generatedAt: 1_785_744_000 }));
  assert.equal(deriveHeartbeat(makeFact(), { generatedAt: EMISSION_AT }).generatedAt, Math.floor(Date.parse(EMISSION_AT) / 1000));
});

test("governance metrics are reproducible and silentStallRate is zero for D36 and D38 fixtures", () => {
  const metricsNow = Date.parse("2026-09-02T12:00:00.000Z");
  /** @param {number} seconds @returns {string} */
  const at = (seconds) => new Date(metricsNow + seconds * 1000).toISOString();
  /** @type {Record<string, unknown>[]} */
  const livenessFacts = [
    { type: "liveness", eventId: "f1", at: at(0), runId: "run-a", state: "running" },
    { type: "liveness", eventId: "f2", at: at(41 * 60), runId: "run-a", state: "blocked", attention: "stale liveness: no progress for 41 min" },
  ];
  /** @type {Record<string, unknown>[]} */
  const coveredOutbox = [{
    eventId: "attention-1",
    type: "run.attention",
    campaignId: "camp",
    at: at(40 * 60 + 30),
    summary: "attention",
    data: { code: "stale_liveness", runId: "run-a" },
    deliveredAt: null,
    attempts: 0,
    lastError: null,
  }];
  const input = { events: [], livenessFacts, outbox: coveredOutbox, now: metricsNow + 42 * 60 * 1000, staleSec: 2400 };
  const first = deriveGovernanceMetrics(input);
  const second = deriveGovernanceMetrics(input);
  assert.deepEqual(first, second, "identical inputs give identical metrics");
  assert.equal(JSON.stringify(first), JSON.stringify(second), "identical inputs give identical JSON");
  assert.equal(first.silentStallRate, 0, "a stale gap covered by the stale_liveness attention is never silent");
  const uncovered = deriveGovernanceMetrics({ ...input, outbox: [] });
  assert.equal(uncovered.silentStallRate, 1, "an uncovered stale gap is fully silent");

  /** @type {Record<string, unknown>[]} */
  const events = [
    { at: at(0), node: "a", from: "pending", to: "pending", budgetDecision: { extensionAllowanceTokens: 200 } },
    { at: at(60), node: "a", from: "pending", to: "running", budgetAction: { type: "extension", grantedTokens: 10 } },
    { at: at(120), node: "b", from: "pending", to: "pending", budgetDecision: { extensionAllowanceTokens: 100 } },
    { at: at(180), node: "b", from: "pending", to: "running", budgetAction: { type: "continuation_activated", allocationTokens: 20 } },
    { at: at(240), node: "c", from: "running", to: "running", budgetAction: { type: "attention", observedTokens: 900 } },
    { at: at(250), node: "c", from: "running", to: "blocked" },
  ];
  const metrics = deriveGovernanceMetrics({ events, livenessFacts: [], outbox: [], now: metricsNow + 600 * 1000, staleSec: 2400 });
  assert.equal(metrics.budgetHeadroomAtDispatch, 150);
  assert.equal(metrics.budgetExtensionRate, 0.5);
  assert.equal(metrics.continuationRate, 0.5);
  assert.equal(metrics.budgetDecisionAge, 480, "newest decision belongs to a still-nonterminal node");
  const latency = deriveGovernanceMetrics({
    events,
    livenessFacts: [],
    outbox: [{ eventId: "ba-1", type: "run.attention", campaignId: "camp", at: at(400), summary: "budget attention", data: { code: "budget_attention", nodeId: "c" }, deliveredAt: null, attempts: 0, lastError: null }],
    now: metricsNow + 600 * 1000,
    staleSec: 2400,
  });
  assert.equal(latency.budgetAttentionLatencyP95, 160, "outbox minus the budgetAction attention event at");

  const { created } = makeCampaign();
  writeGovernanceMetrics(created.path, first);
  assert.deepEqual(JSON.parse(readFileSync(join(created.path, GOVERNANCE_METRICS_FILE), "utf8")), first);
});

test("notify macos adapter records argv and escapes quotes for terminal and attention events", async () => {
  /** @type {{command: string, args: string[]}[]} */
  const calls = [];
  /**
   * @param {string} command
   * @param {string[]} args
   * @returns {import("../scripts/notify/os-macos.mjs").SpawnedChild}
   */
  const fakeSpawn = (command, args) => {
    calls.push({ command, args });
    /** @type {Record<string, (value?: unknown) => void>} */
    const handlers = {};
    const child = {
      stderr: { on() {} },
      /** @param {string} event @param {(value?: unknown) => void} handler */
      once(event, handler) {
        handlers[event] = handler;
        return child;
      },
      /** @param {string} event @param {(value?: unknown) => void} handler */
      on(event, handler) {
        handlers[event] = handler;
        return child;
      },
      kill() {},
      /** @param {string} event @param {unknown} value */
      emit(event, value) {
        handlers[event]?.(value);
      },
    };
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  const adapter = createMacosNotifier({ spawn: fakeSpawn, platform: "darwin", timeoutMs: 1000 });
  assert.equal(adapter.id, "os-macos");
  assert.deepEqual(adapter.capabilities, { canPush: true, canWake: false, canRenderAmbient: false });
  /** @param {string} value @returns {string} */
  const escape = (value) => value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  const events = [
    { type: "node.terminal", campaignId: "camp", summary: 'node "alpha" \\ done' },
    { type: "run.terminal", campaignId: "camp", summary: 'run failed with "boom"' },
    { type: "run.attention", campaignId: "camp", summary: 'stuck on a \\\\ backslash and "gate"' },
  ];
  for (const event of events) {
    const result = await pushNotification(event, [adapter]);
    assert.deepEqual(result, { delivered: ["os-macos"], failed: [] });
  }
  assert.equal(calls.length, events.length);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assert.equal(calls[index].command, "osascript");
    assert.equal(calls[index].args[0], "-e");
    assert.equal(
      calls[index].args[1],
      `display notification "${escape(event.summary)}" with title "intent-factory" subtitle "${escape(`camp · ${event.type}`)}"`,
    );
  }
  assert.deepEqual(loadNotifyAdapters({ platform: "darwin", spawn: fakeSpawn }).map((loaded) => loaded.id), ["os-macos"]);
  assert.deepEqual(loadNotifyAdapters({ platform: "linux", spawn: fakeSpawn }), []);
  const unsupported = createMacosNotifier({
    platform: "freebsd",
    spawn() {
      throw new Error("must not spawn");
    },
  });
  assert.deepEqual(await unsupported.deliver({ type: "node.terminal", summary: "x" }), { ok: false, error: "unsupported platform" });
});

test("notify no progress push never routes or delivers progress events", async () => {
  /** @type {unknown[]} */
  const delivered = [];
  const adapter = {
    id: "stub",
    capabilities: { canPush: true, canWake: false, canRenderAmbient: false },
    /** @param {unknown} event */
    async deliver(event) {
      delivered.push(event);
      return { ok: true };
    },
  };
  const progress = { type: "campaign.progress", campaignId: "camp", summary: "2 of 7 checkpoints" };
  assert.deepEqual(routeNotification(progress, [adapter]), []);
  assert.deepEqual(await pushNotification(progress, [adapter]), { delivered: [], failed: [] });
  assert.deepEqual(delivered, []);
  assert.deepEqual(routeNotification({ type: "outside.push" }, [adapter]), []);
  for (const type of PUSH_EVENT_TYPES) {
    assert.deepEqual(routeNotification({ type, summary: "s" }, [adapter]).map((entry) => entry.id), ["stub"]);
  }
  const quiet = {
    id: "quiet",
    capabilities: { canPush: false, canWake: true, canRenderAmbient: false },
    async deliver() {
      throw new Error("must not run");
    },
  };
  assert.deepEqual(routeNotification({ type: "node.terminal" }, [quiet]), []);
  assert.deepEqual(await pushNotification({ type: "node.terminal" }, [quiet]), { delivered: [], failed: [] });
  const failing = {
    id: "boom",
    capabilities: { canPush: true, canWake: false, canRenderAmbient: false },
    async deliver() {
      return { ok: false, error: "nope" };
    },
  };
  assert.deepEqual(await pushNotification({ type: "run.terminal" }, [failing]), {
    delivered: [],
    failed: [{ id: "boom", error: "nope" }],
  });
  const rejecting = {
    id: "rejects",
    capabilities: { canPush: true, canWake: false, canRenderAmbient: false },
    async deliver() {
      throw new Error("kaput");
    },
  };
  assert.deepEqual(await pushNotification({ type: "run.terminal" }, [rejecting]), {
    delivered: [],
    failed: [{ id: "rejects", error: "kaput" }],
  });
});
