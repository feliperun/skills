import {
  closeSync,
  ftruncateSync,
  fsyncSync,
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
import { dirname, join } from "node:path";

export const BOOTSTRAP_FILE = "bootstrap.json";
const JSONL_RECOVERY_TAIL_BYTES = 64 * 1024;

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
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return error.code;
  return undefined;
}
