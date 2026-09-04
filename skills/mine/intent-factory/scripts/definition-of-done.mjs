/**
 * Schema 2 Definition of Done items. Each item is an object that names an
 * observable outcome and declares how it is proven: mechanically through a
 * `proof` (a verification `command` or a workspace `path`) or by judge
 * `judgment`. The schema-1 string item is rejected; there is no converter
 * and no dual acceptance.
 */

/** @typedef {{kind: "command"|"path", ref: string}} DefinitionOfDoneProof */

/** @typedef {{id: string, text: string, proof?: DefinitionOfDoneProof, judgment?: true}} DefinitionOfDoneItem */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {DefinitionOfDoneItem[]}
 */
export function validateDefinitionOfDone(value, label) {
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
      : validateProof(record.proof, `${itemLabel}.proof`);
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
 * @returns {DefinitionOfDoneProof}
 */
function validateProof(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object with kind and ref`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknown(record, new Set(["kind", "ref"]), label);
  requireString(record.ref, `${label}.ref`);
  const kind = record.kind;
  if (kind !== "command" && kind !== "path") {
    throw new TypeError(`${label}.kind must be "command" or "path"`);
  }
  return { kind, ref: /** @type {string} */ (record.ref) };
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
