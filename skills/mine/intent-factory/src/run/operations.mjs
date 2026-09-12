/**
 * The exactly-once ledger: for every provider invocation, an intent written
 * before the process is released and a settlement merged after it closes.
 *
 * The distinction the rest of the system depends on is `settled` versus
 * `unknown_effect`. A settled operation has a known provider outcome. An
 * unknown effect means the request may have run without leaving proof, and it is
 * explicitly NOT permission to retry -- `replayPolicy` and a clean persisted
 * scope decide that, elsewhere.
 */
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { readBoundedTail } from "../engine/process.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";
import { runtimeSnapshot } from "../engine/failover.mjs";
import { normalizeProviderResult } from "../harnesses/index.mjs";

/** @typedef {import("../engine/process.mjs").Invocation} Invocation */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").Usage} Usage */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

const OPERATIONS_SCHEMA_VERSION = 1;
/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {string}
 */
function operationIntentPath(runDir, invocationId) {
  return join(runDir, "operations", `${invocationId}.intent.json`);
}
/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {string}
 */
function operationSettlementPath(runDir, invocationId) {
  return join(runDir, "operations", `${invocationId}.settlement.json`);
}
/**
 * Reserve the operation durably before the gate releases the provider process.
 * The invocation identity is written before spawn and is the only identity
 * later accepted for settlement or recovery.
 *
 * @param {string} runDir
 * @param {Invocation} invocation
 * @param {{nodeId: string, role: "worker"|"judge", attempt: number, runtimeFingerprint: string, prompt: string}} context
 */
export function persistInvocationIntent(runDir, invocation, context) {
  const promptFingerprint = createHash("sha256").update(context.prompt, "utf8").digest("hex");
  writeJsonAtomic(operationIntentPath(runDir, invocation.id), {
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    operationId: invocation.id,
    invocationId: invocation.id,
    runId: invocation.runId ?? basename(runDir),
    campaignId: invocation.campaignId ?? null,
    nodeId: context.nodeId,
    role: context.role,
    phase: invocation.phase,
    planPhase: invocation.planPhase ?? null,
    attempt: context.attempt,
    runtimeId: invocation.runtimeId ?? null,
    runtimeFingerprint: context.runtimeFingerprint,
    promptFingerprint,
    promptHash: promptFingerprint,
    scopeSnapshotPath: context.role === "worker" ? invocation.snapshotPath ?? null : null,
    scopeSnapshotRef: context.role === "worker" ? invocation.snapshotPath ?? null : null,
    startedAt: invocation.startedAt,
    intentAt: new Date().toISOString(),
  });
}
/**
 * Read an operation record without allowing a malformed or mismatched record
 * to become recovery evidence.
 *
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {Record<string, unknown>|null}
 */
export function readOperationSettlement(runDir, invocationId) {
  try {
    const record = readJson(operationSettlementPath(runDir, invocationId));
    return record.operationId === invocationId ? record : null;
  } catch {
    return null;
  }
}
/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {Record<string, unknown>|null}
 */
function readOperationIntent(runDir, invocationId) {
  try {
    const record = readJson(operationIntentPath(runDir, invocationId));
    return record.operationId === invocationId ? record : null;
  } catch {
    return null;
  }
}
/**
 * A preliminary close observation is not a terminal settlement. It can be
 * replaced by the final envelope outcome, while a resolved outcome is never
 * downgraded by a later controller pass.
 */
const UNRESOLVED_OPERATION_STATUSES = new Set(["closed", "unknown_effect"]);
const RESOLVED_OPERATION_STATUSES = new Set(["done", "failed", "exhausted", "stalled", "canceled", "adopted", "rejudge", "restarted", "safe_replay", "reconciled"]);
/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {boolean}
 */
export function operationNeedsRecovery(runDir, invocationId) {
  const settlement = readOperationSettlement(runDir, invocationId);
  return !settlement || UNRESOLVED_OPERATION_STATUSES.has(String(settlement.status));
}
/**
 * @param {Invocation|undefined|string} invocationOrId
 * @param {unknown} supplied
 * @param {unknown[]} existing
 * @returns {Record<string, string>[]}
 */
function operationReceipts(invocationOrId, supplied, existing = []) {
  /** @type {Record<string, string>[]} */
  const receipts = [];
  const seen = new Set();
  /** @type {(kind: string, ref: unknown) => void} */
  const add = (kind, ref) => {
    if (typeof ref !== "string" || ref.length === 0) return;
    const key = `${kind}\u0000${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    receipts.push({ kind, ref });
  };
  for (const receipt of existing) {
    if (receipt && typeof receipt === "object") {
      const record = /** @type {Record<string, unknown>} */ (receipt);
      add(String(record.kind ?? "operation"), String(record.ref ?? ""));
    }
  }
  if (Array.isArray(supplied)) {
    for (const receipt of supplied) {
      if (typeof receipt === "string") add("provider", receipt);
      else if (receipt && typeof receipt === "object") {
        const record = /** @type {Record<string, unknown>} */ (receipt);
        add(String(record.kind ?? "provider"), String(record.ref ?? ""));
      }
    }
  }
  const invocation = invocationOrId && typeof invocationOrId === "object" ? invocationOrId : null;
  if (invocation) {
    add("prompt", invocation.promptPath);
    add("stdout", invocation.stdoutPath);
    add("stderr", invocation.stderrPath);
    if (invocation.phase === "worker") add("scope_snapshot", invocation.snapshotPath);
    add("provider", invocation.continuationId);
  }
  return receipts;
}
/**
 * Provider-side evidence from the close path. The continuation identity the
 * provider returned (thread/session) is a durable receipt for the invocation's
 * external effect; the first terminal settlement must persist it.
 *
 * @param {{continuationId?: string|null}|null|undefined} envelope
 * @returns {Record<string, string>[]}
 */
export function providerReceipts(envelope) {
  const ref = envelope?.continuationId;
  return typeof ref === "string" && ref.length > 0 ? [{ kind: "provider", ref }] : [];
}
/**
 * Provider receipts still recoverable from an invocation's surviving stream
 * tail. A controller-loss window's first terminal settlement must persist
 * them so repeated settlement/recovery stays idempotent and exact-once.
 *
 * @param {ValidatedContract} contract
 * @param {Invocation|undefined} invocation
 * @returns {Record<string, string>[]}
 */
export function providerReceiptsFromInvocationTail(contract, invocation) {
  if (!invocation?.stdoutPath) return [];
  try {
    const runtime = typeof invocation.runtimeId === "string"
      ? runtimeSnapshot(contract, invocation.runtimeId)
      : null;
    if (!runtime) return [];
    const envelope = normalizeProviderResult(
      runtime,
      readBoundedTail(invocation.stdoutPath),
      invocation.exitCode ?? null,
      invocation.signal ?? null,
    );
    return providerReceipts(envelope);
  } catch {
    return [];
  }
}
/** @param {unknown} value @returns {unknown|null} */
function boundedSettlementResult(value) {
  if (value === undefined || value === null) return null;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 64 * 1024) return null;
    return value;
  } catch {
    return null;
  }
}
/** @param {NodeSnapshot} state @returns {Record<string, unknown>} */
export function operationNextState(state) {
  return {
    status: state.status,
    phase: state.phase,
    attempt: state.attempt,
    revisions: state.revisions,
  };
}
/**
 * Persist a settlement as an idempotent operation record. The operation keeps
 * its first settledAt timestamp, merges receipts, and retains unknown-effect
 * classification while the controller resolves it.
 *
 * @param {string} runDir
 * @param {Invocation|string} invocationOrId
 * @param {{status?: string, usage?: import("../contract/index.mjs").Usage|null, costUsd?: number|null, structuredResult?: boolean|null, result?: unknown, receipts?: unknown, nextState?: unknown, terminalOutcome?: unknown, unknownEffect?: boolean, classification?: string, reason?: string, error?: unknown}} settlement
 */
export function settleInvocation(runDir, invocationOrId, settlement) {
  const invocation = typeof invocationOrId === "object" ? invocationOrId : undefined;
  const invocationId = typeof invocationOrId === "string" ? invocationOrId : invocation?.id;
  if (!invocationId) throw new TypeError("settlement requires an invocation identity");
  const previous = readOperationSettlement(runDir, invocationId) ?? {};
  const intent = readOperationIntent(runDir, invocationId) ?? {};
  const requestedStatus = settlement.status ?? String(previous.status ?? "unknown_effect");
  const previousStatus = String(previous.status ?? "");
  const status = RESOLVED_OPERATION_STATUSES.has(previousStatus)
    && ["adopted", "rejudge", "restarted"].includes(requestedStatus)
    ? previousStatus
    : requestedStatus;
  const receipts = operationReceipts(invocationOrId, settlement.receipts, Array.isArray(previous.receipts) ? previous.receipts : []);
  const result = settlement.result !== undefined
    ? boundedSettlementResult(settlement.result)
    : previous.result ?? null;
  const record = {
    ...previous,
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    operationId: invocationId,
    invocationId,
    runId: invocation?.runId ?? intent.runId ?? basename(runDir),
    campaignId: invocation?.campaignId ?? intent.campaignId ?? null,
    nodeId: intent.nodeId ?? null,
    role: invocation?.role ?? intent.role ?? null,
    status,
    terminalOutcome: settlement.terminalOutcome ?? previous.terminalOutcome ?? status,
    usage: settlement.usage !== undefined ? settlement.usage : previous.usage ?? null,
    costUsd: settlement.costUsd !== undefined ? settlement.costUsd : previous.costUsd ?? null,
    receipts,
    nextState: settlement.nextState !== undefined ? settlement.nextState : previous.nextState ?? null,
    structuredResult: settlement.structuredResult !== undefined ? settlement.structuredResult : previous.structuredResult ?? null,
    result,
    unknownEffect: settlement.unknownEffect ?? previous.unknownEffect ?? status === "unknown_effect",
    classification: settlement.classification ?? previous.classification ?? null,
    reason: settlement.reason ?? previous.reason ?? null,
    error: settlement.error ?? previous.error ?? null,
    settledAt: previous.settledAt ?? new Date().toISOString(),
  };
  writeJsonAtomic(operationSettlementPath(runDir, invocationId), record);
}
/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {boolean}
 */
export function hasOperationIntent(runDir, invocationId) {
  return existsSync(operationIntentPath(runDir, invocationId));
}
/**
 * @param {string} runDir
 * @param {string} invocationId
 * @returns {boolean}
 */
export function hasOperationSettlement(runDir, invocationId) {
  return existsSync(operationSettlementPath(runDir, invocationId));
}
