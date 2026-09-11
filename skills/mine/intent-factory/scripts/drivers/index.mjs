import { spawn } from "node:child_process";
import { claudeDriver } from "./claude.mjs";
import { codexDriver } from "./codex.mjs";
import { agyDriver } from "./agy.mjs";
import { glmDriver } from "./glm.mjs";
import { dshDriver } from "./dsh.mjs";
import { zcodeDriver } from "./zcode.mjs";
import { execJsonlDriver } from "./exec-jsonl.mjs";
import { replayDriver } from "./replay.mjs";

/** Current wire-contract version for runner protocol artifacts. */
export const PROTOCOL_SCHEMA_VERSION = 3;

/** Version of the runner protocol implementation. */
export const INTENT_FACTORY_VERSION = "0.3.0";

const DRIVERS = new Map([
  ["claude", claudeDriver],
  ["codex", codexDriver],
  ["agy", agyDriver],
  ["glm", glmDriver],
  ["dsh", dshDriver],
  ["zcode", zcodeDriver],
  ["exec-jsonl", execJsonlDriver],
  ["replay", replayDriver],
]);

const CAPABILITY_NAMES = new Set([
  "structuredOutput",
  "promptTransport",
  "sandbox",
  "permissions",
  "continuation",
  "tokenBudget",
  "costBudget",
  "usage",
  "cost",
  "toolPolicy",
  "streamsOutput",
]);

/** @typedef {"structuredOutput"|"promptTransport"|"sandbox"|"permissions"|"continuation"|"tokenBudget"|"costBudget"|"usage"|"cost"|"toolPolicy"|"streamsOutput"} CapabilityName */

/** @typedef {{structuredOutput: boolean, promptTransport: "stdin"|"argv", sandbox: boolean, permissions: boolean, continuation: boolean, tokenBudget: boolean, costBudget: boolean, usage: boolean, cost: boolean, toolPolicy: boolean, streamsOutput: boolean, maxArgvPromptBytes?: number}} DriverCapabilities */

/** @typedef {{structuredOutput?: boolean, promptTransport?: "stdin"|"argv", sandbox?: boolean, permissions?: boolean, continuation?: boolean, tokenBudget?: boolean, costBudget?: boolean, usage?: boolean, cost?: boolean, toolPolicy?: boolean, streamsOutput?: boolean}} CapabilityRequirements */

/** @typedef {{executable: string, args: string[], promptTransport: "stdin"|"argv", input: string|null, env?: Record<string, string|null>}} DriverCommand */

/** @typedef {DriverCommand & {driver: string, model: string, capabilities: DriverCapabilities}} ProviderCommand */

/**
 * Which runtime field controls command execution, which values execute, and
 * the value used when the contract omits that field. `null` means the driver
 * has no permission mode that can deny command execution.
 *
 * @typedef {{field: "permissionMode"|"sandbox", executingModes: string[], defaultMode: string}|null} PermissionExecutionPolicy
 */

/** @typedef {{status: "done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled", result: string|null, continuationId: string|null, usage: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}, costUsd: number|null, error: {code: string, message: string, resetAt?: string|null}|null, exhaustedUntil?: string|null, judgeCandidates?: number}} ProviderEnvelope */

/**
 * One declared runtime. `driver` names a registered adapter (`claude`,
 * `codex`, `agy`, `glm`, `dsh`, `zcode`, `exec-jsonl`, or `replay`); replay requires
 * `config["replay.recording"]` for commands, and dsh requires
 * `config.provider` for the harness route every attempt runs on.
 *
 * @typedef {{id?: string, driver: string, model: string, reasoning?: string, sandbox?: string, permissionMode?: string, config?: Record<string, unknown>, printTimeout?: string, tools?: string[], executable?: string, args?: string[], versionArgs?: string[], maxArgvPromptBytes?: number, requiredCapabilities?: CapabilityRequirements, tier?: number|string, vendor?: string}} DriverRuntime
 */

/**
 * Mechanical worker tool policy sent to the provider boundary:
 * `foregroundOnly` rejects background tool invocations and
 * `maxToolOutputBytes` bounds each tool result head-plus-tail. Claude-
 * compatible adapters enforce it through hook settings; an adapter that
 * cannot prove enforcement must never receive it.
 *
 * @typedef {{foregroundOnly: boolean, maxToolOutputBytes: number|null}} ToolPolicy
 */

/** @typedef {{schema?: object, schemaPath?: string, continuationId?: string|null, toolPolicy?: ToolPolicy}} CommandOptions */

/** @typedef {{preferStructured?: boolean, exitCode?: number|null, signal?: string|null, stderr?: string}} NormalizeOptions */

/**
 * One provider adapter: capabilities plus executable, version, command, and
 * result-normalization behavior.
 *
 * @typedef {{capabilities: DriverCapabilities, permissionExecution: PermissionExecutionPolicy, executable: (runtime: DriverRuntime) => string, versionArgs: (runtime: DriverRuntime) => string[], parseVersion: (stdout: string, stderr?: string) => string|null, command: (runtime: DriverRuntime, prompt: string, options: CommandOptions) => DriverCommand, normalize: (stdout: string, exitCode: number|null, signal: string|null, options?: NormalizeOptions) => ProviderEnvelope}} DriverAdapter
 */

/**
 * Result of a read-only runtime probe.
 *
 * @typedef {{id: string|null, driver: string, executable: string, model: string, version: string|null, capabilities: DriverCapabilities, requiredCapabilities: CapabilityRequirements, requiredCapabilitySets: CapabilityRequirements[], ok: boolean, detail: string|null, availability?: {available: boolean, exhaustedUntil: string|null, reason: string}, live?: boolean, liveStatus?: string, usage?: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}, costUsd?: number|null}} ProbeResult
 */

/** @typedef {{id?: string}} RuntimeIdentity */

/**
 * Every registered driver name, for callers that must account for the whole
 * registry. Declaration order only — callers that display drivers sort it
 * themselves.
 *
 * @returns {string[]}
 */
export function registeredDrivers() {
  return [...DRIVERS.keys()];
}

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
 * @param {{driver: string, permissionMode?: string, sandbox?: string}} runtime
 * @returns {{executes: boolean, field: "permissionMode"|"sandbox"|null, mode: string|null, executingModes: string[]}}
 */
export function resolvePermissionExecution(runtime) {
  const policy = getDriver(runtime.driver).permissionExecution;
  if (!policy) return { executes: true, field: null, mode: null, executingModes: [] };
  const mode = /** @type {string} */ (runtime[policy.field] ?? policy.defaultMode);
  return { executes: policy.executingModes.includes(mode), field: policy.field, mode, executingModes: policy.executingModes };
}

/**
 * The vendor a driver talks to when no provider configuration says
 * otherwise. `replay` and `exec-jsonl` stand in for whatever the recording or
 * the exec'd binary actually is, so neither gets a default here — a contract
 * using either must declare `vendor` outright.
 */
const DEFAULT_DRIVER_VENDORS = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  agy: "google",
  glm: "zhipu",
  zcode: "zhipu",
});

/**
 * Resolve one runtime's vendor identity: an explicit `vendor` wins outright,
 * then a provider-configuration override (the codex `model_provider` trap —
 * a codex runtime configured for deepseek is a deepseek vendor, not openai),
 * then the driver's own default. `null` means the caller must reject the
 * runtime: nothing here named a vendor for it.
 *
 * @param {{driver: string, vendor?: string, config?: Record<string, unknown>}} runtime
 * @returns {string|null}
 */
export function resolveVendor(runtime) {
  if (typeof runtime.vendor === "string" && runtime.vendor.length) return runtime.vendor;
  const provider = runtime.config?.model_provider;
  if (typeof provider === "string" && provider.length) return provider;
  return /** @type {Record<string, string>} */ (DEFAULT_DRIVER_VENDORS)[runtime.driver] ?? null;
}

/**
 * Build one provider invocation. Prompt transport is explicit in the result:
 * stdin adapters return `input`, while argv adapters append the prompt. An
 * optional `env` overlay is merged over the runner environment at spawn time;
 * a null value removes the ambient variable.
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
 * Normalize a provider envelope or recorded response into the availability
 * shape used by doctor and runtime assignment.
 *
 * @param {string|{driver: string}} runtimeOrDriver
 * @param {unknown} response
 * @param {number|null} [exitCode]
 * @param {string|null} [signal]
 * @returns {{available: boolean, exhaustedUntil: string|null, reason: string}}
 */
export function normalizeProviderAvailability(runtimeOrDriver, response, exitCode = 0, signal = null) {
  let envelope;
  try {
    envelope = response && typeof response === "object" && !Array.isArray(response) && typeof /** @type {Record<string, unknown>} */ (response).status === "string"
      ? /** @type {ProviderEnvelope} */ (response)
      : normalizeProviderResult(runtimeOrDriver, String(response ?? ""), exitCode, signal);
  } catch (error) {
    return { available: false, exhaustedUntil: null, reason: error instanceof Error ? error.message : "provider_unavailable" };
  }
  const error = envelope.error;
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const text = `${code} ${message}`;
  if (envelope.status === "done" || envelope.status === "no-op") return { available: true, exhaustedUntil: null, reason: "ready" };
  const classified = classifyAvailabilityText(text);
  // A hard balance stop (DeepSeek's 402 "Insufficient Balance") has no reset
  // instant to report, unlike quota_exhausted, so it must be classified before
  // that branch even though its text never matches the quota pattern.
  if (classified?.reason === "insufficient_balance") return classified;
  if (envelope.status === "exhausted" || classified?.reason === "quota_exhausted") {
    return { available: false, exhaustedUntil: resetTimestamp(envelope.exhaustedUntil ?? error?.resetAt ?? message), reason: code || "quota_exhausted" };
  }
  if (classified?.reason === "authentication_failed") return classified;
  return { available: false, exhaustedUntil: null, reason: code || "provider_unavailable" };
}

/**
 * Classify raw provider-produced text (a structured envelope's `error.code
 * error.message`, or a probe's raw stderr on a non-zero exit) into the same
 * insufficient-balance/quota/authentication reasons `normalizeProviderAvailability`
 * recognizes. Shared so a CLI-missing exit and a raw stderr balance/quota
 * message are classified by one set of patterns, never two drifting copies.
 *
 * @param {string} text
 * @returns {{available: false, exhaustedUntil: string|null, reason: string}|null} null when text names none of the known patterns
 */
function classifyAvailabilityText(text) {
  if (/insufficient balance/iu.test(text) || /\b402\b/u.test(text)) {
    return { available: false, exhaustedUntil: null, reason: "insufficient_balance" };
  }
  if (/quota|rate.?limit|usage limit|limit exhausted|1310/iu.test(text)) {
    return { available: false, exhaustedUntil: resetTimestamp(text), reason: "quota_exhausted" };
  }
  if (/auth|credential|unauthori[sz]ed|forbidden|invalid.*(?:key|token)|(?:api|access) key|login/iu.test(text)) {
    return { available: false, exhaustedUntil: null, reason: "authentication_failed" };
  }
  return null;
}

/** @param {unknown} value @returns {string|null} */
function resetTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const match = /reset(?:s| at| on)?\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?)/iu.exec(value);
  const input = match?.[1] ?? value;
  const normalized = input.includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/u.test(input) ? input : `${input.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
    if (!isCapabilityName(name)) throw new TypeError(`${label}.${name} is unknown`);
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
  return Object.keys(requirements).flatMap((name) => {
    if (!isCapabilityName(name)) return [];
    const required = requirements[name];
    return capabilities[name] === required
      ? []
      : [`${name}=${String(required)} (driver provides ${name}=${String(capabilities[name])})`];
  });
}

/** @param {string} name @returns {name is CapabilityName} */
function isCapabilityName(name) {
  return CAPABILITY_NAMES.has(name);
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
    availability: { available: false, exhaustedUntil: null, reason: "provider_unavailable" },
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
        availability: { available: false, exhaustedUntil: null, reason: error && typeof error === "object" && "code" in error && error.code === "ENOENT"
          || /(?:ENOENT|not found|no such file)/iu.test(error instanceof Error ? error.message : String(error)) ? "not_found" : "provider_unavailable" },
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
        availability: { available: false, exhaustedUntil: null, reason: "provider_unavailable" },
        detail: `${identity(null)} · ${[missingEnvironmentDetail, `no response within ${timeoutSec}s`].filter(Boolean).join(" · ")}`,
      });
    }, timeoutSec * 1_000);
    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finish({
        ...base,
        availability: { available: false, exhaustedUntil: null, reason: /(?:ENOENT|not found|no such file)/iu.test(message) ? "not_found" : "provider_unavailable" },
        detail: `${identity(null)} · ${[missingEnvironmentDetail, redactSecrets(message)].filter(Boolean).join(" · ")}`,
      });
    });
    child.once("close", (exitCode, signal) => {
      const version = driver.parseVersion(redactSecrets(stdout), redactSecrets(stderr));
      const withVersion = { ...base, version };
      if (signal || exitCode !== 0) {
        finish({
          ...withVersion,
          availability: classifyAvailabilityText(stderr) ?? { available: false, exhaustedUntil: null, reason: "provider_unavailable" },
          detail: `${identity(version)} · ${[missingEnvironmentDetail, lastLine(stderr) ?? `${executable} exited with code ${exitCode}`].filter(Boolean).join(" · ")}`,
        });
        return;
      }
      if (!version) {
        finish({
          ...withVersion,
          availability: { available: false, exhaustedUntil: null, reason: "provider_unavailable" },
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
        availability: problems.length === 0
          ? { available: true, exhaustedUntil: null, reason: "ready" }
          : { available: false, exhaustedUntil: null, reason: missingEnvironmentDetail ? "authentication_required" : "provider_unavailable" },
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
