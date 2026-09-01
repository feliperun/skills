import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskPacket, renderWorkerPrompt } from "./task-packet.mjs";
import { validateWorkerResult } from "./worker-result.mjs";
import { normalizeManagedSignalBlock } from "./signal-block.mjs";
import {
  INTENT_FACTORY_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  driverCapabilities,
  validateCapabilityRequirements,
} from "./drivers/index.mjs";

export { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION } from "./drivers/index.mjs";

const CONTRACT_FIELDS = new Set([
  "schemaVersion", "contractVersion", "id", "campaignId", "goal", "cwd", "sourceIdentity",
  "maxParallel", "pollIntervalMs", "stallTimeoutSec", "timeoutSec", "maxInputTokens", "maxCostUsd", "usagePolicy",
  "runtimeDefaults", "runtimes", "runtimeRules", "nodes", "warnings",
]);
const DEFAULTS_FIELDS = new Set(["worker", "judge"]);
const RULE_FIELDS = new Set(["match", "runtime", "backoffSec"]);
const NODE_FIELDS = new Set([
  "id", "type", "phase", "runtime", "dependsOn", "taskPacket", "taskPacketFile", "prompt", "promptFile",
  "definitionOfDone", "gate", "timeoutSec", "maxInputTokens", "maxCostUsd", "progressPolicy",
  "requiredCapabilities", "packetHash", "sourceIdentity", "replayPolicy",
]);
const REPLAY_POLICIES = new Set(["safe", "reconcile", "never"]);
const RUNTIME_FIELDS = new Set([
  "driver", "model", "reasoning", "sandbox", "permissionMode", "config", "printTimeout",
  "executable", "args", "versionArgs", "maxArgvPromptBytes", "requiredCapabilities",
]);
const GATE_FIELDS = new Set(["enabled", "runtime", "failOn", "maxRevisions", "requiredCapabilities"]);
const MATCH_FIELDS = new Set(["id", "type", "runtime", "role", "status", "errorCode", "currentRuntime"]);
const RUNTIME_DRIVERS = new Set(["claude", "codex", "agy", "glm", "exec-jsonl"]);
const NODE_STATUSES = new Set(["pending", "running", "done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled"]);
const NODE_PHASES = new Set(["waiting", "worker", "judge", "complete", "dependency", "budget", "canceled"]);
const SNAPSHOT_RUNTIME_FIELDS = new Set(["id", ...RUNTIME_FIELDS, "capabilities"]);
const CAPABILITY_FIELDS = new Set([
  "structuredOutput", "promptTransport", "sandbox", "permissions", "continuation", "tokenBudget", "costBudget",
  "usage", "cost", "toolPolicy", "maxArgvPromptBytes",
]);
const GATE_RESULT_FIELDS = new Set(["verdict", "maxSeverity", "summary", "findings"]);
const FINDING_FIELDS = new Set(["severity", "description", "evidence"]);
const ERROR_FIELDS = new Set(["code", "message"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "cacheReadInputTokens"]);
const MAX_PROGRESS_SEC = 86_400;
const MAX_DRY_HEARTBEATS = 1_000;
const MAX_ROUTING_HISTORY = 64;

/** @typedef {Record<string, unknown>} JsonObject */

/** @typedef {{structuredOutput?: boolean, promptTransport?: "stdin"|"argv", sandbox?: boolean, permissions?: boolean, continuation?: boolean, tokenBudget?: boolean, costBudget?: boolean, usage?: boolean, cost?: boolean}} CapabilityRequirements */

/** @typedef {{kind: string, id?: string, campaignId?: string, contractId?: string, nodeId?: string, cwd?: string, gitHead?: string|null, dirtyTreeFingerprint?: string|null, packetHashes?: Record<string, string>, driverVersions?: Record<string, string|null>}} SourceIdentity */

/** @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[]}} VerificationCommand */

/** @typedef {{mode: "execution"|"discovery"|"autonomous", objective: string, instructions: string[], readFiles: string[], writeFiles?: string[], writeRoots?: string[], symbols: string[], decisions: string[], nonGoals: string[], verification: VerificationCommand[]}} TaskPacket */

/** @typedef {{driver: "claude"|"codex"|"agy"|"glm"|"exec-jsonl", model: string, reasoning?: string, sandbox?: "read-only"|"workspace-write"|"danger-full-access", permissionMode?: string, config?: Record<string, unknown>, printTimeout?: string, executable?: string, args?: string[], versionArgs?: string[], maxArgvPromptBytes?: number, requiredCapabilities?: CapabilityRequirements}} ValidatedRuntime */

/** @typedef {{id?: string, type?: string, runtime?: string, role?: "worker"|"judge", status?: NodeStatus, errorCode?: string, currentRuntime?: string}} RuntimeRuleMatch */

/** @typedef {{match: RuntimeRuleMatch, runtime: string, backoffSec?: number}} ValidatedRuntimeRule */

/** @typedef {{enabled: boolean, runtime?: string, failOn?: ("minor"|"major"|"critical")[], maxRevisions?: number, requiredCapabilities?: CapabilityRequirements}} ValidatedGate */

/** @typedef {{graceSec: number, intervalSec: number, maxDryHeartbeats: number}} ProgressPolicy */
/** @typedef {{epoch: string, maxInputTokens: number, judgeReserveInputTokens: number, maxPhaseInputTokens: number, maxInvocationTokens: number, cacheReadWeight: number}} UsagePolicy */
/** @typedef {{id: string, type: string, phase: string, runtime?: string, dependsOn: string[], taskPacket: TaskPacket, taskPacketFile?: string, prompt: string, definitionOfDone: string[], gate: ValidatedGate, timeoutSec?: number, maxInputTokens?: number, maxCostUsd?: number, progressPolicy?: ProgressPolicy, requiredCapabilities: CapabilityRequirements, packetHash: string, sourceIdentity: SourceIdentity, replayPolicy: "safe"|"reconcile"|"never"}} ValidatedNode */

/** @typedef {{schemaVersion: number, contractVersion: string, id: string, campaignId: string, goal: string, cwd: string, sourceIdentity: SourceIdentity, runtimes: Record<string, ValidatedRuntime>, runtimeDefaults: {worker: string, judge: string}, runtimeRules: ValidatedRuntimeRule[], nodes: ValidatedNode[], maxParallel: number, pollIntervalMs: number, stallTimeoutSec: number, timeoutSec: number, maxInputTokens: number, usagePolicy: UsagePolicy|false, maxCostUsd?: number, warnings: string[]}} ValidatedContract */

/** @typedef {"pending"|"running"|"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"} NodeStatus */
/** @typedef {"waiting"|"worker"|"judge"|"complete"|"dependency"|"budget"|"canceled"} NodePhase */
/** @typedef {{severity: "minor"|"major"|"critical", description: string, evidence: string}} Finding */
/** @typedef {{verdict: "pass"|"fail", maxSeverity: "none"|"minor"|"major"|"critical", summary: string, findings: Finding[]}} GateResult */
/** @typedef {{code: string, message: string}} SnapshotError */
/** @typedef {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} Usage */
/** @typedef {ValidatedRuntime & {id: string, capabilities: import("./drivers/index.mjs").DriverCapabilities}} RuntimeSnapshot */
/** @typedef {import("./supervisor.mjs").Invocation} Invocation */
/** @typedef {import("./verification.mjs").VerificationCommandResult} VerificationCommandResult */
/** @typedef {import("./verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {{passed: boolean, commands?: VerificationCommandResult[], completed?: boolean, error?: string, attempts?: VerificationAttempt[]}} VerificationState */
/** @typedef {{kind: "recovery"|"timeout"|"rotation", decision?: string, invocationId?: string, phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, reason?: string, timeoutSec?: number, at?: string}} ExecutionOverride */
/** @typedef {{literal: string, paths: string[]}} WorkspaceScopeOrigin */
/** @typedef {{schemaVersion: 1, files: string[], roots: string[], fileOrigins: WorkspaceScopeOrigin[], rootOrigins: WorkspaceScopeOrigin[]}} WorkspaceScopeBoundary */
/** @typedef {{changedPaths: string[], unexpectedPaths: string[], changedPathCount: number, unexpectedPathCount: number, truncated: boolean, boundary?: WorkspaceScopeBoundary}} BoundedScope */
/** @typedef {{at: string, role: "worker"|"judge", runtime: string, nextRuntime?: string, rule?: number, ruleIndex?: number, revision?: number, hop?: number, status?: NodeStatus, errorCode?: string, backoffSec?: number, backoffUntil?: string, usage?: Usage, costUsd?: number|null}} RoutingHistoryEntry */
/** @typedef {{at: string, role: "worker"|"judge", runtime: string, nextRuntime?: string, rule?: number, ruleIndex?: number, revision?: number, hop?: number, reason: string, backoffSec?: number, backoffUntil?: string, usage?: Usage, costUsd?: number|null}} RoutingOverride */
/** @typedef {{history: RoutingHistoryEntry[], currentOverride: RoutingOverride|null}} RoutingState */
/** @typedef {{revision?: number, heartbeatCount: number, dryHeartbeatCount: number, progressSignature?: string|null, lastHeartbeatAt: string|null, lastProgressAt: string|null, nextCheckAt?: string|null}} ProgressState */
/** @typedef {{status: "unassigned"|"provisioning"|"ready"|"failed"|"removed", path: string|null, branch: string|null, commit: string|null}} WorktreeState */
/** @typedef {{schemaVersion: number, contractVersion: string, id: string, type: string, sourceIdentity: SourceIdentity, packetHash: string, status: NodeStatus, phase: NodePhase, attempt: number, revisions: number, runtime: RuntimeSnapshot|null, blockedBy: string[], startedAt: string|null, updatedAt: string, result: unknown, gate: GateResult|null, error: SnapshotError|null, usage?: Usage, costUsd?: number, routing?: RoutingState|null, progress?: ProgressState|null, worktree?: WorktreeState|null, invocations?: Invocation[], executionOverrides?: ExecutionOverride[], verification?: VerificationState|null, scope?: BoundedScope|null}} NodeSnapshot */
/** @typedef {{schemaVersion: number, contractVersion: string, pid: number, processStartToken: string|null, startedAt: string, sourceIdentity: SourceIdentity, holderId?: string, leaseGeneration?: number, leaseAcquiredAt?: string, leaseRenewedAt?: string, leaseExpiresAt?: string}} RunMetadata */
/** @typedef {{schemaVersion: number, contractVersion: string, at: string, node: string, from?: string, to: string, phase?: string, attempt?: number, role?: "worker"|"judge", status?: NodeStatus, runtime?: string, currentRuntime?: string, errorCode?: string, error?: SnapshotError, verdict?: string, summary?: string, revisions?: number, sourceIdentity: SourceIdentity, packetHash: string, override?: unknown, recovery?: unknown, invocationId?: string, unexpectedPaths?: string[], unexpectedPathCount?: number}} EventRecord */

/** Ceiling applied when loading a persisted contract that predates mandatory
 * budgets: older runs stay inspectable and resumable, still under a hard cap. */
export const DEFAULT_MAX_INPUT_TOKENS = 1_000_000;

/**
 * Validate and canonicalize the versioned contract. Runtime JSON remains
 * authoritative; JSDoc types document the validated shape only.
 *
 * Authoring entry points (validate, run, preflight, doctor) use the default
 * strict mode: `maxInputTokens` is required. Commands that load a contract
 * persisted inside a run directory pass `{persisted: true}` so runs written
 * before a schema tightening remain readable; a missing budget then defaults
 * to DEFAULT_MAX_INPUT_TOKENS instead of refusing to inspect finished work.
 *
 * @param {JsonObject} raw
 * @param {string} contractPath
 * @param {{persisted?: boolean}} [options]
 * @returns {ValidatedContract}
 */
export function validateContract(raw, contractPath, options = {}) {
  const { persisted = false } = options;
  assertObject(raw, "contract");
  rejectUnknown(raw, CONTRACT_FIELDS, "contract");
  validateMetadata(raw, "contract");
  requireId(raw.id, "contract.id");
  requireId(raw.campaignId, "contract.campaignId");
  requireString(raw.goal, "contract.goal");
  if (!Object.hasOwn(raw, "usagePolicy")) throw new TypeError("contract.usagePolicy is required and must be an object or false");
  const usagePolicy = raw.usagePolicy === false
    ? false
    : validateUsagePolicy(raw.usagePolicy, "contract.usagePolicy");

  const contractDir = dirname(resolve(contractPath));
  const cwd = resolve(contractDir, typeof raw.cwd === "string" ? raw.cwd : ".");
  if (!statSync(cwd).isDirectory()) throw new TypeError("contract.cwd must be a directory");

  const sourceIdentity = validateSourceIdentity(
    raw.sourceIdentity ?? { kind: "contract", id: raw.id, campaignId: raw.campaignId },
    "contract.sourceIdentity",
    { kind: "contract", id: raw.id, campaignId: raw.campaignId },
  );

  const runtimes = /** @type {Record<string, ValidatedRuntime>} */ (raw.runtimes);
  if (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes)) {
    throw new TypeError("contract.runtimes must be an object");
  }
  for (const [id, runtime] of Object.entries(runtimes)) validateRuntime(id, runtime);

  const defaults = /** @type {JsonObject} */ (raw.runtimeDefaults);
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new TypeError("contract.runtimeDefaults is required");
  }
  rejectUnknown(defaults, DEFAULTS_FIELDS, "contract.runtimeDefaults");
  requireRuntime(runtimes, defaults.worker, "runtimeDefaults.worker");
  requireRuntime(runtimes, defaults.judge, "runtimeDefaults.judge");

  const rules = raw.runtimeRules ?? [];
  if (!Array.isArray(rules)) throw new TypeError("contract.runtimeRules must be an array");
  for (const [index, rule] of rules.entries()) validateRule(rule, runtimes, index);

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new TypeError("contract.nodes must be a non-empty array");
  }
  const rawNodes = /** @type {JsonObject[]} */ (raw.nodes);
  const ids = new Set();
  const nodes = rawNodes.map((node, index) => {
    assertObject(node, `nodes[${index}]`);
    rejectUnknown(node, NODE_FIELDS, `nodes[${index}]`);
    if (node.prompt !== undefined || node.promptFile !== undefined) {
      throw new TypeError(`nodes[${index}] must not use prompt or promptFile; provide exactly one of taskPacket or taskPacketFile`);
    }
    requireId(node.id, `nodes[${index}].id`);
    if (ids.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    requireString(node.type, `nodes[${index}].type`);
    boundedString(node.phase, `nodes[${index}].phase`, 128);
    if (node.runtime !== undefined) requireRuntime(runtimes, node.runtime, `nodes[${index}].runtime`);
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      throw new TypeError(`nodes[${index}].dependsOn must be an array of ids`);
    }
    const taskPacket = loadTaskPacket(node, contractDir, cwd, index);
    const prompt = renderWorkerPrompt(taskPacket, /** @type {string} */ (node.id));
    const packetHash = hashPacket(taskPacket);
    if (node.packetHash !== undefined && node.packetHash !== packetHash) {
      throw new TypeError(`nodes[${index}].packetHash does not match taskPacket`);
    }
    const source = validateSourceIdentity(
      node.sourceIdentity ?? { kind: "node", contractId: raw.id, nodeId: node.id },
      `nodes[${index}].sourceIdentity`,
      { kind: "node", contractId: raw.id, nodeId: node.id },
    );
    const definitionOfDone = node.definitionOfDone ?? [];
    if (!Array.isArray(definitionOfDone) || definitionOfDone.some((item) => typeof item !== "string")) {
      throw new TypeError(`nodes[${index}].definitionOfDone must be an array of strings`);
    }
    const requiredCapabilities = validateCapabilityRequirements(
      /** @type {import("./drivers/index.mjs").CapabilityRequirements|undefined} */ (node.requiredCapabilities),
      `nodes[${index}].requiredCapabilities`,
    );
    const gate = validateGate(node.gate, runtimes, index);
    const timeoutSec = node.timeoutSec === undefined
      ? undefined
      : positiveNumber(node.timeoutSec, `nodes[${index}].timeoutSec`);
    const maxInputTokens = node.maxInputTokens === undefined
      ? undefined
      : positiveInteger(node.maxInputTokens, `nodes[${index}].maxInputTokens`);
    const maxCostUsd = node.maxCostUsd === undefined
      ? undefined
      : positiveNumber(node.maxCostUsd, `nodes[${index}].maxCostUsd`);
    const progressPolicy = node.progressPolicy === undefined
      ? taskPacket.mode === "autonomous" ? { graceSec: 300, intervalSec: 120, maxDryHeartbeats: 3 } : undefined
      : validateProgressPolicy(node.progressPolicy, `nodes[${index}].progressPolicy`);
    const replayPolicy = validateReplayPolicy(node.replayPolicy, `nodes[${index}]`);
    return /** @type {ValidatedNode} */ ({
      ...node,
      dependsOn,
      definitionOfDone,
      requiredCapabilities,
      taskPacket,
      packetHash,
      sourceIdentity: source,
      prompt,
      gate,
      timeoutSec,
      maxInputTokens,
      maxCostUsd,
      progressPolicy,
      replayPolicy,
    });
  });

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new TypeError(`${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new TypeError(`${node.id} cannot depend on itself`);
    }
  }
  assertAcyclic(nodes);
  assertPhaseOrdering(nodes);

  const warnings = nodes.flatMap((node, index) => [...commandCoverageWarnings(node, index), ...unsnapshottedWriteWarnings(node, index, cwd)]);
  if (nodes.length === 1) {
    warnings.push("single-node contract: a plan step arrives as one batched multi-node DAG with dependsOn; single nodes are only for targeted fix nodes after gate exhaustion");
  }
  return /** @type {ValidatedContract} */ ({
    ...raw,
    schemaVersion: /** @type {number} */ (raw.schemaVersion),
    contractVersion: /** @type {string} */ (raw.contractVersion),
    sourceIdentity,
    cwd,
    runtimes,
    runtimeDefaults: /** @type {{worker: string, judge: string}} */ (defaults),
    runtimeRules: rules,
    nodes,
    maxParallel: validateMaxParallel(raw.maxParallel ?? 1),
    pollIntervalMs: positiveInteger(raw.pollIntervalMs ?? 1_000, "contract.pollIntervalMs"),
    stallTimeoutSec: positiveNumber(raw.stallTimeoutSec ?? 300, "contract.stallTimeoutSec"),
    timeoutSec: positiveNumber(raw.timeoutSec ?? 2_400, "contract.timeoutSec"),
    // Mandatory at authoring time: a contract without a hard token budget is
    // exactly how the 2026-08 usage incident happened (workers burned 1.2M+
    // input tokens unbounded). Authors must state the ceiling explicitly.
    maxInputTokens: raw.maxInputTokens === undefined && persisted
      ? DEFAULT_MAX_INPUT_TOKENS
      : positiveInteger(raw.maxInputTokens, "contract.maxInputTokens"),
    usagePolicy,
    maxCostUsd: raw.maxCostUsd === undefined
      ? undefined
      : positiveNumber(raw.maxCostUsd, "contract.maxCostUsd"),
    warnings,
  });
}

/** @typedef {{id: string, type?: string, runtime?: string, gate: {runtime?: string}, status?: NodeStatus, errorCode?: string, currentRuntime?: string}} RoutableNode */
/** @typedef {{status?: NodeStatus, errorCode?: string, currentRuntime?: string}} RoutingEvent */
/** @param {ValidatedContract} contract @param {RoutableNode} node @param {"worker"|"judge"} role @param {RoutingEvent} event */
export function routeRuntime(contract, node, role = "worker", event = {}) {
  if (role !== "worker" && role !== "judge") throw new TypeError("route role must be worker or judge");
  const initialRuntimeId = role === "judge"
    ? node.gate.runtime ?? contract.runtimeDefaults.judge
    : node.runtime ?? contract.runtimeDefaults.worker;
  const currentRuntime = event.currentRuntime ?? node.currentRuntime ?? initialRuntimeId;
  requireRuntime(contract.runtimes, currentRuntime, "routing current runtime");
  const routeContext = /** @type {Record<string, unknown>} */ ({
    ...node,
    role,
    status: event.status ?? node.status,
    errorCode: event.errorCode ?? node.errorCode,
    currentRuntime,
  });
  const hasExplicitRuntime = role === "judge" ? Boolean(node.gate.runtime) : Boolean(node.runtime);
  const rule = contract.runtimeRules.find((candidate) => {
    const matches = Object.entries(candidate.match).every(([key, value]) => routeContext[key] === value);
    if (!matches) return false;
    const eventAware = ["role", "status", "errorCode", "currentRuntime"].some((key) => Object.hasOwn(candidate.match, key));
    return !hasExplicitRuntime || eventAware;
  });
  const runtimeId = rule?.runtime ?? currentRuntime;
  const runtime = contract.runtimes[runtimeId];
  return {
    id: runtimeId,
    ...runtime,
    capabilities: driverCapabilities(runtime),
    ...(rule ? { ruleIndex: contract.runtimeRules.indexOf(rule) } : {}),
    ...(rule?.backoffSec === undefined ? {} : { backoffSec: rule.backoffSec }),
  };
}

/**
 * Stable hash for the exact validated packet content.
 *
 * @param {TaskPacket} packet
 * @returns {string}
 */
export function hashPacket(packet) {
  return createHash("sha256").update(canonicalJson(packet)).digest("hex");
}

/**
 * @param {JsonObject} value
 * @param {{requireLease?: boolean, requireSourceIdentity?: boolean}} options
 * @returns {RunMetadata}
 */
export function validateRunMetadata(value, options = {}) {
  assertObject(value, "run metadata");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "pid", "processStartToken", "startedAt", "sourceIdentity",
    "holderId", "leaseGeneration", "leaseAcquiredAt", "leaseRenewedAt", "leaseExpiresAt",
  ]), "run metadata");
  validateMetadata(value, "run metadata");
  requireInteger(value.pid, "run metadata.pid");
  if (value.processStartToken !== undefined && value.processStartToken !== null) requireString(value.processStartToken, "run metadata.processStartToken");
  requireString(value.startedAt, "run metadata.startedAt");
  validateSourceIdentity(value.sourceIdentity, "run metadata.sourceIdentity", { kind: "run" });
  if (options.requireLease) validateLeaseMetadata(value);
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
    "attempt", "revisions", "runtime", "blockedBy", "startedAt", "updatedAt", "result", "gate", "error", "usage",
    "costUsd", "routing", "progress", "worktree", "invocations", "executionOverrides", "verification", "scope",
  ]), "node snapshot");
  validateMetadata(value, "node snapshot");
  requireId(value.id, "node snapshot.id");
  requireString(value.type, "node snapshot.type");
  if (!NODE_STATUSES.has(/** @type {string} */ (value.status))) throw new TypeError("node snapshot.status is invalid");
  if (!NODE_PHASES.has(/** @type {string} */ (value.phase))) throw new TypeError("node snapshot.phase is invalid");
  nonNegativeInteger(value.attempt, "node snapshot.attempt");
  nonNegativeInteger(value.revisions, "node snapshot.revisions");
  requirePacketHash(value.packetHash, "node snapshot.packetHash");
  validateSourceIdentity(value.sourceIdentity, "node snapshot.sourceIdentity", { kind: "node" });
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
    "schemaVersion", "contractVersion", "at", "node", "from", "to", "phase", "attempt", "runtime",
    "role", "status", "currentRuntime", "errorCode", "error", "verdict", "summary", "revisions", "sourceIdentity", "packetHash", "override", "recovery", "invocationId", "unexpectedPaths", "unexpectedPathCount",
  ]), "event");
  validateMetadata(value, "event");
  requireString(value.at, "event.at");
  requireId(value.node, "event.node");
  requireString(value.to, "event.to");
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
 * @param {unknown} rule
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {number} index
 */
function validateRule(rule, runtimes, index) {
  assertObject(rule, `runtimeRules[${index}]`);
  rejectUnknown(rule, RULE_FIELDS, `runtimeRules[${index}]`);
  const match = /** @type {Record<string, unknown>|undefined} */ (rule.match);
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    throw new TypeError(`runtimeRules[${index}].match must be an object`);
  }
  if (!Object.keys(match).length) throw new TypeError(`runtimeRules[${index}].match cannot be empty`);
  for (const key of Object.keys(match)) {
    if (!MATCH_FIELDS.has(key)) throw new TypeError(`runtimeRules[${index}].match.${key} is unknown`);
    if (key === "role") {
      if (match[key] !== "worker" && match[key] !== "judge") throw new TypeError(`runtimeRules[${index}].match.role is invalid`);
    } else if (key === "status") {
      if (!NODE_STATUSES.has(/** @type {string} */ (match[key]))) throw new TypeError(`runtimeRules[${index}].match.status is invalid`);
    } else if (key === "currentRuntime") {
      requireRuntime(runtimes, match[key], `runtimeRules[${index}].match.currentRuntime`);
    } else if (key === "runtime") {
      requireRuntime(runtimes, match[key], `runtimeRules[${index}].match.runtime`);
    } else {
      requireString(match[key], `runtimeRules[${index}].match.${key}`);
    }
  }
  requireRuntime(runtimes, rule.runtime, `runtimeRules[${index}].runtime`);
  if (rule.backoffSec !== undefined) nonNegativeNumber(rule.backoffSec, `runtimeRules[${index}].backoffSec`);
  if (match.currentRuntime === rule.runtime) {
    throw new TypeError(`runtimeRules[${index}] is a self-looping failover rule`);
  }
}

/**
 * Reject runtime failover cycles when their current-runtime edges are known.
 *
 * @param {unknown[]} rules
 */
function assertNoFailoverCycles(rules) {
  const edges = new Map();
  for (const rule of rules) {
    const record = /** @type {JsonObject} */ (rule);
    const match = /** @type {JsonObject} */ (record.match);
    if (match.currentRuntime === undefined) continue;
    const current = /** @type {string} */ (match.currentRuntime);
    const target = /** @type {string} */ (record.runtime);
    const targets = edges.get(current) ?? [];
    targets.push(target);
    edges.set(current, targets);
  }
  const visiting = new Set();
  const visited = new Set();
  /** @param {string} runtime */
  const visit = (runtime) => {
    if (visiting.has(runtime)) throw new TypeError(`runtimeRules contain a cyclic failover at ${runtime}`);
    if (visited.has(runtime)) return;
    visiting.add(runtime);
    for (const next of edges.get(runtime) ?? []) visit(next);
    visiting.delete(runtime);
    visited.add(runtime);
  };
  for (const runtime of edges.keys()) visit(runtime);
}

/**
 * @param {string} id
 * @param {unknown} runtime
 */
function validateRuntime(id, runtime) {
  requireId(id, `runtime ${id}`);
  assertObject(runtime, `runtime ${id}`);
  rejectUnknown(runtime, RUNTIME_FIELDS, `runtime ${id}`);
  validateRuntimeValues(runtime, `runtime ${id}`, runtime.driver === "exec-jsonl");
}

/**
 * @param {JsonObject} runtime
 * @param {string} label
 * @param {boolean} executableRequired
 */
function validateRuntimeValues(runtime, label, executableRequired) {
  const driver = runtime.driver;
  if (typeof driver !== "string" || !RUNTIME_DRIVERS.has(driver)) throw new TypeError(`${label}.driver is invalid`);
  requireString(runtime.model, `${label}.model`);
  if (runtime.reasoning !== undefined) requireString(runtime.reasoning, `${label}.reasoning`);
  if (runtime.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(/** @type {string} */ (runtime.sandbox))) {
    throw new TypeError(`${label}.sandbox is invalid`);
  }
  if (runtime.permissionMode !== undefined) requireString(runtime.permissionMode, `${label}.permissionMode`);
  if (runtime.config !== undefined && (!runtime.config || typeof runtime.config !== "object" || Array.isArray(runtime.config))) {
    throw new TypeError(`${label}.config must be an object`);
  }
  if (runtime.printTimeout !== undefined) requireString(runtime.printTimeout, `${label}.printTimeout`);
  if (runtime.executable !== undefined) requireString(runtime.executable, `${label}.executable`);
  if (runtime.args !== undefined) requireStringArray(runtime.args, `${label}.args`);
  if (runtime.versionArgs !== undefined) requireStringArray(runtime.versionArgs, `${label}.versionArgs`);
  if (runtime.maxArgvPromptBytes !== undefined) positiveInteger(runtime.maxArgvPromptBytes, `${label}.maxArgvPromptBytes`);
  validateCapabilityRequirements(
    /** @type {import("./drivers/index.mjs").CapabilityRequirements|undefined} */ (runtime.requiredCapabilities),
    `${label}.requiredCapabilities`,
  );
  if (executableRequired && runtime.executable === undefined) requireString(runtime.executable, `${label}.executable`);
}

/**
 * @param {unknown} gate
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {number} index
 * @returns {ValidatedGate}
 */
function validateGate(gate, runtimes, index) {
  if (gate === false || gate === undefined) return { enabled: false };
  assertObject(gate, `nodes[${index}].gate`);
  rejectUnknown(gate, GATE_FIELDS, `nodes[${index}].gate`);
  if (gate.enabled === false) {
    if (Object.keys(gate).length !== 1) throw new TypeError(`nodes[${index}].gate disabled shape only allows enabled`);
    return { enabled: false };
  }
  if (gate.enabled !== undefined && gate.enabled !== true) {
    throw new TypeError(`nodes[${index}].gate.enabled must be true or false`);
  }
  if (gate.runtime !== undefined) requireRuntime(runtimes, gate.runtime, `nodes[${index}].gate.runtime`);
  const failOnValue = /** @type {unknown} */ (gate.failOn ?? ["critical"]);
  if (!Array.isArray(failOnValue) || failOnValue.some((value) => !["minor", "major", "critical"].includes(value))) {
    throw new TypeError(`nodes[${index}].gate.failOn contains an invalid severity`);
  }
  return {
    enabled: true,
    runtime: /** @type {string|undefined} */ (gate.runtime),
    failOn: /** @type {("minor"|"major"|"critical")[]} */ (failOnValue),
    maxRevisions: nonNegativeInteger(gate.maxRevisions ?? 1, `nodes[${index}].gate.maxRevisions`),
    requiredCapabilities: validateCapabilityRequirements(
      /** @type {import("./drivers/index.mjs").CapabilityRequirements|undefined} */ (gate.requiredCapabilities),
      `nodes[${index}].gate.requiredCapabilities`,
    ),
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {ProgressPolicy}
 */
function validateProgressPolicy(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["graceSec", "intervalSec", "maxDryHeartbeats"]), label);
  if (!Object.hasOwn(value, "graceSec") || !Object.hasOwn(value, "intervalSec") || !Object.hasOwn(value, "maxDryHeartbeats")) {
    throw new TypeError(`${label} requires graceSec, intervalSec, and maxDryHeartbeats`);
  }
  const graceSec = boundedNonNegativeNumber(value.graceSec, `${label}.graceSec`, MAX_PROGRESS_SEC);
  const intervalSec = boundedPositiveNumber(value.intervalSec, `${label}.intervalSec`, MAX_PROGRESS_SEC);
  const maxDryHeartbeats = nonNegativeInteger(value.maxDryHeartbeats, `${label}.maxDryHeartbeats`);
  if (maxDryHeartbeats > MAX_DRY_HEARTBEATS) throw new TypeError(`${label}.maxDryHeartbeats exceeds ${MAX_DRY_HEARTBEATS}`);
  return { graceSec, intervalSec, maxDryHeartbeats };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {"safe"|"reconcile"|"never"}
 */
function validateReplayPolicy(value, label) {
  if (value === undefined) return "safe";
  if (typeof value !== "string" || !REPLAY_POLICIES.has(value)) {
    throw new TypeError(`${label}.replayPolicy must be one of safe, reconcile, never`);
  }
  return /** @type {"safe"|"reconcile"|"never"} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {UsagePolicy}
 */
function validateUsagePolicy(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["epoch", "maxInputTokens", "judgeReserveInputTokens", "maxPhaseInputTokens", "maxInvocationTokens", "cacheReadWeight"]), label);
  boundedString(value.epoch, `${label}.epoch`, 128);
  const maxInputTokens = positiveInteger(value.maxInputTokens, `${label}.maxInputTokens`);
  const judgeReserveInputTokens = nonNegativeInteger(value.judgeReserveInputTokens, `${label}.judgeReserveInputTokens`);
  if (judgeReserveInputTokens > maxInputTokens) {
    throw new TypeError(`${label}.judgeReserveInputTokens cannot exceed maxInputTokens`);
  }
  const maxPhaseInputTokens = positiveInteger(value.maxPhaseInputTokens, `${label}.maxPhaseInputTokens`);
  const maxInvocationTokens = positiveInteger(value.maxInvocationTokens, `${label}.maxInvocationTokens`);
  const cacheReadWeight = boundedNonNegativeNumber(value.cacheReadWeight, `${label}.cacheReadWeight`, 1);
  return { epoch: /** @type {string} */ (value.epoch), maxInputTokens, judgeReserveInputTokens, maxPhaseInputTokens, maxInvocationTokens, cacheReadWeight };
}

/**
 * @param {JsonObject} value
 * @param {string} label
 */
function validateMetadata(value, label) {
  if (value.schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
    throw new TypeError(`${label}.schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`);
  }
  if (value.contractVersion !== INTENT_FACTORY_VERSION) {
    throw new TypeError(`${label}.contractVersion must be ${INTENT_FACTORY_VERSION}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {JsonObject|null} expected
 */
function validateSourceIdentity(value, label, expected = null) {
  assertObject(value, label);
  const allowed = new Set([
    "kind", "id", "campaignId", "contractId", "nodeId", "cwd", "gitHead",
    "dirtyTreeFingerprint", "packetHashes", "driverVersions",
  ]);
  rejectUnknown(value, allowed, label);
  requireString(value.kind, `${label}.kind`);
  for (const key of ["id", "campaignId", "contractId", "nodeId"]) {
    if (value[key] !== undefined) requireId(value[key], `${label}.${key}`);
  }
  if (value.cwd !== undefined) requireString(value.cwd, `${label}.cwd`);
  for (const key of ["gitHead", "dirtyTreeFingerprint"]) {
    if (value[key] !== undefined && value[key] !== null) requireString(value[key], `${label}.${key}`);
  }
  if (value.packetHashes !== undefined) validateHashMap(value.packetHashes, `${label}.packetHashes`);
  if (value.driverVersions !== undefined) {
    assertObject(value.driverVersions, `${label}.driverVersions`);
    for (const [key, version] of Object.entries(value.driverVersions)) {
      requireId(key, `${label}.driverVersions key`);
      if (version !== null) requireString(version, `${label}.driverVersions.${key}`);
    }
  }
  if (expected) {
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) throw new TypeError(`${label}.${key} does not match its source`);
    }
  }
  return /** @type {SourceIdentity} */ ({ ...value });
}

/**
 * @param {{id: string, campaignId: string, cwd: string, nodes: {id: string, packetHash: string}[]}} contract
 * @param {Record<string, string|null>} driverVersions
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 */
export function captureSourceIdentity(contract, driverVersions = {}, options = {}) {
  const git = gitIdentity(contract.cwd, options);
  return validateSourceIdentity({
    kind: "run",
    contractId: contract.id,
    campaignId: contract.campaignId,
    cwd: contract.cwd,
    gitHead: git.gitHead,
    dirtyTreeFingerprint: git.dirtyTreeFingerprint,
    packetHashes: Object.fromEntries(contract.nodes.map((node) => [node.id, node.packetHash])),
    driverVersions,
  }, "run source identity", { kind: "run", contractId: contract.id, campaignId: contract.campaignId });
}

/**
 * @param {JsonObject} value
 */
function validateLeaseMetadata(value) {
  requireString(value.holderId, "run metadata.holderId");
  positiveInteger(value.leaseGeneration, "run metadata.leaseGeneration");
  for (const key of ["leaseAcquiredAt", "leaseRenewedAt", "leaseExpiresAt"]) {
    requireTimestamp(value[key], `run metadata.${key}`);
  }
}

/**
 * @param {JsonObject} value
 */
function validateCompleteSourceIdentity(value) {
  for (const key of ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "driverVersions"]) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`run metadata.sourceIdentity.${key} is required for resume`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateHashMap(value, label) {
  assertObject(value, label);
  for (const [key, hash] of Object.entries(value)) {
    requireId(key, `${label} key`);
    requirePacketHash(hash, `${label}.${key}`);
  }
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
      "id", "pid", "processGroupId", "processStartToken", "driver", "runtimeId", "phase",
      "promptPath", "stdoutPath", "stderrPath", "startedAt", "updatedAt", "closedAt", "deadlineAt",
      "exitCode", "signal", "status", "executable", "usage", "costUsd", "snapshotPath", "revision",
      "runId", "campaignId", "planPhase", "role", "runtimeFingerprint", "model", "reasoning", "sandbox", "continuationId", "continuationMode",
    ]);
    rejectUnknown(invocation, allowed, `${label}[${index}]`);
    requireString(invocation.id, `${label}[${index}].id`);
    requireInteger(invocation.pid, `${label}[${index}].pid`);
    if (invocation.processGroupId !== null) requireInteger(invocation.processGroupId, `${label}[${index}].processGroupId`);
    if (invocation.processStartToken !== null) requireString(invocation.processStartToken, `${label}[${index}].processStartToken`);
    requireString(invocation.driver, `${label}[${index}].driver`);
    requireString(invocation.phase, `${label}[${index}].phase`);
    requireId(invocation.runId, `${label}[${index}].runId`);
    requireId(invocation.campaignId, `${label}[${index}].campaignId`);
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
 * @param {string} cwd
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 * @returns {{gitHead: string|null, dirtyTreeFingerprint: string|null}}
 */
function gitIdentity(cwd, options = {}) {
  try {
    const pathspec = [
      ".",
      ":(exclude).runs",
      ":(exclude)AGENTS.md",
      ...(options.ignorePaths ?? []).map((path) => `:(exclude)${path}`),
      ...(options.ignoreRoots ?? []).map((path) => `:(exclude)${path}`),
    ];
    let gitHead = null;
    const headPath = resolve(cwd, ".git", "HEAD");
    let headText = null;
    try { headText = readFileSync(headPath, "utf8").trim(); } catch {}
    let unbornHead = false;
    if (headText?.startsWith("ref: ") === true) {
      try { lstatSync(resolve(cwd, ".git", headText.slice(5))); }
      catch (error) { if (errorCode(error) === "ENOENT") unbornHead = true; else throw error; }
    }
    if (!unbornHead) {
      try {
        gitHead = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
      } catch {}
    }
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...pathspec], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const statusText = status.toString("utf8");
    const diff = !gitHead || status.length === 0
      ? Buffer.alloc(0)
      : execFileSync("git", ["-C", cwd, "diff", "--binary", "HEAD", "--", ...pathspec], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const untrackedFiles = statusText.split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3));
    const contents = createHash("sha256");
    for (const relativePath of untrackedFiles) {
      const absolutePath = resolve(cwd, relativePath);
      const metadata = lstatSync(absolutePath);
      contents.update(`${relativePath}\0${metadata.mode}\0`);
      if (metadata.isSymbolicLink()) contents.update(readlinkSync(absolutePath));
      else if (metadata.isFile()) contents.update(readFileSync(absolutePath));
      contents.update("\0");
    }
    return {
      gitHead,
      dirtyTreeFingerprint: createHash("sha256")
        .update(status)
        .update(diff)
        .update(contents.digest())
        .update(agentGuidanceIdentity(cwd))
        .digest("hex"),
    };
  } catch {
    return { gitHead: null, dirtyTreeFingerprint: null };
  }
}

/**
 * Hash AGENTS.md separately so its machine-managed signal may change without
 * hiding edits to human-authored repository guidance.
 *
 * @param {string} cwd
 * @returns {Buffer}
 */
function agentGuidanceIdentity(cwd) {
  const path = resolve(cwd, "AGENTS.md");
  const identity = createHash("sha256").update("AGENTS.md\0");
  try {
    const metadata = lstatSync(path);
    identity.update(`${metadata.mode}\0`);
    if (metadata.isSymbolicLink()) identity.update(`symlink\0${readlinkSync(path)}`);
    else if (metadata.isFile()) identity.update(`file\0${normalizeManagedSignalBlock(readFileSync(path, "utf8"))}`);
    else identity.update("unsupported");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    identity.update("missing");
  }
  return identity.digest();
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateSnapshotRuntime(value, label) {
  if (value === null) return;
  assertObject(value, label);
  rejectUnknown(value, SNAPSHOT_RUNTIME_FIELDS, label);
  requireId(value.id, `${label}.id`);
  validateRuntimeValues(value, label, value.driver === "exec-jsonl");
  validateCapabilities(/** @type {JsonObject} */ (value.capabilities), `${label}.capabilities`);
  const expected = driverCapabilities(/** @type {{driver: string}} */ (value));
  if (canonicalJson(value.capabilities) !== canonicalJson(expected)) {
    throw new TypeError(`${label}.capabilities does not match its driver`);
  }
}

/**
 * @param {JsonObject} value
 * @param {string} label
 */
function validateCapabilities(value, label) {
  assertObject(value, label);
  rejectUnknown(value, CAPABILITY_FIELDS, label);
  for (const name of ["structuredOutput", "sandbox", "permissions", "continuation", "tokenBudget", "costBudget", "usage", "cost", "toolPolicy"]) {
    if (typeof value[name] !== "boolean") throw new TypeError(`${label}.${name} must be boolean`);
  }
  if (!["stdin", "argv"].includes(/** @type {string} */ (value.promptTransport))) {
    throw new TypeError(`${label}.promptTransport is invalid`);
  }
  if (value.maxArgvPromptBytes !== undefined) {
    positiveInteger(value.maxArgvPromptBytes, `${label}.maxArgvPromptBytes`);
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
  if (verdict !== "pass" && verdict !== "fail") throw new TypeError(`${label}.verdict is invalid`);
  if (!["none", "minor", "major", "critical"].includes(/** @type {string} */ (maxSeverity))) {
    throw new TypeError(`${label}.maxSeverity is invalid`);
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
  if ((verdict === "pass") !== (maxSeverity === "none")) {
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
  rejectUnknown(value, new Set(["history", "currentOverride"]), label);
  if (!Array.isArray(value.history) || value.history.length > MAX_ROUTING_HISTORY) {
    throw new TypeError(`${label}.history must be an array with at most ${MAX_ROUTING_HISTORY} items`);
  }
  for (const [index, entry] of value.history.entries()) {
    validateRoutingEntry(entry, `${label}.history[${index}]`, false);
  }
  if (value.currentOverride !== null) validateRoutingEntry(value.currentOverride, `${label}.currentOverride`, true);
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
  rejectUnknown(value, new Set(["status", "path", "branch", "commit"]), label);
  if (!["unassigned", "provisioning", "ready", "failed", "removed"].includes(/** @type {string} */ (value.status))) {
    throw new TypeError(`${label}.status is invalid`);
  }
  for (const [key, maxBytes] of /** @type {[string, number][]} */ ([['path', 4096], ['branch', 512], ['commit', 256]])) {
    if (value[key] !== null) boundedString(value[key], `${label}.${key}`, maxBytes);
  }
}

/**
 * @param {JsonObject} value
 * @param {ValidatedNode} node
 */
function validateSnapshotBinding(value, node) {
  if (value.id !== node.id) throw new TypeError(`node snapshot.id does not match contract node ${node.id}`);
  if (value.type !== node.type) throw new TypeError(`node snapshot.type does not match contract node ${node.id}`);
  if (value.packetHash !== node.packetHash) throw new TypeError(`node snapshot.packetHash does not match contract node ${node.id}`);
  if (canonicalJson(value.sourceIdentity) !== canonicalJson(node.sourceIdentity)) {
    throw new TypeError(`node snapshot.sourceIdentity does not match contract node ${node.id}`);
  }
}

/**
 * @param {unknown} value
 */
function validateVerificationSnapshot(value) {
  assertObject(value, "node snapshot.verification");
  if (typeof value.passed !== "boolean" || !Array.isArray(value.commands) || value.commands.length > 32) {
    throw new TypeError("node snapshot.verification is invalid");
  }
  if (value.completed !== undefined && typeof value.completed !== "boolean") throw new TypeError("node snapshot.verification.completed is invalid");
  if (value.attempts !== undefined) {
    if (!Array.isArray(value.attempts) || value.attempts.length > 16) throw new TypeError("node snapshot.verification.attempts is invalid");
    const attempts = /** @type {unknown[]} */ (value.attempts);
    for (const [index, attempt] of attempts.entries()) validateVerificationAttempt(attempt, `node snapshot.verification.attempts[${index}]`);
  }
  if (value.error !== undefined && (typeof value.error !== "string" || Buffer.byteLength(value.error, "utf8") > 4096)) {
    throw new TypeError("node snapshot.verification.error is invalid");
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateVerificationAttempt(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set([
    "invocationId", "commandIndex", "attempt", "pid", "processStartToken", "processGroupId",
    "startedAt", "deadlineAt", "status", "completedAt", "result",
  ]), label);
  requireString(value.invocationId, `${label}.invocationId`);
  nonNegativeInteger(value.commandIndex, `${label}.commandIndex`);
  positiveInteger(value.attempt, `${label}.attempt`);
  if (value.pid !== null) requireInteger(value.pid, `${label}.pid`);
  if (value.processGroupId !== null) requireInteger(value.processGroupId, `${label}.processGroupId`);
  if (value.processStartToken !== null) requireString(value.processStartToken, `${label}.processStartToken`);
  requireTimestamp(value.startedAt, `${label}.startedAt`);
  requireTimestamp(value.deadlineAt, `${label}.deadlineAt`);
  if (!["active", "closed", "failed", "crashed", "canceled"].includes(/** @type {string} */ (value.status))) throw new TypeError(`${label}.status is invalid`);
  if (value.completedAt !== null) requireTimestamp(value.completedAt, `${label}.completedAt`);
  if (value.result !== null) {
    assertObject(value.result, `${label}.result`);
    const result = /** @type {JsonObject} */ (value.result);
    for (const key of ["stdout", "stderr", "error"]) {
      if (result[key] !== null && result[key] !== undefined && (typeof result[key] !== "string" || Buffer.byteLength(result[key], "utf8") > 2048)) throw new TypeError(`${label}.result.${key} is invalid`);
    }
    if (typeof result.passed !== "boolean") throw new TypeError(`${label}.result.passed is invalid`);
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
 * @param {unknown} value
 * @param {string} label
 */
function validateScopeBoundarySnapshot(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set(["schemaVersion", "files", "roots", "fileOrigins", "rootOrigins"]), label);
  if (value.schemaVersion !== 1 || !Array.isArray(value.files) || !Array.isArray(value.roots) || !Array.isArray(value.fileOrigins) || !Array.isArray(value.rootOrigins)) {
    throw new TypeError(`${label} is malformed`);
  }
  const total = value.files.length + value.roots.length + value.fileOrigins.length + value.rootOrigins.length;
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
  for (const [kind, paths] of [["files", value.files], ["roots", value.roots]]) {
    for (const path of /** @type {unknown[]} */ (paths)) validPath(path, `${label}.${kind}`);
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

/**
 * Reject any key of {@link value} not present in {@link allowed}.
 *
 * @param {JsonObject} value
 * @param {Set<string>} allowed
 * @param {string} label
 */
export function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is JsonObject}
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

/**
 * @param {ValidatedNode[]} nodes
 */
function assertAcyclic(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  /** @type {(id: string) => void} */
  const visit = (id) => {
    if (visiting.has(id)) throw new TypeError(`dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id);
    if (!node) throw new TypeError(`dependency cycle includes ${id}`);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

/**
 * Same-phase nodes must have an unambiguous dependency order. Otherwise a
 * future scheduler with more than one slot could run two nodes against the
 * same provider continuation at once.
 *
 * @param {ValidatedNode[]} nodes
 */
function assertPhaseOrdering(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Map();
  /** @param {string} id @returns {Set<string>} */
  const visit = (id) => {
    if (ancestors.has(id)) return ancestors.get(id);
    const result = new Set();
    ancestors.set(id, result);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      result.add(dependency);
      for (const ancestor of visit(dependency)) result.add(ancestor);
    }
    return result;
  };
  for (const node of nodes) visit(node.id);
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      const first = nodes[left];
      const second = nodes[right];
      if (first.phase !== second.phase) continue;
      const ordered = ancestors.get(first.id)?.has(second.id) || ancestors.get(second.id)?.has(first.id);
      if (!ordered) {
        throw new TypeError(`nodes ${first.id} and ${second.id} share phase ${first.phase} but are not sequentially ordered`);
      }
    }
  }
}

const ALWAYS_UNOBSERVABLE_ROOTS = new Set([".runs", ".git"]);

/**
 * @param {ValidatedNode} node
 * @param {number} index
 * @param {string} cwd
 * @returns {string[]}
 */
function unsnapshottedWriteWarnings(node, index, cwd) {
  const declarations = /** @type {{kind: "writeFiles"|"writeRoots", path: string}[]} */ ([
    ...(node.taskPacket.writeFiles ?? []).map((path) => ({ kind: "writeFiles", path })),
    ...(node.taskPacket.writeRoots ?? []).map((path) => ({ kind: "writeRoots", path })),
  ]);
  const hidden = new Map();
  for (const declaration of declarations) {
    if (!isUnobservableDeclaredPath(cwd, declaration.path, declaration.kind)) continue;
    const path = process.platform === "win32" ? String(declaration.path).replaceAll("\\", "/") : String(declaration.path);
    const root = path.split("/")[0];
    const key = `${declaration.kind}:${root}`;
    hidden.set(key, { kind: declaration.kind, root, path });
  }
  return [...hidden.values()].map(({ kind, root, path }) =>
    `nodes[${index}] (${node.id}): ${path.includes("/") ? `${kind} under ${root}/` : `${kind} ${path}`} are outside the workspace snapshot, so the closed-scope gate cannot observe them`,
  );
}

/**
 * @param {string|undefined} cwd
 * @param {string} declaredPath
 * @param {"writeFiles"|"writeRoots"} kind
 * @returns {boolean}
 */
function isUnobservableDeclaredPath(cwd, declaredPath, kind) {
  if (!cwd) return false;
  const path = process.platform === "win32" ? String(declaredPath).replaceAll("\\", "/") : String(declaredPath);
  const root = path.split("/")[0];
  if (ALWAYS_UNOBSERVABLE_ROOTS.has(root)) return true;
  return gitDeclaredPathState(cwd, path, kind) === "ignored";
}

/**
 * @param {string} cwd
 * @param {string} path
 * @param {"writeFiles"|"writeRoots"} kind
 * @returns {"tracked"|"ignored"|"visible"|"unknown"}
 */
function gitDeclaredPathState(cwd, path, kind) {
  const literals = kind === "writeRoots" ? [path, `${path}/`] : [path];
  try {
    execFileSync("git", ["-C", cwd, "ls-files", "--cached", "--error-unmatch", "--", path], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "tracked";
  } catch (error) {
    if (errorCode(error) !== 1) return "unknown";
  }

  let hasIntentfactoryIgnore = false;
  try {
    hasIntentfactoryIgnore = lstatSync(resolve(cwd, ".intentfactoryignore")).isFile();
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return "unknown";
  }
  const intentfactoryIgnore = hasIntentfactoryIgnore ? resolve(cwd, ".intentfactoryignore") : undefined;
  for (const literal of literals) {
    const combined = checkCombinedGitIgnore(cwd, literal, intentfactoryIgnore);
    if (combined === "unknown") return "unknown";
    if (combined === false) return "visible";
  }
  return "ignored";
}

/**
 * Use the same combined Git enumeration as workspace snapshots for paths
 * that already exist. Missing declarations fall through to check-ignore so
 * validation can still warn about future paths hidden by a rule.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string|undefined} extraExclude
 * @returns {boolean|"unknown"|undefined}
 */
function checkCombinedGitIgnore(cwd, path, extraExclude) {
  let exists = true;
  try {
    lstatSync(resolve(cwd, path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") exists = false;
    else return "unknown";
  }
  if (!exists) {
    return checkMissingCombinedGitIgnore(cwd, path, extraExclude);
  }

  try {
    const args = ["-C", cwd, "ls-files", "--others", "--exclude-standard"];
    if (extraExclude) args.push(`--exclude-from=${extraExclude}`);
    args.push("-z", "--", path);
    const output = execFileSync("git", args, { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    return output.length === 0;
  } catch {
    return "unknown";
  }
}

/**
 * A missing path cannot be checked with the snapshot enumeration. Ask Git for
 * the standard result in the real repository, then ask Git whether the extra
 * source matched in an isolated context so repository `.gitignore` files
 * cannot outrank it.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string|undefined} extraExclude
 * @returns {boolean|"unknown"}
 */
function checkMissingCombinedGitIgnore(cwd, path, extraExclude) {
  const standard = checkGitIgnore(cwd, path);
  if (!extraExclude || standard === "unknown") return standard;
  const temporaryWorktree = mkdtempSync(join(tmpdir(), "intent-factory-ignore-check-"));
  try {
    execFileSync("git", ["init", "-q", temporaryWorktree], { stdio: ["ignore", "ignore", "ignore"] });
    const temporaryGit = resolve(temporaryWorktree, ".git");
    writeFileSync(resolve(temporaryGit, "info", "exclude"), readFileSync(extraExclude), { mode: 0o600 });
    const args = ["--git-dir", temporaryGit, "--work-tree", temporaryWorktree, "-c", `core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "check-ignore", "--no-index", "--verbose", "--", path];
    let customMatched;
    try {
      execFileSync("git", args, { stdio: ["ignore", "ignore", "ignore"] });
      customMatched = true;
    } catch (error) {
      if (errorCode(error) !== 1) return "unknown";
      customMatched = false;
    }

    if (!customMatched) return standard;
    try {
      execFileSync("git", args.toSpliced(-3, 1, "--quiet"), { stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch (error) {
      return errorCode(error) === 1 ? false : "unknown";
    }
  } catch {
    return "unknown";
  } finally {
    rmSync(temporaryWorktree, { recursive: true, force: true });
  }
}

/**
 * Ask Git to classify a path even when it does not exist yet. For the
 * optional runner ignore file, temporarily use Git's configured global
 * exclude slot so Git remains the pattern parser.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string|undefined} [extraExclude]
 * @returns {boolean|"unknown"}
 */
function checkGitIgnore(cwd, path, extraExclude) {
  const args = ["-C", cwd];
  if (extraExclude) args.push("-c", `core.excludesFile=${extraExclude}`);
  args.push("check-ignore", "--no-index", "--quiet", "--", path);
  try {
    execFileSync("git", args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch (error) {
    return errorCode(error) === 1 ? false : "unknown";
  }
}

/** @param {unknown} error @returns {number|string|undefined} */
function errorCode(error) {
  if (!error || typeof error !== "object") return undefined;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

/**
 * @param {ValidatedNode} node
 * @param {number} index
 * @returns {string[]}
 */
function commandCoverageWarnings(node, index) {
  if (!Array.isArray(node.definitionOfDone) || node.definitionOfDone.length === 0) return [];
  const dodText = node.definitionOfDone.join("\n");
  const warnings = [];
  const lines = node.taskPacket.verification.map((command) => command.argv.join(" "));
  for (const line of lines) {
    const target = extractCommandTarget(line);
    if (target && !dodText.includes(target)) {
      warnings.push(`nodes[${index}] (${node.id}): command target "${target}" is not mentioned in any Definition of Done item`);
    }
  }
  return warnings;
}

/**
 * @param {string} line
 * @returns {string|null}
 */
function extractCommandTarget(line) {
  const trimmed = line.trim();
  const patterns = [
    [/^cargo test\b/u, /cargo test(?:\s+\S+)*\s+([a-z_]+::[a-z_:]+)/u],
    [/^pnpm exec vitest run\b/u, /vitest run\s+(\S+)/u],
    [/^(?:pnpm exec )?playwright test\b/u, /playwright test\s+(\S+)/u],
    [/^node\s+/u, /^node\s+(\S+\.(?:mjs|js))/u],
    [/^(?:pnpm|npm) run\s+/u, /^(?:pnpm|npm) run\s+(\S+)/u],
  ];
  for (const [trigger, extract] of patterns) {
    if (!trigger.test(trimmed)) continue;
    return extract.exec(trimmed)?.[1] ?? null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {unknown} id
 * @param {string} label
 */
function requireRuntime(runtimes, id, label) {
  if (typeof id !== "string" || !runtimes[id]) throw new TypeError(`${label} names an unknown runtime`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxBytes
 */
function boundedString(value, label, maxBytes) {
  requireString(value, label);
  if (Buffer.byteLength(/** @type {string} */ (value), "utf8") > maxBytes) throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${label} must be an array of strings`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requirePacketHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireInteger(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function nonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive number`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function nonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} max
 * @returns {number}
 */
function boundedNonNegativeNumber(value, label, max) {
  const result = nonNegativeNumber(value, label);
  if (result > max) throw new TypeError(`${label} exceeds ${max}`);
  return result;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} max
 * @returns {number}
 */
function boundedPositiveNumber(value, label, max) {
  const result = positiveNumber(value, label);
  if (result > max) throw new TypeError(`${label} exceeds ${max}`);
  return result;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function validateMaxParallel(value) {
  const parallel = positiveInteger(value, "contract.maxParallel");
  if (parallel > 1) throw new TypeError("contract.maxParallel must be 1 until filesystem isolation exists");
  return parallel;
}
