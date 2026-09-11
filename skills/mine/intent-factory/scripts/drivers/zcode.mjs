import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { normalizeZcodeResult, parseVersion } from "./protocol.mjs";

/** Default Z.ai Anthropic-compatible endpoint serving GLM models. */
const ZCODE_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";

/** The command name the adapter resolves and the shim is installed under. */
const ZCODE_BIN_NAME = "zcode";

/**
 * macOS install layout: ZCode ships as an Electron app with the CLI bundled
 * inside it (`zcode.cjs`) and no CLI installer of its own, so a machine can run
 * the desktop app for months without ever having a runnable `zcode` command.
 * The `glm` directory name is the app's own, not this skill's provider id.
 */
const ZCODE_MACOS_BUNDLE = Object.freeze({
  electron: "/Applications/ZCode.app/Contents/MacOS/ZCode",
  cli: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
});

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
 * The vendor's own CLI reference is checked in at
 * `docs/intent-factory/ZCODE-CLI.md`; it is the authority this adapter is
 * written against, and the place to look before trusting any of the surface
 * facts above. `ensureZcodeAvailable` below implements what that document
 * describes as the install story: the CLI lives inside the app bundle and has
 * to be reached through a shim on PATH.
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
    const declared = process.env.INTENT_FACTORY_ZCODE_BIN ?? runtime.executable;
    if (declared) return declared;
    // Repair the host, then keep naming the command `zcode`. The name is part
    // of the runtime fingerprint (node.mjs hashes `{runtime, executable}`) and
    // is compared against snapshots persisted by an earlier process, where a
    // mismatch silently rotates the session and drops `--resume`. An absolute
    // path would make that identity depend on whichever PATH the process
    // happened to inherit.
    ensureZcodeAvailable();
    return ZCODE_BIN_NAME;
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

/**
 * Make the ZCode CLI reachable as `zcode`, for this process and every later
 * shell: when the name resolves to nothing on PATH and the app bundle is
 * installed, write the shim that reaches the bundled CLI through Electron's own
 * node. The install dir has to be on PATH already — a shim somewhere the shell
 * does not look would fix the driver and not the user, which is the half of the
 * request that matters here.
 *
 * Total by design: `executable()` is called by surfaces that have no error path
 * around it (`models` reports every registered driver, runtime discovery probes
 * each one, `doctor` checks binaries), so a permissions or disk failure has to
 * degrade into "not found" — never into an aborted run or a crashed report.
 *
 * @param {{env?: Record<string, string|undefined>, pathDirs?: string[], home?: string, bundle?: {electron: string, cli: string}}} [options]
 * @returns {void}
 */
export function ensureZcodeAvailable(options = {}) {
  try {
    const env = options.env ?? process.env;
    const pathDirs = options.pathDirs ?? (env.PATH ?? "").split(delimiter).filter(Boolean);
    if (resolvesOnPath(pathDirs, ZCODE_BIN_NAME)) return;
    const bundle = options.bundle ?? ZCODE_MACOS_BUNDLE;
    if (!existsSync(bundle.electron) || !existsSync(bundle.cli)) return;
    const body = zcodeShim(bundle);
    for (const dir of shimDirs(options.home ?? homedir())) {
      if (!pathDirs.includes(dir)) continue;
      if (settleShim(join(dir, ZCODE_BIN_NAME), body)) return;
    }
  } catch {
    // Unreachable host: the spawn fails and the adapter classifies `not_found`,
    // which is the same answer a machine without the app gets.
  }
}

/**
 * The shim body. It runs the bundle through the app's own Electron binary as
 * node because the CLI mis-handles its response path under a system node
 * (detached ArrayBuffer on node 24 x64), and it `exec`s so no wrapper process
 * outlives it.
 *
 * @param {{electron: string, cli: string}} bundle
 * @returns {string}
 */
function zcodeShim(bundle) {
  return `#!/usr/bin/env bash
set -euo pipefail
# Written by the intent-factory zcode driver; the ZCode app owns both paths.
ELECTRON_RUN_AS_NODE=1 exec ${bundle.electron} \\
  ${bundle.cli} "$@"
`;
}

/**
 * Install dirs, in preference order. `~/.local/bin` is the convention this
 * machine already uses for provider CLIs, `~/bin` is the older habit, and
 * `/usr/local/bin` is the last resort — all three are only eligible while they
 * are on PATH (see the caller).
 *
 * @param {string} home
 * @returns {string[]}
 */
function shimDirs(home) {
  return [join(home, ".local", "bin"), join(home, "bin"), "/usr/local/bin"];
}

/**
 * @param {string[]} pathDirs
 * @param {string} name
 * @returns {boolean} whether `name` is a runnable command on this PATH.
 */
function resolvesOnPath(pathDirs, name) {
  return pathDirs.some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Write the shim into `target`, or decide it is already settled. Returns false
 * only to let the caller try the next install dir.
 *
 * The symlink refusal is the important one: writing a path that is a symlink
 * writes through it, onto whatever it points at — and on a machine where the
 * user already hand-installed `zcode -> zcode-shim`, that would be their file.
 *
 * @param {string} target
 * @param {string} body
 * @returns {boolean}
 */
function settleShim(target, body) {
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) return true;
  if (existing?.isFile() && readFileSync(target, "utf8") === body) return true;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, body);
    // A created file's mode is masked by umask, and the shim has to be runnable.
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

export const driver = zcodeDriver;
export default zcodeDriver;
