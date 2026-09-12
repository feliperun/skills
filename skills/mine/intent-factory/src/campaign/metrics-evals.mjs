/**
 * Small numeric and parsing helpers shared by `metrics.mjs`. Nothing here
 * estimates or weights a token count: every value it touches is a number the
 * platform already recorded.
 */

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {unknown} value
 * @returns {JsonObject|null}
 */
export function jsonObjectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {JsonObject} */ (value) : null;
}

/** @param {unknown} value @returns {number} */
export function timestampMs(value) {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** @param {number} value @returns {number} */
export function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
