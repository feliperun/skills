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

export const LEASE_FILE = "controller-lease.json";
export const SUPERVISOR_LEASE_FILE = "supervisor-lease.json";
export const BOOTSTRAP_FILE = "bootstrap.json";
export const DEFAULT_LEASE_TTL_MS = 15_000;
const LEASE_LOCK_TTL_MS = 5_000;
const LEASE_LOCK_ATTEMPTS = 120;
const JSONL_RECOVERY_TAIL_BYTES = 64 * 1024;

/** @typedef {{schemaVersion: number, contractVersion: string, holderId: string, generation: number, pid: number, processStartToken: string|null, acquiredAt: string, renewedAt: string, expiresAt: string, invalid?: never}} LeaseRecord */
/** @typedef {LeaseRecord|null|{invalid: true, path: string}} ReadLeaseResult */
/** @typedef {{holderId?: string, pid?: number, ttlMs?: number, contractVersion?: string, processStartToken?: string|null, now?: number, fileName?: string, onRenew?: (lease: LeaseRecord) => void}} LeaseOptions */

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
  return acquireLease(runDir, { ...options, fileName: LEASE_FILE });
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
  for (;;) {
    const lock = acquireLeaseMutationLock(runDir, /** @type {string} */ (options.fileName));
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
        unlinkLease(path, runDir);
      }
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
      writeLeaseExclusive(path, lease, runDir);
      return createLeaseHandle(runDir, lease, ttlMs, { ...options, fileName: /** @type {string} */ (options.fileName) });
    } finally {
      lock.release();
    }
  }
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
    const lock = acquireLeaseMutationLock(runDir, /** @type {string} */ (options.fileName));
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
    const lock = acquireLeaseMutationLock(runDir, /** @type {string} */ (options.fileName));
    try {
      const path = join(runDir, /** @type {string} */ (options.fileName));
      const actual = readLeaseFile(path);
      if (sameLease(actual, current)) unlinkLease(path, runDir);
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
 * @param {string} runDir
 * @param {string} fileName
 * @returns {{release: () => void}}
 */
function acquireLeaseMutationLock(runDir, fileName) {
  const path = join(runDir, `${basename(fileName)}.lock`);
  for (let attempt = 0; attempt < LEASE_LOCK_ATTEMPTS; attempt += 1) {
    const holder = {
      pid: process.pid,
      holderId: randomUUID(),
      expiresAt: new Date(Date.now() + LEASE_LOCK_TTL_MS).toISOString(),
    };
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(holder)}\n`, 0, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(runDir);
      return {
        release() {
          try {
            const current = readJson(path);
            if (current.holderId !== holder.holderId) return;
            unlinkSync(path);
            fsyncDirectory(runDir);
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
        : !invalid || lockAgeMs > LEASE_LOCK_TTL_MS;
      if (expired) {
        const stale = `${path}.stale.${process.pid}.${randomUUID()}`;
        try {
          renameSync(path, stale);
          unlinkSync(stale);
          fsyncDirectory(runDir);
        } catch (reclaimError) {
          if (errorCode(reclaimError) !== "ENOENT") throw reclaimError;
        }
        continue;
      }
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  throw new LeaseBusyError(`lease mutation lock is held for ${fileName}`);
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
 * @param {string} path
 * @param {string} runDir
 */
function unlinkLease(path, runDir) {
  try {
    unlinkSync(path);
    fsyncDirectory(runDir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
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
