import { normalizeCodexResult, parseVersion, toml } from "./protocol.mjs";

/**
 * Bound the Codex harness preamble: a closed-packet worker or a read-only judge
 * needs the shell and patch tools, not browser, computer-use, app or sub-agent
 * tooling, MCP servers, or plugins. `features.code_mode_host` stays enabled:
 * codex-cli 0.152.1 only surfaces commands to OpenAI models through the
 * code-mode host, and without it they make zero tool calls and fabricate
 * answers. Measured on the Sol gate: gpt-5.6-sol with the host disabled used
 * 35,130 input tokens and fabricated its verdict, versus 35,199 with the host
 * enabled and a correct tool-backed verdict; deepseek-v4-flash used 25,795
 * with the host disabled and 25,783 with the host enabled, both correct.
 * These overrides are emitted before the runtime's own `config` entries, so a
 * contract can re-enable any of them.
 */
export const CODEX_PREAMBLE_OVERRIDES = Object.freeze([
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.computer_use=false",
  "features.apps=false",
  "features.multi_agent=false",
  "mcp_servers={}",
  "plugins={}",
]);

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
    toolPolicy: false,
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
    for (const override of CODEX_PREAMBLE_OVERRIDES) args.push("-c", override);
    for (const [key, value] of Object.entries(runtime.config ?? {})) {
      args.push("-c", `${key}=${toml(value)}`);
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
