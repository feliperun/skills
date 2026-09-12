/**
 * Verification the controller runs itself, in the attempt workspace, after the
 * worker says it is done.
 *
 * The worker is also told to run these commands, and its word is not the proof:
 * the controller re-runs them and persists each attempt, because a worker that
 * claims a passing suite it never ran is exactly the failure this exists to
 * catch. `recoverVerificationAttempts` reads back what a crashed controller had
 * already proved, so a resume does not pay for the same suite twice.
 */
import { attemptWorkspace } from "../repo/worktree.mjs";
import { boundedUtf8, errorMessage } from "../util.mjs";
import { compactVerification, runVerification } from "../contract/verification.mjs";
import { finalVerificationCommands } from "../contract/final-verification.mjs";
import { join } from "node:path";
import { processStartToken } from "../run/lock.mjs";
import { terminateInvocation } from "./process.mjs";
import { writeNode } from "./state.mjs";

/** @typedef {import("../repo/integrate.mjs").CandidateEvidence} CandidateEvidence */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/index.mjs").VerificationState} VerificationState */

/**
 * @param {VerificationAttemptResult|null|undefined} result
 * @returns {VerificationAttemptResult}
 */
function boundedVerificationAttemptResult(result) {
  return {
    passed: Boolean(result?.passed),
    stdout: boundedUtf8(result?.stdout ?? "", 2 * 1024),
    stderr: boundedUtf8(result?.stderr ?? "", 2 * 1024),
    error: result?.error ? boundedUtf8(result.error, 2 * 1024) : null,
    exitCode: Number.isInteger(result?.exitCode) ? result?.exitCode ?? null : null,
    signal: result?.signal ?? null,
    timedOut: Boolean(result?.timedOut),
    durationMs: Number.isFinite(result?.durationMs) ? result?.durationMs ?? null : null,
  };
}
/**
 * @param {NodeSnapshot} state
 * @returns {import("../contract/index.mjs").VerificationAttempt[]}
 */
function verificationAttemptRecords(state) {
  if (!state.verification || !Array.isArray(state.verification.attempts)) {
    state.verification = { passed: false, commands: [], completed: false, attempts: [] };
  }
  return state.verification.attempts ?? [];
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @param {VerificationAttempt} attempt
 */
function persistVerificationAttempt(runDir, state, lock, attempt) {
  const attempts = verificationAttemptRecords(state);
  const index = attempts.findIndex((item) => item.invocationId === attempt.invocationId);
  if (index >= 0) attempts[index] = { ...attempts[index], ...attempt };
  else attempts.push({ ...attempt, completedAt: attempt.completedAt ?? null, result: attempt.result ?? null });
  state.verification ??= { passed: false, commands: [], completed: false, attempts: [] };
  state.verification.attempts = attempts.slice(-16);
  writeNode(runDir, state, lock);
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<import("../contract/index.mjs").VerificationState>}
 */
export async function executeControllerVerification(contract, runDir, node, state, lock) {
  if (state.verification?.completed === true) return /** @type {import("../contract/index.mjs").VerificationState} */ (state.verification);
  state.verification = {
    passed: false,
    commands: [],
    completed: false,
    attempts: [...(state.verification?.attempts ?? [])],
  };
  writeNode(runDir, state, lock);
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  try {
    const result = await runVerification([...node.taskPacket.verification, ...finalVerificationCommands(contract, node)], workspace, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.verification`),
      onAttemptStart: (attempt) => persistVerificationAttempt(runDir, state, lock, attempt),
      onAttemptSpawn: (attempt) => persistVerificationAttempt(runDir, state, lock, {
        ...attempt,
        processStartToken: processStartToken(attempt.pid),
      }),
      onAttemptComplete: (attempt) => persistVerificationAttempt(runDir, state, lock, {
        ...attempt,
        result: boundedVerificationAttemptResult(attempt.result),
      }),
    });
    state.verification = {
      ...compactVerification(result),
      completed: true,
      attempts: verificationAttemptRecords(state),
    };
  } catch (error) {
    state.verification = {
      ...state.verification,
      completed: true,
      passed: false,
      error: boundedUtf8(errorMessage(error), 4 * 1024),
      attempts: verificationAttemptRecords(state),
    };
  }
  writeNode(runDir, state, lock);
  return state.verification;
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<void>}
 */
export async function recoverVerificationAttempts(runDir, state, lock) {
  const active = (state.verification?.attempts ?? []).filter((attempt) => attempt.status === "active");
  if (!active.length) return;
  for (const attempt of active) {
    if (attempt.pid) {
      try {
    await terminateInvocation({
      id: attempt.invocationId,
      pid: attempt.pid,
      processGroupId: attempt.processGroupId,
      processStartToken: attempt.processStartToken,
    }, { graceMs: 500, killGraceMs: 1_000 });
      } catch (error) {
        throw new Error(`verification attempt ${attempt.invocationId} could not be terminated: ${errorMessage(error)}`);
      }
    }
    persistVerificationAttempt(runDir, state, lock, {
      ...attempt,
      status: "crashed",
      completedAt: new Date().toISOString(),
      result: { passed: false, stdout: "", stderr: "", error: "verification controller interrupted", exitCode: null, signal: null, timedOut: false, durationMs: null },
    });
  }
  state.verification = { ...state.verification, completed: false, passed: false };
  delete state.verification.error;
  writeNode(runDir, state, lock);
}
/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {string} workspace
 * @returns {Promise<import("../repo/integrate.mjs").CandidateEvidence>}
 */
export async function verifyCandidateWorkspace(contract, node, state, runDir, workspace) {
  try {
    const result = await runVerification([...node.taskPacket.verification, ...finalVerificationCommands(contract, node)], workspace, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.candidate-verification`),
    });
    return compactVerification(result);
  } catch (error) {
    return { passed: false, error: boundedUtf8(errorMessage(error), 4 * 1024) };
  }
}
