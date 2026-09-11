import { normalizeZcodeResult, parseVersion } from "./protocol.mjs";

/** Default Z.ai Anthropic-compatible endpoint serving GLM models. */
const ZCODE_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";

/** Provider id in the ZCODE_MODEL target; it also derives the auth env var name. */
const ZCODE_DEFAULT_PROVIDER = "glm";

/** Default environment variable holding the Z.ai API token. */
const ZCODE_DEFAULT_AUTH_TOKEN_ENV = "ZAI_API_KEY";

/**
 * ZCode driver: drives Z.ai's own harness CLI headlessly (`--prompt --json`),
 * so a contract can route GLM 5.x nodes through the native ZCode protocol
 * instead of a Claude-Code-compatible shim. The CLI 0.16.5 headless surface is
 * `--prompt`, `--json`, `--mode`, `--resume`, and `--no-color`; model and
 * endpoint travel as `ZCODE_MODEL` (`provider/model`) and `ZCODE_BASE_URL`,
 * and the token is read at invocation time from the environment variable named
 * by `config["auth_token.env_key"]` (default `ZAI_API_KEY`, falling back to
 * `ANTHROPIC_AUTH_TOKEN`) into the provider-derived `${PROVIDER}_API_KEY`
 * variable the CLI resolves. Values never travel in the contract.
 *
 * The harness has no schema flag, and this driver sends no tool policy, so
 * `structuredOutput` and `toolPolicy` stay `false`: a judge's schema travels
 * inside the prompt text (enforcement remains parseJudge at the review
 * boundary), and the CLI's `--settings`/hooks surface stays unwired.
 *
 * @type {import("./index.mjs").DriverAdapter}
 */
export const zcodeDriver = {
  capabilities: {
    structuredOutput: false,
    promptTransport: "argv",
    maxArgvPromptBytes: 128 * 1024,
    sandbox: false,
    permissions: false,
    continuation: true,
    tokenBudget: false,
    costBudget: false,
    usage: true,
    cost: false,
    toolPolicy: false,
    // `--json` (no streaming flag exists) buffers the whole turn and dumps it
    // once at exit: a live worker node was killed at 420s stall_timeout with
    // its stdout/stderr at zero bytes, while a completed 1m26s invocation's
    // log held its full 26 lines only once the process exited. Stall
    // detection must not watch this driver's stdout/stderr mtime.
    streamsOutput: false,
  },

  // build/edit/plan do not execute commands; command() defaults to yolo.
  permissionExecution: { field: "permissionMode", executingModes: ["yolo"], defaultMode: "yolo" },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_ZCODE_BIN ?? runtime.executable ?? "zcode";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("./index.mjs").DriverRuntime} runtime @param {string} prompt @param {import("./index.mjs").CommandOptions} options @returns {import("./index.mjs").DriverCommand} */
  command(runtime, prompt, options) {
    const continuationId = options.continuationId ?? null;
    const provider = typeof runtime.config?.provider === "string" && runtime.config.provider
      ? runtime.config.provider
      : ZCODE_DEFAULT_PROVIDER;
    // No schema flag exists, so the schema travels inside the prompt: the
    // judge prompt names "the output schema" but only carries its text when
    // the driver puts it there.
    const fullPrompt = options.schema
      ? `${prompt}\n\nThe output schema (return exactly one JSON object matching it, as the only content of your final message):\n${JSON.stringify(options.schema)}`
      : prompt;
    const args = [
      "--json",
      "--no-color",
      "--mode",
      runtime.permissionMode ?? "yolo",
      ...(continuationId ? ["--resume", continuationId] : []),
      "--prompt",
      fullPrompt,
    ];
    const model = runtime.model.replace(/\[1m\]$/iu, "");
    /** @type {Record<string, string|null>} */
    const env = {
      ZCODE_MODEL: `${provider}/${model}`,
      ZCODE_BASE_URL: /** @type {string} */ (runtime.config?.base_url) ?? ZCODE_DEFAULT_BASE_URL,
      // An ambient Anthropic key must not shadow the provider-derived token:
      // the CLI checks it first for anthropic-kind providers.
      ANTHROPIC_API_KEY: null,
    };
    const token = authToken(runtime);
    // The token travels under the provider-derived variable name the CLI
    // resolves (e.g. GLM_API_KEY); an unresolved token is omitted, not blanked.
    const apiKeyVar = providerApiKeyVar(provider);
    if (token !== null && apiKeyVar !== null) env[apiKeyVar] = token;
    return { executable: this.executable(runtime), args, promptTransport: "argv", input: null, env };
  },

  normalize: normalizeZcodeResult,
};

/**
 * The variable the harness reads a provider's token from: the CLI folds every
 * run of non-alphanumerics in the provider id into `_` before appending
 * `_API_KEY` (`z-ai` → `Z_AI_API_KEY`), so the id carried verbatim in
 * `ZCODE_MODEL` has to be folded the same way. An id with no alphanumerics
 * names no variable at all.
 *
 * @param {string} provider
 * @returns {string|null}
 */
function providerApiKeyVar(provider) {
  const stem = provider.trim().replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase();
  return stem ? `${stem}_API_KEY` : null;
}

/**
 * @param {import("./index.mjs").DriverRuntime} runtime
 * @returns {string|null}
 */
function authToken(runtime) {
  const declared = /** @type {unknown} */ (runtime.config?.["auth_token.env_key"]);
  const name = typeof declared === "string" && declared ? declared : ZCODE_DEFAULT_AUTH_TOKEN_ENV;
  const resolved = process.env[name] ?? process.env.ANTHROPIC_AUTH_TOKEN;
  return typeof resolved === "string" && resolved ? resolved : null;
}

export const driver = zcodeDriver;
export default zcodeDriver;
