/**
 * Everything the controller persists and reads back: run metadata, a node
 * snapshot, a transition event, and the nested records inside them (invocations,
 * gate results, routing, worktree, scope, usage).
 *
 * Validated on the way in *and* on the way out. A snapshot written by an earlier
 * controller version, or hand-edited between runs, is refused by name rather
 * than half-understood -- the whole point of a resumable run is that what is on
 * disk is trustworthy or loudly not.
 */
import { Buffer } from "node:buffer";
import { MAX_SCOPE_FINDING_PATHS } from "./scope-findings.mjs";
import { REVIEW_MODES } from "./review-modes.mjs";
import { assertObject, boundedString, nonNegativeInteger, nonNegativeNumber, positiveInteger, positiveNumber, rejectUnknown, requireId, requireInteger, requirePacketHash, requireString, requireTimestamp } from "./assert.mjs";
import { errorCode, stableJson } from "../util.mjs";
import { isAbsolute } from "node:path";
import { validateCompleteSourceIdentity, validateSourceIdentity } from "./source-identity.mjs";
import { validateMetadata } from "./schema-version.mjs";
import { validateSnapshotRuntime } from "./runtime.mjs";
import { validateVerificationSnapshot } from "./final-verification.mjs";
import { validateWorkerResult } from "./worker-result.mjs";

/** @typedef {import("./index.mjs").EventRecord} EventRecord */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./index.mjs").RunMetadata} RunMetadata */
/** @typedef {import("./index.mjs").ValidatedNode} ValidatedNode */

const GATE_VERDICTS = new Set(["pass", "fail", "invalid_judge_output"]);
const NODE_STATUSES = new Set(["pending", "running", "done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled"]);
const NODE_PHASES = new Set(["waiting", "worker", "judge", "complete", "dependency", "canceled"]);
const GATE_RESULT_FIELDS = new Set(["verdict", "maxSeverity", "summary", "findings"]);
const FINDING_FIELDS = new Set(["severity", "description", "evidence"]);
const ERROR_FIELDS = new Set(["code", "message", "exhaustedUntil"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "cacheReadInputTokens"]);
const MAX_ROUTING_HISTORY = 64;
/**
 * @param {JsonObject} value
 * @param {{requireSourceIdentity?: boolean}} options
 * @returns {RunMetadata}
 */
export function validateRunMetadata(value, options = {}) {
  assertObject(value, "run metadata");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "pid", "processStartToken", "startedAt", "sourceIdentity",
    "identityWarnings", "integrationRef",
  ]), "run metadata");
  validateMetadata(value, "run metadata");
  requireInteger(value.pid, "run metadata.pid");
  if (value.processStartToken !== undefined && value.processStartToken !== null) requireString(value.processStartToken, "run metadata.processStartToken");
  requireString(value.startedAt, "run metadata.startedAt");
  if (value.integrationRef !== undefined) requireString(value.integrationRef, "run metadata.integrationRef");
  validateSourceIdentity(value.sourceIdentity, "run metadata.sourceIdentity", { kind: "run" });
  if (value.identityWarnings !== undefined) {
    if (!Array.isArray(value.identityWarnings) || value.identityWarnings.length > 8) {
      throw new TypeError("run metadata.identityWarnings must be an array of at most 8 strings");
    }
    for (const [index, warning] of value.identityWarnings.entries()) {
      if (typeof warning !== "string" || !warning.trim() || Buffer.byteLength(warning, "utf8") > 1024) {
        throw new TypeError(`run metadata.identityWarnings[${index}] must be a string of at most 1024 bytes`);
      }
    }
  }
  if (options.requireSourceIdentity) validateCompleteSourceIdentity(/** @type {JsonObject} */ (value.sourceIdentity));
  return /** @type {RunMetadata} */ (value);
}
/**
 * @param {JsonObject} value
 * @param {ValidatedNode|null} expectedNode
 * @returns {NodeSnapshot}
 */
export function validateNodeSnapshot(value, expectedNode = null) {
  assertObject(value, "node snapshot");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "id", "type", "sourceIdentity", "packetHash", "status", "phase",
    "attempt", "revisions", "judgeFailures", "runtime", "blockedBy", "startedAt", "updatedAt", "result", "gate", "error", "usage",
    "costUsd", "routing", "progress", "worktree", "invocations", "executionOverrides", "verification", "scope",
    "scopeFindings", "review", "previousAttempt", "integratedHead",
  ]), "node snapshot");
  validateMetadata(value, "node snapshot");
  requireId(value.id, "node snapshot.id");
  requireString(value.type, "node snapshot.type");
  if (!NODE_STATUSES.has(/** @type {string} */ (value.status))) throw new TypeError("node snapshot.status is invalid");
  if (!NODE_PHASES.has(/** @type {string} */ (value.phase))) throw new TypeError("node snapshot.phase is invalid");
  nonNegativeInteger(value.attempt, "node snapshot.attempt");
  nonNegativeInteger(value.revisions, "node snapshot.revisions");
  if (value.judgeFailures !== undefined) nonNegativeInteger(value.judgeFailures, "node snapshot.judgeFailures");
  // The review mode that governed the attempt's gate, recorded so a status
  // surface can tell an advisory finding from a below-threshold blocking one.
  if (value.review !== undefined && !REVIEW_MODES.has(/** @type {string} */ (value.review))) {
    throw new TypeError("node snapshot.review is invalid");
  }
  requirePacketHash(value.packetHash, "node snapshot.packetHash");
  validateSourceIdentity(value.sourceIdentity, "node snapshot.sourceIdentity", { kind: "node" });
  if (value.integratedHead !== undefined && value.integratedHead !== null) boundedString(value.integratedHead, "node snapshot.integratedHead", 256);
  const sourceIdentity = /** @type {JsonObject} */ (value.sourceIdentity);
  requireId(sourceIdentity.contractId, "node snapshot.sourceIdentity.contractId");
  requireId(sourceIdentity.nodeId, "node snapshot.sourceIdentity.nodeId");
  validateSnapshotRuntime(value.runtime, "node snapshot.runtime");
  if (!Array.isArray(value.blockedBy) || (/** @type {unknown[]} */ (value.blockedBy)).some((id) => {
    requireId(id, "node snapshot.blockedBy item");
    return false;
  })) {
    throw new TypeError("node snapshot.blockedBy must be an array of ids");
  }
  if (value.startedAt !== null) requireTimestamp(value.startedAt, "node snapshot.startedAt");
  requireTimestamp(value.updatedAt, "node snapshot.updatedAt");
  if (value.result !== null) {
    validateWorkerResult(/** @type {Record<string, unknown>} */ (value.result));
  }
  validateGateResult(value.gate, "node snapshot.gate");
  validateSnapshotError(value.error, "node snapshot.error");
  if (value.usage !== undefined) validateUsage(value.usage, "node snapshot.usage");
  if (value.costUsd !== undefined) nonNegativeNumber(value.costUsd, "node snapshot.costUsd");
  if (value.routing !== undefined && value.routing !== null) validateRoutingState(value.routing, "node snapshot.routing");
  if (value.progress !== undefined && value.progress !== null) validateProgressState(value.progress, "node snapshot.progress");
  if (value.worktree !== undefined && value.worktree !== null) validateWorktreeState(value.worktree, "node snapshot.worktree");
  if (value.invocations !== undefined) validateInvocations(value.invocations, "node snapshot.invocations");
  if (value.executionOverrides !== undefined) validateExecutionOverrides(value.executionOverrides, "node snapshot.executionOverrides");
  if (value.verification !== undefined && value.verification !== null) validateVerificationSnapshot(value.verification);
  if (value.scope !== undefined && value.scope !== null) validateScopeSnapshot(value.scope);
  if (value.scopeFindings !== undefined && value.scopeFindings !== null) validateScopeFindings(value.scopeFindings);
  // The bounded `Previous attempt` section a retry in place attaches to the
  // re-dispatched attempt's worker and judge prompts (retry.mjs renders it).
  if (value.previousAttempt !== undefined) {
    if (typeof value.previousAttempt !== "string" || !value.previousAttempt.trim()) {
      throw new TypeError("node snapshot.previousAttempt must be a non-empty string");
    }
    if (Buffer.byteLength(value.previousAttempt, "utf8") > 8 * 1024) throw new TypeError("node snapshot.previousAttempt exceeds 8192 bytes");
  }
  if (expectedNode) validateSnapshotBinding(value, expectedNode);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 128 * 1024) throw new TypeError("node snapshot exceeds 131072 bytes");
  return /** @type {NodeSnapshot} */ (value);
}
/**
 * @param {JsonObject} value
 * @returns {EventRecord}
 */
export function validateEvent(value) {
  assertObject(value, "event");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "at", "node", "from", "to", "type", "phase", "attempt", "runtime",
    "role", "status", "currentRuntime", "errorCode", "error", "verdict", "summary", "revisions", "sourceIdentity", "packetHash", "override", "recovery", "invocationId", "unexpectedPaths", "unexpectedPathCount",
  ]), "event");
  validateMetadata(value, "event");
  requireString(value.at, "event.at");
  requireId(value.node, "event.node");
  requireString(value.to, "event.to");
  if (value.type !== undefined) boundedString(value.type, "event.type", 128);
  if (value.role !== undefined && value.role !== "worker" && value.role !== "judge") throw new TypeError("event.role is invalid");
  if (value.status !== undefined && !NODE_STATUSES.has(/** @type {string} */ (value.status))) throw new TypeError("event.status is invalid");
  if (value.runtime !== undefined) requireId(value.runtime, "event.runtime");
  if (value.currentRuntime !== undefined) requireId(value.currentRuntime, "event.currentRuntime");
  if (value.errorCode !== undefined) boundedString(value.errorCode, "event.errorCode", 256);
  requireString(value.packetHash, "event.packetHash");
  validateSourceIdentity(value.sourceIdentity, "event.sourceIdentity");
  if (value.summary !== undefined && Buffer.byteLength(/** @type {string} */ (value.summary), "utf8") > 4 * 1024) {
    throw new TypeError("event.summary exceeds 4096 bytes");
  }
  if (value.unexpectedPaths !== undefined) {
    const unexpectedPaths = /** @type {unknown[]} */ (value.unexpectedPaths);
    if (!Array.isArray(value.unexpectedPaths) || unexpectedPaths.length > 64 || unexpectedPaths.some((path) => typeof path !== "string")) {
      throw new TypeError("event unexpected paths are invalid");
    }
  }
  if (value.unexpectedPathCount !== undefined) nonNegativeInteger(value.unexpectedPathCount, "event.unexpectedPathCount");
  return /** @type {EventRecord} */ (value);
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateInvocations(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const invocations = /** @type {JsonObject[]} */ (value);
  for (const [index, invocation] of invocations.entries()) {
    assertObject(invocation, `${label}[${index}]`);
    const allowed = new Set([
      "id", "pid", "processGroupId", "processStartToken", "harness", "runtimeId", "phase",
      "promptPath", "stdoutPath", "stderrPath", "startedAt", "updatedAt", "closedAt", "deadlineAt",
      "exitCode", "signal", "status", "executable", "usage", "usageEstimated", "costUsd", "snapshotPath", "revision",
      "runId", "campaignId", "planPhase", "role", "runtimeFingerprint", "model", "reasoning", "sandbox", "continuationId", "continuationMode",
      "nodeId", "attempt", "workspace", "worktreeBranch", "worktreeBaseSha",
    ]);
    rejectUnknown(invocation, allowed, `${label}[${index}]`);
    requireString(invocation.id, `${label}[${index}].id`);
    requireInteger(invocation.pid, `${label}[${index}].pid`);
    if (invocation.processGroupId !== null) requireInteger(invocation.processGroupId, `${label}[${index}].processGroupId`);
    if (invocation.processStartToken !== null) requireString(invocation.processStartToken, `${label}[${index}].processStartToken`);
    requireString(invocation.harness, `${label}[${index}].harness`);
    requireString(invocation.phase, `${label}[${index}].phase`);
    requireId(invocation.runId, `${label}[${index}].runId`);
    requireId(invocation.campaignId, `${label}[${index}].campaignId`);
    if (invocation.nodeId !== undefined) requireId(invocation.nodeId, `${label}[${index}].nodeId`);
    if (invocation.attempt !== undefined) nonNegativeInteger(invocation.attempt, `${label}[${index}].attempt`);
    if (invocation.workspace !== undefined) boundedString(invocation.workspace, `${label}[${index}].workspace`, 4096);
    if (invocation.worktreeBranch !== undefined && invocation.worktreeBranch !== null) boundedString(invocation.worktreeBranch, `${label}[${index}].worktreeBranch`, 512);
    if (invocation.worktreeBaseSha !== undefined && invocation.worktreeBaseSha !== null) boundedString(invocation.worktreeBaseSha, `${label}[${index}].worktreeBaseSha`, 256);
    boundedString(invocation.planPhase, `${label}[${index}].planPhase`, 128);
    if (invocation.role !== "worker" && invocation.role !== "judge") throw new TypeError(`${label}[${index}].role is invalid`);
    boundedString(invocation.runtimeFingerprint, `${label}[${index}].runtimeFingerprint`, 128);
    requireString(invocation.model, `${label}[${index}].model`);
    if (invocation.reasoning !== null) requireString(invocation.reasoning, `${label}[${index}].reasoning`);
    if (invocation.sandbox !== null) requireString(invocation.sandbox, `${label}[${index}].sandbox`);
    if (invocation.continuationId !== null) boundedString(invocation.continuationId, `${label}[${index}].continuationId`, 512);
    if (!['fresh', 'reuse', 'rotate'].includes(/** @type {string} */ (invocation.continuationMode))) {
      throw new TypeError(`${label}[${index}].continuationMode is invalid`);
    }
    if (invocation.revision !== undefined) nonNegativeInteger(invocation.revision, `${label}[${index}].revision`);
    for (const key of ["promptPath", "stdoutPath", "stderrPath", "executable"]) {
      if (invocation[key] !== null) requireString(invocation[key], `${label}[${index}].${key}`);
    }
    if (invocation.snapshotPath !== undefined) requireString(invocation.snapshotPath, `${label}[${index}].snapshotPath`);
    for (const key of ["startedAt", "updatedAt", "deadlineAt"]) requireTimestamp(invocation[key], `${label}[${index}].${key}`);
    if (invocation.closedAt !== null) requireTimestamp(invocation.closedAt, `${label}[${index}].closedAt`);
    if (!Number.isInteger(invocation.exitCode) && invocation.exitCode !== null) throw new TypeError(`${label}[${index}].exitCode must be an integer or null`);
    if (invocation.signal !== null) requireString(invocation.signal, `${label}[${index}].signal`);
    if (! ["active", "closed", "terminated"].includes(/** @type {string} */ (invocation.status))) throw new TypeError(`${label}[${index}].status is invalid`);
    if (invocation.usage !== undefined) validateInvocationUsage(invocation.usage, `${label}[${index}].usage`);
    if (invocation.usageEstimated !== undefined && typeof invocation.usageEstimated !== "boolean") {
      throw new TypeError(`${label}[${index}].usageEstimated must be a boolean`);
    }
    if (invocation.costUsd !== undefined && invocation.costUsd !== null) nonNegativeNumber(invocation.costUsd, `${label}[${index}].costUsd`);
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateInvocationUsage(value, label) {
  assertObject(value, label);
  rejectUnknown(value, USAGE_FIELDS, label);
  for (const key of USAGE_FIELDS) {
    if (value[key] !== null) nonNegativeInteger(value[key], `${label}.${key}`);
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateExecutionOverrides(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const overrides = /** @type {JsonObject[]} */ (value);
  for (const [index, override] of overrides.entries()) {
    assertObject(override, `${label}[${index}]`);
    rejectUnknown(override, new Set(["kind", "at", "reason", "timeoutSec", "decision", "invocationId", "phase", "result", "usage", "costUsd"]), `${label}[${index}]`);
    requireString(override.kind, `${label}[${index}].kind`);
    requireTimestamp(override.at, `${label}[${index}].at`);
    requireString(override.reason, `${label}[${index}].reason`);
    if (override.timeoutSec !== undefined) positiveNumber(override.timeoutSec, `${label}[${index}].timeoutSec`);
    if (override.decision !== undefined) requireString(override.decision, `${label}[${index}].decision`);
    if (override.invocationId !== undefined) requireString(override.invocationId, `${label}[${index}].invocationId`);
    if (override.phase !== undefined) requireString(override.phase, `${label}[${index}].phase`);
    if (override.result !== undefined && override.result !== null) requireString(override.result, `${label}[${index}].result`);
    if (override.usage !== undefined) validateInvocationUsage(override.usage, `${label}[${index}].usage`);
    if (override.costUsd !== undefined && override.costUsd !== null) nonNegativeNumber(override.costUsd, `${label}[${index}].costUsd`);
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateGateResult(value, label) {
  if (value === null) return;
  assertObject(value, label);
  rejectUnknown(value, GATE_RESULT_FIELDS, label);
  const verdict = value.verdict;
  const maxSeverity = value.maxSeverity;
  if (!GATE_VERDICTS.has(/** @type {string} */ (verdict))) throw new TypeError(`${label}.verdict is invalid`);
  if (!["none", "minor", "major", "critical"].includes(/** @type {string} */ (maxSeverity))) {
    throw new TypeError(`${label}.maxSeverity is invalid`);
  }
  // An invalid verdict is the record that the judge produced nothing usable:
  // it carries no finding the node could be rejected with.
  if (verdict === "invalid_judge_output" && (maxSeverity !== "none" || /** @type {unknown[]} */ (value.findings).length > 0)) {
    throw new TypeError(`${label} with verdict invalid_judge_output records no findings`);
  }
  if (typeof value.summary !== "string") throw new TypeError(`${label}.summary must be a string`);
  if (Buffer.byteLength(value.summary, "utf8") > 4 * 1024) throw new TypeError(`${label}.summary exceeds 4096 bytes`);
  if (!Array.isArray(value.findings)) throw new TypeError(`${label}.findings must be an array`);
  if (value.findings.length > 32) throw new TypeError(`${label}.findings must have at most 32 items`);
  const rank = { none: 0, minor: 1, major: 2, critical: 3 };
  let actualMax = "none";
  const findings = /** @type {JsonObject[]} */ (value.findings);
  for (const [index, finding] of findings.entries()) {
    assertObject(finding, `${label}.findings[${index}]`);
    rejectUnknown(finding, FINDING_FIELDS, `${label}.findings[${index}]`);
    const severity = finding.severity;
    if (typeof severity !== "string" || !["minor", "major", "critical"].includes(severity)) {
      throw new TypeError(`${label}.findings[${index}].severity is invalid`);
    }
    if (typeof finding.description !== "string") {
      throw new TypeError(`${label}.findings[${index}].description must be a string`);
    }
    if (typeof finding.evidence !== "string") {
      throw new TypeError(`${label}.findings[${index}].evidence must be a string`);
    }
    if (Buffer.byteLength(finding.description, "utf8") > 2 * 1024 || Buffer.byteLength(finding.evidence, "utf8") > 4 * 1024) {
      throw new TypeError(`${label}.findings[${index}] exceeds evidence limits`);
    }
    const severityKey = /** @type {"minor"|"major"|"critical"} */ (severity);
    if (rank[severityKey] > rank[/** @type {keyof typeof rank} */ (actualMax)]) actualMax = severityKey;
  }
  if (actualMax !== maxSeverity) throw new TypeError(`${label}.maxSeverity does not match findings`);
  // An invalid verdict is not a pass, yet it records no severity either: only a
  // real arbitrated verdict is held to the pass/none pairing.
  if (verdict !== "invalid_judge_output" && (verdict === "pass") !== (maxSeverity === "none")) {
    throw new TypeError(`${label}.verdict and maxSeverity are inconsistent`);
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateSnapshotError(value, label) {
  if (value === null) return;
  assertObject(value, label);
  rejectUnknown(value, ERROR_FIELDS, label);
  requireString(value.code, `${label}.code`);
  requireString(value.message, `${label}.message`);
  if (value.exhaustedUntil !== undefined && value.exhaustedUntil !== null) requireTimestamp(value.exhaustedUntil, `${label}.exhaustedUntil`);
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateUsage(value, label) {
  assertObject(value, label);
  rejectUnknown(value, USAGE_FIELDS, label);
  for (const key of USAGE_FIELDS) nonNegativeInteger(value[key], `${label}.${key}`);
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateRoutingState(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["history", "currentOverride", "assignments", "availability"]), label);
  if (!Array.isArray(value.history) || value.history.length > MAX_ROUTING_HISTORY) {
    throw new TypeError(`${label}.history must be an array with at most ${MAX_ROUTING_HISTORY} items`);
  }
  for (const [index, entry] of value.history.entries()) {
    validateRoutingEntry(entry, `${label}.history[${index}]`, false);
  }
  if (value.currentOverride !== null) validateRoutingEntry(value.currentOverride, `${label}.currentOverride`, true);
  if (value.assignments !== undefined) {
    assertObject(value.assignments, `${label}.assignments`);
    rejectUnknown(value.assignments, new Set(["worker", "judge", "composedWorker", "composedJudge"]), `${label}.assignments`);
    requireId(value.assignments.worker, `${label}.assignments.worker`);
    requireId(value.assignments.judge, `${label}.assignments.judge`);
    for (const key of ["composedWorker", "composedJudge"]) {
      if (value.assignments[key] !== undefined && typeof value.assignments[key] !== "boolean") throw new TypeError(`${label}.assignments.${key} must be boolean`);
    }
  }
  if (value.availability !== undefined) {
    assertObject(value.availability, `${label}.availability`);
    for (const [id, availability] of Object.entries(value.availability)) {
      requireId(id, `${label}.availability runtime`);
      assertObject(availability, `${label}.availability.${id}`);
      rejectUnknown(availability, new Set(["available", "exhaustedUntil", "reason"]), `${label}.availability.${id}`);
      if (typeof availability.available !== "boolean") throw new TypeError(`${label}.availability.${id}.available must be boolean`);
      if (availability.exhaustedUntil !== undefined && availability.exhaustedUntil !== null) requireTimestamp(availability.exhaustedUntil, `${label}.availability.${id}.exhaustedUntil`);
      requireString(availability.reason, `${label}.availability.${id}.reason`);
    }
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 * @param {boolean} override
 */
function validateRoutingEntry(value, label, override) {
  assertObject(value, label);
  const fields = override
    ? new Set(["at", "role", "runtime", "nextRuntime", "rule", "ruleIndex", "revision", "hop", "reason", "backoffSec", "backoffUntil", "usage", "costUsd"])
    : new Set(["at", "role", "runtime", "nextRuntime", "rule", "ruleIndex", "revision", "hop", "status", "errorCode", "backoffSec", "backoffUntil", "usage", "costUsd"]);
  rejectUnknown(value, fields, label);
  requireTimestamp(value.at, `${label}.at`);
  if (value.role !== "worker" && value.role !== "judge") throw new TypeError(`${label}.role is invalid`);
  requireId(value.runtime, `${label}.runtime`);
  if (value.nextRuntime !== undefined) requireId(value.nextRuntime, `${label}.nextRuntime`);
  if (value.rule !== undefined) nonNegativeInteger(value.rule, `${label}.rule`);
  if (value.ruleIndex !== undefined) nonNegativeInteger(value.ruleIndex, `${label}.ruleIndex`);
  if (value.revision !== undefined) nonNegativeInteger(value.revision, `${label}.revision`);
  if (value.hop !== undefined) nonNegativeInteger(value.hop, `${label}.hop`);
  if (override) {
    boundedString(value.reason, `${label}.reason`, 2 * 1024);
  } else {
    if (value.status !== undefined && !NODE_STATUSES.has(/** @type {string} */ (value.status))) {
      throw new TypeError(`${label}.status is invalid`);
    }
    if (value.errorCode !== undefined) boundedString(value.errorCode, `${label}.errorCode`, 256);
  }
  if (value.backoffSec !== undefined) nonNegativeNumber(value.backoffSec, `${label}.backoffSec`);
  if (value.backoffUntil !== undefined) requireTimestamp(value.backoffUntil, `${label}.backoffUntil`);
  if (value.usage !== undefined) validateInvocationUsage(value.usage, `${label}.usage`);
  if (value.costUsd !== undefined && value.costUsd !== null) nonNegativeNumber(value.costUsd, `${label}.costUsd`);
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateProgressState(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["revision", "heartbeatCount", "dryHeartbeatCount", "progressSignature", "lastHeartbeatAt", "lastProgressAt", "nextCheckAt"]), label);
  if (value.revision !== undefined) nonNegativeInteger(value.revision, `${label}.revision`);
  const heartbeatCount = nonNegativeInteger(value.heartbeatCount, `${label}.heartbeatCount`);
  const dryHeartbeatCount = nonNegativeInteger(value.dryHeartbeatCount, `${label}.dryHeartbeatCount`);
  if (dryHeartbeatCount > heartbeatCount) throw new TypeError(`${label}.dryHeartbeatCount cannot exceed heartbeatCount`);
  if (heartbeatCount > 1_000_000 || dryHeartbeatCount > 1_000_000) throw new TypeError(`${label} heartbeat counts are out of bounds`);
  if (value.lastHeartbeatAt !== null) requireTimestamp(value.lastHeartbeatAt, `${label}.lastHeartbeatAt`);
  if (value.lastProgressAt !== null) requireTimestamp(value.lastProgressAt, `${label}.lastProgressAt`);
  if (value.progressSignature !== undefined && value.progressSignature !== null) boundedString(value.progressSignature, `${label}.progressSignature`, 256);
  if (value.nextCheckAt !== undefined && value.nextCheckAt !== null) requireTimestamp(value.nextCheckAt, `${label}.nextCheckAt`);
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateWorktreeState(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["status", "path", "branch", "commit", "baseSha", "previousAttempt"]), label);
  if (!["unassigned", "provisioning", "ready", "failed", "removed"].includes(/** @type {string} */ (value.status))) {
    throw new TypeError(`${label}.status is invalid`);
  }
  for (const [key, maxBytes] of /** @type {[string, number][]} */ ([['path', 4096], ['branch', 512], ['commit', 256], ['baseSha', 256]])) {
    if (value[key] !== undefined && value[key] !== null) boundedString(value[key], `${label}.${key}`, maxBytes);
  }
  if (value.previousAttempt !== undefined && value.previousAttempt !== null) positiveInteger(value.previousAttempt, `${label}.previousAttempt`);
}
/**
 * @param {JsonObject} value
 * @param {ValidatedNode} node
 */
function validateSnapshotBinding(value, node) {
  if (value.id !== node.id) throw new TypeError(`node snapshot.id does not match contract node ${node.id}`);
  if (value.type !== node.type) throw new TypeError(`node snapshot.type does not match contract node ${node.id}`);
  if (value.packetHash !== node.packetHash) throw new TypeError(`node snapshot.packetHash does not match contract node ${node.id}`);
  if (stableJson(value.sourceIdentity) !== stableJson(node.sourceIdentity)) {
    throw new TypeError(`node snapshot.sourceIdentity does not match contract node ${node.id}`);
  }
}
/**
 * @param {unknown} value
 */
function validateScopeSnapshot(value) {
  assertObject(value, "node snapshot.scope");
  rejectUnknown(value, new Set([
    "changedPaths", "unexpectedPaths", "changedPathCount", "unexpectedPathCount", "truncated", "boundary",
  ]), "node snapshot.scope");
  for (const key of ["changedPaths", "unexpectedPaths"]) {
    const paths = /** @type {unknown[]} */ (value[key]);
    if (!Array.isArray(value[key]) || paths.length > 64 || paths.some((path) => typeof path !== "string")) {
      throw new TypeError(`node snapshot.scope.${key} is invalid`);
    }
    if (paths.some((path) => Buffer.byteLength(/** @type {string} */ (path), "utf8") > 1024)) {
      throw new TypeError(`node snapshot.scope.${key} contains an oversized path`);
    }
  }
  for (const key of ["changedPathCount", "unexpectedPathCount"]) {
    if (value[key] !== undefined) nonNegativeInteger(value[key], `node snapshot.scope.${key}`);
  }
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") throw new TypeError("node snapshot.scope.truncated is invalid");
  if (value.boundary !== undefined && value.boundary !== null) validateScopeBoundarySnapshot(value.boundary, "node snapshot.scope.boundary");
}
/**
 * An advisory finding recorded when a completed attempt's controller
 * verification passed despite unexpected workspace writes (TECH-SPEC lean,
 * rule 1). Never a terminal state.
 *
 * @param {unknown} value
 */
function validateScopeFindings(value) {
  assertObject(value, "node snapshot.scopeFindings");
  rejectUnknown(value, new Set(["unexpectedPaths"]), "node snapshot.scopeFindings");
  const paths = /** @type {unknown[]} */ (value.unexpectedPaths);
  if (!Array.isArray(value.unexpectedPaths) || paths.length > MAX_SCOPE_FINDING_PATHS || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("node snapshot.scopeFindings.unexpectedPaths is invalid");
  }
  if (paths.some((path) => Buffer.byteLength(/** @type {string} */ (path), "utf8") > 1024)) {
    throw new TypeError("node snapshot.scopeFindings.unexpectedPaths contains an oversized path");
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateScopeBoundarySnapshot(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["schemaVersion", "files", "roots", "fileRoots", "fileOrigins", "rootOrigins"]), label);
  if (value.schemaVersion !== 1 || !Array.isArray(value.files) || !Array.isArray(value.roots) || !Array.isArray(value.fileOrigins) || !Array.isArray(value.rootOrigins)) {
    throw new TypeError(`${label} is malformed`);
  }
  // Declared roots that named a regular file at capture time: they authorize
  // exactly that path, never the paths beneath it.
  const fileRoots = value.fileRoots ?? [];
  if (!Array.isArray(fileRoots)) throw new TypeError(`${label}.fileRoots is invalid`);
  const total = value.files.length + value.roots.length + fileRoots.length + value.fileOrigins.length + value.rootOrigins.length;
  if (total > 4096) throw new TypeError(`${label} is too large`);
  /** @param {unknown} path @param {string} pathLabel */
  const validPath = (path, pathLabel) => {
    if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)) {
      throw new TypeError(`${pathLabel} contains an invalid path`);
    }
    if (path === "." || /[\\/]$/u.test(path) || Buffer.byteLength(path, "utf8") > 1024) {
      throw new TypeError(`${pathLabel} contains an invalid path`);
    }
  };
  for (const [kind, paths] of [["files", value.files], ["roots", value.roots], ["fileRoots", fileRoots]]) {
    for (const path of /** @type {unknown[]} */ (paths)) validPath(path, `${label}.${kind}`);
  }
  for (const path of /** @type {unknown[]} */ (fileRoots)) {
    if (!/** @type {unknown[]} */ (value.roots).includes(path)) throw new TypeError(`${label}.fileRoots must be declared roots`);
  }
  for (const [kind, origins] of [["fileOrigins", value.fileOrigins], ["rootOrigins", value.rootOrigins]]) {
    for (const [index, origin] of /** @type {unknown[]} */ (origins).entries()) {
      assertObject(origin, `${label}.${kind}[${index}]`);
      rejectUnknown(origin, new Set(["literal", "paths"]), `${label}.${kind}[${index}]`);
      validPath(origin.literal, `${label}.${kind}[${index}].literal`);
      if (!Array.isArray(origin.paths) || origin.paths.length === 0 || origin.paths.length > 4096) {
        throw new TypeError(`${label}.${kind}[${index}].paths is invalid`);
      }
      for (const path of /** @type {unknown[]} */ (origin.paths)) validPath(path, `${label}.${kind}[${index}].paths`);
      if (!origin.paths.includes(origin.literal)) throw new TypeError(`${label}.${kind}[${index}] must include its literal path`);
    }
  }
}
