import { appendFileSync } from "node:fs";

/**
 * Claude session wake adapter (Addendum 01 section 9, ADR-0019). A session
 * wake exists only for an event the projector already marked requiresUser;
 * the adapter never re-derives that fact. It declares canWake true and
 * canPush false, so pushNotification can never route it and progress can
 * never reach a session even by accident.
 */

export const SESSION_WAKE_ENV = "INTENT_FACTORY_SESSION_WAKE";
export const WAKE_MAX_BYTES = 512;

const SUMMARY_CHARS = 160;

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {import("./index.mjs").NotificationEvent} NotificationEvent */
/** @typedef {import("./index.mjs").WakeResult} WakeResult */
/** @typedef {(record: JsonObject) => WakeResult|Promise<WakeResult>|void|Promise<void>} WakeChannel */

/**
 * Create the Claude session adapter. The wake channel is bound by the host:
 * an injected function wins, else the JSONL file named by SESSION_WAKE_ENV.
 * With no channel bound, wake resolves { ok: false } without writing.
 *
 * @param {{wake?: WakeChannel, wakeFile?: string, at?: () => string}} [options]
 * @returns {import("./index.mjs").NotifyAdapter}
 */
export function createClaudeSessionAdapter({ wake, wakeFile = process.env[SESSION_WAKE_ENV], at = () => new Date().toISOString() } = {}) {
  const channel = typeof wake === "function" ? wake : fileChannel(wakeFile);
  return {
    id: "claude-session",
    capabilities: { canPush: false, canWake: true, canRenderAmbient: false },
    async deliver() {
      return { ok: false, error: "claude-session cannot push" };
    },
    async wake(event) {
      if (!event || event.requiresUser !== true) return { ok: false, error: "wake requires a requiresUser event" };
      if (channel === null) return { ok: false, error: "no session wake channel bound" };
      try {
        const result = await channel(boundedRecord(event, at()));
        if (result && typeof result === "object" && result.ok === false) {
          return { ok: false, error: typeof result.error === "string" && result.error ? result.error : "wake failed" };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

/**
 * @param {string|undefined} wakeFile
 * @returns {WakeChannel|null}
 */
function fileChannel(wakeFile) {
  if (typeof wakeFile !== "string" || !wakeFile.trim()) return null;
  return (record) => {
    appendFileSync(wakeFile, `${JSON.stringify(record)}\n`);
  };
}

/**
 * The wake payload: the canonical projected fields a session needs to act,
 * bounded to WAKE_MAX_BYTES by truncating the summary first.
 *
 * @param {NotificationEvent} event
 * @param {string} wokeAt
 * @returns {JsonObject}
 */
function boundedRecord(event, wokeAt) {
  /** @type {JsonObject} */
  const record = {
    wokeAt,
    eventId: typeof event.eventId === "string" ? event.eventId : null,
    type: typeof event.type === "string" ? event.type : "",
    campaignId: typeof event.campaignId === "string" ? event.campaignId : null,
    next: typeof event.next === "string" ? event.next : "",
    requiresUser: true,
    summary: truncateChars(typeof event.summary === "string" ? event.summary : "", SUMMARY_CHARS),
  };
  let summary = /** @type {string} */ (record.summary);
  while (Buffer.byteLength(JSON.stringify(record), "utf8") > WAKE_MAX_BYTES && summary.length > 0) {
    summary = truncateChars(summary, Math.floor(Array.from(summary).length / 2));
    record.summary = summary;
  }
  return record;
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function truncateChars(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
