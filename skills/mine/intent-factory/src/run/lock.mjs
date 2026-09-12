/**
 * One controller per run, held by an atomic lock file (TECH-SPEC lean, rule 5).
 *
 * `controller.lock` records the holder's pid, its process start token, and
 * when it started. There is no expiry and nothing to renew: a lock stays
 * valid for as long as its holder is alive, however long that takes, and a
 * contender treats it as stale only once it can prove the holder dead — the
 * pid is gone, or its start token no longer matches (the pid was recycled).
 * That is a strictly stronger claim than a lease's TTL, so there is no
 * healthy-but-expired window and nothing to fence against: at most one
 * process can ever hold a live pid, so at most one takeover can ever observe
 * a captured lock as stale.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fsyncDirectory } from "./store.mjs";

const LOCK_FILE = "controller.lock";
const TAKEOVER_ATTEMPTS = 20;

export class LockBusyError extends Error {
  /** @param {string} message @param {unknown} lock */
  constructor(message, lock = null) {
    super(message);
    this.name = "LockBusyError";
    this.code = "lock_busy";
    this.lock = lock;
  }
}

export class LockLostError extends Error {
  constructor(message = "controller lock was lost") {
    super(message);
    this.name = "LockLostError";
    this.code = "lock_lost";
  }
}

/** @typedef {{schemaVersion: number, pid: number, processStartToken: string|null, startedAt: string, hostname: string, invalid?: never}} LockRecord */
/** @typedef {LockRecord|null|{invalid: true}} ReadLockResult */
/** @typedef {{pid?: number, processStartToken?: string|null}} LockOptions */

/** @param {string} runDir @returns {string} */
export function lockPath(runDir) {
  return join(runDir, LOCK_FILE);
}

/**
 * The process start time distinguishes a live pid from a recycled one. On
 * Linux, field 22 of /proc/<pid>/stat. On darwin, there is no /proc, so the
 * fingerprint comes from the OS process table instead: `ps -o lstart=`
 * reports the same live process's own start time on every call and a
 * different one for whatever process next reuses that pid, without a
 * compiled addon or elevated privileges. Every other platform has no cheap
 * equivalent, so the pid probe alone decides there.
 * @param {number|null} pid @returns {string|null}
 */
export function processStartToken(pid) {
  if (!pid) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return started.length > 0 ? started : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** @param {number|null|undefined} pid @returns {boolean} */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return false;
  try {
    process.kill(/** @type {number} */ (pid), 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** @param {string} runDir @returns {ReadLockResult} */
export function readLock(runDir) {
  try {
    return /** @type {LockRecord} */ (JSON.parse(readFileSync(lockPath(runDir), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError) return { invalid: true };
    throw error;
  }
}

/**
 * A lock is stale only once its holder is proven dead. A live holder keeps
 * the lock no matter its age — there is no expiry to race.
 * @param {ReadLockResult} lock @returns {boolean}
 */
export function lockStale(lock) {
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return true;
  const record = /** @type {LockRecord} */ (lock);
  if (!pidAlive(record.pid)) return true;
  return Boolean(record.processStartToken) && processStartToken(record.pid) !== record.processStartToken;
}

/**
 * Acquire the run's controller lock, taking over a stale one. Contention on a
 * live lock fails immediately: there is nothing to wait for, since a live
 * holder does not become dead within this call.
 * @param {string} runDir @param {LockOptions} [options] @returns {LockRecord & {current: LockRecord, assert: () => void, release: () => void, released: boolean}}
 */
export function acquire(runDir, options = {}) {
  mkdirSync(runDir, { recursive: true });
  const path = lockPath(runDir);
  const pid = options.pid ?? process.pid;
  /** @type {LockRecord} */
  const record = {
    schemaVersion: 1,
    pid,
    processStartToken: options.processStartToken !== undefined ? options.processStartToken : processStartToken(pid),
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
    try {
      writeExclusive(path, record, runDir);
      return createHandle(runDir, record);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const occupant = readLock(runDir);
    if (!lockStale(occupant)) {
      throw new LockBusyError(`run controller lock is held by pid ${/** @type {LockRecord} */ (occupant)?.pid}`, occupant);
    }
    // Capture is one atomic rename: there is no gap in which a live successor
    // could install under the name and be destroyed by a decision made about
    // its dead predecessor. A capture that turns out to still be live — the
    // successor won the race between our read and our rename — is handed
    // straight back, never discarded.
    const aside = captureEntry(path);
    if (aside === null) continue;
    const captured = readCapturedLock(aside);
    if (!lockStale(captured)) {
      try {
        linkSync(aside, path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      discardEntry(aside);
      fsyncDirectory(runDir);
      continue;
    }
    discardEntry(aside);
    fsyncDirectory(runDir);
  }
  throw new LockBusyError(`contended controller lock takeover for ${runDir} did not settle`, readLock(runDir));
}

/** @param {string} path @param {LockRecord} record @param {string} runDir */
function writeExclusive(path, record, runDir) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    fsyncDirectory(runDir);
  } finally {
    discardEntry(temporary);
  }
}

/** @param {string} path @returns {string|null} */
function captureEntry(path) {
  const aside = `${path}.captured.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  return aside;
}

/** @param {string} path @returns {ReadLockResult} */
function readCapturedLock(path) {
  try {
    return /** @type {LockRecord} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { invalid: true };
  }
}

/** @param {string} path */
function discardEntry(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** @param {string} runDir @param {LockRecord} record */
function createHandle(runDir, record) {
  const path = lockPath(runDir);
  let released = false;
  /** @returns {boolean} */
  const held = () => {
    const actual = readLock(runDir);
    return Boolean(actual) && !/** @type {{invalid?: true}} */ (actual).invalid
      && /** @type {LockRecord} */ (actual).pid === record.pid
      && /** @type {LockRecord} */ (actual).startedAt === record.startedAt;
  };
  return {
    ...record,
    get current() { return record; },
    assert() {
      if (released || !held()) throw new LockLostError();
    },
    release() {
      if (released) return;
      if (held()) {
        discardEntry(path);
        fsyncDirectory(runDir);
      }
      released = true;
    },
    get released() { return released; },
  };
}

/** @param {unknown} error @returns {string|undefined} */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    const code = /** @type {{code: unknown}} */ (error).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Detached-bootstrap identity (TECH-SPEC section 4.3).
 *
 * A `run --detach` parent hands its child a nonce and later needs proof that
 * the bootstrap record and the controller lock it finds really belong to the
 * pid it spawned, not to some other process that reused that pid in the
 * meantime. Matching pid and nonce alone is not that proof: a nonce is
 * generated by the parent and never reused, but a recycled pid could
 * coincidentally match while belonging to an unrelated process if the
 * parent's own child died and something else took its pid before the parent
 * finished checking. The process start token is what rules that out.
 */

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
