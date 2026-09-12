/**
 * The launcher half of `--detach`: spawn the controller, wait for it to prove it
 * owns the run, acknowledge, and exit.
 *
 * The controller half is `engine/detach.mjs`. They are separate because only
 * this side knows about `process.argv` and about exiting -- and because the
 * engine importing the CLI was the one import cycle a layered tree could not
 * express.
 *
 * `writeBootstrapFailure` is what makes a detached failure visible at all: a
 * child that dies before taking the lock leaves nothing behind unless it writes
 * why, and the launcher is already gone by then.
 */
import { TERMINAL } from "../engine/prompts.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, bootstrapPath, cleanupBootstrapAttempts, readJson, writeJsonAtomic } from "../run/store.mjs";
import { bootstrapFailureMatchesChild, bootstrapMatchesChild, processStartToken, readLock, sameProcessStartToken, validBootstrapNonce } from "../run/lock.mjs";
import { cleanupBootstrapNonce } from "../engine/detach.mjs";
import { delay, errorCode } from "../util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readRunNodes } from "../engine/scheduler.mjs";
import { spawn } from "node:child_process";
import { validateContract } from "../contract/index.mjs";

/**
 * The file a detached child is spawned as. It must be the CLI and not this
 * module: `cli.mjs` guards its dispatch on `process.argv[1]` being itself, so a
 * child started as `launch.mjs` would run no command at all -- which is exactly
 * what happened when this code moved out of `cli.mjs` and kept using
 * `import.meta.url`.
 */
const CLI_ENTRY = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** @typedef {import("../cli.mjs").BootstrapRecord} BootstrapRecord */
/** @typedef {import("node:child_process").ChildProcess & {bootstrapNonce?: string, bootstrapProcessStartToken?: string|null}} DetachedChild */
/** @typedef {import("../run/lock.mjs").ReadLockResult} ReadLockResult */

/**
 * @param {string} command
 * @param {string} target
 * @param {string[]} [extraArgs]
 * @returns {DetachedChild}
 */
export function detachSelf(command, target, extraArgs = []) {
  const nonce = randomUUID();
  const child = /** @type {DetachedChild} */ (spawn(process.execPath, [CLI_ENTRY, command, target, ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: nonce },
    detached: process.platform !== "win32", stdio: "ignore",
  }));
  child.unref();
  child.bootstrapNonce = nonce;
  child.bootstrapProcessStartToken = processStartToken(child.pid ?? null);
  return child;
}
/**
 * @param {string} runDir
 * @param {number} pid
 * @param {DetachedChild|null} [child]
 * @param {number} [timeoutMs]
 * @returns {Promise<BootstrapRecord>}
 */
export async function waitForBootstrap(runDir, pid, child = null, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const nonce = child?.bootstrapNonce;
  if (!nonce) throw new Error(`detached bootstrap has no start nonce for pid ${pid}`);
  if (!validBootstrapNonce(nonce) || child.pid !== pid) throw new Error(`detached bootstrap has invalid child identity for pid ${pid}`);
  let expectedProcessStartToken = child.bootstrapProcessStartToken ?? null;
  let exited = false;
  child?.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    const childExited = exited || child?.exitCode !== null || child?.signalCode !== null;
    if (expectedProcessStartToken === null && !childExited) expectedProcessStartToken = processStartToken(pid);
    for (const path of [bootstrapAttemptPath(runDir, nonce), bootstrapPath(runDir)]) {
      try {
        const bootstrap = /** @type {BootstrapRecord} */ (readJson(path));
        const childIdentity = bootstrapMatchesChild(bootstrap, pid, nonce, expectedProcessStartToken);
        if (bootstrap.status === "failed" && bootstrapFailureMatchesChild(bootstrap, pid, nonce, expectedProcessStartToken)) {
          cleanupBootstrapAttempts(runDir);
          throw new Error(`detached bootstrap failed: ${bootstrap.error}`);
        }
        const lock = readLock(runDir);
        const currentOwner = lockOwnedBy(lock, pid, expectedProcessStartToken);
        if (!childExited && bootstrap.status === "ready" && childIdentity && currentOwner && runIsNonterminal(runDir)) {
          cleanupBootstrapAttempts(runDir);
          try {
            writeBootstrapAcknowledgement(runDir, bootstrap, expectedProcessStartToken);
          } catch (error) {
            cleanupBootstrapNonce(runDir, nonce);
            throw error;
          }
          return bootstrap;
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          cleanupBootstrapNonce(runDir, nonce);
          cleanupBootstrapAttempts(runDir);
          throw error;
        }
      }
    }
    if (childExited) {
      try {
        const failure = /** @type {BootstrapRecord} */ (readJson(bootstrapAttemptPath(runDir, nonce)));
        if (failure.status === "failed" && bootstrapFailureMatchesChild(failure, pid, nonce, expectedProcessStartToken)) {
          cleanupBootstrapAttempts(runDir);
          throw new Error(`detached bootstrap failed: ${failure.error}`);
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          cleanupBootstrapNonce(runDir, nonce);
          cleanupBootstrapAttempts(runDir);
          throw error;
        }
      }
      cleanupBootstrapNonce(runDir, nonce);
      cleanupBootstrapAttempts(runDir);
      throw new Error(`detached bootstrap failed before readiness for pid ${pid}`);
    }
    await delay(50);
  }
  cleanupBootstrapNonce(runDir, nonce);
  cleanupBootstrapAttempts(runDir);
  throw new Error(`detached bootstrap did not become ready for pid ${pid}`);
}
/**
 * @param {string} runDir
 * @param {BootstrapRecord} bootstrap
 * @param {string|null} expectedProcessStartToken
 */
export function writeBootstrapAcknowledgement(runDir, bootstrap, expectedProcessStartToken) {
  if (!bootstrap.nonce) throw new Error("bootstrap record has no nonce");
  writeJsonAtomic(bootstrapAckPath(runDir, bootstrap.nonce), {
    status: "acknowledged",
    nonce: bootstrap.nonce,
    pid: bootstrap.pid ?? null,
    processStartToken: expectedProcessStartToken,
    at: new Date().toISOString(),
  });
}
/**
 * @param {string} runDir
 * @returns {boolean}
 */
export function runIsNonterminal(runDir) {
  try {
    const contractPath = join(runDir, "contract.json");
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
    const nodes = readRunNodes(runDir, contract);
    return nodes.length > 0 && nodes.some((node) => !TERMINAL.has(node.status));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
/**
 * @param {string} command
 * @param {string|undefined} target
 * @returns {string|null}
 */
export function bootstrapRunDir(command, target) {
  try {
    if (command === "run") {
      if (!target) return null;
      const path = resolve(target);
      const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
      return join(contract.cwd, ".runs", contract.id);
    }
    if (["resume", "cancel"].includes(command)) {
      if (!target) return null;
      return resolve(target);
    }
  } catch {
    return null;
  }
  return null;
}
/**
 * @param {string} command
 * @param {string|undefined} target
 * @param {Error} error
 */
export function writeBootstrapFailure(command, target, error) {
  const runDir = bootstrapRunDir(command, target);
  if (!runDir || !existsSync(runDir)) return;
  const nonce = validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE) ? process.env.INTENT_FACTORY_BOOTSTRAP_NONCE : null;
  const failure = { status: "failed", pid: process.pid, processStartToken: processStartToken(process.pid), runDir, nonce, at: new Date().toISOString(), error: error.message };
  if (command === "run" && existsSync(join(runDir, "contract.json"))) return;
  /** @type {BootstrapRecord|null} */
  let current = null;
  try {
    current = /** @type {BootstrapRecord} */ (readJson(bootstrapPath(runDir)));
    const controllerLock = readLock(runDir);
    const currentOwnerActive = current.status === "ready" && current.pid !== process.pid
      && lockOwnedBy(controllerLock, current.pid, current.processStartToken);
    if (currentOwnerActive) return;
  } catch (readError) {
    if (errorCode(readError) !== "ENOENT") return;
  }
  // Only a detached bootstrap child records an attempt file for its own nonce;
  // a --detach parent that observed the failure must not recreate attempt
  // artifacts with an ambient nonce it does not own.
  if (nonce && !process.argv.includes("--detach") && !(current?.status === "ready" && current.pid === process.pid)) {
    try { writeJsonAtomic(bootstrapAttemptPath(runDir, nonce), failure); } catch {}
  }
  try { writeJsonAtomic(bootstrapPath(runDir), failure); } catch {}
}
/**
 * @param {import("../run/lock.mjs").ReadLockResult} lock
 * @param {number|undefined} pid
 * @param {string|null|undefined} processStartToken
 * @returns {boolean}
 */
function lockOwnedBy(lock, pid, processStartToken) {
  return lock !== null && !lock.invalid && lock.pid === pid
    && sameProcessStartToken(lock.processStartToken, processStartToken);
}
