import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUsage, extractJson, failed, isVerdictCandidate, parseJsonLines, parseVersion } from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The harness has no one-shot surface that reports what a turn cost, so the
 * adapter's real provider is this client: it speaks the `sdk` JSON-RPC profile
 * and folds the session firehose into the envelope. The `dsh` binary named by
 * `executable()` is the harness the client drives, and probing it is what
 * preflight means by "the provider binary exists".
 */
const RUNNER = join(HERE, "dsh-runner.mjs");

/**
 * Every runtime gets the closed-packet profile: the shipped harness advertises
 * twenty-five tools and describes goals, subagents, and skills it was never
 * asked to use. Measured on the same closed packet, that preamble costs
 * 60,994 prompt tokens against 11,959 with this patch — the overhead is
 * re-sent on every step, so it is paid once per model call, not once per node.
 * `agent-instructions` is off for the same reason the packet is closed: the
 * worker's instructions come from its packet, not from whatever `AGENTS.md`
 * sits above the worktree.
 */
const CLOSED_PACKET_PATCH = join(HERE, "dsh-closed-packet.patch.yml");

/**
 * @type {import("./index.mjs").DriverAdapter}
 */
export const dshDriver = {
  capabilities: {
    // The schema rides in the prompt and the verdict is extracted from the
    // final message, exactly as `agy` does; nothing in the wire enforces it.
    structuredOutput: true,
    promptTransport: "stdin",
    // `runtime.sandbox` maps onto DSH_PERMISSION_MODE, which is the harness's
    // own file-effect boundary and its approval policy in one value.
    sandbox: true,
    permissions: false,
    // `sdk` and `headless` are create-only: `session/resume` exists on the ACP
    // profile alone, and reusing a persisted session id is refused outright.
    continuation: false,
    tokenBudget: false,
    costBudget: false,
    usage: true,
    cost: false,
    toolPolicy: false,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_DSH_BIN ?? runtime.executable ?? "dsh";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /**
   * @param {import("./index.mjs").DriverRuntime} runtime
   * @param {string} prompt
   * @param {import("./index.mjs").CommandOptions} options
   * @returns {import("./index.mjs").DriverCommand}
   */
  command(runtime, prompt, options = {}) {
    const args = [
      RUNNER,
      "--dsh", this.executable(runtime),
      "--provider", /** @type {string} */ (runtime.config?.provider),
      "--model", runtime.model,
    ];
    if (runtime.reasoning) args.push("--reasoning", runtime.reasoning);
    if (runtime.sandbox) args.push("--sandbox", runtime.sandbox);
    args.push("--patch", CLOSED_PACKET_PATCH);
    const extraPatch = runtime.config?.patch;
    if (typeof extraPatch === "string" && extraPatch.length) args.push("--patch", extraPatch);
    return {
      executable: process.execPath,
      args,
      promptTransport: "stdin",
      input: withSchema(prompt, options.schema),
    };
  },

  /**
   * @param {string} stdout
   * @param {number|null} exitCode
   * @param {string|null} signal
   * @param {import("./index.mjs").NormalizeOptions} [options]
   * @returns {import("./index.mjs").ProviderEnvelope}
   */
  normalize(stdout, exitCode, signal, options = {}) {
    if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
    let events;
    try {
      events = parseJsonLines(stdout, "dsh");
    } catch (error) {
      return failed("invalid_protocol", error instanceof Error ? error.message : String(error));
    }
    const terminal = events.findLast((event) => event.type === "dsh.completed" || event.type === "dsh.failed");
    if (!terminal) {
      const detail = options.stderr?.trim();
      return failed(
        "incomplete_stream",
        `dsh emitted no terminal event${detail ? `: ${detail.slice(-512)}` : ""}${exitCode === null ? "" : ` (exit ${exitCode})`}`,
      );
    }
    const usage = canonicalUsage(terminal.usage);
    if (terminal.type === "dsh.completed") {
      const text = typeof terminal.result === "string" ? terminal.result : null;
      const result = options.preferStructured ? extractJson(text) ?? text : text;
      const verdicts = options.preferStructured ? countVerdicts(events) : null;
      return {
        status: result?.trim() ? "done" : "no-op",
        result,
        continuationId: null,
        usage,
        costUsd: null,
        error: null,
        ...(verdicts === null ? {} : { judgeCandidates: verdicts }),
      };
    }
    const error = terminal.error && typeof terminal.error === "object" ? /** @type {Record<string, unknown>} */ (terminal.error) : {};
    const kind = typeof terminal.kind === "string" ? terminal.kind : "error";
    const code = typeof error.code === "string" && error.code ? error.code : kind;
    const message = typeof error.message === "string" && error.message ? error.message : code;
    const resetAt = resetTimestamp(error.retryAfterMs);
    return {
      status: statusFor(kind, `${code} ${message}`),
      result: null,
      continuationId: null,
      usage,
      costUsd: null,
      error: { code, message, ...(resetAt ? { resetAt } : {}) },
      ...(resetAt ? { exhaustedUntil: resetAt } : {}),
    };
  },
};

/**
 * Append the output schema the judge prompt refers to. Codex and Claude receive
 * it through a native flag; this harness has none, so it travels in the prompt.
 *
 * @param {string} prompt
 * @param {object|undefined} schema
 * @returns {string}
 */
function withSchema(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}\n\nOutput schema (the JSON object must validate against it):\n${JSON.stringify(schema)}`;
}

/**
 * Count the verdict-shaped final messages, the way the codex adapter does: two
 * verdicts in one turn must be visible at the provider boundary, because the
 * last one alone is indistinguishable from a single clean answer.
 *
 * @param {Record<string, unknown>[]} events
 * @returns {number}
 */
function countVerdicts(events) {
  return events.filter((event) => event.type === "dsh.message" && isVerdictCandidate(event.text)).length;
}

/**
 * @param {string} kind
 * @param {string} text
 * @returns {"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"}
 */
function statusFor(kind, text) {
  if (kind === "aborted") return "canceled";
  if (kind === "blocked") return "blocked";
  if (/\bQUOTA\b|\bRATE_LIMIT\b|insufficient balance|quota|rate.?limit/iu.test(text)) return "exhausted";
  if (/permission|approval|sandbox/iu.test(text)) return "blocked";
  return "failed";
}

/**
 * Turn the harness's relative retry hint into the absolute instant the
 * controller needs; without one it takes the failover edge instead of waiting.
 *
 * @param {unknown} retryAfterMs
 * @returns {string|null}
 */
function resetTimestamp(retryAfterMs) {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null;
  return new Date(Date.now() + retryAfterMs).toISOString();
}

export const driver = dshDriver;
export default dshDriver;
