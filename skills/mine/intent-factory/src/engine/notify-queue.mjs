/**
 * The controller's notification queue, one per run directory, plus the campaign
 * handoff render that must never take a run down with it.
 *
 * Notifications are serialized per run because the outbox is a file: two
 * concurrent appends interleave. `alreadyNotified` is the dedupe key check that
 * keeps a resumed run from re-announcing what the previous controller already
 * announced.
 */
import { NotifyQueue } from "../notify/index.mjs";
import { appendJsonl } from "../run/store.mjs";
import { errorMessage } from "../util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHandoff } from "../campaign/index.mjs";

/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */

/**
 * One notify queue per run, so retries and the notify.jsonl receipt log stay
 * scoped to the run that owns them across the whole controller lifetime.
 * @type {Map<string, NotifyQueue>}
 */
export const notifyQueuesByRun = new Map();
/** @param {string} runDir @returns {NotifyQueue} */
export function notifyQueueFor(runDir) {
  let queue = notifyQueuesByRun.get(runDir);
  if (!queue) {
    queue = new NotifyQueue({ runDir });
    notifyQueuesByRun.set(runDir, queue);
  }
  return queue;
}
/**
 * Whether `notify.jsonl` already carries a receipt for this exact logical
 * event. A resumed controller starts a fresh in-memory notify queue, so
 * without this durable check it would re-notify every node that was already
 * terminal before the resume; the durable log is the only thing that
 * survives the process boundary.
 *
 * @param {string} runDir
 * @param {string} dedupeKey
 * @returns {boolean}
 */
export function alreadyNotified(runDir, dedupeKey) {
  const path = join(runDir, "notify.jsonl");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).dedupeKey === dedupeKey) return true;
    } catch {
      // A torn trailing line was never a committed receipt.
    }
  }
  return false;
}
/**
 * @param {CampaignRef} campaign
 * @param {string} runsDir
 * @param {string} runDir
 * @returns {boolean}
 */
export function renderCampaignHandoffSafely(campaign, runsDir, runDir) {
  try {
    renderHandoff(campaign.path, runsDir);
    return true;
  } catch (error) {
    /** @type {Record<string, unknown>} */
    const diagnostic = {
      type: "campaign.handoff-failed",
      at: new Date().toISOString(),
      campaignId: campaign.campaign.id,
      error: errorMessage(error),
    };
    try {
      appendJsonl(join(runDir, "events.jsonl"), diagnostic);
    } catch {
      // A failed diagnostic must not abort the controller either.
    }
    process.stderr.write(`[warn] campaign handoff render failed: ${errorMessage(error)}\n`);
    return false;
  }
}
