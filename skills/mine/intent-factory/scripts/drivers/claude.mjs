import { normalizeClaudeResult, parseVersion } from "./exec-jsonl.mjs";
import { hookSettings } from "../tool-policy-hook.mjs";

/**
 * @type {import("./index.mjs").DriverAdapter}
 */
export const claudeDriver = {
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
    return process.env.INTENT_FACTORY_CLAUDE_BIN ?? runtime.executable ?? "claude";
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
    ];
    if (options.toolPolicy) args.push("--settings", JSON.stringify(hookSettings(options.toolPolicy)));
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    if (options.maxCostUsd !== undefined) args.push("--max-budget-usd", String(options.maxCostUsd));
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt };
  },

  normalize: normalizeClaudeResult,
};

export const driver = claudeDriver;
export default claudeDriver;
