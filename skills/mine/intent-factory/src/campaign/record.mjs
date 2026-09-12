/**
 * The `campaign.json` record itself: read it, validate it, and answer what a
 * campaign's id is.
 *
 * `campaignIdOf` falls back to the directory name when the record cannot be
 * read, because a campaign whose file is corrupt still has to be nameable in an
 * error message.
 */
import { CAMPAIGN_FILE, basenameSafe } from "./layout.mjs";
import { errorCode } from "../util.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { requireId, requireText } from "../contract/assert.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */

/**
 * @param {string} path
 * @returns {Campaign}
 */
export function readCampaign(path) {
  let campaign;
  try {
    campaign = /** @type {unknown} */ (JSON.parse(readFileSync(join(path, CAMPAIGN_FILE), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`campaign not found: ${path}`);
    throw error;
  }
  validateCampaign(campaign);
  return /** @type {Campaign} */ (campaign);
}
/**
 * @param {string} campaignPath
 * @returns {string}
 */
export function campaignIdOf(campaignPath) {
  try {
    return readCampaign(campaignPath).id;
  } catch {
    return basenameSafe(campaignPath);
  }
}
/**
 * @param {unknown} campaign
 */
function validateCampaign(campaign) {
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    throw new TypeError("campaign.json must be an object");
  }
  const record = /** @type {JsonObject} */ (campaign);
  requireId(record.id, "campaign.id");
  requireText(record.goal, "campaign.goal");
  if (record.status !== "active" && record.status !== "closed") {
    throw new TypeError("campaign.status must be active or closed");
  }
  if (!Array.isArray(record.linkedRunIds)) throw new TypeError("campaign.linkedRunIds must be an array");
  for (const runId of record.linkedRunIds) requireId(runId, "campaign.linkedRunIds[]");
}
