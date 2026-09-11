import { normalizeAgyResult, parseVersion } from "../protocol.mjs";

/**
 * @type {import("../index.mjs").HarnessAdapter}
 */
export const agyHarness = {
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
    toolPolicy: false,
    // `--output-format=stream-json` writes one JSON line per event as the
    // turn runs, not one dump at exit.
    streamsOutput: true,
  },

  // command() always passes --dangerously-skip-permissions.
  permissionExecution: null,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.INTENT_FACTORY_AGY_BIN ?? runtime.executable ?? "agy";
  },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @param {string} prompt @param {import("../index.mjs").CommandOptions} options @returns {import("../index.mjs").HarnessCommand} */
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

export const harness = agyHarness;
export default agyHarness;
