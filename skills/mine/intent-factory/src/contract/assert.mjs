/**
 * The primitive assertions every validator in this tree needs, in one place.
 *
 * They were copied instead: `requireString` stood four times, `rejectUnknown`
 * four, `requireId` three, `requireTimestamp` three, and the copies had drifted
 * into six behaviours. Each definition below is the superset of what its copies
 * did, and the message wording is the majority's, because that is what the
 * tests match on (`has unexpected field X`); the tests that cover the others
 * match the label, not the wording, so no assertion changed meaning.
 *
 * Deliberately not here: `requirePacketHash` (a contract-specific format),
 * `requireRuntime` (needs the runtime table), and `repo/integrate.mjs`'s
 * `requireText`, which despite the name reads a file and is a different
 * function entirely.
 */

/**
 * @param {Record<string, unknown>} value
 * @param {Set<string>} allowed
 * @param {string} label
 */
export function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Record<string, unknown>}
 */
export function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

/**
 * A path-safe identifier: letters, numbers, dot, underscore, dash, and never
 * `.` or `..` on their own. The exclusion is load-bearing -- these ids become
 * directory names under `.runs/`.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is string}
 */
export function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
  if (value === "." || value === "..") throw new TypeError(`${label} must not be "." or ".."`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is string}
 */
export function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} [maxBytes]
 * @returns {asserts value is string}
 */
export function requireText(value, label, maxBytes) {
  requireString(value, label);
  if (maxBytes !== undefined && Buffer.byteLength(/** @type {string} */ (value), "utf8") > maxBytes) {
    throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxBytes
 */
export function boundedString(value, label, maxBytes) {
  requireText(value, label, maxBytes);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {boolean} [nonEmpty]
 */
export function requireStringArray(value, label, nonEmpty = false) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (nonEmpty && !value.length) throw new TypeError(`${label} must not be empty`);
  for (const [index, item] of value.entries()) requireString(item, `${label}[${index}]`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is string}
 */
export function requireTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
export function requireInteger(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function nonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive number`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function nonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
export function requirePacketHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`);
}
