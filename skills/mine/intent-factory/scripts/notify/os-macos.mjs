import { spawn as defaultSpawn } from "node:child_process";

const TITLE = "intent-factory";
const BODY_CHARS = 200;
const SUBTITLE_CHARS = 80;

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{type: string, campaignId?: string, summary?: string, eventId?: string, at?: string, data?: JsonObject}} NotificationEvent */
/** @typedef {{id: string, capabilities: {canPush: boolean, canWake: boolean, canRenderAmbient: boolean}, deliver(event: NotificationEvent): Promise<{ok: boolean, error?: string}>}} NotifyAdapter */
/** @typedef {{once(event: string, listener: (...args: any[]) => void): unknown, kill(signal?: any): unknown, stderr?: {on(event: string, listener: (chunk: string|Buffer) => void): void}|null}} SpawnedChild */
/** @typedef {(command: string, args?: any, options?: any) => SpawnedChild} SpawnFunction */

/**
 * Create the macOS notification adapter. On a non-darwin platform deliver
 * resolves { ok: false, error: "unsupported platform" } without spawning.
 *
 * @param {{spawn?: SpawnFunction, platform?: string, timeoutMs?: number}} [options]
 * @returns {NotifyAdapter}
 */
export function createMacosNotifier({ spawn = defaultSpawn, platform = process.platform, timeoutMs = 5000 } = {}) {
  return {
    id: "os-macos",
    capabilities: { canPush: true, canWake: false, canRenderAmbient: false },
    deliver(event) {
      return new Promise((resolve) => {
        if (platform !== "darwin") {
          resolve({ ok: false, error: "unsupported platform" });
          return;
        }
        const summary = typeof event.summary === "string" ? event.summary : "";
        const body = escapeAppleScript(truncateChars(summary, BODY_CHARS));
        const campaignLabel = typeof event.campaignId === "string" ? event.campaignId : "campaign";
        const subtitle = escapeAppleScript(truncateChars(`${campaignLabel} · ${event.type}`, SUBTITLE_CHARS));
        const script = `display notification "${body}" with title "${TITLE}" subtitle "${subtitle}"`;
        let child;
        try {
          child = spawn("osascript", ["-e", script]);
        } catch (error) {
          resolve({ ok: false, error: errorMessage(error) });
          return;
        }
        let settled = false;
        let stderr = "";
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let timer;
        /** @param {{ok: boolean, error?: string}} result */
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        child.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
        child.once("close", (code) => {
          finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `osascript exited ${code}` });
        });
        child.stderr?.on("data", (chunk) => {
          stderr = `${stderr}${String(chunk)}`.slice(-2048);
        });
        timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {}
          finish({ ok: false, error: `osascript timed out after ${timeoutMs}ms` });
        }, timeoutMs);
      });
    },
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAppleScript(value) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
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
