/**
 * Lease holder liveness and detached-bootstrap identity (TECH-SPEC section 4.3).
 *
 * A lease that ran past its expiresAt says nothing about the process that owns
 * it: a controller stalled by a slow disk, a stop-the-world pause or a suspended
 * laptop keeps driving the run while its heartbeat is late. Run
 * intent-factory-efficiency-p05-governance-resume-20260903 turned that gap into
 * a takeover storm — four controllers were spawned from one expired lease while
 * the original holder was alive. Adoption therefore needs proof of death: the
 * recorded pid must be gone, or its process start token must no longer match
 * the token recorded when the lease was written (the pid was recycled).
 *
 * This module is a leaf on purpose. store.mjs owns the lease file and imports
 * these predicates; nothing here may import store.mjs back.
 */

import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** @typedef {{pid?: number, holderId?: string, processStartToken?: string|null}} LeaseHolder */
/** @typedef {{kill?: (pid: number) => boolean, startToken?: (pid: number) => string|null}} LivenessProbes */
/** @typedef {{alive: boolean, reason: "no_pid"|"pid_gone"|"pid_recycled"|"pid_alive"|"token_alive"}} Liveness */
/** @typedef {{adopt: boolean, reason: "absent"|"invalid"|"healthy"|"holder_alive"|Liveness["reason"]}} AdoptionVerdict */

/**
 * The Linux process start time (field 22 of /proc/<pid>/stat) distinguishes a
 * live pid from a recycled one. Other platforms have no cheap equivalent, so
 * the pid probe alone decides there.
 * @param {number|null} pid
 * @returns {string|null}
 */
export function processStartTokenOf(pid) {
  if (process.platform !== "linux" || !pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: still alive.
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

/**
 * Resolve whether the process recorded in a lease is still running. Probes are
 * injectable so tests can describe a holder without spawning one.
 * @param {LeaseHolder|null|undefined} holder
 * @param {LivenessProbes} [probes]
 * @returns {Liveness}
 */
export function holderLiveness(holder, probes = {}) {
  const pid = holder?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { alive: false, reason: "no_pid" };
  const kill = probes.kill ?? pidAlive;
  if (!kill(pid)) return { alive: false, reason: "pid_gone" };
  const recorded = holder?.processStartToken ?? null;
  if (recorded === null) return { alive: true, reason: "pid_alive" };
  const current = (probes.startToken ?? processStartTokenOf)(pid);
  if (current !== null && current !== recorded) return { alive: false, reason: "pid_recycled" };
  return { alive: true, reason: "token_alive" };
}

/**
 * @param {LeaseHolder|null|undefined} holder
 * @param {LivenessProbes} [probes]
 * @returns {boolean}
 */
export function holderProvenDead(holder, probes = {}) {
  return !holderLiveness(holder, probes).alive;
}

/**
 * Decide whether a lease record may be taken over. An expired lease is only
 * adoptable once its holder is proven dead; a still-running holder keeps the
 * run even though its heartbeat is late.
 * @param {unknown} lease
 * @param {{now?: number, probes?: LivenessProbes}} [options]
 * @returns {AdoptionVerdict}
 */
export function leaseAdoption(lease, options = {}) {
  if (!lease || typeof lease !== "object") return { adopt: true, reason: "absent" };
  const record = /** @type {Record<string, unknown>} */ (lease);
  if (record.invalid) return { adopt: true, reason: "invalid" };
  const now = options.now ?? Date.now();
  const expiresAt = Date.parse(/** @type {string} */ (record.expiresAt));
  if (Number.isFinite(expiresAt) && expiresAt > now) return { adopt: false, reason: "healthy" };
  const liveness = holderLiveness(/** @type {LeaseHolder} */ (lease), options.probes);
  return liveness.alive ? { adopt: false, reason: "holder_alive" } : { adopt: true, reason: liveness.reason };
}

/**
 * @param {string|null|undefined} actual
 * @param {string|null|undefined} expected
 * @returns {boolean}
 */
export function sameProcessStartToken(actual, expected) {
  return actual === expected;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function validBootstrapNonce(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{16,64}$/u.test(value);
}

/**
 * @param {{pid?: number, nonce?: string, processStartToken?: string|null}} record
 * @param {number} pid
 * @param {string} nonce
 * @param {string|null} expectedProcessStartToken
 * @returns {boolean}
 */
export function bootstrapMatchesChild(record, pid, nonce, expectedProcessStartToken) {
  return record?.pid === pid && record?.nonce === nonce && validBootstrapNonce(record.nonce) && sameProcessStartToken(record.processStartToken, expectedProcessStartToken);
}

/**
 * @param {{pid?: number, nonce?: string, processStartToken?: string|null}} record
 * @param {number} pid
 * @param {string} nonce
 * @param {string|null} expectedProcessStartToken
 * @returns {boolean}
 */
export function bootstrapFailureMatchesChild(record, pid, nonce, expectedProcessStartToken) {
  return record?.pid === pid && record?.nonce === nonce && validBootstrapNonce(record.nonce) && (
    expectedProcessStartToken === null
      ? record.processStartToken === null || typeof record.processStartToken === "string"
      : record.processStartToken === expectedProcessStartToken
  );
}

/**
 * @param {string} leasePath
 * @param {number} generation
 * @returns {string}
 */
export function generationFencePath(leasePath, generation) {
  return `${leasePath}.fence.${generation}`;
}

/**
 * @param {string} path
 * @param {unknown} record
 * @returns {boolean} false when the entry already exists
 */
function createFenceExclusive(path, record) {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * @param {string} path
 * @returns {LeaseHolder|null} null when the claim is missing or was never finished
 */
function readFenceRecord(path) {
  try {
    return /** @type {LeaseHolder} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Take whatever occupies `path` out of the way without destroying it.
 *
 * This is the only removal primitive the lease protocol uses, because it is the
 * only one that cannot go wrong when the caller is descheduled. A rename is a
 * single atomic step that both frees the name and hands the caller the exact
 * bytes that were under it — not the bytes it read a moment earlier. Every
 * decision downstream is therefore made about something already in hand, and a
 * caller that decides it had no right to remove what it captured can put it
 * back. An unlink offers no such retreat: once it runs, a newer holder that
 * arrived in the meantime is gone.
 * @param {string} path
 * @returns {string|null} the private name holding the capture, or null when nothing was there
 */
export function captureEntry(path) {
  const aside = `${path}.captured.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  return aside;
}

/**
 * Put a capture back and drop the private name. The link is conditional: if
 * somebody took the name while the capture was held, that newer occupant is
 * left alone and the capture is discarded rather than forced back over it.
 * @param {string} aside
 * @param {string} path
 * @returns {boolean} true when the capture is back under its old name
 */
export function restoreEntry(aside, path) {
  let restored = true;
  try {
    linkSync(aside, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    restored = false;
  }
  discardEntry(aside);
  return restored;
}

/**
 * @param {string} path
 */
export function discardEntry(path) {
  try { unlinkSync(path); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Free a fence claim whose owner died mid-takeover, so one crash cannot wedge a
 * generation forever.
 *
 * The proof of death is made about a claim already captured, never about a
 * claim still sitting under its name. A reclaimer stalled between the two would
 * otherwise wake up and delete whatever now holds the name — including the live
 * replacement claim of a controller that legitimately took the generation while
 * it slept. Capturing first inverts that: a live claim is handed back.
 * @param {string} path
 * @param {LivenessProbes} [probes]
 * @returns {boolean} true when the name is free for a new claim
 */
function reclaimDeadFence(path, probes) {
  const aside = captureEntry(path);
  if (aside === null) return true;
  if (!holderProvenDead(readFenceRecord(aside), probes)) {
    restoreEntry(aside, path);
    return false;
  }
  discardEntry(aside);
  return true;
}

/**
 * Claim the right to install one lease generation, before anything is removed.
 *
 * The claim is an exclusive create, so of all the contenders that read the same
 * expired lease exactly one takes generation N and the rest give up having
 * touched nothing. That keeps the common case free of racing writers, and it
 * satisfies the rule that a takeover proves its ground before it acts. It is
 * deliberately not the last line of defence: a claim is a decision, and no
 * decision survives an unbounded pause. What makes the takeover single-winner
 * is that the install itself is non-destructive and conditional — see
 * captureLeaseSlot in store.mjs — so even two contenders holding the same
 * generation cannot both end up installed.
 *
 * A claim outlives its owner only if that owner died mid-takeover, so a claim
 * whose holder is proven dead — the same proof adoption itself demands — may be
 * reclaimed. A claim held by a live process is never stolen.
 * @param {string} leasePath
 * @param {{holderId: string, pid: number, processStartToken: string|null}} holder
 * @param {number} generation
 * @param {{probes?: LivenessProbes}} [options]
 * @returns {{claimed: boolean, reason: "claimed"|"reclaimed"|"held", owned: () => boolean, release: () => void}}
 */
export function claimGenerationFence(leasePath, holder, generation, options = {}) {
  const path = generationFencePath(leasePath, generation);
  const record = { ...holder, generation, claimedAt: new Date().toISOString() };
  /** @param {boolean} claimed @param {"claimed"|"reclaimed"|"held"} reason */
  const handle = (claimed, reason) => ({
    claimed,
    reason,
    /** @returns {boolean} whether the claim under this name is still this holder's */
    owned() {
      return claimed && readFenceRecord(path)?.holderId === holder.holderId;
    },
    release() {
      if (!claimed) return;
      const aside = captureEntry(path);
      if (aside === null) return;
      // Releasing must not remove a successor's claim, so the capture goes back
      // whenever the bytes under the name turned out to belong to somebody else.
      if (readFenceRecord(aside)?.holderId === holder.holderId) discardEntry(aside);
      else restoreEntry(aside, path);
    },
  });
  if (createFenceExclusive(path, record)) return handle(true, "claimed");
  if (!reclaimDeadFence(path, options.probes)) return handle(false, "held");
  return createFenceExclusive(path, record) ? handle(true, "reclaimed") : handle(false, "held");
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return error.code;
  return undefined;
}
