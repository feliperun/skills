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
    continuation: false,
    usage: true,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.PLAN_RUNNER_CODEX_BIN ?? runtime.executable ?? "codex";
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("./index.mjs").DriverRuntime} runtime @param {string} prompt @param {import("./index.mjs").CommandOptions} options @returns {import("./index.mjs").DriverCommand} */
  command(runtime, prompt, options) {
    const args = ["exec", "--json", "--sandbox", runtime.sandbox ?? "workspace-write"];
    for (const [key, value] of Object.entries(runtime.config ?? {})) {
      args.push("-c", `${key}=${toml(value)}`);
    }
    args.push("-c", `model=${toml(runtime.model)}`);
    if (runtime.reasoning) args.push("-c", `model_reasoning_effort=${toml(runtime.reasoning)}`);
    if (options.schemaPath) args.push("--output-schema", options.schemaPath);
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt };
  },

  normalize: normalizeCodexResult,
};

export const driver = codexDriver;
export default codexDriver;
