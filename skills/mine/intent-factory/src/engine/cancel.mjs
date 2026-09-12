/**
 * Stopping a run that is still going.
 *
 * `cancel` is not a flag on a loop: the controller may be another process, or
 * gone with its lock still on disk. It signals the holder, waits for the
 * process to actually die rather than assuming, takes over the now-stale lock,
 * terminates every recorded invocation, and only then marks the run terminal.
 * It refuses a lock held by its own process, because that is a bug and not a
 * cancellation.
 */
import { LockBusyError, acquire as acquireLock, pidAlive, readLock } from "../run/lock.mjs";
import { TERMINAL } from "./prompts.mjs";
import { assertRunMutable } from "./lifecycle.mjs";
import { delay, errorCode } from "../util.mjs";
import { invocationAlive, terminateInvocation } from "./process.mjs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readRunNodes } from "./scheduler.mjs";
import { syncAgentSignal } from "../repo/signal.mjs";
import { transition, writeNode } from "./state.mjs";
import { validateContract } from "../contract/index.mjs";
import { writeJsonAtomic } from "../run/store.mjs";

/** @typedef {import("./process.mjs").InvocationProbe} InvocationProbe */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */

/**
 * @param {string} runDirPath
 * @returns {Promise<boolean>}
 */
export async function cancelRun(runDirPath) {
  const runDir = resolve(runDirPath);
  assertRunMutable(runDir);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  writeJsonAtomic(join(runDir, "cancel.request.json"), { requestedAt: new Date().toISOString(), pid: process.pid });
  const current = readLock(runDir);
  const holder = current && !current.invalid ? /** @type {LockRecord} */ (current) : null;
  if (holder && holder.pid === process.pid) {
    throw new Error("cancel cannot take over a controller lock held by this process");
  }
  if (holder) {
    const controller = { pid: holder.pid, processStartToken: holder.processStartToken };
    if (invocationAlive(controller)) {
      signalController(holder, "SIGTERM");
      if (!await waitForProcessDeath(controller, 2_000)) {
        signalController(holder, "SIGKILL");
        if (!await waitForProcessDeath(controller, 2_000)) throw new Error("cancel could not confirm controller termination");
      }
    }
  }
  const controllerLock = await acquireStaleLock(runDir);
  try {
    const states = readRunNodes(runDir, contract);
    /** @type {Error[]} */
    const failures = [];
    for (const state of states) {
      for (const invocation of state.invocations ?? []) {
        if (invocation.status === "active" || invocationAlive(invocation)) {
          try {
            await terminateInvocation(invocation);
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
      for (const invocation of state.invocations ?? []) {
        if (invocationAlive(invocation)) failures.push(new Error(`provider invocation ${invocation.id} is still alive after cancellation`));
      }
      for (const attempt of state.verification?.attempts ?? []) {
        if (attempt.status !== "active" && (!attempt.pid || !invocationAlive(attempt))) continue;
        if (attempt.pid) {
          try {
            await terminateInvocation({
              id: attempt.invocationId,
              pid: attempt.pid,
              processGroupId: attempt.processGroupId,
              processStartToken: attempt.processStartToken,
            });
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (attempt.pid && invocationAlive(attempt)) failures.push(new Error(`verification attempt ${attempt.invocationId} is still alive after cancellation`));
        const completedAt = new Date().toISOString();
        state.verification = state.verification ?? { passed: false, commands: [], completed: false, attempts: [] };
        state.verification.attempts = (state.verification.attempts ?? []).map((item) => item.invocationId === attempt.invocationId
          ? { ...item, status: "canceled", completedAt, result: { passed: false, stdout: "", stderr: "", error: "verification canceled", exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: null } }
          : item);
        state.verification.completed = true;
        state.verification.passed = false;
        state.verification.error = "verification canceled";
      }
      if (state.verification?.attempts?.length) writeNode(runDir, state, controllerLock);
      if (failures.length) continue;
      const closedAt = new Date().toISOString();
      const invocations = (state.invocations ?? []).map((invocation) => invocation.status === "active"
        ? { ...invocation, status: "terminated", closedAt, updatedAt: closedAt }
        : invocation);
      if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled", invocations }, controllerLock);
    }
    if (failures.length) {
      const error = new Error(`cancel could not confirm termination of ${failures.length} invocation${failures.length === 1 ? "" : "s"}`);
      error.cause = failures[0];
      throw error;
    }
    if (!await waitForTerminal(runDir, 1_000)) throw new Error("cancel could not confirm a terminal run state");
    syncAgentSignal(join(runDir, ".."));
    return true;
  } finally {
    controllerLock.release();
  }
}
/**
 * The controller pid is already confirmed dead (or was never alive) by the
 * time this is called, so the lock is stale and acquire() takes it over on
 * its own; the retry here only covers a lock file whose write has not
 * settled yet, never a live rival.
 * @param {string} runDir
 * @returns {Promise<LockHandle>}
 */
async function acquireStaleLock(runDir) {
  for (;;) {
    try {
      return acquireLock(runDir);
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      const holder = /** @type {LockRecord|null} */ (error.lock);
      if (!holder || pidAlive(holder.pid)) throw error;
      await delay(50);
    }
  }
}
/**
 * @param {LockRecord} lock
 * @param {NodeJS.Signals} signal
 */
function signalController(lock, signal) {
  if (!invocationAlive({ pid: lock.pid, processStartToken: lock.processStartToken })) return;
  try {
    process.kill(lock.pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}
/**
 * @param {InvocationProbe} invocation
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForProcessDeath(invocation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!invocationAlive(invocation)) return true;
    await delay(50);
  }
  return !invocationAlive(invocation);
}
/**
 * @param {string} runDir
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForTerminal(runDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const contractPath = join(runDir, "contract.json");
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
    const states = readRunNodes(runDir, contract);
    if (states.every((state) => TERMINAL.has(state.status)) && states.every((state) => (state.invocations ?? []).every((invocation) => !invocationAlive(invocation)))) return true;
    await delay(100);
  }
  return false;
}
