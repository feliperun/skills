/**
 * Where a campaign's files live and how big each one may be.
 *
 * Every byte ceiling in the campaign layer is here rather than beside the code
 * that enforces it, because the ceilings interact: the handoff has a total
 * budget, the journal a per-entry cap, the projection a list cap, and a change
 * to one is a decision about the others. They were scattered across one
 * 1,418-line file, which is how a "small" limit bump becomes a surprise.
 */
import { join } from "node:path";
import { requireId } from "../contract/assert.mjs";

export const CAMPAIGN_DIR_NAME = "campaigns";
export const CAMPAIGN_FILE = "campaign.json";
export const JOURNAL_FILE = "journal.jsonl";
export const HANDOFF_FILE = "HANDOFF.md";
export const PROJECTION_FILE = "projection.json";
export const JOURNAL_WATCH_CURSOR_DIR = "watch-cursors";
export const JOURNAL_WATCH_CURSOR_SCHEMA_VERSION = 1;
export const HANDOFF_LIMIT = 20;
export const HANDOFF_BYTES = 16 * 1024;
export const JOURNAL_TEXT_BYTES = 2 * 1024;
export const GOAL_TEXT_BYTES = 4 * 1024;
export const RENDER_NOTE_BYTES = 300;
export const PROJECTION_LIST_CAP = 60;
export const PROJECTION_ACTIVE_CAP = 100;
export const JOURNAL_TAIL_BYTES = 4096;
export const CRITICAL_FLOOR_BYTES = 512;
export const ID_CAP_FLOOR = 48;
/**
 * @param {string} runsDir
 * @returns {string}
 */
export function campaignsDir(runsDir) {
  return join(runsDir, CAMPAIGN_DIR_NAME);
}
/**
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {string}
 */
export function campaignDir(runsDir, campaignId) {
  requireId(campaignId, "campaignId");
  return join(campaignsDir(runsDir), campaignId);
}
/** @param {string} value @returns {string} */
export function basenameSafe(value) {
  return value.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "campaign";
}
