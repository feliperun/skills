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
/** @typedef {{type: string, campaignId?: string, summary?: string, eventId?: string, at?: string, data?: JsonObject}} NotificationEvent */
/** @typedef {{id: string, capabilities: {canPush: boolean, canWake: boolean, canRenderAmbient: boolean}, deliver(event: NotificationEvent): Promise<{ok: boolean, error?: string}>}} NotifyAdapter */

/**
 * Load the notify adapters for the current platform. The macOS adapter is
 * present only on darwin.
 *
 * @param {{platform?: string, spawn?: import("./os-macos.mjs").SpawnFunction}} [options]
 * @returns {NotifyAdapter[]}
 */
export function loadNotifyAdapters({ platform = process.platform, spawn } = {}) {
  /** @type {NotifyAdapter[]} */
  const adapters = [];
  if (platform === "darwin") adapters.push(createMacosNotifier({ spawn, platform }));
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
