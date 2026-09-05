import {
  closeSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { captureEntry, claimGenerationFence, discardEntry, leaseAdoption, restoreEntry } from "./lease-liveness.mjs";

export const LEASE_FILE = "controller-lease.json";
export const SUPERVISOR_LEASE_FILE = "supervisor-lease.json";
export const BOOTSTRAP_FILE = "bootstrap.json";
export const DEFAULT_LEASE_TTL_MS = 15_000;
const FILE_LOCK_TTL_MS = 5_000;
const FILE_LOCK_ATTEMPTS = 120;
// A takeover only writes while its lock still has this much life left. This is
// an early exit for an obviously stale contender, not the serialization point:
// the generation fence in lease-liveness.mjs is what admits a single writer.
const LOCK_WRITE_MARGIN_MS = 1_000;
const LEASE_TAKEOVER_ATTEMPTS = 8;
const JSONL_RECOVERY_TAIL_BYTES = 64 * 1024;

/** @typedef {{schemaVersion: number, contractVersion: string, holderId: string, generation: number, pid: number, processStartToken: string|null, acquiredAt: string, renewedAt: string, expiresAt: string, invalid?: never}} LeaseRecord */
/** @typedef {LeaseRecord|null|{invalid: true, path: string}} ReadLeaseResult */
/** @typedef {{holderId?: string, pid?: number, ttlMs?: number, contractVersion?: string, processStartToken?: string|null, now?: number, fileName?: string, requireHolderDeath?: boolean, livenessProbes?: import("./lease-liveness.mjs").LivenessProbes, onRenew?: (lease: LeaseRecord) => void}} LeaseOptions */

export class LeaseBusyError extends Error {
  /**
   * @param {string} message
   * @param {ReadLeaseResult} lease
   */
  constructor(message, lease = null) {
    super(message);
    this.name = "LeaseBusyError";
    this.code = "lease_busy";
    this.lease = lease;
  }
}

export class LeaseLostError extends Error {
  constructor(message = "controller lease was lost") {
    super(message);
    this.name = "LeaseLostError";
    this.code = "lease_lost";
  }
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function readJson(path) {
  return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, "utf8")));
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} path
 * @param {string} text
 */
export function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let committed = false;
  try {
    try {
      writeSync(fd, text, 0, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
    committed = true;
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanupError) {
      if (errorCode(cleanupError) !== "ENOENT") throw cleanupError;
    }
    throw error;
  } finally {
    if (!committed) {
      try { unlinkSync(temporary); } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  recoverPartialJsonl(path);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} path
 */
function recoverPartialJsonl(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (size === 0) return;
  const window = Math.min(size, JSONL_RECOVERY_TAIL_BYTES);
  const fd = openSync(path, "r+");
  try {
    const buffer = Buffer.alloc(window);
    readSync(fd, buffer, 0, window, size - window);
    const tail = buffer.toString("utf8");
    if (tail.endsWith("\n")) return;
    const newline = tail.lastIndexOf("\n");
    const completeBytes = newline >= 0
      ? size - window + newline + 1
      : size <= JSONL_RECOVERY_TAIL_BYTES ? 0 : size - window;
    ftruncateSync(fd, completeBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} path
 */
export function fsyncDirectory(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!(["EINVAL", "EPERM", "EISDIR"].includes(/** @type {string} */ (errorCode(error))))) throw error;
  }
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function leasePath(runDir) {
  return join(runDir, LEASE_FILE);
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function supervisorLeasePath(runDir) {
  return join(runDir, SUPERVISOR_LEASE_FILE);
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function bootstrapPath(runDir) {
  return join(runDir, BOOTSTRAP_FILE);
}

/**
 * @param {string} runDir
 * @param {string} nonce
 * @returns {string}
 */
export function bootstrapAttemptPath(runDir, nonce) {
  return join(runDir, `${BOOTSTRAP_FILE}.${nonce}`);
}

/**
 * @param {string} runDir
 * @param {string} nonce
 * @returns {string}
 */
export function bootstrapAckPath(runDir, nonce) {
  return join(runDir, `${BOOTSTRAP_FILE}.${nonce}.ack`);
}

/**
 * @param {string} runDir
 * @param {string|null} keepNonce
 */
export function cleanupBootstrapAttempts(runDir, keepNonce = null) {
  const prefix = `${BOOTSTRAP_FILE}.`;
  let names;
  try { names = readdirSync(runDir); } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !isBootstrapAttemptName(name)) continue;
    if (keepNonce && (name === `${prefix}${keepNonce}` || name === `${prefix}${keepNonce}.ack`)) continue;
    try { unlinkSync(join(runDir, name)); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isBootstrapAttemptName(name) {
  const rest = name.slice(`${BOOTSTRAP_FILE}.`.length);
  return /^[A-Za-z0-9-]{16,64}$/u.test(rest) || /^[A-Za-z0-9-]{16,64}\.ack$/u.test(rest);
}

/**
 * @param {string} runDir
 * @returns {ReadLeaseResult}
 */
export function readLease(runDir) {
  return readLeaseFile(leasePath(runDir));
}

/**
 * @param {string} runDir
 * @returns {ReadLeaseResult}
 */
export function readSupervisorLease(runDir) {
  return readLeaseFile(supervisorLeasePath(runDir));
}

/**
 * @param {string} path
 * @returns {ReadLeaseResult}
 */
function readLeaseFile(path) {
  try {
    return /** @type {LeaseRecord} */ (readJson(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError) return { invalid: true, path };
    throw error;
  }
}

/**
 * @param {unknown} lease
 * @param {number} now
 * @returns {boolean}
 */
export function leaseHealthy(lease, now = Date.now()) {
  return Boolean(
    lease &&
    typeof lease === "object" &&
    !/** @type {Record<string, unknown>} */ (lease).invalid &&
    typeof /** @type {Record<string, unknown>} */ (lease).contractVersion === "string" &&
    typeof /** @type {Record<string, unknown>} */ (lease).holderId === "string" &&
    Number.isInteger(/** @type {Record<string, unknown>} */ (lease).generation) &&
    Number.isInteger(/** @type {Record<string, unknown>} */ (lease).pid) &&
    typeof /** @type {Record<string, unknown>} */ (lease).acquiredAt === "string" &&
    typeof /** @type {Record<string, unknown>} */ (lease).renewedAt === "string" &&
    typeof /** @type {Record<string, unknown>} */ (lease).expiresAt === "string" &&
    !Number.isNaN(Date.parse(/** @type {string} */ (/** @type {Record<string, unknown>} */ (lease).acquiredAt))) &&
    !Number.isNaN(Date.parse(/** @type {string} */ (/** @type {Record<string, unknown>} */ (lease).renewedAt))) &&
    Date.parse(/** @type {string} */ (/** @type {Record<string, unknown>} */ (lease).expiresAt)) > now,
  );
}

/**
 * @param {string} runDir
 * @param {LeaseOptions} options
 * @returns {ReturnType<typeof createLeaseHandle>}
 */
export function acquireControllerLease(runDir, options = {}) {
  return acquireLease(runDir, { requireHolderDeath: true, ...options, fileName: LEASE_FILE });
}

/**
 * @param {string} runDir
 * @param {LeaseOptions} options
 * @returns {ReturnType<typeof createLeaseHandle>}
 */
export function acquireSupervisorLease(runDir, options = {}) {
  return acquireLease(runDir, { ...options, fileName: SUPERVISOR_LEASE_FILE });
}

/**
 * @param {string} runDir
 * @param {LeaseOptions} options
 * @returns {ReturnType<typeof createLeaseHandle>}
 */
export function acquireLease(runDir, options) {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, /** @type {string} */ (options.fileName));
  const holderId = options.holderId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const contractVersion = options.contractVersion ?? "unknown";
  let generation = 1;
  try {
    const metadata = readJson(join(runDir, "run.json"));
    if (Number.isInteger(metadata.leaseGeneration)) generation = /** @type {number} */ (metadata.leaseGeneration) + 1;
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  const now = options.now ?? Date.now();
  let fenced = false;
  for (let attempt = 0; attempt < LEASE_TAKEOVER_ATTEMPTS; attempt += 1) {
    const lock = acquireFileMutationLock(runDir, /** @type {string} */ (options.fileName));
    try {
      const previous = readLeaseFile(path);
      if (previous && !previous.invalid) {
        if (Number.isInteger(previous.generation)) generation = /** @type {number} */ (previous.generation) + 1;
        if (leaseHealthy(previous, now)) {
          throw new LeaseBusyError(
            `run controller lease is held by ${previous.holderId} until ${previous.expiresAt}`,
            previous,
          );
        }
        // An expired lease is not an abandoned one. Taking it over while its
        // controller still runs forks the run, so adoption needs proof of death
        // (pid gone, or its process start token no longer matches).
        if (options.requireHolderDeath) {
          const verdict = leaseAdoption(previous, { now, probes: options.livenessProbes });
          if (!verdict.adopt) {
            throw new LeaseBusyError(
              `run controller lease held by ${previous.holderId} expired at ${previous.expiresAt} but its controller pid ${previous.pid} is alive`,
              previous,
            );
          }
        }
      }
      // Take the exclusive right to install this generation before anything
      // destructive happens. The mutation lock expires, so a contender
      // descheduled past its TTL can wake up holding decisions made from a
      // lease that has since been replaced; the fence is what stops it from
      // acting on them, because the rival that would replace the lease cannot
      // get past this claim while the claim's owner lives.
      const fence = claimGenerationFence(
        path,
        { holderId, pid, processStartToken: options.processStartToken ?? null },
        generation,
        { probes: options.livenessProbes },
      );
      if (!fence.claimed) {
        fenced = true;
        continue;
      }
      try {
        // Cheap early exit for a contender that already lost: the lock must
        // still be ours with room to finish, and the file must still hold the
        // record the takeover was decided from.
        if (!lock.heldWithMargin(LOCK_WRITE_MARGIN_MS) || !sameLeaseFile(readLeaseFile(path), previous)) continue;
        const acquiredAt = new Date(now).toISOString();
        /** @type {LeaseRecord} */
        const lease = {
          schemaVersion: 1,
          contractVersion,
          holderId,
          generation,
          pid,
          processStartToken: options.processStartToken ?? null,
          acquiredAt,
          renewedAt: acquiredAt,
          expiresAt: new Date(now + ttlMs).toISOString(),
        };
        if (!installFencedLease(path, lease, runDir, fence)) continue;
        return createLeaseHandle(runDir, lease, ttlMs, { ...options, fileName: /** @type {string} */ (options.fileName) });
      } finally {
        fence.release();
      }
    } finally {
      lock.release();
    }
  }
  if (fenced) throw new LeaseBusyError(`lease takeover for ${options.fileName} was fenced by another contender`, readLeaseFile(path));
  throw new LeaseBusyError(`contended lease takeover for ${options.fileName} did not settle`, readLeaseFile(path));
}

/**
 * Take the lease file out of the way and rule on what came out of it.
 *
 * This is the takeover's compare-and-swap, and it is split in two on purpose:
 * every step that could destroy another controller's lease is either atomic or
 * reversible, so a contender may be descheduled anywhere in the sequence and
 * still be unable to do damage.
 *
 * The capture is one rename. It does not read the file and then remove it —
 * there is no gap in which a newer winner could slip under the name and be
 * deleted by a decision made about its predecessor. What the rename yields is
 * the occupant itself, and the generation carried in that occupant is the
 * fencing token: a token at or beyond the one being installed means this
 * contender lost while it was away, and the occupant is put straight back.
 *
 * The install is one conditional link. It can only create the name, never
 * replace it, so a contender that stalls between the ruling and the write
 * finds the name taken and fails instead of overwriting the taker. The
 * generation claim narrows who reaches this code; these two steps are what
 * make exactly one of them succeed.
 * @param {string} path
 * @param {number} generation the generation this contender intends to install
 * @param {string} runDir
 * @returns {{authorized: boolean, occupant: ReadLeaseResult, install: (lease: LeaseRecord) => boolean}}
 */
export function captureLeaseSlot(path, generation, runDir) {
  const aside = captureEntry(path);
  fsyncDirectory(runDir);
  const occupant = aside === null ? null : readLeaseFile(aside);
  const held = occupant !== null && !occupant.invalid ? occupant : null;
  const superseded = held === null || !Number.isInteger(held.generation) || held.generation < generation;
  if (!superseded) {
    restoreEntry(/** @type {string} */ (aside), path);
    fsyncDirectory(runDir);
    return { authorized: false, occupant, install: () => false };
  }
  return {
    authorized: true,
    occupant,
    install(lease) {
      let installed = true;
      try {
        writeLeaseExclusive(path, lease, runDir);
      } catch (error) {
        // The link only fails because a lease already holds the name, and the
        // holder of that name won: this contender installs nothing.
        if (errorCode(error) !== "EEXIST") throw error;
        installed = false;
      }
      // The captured predecessor is superseded either way — by this lease or by
      // whichever one took the name first.
      if (aside !== null) discardEntry(aside);
      fsyncDirectory(runDir);
      return installed;
    },
  };
}

/**
 * @param {string} path
 * @param {LeaseRecord} lease
 * @param {string} runDir
 * @param {{owned: () => boolean}|null} fence
 * @returns {boolean} false when another contender holds the lease this one meant to install
 */
export function installFencedLease(path, lease, runDir, fence = null) {
  // A contender that no longer holds its generation claim has already lost the
  // takeover; refusing here keeps it from even capturing the file.
  if (fence && !fence.owned()) return false;
  return captureLeaseSlot(path, lease.generation, runDir).install(lease);
}

/**
 * Compare-and-swap witness: the lease file must still hold exactly the record a
 * takeover decision was made from. A renewal, a takeover or a release by anyone
 * else all change these bytes.
 * @param {ReadLeaseResult} actual
 * @param {ReadLeaseResult} expected
 * @returns {boolean}
 */
function sameLeaseFile(actual, expected) {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}

/**
 * @param {string} runDir
 * @param {LeaseRecord} initial
 * @param {number} ttlMs
 * @param {LeaseOptions} options
 * @returns {LeaseRecord & {current: LeaseRecord, renew: () => boolean, assert: () => void, startHeartbeat: (onLost?: (error: Error) => void) => void, stopHeartbeat: () => void, release: () => void, released: boolean, options: LeaseOptions}}
 */
function createLeaseHandle(runDir, initial, ttlMs, options) {
  let current = initial;
  let released = false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let heartbeatTimer = null;
  const heartbeatLossHandlers = new Set();
  const renew = () => {
    if (released) return false;
    let renewed = null;
    const lock = acquireFileMutationLock(runDir, /** @type {string} */ (options.fileName));
    try {
      const actual = readLeaseFile(join(runDir, /** @type {string} */ (options.fileName)));
      // A delayed heartbeat may find its own lease expired on disk; that is not
      // a loss (takeover by others is guarded by sameLease + the mutation lock).
      // Loss is only real when another holder replaced or removed the lease.
      if (!sameLease(actual, current)) return false;
      const now = Date.now();
      current = /** @type {LeaseRecord} */ ({
        ...actual,
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      });
      writeJsonAtomic(join(runDir, /** @type {string} */ (options.fileName)), current);
      renewed = current;
    } finally {
      lock.release();
    }
    options.onRenew?.(renewed);
    return true;
  };
  const assert = () => {
    if (released || !sameLease(readLeaseFile(join(runDir, /** @type {string} */ (options.fileName))), current)) {
      throw new LeaseLostError();
    }
  };
  /** @type {(onLost?: (error: Error) => void) => void} */
  const startHeartbeat = (onLost = () => {}) => {
    heartbeatLossHandlers.add(onLost);
    if (heartbeatTimer) return;
    const interval = Math.max(50, Math.floor(ttlMs / 3));
    heartbeatTimer = setInterval(() => {
      try {
        if (!renew()) {
          for (const handler of heartbeatLossHandlers) handler(new LeaseLostError());
        }
      } catch (error) {
        for (const handler of heartbeatLossHandlers) handler(/** @type {Error} */ (error));
      }
    }, interval);
    heartbeatTimer.unref?.();
  };
  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatLossHandlers.clear();
  };
  const release = () => {
    if (released) return;
    stopHeartbeat();
    const lock = acquireFileMutationLock(runDir, /** @type {string} */ (options.fileName));
    try {
      const path = join(runDir, /** @type {string} */ (options.fileName));
      // Capture before deciding, for the same reason a takeover does: a release
      // that read the file, stalled, and then unlinked would take a successor's
      // lease with it. What is captured is either ours to drop or theirs to
      // keep.
      const aside = captureEntry(path);
      if (aside !== null) {
        if (sameLease(readLeaseFile(aside), current)) discardEntry(aside);
        else restoreEntry(aside, path);
        fsyncDirectory(runDir);
      }
    } finally {
      lock.release();
      released = true;
    }
  };
  return {
    ...current,
    get current() { return current; },
    renew,
    assert,
    startHeartbeat,
    stopHeartbeat,
    release,
    get released() { return released; },
    options,
  };
}

/**
 * @param {ReadLeaseResult} left
 * @param {LeaseRecord} right
 * @returns {boolean}
 */
function sameLease(left, right) {
  return Boolean(
    left && !left.invalid &&
    left.holderId === right.holderId &&
    left.generation === right.generation &&
    left.pid === right.pid &&
    left.processStartToken === right.processStartToken,
  );
}

/**
 * @param {string} directory
 * @param {string} fileName
 * @returns {{holderId: string, heldWithMargin: (marginMs: number) => boolean, release: () => void}}
 */
export function acquireFileMutationLock(directory, fileName) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${basename(fileName)}.lock`);
  for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
    const holder = {
      pid: process.pid,
      holderId: randomUUID(),
      expiresAt: new Date(Date.now() + FILE_LOCK_TTL_MS).toISOString(),
    };
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(holder)}\n`, 0, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(directory);
      return {
        holderId: holder.holderId,
        /**
         * The lock has a TTL, so a contender descheduled inside its critical
         * section can find the lock reclaimed and reissued to somebody else.
         * A destructive write must therefore confirm it still owns the lock and
         * still has time to finish before it touches the file.
         * @param {number} marginMs
         * @returns {boolean}
         */
        heldWithMargin(marginMs) {
          try {
            const current = readJson(path);
            return current.holderId === holder.holderId
              && Date.parse(/** @type {string} */ (current.expiresAt)) - Date.now() >= marginMs;
          } catch (error) {
            if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return false;
            throw error;
          }
        },
        release() {
          try {
            const current = readJson(path);
            if (current.holderId !== holder.holderId) return;
            unlinkSync(path);
            fsyncDirectory(directory);
          } catch (error) {
            if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          }
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let current = null;
      let invalid = false;
      try { current = readJson(path); } catch (readError) {
        if (readError instanceof SyntaxError) invalid = true;
        else if (errorCode(readError) !== "ENOENT") throw readError;
      }
      let lockAgeMs = 0;
      if (invalid) {
        try { lockAgeMs = Date.now() - statSync(path).mtimeMs; } catch (statError) {
          if (errorCode(statError) === "ENOENT") continue;
          throw statError;
        }
      }
      const expired = current
        ? !Number.isFinite(Date.parse(/** @type {string} */ (current.expiresAt))) || Date.parse(/** @type {string} */ (current.expiresAt)) <= Date.now()
        : !invalid || lockAgeMs > FILE_LOCK_TTL_MS;
      if (expired) {
        const stale = `${path}.stale.${process.pid}.${randomUUID()}`;
        try {
          renameSync(path, stale);
          unlinkSync(stale);
          fsyncDirectory(directory);
        } catch (reclaimError) {
          if (errorCode(reclaimError) !== "ENOENT") throw reclaimError;
        }
        continue;
      }
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  throw new LeaseBusyError(`file mutation lock is held for ${fileName}`);
}

/**
 * @param {string} path
 * @param {LeaseRecord} lease
 * @param {string} runDir
 */
function writeLeaseExclusive(path, lease, runDir) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeTextAtomic(temporary, `${JSON.stringify(lease, null, 2)}\n`);
  try {
    linkSync(temporary, path);
    fsyncDirectory(runDir);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
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
