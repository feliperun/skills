import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_DATA_MAX_BYTES,
  EVENT_MAX_BYTES,
  EVENT_SCHEMA_VERSION,
  boundEventRecord,
  classifyEvent,
  projectEvent,
  validateEvent,
} from "../scripts/events.mjs";

/** @param {number} seconds @returns {string} */
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

/** @param {string} type @param {Record<string, unknown>} [overrides] */
function event(type, overrides = {}) {
  return projectEvent({
    type,
    campaignId: "campaign",
    at: at(1),
    ...overrides,
  });
}

test("events module exports the schema contract", () => {
  assert.equal(EVENT_SCHEMA_VERSION, 1);
  assert.equal(EVENT_MAX_BYTES, 1024);
  assert.equal(EVENT_DATA_MAX_BYTES, 512);
});

test("summary is deterministic per type from counters and identifiers only", () => {
  assert.equal(
    event("campaign.progress", {
      runId: "run-a",
      nodeId: "build",
      counters: { attempt: 3, revisions: 1 },
      identifiers: { runtimeId: "luna" },
      data: { runId: "run-a", nodeId: "build", status: "done", phase: "worker", attempt: 3, revisions: 1, runtime: "luna" },
    }).summary,
    "node build progress · attempt 3 · revisions 1 · runtime luna",
  );
  assert.equal(
    event("node.terminal", {
      runId: "run-a",
      nodeId: "build",
      counters: { attempt: 3, revisions: 1 },
      identifiers: { errorCode: "verification_failed" },
      data: { runId: "run-a", nodeId: "build", status: "failed" },
    }).summary,
    "node build terminal · attempt 3 · revisions 1 · verification_failed",
  );
  assert.equal(
    event("run.terminal", {
      runId: "run-a",
      counters: { done: 2, total: 3 },
      data: { runId: "run-a", done: 2, total: 3, needsAttention: 1 },
    }).summary,
    "run run-a terminal · 2/3 done · attention",
  );
  assert.equal(
    event("run.terminal", {
      runId: "run-a",
      counters: { done: 3, total: 3 },
      data: { runId: "run-a", done: 3, total: 3, needsAttention: 0 },
    }).summary,
    "run run-a terminal · 3/3 done",
  );
  assert.equal(
    event("run.attention", {
      runId: "run-a",
      nodeId: "build",
      identifiers: { errorCode: "budget_attention" },
      data: { runId: "run-a", nodeId: "build", code: "budget_attention" },
    }).summary,
    "run run-a attention · node build · budget_attention",
  );
  assert.equal(
    event("campaign.attention", {
      identifiers: { errorCode: "retry_limit_exhausted" },
      data: { code: "retry_limit_exhausted" },
    }).summary,
    "campaign campaign attention · retry_limit_exhausted",
  );
  assert.equal(event("campaign.completed", { data: { runCount: 1 } }).summary, "campaign campaign completed");
});

test("every record carries an explicit requiresUser and a fixed next phrase", () => {
  for (const type of ["campaign.progress", "campaign.attention", "campaign.completed", "run.attention", "run.terminal", "node.terminal"]) {
    const record = event(type, { runId: "run-a", nodeId: "build", data: { runId: "run-a", nodeId: "build", status: "done" } });
    assert.equal(typeof record.requiresUser, "boolean", type);
    assert.ok(record.next.length > 0, type);
    validateEvent(record);
  }
});

test("the canonical record carries eventId, runId and nodeId inside the 1 KiB bound", () => {
  const record = event("node.terminal", {
    runId: "run-a",
    nodeId: "build",
    counters: { attempt: 3, revisions: 1 },
    identifiers: { errorCode: "provider_exhausted" },
    data: { runId: "run-a", nodeId: "build", status: "exhausted", detail: "d".repeat(2 * 1024) },
  });
  assert.equal(typeof record.eventId, "string");
  assert.ok(record.eventId.length > 0, "eventId is generated inside projectEvent");
  assert.equal(record.runId, "run-a");
  assert.equal(record.nodeId, "build");
  validateEvent(record);
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= EVENT_MAX_BYTES);
  const scoped = event("campaign.completed", { data: { runCount: 1 } });
  assert.equal(scoped.runId, null);
  assert.equal(scoped.nodeId, null);
  validateEvent(scoped);
});

test("projectEvent derives a stable eventId from the enqueue key", () => {
  const base = { type: "node.terminal", campaignId: "campaign", runId: "run-a", nodeId: "build", counters: { attempt: 1 }, at: at(1) };
  const first = projectEvent({ ...base, data: { status: "done" }, key: "run-a:build:done:1:0" });
  const second = projectEvent({ ...base, data: { status: "done" }, key: "run-a:build:done:1:0" });
  assert.equal(first.eventId, second.eventId, "the same enqueue key projects the same event id");
  const other = projectEvent({ ...base, data: { status: "done" }, key: "run-a:build:done:2:0" });
  assert.notEqual(first.eventId, other.eventId, "a different enqueue key projects a different event id");
});

test("requiresUser is true only for the three actionable classes", () => {
  /** @type {Array<[type: string, code: string|null]>} */
  const healthy = [
    ["campaign.progress", null],
    ["node.terminal", null],
    ["run.terminal", null],
    ["run.attention", "budget_attention"],
    ["run.attention", "stale_liveness"],
    ["run.attention", "judge_unavailable"],
    ["campaign.attention", "retry_limit_exhausted"],
    ["campaign.attention", "budget_exhausted"],
    ["campaign.attention", "repair_limit_exhausted"],
    ["campaign.attention", "invalid_state"],
  ];
  for (const [type, code] of healthy) {
    assert.equal(classifyEvent(type, code).requiresUser, false, `${type} ${code}`);
  }
  /** @type {Array<[type: string, code: string|null]>} */
  const actionable = [
    ["node.terminal", "blocked_context"],
    ["run.attention", "open-question"],
    ["node.terminal", "context_missing"],
    ["campaign.attention", "provider_exhausted_without_declared_failover"],
    ["node.terminal", "provider_exhausted"],
    ["node.terminal", "quota_exhausted"],
    ["run.terminal", "payment_required"],
  ];
  for (const [type, code] of actionable) {
    // The exhausted provider class is actionable only when the enqueue site
    // established that no unused failover edge remains.
    const classified = code !== null && ["provider_exhausted", "provider_exhausted_without_declared_failover", "quota_exhausted", "payment_required"].includes(code)
      ? classifyEvent(type, code, 0)
      : classifyEvent(type, code);
    assert.equal(classified.requiresUser, true, `${type} ${code}`);
  }
  assert.equal(classifyEvent("run.attention", "open-question").next, "answer the blocking question");
  assert.equal(classifyEvent("node.terminal", "context_missing").next, "answer the blocking question");
  assert.equal(classifyEvent("campaign.attention", "provider_exhausted_without_declared_failover", 0).next, "run resume or supervise");
  assert.equal(classifyEvent("campaign.progress", null).next, "no action: pull-only progress");
});

test("raw provider-class errors before the supervisor evaluates failover routes never require the user", () => {
  for (const code of ["provider_exhausted", "provider_unavailable", "rate_limit", "quota_exhausted", "usage_limit", "payment_required", "provider_failover_cycle", "provider_failover_hop_cap"]) {
    assert.equal(classifyEvent("node.terminal", code).requiresUser, false, `${code} without a remaining-edge fact is not actionable`);
    assert.equal(classifyEvent("node.terminal", code, 1).requiresUser, false, `${code} with an unused edge is not actionable`);
    assert.equal(classifyEvent("node.terminal", code, 0).requiresUser, true, `${code} with no unused edge is actionable`);
  }
  const raw = projectEvent({
    type: "node.terminal",
    campaignId: "campaign",
    runId: "run-a",
    nodeId: "build",
    identifiers: { errorCode: "provider_exhausted" },
    data: { runId: "run-a", nodeId: "build", status: "exhausted" },
    at: at(1),
  });
  assert.equal(raw.requiresUser, false, "a raw projected provider error is not actionable");
  const settled = projectEvent({
    type: "node.terminal",
    campaignId: "campaign",
    runId: "run-a",
    nodeId: "build",
    identifiers: { errorCode: "provider_exhausted" },
    data: { runId: "run-a", nodeId: "build", status: "exhausted" },
    remainingEdges: 0,
    at: at(1),
  });
  assert.equal(settled.requiresUser, true, "provider exhaustion with zero remaining edges is actionable");
  assert.equal(classifyEvent("campaign.completed", null).requiresUser, true);
  assert.equal(classifyEvent("campaign.completed", null).next, "campaign closed");
});

test("projected records keep data bounded to 512 bytes", () => {
  const record = event("run.attention", {
    identifiers: { errorCode: "budget_attention" },
    data: { runId: "run-a", code: "budget_attention", detail: "d".repeat(2 * 1024) },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(record.data), "utf8") <= EVENT_DATA_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= EVENT_MAX_BYTES);
  validateEvent(record);
});

test("canonical JSON never exceeds 1024 bytes and summary shrinks before data", () => {
  const record = event("node.terminal", {
    runId: `run-${"a".repeat(1200)}`,
    nodeId: `build-${"b".repeat(1200)}`,
    counters: { attempt: 1, revisions: 0 },
    identifiers: { errorCode: `code-${"c".repeat(1200)}` },
    data: { runId: "run-a", nodeId: "build", status: "failed", detail: "d".repeat(2000) },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= EVENT_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(record.data), "utf8") <= EVENT_DATA_MAX_BYTES);
  validateEvent(record);
  assert.ok(record.summary.endsWith("…"), "an oversized summary is truncated with an ellipsis marker");
});

test("requiresUser flows into the projected record", () => {
  assert.equal(event("campaign.completed", { data: { runCount: 1 } }).requiresUser, true);
  assert.equal(event("node.terminal", { identifiers: { errorCode: "blocked_context" }, data: { status: "blocked" } }).requiresUser, true);
  assert.equal(event("run.attention", { identifiers: { errorCode: "budget_attention" }, data: { code: "budget_attention" } }).requiresUser, false);
  assert.equal(event("campaign.progress", { nodeId: "build", data: { status: "running" } }).requiresUser, false);
});

test("validateEvent rejects malformed and non-contract records", () => {
  assert.throws(() => validateEvent(null), /must be an object/u);
  assert.throws(() => validateEvent([]), /must be an object/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), surprise: true }), /unexpected field/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), schemaVersion: 2 }), /schemaVersion/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), type: "unknown.type" }), /event record\.type/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), requiresUser: "yes" }), /requiresUser/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), at: "yesterday" }), /at must be an ISO-8601/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), next: "invented" }), /event record\.next/u);
  assert.throws(() => validateEvent({ ...event("campaign.progress", { nodeId: "build", data: {} }), summary: "" }), /summary/u);
  assert.throws(
    () => validateEvent({ ...event("run.attention", { data: {} }), data: { blob: "b".repeat(600) } }),
    /event record\.data exceeds/u,
  );
  assert.throws(() => projectEvent({ type: "invented", campaignId: "campaign", at: at(1), data: {} }), /unknown event type/u);
  assert.throws(() => projectEvent({ type: "campaign.progress", campaignId: "", at: at(1), data: {} }), /campaignId/u);
  assert.throws(() => projectEvent({ type: "campaign.progress", campaignId: "campaign", at: "nope", data: {} }), /at must be an ISO-8601/u);
});

test("the delivery envelope never grows a persisted record past the ceiling", () => {
  // A canonical record at the ceiling plus delivery metadata: the envelope
  // yields, the record stays valid and bounding is idempotent.
  const projected = projectEvent({
    type: "run.terminal",
    campaignId: "campaign",
    runId: "r".repeat(120),
    nodeId: "n".repeat(120),
    at: at(1),
    counters: { attempt: 1, revisions: 0 },
    identifiers: { runtimeId: "t".repeat(80), errorCode: "provider_exhausted" },
    data: { detail: "d".repeat(600) },
    key: "boundary",
  });
  assert.ok(bytes(projected) > 900, `the fixture must sit near the ceiling, got ${bytes(projected)}`);

  const record = { ...projected, deliveredAt: new Date(Date.parse(at(1)) + 1000).toISOString(), attempts: 3, lastError: "E".repeat(1024), coalesceKey: "k".repeat(256) };
  const bounded = boundEventRecord(record);
  assert.ok(bytes(bounded) <= EVENT_MAX_BYTES, `bounded record is ${bytes(bounded)} bytes`);
  assert.equal(bounded.attempts, 3, "counters are never rewritten");
  assert.equal(bounded.deliveredAt, record.deliveredAt, "the delivery timestamp is never rewritten");
  assert.equal(validateEvent({
    schemaVersion: bounded.schemaVersion,
    eventId: bounded.eventId,
    type: bounded.type,
    campaignId: bounded.campaignId,
    runId: bounded.runId,
    nodeId: bounded.nodeId,
    at: bounded.at,
    summary: bounded.summary,
    next: bounded.next,
    requiresUser: bounded.requiresUser,
    data: bounded.data,
  }), true, "the canonical fields of a bounded record still validate");

  const before = JSON.stringify(bounded);
  assert.equal(JSON.stringify(boundEventRecord(bounded)), before, "bounding is idempotent");

  // A record that already fits is returned untouched.
  const small = { ...projectEvent({ type: "campaign.progress", campaignId: "campaign", nodeId: "build", at: at(1), data: {}, key: "small" }), deliveredAt: null, attempts: 0, lastError: null };
  const smallText = JSON.stringify(small);
  assert.equal(JSON.stringify(boundEventRecord(small)), smallText);
});

/** @param {unknown} value @returns {number} */
function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
