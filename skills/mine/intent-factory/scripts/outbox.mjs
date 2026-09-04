/**
 * Human-channel dispatcher (TECH-SPEC section 3.2, Addendum 01 section 7).
 *
 * The durable notification outbox, its delivery transports and the pull
 * cursors live here, separate from the campaign controller that produces the
 * events. Records enter through enqueueNotification already projected by
 * events.mjs, are held to the canonical 1 KiB ceiling on every write, and
 * leave either through drainNotifications (push to the configured executable
 * or the platform adapters) or through watchCampaign/acknowledgeCampaignEvent
 * (durable incremental pull). Nothing here wakes a control session: that
 * boundary belongs to the caller and to the record's own requiresUser field.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireFileMutationLock, readJson, writeJsonAtomic } from "./store.mjs";
import { loadNotifyAdapters, PUSH_EVENT_TYPES, pushNotification } from "./notify/index.mjs";
import { EVENT_MAX_BYTES, boundEventRecord, validateEvent } from "./events.mjs";
import { readCampaign } from "./campaign.mjs";

export const CAMPAIGN_OUTBOX_FILE = "notification-outbox.json";
export const CAMPAIGN_PROGRESS_TYPE = "campaign.progress";
export const CAMPAIGN_WATCH_CURSOR_DIR = "watch-cursors";
/** Cursor records carry the campaign artifact schema version. */
export const OUTBOX_SCHEMA_VERSION = 1;
const MAX_OUTBOX_EVENTS = 100;
const MAX_COALESCE_KEY_BYTES = 256;
const MAX_LAST_ERROR_CHARS = 200;

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{schemaVersion?: number, eventId: string, type: string, campaignId: string, runId?: string|null, nodeId?: string|null, at: string, summary: string, next?: string, requiresUser?: boolean, data?: JsonObject, coalesceKey?: string, deliveredAt?: string|null, attempts: number, lastError?: string|null}} NotificationEvent */

/**
 * Append one projected notification event. The record must be produced by
 * projectEvent (validated on entry) so summary/next/requiresUser stay
 * deterministic and bounded. Undelivered campaign.progress events are
 * coalesced by a bounded key: a newer enqueue rewrites the older pending event
 * in place instead of growing the outbox. Terminal events and delivered
 * history are never rewritten. The read-modify-write is serialized under the
 * outbox mutation lock so concurrent enqueuers cannot lose each other's
 * durable events.
 *
 * @param {string} campaignPath
 * @param {import("./events.mjs").ProjectedEvent} event
 * @param {string} key
 * @param {string} [progressCoalesceKey]
 */
export function enqueueNotification(campaignPath, event, key, progressCoalesceKey = key) {
  validateEvent(event);
  const lock = acquireFileMutationLock(campaignPath, CAMPAIGN_OUTBOX_FILE);
  try {
    const outbox = readNotificationOutbox(campaignPath);
    // The event id is generated inside projectEvent from the enqueue key, so
    // an idempotent re-enqueue of the same logical event carries the same id
    // and is ignored here without rewriting the durable record.
    if (outbox.some((candidate) => candidate.eventId === event.eventId)) return;
    const coalesceKey = event.type === CAMPAIGN_PROGRESS_TYPE ? boundedText(progressCoalesceKey, MAX_COALESCE_KEY_BYTES) : null;
    const record = /** @type {NotificationEvent} */ ({
      ...event,
      deliveredAt: null,
      attempts: 0,
      lastError: null,
    });
    if (coalesceKey !== null) record.coalesceKey = coalesceKey;
    // The canonical record is bounded inside projectEvent; the delivery
    // envelope is bounded here, against the same ceiling, so a record that
    // fits with its metadata is persisted and one that would not is shrunk
    // instead of dropped.
    boundEventRecord(record);
    const coalescedIndex = coalesceKey === null ? -1 : outbox.findIndex((candidate) => !candidate.deliveredAt && candidate.type === event.type && candidate.coalesceKey === coalesceKey);
    if (coalescedIndex >= 0) {
      outbox[coalescedIndex] = record;
      writeOutbox(campaignPath, outbox);
      return;
    }
    while (outbox.length >= MAX_OUTBOX_EVENTS) {
      const deliveredIndex = outbox.findIndex((candidate) => Boolean(candidate.deliveredAt));
      const progressIndex = event.type === CAMPAIGN_PROGRESS_TYPE ? -1 : outbox.findIndex((candidate) => !candidate.deliveredAt && candidate.type === CAMPAIGN_PROGRESS_TYPE);
      const evictableIndex = deliveredIndex >= 0 ? deliveredIndex : progressIndex;
      if (evictableIndex < 0) {
        process.stderr.write("[warn] notification outbox is full of undelivered events; new event was not retained\n");
        return;
      }
      outbox.splice(evictableIndex, 1);
    }
    outbox.push(record);
    writeOutbox(campaignPath, outbox);
  } finally {
    lock.release();
  }
}

/** @param {string} campaignPath @returns {NotificationEvent[]} */
export function readNotificationOutbox(campaignPath) {
  const path = join(campaignPath, CAMPAIGN_OUTBOX_FILE);
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new TypeError("notification outbox must be an array");
  return /** @type {NotificationEvent[]} */ (value);
}

/** @param {string} campaignPath @param {NotificationEvent[]} outbox */
function writeOutbox(campaignPath, outbox) {
  // Retention applies the canonical 1 KiB ceiling: every record is bounded
  // first, so the filter only ever drops a record no bound can rescue.
  const retained = outbox.slice(-MAX_OUTBOX_EVENTS);
  for (const event of retained) boundEventRecord(event);
  const bounded = retained.filter((event) => Buffer.byteLength(JSON.stringify(event), "utf8") <= EVENT_MAX_BYTES);
  writeJsonAtomic(join(campaignPath, CAMPAIGN_OUTBOX_FILE), bounded);
}

/**
 * Deliver pending notification events. Delivery is at-least-once: an event
 * stays pending until the configured executable exits successfully.
 * INTENT_FACTORY_NOTIFY_BIN stays the primary transport; when it is unset,
 * undelivered push events are handed to the platform notify adapters.
 * Each delivery attempt is merged into a fresh durable read under the outbox
 * mutation lock, so a concurrent enqueue can never be clobbered by a stale
 * drainer snapshot, and the lock is never held across adapter I/O.
 *
 * @param {string} campaignPath
 * @param {{adapters?: ReturnType<typeof loadNotifyAdapters>}} [options]
 * @returns {Promise<{delivered: number, pending: number}>}
 */
export async function drainNotifications(campaignPath, options = {}) {
  const executable = process.env.INTENT_FACTORY_NOTIFY_BIN;
  const snapshot = (() => {
    const lock = acquireFileMutationLock(campaignPath, CAMPAIGN_OUTBOX_FILE);
    try {
      return readNotificationOutbox(campaignPath);
    } finally {
      lock.release();
    }
  })();
  let delivered = 0;
  if (!executable) {
    const adapters = options.adapters ?? loadNotifyAdapters();
    for (const event of selectPushableEvents(snapshot)) {
      const result = await pushNotification(event, adapters);
      const failed = result.delivered.length === 0;
      const lock = acquireFileMutationLock(campaignPath, CAMPAIGN_OUTBOX_FILE);
      try {
        const fresh = readNotificationOutbox(campaignPath);
        const record = fresh.find((candidate) => candidate.eventId === event.eventId);
        if (record) {
          if (result.delivered.length > 0) {
            record.deliveredAt = new Date().toISOString();
            record.lastError = null;
            boundEventRecord(record);
            writeOutbox(campaignPath, fresh);
          } else if (result.failed.length > 0) {
            record.attempts = (record.attempts ?? 0) + 1;
            record.lastError = boundedChars(result.failed[0].error, MAX_LAST_ERROR_CHARS);
            boundEventRecord(record);
            writeOutbox(campaignPath, fresh);
          }
        }
      } finally {
        lock.release();
      }
      if (!failed) delivered += 1;
    }
    const lock = acquireFileMutationLock(campaignPath, CAMPAIGN_OUTBOX_FILE);
    try {
      const fresh = readNotificationOutbox(campaignPath);
      return { delivered, pending: fresh.filter((event) => !event.deliveredAt).length };
    } finally {
      lock.release();
    }
  }
  for (const event of snapshot) {
    if (event.deliveredAt) continue;
    const attemptEvent = /** @type {NotificationEvent} */ ({ ...event, attempts: event.attempts + 1 });
    const result = await deliverNotification(executable, attemptEvent);
    const lock = acquireFileMutationLock(campaignPath, CAMPAIGN_OUTBOX_FILE);
    try {
      const fresh = readNotificationOutbox(campaignPath);
      const record = fresh.find((candidate) => candidate.eventId === event.eventId);
      if (record) {
        record.attempts = attemptEvent.attempts;
        if (result.ok) {
          record.deliveredAt = new Date().toISOString();
          record.lastError = null;
        } else {
          record.lastError = boundedChars(result.error, MAX_LAST_ERROR_CHARS);
        }
        boundEventRecord(record);
        writeOutbox(campaignPath, fresh);
      }
      if (result.ok) delivered += 1;
    } finally {
      lock.release();
    }
  }
  const lock = acquireFileMutationLock(campaignPath, CAMPAIGN_OUTBOX_FILE);
  try {
    const fresh = readNotificationOutbox(campaignPath);
    return { delivered, pending: fresh.filter((event) => !event.deliveredAt).length };
  } finally {
    lock.release();
  }
}

/**
 * Pure selection of the outbox events an adapter push may deliver: every
 * undelivered event whose type is in PUSH_EVENT_TYPES. campaign.progress
 * events are never pushable and stay pending for pull consumers.
 *
 * @param {NotificationEvent[]} outbox
 * @returns {NotificationEvent[]}
 */
export function selectPushableEvents(outbox) {
  return outbox.filter((event) => !event.deliveredAt && PUSH_EVENT_TYPES.has(event.type));
}

/**
 * Watch campaign events incrementally. Exactly one of `since` or `cursor` is
 * accepted: `since` is a stateless event ID, while
 * `cursor` names a durable per-watcher position that is advanced atomically
 * after the unseen event list is built, so a repeated invocation returns no
 * events. Cursor ids in the reserved `session-*` namespace are owned by `ack`
 * and never advance here: watch reads over a session cursor stay read-only.
 *
 * @param {string} campaignPath
 * @param {{since?: string, cursor?: string, readOnly?: boolean}} [options]
 * @returns {{campaignId: string, cursor: {cursorId: string, at: string, eventId: string}|null, events: NotificationEvent[]}}
 */
export function watchCampaign(campaignPath, options = {}) {
  if ((options.since !== undefined) === (options.cursor !== undefined)) throw new TypeError("watch requires exactly one of --since or --cursor");
  const outbox = readNotificationOutbox(campaignPath).sort(compareEvents);
  let cursorId = null;
  /** @type {{at: string, eventId: string}} */
  let position;
  if (options.since !== undefined) {
    const since = String(options.since);
    const event = outbox.find((candidate) => candidate.eventId === since);
    if (!event) throw new TypeError("--since event ID is not retained in the notification outbox");
    position = { at: event.at, eventId: event.eventId };
  } else {
    cursorId = String(options.cursor);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(cursorId)) throw new TypeError("--cursor must be a safe identifier");
    position = readWatchCursor(campaignPath, cursorId);
  }
  const events = outbox
    .filter((event) => event.at > position.at || (event.at === position.at && event.eventId > position.eventId));
  // Session cursors are owned by `ack`: sync and watch reads over the
  // session-* namespace never advance the durable position.
  if (cursorId !== null && !options.readOnly && !cursorId.startsWith("session-") && events.length > 0) {
    const last = events[events.length - 1];
    position = { at: last.at, eventId: last.eventId };
    writeWatchCursor(campaignPath, { cursorId, ...position });
  }
  const campaignId = (() => { try { return readCampaign(campaignPath).id; } catch { return basenameSafe(campaignPath); } })();
  return { campaignId, cursor: cursorId === null ? null : { cursorId, ...position }, events };
}

/** @param {NotificationEvent} left @param {NotificationEvent} right @returns {number} */
function compareEvents(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

/** @param {string} campaignPath @param {string} cursorId @returns {{at: string, eventId: string}} */
function readWatchCursor(campaignPath, cursorId) {
  const path = join(campaignPath, CAMPAIGN_WATCH_CURSOR_DIR, `${cursorId}.json`);
  if (!existsSync(path)) return { at: "", eventId: "" };
  const record = objectValue(readJson(path), "campaign watch cursor");
  requireText(record.at, "campaign watch cursor.at");
  if (typeof record.eventId !== "string") throw new TypeError("campaign watch cursor.eventId must be a string");
  return { at: String(record.at), eventId: record.eventId };
}

/** @param {string} campaignPath @param {{cursorId: string, at: string, eventId: string}} position */
function writeWatchCursor(campaignPath, position) {
  const path = join(campaignPath, CAMPAIGN_WATCH_CURSOR_DIR, `${position.cursorId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, { schemaVersion: OUTBOX_SCHEMA_VERSION, ...position, updatedAt: new Date().toISOString() });
}

/**
 * Acknowledge one retained outbox event by atomically advancing a durable
 * per-session watch cursor to it. ack is the only cursor writer: sync and
 * watch reads never advance it. The event id must be present in the current
 * outbox or already at/behind the session cursor (a previous ack of the same
 * id is a no-op). Cursor movement never regresses: acknowledging an older
 * retained event leaves the cursor where it was.
 *
 * @param {string} campaignPath
 * @param {string} cursorId
 * @param {string} eventId
 * @returns {{cursorId: string, at: string, eventId: string}}
 */
export function acknowledgeCampaignEvent(campaignPath, cursorId, eventId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(cursorId)) throw new TypeError("--cursor must be a safe identifier");
  if (typeof eventId !== "string" || !eventId.trim()) throw new TypeError("--event-id requires a value");
  const current = readWatchCursor(campaignPath, cursorId);
  const outbox = readNotificationOutbox(campaignPath);
  const found = outbox.find((candidate) => candidate.eventId === eventId);
  let position;
  if (found) {
    position = { at: found.at, eventId: found.eventId };
  } else if (current.eventId !== "" && current.eventId === eventId) {
    position = current;
  } else {
    throw new TypeError("--event-id is not retained in the notification outbox");
  }
  if (current.eventId !== "" && comparePositions(position, current) <= 0) position = current;
  // Acknowledging the current position is a durable no-op: no write means the
  // cursor file stays byte-identical (updatedAt is never rewritten).
  if (current.eventId === "" || comparePositions(position, current) > 0) {
    writeWatchCursor(campaignPath, { cursorId, ...position });
  }
  return { cursorId, ...position };
}

/** @param {{at: string, eventId: string}} left @param {{at: string, eventId: string}} right @returns {number} */
function comparePositions(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

/** @param {string} executable @param {NotificationEvent} event @returns {Promise<{ok: boolean, error?: string}>} */
function deliverNotification(executable, event) {
  return new Promise((resolveDelivery) => {
    let child;
    try {
      child = spawn(executable, [], { stdio: ["pipe", "ignore", "pipe"], env: process.env });
    } catch (error) {
      resolveDelivery({ ok: false, error: errorMessage(error) });
      return;
    }
    let settled = false;
    /** @param {{ok: boolean, error?: string}} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveDelivery(result);
    };
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = boundedText(`${stderr}${chunk}`, 1024); });
    child.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
    child.once("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr || `notification exited ${code}` }));
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ ok: false, error: "notification timed out after 5s" });
    }, 5_000);
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

/** @param {unknown} value @param {string} label */
function requireText(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); }

/** @param {unknown} value @param {string} label @returns {JsonObject} */
function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return /** @type {JsonObject} */ (value);
}

/** @param {string} value @returns {string} */
function basenameSafe(value) { return value.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "campaign"; }

/** @param {unknown} value @param {number} max @returns {string} */
function boundedText(value, max) { const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " "); return Buffer.byteLength(text, "utf8") <= max ? text : `${Buffer.from(text, "utf8").subarray(0, max - 1).toString("utf8")}…`; }

/**
 * Bound a persisted delivery error by characters with an ellipsis marker so
 * writeOutbox never silently drops a pending event because its retry history
 * grew past the serialized event budget.
 *
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string}
 */
function boundedChars(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

/**
 * Drain the outbox without ever failing the caller: delivery is best effort,
 * so a broken human channel is reported on stderr and the records stay
 * pending for the next pass.
 *
 * @param {string} campaignPath
 */
export async function drainNotificationsSafely(campaignPath) {
  try {
    await drainNotifications(campaignPath);
  } catch (error) {
    process.stderr.write(`[warn] notification delivery failed: ${errorMessage(error)}\n`);
  }
}

/**
 * Enqueue one projected event and hand the outbox to its transport. Both
 * halves are best effort by design: a campaign never fails because a human
 * channel is unavailable, so a failure is reported on stderr and the record
 * simply stays pending.
 *
 * @param {string} campaignPath
 * @param {import("./events.mjs").ProjectedEvent} event
 * @param {string} key
 * @param {string} [progressCoalesceKey]
 */
export async function notifyCampaign(campaignPath, event, key, progressCoalesceKey = key) {
  try {
    enqueueNotification(campaignPath, event, key, progressCoalesceKey);
  } catch (error) {
    process.stderr.write(`[warn] notification enqueue failed: ${errorMessage(error)}\n`);
    return;
  }
  await drainNotificationsSafely(campaignPath);
}

/**
 * The projector error code of a terminal node event. A blocked_context worker
 * result is persisted by the runner as error code context_missing; it is
 * classified as the blocking question it is, so surface the worker's own
 * terminal status code for the projector.
 *
 * @param {{result?: unknown, error?: unknown}} state
 * @returns {string|null}
 */
export function terminalErrorCode(state) {
  const result = state.result && typeof state.result === "object" ? /** @type {{status?: unknown}} */ (state.result) : {};
  if (result.status === "blocked_context") return "blocked_context";
  const error = state.error && typeof state.error === "object" ? /** @type {{code?: unknown}} */ (state.error) : {};
  return typeof error.code === "string" && error.code ? error.code : null;
}
