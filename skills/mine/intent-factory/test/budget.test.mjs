import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUDGET_POLICY_VERSION,
  canonicalBudgetDecision,
  deriveBudgetDecision,
  grantBudgetExtension,
  initialBudgetState,
  planBudgetContinuation,
  validateBudgetProfile,
} from "../scripts/budget.mjs";

function profile(overrides = {}) {
  return {
    estimatedWeightedInputTokens: 420_000,
    estimatedTurns: 12,
    contextWindowTokens: 1_000_000,
    safetyFraction: 0.75,
    minimumSegmentTokens: 100_000,
    growthIncrementTokens: 100_000,
    preambleBytes: 48_000,
    tokenizerEstimate: { bytes: 4, tokens: 1, source: "measured bounded preamble" },
    continuation: { enabled: true, maxSegments: 2, segmentReserveTokens: 300_000 },
    ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    packetHash: "a".repeat(64),
    packetBytes: 8_000,
    scopeHash: "b".repeat(64),
    verificationHash: "c".repeat(64),
    runtimeId: "glm",
    phaseRemainingTokens: 1_200_000,
    campaignRemainingTokens: 2_000_000,
    judgeReserveTokens: 200_000,
    pendingReserveTokens: 200_000,
    explicitHardCeilingTokens: null,
    ...overrides,
  };
}

test("budget provenance validates measured inputs and rejects unexplained shapes", () => {
  const value = validateBudgetProfile(profile());
  assert.equal(value.preambleBytes, 48_000);
  assert.deepEqual(value.tokenizerEstimate, { bytes: 4, tokens: 1, source: "measured bounded preamble" });
  assert.throws(() => validateBudgetProfile(profile({ preambleBytes: undefined })), /preambleBytes/u);
  assert.throws(() => validateBudgetProfile(profile({ tokenizerEstimate: { bytes: 4, tokens: 1 } })), /source/u);
});

test("budget deterministic D33 derives a non-literal allocation from a 1M context", () => {
  const first = deriveBudgetDecision(profile(), facts());
  const second = deriveBudgetDecision(profile(), facts());
  assert.equal(first.policyVersion, BUDGET_POLICY_VERSION);
  assert.equal(canonicalBudgetDecision(first), canonicalBudgetDecision(second));
  assert.equal(first.initialAllocationTokens, 420_000);
  assert.notEqual(first.initialAllocationTokens, 500_000);
  assert.notEqual(first.initialAllocationTokens, 1_000_000);
  assert.equal(first.inputs.packetTokens, 2_000);
  assert.equal(first.inputs.preambleTokens, 12_000);
});

test("budget reserve D34 keeps pending, judge, and continuation allowance intact", () => {
  const decision = deriveBudgetDecision(profile({ estimatedWeightedInputTokens: 500_000 }), facts({
    phaseRemainingTokens: 1_000_000,
    campaignRemainingTokens: 1_000_000,
    judgeReserveTokens: 100_000,
    pendingReserveTokens: 200_000,
  }));
  assert.equal(decision.availableTokens, 900_000);
  assert.equal(decision.initialAllocationTokens, 400_000);
  assert.equal(decision.continuationReserveTokens, 300_000);
  assert.equal(decision.hardCapTokens, 700_000);
  const extended = grantBudgetExtension(decision, initialBudgetState(decision), "progress-1");
  assert.equal(extended.grantedTokens, 0);
});

test("budget extension D34 grants unused headroom without touching reserves", () => {
  const decision = deriveBudgetDecision(profile({ estimatedWeightedInputTokens: 300_000 }), facts({
    phaseRemainingTokens: 1_000_000,
    campaignRemainingTokens: 1_000_000,
    judgeReserveTokens: 100_000,
    pendingReserveTokens: 200_000,
  }));
  assert.equal(decision.availableTokens, 900_000);
  assert.equal(decision.initialAllocationTokens, 300_000);
  assert.equal(decision.hardCapTokens, 700_000);
  assert.equal(decision.extensionAllowanceTokens, 100_000);
  const extended = grantBudgetExtension(decision, initialBudgetState(decision), "progress-signature-1");
  assert.equal(extended.grantedTokens, 100_000);
  assert.equal(extended.currentCapTokens, 400_000);
  assert.equal(extended.extensionRemainingTokens, 0);
  assert.equal(grantBudgetExtension(decision, extended, "progress-signature-1").grantedTokens, 0);
  assert.equal(grantBudgetExtension(decision, extended, "progress-signature-2").grantedTokens, 0);
  assert.equal(decision.pendingReserveTokens, 200_000);
  assert.equal(decision.judgeReserveTokens, 100_000);
  assert.equal(decision.continuationReserveTokens, 300_000);
});

test("budget continuation D35 is bounded and deterministic", () => {
  const decision = deriveBudgetDecision(profile(), facts());
  const state = initialBudgetState(decision);
  const first = planBudgetContinuation(decision, state);
  assert.ok(first);
  assert.equal(first.segment, 2);
  assert.equal(first.allocationTokens, 300_000);
  assert.deepEqual(planBudgetContinuation(decision, { ...state, pendingSegment: first }), first);
  assert.equal(planBudgetContinuation(decision, { ...state, segment: 2, activatedSegments: [1, 2] }), null);
});

test("continuation scope identities are part of the byte-stable decision", () => {
  const original = deriveBudgetDecision(profile(), facts());
  const changed = deriveBudgetDecision(profile(), facts({ scopeHash: "d".repeat(64) }));
  assert.notEqual(canonicalBudgetDecision(original), canonicalBudgetDecision(changed));
});

test("budget attention D36 rejects allocation below the declared segment floor", () => {
  const decision = deriveBudgetDecision(profile(), facts({
    phaseRemainingTokens: 550_000,
    campaignRemainingTokens: 550_000,
    judgeReserveTokens: 100_000,
    pendingReserveTokens: 100_000,
  }));
  assert.equal(decision.status, "rejected");
  assert.match(decision.rejectReason ?? "", /minimum segment/u);
});

test("budget failover boundary D37 contains no provider routing decision", () => {
  const decision = deriveBudgetDecision(profile(), facts({ runtimeId: "deepseek" }));
  assert.equal(decision.inputs.runtimeId, "deepseek");
  assert.equal(Object.hasOwn(decision, "nextRuntime"), false);
});

test("context budget distinction does not equate context capacity with cumulative allowance", () => {
  const decision = deriveBudgetDecision(profile({ estimatedWeightedInputTokens: 250_000 }), facts());
  assert.equal(decision.inputs.contextWindowTokens, 1_000_000);
  assert.equal(decision.initialAllocationTokens, 250_000);
});

test("budget replay D39 emits byte-identical canonical JSON", () => {
  const expected = canonicalBudgetDecision(deriveBudgetDecision(profile(), facts()));
  const replayed = canonicalBudgetDecision(deriveBudgetDecision(
    JSON.parse(JSON.stringify(profile())),
    JSON.parse(JSON.stringify(facts())),
  ));
  assert.equal(replayed, expected);
});

test("watchdog D38 reference pins the stale-liveness fixture to campaign-autonomy", () => {
  const source = readFileSync(new URL("./campaign-autonomy.test.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("watchdog stale liveness"));
});
