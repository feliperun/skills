import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeAssignments, nextSameTierRuntime, normalizeProviderAvailability } from "../scripts/runtime-discovery.mjs";
import { probeRuntime } from "../scripts/drivers/index.mjs";

const ready = { available: true, exhaustedUntil: null, reason: "ready" };

test("normalizes Z.ai code 1310 with its reset timestamp", () => {
  const availability = normalizeProviderAvailability("glm", JSON.stringify({
    type: "assistant",
    error: "rate_limit",
    is_api_error_message: true,
    content: "[1310] Weekly limit exhausted. Your limit will reset at 2026-09-04 21:44:15",
  }) + "\n" + JSON.stringify({
    type: "result",
    result: "quota exhausted",
    is_error: true,
    terminal_reason: "api_error",
  }), 1, null);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, "quota_exhausted");
  assert.equal(availability.exhaustedUntil, "2026-09-04T21:44:15.000Z");
});

test("normalizes Codex and Claude authentication failures", () => {
  for (const driver of ["codex", "claude"]) {
    const availability = normalizeProviderAvailability(driver, {
      status: "failed",
      error: { code: "authentication_failed", message: "invalid API key" },
    });
    assert.deepEqual(availability, { available: false, exhaustedUntil: null, reason: "authentication_failed" });
  }
});

test("normalizes Codex and Claude quota failures separately from auth", () => {
  for (const driver of ["codex", "claude"]) {
    const availability = normalizeProviderAvailability(driver, {
      status: "failed",
      error: { code: "quota_exhausted", message: "usage limit reached", resetAt: "2099-01-01T00:00:00Z" },
    });
    assert.deepEqual(availability, { available: false, exhaustedUntil: "2099-01-01T00:00:00.000Z", reason: "quota_exhausted" });
  }
});

test("an absent CLI is unavailable with a named not_found reason", async () => {
  const result = await probeRuntime({ driver: "codex", model: "m", executable: join(mkdtempSync(join(tmpdir(), "runtime-discovery-")), "missing") });
  assert.equal(result.ok, false);
  assert.equal(result.availability?.reason, "not_found");
});

test("composes the cheapest worker and strongest cross-vendor judge only for omitted roles", () => {
  const contract = {
    runtimes: {
      cheap: { vendor: "vendor-a", tier: 1, costRank: 1 },
      cheapJudge: { vendor: "vendor-b", tier: 1, costRank: 2 },
      strong: { vendor: "vendor-c", tier: 2, costRank: 3 },
    },
    runtimeDefaults: {},
    nodes: [
      { id: "composed", runtime: undefined, gate: { enabled: true, runtime: undefined } },
      { id: "explicit", runtime: "strong", gate: { enabled: true, runtime: "cheapJudge" } },
    ],
  };
  const assignments = composeAssignments(contract, { cheap: ready, cheapJudge: ready, strong: ready });
  assert.deepEqual(assignments.composed, { worker: "cheap", judge: "strong" });
  assert.deepEqual(assignments.explicit, { worker: "strong", judge: "cheapJudge" });
});

test("fails composition by name when no cross-vendor judge is available", () => {
  assert.throws(() => composeAssignments({
    runtimes: { worker: { vendor: "same", tier: 1, costRank: 1 } },
    runtimeDefaults: {},
    nodes: [{ id: "gated", gate: { enabled: true } }],
  }, { worker: ready }), /runtime_assignment_judge_unavailable/u);
});

test("same-tier re-tiering excludes exhausted and same-vendor judges", () => {
  const contract = {
    runtimes: {
      worker: { vendor: "worker-vendor", tier: 1, costRank: 1 },
      sibling: { vendor: "sibling-vendor", tier: 1, costRank: 2 },
      otherTier: { vendor: "other-vendor", tier: 2, costRank: 3 },
      sameVendor: { vendor: "worker-vendor", tier: 1, costRank: 0 },
    },
  };
  const routing = {
    assignments: { worker: "worker", judge: "otherTier", composedWorker: true, composedJudge: true },
    availability: {
      worker: { available: false, exhaustedUntil: "2099-01-01T00:00:00.000Z", reason: "quota" },
      sibling: ready,
      otherTier: ready,
      sameVendor: ready,
    },
  };
  assert.equal(nextSameTierRuntime(contract, routing, "worker", "worker", new Set(["worker"])), "sameVendor");
  assert.equal(nextSameTierRuntime(contract, routing, "judge", "otherTier", new Set(["otherTier"])), null);
});
