/**
 * A node's persisted state and the event log beside it: every status change goes
 * through `transition`, which writes the snapshot and appends one event.
 *
 * `ensureTerminalEvent` exists because a crash can leave a node terminal on disk
 * with no event recorded for it, and the campaign readers project from events.
 */
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION } from "../harnesses/index.mjs";
import { TERMINAL } from "./prompts.mjs";
import { appendJsonl } from "../run/store.mjs";
import { excerpt } from "../util.mjs";
import { hasOperationSettlement, operationNextState, settleInvocation } from "../run/operations.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { validateEvent, validateNodeSnapshot } from "../contract/index.mjs";
import { writeRunTextWithDiskPressureRetry } from "../run/disk-gc.mjs";

/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {import("../contract/index.mjs").NodeStatus} status
 * @param {Record<string, unknown>} [patch]
 * @param {LockHandle|null} [lock]
 */
export function transition(runDir, state, status, patch = {}, lock = null) {
  lock?.assert();
  const from = state.status;
  const updatedAt = new Date().toISOString();
  Object.assign(state, patch, { status, updatedAt });
  writeNode(runDir, state, lock);
  if (status === "done" && process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT === "after-state") {
    throw new Error("integration interrupted after node state write");
  }
  const invocation = state.invocations?.at(-1);
  if (invocation && hasOperationSettlement(runDir, invocation.id)) {
    settleInvocation(runDir, invocation, { nextState: operationNextState(state) });
  }
  appendTransitionEvent(runDir, state, from, status, {}, lock);
  if (TERMINAL.has(status)) {
    const note = state.gate?.summary ?? resultSummary(state.result) ?? state.error?.message;
    process.stdout.write(`[node] ${state.id} ${status}${note ? ` · ${note}` : ""}\n`);
  }
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle|null} [lock]
 */
export function ensureTerminalEvent(runDir, state, lock = null) {
  if (!hasDoneEvent(runDir, state.id, state.attempt)) {
    appendTransitionEvent(runDir, state, "done", "done", { recovery: "terminal side effects replayed" }, lock);
  }
}
/**
 * Whether a `done` transition for this node and attempt was already durably
 * recorded, at any point in the past. This is the idempotent signal for "this
 * attempt's integration effects were already fully applied at least once" —
 * a later, unrelated change to the node's current status is not evidence
 * that they need reapplying.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {number} attempt
 * @returns {boolean}
 */
export function hasDoneEvent(runDir, nodeId, attempt) {
  let text = "";
  try { text = readFileSync(join(runDir, "events.jsonl"), "utf8"); } catch {}
  return text.split("\n").filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line);
      return event.node === nodeId && event.to === "done" && event.attempt === attempt;
    } catch {
      return false;
    }
  });
}
/**
 * @param {unknown} result
 * @returns {string|null}
 */
function resultSummary(result) {
  if (typeof result === "object" && result !== null && "summary" in result) {
    const summary = /** @type {{summary?: unknown}} */ (result).summary;
    if (typeof summary === "string") return summary;
  }
  return typeof result === "string" && result ? excerpt(result) : null;
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {string} from
 * @param {string} to
 * @param {Record<string, unknown>} [details]
 * @param {LockHandle|null} [lock]
 */
export function appendTransitionEvent(runDir, state, from, to, details = {}, lock = null) {
  lock?.assert();
  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    at: state.updatedAt,
    node: state.id,
    sourceIdentity: state.sourceIdentity,
    packetHash: state.packetHash,
    from,
    to,
    phase: state.phase,
    ...details,
  };
  if (state.attempt) event.attempt = state.attempt;
  if (state.runtime?.id) event.runtime = state.runtime.id;
  if (state.error?.code) event.error = state.error.code;
  if (state.gate?.verdict) event.verdict = state.gate.verdict;
  if (state.gate?.summary) event.summary = state.gate.summary;
  if (state.revisions) event.revisions = state.revisions;
  const invocation = state.invocations?.at(-1);
  if (invocation?.id) event.invocationId = invocation.id;
  validateEvent(event);
  appendJsonl(join(runDir, "events.jsonl"), event);
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {import("../contract/index.mjs").ExecutionOverride} override
 * @param {LockHandle} lock
 */
export function recordExecutionOverride(runDir, state, override, lock) {
  const entry = { ...override, at: override.at ?? new Date().toISOString() };
  state.executionOverrides = [...(state.executionOverrides ?? []), entry];
  writeNode(runDir, state, lock);
  appendTransitionEvent(runDir, state, state.status, state.status, { override: entry, recovery: entry.decision }, lock);
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle|null} [lock]
 */
export function writeNode(runDir, state, lock = null) {
  lock?.assert();
  validateNodeSnapshot(state);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > 128 * 1024) throw new Error("node snapshot exceeds 131072 bytes");
  writeRunTextWithDiskPressureRetry(runDir, join(runDir, "nodes", `${state.id}.json`), `${serialized}\n`);
}
