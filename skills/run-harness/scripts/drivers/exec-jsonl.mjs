/**
 * Generic exec-jsonl adapter protocol.
 *
 * The executable receives one UTF-8 JSON line on stdin:
 * `{schemaVersion:1,type:"run.request",model,prompt,structuredOutput,
 * outputSchema,continuationId}`. It writes JSONL events to stdout:
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
export const EXEC_JSONL_PROTOCOL = Object.freeze({
  schemaVersion: 1,
  requestType: "run.request",
  completedType: "run.completed",
  failedType: "run.failed",
});
export const DRIVER_OUTPUT_LIMIT_BYTES = 512 * 1024;

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
    usage: true,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.HARNESS_EXEC_JSONL_BIN ?? runtime.executable ?? "exec-jsonl";
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
 * Parse newline-delimited JSON without accepting provider prose.
 *
 * @param {string} stdout
 * @param {string} driver
 * @returns {Record<string, unknown>[]}
 */
export function parseJsonLines(stdout, driver) {
  const raw = Buffer.from(String(stdout), "utf8");
  const truncated = raw.length > DRIVER_OUTPUT_LIMIT_BYTES;
  const bounded = truncated ? raw.subarray(raw.length - DRIVER_OUTPUT_LIMIT_BYTES).toString("utf8") : raw.toString("utf8");
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let firstNonEmpty = true;
  for (const [index, line] of bounded.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
      firstNonEmpty = false;
    } catch (error) {
      // A bounded tail (or a log capped by the gate wrapper) can start inside a
      // provider event; only the first non-empty line may be partial.
      if (firstNonEmpty) continue;
      throw new Error(`${driver} emitted invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

/**
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string|null}
 */
export function parseVersion(stdout, stderr = "") {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  if (!line || /^[\[{]/u.test(line)) return null;
  return /(?:^|[\s/])v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:$|\s)/u.test(line)
    ? line
    : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function toml(value) {
  return JSON.stringify(value);
}

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeClaudeResult(stdout, exitCode, signal) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  const events = parseJsonLines(stdout, "claude");
  const resultEvent = events.findLast((event) => event.type === "result");
  if (!resultEvent) return failed("incomplete_stream", "Claude emitted no result event");
  const result = typeof resultEvent.result === "string" ? resultEvent.result : null;
  if (resultEvent.is_error || exitCode !== 0) {
    return failed("provider_error", result ?? `Claude exited with code ${exitCode}`);
  }
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId: typeof resultEvent.session_id === "string" ? resultEvent.session_id : null,
    usage: canonicalUsage(resultEvent.usage),
    costUsd: finite(resultEvent.total_cost_usd),
    error: null,
  };
}

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {import("./index.mjs").NormalizeOptions} options
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeAgyResult(stdout, exitCode, signal, options = {}) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  const events = parseJsonLines(stdout, "agy");
  const resultEvent = events.findLast((event) => event.event === "result")?.result;
  if (!resultEvent || typeof resultEvent !== "object" || Array.isArray(resultEvent)) {
    return failed("incomplete_stream", "agy emitted no result event");
  }
  const record = /** @type {Record<string, unknown>} */ (resultEvent);
  const response = typeof record.response === "string" ? record.response : null;
  if (record.status !== "SUCCESS" || exitCode !== 0) {
    return failed("provider_error", typeof record.error === "string" ? record.error : `agy exited with code ${exitCode}`);
  }
  const result = options.preferStructured ? extractJson(response) ?? response : response;
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId: typeof record.conversation_id === "string" ? record.conversation_id : null,
    usage: canonicalUsage(record.usage),
    costUsd: null,
    error: null,
  };
}

/**
 * @param {Record<string, unknown>|undefined} event
 * @returns {Record<string, unknown>|null}
 */
function eventItem(event) {
  const item = event?.item;
  return item && typeof item === "object" && !Array.isArray(item) ? /** @type {Record<string, unknown>} */ (item) : null;
}

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {import("./index.mjs").NormalizeOptions} options
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeCodexResult(stdout, exitCode, signal, options = {}) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  const events = parseJsonLines(stdout, "codex");
  const completed = events.findLast((event) => event.type === "turn.completed");
  const messages = events.filter((event) => event.type === "item.completed" && eventItem(event)?.type === "agent_message");
  const message = options.preferStructured
    ? messages.findLast((event) => extractJson(eventItem(event)?.text) !== null) ?? messages.at(-1)
    : messages.at(-1);
  const failure = events.findLast((event) => event.type === "turn.failed" || event.type === "error");
  if (failure || exitCode !== 0) {
    const errorRecord = /** @type {Record<string, unknown>|undefined} */ (failure?.error);
    return failed(
      "provider_error",
      typeof errorRecord?.message === "string" ? errorRecord.message
        : typeof failure?.message === "string" ? failure.message
          : `Codex exited with code ${exitCode}`,
    );
  }
  if (!completed) return failed("incomplete_stream", "Codex emitted no turn.completed event");
  const text = eventItem(message)?.text;
  const textResult = typeof text === "string" ? text : null;
  const result = options.preferStructured ? extractJson(textResult) ?? textResult : textResult;
  const thread = events.find((event) => event.type === "thread.started");
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId: typeof thread?.thread_id === "string" ? thread.thread_id : null,
    usage: canonicalUsage(completed.usage),
    costUsd: null,
    error: null,
  };
}

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
 * Extract a JSON value from a provider response that may carry prose, taking
 * the last parseable suffix or fenced JSON block.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function extractJson(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}
  const lines = trimmed.split(/\r?\n/u);
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const candidate = lines.slice(index).join("\n").trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
  const blocks = [...value.matchAll(/```json\s*([\s\S]*?)```/giu)];
  for (const block of blocks.reverse()) {
    const candidate = block[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"} status
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
function failed(code, message, status = classifyFailure(message)) {
  return {
    status,
    result: null,
    continuationId: null,
    usage: canonicalUsage(),
    costUsd: null,
    error: { code, message: String(message) },
  };
}

/**
 * @param {string} message
 * @returns {"canceled"|"blocked"|"exhausted"|"failed"}
 */
function classifyFailure(message) {
  const text = String(message);
  if (/cancel(?:ed|led)|aborted/iu.test(text)) return "canceled";
  if (/permission|approval|sandbox/iu.test(text)) return "blocked";
  if (/budget|token.*limit|context.*limit|max.*turn/iu.test(text)) return "exhausted";
  return "failed";
}

/**
 * @param {unknown} usage
 * @returns {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}}
 */
function canonicalUsage(usage = {}) {
  const record = usage && typeof usage === "object" && !Array.isArray(usage) ? /** @type {Record<string, unknown>} */ (usage) : {};
  return {
    inputTokens: finite(record.inputTokens ?? record.input_tokens),
    outputTokens: finite(record.outputTokens ?? record.output_tokens),
    cacheReadInputTokens: finite(
      record.cacheReadInputTokens ?? record.cache_read_input_tokens ?? record.cached_input_tokens ?? record.cache_read_tokens,
    ),
  };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
