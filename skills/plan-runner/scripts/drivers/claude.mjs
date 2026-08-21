import { normalizeClaudeResult, parseVersion } from "./exec-jsonl.mjs";

/**
 * @type {import("./index.mjs").DriverAdapter}
 */
export const claudeDriver = {
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
    return process.env.PLAN_RUNNER_CLAUDE_BIN ?? runtime.executable ?? "claude";
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
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt };
  },

  normalize: normalizeClaudeResult,
};

export const driver = claudeDriver;
export default claudeDriver;
