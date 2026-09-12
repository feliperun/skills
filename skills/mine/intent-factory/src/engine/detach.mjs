/**
 * The detached-bootstrap handshake, from the controller's side.
 *
 * `run --detach` and `resume --detach` spawn a second process that becomes the
 * controller and outlives the launcher. The launcher must not exit until that
 * child has proved it owns the run, and the child must not start burning tokens
 * until the launcher has seen the proof. The two halves meet in three files
 * under the run directory, all named by `run/store.mjs`:
 *
 *   bootstrap.json              the child's own claim: status, pid, start token
 *   bootstrap.<nonce>.json      that claim, per attempt, so a stale one is
 *                               distinguishable from the current one
 *   bootstrap.<nonce>.ack.json  the launcher's acknowledgement of the claim
 *
 * The nonce travels to the child in `INTENT_FACTORY_BOOTSTRAP_NONCE`, so the
 * child can recognise its own attempt among the artifacts of earlier ones.
 *
 * This module holds the controller's half, because the controller is what waits
 * on the acknowledgement. Until 2026-09-11 it lived in the CLI, which made
 * `engine/scheduler.mjs` import `cli.mjs` -- the one import cycle in the tree
 * that a layered layout could not express. The launcher's half (writing the
 * acknowledgement, spawning the child, deciding whether *this* process is the
 * detached child at all) stays in the CLI, where the answer depends on which
 * file was the process entry point.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { sameProcessStartToken, validBootstrapNonce } from "../run/lock.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, readJson } from "../run/store.mjs";
import { delay } from "../util.mjs";

/** How long a detached child waits for its launcher to acknowledge. */
const ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;

/** @typedef {{status?: string, nonce?: string, pid?: number, processStartToken?: string|null}} BootstrapRecord */

/**
 * The nonce this controller process should stamp on its bootstrap record: the
 * one its launcher handed it, or a fresh one when it was started directly.
 *
 * @returns {string}
 */
export function bootstrapNonceForProcess() {
  return validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)
    ? /** @type {string} */ (process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)
    : randomUUID();
}

/**
 * Block until the launcher acknowledges this exact claim -- same nonce, same
 * pid, same process start token, so a reused pid cannot be mistaken for it.
 * Returns on timeout rather than failing: an unacknowledged controller has
 * still taken the lock and is still the owner, and the launcher's silence is
 * the launcher's problem.
 *
 * @param {string} runDir
 * @param {{nonce: string, pid: number, processStartToken: string|null}} expected
 * @returns {Promise<void>}
 */
export async function waitForBootstrapAcknowledgement(runDir, expected) {
  if (!validBootstrapNonce(expected.nonce)) return;
  const deadline = Date.now() + ACKNOWLEDGEMENT_TIMEOUT_MS;
  const path = bootstrapAckPath(runDir, expected.nonce);
  try {
    while (Date.now() < deadline) {
      try {
        const acknowledgement = /** @type {BootstrapRecord} */ (readJson(path));
        if (
          acknowledgement.status === "acknowledged" &&
          acknowledgement.nonce === expected.nonce &&
          acknowledgement.pid === expected.pid &&
          sameProcessStartToken(acknowledgement.processStartToken, expected.processStartToken)
        ) {
          return;
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await delay(25);
    }
  } finally {
    cleanupBootstrapNonce(runDir, expected.nonce);
  }
}

/**
 * Remove one attempt's artifacts. Both halves of the handshake call this, so
 * the successful path leaves nothing behind for the next attempt to read.
 *
 * @param {string} runDir
 * @param {string} nonce
 */
export function cleanupBootstrapNonce(runDir, nonce) {
  if (!validBootstrapNonce(nonce)) return;
  for (const path of [bootstrapAttemptPath(runDir, nonce), bootstrapAckPath(runDir, nonce)]) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return error.code;
  return undefined;
}
