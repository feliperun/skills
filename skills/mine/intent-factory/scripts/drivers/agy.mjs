import { normalizeAgyResult, parseVersion } from "./exec-jsonl.mjs";

/**
 * @type {import("./index.mjs").DriverAdapter}
 */
export const agyDriver = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "argv",
    maxArgvPromptBytes: 128 * 1024,
    sandbox: false,
    permissions: false,
    continuation: true,
    tokenBudget: false,
    costBudget: false,
    usage: true,
    cost: false,
  },

  /** @param {import("./index.mjs").DriverRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.PLAN_RUNNER_AGY_BIN ?? runtime.executable ?? "agy";
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
      `--model=${runtime.model}`,
      "--output-format=stream-json",
      "--dangerously-skip-permissions",
      `--print-timeout=${runtime.printTimeout ?? "24h"}`,
    ];
    if (continuationId) args.push(`--conversation=${continuationId}`);
    if (runtime.reasoning) {
      const effort = ["xhigh", "max"].includes(runtime.reasoning) ? "high" : runtime.reasoning;
      args.push(`--effort=${effort}`);
    }
    if (options.schema) args.push(`--json-schema=${JSON.stringify(options.schema)}`);
    args.push(`--print=${prompt}`);
    return { executable: this.executable(runtime), args, promptTransport: "argv", input: null };
  },

  normalize: normalizeAgyResult,
};

export const driver = agyDriver;
export default agyDriver;
