import { normalizeClaudeResult, parseVersion } from "./protocol.mjs";
import { hookSettings } from "../tool-policy-hook.mjs";

/** Built-in tools a closed-packet worker needs; every other tool is preamble. */
export const DEFAULT_CLAUDE_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

/**
 * Bound the harness preamble of a Claude-compatible CLI: no skills, no MCP
 * servers, no settings files (an explicit `--settings` still applies, so hook
 * enforcement survives) and only the declared built-in tools. Measured on
 * 2026-09-01 with glm-5.3[1m]: 65,170 uncached input tokens per trivial call
 * with the ambient configuration, about 4,300 per turn with these flags.
 * `--bare` would cut further but disables hooks, so it is never used.
 *
 * @param {import("./index.mjs").DriverRuntime} runtime
 * @returns {string[]}
 */
export function claudePreambleArgs(runtime) {
  return [
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    (runtime.tools ?? DEFAULT_CLAUDE_TOOLS).join(","),
  ];
}

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
    // `--output-format stream-json --verbose` writes one JSON line per event
    // as the turn runs, not one dump at exit.
    streamsOutput: true,
  },

  // Headless acceptEdits denies Bash; bypassPermissions executes commands.
  permissionExecution: { field: "permissionMode", executingModes: ["bypassPermissions"], defaultMode: "acceptEdits" },

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
      ...claudePreambleArgs(runtime),
    ];
    if (options.toolPolicy) args.push("--settings", JSON.stringify(hookSettings(options.toolPolicy)));
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt };
  },

  normalize: normalizeClaudeResult,
};

export const driver = claudeDriver;
export default claudeDriver;
