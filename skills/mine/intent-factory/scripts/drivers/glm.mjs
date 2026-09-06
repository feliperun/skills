import { normalizeClaudeResult, parseVersion } from "./exec-jsonl.mjs";
import { hookSettings } from "../tool-policy-hook.mjs";
import { claudePreambleArgs } from "./claude.mjs";

/** Default Z.ai Anthropic-compatible endpoint serving GLM models. */
export const GLM_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";

/** Default environment variable holding the Z.ai API token. */
export const GLM_DEFAULT_AUTH_TOKEN_ENV = "ZAI_API_KEY";

/** GLM model that serves the CLI's internal small-model (haiku) calls. */
export const GLM_DEFAULT_SMALL_MODEL = "glm-5.3-flash";

/**
 * GLM driver: drives a Claude-Code-compatible CLI pinned to the Z.ai
 * Anthropic-compatible endpoint, so a contract can route GLM 5.3 nodes
 * regardless of the caller's ambient Anthropic configuration. The token is
 * read at invocation time from the environment variable named by
 * `config["auth_token.env_key"]` (default `ZAI_API_KEY`, falling back to
 * `ANTHROPIC_AUTH_TOKEN`); values never travel in the contract.
 *
 * @type {import("./index.mjs").DriverAdapter}
 */
export const glmDriver = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: true,
    continuation: true,
    tokenBudget: false,
    costBudget: true,
    usage: true,
    cost: true,
    // The Claude-compatible hook surface enforces the tool policy mechanically.
    toolPolicy: true,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_GLM_BIN ?? runtime.executable ?? "claude";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("./index.mjs").DriverRuntime} runtime @param {string} prompt @param {import("./index.mjs").CommandOptions} options @returns {import("./index.mjs").DriverCommand} */
  command(runtime, prompt, options) {
    const continuationId = options.continuationId ?? null;
    const args = [
      "-p",
      ...(continuationId ? ["--resume", continuationId] : []),
      "--model",
      runtime.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      runtime.permissionMode ?? "acceptEdits",
      ...claudePreambleArgs(runtime),
    ];
    if (options.toolPolicy) args.push("--settings", JSON.stringify(hookSettings(options.toolPolicy)));
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    if (options.maxCostUsd !== undefined) args.push("--max-budget-usd", String(options.maxCostUsd));
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    // Claude Code reads `[1m]` as the 1M-context tier of the model in front of
    // it; the Z.ai endpoint itself does not know the suffix.
    const oneMillion = /\[1m\]$/iu.test(runtime.model);
    /** @type {Record<string, string|null>} */
    const env = {
      ANTHROPIC_BASE_URL: /** @type {string} */ (runtime.config?.base_url) ?? GLM_DEFAULT_BASE_URL,
      ANTHROPIC_MODEL: runtime.model,
      // An ambient Anthropic key must not shadow the Z.ai token.
      ANTHROPIC_API_KEY: null,
      // The Z.ai coding-plan environment that @z_ai/coding-helper writes into
      // Claude Code settings, carried here because the preamble diet disables
      // settings files: no telemetry or update traffic, an API timeout that
      // survives long GLM generations, every internal model tier routed to a
      // GLM model, and the compaction window matched to the context window.
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: oneMillion ? `${GLM_DEFAULT_SMALL_MODEL}[1m]` : GLM_DEFAULT_SMALL_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: runtime.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: runtime.model,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(oneMillion ? 1_048_576 : 200_000),
    };
    const token = authToken(runtime);
    if (token !== null) env.ANTHROPIC_AUTH_TOKEN = token;
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt, env };
  },

  normalize: normalizeClaudeResult,
};

/**
 * @param {import("./index.mjs").DriverRuntime} runtime
 * @returns {string|null}
 */
function authToken(runtime) {
  const declared = /** @type {unknown} */ (runtime.config?.["auth_token.env_key"]);
  const name = typeof declared === "string" && declared ? declared : GLM_DEFAULT_AUTH_TOKEN_ENV;
  const resolved = process.env[name] ?? process.env.ANTHROPIC_AUTH_TOKEN;
  return typeof resolved === "string" && resolved ? resolved : null;
}

export const driver = glmDriver;
export default glmDriver;
