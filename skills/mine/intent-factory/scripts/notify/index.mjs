import { createClaudeSessionAdapter, SESSION_WAKE_ENV } from "./claude-session.mjs";
import { createMacosNotifier } from "./os-macos.mjs";

export const PUSH_EVENT_TYPES = new Set([
  "run.attention",
  "campaign.attention",
  "node.terminal",
  "run.terminal",
  "campaign.completed",
]);

const PROGRESS_EVENT_TYPE = "campaign.progress";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{type: string, campaignId?: string, summary?: string, next?: string, requiresUser?: boolean, eventId?: string, at?: string, data?: JsonObject}} NotificationEvent */
/** @typedef {{ok: boolean, error?: string}} WakeResult */
/** @typedef {{id: string, capabilities: {canPush: boolean, canWake: boolean, canRenderAmbient: boolean}, deliver(event: NotificationEvent): Promise<WakeResult>, wake?: (event: NotificationEvent) => Promise<WakeResult>}} NotifyAdapter */

/**
 * Load the notify adapters for the current platform. The macOS adapter is
 * present only on darwin; the Claude session adapter is present only when the
 * host bound a wake channel, by injection or through SESSION_WAKE_ENV.
 *
 * @param {{platform?: string, spawn?: import("./os-macos.mjs").SpawnFunction, sessionWake?: import("./claude-session.mjs").WakeChannel, wakeFile?: string}} [options]
 * @returns {NotifyAdapter[]}
 */
export function loadNotifyAdapters({ platform = process.platform, spawn, sessionWake, wakeFile = process.env[SESSION_WAKE_ENV] } = {}) {
  /** @type {NotifyAdapter[]} */
  const adapters = [];
  if (platform === "darwin") adapters.push(createMacosNotifier({ spawn, platform }));
  if (typeof sessionWake === "function" || (typeof wakeFile === "string" && Boolean(wakeFile.trim()))) {
    adapters.push(createClaudeSessionAdapter({ wake: sessionWake, wakeFile }));
  }
  return adapters;
}

/**
 * Route a notification event to the adapters allowed to push it. Progress
 * events and any type outside PUSH_EVENT_TYPES are never routed.
 *
 * @param {NotificationEvent} event
 * @param {NotifyAdapter[]} adapters
 * @returns {NotifyAdapter[]}
 */
export function routeNotification(event, adapters) {
  if (!event || typeof event.type !== "string" || event.type === PROGRESS_EVENT_TYPE || !PUSH_EVENT_TYPES.has(event.type)) {
    return [];
  }
  return /** @type {NotifyAdapter[]} */ (adapters).filter((adapter) => adapter.capabilities.canPush === true);
}

/**
 * Deliver one event through every routed adapter without ever throwing.
 *
 * @param {NotificationEvent} event
 * @param {NotifyAdapter[]} adapters
 * @returns {Promise<{delivered: string[], failed: {id: string, error: string}[]}>}
 */
export async function pushNotification(event, adapters) {
  /** @type {string[]} */
  const delivered = [];
  /** @type {{id: string, error: string}[]} */
  const failed = [];
  for (const adapter of routeNotification(event, adapters)) {
    try {
      const result = await adapter.deliver(event);
      if (result && result.ok === true) delivered.push(adapter.id);
      else failed.push({ id: adapter.id, error: (result && typeof result.error === "string" && result.error) || "delivery failed" });
    } catch (error) {
      failed.push({ id: adapter.id, error: errorMessage(error) });
    }
  }
  return { delivered, failed };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Route a session wake. A wake exists only for a requiresUser-true event
 * (Addendum 01 section 9, ADR-0019): requiresUser is read from the projected
 * record and never re-derived here, and for every other event — progress
 * included — the canWake capability is not consulted at all.
 *
 * @param {NotificationEvent} event
 * @param {NotifyAdapter[]} adapters
 * @returns {NotifyAdapter[]}
 */
export function routeWake(event, adapters) {
  if (!event || event.requiresUser !== true) return [];
  return /** @type {NotifyAdapter[]} */ (adapters).filter(
    (adapter) => adapter.capabilities.canWake === true && typeof adapter.wake === "function",
  );
}

/**
 * Wake every session adapter routed for this event, without ever throwing.
 * A healthy campaign wakes two or three times in total, never once per
 * progress transition.
 *
 * @param {NotificationEvent} event
 * @param {NotifyAdapter[]} adapters
 * @returns {Promise<{woke: string[], failed: {id: string, error: string}[]}>}
 */
export async function wakeSession(event, adapters) {
  /** @type {string[]} */
  const woke = [];
  /** @type {{id: string, error: string}[]} */
  const failed = [];
  for (const adapter of routeWake(event, adapters)) {
    try {
      const result = await /** @type {(event: NotificationEvent) => Promise<WakeResult>} */ (adapter.wake)(event);
      if (result && result.ok === true) woke.push(adapter.id);
      else failed.push({ id: adapter.id, error: (result && typeof result.error === "string" && result.error) || "wake failed" });
    } catch (error) {
      failed.push({ id: adapter.id, error: errorMessage(error) });
    }
  }
  return { woke, failed };
}
