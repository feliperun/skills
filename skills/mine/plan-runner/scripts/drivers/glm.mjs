import { normalizeClaudeResult, parseVersion } from "./exec-jsonl.mjs";

/** Default Z.ai Anthropic-compatible endpoint serving GLM models. */
export const GLM_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";

/** Default environment variable holding the Z.ai API token. */
export const GLM_DEFAULT_AUTH_TOKEN_ENV = "ZAI_API_KEY";

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
    continuation: false,
    usage: true,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.PLAN_RUNNER_GLM_BIN ?? runtime.executable ?? "claude";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("./index.mjs").DriverRuntime} runtime @param {string} prompt @param {import("./index.mjs").CommandOptions} options @returns {import("./index.mjs").DriverCommand} */
  command(runtime, prompt, options) {
    const args = [
      "-p",
      "--model",
      runtime.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      runtime.permissionMode ?? "acceptEdits",
    ];
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    /** @type {Record<string, string|null>} */
    const env = {
      ANTHROPIC_BASE_URL: /** @type {string} */ (runtime.config?.base_url) ?? GLM_DEFAULT_BASE_URL,
      ANTHROPIC_MODEL: runtime.model,
      // An ambient Anthropic key must not shadow the Z.ai token.
      ANTHROPIC_API_KEY: null,
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
