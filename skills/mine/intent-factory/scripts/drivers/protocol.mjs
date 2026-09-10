/**
 * Shared provider-protocol normalization and version parsing, extracted from
 * `exec-jsonl.mjs` because `claude.mjs`, `codex.mjs`, `agy.mjs`, `glm.mjs`,
 * `zcode.mjs`, `replay.mjs` and `exec-jsonl.mjs` itself all depend on it.
 */

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

export const DRIVER_OUTPUT_LIMIT_BYTES = 512 * 1024;

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
 * A stream that ended without its completion event says nothing about why.
 * When the process also wrote to stderr — a config parse error, a missing
 * binary, an auth refusal — that text is the whole diagnosis, and dropping it
 * turns a contract bug into what looks like a provider outage: a codex custom
 * provider declared without `name` dies at config load, and reporting only
 * "Codex emitted no turn.completed event" cost two preflight rounds before
 * anyone read git-less stderr by hand.
 *
 * @param {string} message
 * @param {import("./index.mjs").NormalizeOptions} [options]
 * @returns {string}
 */
function withStartupReason(message, options = {}) {
  const reason = typeof options.stderr === "string" ? options.stderr.trim() : "";
  return reason ? `${message}: ${boundedMessage(reason, 512)}` : message;
}

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {import("./index.mjs").NormalizeOptions} [options]
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeClaudeResult(stdout, exitCode, signal, options = {}) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  const events = parseJsonLines(stdout, "claude");
  const resultEvent = events.findLast((event) => event.type === "result");
  if (!resultEvent) return failed("incomplete_stream", withStartupReason("Claude emitted no result event", options));
  const result = typeof resultEvent.result === "string" ? resultEvent.result : null;
  // A provider-reported quota stop is exhaustion: the declared failover edge
  // must fire instead of settling the node as an ordinary provider failure.
  const quotaText = claudeQuotaText(resultEvent, events);
  if (quotaText) {
    return failed(
      "quota_exhausted",
      boundedMessage(quotaText, 512),
      "exhausted",
      typeof resultEvent.session_id === "string" ? resultEvent.session_id : null,
      canonicalUsage(resultEvent.usage),
    );
  }
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
    return failed("incomplete_stream", withStartupReason("agy emitted no result event", options));
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
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {import("./index.mjs").NormalizeOptions} options
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeZcodeResult(stdout, exitCode, signal, options = {}) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  // The headless result is one JSON object, not an event stream: a run that
  // died before it (config rejection, auth refusal) leaves stdout empty and
  // the whole diagnosis on stderr.
  let record;
  let parsed = false;
  try {
    record = JSON.parse(stdout);
    parsed = record !== null && typeof record === "object" && !Array.isArray(record);
  } catch {}
  if (!parsed) {
    const reason = withStartupReason("ZCode emitted no result object", options);
    // A run that died before its result object still classifies by its own
    // stderr: quota evidence is exhaustion, everything else is a plain
    // incomplete stream whose diagnosis travels in the message.
    if (isQuotaText(reason)) return failed("quota_exhausted", boundedMessage(reason, 512), "exhausted");
    return failed("incomplete_stream", reason);
  }
  const response = typeof record.response === "string" ? record.response : null;
  if (exitCode !== 0) {
    return failed("provider_error", response?.trim() ? response : withStartupReason(`ZCode exited with code ${exitCode}`, options));
  }
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? /** @type {Record<string, unknown>} */ (record.usage)
    : {};
  const result = options.preferStructured ? extractJson(response) ?? response : response;
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId: typeof record.sessionId === "string" ? record.sessionId : null,
    // ZCode inputTokens already include the cached reads (its totalTokens is
    // inputTokens + outputTokens), so the cache component is subtracted here.
    usage: canonicalUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
    }, { inputIncludesCache: true }),
    costUsd: null,
    error: null,
  };
}

/**
 * @param {Record<string, unknown>|undefined} event
 * @returns {Record<string, unknown>|null}
 */
export function eventItem(event) {
  const item = event?.item;
  return item && typeof item === "object" && !Array.isArray(item) ? /** @type {Record<string, unknown>} */ (item) : null;
}

/** Provider-reported quota and rate-limit text: exhaustion, never an ordinary provider failure. */
const QUOTA_TEXT_PATTERN = /429|1310|rate.?limit|usage limit|limit exhausted|quota|too many requests/iu;

/**
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function isQuotaText(text) {
  return QUOTA_TEXT_PATTERN.test(String(text ?? ""));
}

/**
 * Quota evidence inside one claude-family assistant error record. The record
 * shape differs across providers: the Z.ai stream carries `content` text at
 * the top level, while the Anthropic stream nests content blocks under
 * `message`.
 *
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
function assistantQuotaText(record) {
  const message = record.message && typeof record.message === "object" ? /** @type {Record<string, unknown>} */ (record.message) : null;
  const content = record.content ?? message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block === null || typeof block !== "object") return "";
      const value = /** @type {Record<string, unknown>} */ (block).text ?? /** @type {Record<string, unknown>} */ (block).content;
      return typeof value === "string" ? value : "";
    }).join("\n");
  }
  return null;
}

/**
 * Provider-reported quota text in a claude-family stream: an assistant error
 * record (`rate_limit` or an API error message) or a terminal `api_error`
 * result whose text carries quota evidence.
 *
 * @param {Record<string, unknown>|undefined} resultEvent
 * @param {Record<string, unknown>[]} events
 * @returns {string|null}
 */
function claudeQuotaText(resultEvent, events) {
  for (const event of events) {
    if (event?.type !== "assistant") continue;
    const record = /** @type {Record<string, unknown>} */ (event);
    if (record.error !== "rate_limit" && record.is_api_error_message !== true) continue;
    const text = assistantQuotaText(record);
    if (text !== null && isQuotaText(text)) return text;
  }
  if (resultEvent?.terminal_reason === "api_error" || resultEvent?.is_error === true) {
    const terminal = typeof resultEvent.result === "string"
      ? resultEvent.result
      : resultEvent.error && typeof resultEvent.error === "object"
        ? /** @type {Record<string, unknown>} */ (resultEvent.error).message
        : null;
    if (typeof terminal === "string" && isQuotaText(terminal)) return terminal;
  }
  return null;
}

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {import("./index.mjs").NormalizeOptions} options
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeCodexResult(stdout, exitCode, signal, options = {}) {
  const events = parseJsonLines(stdout, "codex");
  const thread = events.findLast((event) => event.type === "thread.started");
  const continuationId = typeof thread?.thread_id === "string" ? thread.thread_id : null;
  // A disabled code-mode host means the model could not run any command or
  // inspect anything: whatever agent_message it streamed afterwards is a
  // fabricated result, never evidence. The tool-host failure is classified
  // first so it wins over a later termination signal, a completed turn, or an
  // agent_message verdict: a judge grounded in no inspection is rejected, and
  // a harness that dies after the host error is not a plain cancellation.
  // Other item-level error records (rollout_budget warnings, missing model
  // metadata, ...) are diagnostics and stay ignored.
  const toolHostError = events.find((event) => {
    if (event.type !== "item.completed") return false;
    const item = eventItem(event);
    return item?.type === "error" && typeof item.message === "string"
      && (item.message.includes("code-mode host is disabled") || item.message.includes("Code Mode is unavailable"));
  });
  if (toolHostError) {
    const item = eventItem(toolHostError);
    const message = typeof item?.message === "string" ? item.message : "code-mode host is disabled";
    const completed = events.findLast((event) => event.type === "turn.completed");
    return failed(
      "tool_host_unavailable",
      boundedMessage(message, 512),
      undefined,
      continuationId,
      canonicalUsage(completed?.usage, { inputIncludesCache: true }),
    );
  }
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled", continuationId);
  const completed = events.findLast((event) => event.type === "turn.completed");
  const messages = events.filter((event) => event.type === "item.completed" && eventItem(event)?.type === "agent_message");
  // A judge round is arbitrated by exactly one verdict. Counting the
  // verdict-shaped messages here, at the provider boundary, is the only way the
  // controller can tell one verdict from two: the last structured message looks
  // identical in both cases once the rest is discarded.
  const verdictCandidates = options.preferStructured ? messages.filter((event) => isVerdictCandidate(eventItem(event)?.text)) : [];
  const message = options.preferStructured
    ? verdictCandidates.at(-1) ?? messages.findLast((event) => extractJson(eventItem(event)?.text) !== null) ?? messages.at(-1)
    : messages.at(-1);
  const failure = events.findLast((event) => event.type === "turn.failed" || event.type === "error");
  if (failure) {
    const errorRecord = /** @type {Record<string, unknown>|undefined} */ (failure?.error);
    const failureMessage = typeof errorRecord?.message === "string" ? errorRecord.message
      : typeof failure?.message === "string" ? failure.message
      : "Codex failed";
    const usage = canonicalUsage(errorRecord?.usage ?? failure?.usage, { inputIncludesCache: true });
    if (isQuotaText(failureMessage)) {
      return failed("quota_exhausted", boundedMessage(failureMessage, 512), "exhausted", continuationId, usage);
    }
    return failed(
      "provider_error",
      failureMessage,
      undefined,
      continuationId,
      usage,
    );
  }
  if (!completed) return failed("incomplete_stream", withStartupReason("Codex emitted no turn.completed event", options), undefined, continuationId);
  const text = eventItem(message)?.text;
  const textResult = typeof text === "string" ? text : null;
  // A finished turn with a final message is accepted work regardless of the
  // harness exit code: the exit code is evidence about the harness, not about
  // the result. Only a turn that ended without any final message still
  // reports the non-zero exit as a provider error.
  if (exitCode !== 0 && typeof text !== "string") {
    return failed(
      "provider_error",
      `Codex exited with code ${exitCode}`,
      undefined,
      continuationId,
      canonicalUsage(completed.usage, { inputIncludesCache: true }),
    );
  }
  const result = options.preferStructured ? extractJson(textResult) ?? textResult : textResult;
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId,
    usage: canonicalUsage(completed.usage, { inputIncludesCache: true }),
    costUsd: null,
    error: null,
    ...(options.preferStructured ? { judgeCandidates: verdictCandidates.length } : {}),
  };
}

/**
 * Whether one agent message carries a verdict-shaped object: a JSON value whose
 * `verdict` names the only two outcomes a gate accepts. Prose, partial JSON,
 * and unrelated objects are not candidates.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isVerdictCandidate(text) {
  const candidate = extractJson(text);
  if (candidate === null) return false;
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(candidate));
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && ["pass", "fail"].includes(String(/** @type {Record<string, unknown>} */ (parsed).verdict)));
  } catch {
    return false;
  }
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
 * Truncate a diagnostic message to at most `maxBytes` UTF-8 bytes without
 * splitting a multi-byte sequence.
 *
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedMessage(value, maxBytes) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  // Cut before the character that starts at or after the limit. Backing up to
  // a lead byte without dropping it would leave a dangling sequence that
  // re-encodes as U+FFFD and can exceed the byte ceiling.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * @param {string} code
 * @param {string} message
 * @param {"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"} status
 * @param {string|null} [continuationId]
 * @param {ReturnType<typeof canonicalUsage>} [usage]
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function failed(code, message, status = classifyFailure(message), continuationId = null, usage = canonicalUsage()) {
  return {
    status,
    result: null,
    continuationId,
    usage,
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
  if (isQuotaText(text) || /budget|token.*limit|context.*limit|max.*turn/iu.test(text)) return "exhausted";
  return "failed";
}

/**
 * @param {unknown} usage
 * @param {{inputIncludesCache?: boolean}} [options]
 * @returns {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}}
 */
export function canonicalUsage(usage = {}, options = {}) {
  const record = usage && typeof usage === "object" && !Array.isArray(usage) ? /** @type {Record<string, unknown>} */ (usage) : {};
  const rawInput = finite(record.inputTokens ?? record.input_tokens);
  const cacheReadInputTokens = finite(
    record.cacheReadInputTokens ?? record.cache_read_input_tokens ?? record.cached_input_tokens ?? record.cache_read_tokens,
  );
  const cacheWriteInputTokens = finite(record.cacheWriteInputTokens ?? record.cache_creation_input_tokens ?? record.cache_write_tokens) ?? 0;
  const inputTokens = rawInput === null
    ? null
    : Math.max(0, rawInput + cacheWriteInputTokens - (options.inputIncludesCache ? cacheReadInputTokens ?? 0 : 0));
  return {
    inputTokens,
    outputTokens: finite(record.outputTokens ?? record.output_tokens),
    cacheReadInputTokens,
  };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
