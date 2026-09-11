import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../protocol.mjs";

/** Envelope statuses a recording may carry. */
const REPLAY_STATUSES = Object.freeze(new Set([
  "done",
  "no-op",
  "blocked",
  "failed",
  "exhausted",
  "stalled",
  "canceled",
]));

/**
 * Deterministic provider stand-in. The recording holds already-normalized
 * envelopes consumed strictly in order through a `<recording>.cursor` sidecar,
 * so the controller exercises everything after provider normalization with
 * zero model invocations.
 *
 * @type {import("../index.mjs").HarnessAdapter}
 */
export const replayHarness = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: false,
    continuation: true,
    tokenBudget: true,
    costBudget: true,
    usage: true,
    cost: true,
    // A recording cannot prove mechanical tool-policy enforcement.
    toolPolicy: false,
    // replay/bin.mjs writes its one envelope line after the recorded delay,
    // never incrementally.
    streamsOutput: false,
  },

  // A recording exposes no permission mode.
  permissionExecution: null,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_REPLAY_BIN
      ?? runtime.executable
      ?? fileURLToPath(new URL("./bin.mjs", import.meta.url));
  },

  /**
   * A recording only stands in for a prompt invocation; the live version
   * probe (`probeRuntime`) never touches it, so a deterministic case that
   * needs to prove a probe's own balance/quota/missing-CLI classification
   * declares `config["replay.probe"]` instead — carried to replay/bin.mjs as
   * a `--replay-probe` argument, the same way a recorded envelope carries
   * `error.resetAt` to prove a reset instant.
   *
   * @param {import("../index.mjs").HarnessRuntime} runtime @returns {string[]}
   */
  versionArgs(runtime) {
    const probe = runtime.config?.["replay.probe"];
    if (probe === undefined) return runtime.versionArgs ?? ["--version"];
    if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
      throw new TypeError('replay runtime config["replay.probe"] must be an object');
    }
    return ["--version", "--replay-probe", JSON.stringify(probe)];
  },

  parseVersion,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @param {string} prompt @param {import("../index.mjs").CommandOptions} options @returns {import("../index.mjs").HarnessCommand} */
  command(runtime, prompt, options) {
    const recording = runtime.config?.["replay.recording"];
    if (typeof recording !== "string" || recording.length === 0) {
      throw new TypeError('replay runtime requires config["replay.recording"]');
    }
    const args = ["--recording", resolve(recording)];
    if (options.continuationId) args.push("--continuation", options.continuationId);
    if (options.schema || options.schemaPath) args.push("--schema");
    return {
      executable: this.executable(runtime),
      args,
      promptTransport: "stdin",
      input: prompt,
    };
  },

  normalize: normalizeReplayResult,
};

export const harness = replayHarness;
export default replayHarness;

/**
 * Parse the last non-empty stdout line as an already-normalized provider
 * envelope. Canonical fields are kept — including the optional
 * `error.resetAt` and `exhaustedUntil`, in exactly the shape
 * `ProviderEnvelope` declares for a real harness — and unknown fields are
 * dropped; anything else (prose, an empty stream, a non-zero exit with no
 * envelope) normalizes to a `failed` envelope with error code
 * `invalid_output`. Never throws.
 *
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @returns {import("../index.mjs").ProviderEnvelope}
 */
function normalizeReplayResult(stdout, exitCode, signal) {
  const envelope = parseLastEnvelope(stdout);
  if (envelope) return envelope;
  const reason = signal
    ? `provider ended after ${signal}`
    : exitCode
      ? `replay exited with code ${exitCode}`
      : lastNonEmpty(stdout) === null
        ? "replay emitted no stdout"
        : "replay stdout is not a valid envelope";
  return {
    status: "failed",
    result: null,
    continuationId: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: null,
    error: { code: "invalid_output", message: boundedText(reason, 512) },
  };
}

/**
 * @param {string} stdout
 * @returns {import("../index.mjs").ProviderEnvelope|null}
 */
function parseLastEnvelope(stdout) {
  const line = lastNonEmpty(stdout);
  if (line === null) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return canonicalEnvelope(parsed);
}

/**
 * @param {string} stdout
 * @returns {string|null}
 */
function lastNonEmpty(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? null;
}

/**
 * Validate one parsed stdout value as a canonical envelope and return it with
 * exactly the canonical fields. Returns null (never throws) when the value is
 * not a well-formed envelope.
 *
 * @param {unknown} value
 * @returns {import("../index.mjs").ProviderEnvelope|null}
 */
function canonicalEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = /** @type {Record<string, unknown>} */ (value);
  const status = envelope.status;
  if (typeof status !== "string" || !REPLAY_STATUSES.has(status)) return null;
  const result = envelope.result;
  if (result !== null && typeof result !== "string") return null;
  const continuationId = envelope.continuationId;
  if (continuationId !== null && typeof continuationId !== "string") return null;
  const usage = canonicalUsage(envelope.usage);
  if (!usage) return null;
  const costUsd = envelope.costUsd;
  if (costUsd !== null && (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)) return null;
  const error = canonicalError(envelope.error);
  if (error === undefined) return null;
  const exhaustedUntil = envelope.exhaustedUntil;
  if (exhaustedUntil !== undefined && exhaustedUntil !== null && typeof exhaustedUntil !== "string") return null;
  return {
    status: /** @type {"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"} */ (status),
    result,
    continuationId,
    usage,
    costUsd,
    error,
    ...(exhaustedUntil !== undefined ? { exhaustedUntil } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}|null}
 */
function canonicalUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = /** @type {Record<string, unknown>} */ (value);
  /** @type {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} */
  const record = { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
  for (const key of /** @type {("inputTokens"|"outputTokens"|"cacheReadInputTokens")[]} */ (Object.keys(record))) {
    const raw = usage[key];
    if (raw === undefined) continue;
    if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) return null;
    record[key] = raw;
  }
  return record;
}

/**
 * @param {unknown} value
 * @returns {{code: string, message: string, resetAt?: string|null}|null|undefined}
 */
function canonicalError(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = /** @type {Record<string, unknown>} */ (value);
  if (typeof error.code !== "string" || error.code.length === 0 || typeof error.message !== "string") return undefined;
  const resetAt = error.resetAt;
  if (resetAt !== undefined && resetAt !== null && typeof resetAt !== "string") return undefined;
  return { code: error.code, message: error.message, ...(resetAt !== undefined ? { resetAt } : {}) };
}

/**
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedText(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}
