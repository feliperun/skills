/**
 * The worker result sidecar: the file a worker writes its structured outcome
 * into, and everything needed to find, read, canonicalise and clear it.
 *
 * It is a file and not the provider's final message because a provider's last
 * message is prose it may decorate, truncate or repeat. A worker in an attempt
 * worktree writes into that worktree, so the result has to be materialised back
 * into the run directory -- which is what `materializeAttemptResult` and the
 * result-materialization invocation are for.
 */
import { attemptWorkspace } from "../repo/worktree.mjs";
import { errorCode, errorMessage } from "../util.mjs";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { extractJson } from "../harnesses/protocol.mjs";
import { invocationResult } from "./process.mjs";
import { join } from "node:path";
import { parseJudge } from "./prompts.mjs";
import { parseWorkerResult } from "../contract/worker-result.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../run/store.mjs";
import { routeRuntimeForState, runtimeSnapshot } from "./failover.mjs";

/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/worker-result.mjs").WorkerResult} WorkerResult */

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {string}
 */
export function workerResultPath(runDir, nodeId) {
  return join(runDir, "results", `${nodeId}.json`);
}
/** @param {string} runDir @param {string} nodeId @param {string} workspace @returns {string} */
export function attemptWorkerResultPath(runDir, nodeId, workspace) {
  return join(workspace, ".runs", "results", `${nodeId}.json`);
}
/** @param {string} workspace @param {string} nodeId */
export function clearAttemptWorkerResult(workspace, nodeId) {
  try { unlinkSync(attemptWorkerResultPath("", nodeId, workspace)); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
/** @param {string} runDir @param {NodeSnapshot} state @param {ValidatedNode} node */
export function materializeAttemptResult(runDir, state, node) {
  const workspace = attemptWorkspace(state);
  if (!workspace) return;
  const source = attemptWorkerResultPath(runDir, node.id, workspace);
  if (!existsSync(source)) return;
  writeTextAtomic(workerResultPath(runDir, node.id), readFileSync(source, "utf8"));
}
/**
 * The run-owned result file is the primary recovery source. The provider's
 * final message is intentionally only redundant input.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {WorkerResult|null}
 */
export function readWorkerResultFile(runDir, nodeId) {
  const path = workerResultPath(runDir, nodeId);
  if (!existsSync(path)) return null;
  try {
    return parseWorkerResult(JSON.stringify(readJson(path)));
  } catch (error) {
    throw new TypeError(`canonical worker result ${path} is invalid: ${errorMessage(error)}`);
  }
}
/** @param {string} runDir @param {string} nodeId @param {WorkerResult} result */
function persistWorkerResultFile(runDir, nodeId, result) {
  writeJsonAtomic(workerResultPath(runDir, nodeId), result);
}
/** @param {string} runDir @param {string} nodeId */
export function clearWorkerResultFile(runDir, nodeId) {
  try { unlinkSync(workerResultPath(runDir, nodeId)); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
/** First line of the one-turn result-materialization prompt. */
export const RESULT_MATERIALIZATION_PROMPT_HEADER = "The implementation is already complete.";
/**
 * The canonical result text without validation. Presence is authoritative:
 * adoption decisions must surface a present-but-invalid file as an invalid
 * result, never treat it as missing work.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {string|null}
 */
export function canonicalWorkerResultText(runDir, nodeId) {
  const path = workerResultPath(runDir, nodeId);
  if (!existsSync(path)) return null;
  try { return JSON.stringify(readJson(path)); } catch { return readFileSync(path, "utf8"); }
}
/**
 * The materialization mode must survive controller interruption, so it is
 * derived from the persisted invocation prompt — the run-owned record of what
 * that turn was asked to do — instead of in-memory job state.
 *
 * @param {Invocation|null|undefined} invocation
 * @returns {boolean}
 */
export function isResultMaterializationInvocation(invocation) {
  if (!invocation?.promptPath) return false;
  try {
    return readFileSync(invocation.promptPath, "utf8").startsWith(RESULT_MATERIALIZATION_PROMPT_HEADER);
  } catch {
    return false;
  }
}
/**
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {unknown} providerResult
 * @returns {WorkerResult}
 */
export function resolveWorkerResult(runDir, node, providerResult) {
  const fromFile = readWorkerResultFile(runDir, node.id);
  if (fromFile) return fromFile;
  const result = parseWorkerResult(String(extractJson(providerResult) ?? providerResult ?? ""));
  persistWorkerResultFile(runDir, node.id, result);
  return result;
}
/**
 * @param {string} prompt
 * @param {string} resultPath
 * @returns {string}
 */
export function workerProtocolPrompt(prompt, resultPath) {
  return [
    prompt,
    "Controller worker protocol:",
    `Before your final response, write the required worker-result JSON object to this canonical result file: ${resultPath}`,
    "Your final provider message is redundant; the result file is the recovery source.",
  ].join("\n\n");
}
/**
 * Parse a result persisted in a node checkpoint or operation settlement. The
 * provider stream remains the first source of evidence; this path is used only
 * after that stream is unavailable.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function parsePersistedWorkerResult(value) {
  if (value === undefined || value === null) return null;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    parseWorkerResult(String(extractJson(serialized) ?? serialized));
    return serialized;
  } catch {
    return null;
  }
}
/**
 * Durable worker-result evidence for recovery, in authority order: the run-owned
 * canonical file first, then the operation settlement, then the node snapshot.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Record<string, unknown>|null} settlement
 * @returns {string|null}
 */
export function persistedWorkerResult(runDir, state, invocation, settlement) {
  const fromFile = canonicalWorkerResultText(runDir, state.id);
  if (fromFile !== null) return fromFile;
  const fromSettlement = parsePersistedWorkerResult(settlement?.result);
  if (fromSettlement) return fromSettlement;
  if (invocation.status !== "active") return parsePersistedWorkerResult(state.result);
  return null;
}
/**
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Record<string, unknown>|null} settlement
 * @returns {unknown|null}
 */
export function persistedJudgeResult(state, invocation, settlement) {
  const candidates = [settlement?.result, invocation.status !== "active" ? state.gate : null];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    try {
      const serialized = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      parseJudge(serialized);
      return serialized;
    } catch {
      // Invalid candidate: skip it and try the next evidence source.
    }
  }
  return null;
}
/**
 * The worker result backing a judge-phase recovery. The canonical file is
 * primary: a present-but-invalid file throws so the caller surfaces an
 * invalid result, and only an absent file falls back to the transcript.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @returns {WorkerResult|null}
 */
export function recoverWorkerResult(runDir, state, contract, node) {
  const fromFile = canonicalWorkerResultText(runDir, state.id);
  if (fromFile !== null) {
    // Presence is authoritative: an unparsable canonical file is an invalid
    // result, never a license to adopt provider-derived evidence instead.
    return parseWorkerResult(String(extractJson(fromFile) ?? fromFile));
  }
  const invocation = [...(state.invocations ?? [])].reverse().find((item) => item.phase === "worker");
  if (!invocation) return null;
  const result = invocationResult(invocation, invocation.runtimeId ? runtimeSnapshot(contract, invocation.runtimeId) : routeRuntimeForState(contract, node, state, "worker"));
  if (result?.status !== "done") return null;
  try { return parseWorkerResult(result.result ?? ""); } catch { return null; }
}
