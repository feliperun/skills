/**
 * Schema 2 Definition of Done items. Each item is an object that names an
 * observable outcome and declares how it is proven: mechanically through a
 * `proof` (a verification `command`, a workspace `path`, or a `verification`
 * entry reused by reference) or by judge `judgment`. The schema-1 string item
 * is rejected; there is no converter and no dual acceptance.
 */

/** @typedef {{kind: "command"|"path"|"verification", ref: string}} DefinitionOfDoneProof */

/** @typedef {{id: string, text: string, proof?: DefinitionOfDoneProof, judgment?: true}} DefinitionOfDoneItem */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number}} [options]
 * @returns {DefinitionOfDoneItem[]}
 */
export function validateDefinitionOfDone(value, label, options = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of Definition of Done objects`);
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (typeof item === "string") {
      throw new TypeError(`${itemLabel} must be an object, not a schema-1 string item`);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`${itemLabel} must be an object with id, text, and proof or judgment: true`);
    }
    const record = /** @type {Record<string, unknown>} */ (item);
    rejectUnknown(record, new Set(["id", "text", "proof", "judgment"]), itemLabel);
    requireId(record.id, `${itemLabel}.id`);
    requireString(record.text, `${itemLabel}.text`);
    if (record.judgment !== undefined && record.judgment !== true) {
      throw new TypeError(`${itemLabel}.judgment must be true when present`);
    }
    const proof = record.proof === undefined
      ? undefined
      : validateProof(record.proof, `${itemLabel}.proof`, options);
    if (proof === undefined && record.judgment !== true) {
      throw new TypeError(`${itemLabel} must declare proof or judgment: true`);
    }
    return {
      id: /** @type {string} */ (record.id),
      text: /** @type {string} */ (record.text),
      ...(proof === undefined ? {} : { proof }),
      ...(record.judgment === true ? { judgment: true } : {}),
    };
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number}} options
 * @returns {DefinitionOfDoneProof}
 */
function validateProof(value, label, options) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object with kind and ref`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknown(record, new Set(["kind", "ref"]), label);
  const kind = record.kind;
  if (kind !== "command" && kind !== "path" && kind !== "verification") {
    throw new TypeError(`${label}.kind must be "command", "path", or "verification"`);
  }
  if (kind === "verification") return { kind, ref: validateVerificationRef(record.ref, label, options) };
  requireString(record.ref, `${label}.ref`);
  return { kind, ref: /** @type {string} */ (record.ref) };
}

/**
 * A `verification` proof reuses a recorded controller verification result by
 * position, never by comparing command strings: a joined argv loses argument
 * boundaries and shell semantics, so the reference is the only sound name.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number}} options
 * @returns {string}
 */
function validateVerificationRef(value, label, options) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/u.test(text.trim())) {
    throw new TypeError(`${label}.ref must be the zero-based index of a verification command`);
  }
  const index = Number.parseInt(text, 10);
  if (typeof options.verificationCount === "number" && index >= options.verificationCount) {
    throw new TypeError(`${label}.ref ${index} names no verification command: the packet declares ${options.verificationCount}`);
  }
  if (typeof options.recordableCount === "number" && index >= options.recordableCount) {
    throw new TypeError(`${label}.ref ${index} cannot be reused at gate time: only the first ${options.recordableCount} verification commands are recorded on the node`);
  }
  return String(index);
}

/**
 * @param {Record<string, unknown>} record
 * @param {Set<string>} fields
 * @param {string} label
 */
function rejectUnknown(record, fields, label) {
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}
