import { createHash } from "node:crypto";

/** Latest portable continuation capsule schema version. */
export const CAPSULE_VERSION = 1;

/** Default serialized size bound for a capsule. */
export const DEFAULT_CAPSULE_BYTES = 16 * 1024;

/** @typedef {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} CapsuleUsage */
/** @typedef {{handle: string, sha256: string, bytes: number|null, preview: string|null, previewTruncated?: boolean}} CapsuleArtifact */
/** @typedef {{kind: string, ref: string, settledAt?: string}} CapsuleReceipt */
/** @typedef {{argv: string, pass: boolean}} CapsuleVerification */
/**
 * Versioned portable continuation capsule. Everything a fresh harness needs to
 * continue a node without the prior transcript.
 *
 * @typedef {{
 *   capsuleVersion: number,
 *   runId: string,
 *   nodeId: string,
 *   attemptId: string,
 *   objective: string,
 *   constraints: string[],
 *   decisions: string[],
 *   nonGoals: string[],
 *   changedFiles: string[],
 *   worktreeIdentity: {gitHead: string|null, dirty: boolean},
 *   receipts: CapsuleReceipt[],
 *   verifications: CapsuleVerification[],
 *   artifacts: CapsuleArtifact[],
 *   blockers: string[],
 *   nextAction: string|null,
 *   usage: CapsuleUsage,
 *   costUsd: number|null,
 *   budgetRemaining: number|null,
 *   continuationHint: string|null,
 *   digest?: string,
 *   artifactsTruncated?: boolean,
 *   receiptsTruncated?: boolean,
 *   verificationsTruncated?: boolean,
 *   changedFilesTruncated?: boolean,
 *   constraintsTruncated?: boolean,
 *   decisionsTruncated?: boolean,
 *   nonGoalsTruncated?: boolean,
 *   blockersTruncated?: boolean,
 * }} Capsule
 */

const CAPSULE_TOP_LEVEL_FIELDS = new Set([
  "capsuleVersion",
  "runId",
  "nodeId",
  "attemptId",
  "objective",
  "constraints",
  "decisions",
  "nonGoals",
  "changedFiles",
  "worktreeIdentity",
  "receipts",
  "verifications",
  "artifacts",
  "blockers",
  "nextAction",
  "usage",
  "costUsd",
  "budgetRemaining",
  "continuationHint",
  // Bounding flags emitted by buildCapsule when a field was cut down.
  "digest",
  "artifactsTruncated",
  "receiptsTruncated",
  "verificationsTruncated",
  "changedFilesTruncated",
  "constraintsTruncated",
  "decisionsTruncated",
  "nonGoalsTruncated",
  "blockersTruncated",
]);

const STRING_LIST_FIELDS = /** @type {const} */ (["constraints", "decisions", "nonGoals", "changedFiles", "blockers"]);

const TRUNCATION_MARKER = "…[truncated]";
const MAX_OBJECTIVE_BYTES = 4096;
const MAX_LIST_ITEM_BYTES = 1024;
const MAX_RECEIPTS = 64;
const MAX_VERIFICATIONS = 64;
const MAX_ARTIFACTS = 32;

// Redaction rules are intentionally small and deterministic so a capsule built
// on one host parses identically everywhere. They never read process.env: the
// capsule must not depend on the building host's environment.
//
// 1. ENV_ASSIGNMENT: an entire string shaped `KEY=value` with an uppercase
//    variable name carries an environment assignment; the value is dropped.
// 2. BEARER: credential schemes (`bearer <token>`) keep the scheme only.
// 3. HIGH_ENTROPY: runs of 32+ credential-class characters ([A-Za-z0-9_-])
//    mixing letters and digits look like API keys; path separators and dots
//    stay outside the class so ordinary paths survive untouched.
const ENV_ASSIGNMENT_PATTERN = /^[A-Z][A-Z0-9_]{1,}=\S{4,}$/u;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const HIGH_ENTROPY_PATTERN = /[A-Za-z0-9_-]{32,}/gu;
const REQUIRED_IDENTITY_KEYS = new Set(["runId", "nodeId", "attemptId"]);

/**
 * Redact secret-shaped values in a single string.
 *
 * @param {string} value
 * @returns {string}
 */
export function redactCapsuleString(value) {
  let result = value;
  if (ENV_ASSIGNMENT_PATTERN.test(result)) {
    const separator = result.indexOf("=");
    result = `${result.slice(0, separator)}=[redacted]`;
  }
  result = result.replace(BEARER_PATTERN, "$1[redacted]");
  result = result.replace(HIGH_ENTROPY_PATTERN, (match) => {
    return /[A-Za-z]/u.test(match) && /\d/u.test(match) ? "[redacted]" : match;
  });
  return result;
}

/**
 * Deeply redact every string inside a capsule-shaped value.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepRedact(value, key = "") {
  if (typeof value === "string") {
    if (isOpaqueIdentity(value, key)) return value;
    return redactCapsuleString(value);
  }
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (value)).map(([entryKey, entry]) => [entryKey, deepRedact(entry, entryKey)]));
  }
  return value;
}

/**
 * Canonical JSON: sorted keys, no whitespace. Stable across hosts and runs.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic sha-256 digest over the canonical form of the capsule minus
 * any digest field.
 *
 * @param {Capsule} capsule
 * @returns {string}
 */
export function capsuleDigest(capsule) {
  const { ...rest } = /** @type {Record<string, unknown>} */ ({ ...capsule });
  delete rest.digest;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/**
 * Bound a string to a byte length, marking truncation.
 *
 * @param {string} value
 * @param {number} maxBytes
 * @returns {{text: string, truncated: boolean}}
 */
function boundText(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("text byte bound must be a positive integer");
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (maxBytes <= markerBytes) {
    const shortMarker = "[truncated]";
    return { text: shortMarker.slice(0, maxBytes), truncated: true };
  }
  let head = "";
  for (let headBytes = maxBytes - markerBytes; headBytes >= 0; headBytes -= 1) {
    const candidate = encoded.subarray(0, headBytes).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") <= headBytes) {
      head = candidate;
      break;
    }
  }
  return { text: `${head}${TRUNCATION_MARKER}`, truncated: true };
}

/**
 * Keep identity strings opaque while redacting all free text before it is
 * bounded. This prevents a secret from being shortened below its detector's
 * threshold before redaction runs.
 *
 * @param {string} value
 * @param {string} key
 * @returns {string}
 */
function redactBeforeBound(value, key = "") {
  return isOpaqueIdentity(value, key) ? value : redactCapsuleString(value);
}

/**
 * @param {string} value
 * @param {number} maxBytes
 * @param {string} [key]
 * @returns {{text: string, truncated: boolean}}
 */
function boundRedactedText(value, maxBytes, key = "") {
  return boundText(redactBeforeBound(value, key), maxBytes);
}

/**
 * @param {string} value
 * @param {string} key
 * @returns {boolean}
 */
function isOpaqueIdentity(value, key) {
  if (REQUIRED_IDENTITY_KEYS.has(key)) return true;
  if (key === "gitHead") return /^[0-9a-f]{7,64}$/u.test(value);
  if (key === "sha256") return /^[0-9a-f]{64}$/u.test(value);
  return false;
}

/**
 * Build a validated, redacted, bounded capsule from runner state.
 *
 * Oversize handling: artifact previews drop first, then list fields truncate
 * (in artifacts, receipts, verifications, changedFiles, constraints, decisions,
 * nonGoals, blockers order) by removing entries, replacing individual
 * string-list items with the truncation marker, and flagging fields explicitly,
 * then scalar fields shorten or remove deterministically. The function never
 * emits a capsule above `maxBytes` and never fails silently: if even fully
 * truncated required fields cannot fit, it throws.
 *
 * @param {Partial<Capsule>} input
 * @param {{maxBytes?: number}} [options]
 * @returns {Capsule & {digest: string}}
 */
export function buildCapsule(input, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_CAPSULE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive integer");
  const constraints = stringList(input.constraints);
  const decisions = stringList(input.decisions);
  const nonGoals = stringList(input.nonGoals);
  const changedFiles = stringList(input.changedFiles);
  const blockers = stringList(input.blockers);
  const receipts = normalizeReceipts(input.receipts);
  const verifications = normalizeVerifications(input.verifications);
  const artifacts = normalizeArtifacts(input.artifacts);
  const capsule = /** @type {Capsule} */ ({
    capsuleVersion: CAPSULE_VERSION,
    runId: requireText(input.runId, "runId"),
    nodeId: requireText(input.nodeId, "nodeId"),
    attemptId: requireText(input.attemptId, "attemptId"),
    objective: boundRedactedText(requireText(input.objective, "objective"), MAX_OBJECTIVE_BYTES, "objective").text,
    constraints: constraints.values,
    decisions: decisions.values,
    nonGoals: nonGoals.values,
    changedFiles: changedFiles.values,
    worktreeIdentity: {
      gitHead: typeof input.worktreeIdentity?.gitHead === "string"
        ? boundRedactedText(input.worktreeIdentity.gitHead, 128, "gitHead").text
        : null,
      dirty: input.worktreeIdentity?.dirty === true,
    },
    receipts: receipts.values,
    verifications: verifications.values,
    artifacts: artifacts.values,
    blockers: blockers.values,
    nextAction: typeof input.nextAction === "string" ? boundRedactedText(input.nextAction, 1024, "nextAction").text : null,
    usage: {
      inputTokens: nullableNumber(input.usage?.inputTokens),
      outputTokens: nullableNumber(input.usage?.outputTokens),
      cacheReadInputTokens: nullableNumber(input.usage?.cacheReadInputTokens),
    },
    costUsd: nullableNumber(input.costUsd),
    budgetRemaining: nullableNumber(input.budgetRemaining),
    continuationHint: typeof input.continuationHint === "string" ? boundRedactedText(input.continuationHint, 2048, "continuationHint").text : null,
  });

  if (constraints.truncated) capsule.constraintsTruncated = true;
  if (decisions.truncated) capsule.decisionsTruncated = true;
  if (nonGoals.truncated) capsule.nonGoalsTruncated = true;
  if (changedFiles.truncated) capsule.changedFilesTruncated = true;
  if (blockers.truncated) capsule.blockersTruncated = true;
  if (receipts.truncated) capsule.receiptsTruncated = true;
  if (verifications.truncated) capsule.verificationsTruncated = true;
  if (artifacts.truncated) capsule.artifactsTruncated = true;

  /** @type {Record<string, unknown>} */
  let candidate = /** @type {Record<string, unknown>} */ (deepRedact(capsule));
  const serializedSize = (value) => Buffer.byteLength(canonicalJson(value), "utf8");
  const overBudget = (value) => serializedSize({ ...value, digest: "0".repeat(64) }) > maxBytes;
  if (overBudget(candidate)) {
    candidate = dropArtifactPreviews(candidate, serializedSize);
  }
  const listOrder = ["artifacts", "receipts", "verifications", "changedFiles", "constraints", "decisions", "nonGoals", "blockers"];
  for (const field of listOrder) {
    // Halve repeatedly before moving on so one huge list cannot push the
    // overflow onto later, less-important fields.
    let previous = /** @type {Record<string, unknown>|null} */ (null);
    while (overBudget(candidate) && candidate !== previous) {
      previous = candidate;
      candidate = truncateListField(candidate, field, serializedSize);
    }
  }
  candidate = shrinkScalarFields(candidate, overBudget, serializedSize);
  if (overBudget(candidate)) {
    throw new Error(`capsule cannot fit ${maxBytes} bytes even fully truncated`);
  }
  const settled = /** @type {Capsule} */ (candidate);
  return { ...settled, digest: capsuleDigest(settled) };
}

/**
 * Parse and validate a serialized capsule. Rejects wrong versions, missing
 * fields, and unknown top-level fields instead of guessing.
 *
 * @param {string} text
 * @returns {Capsule}
 */
export function parseCapsule(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("capsule must be a JSON object");
  const record = /** @type {Record<string, unknown>} */ (parsed);
  if (record.capsuleVersion !== CAPSULE_VERSION) throw new TypeError(`unsupported capsuleVersion ${JSON.stringify(record.capsuleVersion)}`);
  for (const field of Object.keys(record)) {
    if (!CAPSULE_TOP_LEVEL_FIELDS.has(field)) throw new TypeError(`unknown capsule field ${field}`);
  }
  for (const field of ["runId", "nodeId", "attemptId", "objective"]) {
    if (typeof record[field] !== "string" || record[field].length === 0) throw new TypeError(`capsule.${field} must be a non-empty string`);
  }
  for (const field of ["constraints", "decisions", "nonGoals", "changedFiles", "blockers"]) {
    if (!Array.isArray(record[field])) throw new TypeError(`capsule.${field} must be an array`);
    if (record[field].some((entry) => typeof entry !== "string")) throw new TypeError(`capsule.${field} must contain strings`);
  }
  if (!record.worktreeIdentity || typeof record.worktreeIdentity !== "object") throw new TypeError("capsule.worktreeIdentity must be an object");
  if (!record.usage || typeof record.usage !== "object") throw new TypeError("capsule.usage must be an object");
  if (!Array.isArray(record.receipts)) throw new TypeError("capsule.receipts must be an array");
  if (!Array.isArray(record.verifications)) throw new TypeError("capsule.verifications must be an array");
  if (!Array.isArray(record.artifacts)) throw new TypeError("capsule.artifacts must be an array");
  for (const receipt of record.receipts) validateReceipt(receipt);
  for (const verification of record.verifications) validateVerification(verification);
  for (const artifact of record.artifacts) validateArtifact(artifact);
  validateWorktreeIdentity(record.worktreeIdentity);
  validateUsage(record.usage);
  for (const field of ["costUsd", "budgetRemaining"]) {
    if (!isNullableNumber(record[field])) throw new TypeError(`capsule.${field} must be a finite number or null`);
  }
  if (!("nextAction" in record) || (record.nextAction !== null && typeof record.nextAction !== "string")) {
    throw new TypeError("capsule.nextAction must be a string or null");
  }
  if (record.continuationHint !== null && record.continuationHint !== undefined && typeof record.continuationHint !== "string") {
    throw new TypeError("capsule.continuationHint must be a string or null");
  }
  for (const field of ["digest", ...STRING_LIST_FIELDS.map((name) => `${name}Truncated`), "receiptsTruncated", "verificationsTruncated", "artifactsTruncated"]) {
    if (field === "digest") continue;
    if (record[field] !== undefined && typeof record[field] !== "boolean") throw new TypeError(`capsule.${field} must be boolean`);
  }
  if (typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest)) {
    throw new TypeError("capsule.digest must be a sha-256 hex string");
  }
  if (record.digest !== capsuleDigest(/** @type {Capsule} */ (record))) throw new TypeError("capsule.digest does not match capsule contents");
  return /** @type {Capsule} */ (record);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireText(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`capsule.${field} must be a non-empty string`);
  return value;
}

/**
 * @param {unknown} value
 * @returns {{values: string[], truncated: boolean}}
 */
function stringList(value) {
  if (!Array.isArray(value)) return { values: [], truncated: false };
  let truncated = false;
  const values = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => {
      const bounded = boundRedactedText(/** @type {string} */ (entry), MAX_LIST_ITEM_BYTES);
      truncated ||= bounded.truncated;
      return bounded.text;
    });
  return { values, truncated };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function nullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {{values: CapsuleReceipt[], truncated: boolean}}
 */
function normalizeReceipts(value) {
  if (!Array.isArray(value)) return { values: [], truncated: false };
  return {
    values: value.slice(0, MAX_RECEIPTS).map((receipt) => {
      const record = receipt && typeof receipt === "object" && !Array.isArray(receipt)
        ? /** @type {Record<string, unknown>} */ (receipt)
        : {};
      const normalized = {
        kind: boundRedactedText(String(record.kind ?? ""), 128, "kind").text,
        ref: boundRedactedText(String(record.ref ?? ""), 2048, "ref").text,
      };
      if (typeof record.settledAt === "string") normalized.settledAt = boundRedactedText(record.settledAt, 128, "settledAt").text;
      return normalized;
    }),
    truncated: value.length > MAX_RECEIPTS,
  };
}

/**
 * @param {unknown} value
 * @returns {{values: CapsuleVerification[], truncated: boolean}}
 */
function normalizeVerifications(value) {
  if (!Array.isArray(value)) return { values: [], truncated: false };
  return {
    values: value.slice(0, MAX_VERIFICATIONS).map((verification) => ({
      argv: boundRedactedText(String(verification?.argv ?? ""), 1024, "argv").text,
      pass: verification?.pass === true,
    })),
    truncated: value.length > MAX_VERIFICATIONS,
  };
}

/**
 * @param {unknown} value
 * @returns {{values: CapsuleArtifact[], truncated: boolean}}
 */
function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return { values: [], truncated: false };
  return {
    values: value.slice(0, MAX_ARTIFACTS).map((artifact) => {
      const preview = artifact?.preview === null || artifact?.preview === undefined
        ? { text: null, truncated: false }
        : boundRedactedText(String(artifact.preview), 256, "preview");
      const normalized = {
        handle: boundRedactedText(String(artifact?.handle ?? ""), 2048, "handle").text,
        sha256: boundRedactedText(String(artifact?.sha256 ?? ""), 128, "sha256").text,
        bytes: nullableNumber(artifact?.bytes),
        preview: preview.text || null,
      };
      if (preview.truncated) normalized.previewTruncated = true;
      return normalized;
    }),
    truncated: value.length > MAX_ARTIFACTS,
  };
}

/**
 * @param {unknown} value
 */
function validateReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capsule.receipts entries must be objects");
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.kind !== "string" || typeof record.ref !== "string") throw new TypeError("capsule.receipts entries need kind and ref");
  if (record.settledAt !== undefined && typeof record.settledAt !== "string") throw new TypeError("capsule.receipts.settledAt must be a string");
}

/**
 * @param {unknown} value
 */
function validateVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capsule.verifications entries must be objects");
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.argv !== "string" || typeof record.pass !== "boolean") throw new TypeError("capsule.verifications entries need argv and pass");
}

/**
 * @param {unknown} value
 */
function validateArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capsule.artifacts entries must be objects");
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.handle !== "string" || typeof record.sha256 !== "string") throw new TypeError("capsule.artifacts entries need handle and sha256");
  if (!isNullableNumber(record.bytes)) throw new TypeError("capsule.artifacts.bytes must be a finite number or null");
  if (record.preview !== null && typeof record.preview !== "string") throw new TypeError("capsule.artifacts.preview must be a string or null");
  if (record.previewTruncated !== undefined && typeof record.previewTruncated !== "boolean") throw new TypeError("capsule.artifacts.previewTruncated must be boolean");
}

/**
 * @param {unknown} value
 */
function validateWorktreeIdentity(value) {
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.gitHead !== null && typeof record.gitHead !== "string") throw new TypeError("capsule.worktreeIdentity.gitHead must be a string or null");
  if (typeof record.dirty !== "boolean") throw new TypeError("capsule.worktreeIdentity.dirty must be boolean");
}

/**
 * @param {unknown} value
 */
function validateUsage(value) {
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const field of ["inputTokens", "outputTokens", "cacheReadInputTokens"]) {
    if (!isNullableNumber(record[field])) throw new TypeError(`capsule.usage.${field} must be a finite number or null`);
  }
}

/**
 * @param {unknown} value
 * @returns {value is number|null}
 */
function isNullableNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Drop every artifact preview, recording the loss explicitly.
 *
 * @param {Record<string, unknown>} capsule
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @returns {Record<string, unknown>}
 */
function dropArtifactPreviews(capsule, serializedSize) {
  const artifacts = Array.isArray(capsule.artifacts) ? capsule.artifacts : [];
  const candidate = {
    ...capsule,
    artifacts: artifacts.map((artifact) => {
      const record = /** @type {Record<string, unknown>} */ (artifact);
      if (record.preview === null && record.previewTruncated !== true) return record;
      const removed = { ...record, preview: null, previewTruncated: true };
      return serializedSize(removed) < serializedSize(record) ? removed : record;
    }),
  };
  return serializedSize(candidate) < serializedSize(capsule) ? candidate : capsule;
}

/**
 * Shrink a list field one step, always taking the smallest strictly-smaller
 * candidate so the supported reductions compose: entry removal halves the
 * list and flags the field, any individual string-list item is replaced by
 * the explicit truncation marker when that representation saves bytes, and
 * emptying the list flags the field. A flagged empty list can be larger than
 * the original list, so item-level marker replacement is what lets a lone
 * short item shrink; without it a supported reduction would be missed.
 *
 * @param {Record<string, unknown>} capsule
 * @param {string} field
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @returns {Record<string, unknown>}
 */
function truncateListField(capsule, field, serializedSize) {
  const list = Array.isArray(capsule[field]) ? /** @type {unknown[]} */ (capsule[field]) : [];
  // An empty list cannot shrink; returning the same reference tells the caller
  // this field is exhausted and the bound must come from elsewhere.
  if (list.length === 0) return capsule;

  const truncatedFlag = `${field}Truncated`;
  let best = capsule;
  let bestBytes = serializedSize(capsule);
  const consider = (candidate) => {
    const bytes = serializedSize(candidate);
    if (bytes < bestBytes) {
      best = candidate;
      bestBytes = bytes;
    }
  };

  const kept = Math.floor(list.length / 2);
  if (kept < list.length) {
    consider({ ...capsule, [field]: list.slice(0, kept), [truncatedFlag]: true });
  }
  if (STRING_LIST_FIELDS.includes(field)) {
    const replaced = markerReplaceBestItem(capsule, field, list);
    if (replaced !== capsule) consider(replaced);
  }
  consider({ ...capsule, [field]: [], [truncatedFlag]: true });
  return best;
}

/**
 * Replace the string-list item whose bytes shrink the most with the explicit
 * truncation marker. Ties resolve to the earliest item, keeping the reduction
 * order deterministic. Returns the capsule unchanged when no item shrinks.
 *
 * @param {Record<string, unknown>} capsule
 * @param {string} field
 * @param {unknown[]} list
 * @returns {Record<string, unknown>}
 */
function markerReplaceBestItem(capsule, field, list) {
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let bestIndex = -1;
  let bestSavings = 0;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (typeof entry !== "string" || entry === TRUNCATION_MARKER) continue;
    const savings = Buffer.byteLength(entry, "utf8") - markerBytes;
    if (savings > bestSavings) {
      bestSavings = savings;
      bestIndex = index;
    }
  }
  if (bestIndex === -1) return capsule;
  const replaced = list.slice();
  replaced[bestIndex] = TRUNCATION_MARKER;
  return { ...capsule, [field]: replaced };
}

/**
 * Shorten scalar content only after optional collections are exhausted. The
 * field values carry their own truncation marker, while nullable optional
 * fields may be removed when even the marker cannot fit.
 *
 * @param {Record<string, unknown>} capsule
 * @param {(value: Record<string, unknown>) => boolean} overBudget
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @returns {Record<string, unknown>}
 */
function shrinkScalarFields(capsule, overBudget, serializedSize) {
  let result = capsule;
  for (const field of ["continuationHint", "nextAction"]) {
    if (!overBudget(result)) break;
    result = shrinkTopLevelString(result, field, overBudget, serializedSize, true);
  }
  if (overBudget(result)) result = removeWorktreeGitHead(result, serializedSize);
  for (const field of ["cacheReadInputTokens", "outputTokens", "inputTokens"]) {
    if (!overBudget(result)) break;
    result = removeUsageValue(result, field, serializedSize);
  }
  for (const field of ["costUsd", "budgetRemaining"]) {
    if (!overBudget(result)) break;
    result = removeNullableValue(result, field, serializedSize);
  }
  if (overBudget(result)) result = shrinkTopLevelString(result, "objective", overBudget, serializedSize, false);
  return result;
}

/**
 * Find the longest marked value that fits the remaining structural budget.
 *
 * @param {Record<string, unknown>} capsule
 * @param {string} field
 * @param {(value: Record<string, unknown>) => boolean} overBudget
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @param {boolean} removable
 * @returns {Record<string, unknown>}
 */
function shrinkTopLevelString(capsule, field, overBudget, serializedSize, removable) {
  const value = capsule[field];
  if (typeof value !== "string") return capsule;
  const valueBytes = Buffer.byteLength(value, "utf8");
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const marked = { ...capsule, [field]: TRUNCATION_MARKER };
  if (overBudget(marked)) {
    if (removable) {
      const removed = { ...capsule, [field]: null };
      return serializedSize(removed) < serializedSize(capsule) ? removed : capsule;
    }
    return serializedSize(marked) < serializedSize(capsule) ? marked : capsule;
  }

  let lower = markerBytes;
  let upper = valueBytes;
  let best = marked;
  while (lower <= upper) {
    const targetBytes = Math.floor((lower + upper) / 2);
    const bounded = boundText(value, targetBytes).text;
    const candidate = { ...capsule, [field]: bounded };
    if (!overBudget(candidate)) {
      best = candidate;
      lower = targetBytes + 1;
    } else {
      upper = targetBytes - 1;
    }
  }
  return best;
}

/**
 * Remove the optional worktree hash if scalar content still exceeds the bound.
 * Its nullable schema representation is an explicit deterministic removal.
 *
 * @param {Record<string, unknown>} capsule
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @returns {Record<string, unknown>}
 */
function removeWorktreeGitHead(capsule, serializedSize) {
  const worktreeIdentity = capsule.worktreeIdentity;
  if (!worktreeIdentity || typeof worktreeIdentity !== "object") return capsule;
  const record = /** @type {Record<string, unknown>} */ (worktreeIdentity);
  if (record.gitHead === null || record.gitHead === undefined) return capsule;
  const candidate = {
    ...capsule,
    worktreeIdentity: { ...record, gitHead: null },
  };
  return serializedSize(candidate) < serializedSize(capsule) ? candidate : capsule;
}

/**
 * @param {Record<string, unknown>} capsule
 * @param {string} field
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @returns {Record<string, unknown>}
 */
function removeUsageValue(capsule, field, serializedSize) {
  const usage = capsule.usage;
  if (!usage || typeof usage !== "object") return capsule;
  const record = /** @type {Record<string, unknown>} */ (usage);
  if (record[field] === null || record[field] === undefined) return capsule;
  const candidate = { ...capsule, usage: { ...record, [field]: null } };
  return serializedSize(candidate) < serializedSize(capsule) ? candidate : capsule;
}

/**
 * @param {Record<string, unknown>} capsule
 * @param {string} field
 * @param {(value: Record<string, unknown>) => number} serializedSize
 * @returns {Record<string, unknown>}
 */
function removeNullableValue(capsule, field, serializedSize) {
  if (capsule[field] === null || capsule[field] === undefined) return capsule;
  const candidate = { ...capsule, [field]: null };
  return serializedSize(candidate) < serializedSize(capsule) ? candidate : capsule;
}
