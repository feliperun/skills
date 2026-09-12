/**
 * The usage and cost ledger: `usage.jsonl`, one record per invocation, and the
 * arithmetic that rolls it up onto a node.
 *
 * Reporting only. No control path reads this -- a spent allowance is handled by
 * runtime re-tiering, never by a token or dollar cap -- and that is why a usage
 * the provider did not report stays null instead of becoming a plausible zero.
 */
import { appendJsonl } from "./store.mjs";
import { basename, join } from "node:path";
import { errorMessage, stableJson } from "../util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { liveUsage } from "../harnesses/exec-jsonl/index.mjs";
import { normalizeProviderResult } from "../engine/prompts.mjs";
import { readBoundedTail } from "../engine/process.mjs";
import { writeNode } from "../engine/state.mjs";

/** @typedef {import("../engine/process.mjs").Invocation} Invocation */
/** @typedef {import("../engine/process.mjs").Job} Job */
/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {{kind: "adopted"|"rejudge"|"restart"|"reconciled"|"exhausted"|"stalled", phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, error?: {code: string, message: string}|null, invocationId?: string, reason?: string}} RecoveryOutcome */
/** @typedef {import("../contract/index.mjs").Usage} Usage */

/**
 * Extract the invocation's provider envelope from the bounded transcript tail
 * and persist its usage into the matching invocation record. By default the
 * usage is also accumulated into `state.usage` (the caller then transitions or
 * continues); with `accumulate: false` only the invocation record is updated,
 * for jobs whose node already reached a terminal state that already counted
 * this spend.
 *
 * @param {Job} job
 * @param {{accumulate?: boolean}} [options]
 * @returns {ProviderEnvelope}
 */
export function recordInvocationUsage(job, options = {}) {
  const { state } = job;
  /** @type {ProviderEnvelope} */
  let envelope;
  let boundedStdout = "";
  try {
    boundedStdout = readBoundedTail(job.paths.stdout);
    const boundedStderr = readBoundedTail(job.paths.stderr, 512 * 1024);
    envelope = normalizeProviderResult(job.runtime, boundedStdout, job.exitCode, job.signal, {
      preferStructured: job.phase === "judge",
      stderr: boundedStderr,
    });
  } catch (error) {
    envelope = {
      status: "failed",
      result: null,
      continuationId: null,
      usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null },
      costUsd: null,
      error: { code: "invalid_output", message: errorMessage(error) },
    };
  }
  // Failure envelopes carry zeroed usage (a killed provider emits no terminal
  // event), yet its transcript holds real per-turn counters. Backfill the
  // normalized usage components from the live meter so kills, timeouts, and
  // scope failures still report what they spent, cache reads separated.
  if (envelope.usage.inputTokens === null && boundedStdout) {
    const observed = liveUsage(job.runtime.harness, boundedStdout);
    if (observed.inputTokens !== null) {
      envelope = { ...envelope, usage: { ...envelope.usage, inputTokens: observed.inputTokens, cacheReadInputTokens: observed.cacheReadInputTokens } };
    }
  }
  state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === job.invocation.id
    ? { ...invocation, usage: envelope.usage }
    : invocation);
  if (options.accumulate !== false) state.usage = addUsage(state.usage, envelope.usage);
  return envelope;
}
const USAGE_LOG_NAME = "usage.jsonl";
/** @param {Usage|undefined} usage @returns {boolean} */
function hasMeasuredUsage(usage) {
  return Boolean(usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens]
    .some((value) => typeof value === "number" && Number.isFinite(value)));
}
/** @param {NodeSnapshot} state @returns {Usage} */
export function invocationUsage(state) {
  const seen = new Set();
  return (state.invocations ?? []).reduce((total, invocation) => {
    if (invocation.id && seen.has(invocation.id)) return total;
    if (invocation.id) seen.add(invocation.id);
    return addUsage(total, invocation.usage);
  }, /** @type {Usage} */ ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }));
}
/** @param {NodeSnapshot} state @returns {number|undefined} */
export function invocationCost(state) {
  const costs = /** @type {number[]} */ ((state.invocations ?? [])
    .map((invocation) => invocation.costUsd)
    .filter((cost) => typeof cost === "number" && Number.isFinite(cost)));
  return costs.length ? costs.reduce((total, cost) => total + cost, 0) : undefined;
}
/**
 * Invocation ids already present in the run's usage.jsonl. The append path
 * uses this to stay idempotent across resume and replay.
 *
 * @param {string} runDir
 * @returns {Set<string>}
 */
export function usageRecordIds(runDir) {
  const ids = new Set();
  const path = join(runDir, USAGE_LOG_NAME);
  if (!existsSync(path)) return ids;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const value = record && typeof record === "object" && !Array.isArray(record)
        ? /** @type {Record<string, unknown>} */ (record)
        : null;
      if (value && typeof value.invocationId === "string") ids.add(value.invocationId);
    } catch {
      // A truncated tail line is repaired by appendJsonl on the next write.
    }
  }
  return ids;
}
/**
 * Append one usage.jsonl record for a worker or judge invocation. Usage is a
 * reporting record only: no control path reads this file to gate work.
 *
 * @param {string} runDir
 * @param {Invocation|undefined|null} invocation
 */
export function appendUsageRecord(runDir, invocation) {
  if (!invocation?.id || usageRecordIds(runDir).has(invocation.id)) return;
  const usage = /** @type {Usage} */ (invocation.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
  appendJsonl(join(runDir, USAGE_LOG_NAME), {
    invocationId: invocation.id,
    runId: invocation.runId ?? basename(runDir),
    nodeId: invocation.nodeId ?? null,
    attempt: invocation.attempt ?? null,
    role: invocation.role ?? null,
    runtimeId: invocation.runtimeId ?? null,
    model: invocation.model ?? null,
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
    cacheReadInputTokens: typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : null,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
    costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
    costProvenance: typeof invocation.costUsd === "number" ? "provider" : "unknown",
    startedAt: invocation.startedAt ?? null,
    finishedAt: invocation.closedAt ?? null,
  });
}
/**
 * Recovery can discover usage after the run synchronized its records. Attach
 * it to the authoritative invocation first, then write the updated usage
 * record. The invocation id makes repeated resumes idempotent.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {RecoveryOutcome|null|undefined} recovery
 * @param {LockHandle} lock
 * @returns {Promise<void>}
 */
export async function persistRecoveryUsage(runDir, state, recovery, lock) {
  if (!recovery?.invocationId) return;
  const current = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
  if (!current) return;
  const usage = hasMeasuredUsage(current.usage) ? current.usage : recovery.usage;
  const costUsd = typeof current.costUsd === "number" ? current.costUsd : recovery.costUsd;
  const changed = stableJson(current.usage) !== stableJson(usage)
    || current.costUsd !== (costUsd ?? null);
  if (changed) {
    state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === current.id
      ? { ...invocation, usage, costUsd: costUsd ?? null }
      : invocation);
    state.usage = invocationUsage(state);
    writeNode(runDir, state, lock);
  }
  const updated = state.invocations?.find((invocation) => invocation.id === current.id);
  if (updated) appendUsageRecord(runDir, updated);
}
/**
 * @param {Usage|undefined} left
 * @param {Usage|undefined} right
 * @returns {Usage}
 */
function addUsage(left, right) {
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    cacheReadInputTokens: (left?.cacheReadInputTokens ?? 0) + (right?.cacheReadInputTokens ?? 0),
  };
}
/** @returns {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} */
export function emptyUsage() {
  return { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
}
