import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const BUDGET_POLICY_VERSION = "budget-v1";

const PROFILE_FIELDS = new Set([
  "estimatedWeightedInputTokens", "estimatedTurns", "contextWindowTokens", "safetyFraction",
  "minimumSegmentTokens", "growthIncrementTokens", "preambleBytes", "tokenizerEstimate", "continuation",
]);
const TOKENIZER_FIELDS = new Set(["bytes", "tokens", "source"]);
const CONTINUATION_FIELDS = new Set(["enabled", "maxSegments", "segmentReserveTokens"]);
const DECISION_FIELDS = new Set([
  "policyVersion", "packetHash", "scopeHash", "verificationHash", "inputs", "requestHeadroomTokens",
  "contextAllowanceTokens", "availableTokens", "pendingReserveTokens", "judgeReserveTokens",
  "continuationReserveTokens", "initialAllocationTokens", "extensionAllowanceTokens", "hardCapTokens",
  "maxSegments", "growthIncrementTokens", "minimumSegmentTokens", "status", "rejectReason",
]);
const DECISION_INPUT_FIELDS = new Set([
  "runtimeId", "packetBytes", "packetTokens", "preambleBytes", "preambleTokens", "tokenizerEstimate",
  "contextWindowTokens", "safetyFraction", "estimatedTurns", "estimatedWeightedInputTokens",
  "phaseRemainingTokens", "campaignRemainingTokens", "judgeReserveTokens", "pendingReserveTokens",
  "explicitHardCeilingTokens",
]);
const STATE_FIELDS = new Set([
  "currentCapTokens", "extensionRemainingTokens", "continuationRemainingTokens", "segment",
  "activatedSegments", "pendingSegment", "lastGrantedProgressSignature", "status",
]);
const SEGMENT_FIELDS = new Set(["id", "segment", "allocationTokens", "packetHash", "scopeHash", "verificationHash"]);

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{id: string, segment: number, allocationTokens: number, packetHash: string, scopeHash: string, verificationHash: string}} BudgetSegment */
/** @typedef {{currentCapTokens: number, extensionRemainingTokens: number, continuationRemainingTokens: number, segment: number, activatedSegments: number[], pendingSegment: BudgetSegment|null, lastGrantedProgressSignature: string|null, status: "active"|"continuing"|"attention"|"complete"}} BudgetState */

/**
 * @param {unknown} value
 * @param {string} [label]
 */
export function validateBudgetProfile(value, label = "budgetProfile") {
  object(value, label);
  exact(value, PROFILE_FIELDS, label);
  const profile = /** @type {JsonObject} */ (value);
  const estimatedWeightedInputTokens = positiveInteger(profile.estimatedWeightedInputTokens, `${label}.estimatedWeightedInputTokens`);
  const estimatedTurns = positiveInteger(profile.estimatedTurns, `${label}.estimatedTurns`);
  const contextWindowTokens = positiveInteger(profile.contextWindowTokens, `${label}.contextWindowTokens`);
  const safetyFraction = positiveNumber(profile.safetyFraction, `${label}.safetyFraction`);
  if (safetyFraction > 1) throw new TypeError(`${label}.safetyFraction cannot exceed 1`);
  const minimumSegmentTokens = positiveInteger(profile.minimumSegmentTokens, `${label}.minimumSegmentTokens`);
  const growthIncrementTokens = positiveInteger(profile.growthIncrementTokens, `${label}.growthIncrementTokens`);
  const preambleBytes = nonNegativeInteger(profile.preambleBytes, `${label}.preambleBytes`);

  object(profile.tokenizerEstimate, `${label}.tokenizerEstimate`);
  exact(profile.tokenizerEstimate, TOKENIZER_FIELDS, `${label}.tokenizerEstimate`);
  const tokenizer = /** @type {JsonObject} */ (profile.tokenizerEstimate);
  const tokenizerEstimate = {
    bytes: positiveInteger(tokenizer.bytes, `${label}.tokenizerEstimate.bytes`),
    tokens: positiveInteger(tokenizer.tokens, `${label}.tokenizerEstimate.tokens`),
    source: boundedString(tokenizer.source, `${label}.tokenizerEstimate.source`, 512),
  };

  object(profile.continuation, `${label}.continuation`);
  exact(profile.continuation, CONTINUATION_FIELDS, `${label}.continuation`);
  const continuationValue = /** @type {JsonObject} */ (profile.continuation);
  if (typeof continuationValue.enabled !== "boolean") throw new TypeError(`${label}.continuation.enabled must be boolean`);
  const continuation = {
    enabled: continuationValue.enabled,
    maxSegments: positiveInteger(continuationValue.maxSegments, `${label}.continuation.maxSegments`),
    segmentReserveTokens: nonNegativeInteger(continuationValue.segmentReserveTokens, `${label}.continuation.segmentReserveTokens`),
  };
  if (!continuation.enabled && (continuation.maxSegments !== 1 || continuation.segmentReserveTokens !== 0)) {
    throw new TypeError(`${label}.continuation disabled shape requires maxSegments 1 and segmentReserveTokens 0`);
  }
  if (continuation.enabled) {
    if (continuation.maxSegments < 2) throw new TypeError(`${label}.continuation.maxSegments must be at least 2 when enabled`);
    if (continuation.segmentReserveTokens < minimumSegmentTokens * (continuation.maxSegments - 1)) {
      throw new TypeError(`${label}.continuation.segmentReserveTokens cannot fund every minimum segment`);
    }
  }
  return {
    estimatedWeightedInputTokens,
    estimatedTurns,
    contextWindowTokens,
    safetyFraction,
    minimumSegmentTokens,
    growthIncrementTokens,
    preambleBytes,
    tokenizerEstimate,
    continuation,
  };
}

/**
 * @param {ReturnType<typeof validateBudgetProfile>|unknown} rawProfile
 * @param {JsonObject} rawFacts
 */
export function deriveBudgetDecision(rawProfile, rawFacts) {
  const profile = validateBudgetProfile(rawProfile);
  const facts = validateFacts(rawFacts);
  const packetTokens = estimatedTokens(facts.packetBytes, profile.tokenizerEstimate);
  const preambleTokens = estimatedTokens(profile.preambleBytes, profile.tokenizerEstimate);
  const requestHeadroomTokens = Math.max(0, Math.floor(
    (profile.contextWindowTokens - packetTokens - preambleTokens) * profile.safetyFraction,
  ));
  const contextAllowanceTokens = safeProduct(requestHeadroomTokens, profile.estimatedTurns, "context allowance");
  const campaignWorkerRemaining = Math.max(0, facts.campaignRemainingTokens - facts.judgeReserveTokens);
  const availableTokens = Math.max(0, Math.min(facts.phaseRemainingTokens, campaignWorkerRemaining));
  const continuationReserveTokens = profile.continuation.enabled ? profile.continuation.segmentReserveTokens : 0;
  const unreserved = Math.max(0, availableTokens - facts.pendingReserveTokens - continuationReserveTokens);
  const initialAllocationTokens = Math.max(0, Math.min(
    profile.estimatedWeightedInputTokens,
    contextAllowanceTokens,
    unreserved,
  ));
  const derivedHardCap = Math.max(0, Math.min(
    contextAllowanceTokens,
    availableTokens - facts.pendingReserveTokens,
  ));
  const explicitHardCeilingTokens = facts.explicitHardCeilingTokens;
  const hardCapTokens = Math.min(derivedHardCap, explicitHardCeilingTokens ?? derivedHardCap);
  let rejectReason = null;
  if (initialAllocationTokens < profile.minimumSegmentTokens) {
    rejectReason = `derived allocation ${initialAllocationTokens} is below minimum segment ${profile.minimumSegmentTokens}`;
  } else if (hardCapTokens < initialAllocationTokens + continuationReserveTokens) {
    rejectReason = `explicit hard ceiling cannot preserve the declared continuation reserve`;
  }
  const extensionAllowanceTokens = rejectReason
    ? 0
    : Math.max(0, hardCapTokens - initialAllocationTokens - continuationReserveTokens);
  return {
    policyVersion: BUDGET_POLICY_VERSION,
    packetHash: facts.packetHash,
    scopeHash: facts.scopeHash,
    verificationHash: facts.verificationHash,
    inputs: {
      runtimeId: facts.runtimeId,
      packetBytes: facts.packetBytes,
      packetTokens,
      preambleBytes: profile.preambleBytes,
      preambleTokens,
      tokenizerEstimate: profile.tokenizerEstimate,
      contextWindowTokens: profile.contextWindowTokens,
      safetyFraction: profile.safetyFraction,
      estimatedTurns: profile.estimatedTurns,
      estimatedWeightedInputTokens: profile.estimatedWeightedInputTokens,
      phaseRemainingTokens: facts.phaseRemainingTokens,
      campaignRemainingTokens: facts.campaignRemainingTokens,
      judgeReserveTokens: facts.judgeReserveTokens,
      pendingReserveTokens: facts.pendingReserveTokens,
      explicitHardCeilingTokens,
    },
    requestHeadroomTokens,
    contextAllowanceTokens,
    availableTokens,
    pendingReserveTokens: facts.pendingReserveTokens,
    judgeReserveTokens: facts.judgeReserveTokens,
    continuationReserveTokens,
    initialAllocationTokens,
    extensionAllowanceTokens,
    hardCapTokens,
    maxSegments: profile.continuation.maxSegments,
    growthIncrementTokens: profile.growthIncrementTokens,
    minimumSegmentTokens: profile.minimumSegmentTokens,
    status: rejectReason ? "rejected" : "allocated",
    rejectReason,
  };
}

/** @param {ReturnType<typeof deriveBudgetDecision>} decision @returns {string} */
export function canonicalBudgetDecision(decision) {
  return canonicalJson(decision);
}

/** @param {unknown} value @param {string} [label] */
export function validateBudgetDecision(value, label = "budgetDecision") {
  object(value, label);
  exact(value, DECISION_FIELDS, label);
  const decision = /** @type {JsonObject} */ (value);
  if (decision.policyVersion !== BUDGET_POLICY_VERSION) throw new TypeError(`${label}.policyVersion must be ${BUDGET_POLICY_VERSION}`);
  for (const key of ["packetHash", "scopeHash", "verificationHash"]) hash(decision[key], `${label}.${key}`);
  object(decision.inputs, `${label}.inputs`);
  exact(decision.inputs, DECISION_INPUT_FIELDS, `${label}.inputs`);
  const inputs = /** @type {JsonObject} */ (decision.inputs);
  boundedString(inputs.runtimeId, `${label}.inputs.runtimeId`, 128);
  for (const key of ["packetBytes", "packetTokens", "preambleBytes", "preambleTokens", "contextWindowTokens", "estimatedTurns", "estimatedWeightedInputTokens", "phaseRemainingTokens", "campaignRemainingTokens", "judgeReserveTokens", "pendingReserveTokens"]) {
    nonNegativeInteger(inputs[key], `${label}.inputs.${key}`);
  }
  positiveNumber(inputs.safetyFraction, `${label}.inputs.safetyFraction`);
  object(inputs.tokenizerEstimate, `${label}.inputs.tokenizerEstimate`);
  exact(inputs.tokenizerEstimate, TOKENIZER_FIELDS, `${label}.inputs.tokenizerEstimate`);
  if (inputs.explicitHardCeilingTokens !== null) positiveInteger(inputs.explicitHardCeilingTokens, `${label}.inputs.explicitHardCeilingTokens`);
  for (const key of ["requestHeadroomTokens", "contextAllowanceTokens", "availableTokens", "pendingReserveTokens", "judgeReserveTokens", "continuationReserveTokens", "initialAllocationTokens", "extensionAllowanceTokens", "hardCapTokens"]) {
    nonNegativeInteger(decision[key], `${label}.${key}`);
  }
  for (const key of ["maxSegments", "growthIncrementTokens", "minimumSegmentTokens"]) positiveInteger(decision[key], `${label}.${key}`);
  if (decision.status !== "allocated" && decision.status !== "rejected") throw new TypeError(`${label}.status is invalid`);
  if (decision.rejectReason !== null) boundedString(decision.rejectReason, `${label}.rejectReason`, 1024);
  if ((decision.status === "rejected") !== (decision.rejectReason !== null)) throw new TypeError(`${label}.status and rejectReason are inconsistent`);
  return /** @type {ReturnType<typeof deriveBudgetDecision>} */ (value);
}

/** @param {ReturnType<typeof deriveBudgetDecision>} decision @returns {BudgetState} */
export function initialBudgetState(decision) {
  return {
    currentCapTokens: decision.initialAllocationTokens,
    extensionRemainingTokens: decision.extensionAllowanceTokens,
    continuationRemainingTokens: decision.continuationReserveTokens,
    segment: 1,
    activatedSegments: [1],
    pendingSegment: null,
    lastGrantedProgressSignature: null,
    status: decision.status === "allocated" ? "active" : "attention",
  };
}

/** @param {unknown} value @param {string} [label] @returns {BudgetState} */
export function validateBudgetState(value, label = "budgetState") {
  object(value, label);
  exact(value, STATE_FIELDS, label);
  const state = /** @type {JsonObject} */ (value);
  for (const key of ["currentCapTokens", "extensionRemainingTokens", "continuationRemainingTokens"]) nonNegativeInteger(state[key], `${label}.${key}`);
  positiveInteger(state.segment, `${label}.segment`);
  if (!Array.isArray(state.activatedSegments) || state.activatedSegments.length === 0 || state.activatedSegments.some((item) => !Number.isSafeInteger(item) || item <= 0)) {
    throw new TypeError(`${label}.activatedSegments must contain positive integers`);
  }
  if (state.pendingSegment !== null) validatePendingSegment(state.pendingSegment, `${label}.pendingSegment`);
  if (state.lastGrantedProgressSignature !== null) boundedString(state.lastGrantedProgressSignature, `${label}.lastGrantedProgressSignature`, 256);
  if (!["active", "continuing", "attention", "complete"].includes(/** @type {string} */ (state.status))) throw new TypeError(`${label}.status is invalid`);
  return /** @type {BudgetState} */ (value);
}

/** @param {unknown} value @param {string} label */
function validatePendingSegment(value, label) {
  object(value, label);
  exact(value, SEGMENT_FIELDS, label);
  const segment = /** @type {JsonObject} */ (value);
  boundedString(segment.id, `${label}.id`, 256);
  positiveInteger(segment.segment, `${label}.segment`);
  positiveInteger(segment.allocationTokens, `${label}.allocationTokens`);
  for (const key of ["packetHash", "scopeHash", "verificationHash"]) hash(segment[key], `${label}.${key}`);
}

/**
 * @param {ReturnType<typeof deriveBudgetDecision>} decision
 * @param {BudgetState} state
 * @param {string|null|undefined} progressSignature
 * @returns {BudgetState & {grantedTokens: number}}
 */
export function grantBudgetExtension(decision, state, progressSignature) {
  const remaining = nonNegativeInteger(state.extensionRemainingTokens, "budgetState.extensionRemainingTokens");
  const current = nonNegativeInteger(state.currentCapTokens, "budgetState.currentCapTokens");
  if (!progressSignature || progressSignature === state.lastGrantedProgressSignature || remaining === 0) {
    return { ...state, grantedTokens: 0 };
  }
  const grantedTokens = Math.min(decision.growthIncrementTokens, remaining);
  return {
    ...state,
    currentCapTokens: current + grantedTokens,
    extensionRemainingTokens: remaining - grantedTokens,
    lastGrantedProgressSignature: progressSignature,
    grantedTokens,
  };
}

/**
 * @param {ReturnType<typeof deriveBudgetDecision>} decision
 * @param {BudgetState} state
 * @returns {BudgetSegment|null}
 */
export function planBudgetContinuation(decision, state) {
  if (state.pendingSegment && typeof state.pendingSegment === "object") return state.pendingSegment;
  const segment = positiveInteger(state.segment, "budgetState.segment");
  const remaining = nonNegativeInteger(state.continuationRemainingTokens, "budgetState.continuationRemainingTokens");
  if (remaining === 0 || segment >= decision.maxSegments) return null;
  const remainingSegments = decision.maxSegments - segment;
  const allocationTokens = Math.floor(remaining / remainingSegments);
  if (allocationTokens < decision.minimumSegmentTokens) return null;
  return {
    id: `${decision.packetHash}:${segment + 1}`,
    segment: segment + 1,
    allocationTokens,
    packetHash: decision.packetHash,
    scopeHash: decision.scopeHash,
    verificationHash: decision.verificationHash,
  };
}

/** @param {unknown} value */
export function canonicalBudgetHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** @param {number} bytes @param {{bytes: number, tokens: number}} estimate */
function estimatedTokens(bytes, estimate) {
  return Math.ceil(bytes * estimate.tokens / estimate.bytes);
}

/** @param {JsonObject} facts */
function validateFacts(facts) {
  object(facts, "budget facts");
  for (const key of ["packetHash", "scopeHash", "verificationHash"]) hash(facts[key], `budget facts.${key}`);
  const explicit = facts.explicitHardCeilingTokens === null || facts.explicitHardCeilingTokens === undefined
    ? null
    : positiveInteger(facts.explicitHardCeilingTokens, "budget facts.explicitHardCeilingTokens");
  return {
    packetHash: /** @type {string} */ (facts.packetHash),
    scopeHash: /** @type {string} */ (facts.scopeHash),
    verificationHash: /** @type {string} */ (facts.verificationHash),
    runtimeId: boundedString(facts.runtimeId, "budget facts.runtimeId", 128),
    packetBytes: nonNegativeInteger(facts.packetBytes, "budget facts.packetBytes"),
    phaseRemainingTokens: nonNegativeInteger(facts.phaseRemainingTokens, "budget facts.phaseRemainingTokens"),
    campaignRemainingTokens: nonNegativeInteger(facts.campaignRemainingTokens, "budget facts.campaignRemainingTokens"),
    judgeReserveTokens: nonNegativeInteger(facts.judgeReserveTokens, "budget facts.judgeReserveTokens"),
    pendingReserveTokens: nonNegativeInteger(facts.pendingReserveTokens, "budget facts.pendingReserveTokens"),
    explicitHardCeilingTokens: explicit,
  };
}

/** @param {unknown} value @param {string} label */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

/** @param {unknown} value @param {Set<string>} fields @param {string} label */
function exact(value, fields, label) {
  for (const key of Object.keys(/** @type {JsonObject} */ (value))) if (!fields.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  for (const key of fields) if (!Object.hasOwn(/** @type {JsonObject} */ (value), key)) throw new TypeError(`${label}.${key} is required`);
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive number`);
  return value;
}

/** @param {unknown} value @param {string} label @param {number} max */
function boundedString(value, label, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > max) throw new TypeError(`${label} exceeds ${max} bytes`);
  return value;
}

/** @param {unknown} value @param {string} label */
function hash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`);
}

/** @param {number} left @param {number} right @param {string} label */
function safeProduct(left, right, label) {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer range`);
  return result;
}

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {JsonObject} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
