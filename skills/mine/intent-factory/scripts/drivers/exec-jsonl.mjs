/**
 * Generic exec-jsonl adapter protocol.
 *
 * The executable receives one UTF-8 JSON line on stdin:
 * `{schemaVersion:1,type:"run.request",model,prompt,structuredOutput,
 * outputSchema,continuationId}`. The request deliberately carries no tool
 * policy: an
 * arbitrary wrapper executable cannot prove enforcement, so the mechanical
 * policy travels only where a hook surface can enforce it (claude/glm). It
 * writes JSONL events to stdout:
 * `run.started` (optional), `message` (zero or more), then exactly one
 * `run.completed` or `run.failed` event. Events must appear in that order,
 * with no unknown fields. A completed event is
 * `{schemaVersion:1,type:"run.completed",result,continuationId,usage,costUsd}`;
 * `result` is required and may be any JSON value. A failed event is
 * `{schemaVersion:1,type:"run.failed",error:{code,message}}`.
 *
 * Stderr is diagnostic only. Unknown or malformed output is rejected by the
 * runtime normalizer; wrappers should emit this protocol rather than making
 * scheduler-specific provider branches.
 */

import {
  canonicalUsage,
  eventItem,
  extractJson,
  failed,
  finite,
  parseJsonLines,
  parseVersion,
} from "./protocol.mjs";

export { DRIVER_OUTPUT_LIMIT_BYTES } from "./protocol.mjs";

export const EXEC_JSONL_PROTOCOL = Object.freeze({
  schemaVersion: 1,
  requestType: "run.request",
  completedType: "run.completed",
  failedType: "run.failed",
});

/** Exact tool-output bound (UTF-8 bytes) carried by the toolPolicy contract. */
export const TOOL_OUTPUT_LIMIT_BYTES = 8192;

const EVENT_FIELDS = Object.freeze({
  "run.started": new Set(["schemaVersion", "type", "continuationId"]),
  message: new Set(["schemaVersion", "type", "text"]),
  "run.completed": new Set(["schemaVersion", "type", "result", "continuationId", "usage", "costUsd"]),
  "run.failed": new Set(["schemaVersion", "type", "error"]),
});

const EVENT_TYPES = new Set(Object.keys(EVENT_FIELDS));

/** @typedef {import("./index.mjs").DriverAdapter} DriverAdapter */

/**
 * @type {DriverAdapter}
 */
export const execJsonlDriver = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: false,
    continuation: true,
    tokenBudget: true,
    costBudget: false,
    usage: true,
    cost: true,
    // An arbitrary wrapper executable cannot honestly advertise mechanical
    // tool-policy enforcement; the request carries none.
    toolPolicy: false,
    // The protocol allows zero `message` events before the terminal one, so
    // an arbitrary wrapper cannot honestly advertise incremental output either.
    streamsOutput: false,
  },

  // The wrapper protocol exposes no permission mode.
  permissionExecution: null,

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_EXEC_JSONL_BIN ?? runtime.executable ?? "exec-jsonl";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("./index.mjs").DriverRuntime} runtime @param {string} prompt @param {import("./index.mjs").CommandOptions} options @returns {import("./index.mjs").DriverCommand} */
  command(runtime, prompt, options) {
    const request = {
      schemaVersion: 1,
      type: "run.request",
      model: runtime.model,
      prompt,
      structuredOutput: Boolean(options.schema || options.schemaPath),
      outputSchema: options.schema ?? options.schemaPath ?? null,
      continuationId: options.continuationId ?? null,
    };
    const args = runtime.args ?? [];
    return {
      executable: this.executable(runtime),
      args: [...args],
      promptTransport: "stdin",
      input: `${JSON.stringify(request)}\n`,
    };
  },

  normalize: normalizeExecJsonlResult,
};

export const driver = execJsonlDriver;
export default execJsonlDriver;

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeExecJsonlResult(stdout, exitCode, signal) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  let events;
  try {
    events = parseJsonLines(stdout, "exec-jsonl");
    validateExecJsonlEvents(events);
  } catch (error) {
    return failed("invalid_protocol", error instanceof Error ? error.message : String(error));
  }
  const lastEvent = events.at(-1);
  if (!lastEvent) return failed("invalid_protocol", "exec-jsonl emitted no events");
  const terminal = /** @type {Record<string, unknown>} */ (lastEvent);
  if (terminal.type === "run.failed") {
    const error = /** @type {Record<string, unknown>|undefined} */ (terminal.error);
    return failed(
      typeof error?.code === "string" ? error.code : "provider_error",
      typeof error?.message === "string" ? error.message : "exec-jsonl failed",
    );
  }
  if (exitCode !== 0) return failed("provider_error", `exec-jsonl exited with code ${exitCode}`);
  const rawResult = terminal.result;
  const result = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
  return {
    status: result.trim() ? "done" : "no-op",
    result,
    continuationId: typeof terminal.continuationId === "string" ? terminal.continuationId : null,
    usage: canonicalUsage(terminal.usage),
    costUsd: finite(terminal.costUsd),
    error: null,
  };
}

/**
 * @param {Record<string, unknown>[]} events
 */
function validateExecJsonlEvents(events) {
  if (!events.length) throw new TypeError("exec-jsonl emitted no events");
  let terminalCount = 0;
  let phase = "start";
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError(`exec-jsonl event ${index + 1} must be an object`);
    }
    if (event.schemaVersion !== 1) {
      throw new TypeError(`exec-jsonl event ${index + 1} schemaVersion must be 1`);
    }
    const type = /** @type {keyof typeof EVENT_FIELDS} */ (event.type);
    if (!EVENT_TYPES.has(type)) {
      throw new TypeError(`exec-jsonl event ${index + 1} type is unknown`);
    }
    rejectUnknown(event, EVENT_FIELDS[type], `exec-jsonl event ${index + 1}`);
    if (type === "run.started") {
      if (phase !== "start") throw new TypeError("exec-jsonl run.started must be the first event");
      phase = "messages";
      validateContinuationId(event.continuationId, `exec-jsonl event ${index + 1}.continuationId`);
      continue;
    }
    if (type === "message") {
      if (phase === "terminal") throw new TypeError("exec-jsonl message cannot follow a terminal event");
      phase = "messages";
      if (typeof event.text !== "string") throw new TypeError(`exec-jsonl event ${index + 1}.text must be a string`);
      continue;
    }
    if (phase === "terminal") throw new TypeError("exec-jsonl emitted multiple terminal events");
    phase = "terminal";
    terminalCount += 1;
    if (event.type === "run.completed") {
      if (!Object.hasOwn(event, "result")) throw new TypeError("exec-jsonl run.completed.result is required");
      validateContinuationId(event.continuationId, `exec-jsonl event ${index + 1}.continuationId`);
      validateUsage(event.usage, `exec-jsonl event ${index + 1}.usage`);
      validateCost(event.costUsd, `exec-jsonl event ${index + 1}.costUsd`);
    } else {
      validateError(event.error, `exec-jsonl event ${index + 1}.error`);
    }
    if (index !== events.length - 1) {
      if (events.slice(index + 1).some((next) => next?.type === "run.completed" || next?.type === "run.failed")) {
        throw new TypeError("exec-jsonl emitted multiple terminal events");
      }
      throw new TypeError("exec-jsonl terminal event must be last");
    }
  }
  if (terminalCount !== 1) throw new TypeError("exec-jsonl requires exactly one terminal event");
}

/**
 * @param {Record<string, unknown>} value
 * @param {Set<string>} allowed
 * @param {string} label
 */
function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateContinuationId(value, label) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateUsage(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = /** @type {Record<string, unknown>} */ (value);
  const allowed = new Set(["inputTokens", "outputTokens", "cacheReadInputTokens"]);
  rejectUnknown(record, allowed, label);
  for (const key of allowed) {
    const raw = record[key];
    if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) {
      throw new TypeError(`${label}.${key} must be a non-negative integer or null`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateCost(value, label) {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative number or null`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateError(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknown(record, new Set(["code", "message"]), label);
  if (typeof record.code !== "string" || !record.code.trim()) throw new TypeError(`${label}.code must be a non-empty string`);
  if (typeof record.message !== "string" || !record.message.trim()) throw new TypeError(`${label}.message must be a non-empty string`);
}

/**
 * Best-effort input-token meter over a still-growing transcript. The
 * controller never owns the provider stream (the gate writes stdout straight
 * to the log fd), so budget enforcement polls this instead. Lenient by
 * design: unparsable or partial lines count as zero, and providers that only
 * report usage at completion (agy, exec-jsonl, replay) meter as 0 mid-run.
 *
 * @param {string} driver
 * @param {string} stdout bounded transcript tail
 * @returns {{inputTokens: number|null, cacheReadInputTokens: number|null}}
 */
export function liveUsage(driver, stdout) {
  if (driver === "exec-jsonl" || driver === "replay") {
    // Completion-only drivers: usage arrives in the terminal envelope, which
    // the close path normalizes, never in a mid-run live observation.
    return { inputTokens: null, cacheReadInputTokens: null };
  }
  const events = parsedEvents(stdout);
  if (driver === "codex") {
    // turn.completed usage is cumulative for the session; the last one wins.
    // Codex counts input_tokens with their cached portion included, so the
    // uncached total is what the ledger calls `inputTokens`.
    const records = events
      .filter((event) => event?.type === "turn.completed" && event.usage && typeof event.usage === "object")
      .map((event) => {
        const rawInput = finite(event.usage.input_tokens ?? event.usage.inputTokens);
        if (rawInput === null) return null;
        const cacheReadInputTokens = finite(
          event.usage.cached_input_tokens ?? event.usage.cacheReadInputTokens ?? event.usage.cache_read_tokens,
        ) ?? 0;
        return { inputTokens: Math.max(0, rawInput - cacheReadInputTokens), cacheReadInputTokens };
      })
      .filter((record) => record !== null);
    if (!records.length) return { inputTokens: null, cacheReadInputTokens: null };
    return records.reduce((best, record) => (
      record.inputTokens + record.cacheReadInputTokens > best.inputTokens + best.cacheReadInputTokens ? record : best
    ));
  }
  if (driver === "claude" || driver === "glm") {
    // The terminal result event carries the session total; before it lands,
    // sum per-request assistant usage (each request re-reads full context).
    // Claude's input_tokens already exclude cache reads.
    const resultEvent = events.findLast((event) => event?.type === "result");
    const resultUsage = resultEvent?.usage && typeof resultEvent.usage === "object"
      ? finite(resultEvent.usage.input_tokens ?? resultEvent.usage.inputTokens)
      : null;
    if (resultUsage !== null) {
      return {
        inputTokens: resultUsage,
        cacheReadInputTokens: finite(resultEvent.usage.cache_read_input_tokens ?? resultEvent.usage.cacheReadInputTokens) ?? null,
      };
    }
    return {
      inputTokens: events.reduce((sum, event) => {
        if (event?.type !== "assistant") return sum;
        const usage = event.message?.usage;
        const value = usage && typeof usage === "object" ? finite(usage.input_tokens ?? usage.inputTokens) : null;
        return sum + (value ?? 0);
      }, 0) || null,
      cacheReadInputTokens: null,
    };
  }
  return { inputTokens: null, cacheReadInputTokens: null };
}

/**
 * Budgeted live meter: one number, with cache reads weighted by the campaign
 * policy so it is comparable with the persisted ledger. A provider that only
 * reports usage at completion (agy, exec-jsonl, replay) meters as 0 mid-run.
 *
 * @param {string} driver
 * @param {string} stdout bounded transcript tail
 * @param {number} [cacheReadWeight] cached-to-uncached rate ratio, default 1
 * @returns {number}
 */
export function liveInputTokens(driver, stdout, cacheReadWeight = 1) {
  const usage = liveUsage(driver, stdout);
  if (usage.inputTokens === null) return 0;
  const weighted = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) * cacheReadWeight;
  return Math.round(weighted * 1000) / 1000;
}

/**
 * Parse each JSONL line independently. A bounded transcript tail can start or
 * end mid-line, so unparsable lines are skipped rather than failing the live
 * observation.
 *
 * @param {string} stdout
 */
function parsedEvents(stdout) {
  return String(stdout).split(/\r?\n/u).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Codex item types whose completion proves one tool invocation. */
const CODEX_TOOL_ITEM_TYPES = new Set(["tool_call", "command_execution", "mcp_tool_call", "web_search", "file_change"]);

/**
 * Session evidence from a bounded live transcript: completed turns, cache-read
 * input, tool invocations, and whether the driver's terminal record has been
 * folded. Each driver exposes only what its own events prove, and anything
 * unparsable or unsupported meters as zero — a live observation never throws.
 *
 * @param {string} driver
 * @param {string} stdout bounded transcript tail
 * @returns {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}}
 */
export function liveSessionMetrics(driver, stdout) {
  const parser = new SessionMetricsParser(driver);
  parser.push(String(stdout));
  parser.flush();
  return parser.metrics();
}

/** Retention bound for one streamed record: records at or below it parse whole. */
const SESSION_RECORD_MAX_BYTES = 64 * 1024;

/** Fragment evidence kept for a record that outgrew the retention bound. */
const SESSION_FRAGMENT_BYTES = SESSION_RECORD_MAX_BYTES / 2;

/** Claude-family content-block needle proving one tool invocation. */
const TOOL_USE_NEEDLE = Buffer.from('"type":"tool_use"', "utf8");

/** Cache-read evidence spellings across driver streams. */
const CACHE_READ_PATTERN = /"(?:cache_read_input_tokens|cached_input_tokens|cacheReadInputTokens)":(\d+)/gu;

/**
 * Bounded incremental session-metrics parser: fold fixed-size chunks into
 * running rotation totals without ever holding a buffer that scales with the
 * unread transcript. Records within `SESSION_RECORD_MAX_BYTES` parse whole;
 * a larger record keeps head and tail fragments plus streamed needle counts,
 * so its turn and usage evidence still lands in the totals instead of being
 * silently skipped.
 */
export class SessionMetricsParser {
  /**
   * @param {string} driver
   * @param {{turns?: number, cacheReadInputTokens?: number, toolCalls?: number, completed?: boolean}} [previous]
   */
  constructor(driver, previous = {}) {
    this.driver = driver;
    this.totals = {
      turns: previous.turns ?? 0,
      cacheReadInputTokens: previous.cacheReadInputTokens ?? 0,
      toolCalls: previous.toolCalls ?? 0,
      completed: previous.completed === true,
    };
    /** @type {string|null} */
    this.continuationId = null;
    /** @type {string|null} Most recent folded item-completed type, for the codex completion rule. */
    this.lastItemType = null;
    /** @type {string|null} Text of the most recent folded agent message, for the codex completion rule. */
    this.lastAgentText = null;
    /** @type {Buffer} */
    this.pending = Buffer.alloc(0);
    /** @type {{head: Buffer, tail: Buffer, streamedToolUse: number, carry: Buffer}|null} */
    this.oversized = null;
  }

  /**
   * Fold every newline-terminated record in one chunk. A trailing partial
   * record stays buffered (bounded) for the next chunk.
   *
   * @param {string|Buffer} chunk
   */
  push(chunk) {
    let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    while (data.length > 0) {
      const newline = data.indexOf(10);
      if (newline < 0) {
        this.absorb(data);
        return;
      }
      this.absorb(data.subarray(0, newline));
      this.completeRecord();
      data = data.subarray(newline + 1);
    }
  }

  /** Fold the buffered partial record as if a newline had ended it. */
  flush() {
    if (this.pending.length > 0 || this.oversized) this.completeRecord();
  }

  /** @returns {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}} */
  metrics() {
    return {
      turns: this.totals.turns,
      cacheReadInputTokens: this.totals.cacheReadInputTokens,
      toolCalls: this.totals.toolCalls,
      completed: this.totals.completed === true,
    };
  }

  /**
   * Retain one piece of a record still under assembly. Once the record
   * outgrows the retention bound, only its head and a rolling tail are kept;
   * the bytes leaving the tail are scanned for tool_use evidence instead of
   * being buffered.
   *
   * @param {Buffer} piece
   */
  absorb(piece) {
    if (this.oversized) {
      const window = Buffer.concat([this.oversized.tail, piece]);
      const keep = window.subarray(Math.max(0, window.length - SESSION_FRAGMENT_BYTES));
      const dropped = window.subarray(0, window.length - keep.length);
      if (isClaudeFamily(this.driver)) {
        const counted = countWithCarry(dropped, this.oversized.carry, TOOL_USE_NEEDLE);
        this.oversized.streamedToolUse += counted.hits;
        this.oversized.carry = counted.carry;
      }
      this.oversized.tail = keep;
      return;
    }
    if (this.pending.length + piece.length <= SESSION_RECORD_MAX_BYTES) {
      // Copy: `piece` may be a view of a scratch buffer the caller reuses for
      // the next read, which would corrupt a record buffered mid-chunk.
      this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, piece]) : Buffer.from(piece);
      return;
    }
    const whole = Buffer.concat([this.pending, piece]);
    this.pending = Buffer.alloc(0);
    const head = whole.subarray(0, Math.min(SESSION_FRAGMENT_BYTES, whole.length));
    const tail = whole.subarray(Math.max(0, whole.length - SESSION_FRAGMENT_BYTES));
    /** @type {{head: Buffer, tail: Buffer, streamedToolUse: number, carry: Buffer}} */
    const oversized = { head, tail, streamedToolUse: 0, carry: Buffer.alloc(0) };
    if (isClaudeFamily(this.driver)) {
      // Count from the record start up to where the rolling tail takes over,
      // so a needle straddling any region boundary is counted exactly once.
      const counted = countWithCarry(whole.subarray(0, Math.max(0, whole.length - tail.length)), oversized.carry, TOOL_USE_NEEDLE);
      oversized.streamedToolUse = counted.hits;
      oversized.carry = counted.carry;
    }
    this.oversized = oversized;
  }

  /** Fold the assembled record into the running totals. */
  completeRecord() {
    const oversized = this.oversized;
    if (oversized) {
      this.oversized = null;
      /** @type {{head: string, tail: string, toolUse: number}} */
      let fragments;
      if (isClaudeFamily(this.driver)) {
        const counted = countWithCarry(oversized.tail, oversized.carry, TOOL_USE_NEEDLE);
        fragments = {
          head: decodeFragment(oversized.head),
          tail: decodeFragment(oversized.tail),
          toolUse: oversized.streamedToolUse + counted.hits,
        };
      } else {
        fragments = { head: decodeFragment(oversized.head), tail: decodeFragment(oversized.tail), toolUse: 0 };
      }
      foldFragmentRecord(this.driver, this.totals, fragments);
      this.continuationId ??= fragmentContinuationId(this.driver, fragments);
      return;
    }
    const line = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const record = /** @type {Record<string, unknown>} */ (event);
    foldRecord(this.driver, this.totals, record);
    this.continuationId ??= recordContinuationId(this.driver, record);
    this.foldCompletionEvidence(record);
  }

  /**
   * Fold the completion evidence one parsed record proves into the sticky
   * totals. A driver is completed when its terminal record was folded; for
   * codex that means a turn.completed that ends the turn with the
   * result-carrying final agent message, so a live observation never treats a
   * still-working or already-answered session ambiguously.
   *
   * @param {Record<string, unknown>} record
   */
  foldCompletionEvidence(record) {
    const totals = this.totals;
    if (this.driver === "codex") {
      if (record.type === "turn.completed" && this.lastItemType === "agent_message"
        && extractJson(this.lastAgentText) !== null) {
        totals.completed = true;
      }
    } else if ((this.driver === "claude" || this.driver === "glm") && record.type === "result") {
      totals.completed = true;
    } else if (this.driver === "exec-jsonl" && record.type === "run.completed") {
      totals.completed = true;
    } else if (this.driver === "replay" && typeof record.status === "string") {
      // The replay envelope is the terminal record: the bin emits exactly one
      // envelope line per invocation, so folding one proves completion.
      totals.completed = true;
    }
    const item = eventItem(record);
    if (record.type === "item.completed" && item) {
      this.lastItemType = String(item.type ?? "");
      this.lastAgentText = this.lastItemType === "agent_message" && typeof item.text === "string"
        ? item.text
        : null;
    } else {
      this.lastItemType = null;
      this.lastAgentText = null;
    }
  }
}

/**
 * Fold one parsed record into the running totals. Turn and tool counts are
 * additive; cache-read is a running max for Codex (each turn.completed
 * counter is already cumulative) and additive for claude-style streams until
 * a terminal result event carries the authoritative session total.
 *
 * @param {string} driver
 * @param {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}} totals
 * @param {Record<string, unknown>} record
 */
function foldRecord(driver, totals, record) {
  if (driver === "codex") {
    if (record.type === "turn.completed") {
      totals.turns += 1;
      totals.cacheReadInputTokens = Math.max(totals.cacheReadInputTokens, canonicalUsage(record.usage).cacheReadInputTokens ?? 0);
    } else if (record.type === "item.completed" && CODEX_TOOL_ITEM_TYPES.has(String(eventItem(record)?.type))) {
      totals.toolCalls += 1;
    }
    return;
  }
  if (driver === "claude" || driver === "glm") {
    if (record.type === "assistant") {
      const message = /** @type {Record<string, unknown>} */ (record.message ?? {});
      totals.turns += 1;
      totals.cacheReadInputTokens += canonicalUsage(message.usage).cacheReadInputTokens ?? 0;
      totals.toolCalls += Array.isArray(message.content)
        ? message.content.filter((/** @type {{type?: unknown}} */ block) => block?.type === "tool_use").length
        : 0;
    } else if (record.type === "result") {
      const sessionTotal = canonicalUsage(record.usage).cacheReadInputTokens;
      if (sessionTotal !== null) totals.cacheReadInputTokens = sessionTotal;
    }
    return;
  }
  if (driver === "exec-jsonl" && record.type === "run.completed") {
    // The protocol carries no tool events; only a completed run proves a turn.
    totals.turns += 1;
    totals.cacheReadInputTokens += canonicalUsage(record.usage).cacheReadInputTokens ?? 0;
  }
  if (driver === "replay" && typeof record.status === "string") {
    // A replayed envelope is the whole invocation: one completed turn, no
    // tool events, usage only in the terminal record.
    totals.turns += 1;
    totals.cacheReadInputTokens += canonicalUsage(record.usage).cacheReadInputTokens ?? 0;
  }
}

/**
 * Fold the head-plus-tail fragments of one record that outgrew the retention
 * bound: the same evidence foldRecord extracts, read as fragments so an
 * oversized record is never silently skipped.
 *
 * @param {string} driver
 * @param {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}} totals
 * @param {{head: string, tail: string, toolUse: number}} fragments
 */
function foldFragmentRecord(driver, totals, fragments) {
  const text = `${fragments.head}\n${fragments.tail}`;
  if (driver === "claude" || driver === "glm") {
    if (text.includes('"type":"assistant"')) {
      totals.turns += 1;
      totals.toolCalls += fragments.toolUse;
      const cacheRead = lastCacheRead(text);
      if (cacheRead !== null) totals.cacheReadInputTokens += cacheRead;
    } else if (text.includes('"type":"result"')) {
      const sessionTotal = lastCacheRead(text);
      if (sessionTotal !== null) totals.cacheReadInputTokens = sessionTotal;
      totals.completed = true;
    }
    return;
  }
  if (driver === "codex") {
    if (text.includes('"type":"turn.completed"')) {
      totals.turns += 1;
      const cacheRead = lastCacheRead(text);
      totals.cacheReadInputTokens = Math.max(totals.cacheReadInputTokens, cacheRead ?? 0);
      // Fragment approximation of the parsed-record completion rule: the
      // turn ends with the final agent message when that message appears
      // before the completed marker in the retained head and tail.
      const agentAt = text.indexOf('"type":"agent_message"');
      if (agentAt >= 0 && agentAt < text.indexOf('"type":"turn.completed"')) totals.completed = true;
    } else if (text.includes('"type":"item.completed"') && [...CODEX_TOOL_ITEM_TYPES].some((type) => text.includes(`"type":"${type}"`))) {
      totals.toolCalls += 1;
    }
    return;
  }
  if (driver === "exec-jsonl" && text.includes('"type":"run.completed"')) {
    totals.turns += 1;
    const cacheRead = lastCacheRead(text);
    if (cacheRead !== null) totals.cacheReadInputTokens += cacheRead;
    totals.completed = true;
  }
}

/**
 * The provider session identity one record proves.
 *
 * @param {string} driver
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
function recordContinuationId(driver, record) {
  if (driver === "codex") {
    return record.type === "thread.started" && typeof record.thread_id === "string" ? record.thread_id : null;
  }
  if (driver === "claude" || driver === "glm") {
    return record.type === "result" && typeof record.session_id === "string" ? record.session_id : null;
  }
  if (driver === "exec-jsonl" && (record.type === "run.started" || record.type === "run.completed")) {
    return typeof record.continuationId === "string" ? record.continuationId : null;
  }
  return null;
}

/**
 * The provider session identity one record's fragments prove.
 *
 * @param {string} driver
 * @param {{head: string, tail: string}} fragments
 * @returns {string|null}
 */
function fragmentContinuationId(driver, fragments) {
  const text = `${fragments.head}\n${fragments.tail}`;
  const pattern = driver === "codex"
    ? /"thread_id":"([^"]+)"/u
    : driver === "claude" || driver === "glm"
      ? /"session_id":"([^"]+)"/u
      : /"continuationId":"([^"]+)"/u;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

/**
 * @param {string} driver
 * @returns {boolean}
 */
function isClaudeFamily(driver) {
  return driver === "claude" || driver === "glm";
}

/**
 * Count needle occurrences in one region, keeping the trailing bytes that
 * could complete a needle in the next region so a straddling needle is
 * counted exactly once.
 *
 * @param {Buffer} region
 * @param {Buffer} carry
 * @param {Buffer} needle
 * @returns {{hits: number, carry: Buffer}}
 */
function countWithCarry(region, carry, needle) {
  const stream = carry.length > 0 ? Buffer.concat([carry, region]) : region;
  return { hits: countNeedle(stream, needle), carry: stream.subarray(Math.max(0, stream.length - (needle.length - 1))) };
}

/**
 * @param {Buffer} haystack
 * @param {Buffer} needle
 * @returns {number}
 */
function countNeedle(haystack, needle) {
  let hits = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) hits += 1;
  return hits;
}

/**
 * Decode a retained fragment without splitting a UTF-8 sequence.
 *
 * @param {Buffer} fragment
 * @returns {string}
 */
function decodeFragment(fragment) {
  let start = 0;
  while (start < fragment.length && (fragment[start] & 0xc0) === 0x80) start += 1;
  return fragment.toString("utf8", start);
}

/**
 * The last cache-read number in a fragment text, or null.
 *
 * @param {string} text
 * @returns {number|null}
 */
function lastCacheRead(text) {
  const matches = [...text.matchAll(CACHE_READ_PATTERN)];
  return matches.length > 0 ? Number(matches.at(-1)?.[1]) : null;
}

/**
 * Bound one tool result to at most `maxBytes` UTF-8 bytes, keeping the head
 * and the tail around an omission marker. This is the reference head+tail
 * form the toolPolicy contract names; a cut never splits a UTF-8 sequence.
 *
 * @param {string} value
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateToolOutput(value, maxBytes = TOOL_OUTPUT_LIMIT_BYTES) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  if (maxBytes < 192) {
    // Too small to carry a head+tail marker: keep only a UTF-8-safe prefix.
    let end = Math.max(0, maxBytes - 3);
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return end > 0 ? `${bytes.subarray(0, end).toString("utf8")}…` : "";
  }
  // Reserve headroom for the marker so the bounded result can never exceed
  // the limit regardless of how many digits the omission count needs.
  const markerBudget = 96;
  const headBudget = Math.floor((maxBytes - markerBudget) / 2);
  const tailBudget = maxBytes - markerBudget - headBudget;
  let headEnd = headBudget;
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = bytes.length - tailBudget;
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart += 1;
  const head = bytes.subarray(0, headEnd);
  const tail = bytes.subarray(tailStart);
  const marker = `\n…[${bytes.length - head.length - tail.length} bytes truncated; narrow with grep or tail]…\n`;
  return Buffer.concat([head, Buffer.from(marker, "utf8"), tail]).toString("utf8");
}
