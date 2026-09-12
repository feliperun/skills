/**
 * The protocol version gate. Every top-level artefact -- a contract, a run
 * metadata record, a node snapshot, an event -- carries `schemaVersion` and
 * `contractVersion`, and this is the one place that refuses a mismatch.
 *
 * It is its own module because all four validators need it, so leaving it in
 * `contract/index.mjs` made `contract/snapshot.mjs` import the contract
 * validator just to borrow it.
 */
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION } from "../harnesses/index.mjs";

/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */

/**
 * @param {JsonObject} value
 * @param {string} label
 */
export function validateMetadata(value, label) {
  if (value.schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
    throw new TypeError(`${label}.schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`);
  }
  if (value.contractVersion !== INTENT_FACTORY_VERSION) {
    throw new TypeError(`${label}.contractVersion must be ${INTENT_FACTORY_VERSION}`);
  }
}
