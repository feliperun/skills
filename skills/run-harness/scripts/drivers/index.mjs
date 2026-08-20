import { spawn } from "node:child_process";
import { claudeDriver } from "./claude.mjs";
import { codexDriver } from "./codex.mjs";
import { agyDriver } from "./agy.mjs";
import { execJsonlDriver } from "./exec-jsonl.mjs";

/** Current wire-contract version for harness protocol artifacts. */
export const PROTOCOL_SCHEMA_VERSION = 1;

/** Version of the harness protocol implementation. */
export const HARNESS_VERSION = "0.1.0";

const DRIVERS = new Map([
  ["claude", claudeDriver],
  ["codex", codexDriver],
  ["agy", agyDriver],
  ["exec-jsonl", execJsonlDriver],
]);

const CAPABILITY_NAMES = new Set([
  "structuredOutput",
  "promptTransport",
  "sandbox",
  "permissions",
  "continuation",
  "usage",
]);

/** @typedef {{structuredOutput: boolean, promptTransport: "stdin"|"argv", sandbox: boolean, permissions: boolean, continuation: boolean, usage: boolean, maxArgvPromptBytes?: number}} DriverCapabilities */

/** @typedef {{structuredOutput?: boolean, promptTransport?: "stdin"|"argv", sandbox?: boolean, permissions?: boolean, continuation?: boolean, usage?: boolean}} CapabilityRequirements */

/** @typedef {{executable: string, args: string[], promptTransport: "stdin"|"argv", input: string|null}} DriverCommand */

/** @typedef {DriverCommand & {driver: string, model: string, capabilities: DriverCapabilities}} ProviderCommand */

/** @typedef {{status: "done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled", result: string|null, continuationId: string|null, usage: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}, costUsd: number|null, error: {code: string, message: string}|null}} ProviderEnvelope */

/** @typedef {{id?: string, driver: string, model: string, reasoning?: string, sandbox?: string, permissionMode?: string, config?: Record<string, unknown>, printTimeout?: string, executable?: string, args?: string[], versionArgs?: string[], maxArgvPromptBytes?: number, requiredCapabilities?: CapabilityRequirements}} DriverRuntime */

/** @typedef {{schema?: object, schemaPath?: string, continuationId?: string|null}} CommandOptions */

/** @typedef {{preferStructured?: boolean, exitCode?: number|null, signal?: string|null}} NormalizeOptions */

/**
 * One provider adapter: capabilities plus executable, version, command, and
 * result-normalization behavior.
 *
 * @typedef {{capabilities: DriverCapabilities, executable: (runtime: DriverRuntime) => string, versionArgs: (runtime: DriverRuntime) => string[], parseVersion: (stdout: string, stderr?: string) => string|null, command: (runtime: DriverRuntime, prompt: string, options: CommandOptions) => DriverCommand, normalize: (stdout: string, exitCode: number|null, signal: string|null, options?: NormalizeOptions) => ProviderEnvelope}} DriverAdapter
 */

/**
 * Result of a read-only runtime probe.
 *
 * @typedef {{id: string|null, driver: string, executable: string, model: string, version: string|null, capabilities: DriverCapabilities, requiredCapabilities: CapabilityRequirements, requiredCapabilitySets: CapabilityRequirements[], ok: boolean, detail: string|null}} ProbeResult
 */

/** @typedef {{id?: string}} RuntimeIdentity */

/**
 * @param {string} name
 * @returns {DriverAdapter}
 */
export function getDriver(name) {
  const driver = DRIVERS.get(name);
  if (!driver) throw new TypeError(`unknown driver: ${name}`);
  return driver;
}

/**
 * @param {{driver: string}} runtime
 * @returns {DriverCapabilities}
 */
export function driverCapabilities(runtime) {
  return { ...getDriver(runtime.driver).capabilities };
}

/**
 * Build one provider invocation. Prompt transport is explicit in the result:
 * stdin adapters return `input`, while argv adapters append the prompt.
 *
 * @param {DriverRuntime} runtime
 * @param {string} prompt
 * @param {CommandOptions} options
 * @returns {ProviderCommand}
 */
export function providerCommand(runtime, prompt, options = {}) {
  const driver = getDriver(runtime.driver);
  const command = driver.command(runtime, prompt, options);
  if (command.promptTransport === "argv") {
    const limit = runtime.maxArgvPromptBytes ?? driver.capabilities.maxArgvPromptBytes;
    if (typeof limit === "number" && Number.isFinite(limit) && Buffer.byteLength(prompt, "utf8") > limit) {
      const error = /** @type {Error & {code: string}} */ (new Error(`prompt exceeds argv limit of ${limit} bytes for ${runtime.driver}`));
      error.code = "prompt_too_large";
      throw error;
    }
  }
  return {
    ...command,
    driver: runtime.driver,
    model: runtime.model,
    capabilities: driverCapabilities(runtime),
  };
}

/**
 * @param {string|{driver: string}} runtimeOrDriver
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {NormalizeOptions} options
 * @returns {ProviderEnvelope}
 */
export function normalizeProviderResult(runtimeOrDriver, stdout, exitCode, signal, options = {}) {
  const runtime = typeof runtimeOrDriver === "string" ? { driver: runtimeOrDriver } : runtimeOrDriver;
  const driver = getDriver(runtime.driver);
  return driver.normalize(stdout, exitCode, signal, options);
}

/**
 * Validate a partial capability requirement against an adapter declaration.
 * The runtime JSON remains the authoritative source for requirement shape.
 *
 * @param {CapabilityRequirements|undefined} requirements
 * @param {string} label
 * @returns {CapabilityRequirements}
 */
export function validateCapabilityRequirements(requirements, label = "requiredCapabilities") {
  if (requirements === undefined) return {};
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const [name, value] of Object.entries(requirements)) {
    if (!CAPABILITY_NAMES.has(name)) throw new TypeError(`${label}.${name} is unknown`);
    if (name === "promptTransport") {
      if (value !== "stdin" && value !== "argv") throw new TypeError(`${label}.promptTransport is invalid`);
    } else if (typeof value !== "boolean") {
      throw new TypeError(`${label}.${name} must be boolean`);
    }
  }
  return { ...requirements };
}

/**
 * @param {DriverCapabilities} capabilities
 * @param {CapabilityRequirements} requirements
 * @returns {string[]}
 */
export function missingCapabilities(capabilities, requirements = {}) {
  const provided = new Map(Object.entries(capabilities));
  return Object.entries(requirements)
    .filter(([name, required]) => provided.get(name) !== required)
    .map(([name, required]) => `${name}=${String(required)} (driver provides ${String(provided.get(name))})`);
}

/** @param {DriverCapabilities} capabilities @param {CapabilityRequirements[]} requirementSets */
function missingCapabilitySets(capabilities, requirementSets) {
  return requirementSets.flatMap((requirements, index) =>
    missingCapabilities(capabilities, requirements).map((missing) => `requirement ${index + 1}: ${missing}`),
  );
}

/**
 * Probe an executable version without sending a prompt or exposing secrets.
 *
 * @param {DriverRuntime} runtime
 * @param {{cwd?: string, timeoutSec?: number, requiredCapabilities?: CapabilityRequirements, requiredCapabilitySets?: CapabilityRequirements[]}} options
 * @returns {Promise<ProbeResult>}
 */
export function probeRuntime(runtime, options = {}) {
  const driver = getDriver(runtime.driver);
  const executable = driver.executable(runtime);
  const requirementSets = (options.requiredCapabilitySets ?? [options.requiredCapabilities])
    .filter((requirements) => requirements !== undefined)
    .map((requirements, index) => validateCapabilityRequirements(requirements, `requiredCapabilitySets[${index}]`));
  const missingEnvironment = missingEnvironmentVariables(runtime);
  const base = {
    id: runtime.id ?? null,
    driver: runtime.driver,
    executable,
    model: runtime.model,
    version: null,
    capabilities: driverCapabilities(runtime),
    requiredCapabilities: requirementSets.length === 1 ? requirementSets[0] : {},
    requiredCapabilitySets: requirementSets,
    ok: false,
    detail: null,
  };
  const missing = missingCapabilitySets(base.capabilities, requirementSets);
  const args = driver.versionArgs(runtime);
  const timeoutSec = options.timeoutSec ?? 120;
  const identity = (/** @type {string|null} */ version) => `${runtime.driver} · ${executable} · ${runtime.model} · ${version ?? "version unavailable"}`;
  const missingEnvironmentDetail = missingEnvironment.length
    ? `missing environment variable ${missingEnvironment.join(", ")}`
    : null;
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({
        ...base,
        detail: `${identity(null)} · ${[missingEnvironmentDetail, redactSecrets(error instanceof Error ? error.message : String(error))].filter(Boolean).join(" · ")}`,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @param {ProbeResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settle(result);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ...base,
        detail: `${identity(null)} · ${[missingEnvironmentDetail, `no response within ${timeoutSec}s`].filter(Boolean).join(" · ")}`,
      });
    }, timeoutSec * 1_000);
    child.once("error", (error) => finish({
      ...base,
      detail: `${identity(null)} · ${[missingEnvironmentDetail, redactSecrets(error instanceof Error ? error.message : String(error))].filter(Boolean).join(" · ")}`,
    }));
    child.once("close", (exitCode, signal) => {
      const version = driver.parseVersion(redactSecrets(stdout), redactSecrets(stderr));
      const withVersion = { ...base, version };
      if (signal || exitCode !== 0) {
        finish({
          ...withVersion,
          detail: `${identity(version)} · ${[missingEnvironmentDetail, lastLine(stderr) ?? `${executable} exited with code ${exitCode}`].filter(Boolean).join(" · ")}`,
        });
        return;
      }
      if (!version) {
        finish({
          ...withVersion,
          detail: `${identity(null)} · ${[missingEnvironmentDetail, "unable to determine version"].filter(Boolean).join(" · ")}`,
        });
        return;
      }
      const problems = [];
      if (missingEnvironmentDetail) problems.push(missingEnvironmentDetail);
      if (missing.length) problems.push(`missing capabilities: ${missing.join(", ")}`);
      finish({
        ...withVersion,
        ok: problems.length === 0,
        detail: `${identity(version)}${problems.length ? ` · ${problems.join(" · ")}` : ""}`,
      });
    });
  });
}

/**
 * @param {DriverRuntime} runtime
 * @returns {string[]}
 */
function missingEnvironmentVariables(runtime) {
  /** @type {string[]} */
  const names = [];
  for (const [key, value] of Object.entries(runtime.config ?? {})) {
    if (!key.endsWith(".env_key")) continue;
    if (typeof value === "string" && value.length > 0 && !process.env[value]) names.push(value);
  }
  return [...new Set(names)];
}

/**
 * @param {string} text
 * @returns {string|null}
 */
function lastLine(text) {
  return redactSecrets(text.trim().split(/\r?\n/u).at(-1) || "") || null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  let result = text;
  for (const value of Object.values(process.env)) {
    if (typeof value === "string" && value.length >= 4) result = result.split(value).join("[REDACTED]");
  }
  return result;
}
