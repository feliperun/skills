import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskPacket, renderWorkerPrompt } from "./task-packet.mjs";
import { validateWorkerResult } from "./worker-result.mjs";
import { normalizeManagedSignalBlock } from "../repo/signal-block.mjs";
import { validateDefinitionOfDone } from "./definition-of-done.mjs";
import { validateFinalVerification, validateVerificationSnapshot } from "./final-verification.mjs";
import { MAX_SCOPE_FINDING_PATHS } from "./scope-findings.mjs";
import { REVIEW_MODES } from "./review-modes.mjs";
import { VERIFICATION_LIMITS } from "./verification.mjs";
import {
  INTENT_FACTORY_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  harnessCapabilities,
  resolvePermissionExecution,
  resolveVendor,
  validateCapabilityRequirements,
} from "../harnesses/index.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS, composeAssignments } from "../engine/runtime-discovery.mjs";
import { errorCode, exitStatus, stableJson } from "../util.mjs";
import { assertObject, boundedString, nonNegativeInteger, nonNegativeNumber, positiveInteger, positiveNumber, rejectUnknown, requireId, requireInteger, requirePacketHash, requireString, requireStringArray, requireTimestamp } from "./assert.mjs";
import { validateMetadata } from "./schema-version.mjs";
import { assertRuntimeExecutesCommands, requireRuntime, validateRuntime, validateSnapshotRuntime } from "./runtime.mjs";
import { validateCompleteSourceIdentity, validateSourceIdentity } from "./source-identity.mjs";
import { commandCoverageWarnings, unsnapshottedWriteWarnings } from "../repo/declared-paths.mjs";

export { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION } from "../harnesses/index.mjs";

const CONTRACT_FIELDS = new Set([
  "schemaVersion", "contractVersion", "id", "campaignId", "goal", "cwd", "sourceIdentity",
  "maxParallel", "pollIntervalMs", "stallTimeoutSec", "timeoutSec",
  "runtimeDefaults", "runtimes", "nodes", "warnings", "finalVerification",
]);
const DEFAULTS_FIELDS = new Set(["worker", "judge"]);
const NODE_FIELDS = new Set([
  "id", "type", "phase", "runtime", "dependsOn", "taskPacket", "taskPacketFile", "prompt", "promptFile",
  "definitionOfDone", "gate", "timeoutSec",
  "requiredCapabilities", "packetHash", "sourceIdentity", "replayPolicy",
]);
const REPLAY_POLICIES = new Set(["safe", "reconcile", "never"]);
const GATE_FIELDS = new Set(["enabled", "runtime", "review", "failOn", "maxRevisions", "requiredCapabilities"]);
const GATE_REVIEWS = new Set(["none", "advisory", "blocking"]);

/** @typedef {Record<string, unknown>} JsonObject */

/** @typedef {{structuredOutput?: boolean, promptTransport?: "stdin"|"argv", sandbox?: boolean, permissions?: boolean, continuation?: boolean, tokenBudget?: boolean, costBudget?: boolean, usage?: boolean, cost?: boolean}} CapabilityRequirements */

/** @typedef {{kind: string, id?: string, campaignId?: string, contractId?: string, nodeId?: string, cwd?: string, gitHead?: string|null, dirtyTreeFingerprint?: string|null, packetHashes?: Record<string, string>, harnessVersions?: Record<string, string|null>}} SourceIdentity */

/** @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[]}} VerificationCommand */

/** @typedef {{mode: "execution"|"discovery"|"autonomous", objective: string, instructions: string[], readFiles: string[], writeFiles?: string[], writeRoots?: string[], symbols: string[], decisions: string[], nonGoals: string[], verification: VerificationCommand[]}} TaskPacket */

/** @typedef {{harness: "claude"|"codex"|"agy"|"dsh"|"zcode"|"exec-jsonl"|"replay", model: string, reasoning?: string, sandbox?: "read-only"|"workspace-write"|"danger-full-access", permissionMode?: string, config?: Record<string, unknown>, printTimeout?: string, tools?: string[], executable?: string, args?: string[], versionArgs?: string[], maxArgvPromptBytes?: number, requiredCapabilities?: CapabilityRequirements, costRank?: number, fallback?: string, vendor: string, tier?: number|string}} ValidatedRuntime */

/** @typedef {{enabled: boolean, review?: ("none"|"advisory"|"blocking"), runtime?: string, failOn?: ("minor"|"major"|"critical")[], maxRevisions?: number, requiredCapabilities?: CapabilityRequirements}} ValidatedGate */

/** @typedef {{id: string, type: string, phase: string, runtime?: string, dependsOn: string[], taskPacket: TaskPacket, taskPacketFile?: string, prompt: string, definitionOfDone: import("./definition-of-done.mjs").DefinitionOfDoneItem[], gate: ValidatedGate, timeoutSec?: number, requiredCapabilities: CapabilityRequirements, packetHash: string, sourceIdentity: SourceIdentity, replayPolicy: "safe"|"reconcile"|"never"}} ValidatedNode */

/** @typedef {{schemaVersion: number, contractVersion: string, id: string, campaignId: string, goal: string, cwd: string, sourceIdentity: SourceIdentity, runtimes: Record<string, ValidatedRuntime>, runtimeDefaults: {worker?: string, judge?: string}, nodes: ValidatedNode[], maxParallel: number, pollIntervalMs: number, stallTimeoutSec: number, timeoutSec: number, finalVerification?: VerificationCommand[], warnings: string[]}} ValidatedContract */

/** @typedef {"pending"|"running"|"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"} NodeStatus */
/** @typedef {"waiting"|"worker"|"judge"|"complete"|"dependency"|"canceled"} NodePhase */
/** @typedef {{severity: "minor"|"major"|"critical", description: string, evidence: string}} Finding */
/** @typedef {{verdict: "pass"|"fail"|"invalid_judge_output", maxSeverity: "none"|"minor"|"major"|"critical", summary: string, findings: Finding[]}} GateResult */
/** @typedef {{code: string, message: string, exhaustedUntil?: string|null}} SnapshotError */
/** @typedef {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} Usage */
/** @typedef {ValidatedRuntime & {id: string, capabilities: import("../harnesses/index.mjs").HarnessCapabilities}} RuntimeSnapshot */
/** @typedef {import("../engine/lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./verification.mjs").VerificationCommandResult} VerificationCommandResult */
/** @typedef {import("./verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {{passed: boolean, commands?: VerificationCommandResult[], completed?: boolean, error?: string, attempts?: VerificationAttempt[]}} VerificationState */
/** @typedef {{kind: "recovery"|"timeout"|"rotation", decision?: string, invocationId?: string, phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, reason?: string, timeoutSec?: number, at?: string}} ExecutionOverride */
/** @typedef {{literal: string, paths: string[]}} WorkspaceScopeOrigin */
/** @typedef {{schemaVersion: 1, files: string[], roots: string[], fileRoots?: string[], fileOrigins: WorkspaceScopeOrigin[], rootOrigins: WorkspaceScopeOrigin[]}} WorkspaceScopeBoundary */
/** @typedef {{changedPaths: string[], unexpectedPaths: string[], changedPathCount: number, unexpectedPathCount: number, truncated: boolean, boundary?: WorkspaceScopeBoundary}} BoundedScope */
/** @typedef {{unexpectedPaths: string[]}} ScopeFindings */
/** @typedef {{at: string, role: "worker"|"judge", runtime: string, nextRuntime?: string, rule?: number, ruleIndex?: number, revision?: number, hop?: number, status?: NodeStatus, errorCode?: string, backoffSec?: number, backoffUntil?: string, usage?: Usage, costUsd?: number|null}} RoutingHistoryEntry */
/** @typedef {{at: string, role: "worker"|"judge", runtime: string, nextRuntime?: string, rule?: number, ruleIndex?: number, revision?: number, hop?: number, reason: string, backoffSec?: number, backoffUntil?: string, usage?: Usage, costUsd?: number|null}} RoutingOverride */
/** @typedef {{worker: string, judge: string, composedWorker?: boolean, composedJudge?: boolean}} RuntimeAssignments */
/** @typedef {{available: boolean, exhaustedUntil: string|null, reason: string}} RuntimeAvailability */
/** @typedef {{history: RoutingHistoryEntry[], currentOverride: RoutingOverride|null, assignments?: RuntimeAssignments, availability?: Record<string, RuntimeAvailability>}} RoutingState */
/** @typedef {{revision?: number, heartbeatCount: number, dryHeartbeatCount: number, progressSignature?: string|null, lastHeartbeatAt: string|null, lastProgressAt: string|null, nextCheckAt?: string|null}} ProgressState */
/** @typedef {{status: "unassigned"|"provisioning"|"ready"|"failed"|"removed", path: string|null, branch: string|null, commit: string|null, baseSha?: string|null, previousAttempt?: number|null}} WorktreeState */
/** @typedef {{schemaVersion: number, contractVersion: string, id: string, type: string, sourceIdentity: SourceIdentity, packetHash: string, status: NodeStatus, phase: NodePhase, attempt: number, revisions: number, judgeFailures?: number, review?: ("none"|"advisory"|"blocking"), runtime: RuntimeSnapshot|null, blockedBy: string[], startedAt: string|null, updatedAt: string, result: unknown, gate: GateResult|null, error: SnapshotError|null, usage?: Usage, costUsd?: number, routing?: RoutingState|null, progress?: ProgressState|null, worktree?: WorktreeState|null, integratedHead?: string|null, invocations?: Invocation[], executionOverrides?: ExecutionOverride[], verification?: VerificationState|null, scope?: BoundedScope|null, scopeFindings?: ScopeFindings|null, previousAttempt?: string}} NodeSnapshot */
/** @typedef {{schemaVersion: number, contractVersion: string, pid: number, processStartToken: string|null, startedAt: string, sourceIdentity: SourceIdentity, integrationRef?: string, identityWarnings?: string[]}} RunMetadata */
/** @typedef {{schemaVersion: number, contractVersion: string, at: string, node: string, from?: string, to: string, type?: string, phase?: string, attempt?: number, role?: "worker"|"judge", status?: NodeStatus, runtime?: string, currentRuntime?: string, errorCode?: string, error?: SnapshotError, verdict?: string, summary?: string, revisions?: number, sourceIdentity: SourceIdentity, packetHash: string, override?: unknown, recovery?: unknown, invocationId?: string, unexpectedPaths?: string[], unexpectedPathCount?: number}} EventRecord */

/**
 * Validate and canonicalize the versioned contract. Runtime JSON remains
 * authoritative; JSDoc types document the validated shape only.
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

  const contractDir = dirname(resolve(contractPath));
  const cwd = resolve(contractDir, typeof raw.cwd === "string" ? raw.cwd : ".");
  if (!statSync(cwd).isDirectory()) throw new TypeError("contract.cwd must be a directory");

  const sourceIdentity = validateSourceIdentity(
    raw.sourceIdentity ?? { kind: "contract", id: raw.id, campaignId: raw.campaignId },
    "contract.sourceIdentity",
    { kind: "contract", id: raw.id, campaignId: raw.campaignId },
  );

  const rawRuntimes = /** @type {Record<string, JsonObject>} */ (raw.runtimes ?? DISCOVERY_RUNTIME_DEFINITIONS);
  if (!rawRuntimes || typeof rawRuntimes !== "object" || Array.isArray(rawRuntimes)) {
    throw new TypeError("contract.runtimes must be an object");
  }
  const runtimes = /** @type {Record<string, ValidatedRuntime>} */ ({});
  for (const [id, runtime] of Object.entries(rawRuntimes)) runtimes[id] = validateRuntime(id, runtime);
  // A runtime's fallback is validated against sibling runtimes once every
  // runtime is known, so declaration order never matters.
  for (const [id, runtime] of Object.entries(runtimes)) {
    if (runtime.fallback === undefined) continue;
    if (runtime.fallback === id) throw new TypeError(`runtime ${id}.fallback cannot name itself`);
    requireRuntime(runtimes, runtime.fallback, `runtime ${id}.fallback`);
  }

  const defaults = /** @type {JsonObject} */ (raw.runtimeDefaults ?? {});
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new TypeError("contract.runtimeDefaults must be an object when provided");
  }
  rejectUnknown(defaults, DEFAULTS_FIELDS, "contract.runtimeDefaults");
  if (defaults.worker !== undefined) requireRuntime(runtimes, defaults.worker, "runtimeDefaults.worker");
  if (defaults.judge !== undefined) requireRuntime(runtimes, defaults.judge, "runtimeDefaults.judge");

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
    const definitionOfDone = validateDefinitionOfDone(
      node.definitionOfDone ?? [],
      `nodes[${index}].definitionOfDone`,
      {
        // A `verification` proof names an entry of this packet's verification
        // array by position and reuses its recorded result at gate time; an
        // entry the node snapshot cannot record could never be reused.
        verificationCount: taskPacket.verification.length,
        recordableCount: VERIFICATION_LIMITS.stateCommands,
      },
    );
    const requiredCapabilities = validateCapabilityRequirements(
      /** @type {import("../harnesses/index.mjs").CapabilityRequirements|undefined} */ (node.requiredCapabilities),
      `nodes[${index}].requiredCapabilities`,
    );
    const gate = validateGate(node.gate, runtimes, index, /** @type {string} */ (node.id));
    const timeoutSec = node.timeoutSec === undefined
      ? undefined
      : positiveNumber(node.timeoutSec, `nodes[${index}].timeoutSec`);
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

  // A gated node whose worker and judge share a vendor cannot produce an
  // independent review — the same vendor grading its own output is not a
  // gate, so this is rejected outright rather than left to reach dispatch.
  // The worker's declared fallback chain is checked the same way, since it is
  // statically known which runtime a worker failover lands on; the symmetric
  // case — the judge's own fallback landing on the worker's vendor — depends
  // on which worker runtime actually ran and is refused at execution instead
  // (node.mjs, `judge_fallback_vendor_conflict`).
  for (const [index, node] of nodes.entries()) {
    if (!node.gate.enabled) continue;
    const workerRuntimeId = node.runtime ?? defaults.worker;
    const judgeRuntimeId = node.gate.runtime ?? defaults.judge;
    if (!workerRuntimeId || !judgeRuntimeId) continue;
    const workerVendor = runtimes[/** @type {string} */ (workerRuntimeId)].vendor;
    const judgeVendor = runtimes[/** @type {string} */ (judgeRuntimeId)].vendor;
    if (workerVendor === judgeVendor) {
      throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} and judge runtime ${judgeRuntimeId} share vendor ${workerVendor}`);
    }
    const seenFallbacks = new Set([/** @type {string} */ (workerRuntimeId)]);
    let fallbackId = runtimes[/** @type {string} */ (workerRuntimeId)].fallback;
    while (fallbackId !== undefined) {
      if (seenFallbacks.has(fallbackId)) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback chain cycles back to ${fallbackId}`);
      }
      seenFallbacks.add(fallbackId);
      const fallbackVendor = runtimes[fallbackId].vendor;
      if (fallbackVendor === judgeVendor) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback runtime ${fallbackId} and judge runtime ${judgeRuntimeId} share vendor ${fallbackVendor}`);
      }
      fallbackId = runtimes[fallbackId].fallback;
    }
  }

  // Every worker prompt tells the worker to run its packet verification.
  // Refuse a statically known permission mode that makes that instruction
  // impossible, including every reachable worker fallback. Judges only review
  // captured results, so their permission mode is intentionally irrelevant.
  for (const [index, node] of nodes.entries()) {
    if (node.taskPacket.verification.length === 0) continue;
    const workerRuntimeId = node.runtime ?? defaults.worker;
    if (!workerRuntimeId) continue;
    assertRuntimeExecutesCommands(runtimes, /** @type {string} */ (workerRuntimeId), index, node.id, "worker runtime");
    const seenFallbacks = new Set([/** @type {string} */ (workerRuntimeId)]);
    let fallbackId = runtimes[/** @type {string} */ (workerRuntimeId)].fallback;
    while (fallbackId !== undefined && !seenFallbacks.has(fallbackId)) {
      seenFallbacks.add(fallbackId);
      assertRuntimeExecutesCommands(runtimes, fallbackId, index, node.id, "worker fallback runtime");
      fallbackId = runtimes[fallbackId].fallback;
    }
  }

  const warnings = nodes.flatMap((node, index) => [...commandCoverageWarnings(node, index), ...unsnapshottedWriteWarnings(node, index, cwd)]);
  return /** @type {ValidatedContract} */ ({
    ...raw,
    schemaVersion: /** @type {number} */ (raw.schemaVersion),
    contractVersion: /** @type {string} */ (raw.contractVersion),
    sourceIdentity,
    cwd,
    runtimes,
    runtimeDefaults: /** @type {{worker?: string, judge?: string}} */ (defaults),
    nodes,
    maxParallel: validateMaxParallel(raw.maxParallel ?? 1),
    pollIntervalMs: positiveInteger(raw.pollIntervalMs ?? 1_000, "contract.pollIntervalMs"),
    stallTimeoutSec: positiveNumber(raw.stallTimeoutSec ?? 300, "contract.stallTimeoutSec"),
    timeoutSec: positiveNumber(raw.timeoutSec ?? 2_400, "contract.timeoutSec"),
    finalVerification: validateFinalVerification(raw.finalVerification, "contract.finalVerification"),
    warnings,
  });
}

/**
 * Stable hash for the exact validated packet content.
 *
 * @param {TaskPacket} packet
 * @returns {string}
 */
export function hashPacket(packet) {
  return createHash("sha256").update(stableJson(packet)).digest("hex");
}

/**
 * @param {unknown} gate
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {number} index
 * @param {string} nodeId
 * @returns {ValidatedGate}
 */
function validateGate(gate, runtimes, index, nodeId) {
  const label = `nodes[${index}] (${nodeId})`;
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
  if (gate.review !== undefined && !GATE_REVIEWS.has(/** @type {string} */ (gate.review))) {
    throw new TypeError(`nodes[${index}].gate.review must be none, advisory, or blocking`);
  }
  const review = /** @type {("none"|"advisory"|"blocking")} */ (gate.review ?? "advisory");
  if (gate.runtime !== undefined) requireRuntime(runtimes, gate.runtime, `nodes[${index}].gate.runtime`);
  const failOnValue = /** @type {unknown} */ (gate.failOn ?? ["critical"]);
  if (!Array.isArray(failOnValue) || failOnValue.some((value) => !["minor", "major", "critical"].includes(value))) {
    throw new TypeError(`nodes[${index}].gate.failOn contains an invalid severity`);
  }
  const failOn = /** @type {("minor"|"major"|"critical")[]} */ (failOnValue);
  // The runner compares the verdict severity against this set by exact
  // membership, so `["major"]` admits a critical finding: the threshold set
  // has to be closed downwards (TECH-SPEC lean, rule 2).
  if (failOn.includes("major") && !failOn.includes("critical")) {
    throw new TypeError(`${label}: gate.failOn lists major without critical, and the gate checks exact membership, so a critical finding would pass (TECH-SPEC lean, rule 2)`);
  }
  // A blocking review that never fails on a major can never reject one, so it
  // is not a review at all. Advisory review ignores failOn and may declare any.
  if (review === "blocking" && !failOn.includes("major")) {
    throw new TypeError(`${label}: gate.review blocking requires major in gate.failOn (TECH-SPEC lean, rule 2)`);
  }
  return {
    enabled: true,
    review,
    runtime: /** @type {string|undefined} */ (gate.runtime),
    failOn,
    maxRevisions: nonNegativeInteger(gate.maxRevisions ?? 1, `nodes[${index}].gate.maxRevisions`),
    requiredCapabilities: validateCapabilityRequirements(
      /** @type {import("../harnesses/index.mjs").CapabilityRequirements|undefined} */ (gate.requiredCapabilities),
      `nodes[${index}].gate.requiredCapabilities`,
    ),
  };
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

/**
 * @param {unknown} value
 * @returns {number}
 */
function validateMaxParallel(value) {
  // Filesystem isolation (attempt worktrees) exists now, so nothing caps this
  // beyond being a sane positive integer.
  return positiveInteger(value, "contract.maxParallel");
}
