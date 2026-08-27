import { normalizeCodexResult, parseVersion, toml } from "./exec-jsonl.mjs";

/**
 * @type {import("./index.mjs").DriverAdapter}
 */
export const codexDriver = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: true,
    permissions: false,
    continuation: true,
    tokenBudget: true,
    costBudget: false,
    usage: true,
    cost: false,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_CODEX_BIN ?? runtime.executable ?? "codex";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("./index.mjs").DriverRuntime} runtime @param {string} prompt @param {import("./index.mjs").CommandOptions} options @returns {import("./index.mjs").DriverCommand} */
  command(runtime, prompt, options) {
    const continuationId = options.continuationId ?? null;
    const args = continuationId
      ? ["exec", "resume", "--json"]
      : ["exec"];
    if (!continuationId) args.push("--json", "--sandbox", runtime.sandbox ?? "workspace-write");
    for (const [key, value] of Object.entries(runtime.config ?? {})) {
      args.push("-c", `${key}=${toml(value)}`);
    }
    if (options.maxInvocationTokens) {
      args.push("-c", `features.rollout_budget={enabled=true,limit_tokens=${options.maxInvocationTokens},reminder_at_remaining_tokens=[],sampling_token_weight=1.0,prefill_token_weight=1.0}`);
    }
    args.push("-c", `model=${toml(runtime.model)}`);
    if (runtime.reasoning) args.push("-c", `model_reasoning_effort=${toml(runtime.reasoning)}`);
    if (options.schemaPath) args.push("--output-schema", options.schemaPath);
    if (continuationId) return { executable: this.executable(runtime), args: [...args, continuationId, prompt], promptTransport: "argv", input: null };
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt };
  },

  normalize: normalizeCodexResult,
};

export const driver = codexDriver;
export default codexDriver;
