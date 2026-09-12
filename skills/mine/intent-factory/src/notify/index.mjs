/**
 * Direct notification dispatcher (TECH-SPEC lean, rule 6). On `node.terminal`,
 * `run.terminal` and `attention` the controller renders a one-line message
 * from a fixed per-type template, calls `INTENT_FACTORY_NOTIFY_BIN` with the
 * event as JSON on stdin, and appends a receipt (`delivered` or `failed`, with
 * the timestamp) to `<run-dir>/notify.jsonl`. A failed delivery is retried on
 * the next controller ticks up to three times with backoff. With no
 * transport bound (`INTENT_FACTORY_NOTIFY_BIN` unset) nothing is spawned and a
 * `no_transport` receipt is recorded instead — there is no implicit desktop
 * fallback. The macOS notifier is reachable only by setting
 * `INTENT_FACTORY_NOTIFY_BIN=os-macos`, an explicit opt-in, never a default.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMacosNotifier } from "./os-macos.mjs";

const NOTIFY_BIN_ENV = "INTENT_FACTORY_NOTIFY_BIN";
const MACOS_TRANSPORT = "os-macos";
export const NOTIFY_LOG_FILE = "notify.jsonl";
export const MAX_ATTEMPTS = 3;
/** Wait, in ms, before attempt 2 and attempt 3 of a failed delivery. */
const DEFAULT_BACKOFF_MS = [5_000, 30_000];

const SUMMARY_CHARS = 200;

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{type: "node.terminal"|"run.terminal"|"attention", runId: string, campaignId?: string|null, nodeId?: string|null, status?: string|null, attempt?: number|null, errorCode?: string|null, done?: number|null, total?: number|null, dedupeKey?: string|null, runDir?: string|null, costUsd?: number|null, eventId?: string}} NotifyEvent */
/** @typedef {{ok: boolean, error?: string, noTransport?: boolean}} DeliveryResult */

/**
 * Render the fixed one-line message for an event, from counters and
 * identifiers only (node id, run id or directory, state, attempt, error
 * code, done/total, cost), never from model text:
 *   `node <id> failed · run <id> · attempt 2 · verification_failed · resume <run-dir>`
 *   `run <id> done · 3/3 nodes · $4.21`
 *   `node <id> needs you · run <id> · <error code>`
 * `runDir` and `costUsd`, when present on the event, come from the run's own
 * `status.json` (`NotifyQueue.enqueue` reads it) — never from the model.
 *
 * @param {NotifyEvent} event
 * @returns {string}
 */
export function renderNotification(event) {
  const runId = event.runId ?? "-";
  switch (event.type) {
    case "node.terminal": {
      const ok = event.status === "done" || event.status === "no-op";
      const errorPart = event.errorCode ? ` · ${event.errorCode}` : "";
      const resumePart = !ok && event.runDir ? ` · resume ${event.runDir}` : "";
      return truncate(`node ${event.nodeId ?? "-"} ${event.status ?? "-"} · run ${runId} · attempt ${event.attempt ?? 0}${errorPart}${resumePart}`);
    }
    case "run.terminal": {
      const done = event.done ?? 0;
      const total = event.total ?? 0;
      const state = total > done ? "attention" : "done";
      const costPart = typeof event.costUsd === "number" ? ` · $${event.costUsd.toFixed(2)}` : "";
      return truncate(`run ${runId} ${state} · ${done}/${total} nodes${costPart}`);
    }
    case "attention": {
      const subject = event.nodeId ? `node ${event.nodeId} needs you · run ${runId}` : `run ${runId} needs you`;
      const errorPart = event.errorCode ? ` · ${event.errorCode}` : "";
      return truncate(`${subject}${errorPart}`);
    }
    default:
      throw new TypeError(`renderNotification: unknown event type ${String(event.type)}`);
  }
}

/**
 * The run's total cost so far, read from its own `status.json` (the single
 * source `writeStatusArtifacts` refreshes every tick). Missing or unreadable
 * is `null`: a notification never blocks or fails on this being unavailable.
 *
 * @param {string} runDir
 * @returns {number|null}
 */
function readRunCostUsd(runDir) {
  try {
    const payload = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
    const costUsd = payload?.usage?.costUsd;
    return typeof costUsd === "number" ? costUsd : null;
  } catch {
    return null;
  }
}

/** @param {string} value @returns {string} */
function truncate(value) {
  return value.length <= SUMMARY_CHARS ? value : `${value.slice(0, SUMMARY_CHARS - 1)}…`;
}

/**
 * Deliver one event through the bound transport. No transport bound resolves
 * `{ok: false, noTransport: true}` without spawning anything.
 *
 * @param {{type: string, summary: string, campaignId?: string|null, [key: string]: unknown}} event
 * @param {{bin?: string, spawn?: typeof defaultSpawn, timeoutMs?: number}} [options]
 * @returns {Promise<DeliveryResult>}
 */
function deliverNotification(event, options = {}) {
  const bin = options.bin ?? process.env[NOTIFY_BIN_ENV];
  if (!bin) return Promise.resolve({ ok: false, noTransport: true });
  if (bin === MACOS_TRANSPORT) {
    return createMacosNotifier({ spawn: options.spawn }).deliver(/** @type {any} */ (event));
  }
  return spawnDeliver(bin, event, options);
}

/**
 * @param {string} bin
 * @param {JsonObject} event
 * @param {{spawn?: typeof defaultSpawn, timeoutMs?: number}} options
 * @returns {Promise<DeliveryResult>}
 */
function spawnDeliver(bin, event, { spawn = defaultSpawn, timeoutMs = 5_000 } = {}) {
  return new Promise((resolveDelivery) => {
    let child;
    try {
      child = spawn(bin, [], { stdio: ["pipe", "ignore", "pipe"], env: process.env });
    } catch (error) {
      resolveDelivery({ ok: false, error: errorMessage(error) });
      return;
    }
    let settled = false;
    /** @param {DeliveryResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDelivery(result);
    };
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1024);
    });
    child.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
    child.once("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr || `notification exited ${code}` }));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({ ok: false, error: `notification timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

/**
 * Per-run queue of pending notifications with bounded retry. `enqueue`
 * renders the message and attempts delivery immediately; a failed attempt
 * schedules the next one at `now() + backoffMs[attempt - 1]`, and `pump`
 * retries whichever pending entries are due. Every attempt appends one
 * receipt to `<runDir>/notify.jsonl`, so a resume or an audit sees exactly
 * how many tries an event took and when each one happened.
 */
export class NotifyQueue {
  /**
   * @param {{runDir: string, maxAttempts?: number, backoffMs?: number[], deliver?: typeof deliverNotification, now?: () => number}} options
   */
  constructor({ runDir, maxAttempts = MAX_ATTEMPTS, backoffMs, deliver = deliverNotification, now = () => Date.now() }) {
    this.runDir = runDir;
    this.maxAttempts = maxAttempts;
    this.backoffMs = backoffMs ?? backoffMsFromEnv() ?? DEFAULT_BACKOFF_MS;
    this.deliver = deliver;
    this.now = now;
    /** @type {{event: NotifyEvent & {summary: string}, attempts: number, nextAttemptAt: number}[]} */
    this.pending = [];
  }

  /**
   * Enrich the event with `runDir` and the run's current `costUsd` (from its
   * own `status.json`, never the model) before rendering its summary, so
   * `resume <run-dir>` and the run-terminal cost are counters and
   * identifiers the templates can use without the caller supplying them.
   *
   * @param {NotifyEvent} event
   * @returns {Promise<void>}
   */
  async enqueue(event) {
    const enriched = { ...event, runDir: this.runDir, costUsd: readRunCostUsd(this.runDir) };
    const summary = renderNotification(enriched);
    const entry = { event: { ...enriched, summary }, attempts: 0, nextAttemptAt: this.now() };
    this.pending.push(entry);
    await this._attempt(entry);
  }

  /** @returns {Promise<void>} */
  async pump() {
    const now = this.now();
    for (const entry of this.pending.filter((candidate) => candidate.nextAttemptAt <= now)) {
      await this._attempt(entry);
    }
  }

  /**
   * Drain every pending entry, waiting in real time for each one's backoff, so
   * a caller with no more ticks left (the controller at run.terminal) still
   * exhausts the bounded retry budget before returning.
   *
   * @param {(ms: number) => Promise<void>} [wait]
   * @returns {Promise<void>}
   */
  async drain(wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))) {
    while (this.pending.length > 0) {
      const due = Math.min(...this.pending.map((entry) => entry.nextAttemptAt));
      const remaining = due - this.now();
      if (remaining > 0) await wait(remaining);
      await this.pump();
    }
  }

  /**
   * @param {{event: NotifyEvent & {summary: string}, attempts: number, nextAttemptAt: number}} entry
   */
  async _attempt(entry) {
    entry.attempts += 1;
    // Consumers deduplicate by eventId (the Ford adapter rejects an event without
    // one), so every delivery carries a stable id derived from the dedupe key.
    const eventId = /** @type {string|undefined} */ (entry.event.eventId)
      ?? createHash("sha256").update(entry.event.dedupeKey ?? JSON.stringify(entry.event)).digest("hex");
    const result = await this.deliver({ ...entry.event, eventId });
    /** @type {JsonObject} */
    const receipt = {
      eventId,
      type: entry.event.type,
      runId: entry.event.runId ?? null,
      nodeId: entry.event.nodeId ?? null,
      nodeStatus: entry.event.status ?? null,
      errorCode: entry.event.errorCode ?? null,
      done: entry.event.done ?? null,
      total: entry.event.total ?? null,
      dedupeKey: entry.event.dedupeKey ?? null,
      summary: entry.event.summary,
      attempt: entry.attempts,
      status: result.ok ? "delivered" : result.noTransport ? "no_transport" : "failed",
      at: new Date(this.now()).toISOString(),
    };
    if (!result.ok && !result.noTransport) receipt.error = result.error ?? null;
    appendFileSync(join(this.runDir, NOTIFY_LOG_FILE), `${JSON.stringify(receipt)}\n`);
    if (result.ok || result.noTransport || entry.attempts >= this.maxAttempts) {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    } else {
      entry.nextAttemptAt = this.now() + (this.backoffMs[entry.attempts - 1] ?? this.backoffMs.at(-1) ?? 0);
    }
  }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An operator (or a test) may override the retry backoff with a
 * comma-separated list of milliseconds, so a slow default never has to be
 * waited out in full. Read fresh on every queue construction rather than
 * baked into a module constant, so the override still applies however late
 * it is set.
 *
 * @returns {number[]|null}
 */
function backoffMsFromEnv() {
  const raw = process.env.INTENT_FACTORY_NOTIFY_BACKOFF_MS;
  if (!raw) return null;
  const parts = raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0);
  return parts.length > 0 ? parts : null;
}
