import { spawn } from "node:child_process";
import { claudeHarness } from "./claude/index.mjs";
import { codexHarness } from "./codex/index.mjs";
import { agyHarness } from "./agy/index.mjs";
import { dshHarness } from "./dsh/index.mjs";
import { zcodeHarness } from "./zcode/index.mjs";
import { execJsonlHarness } from "./exec-jsonl/index.mjs";
import { replayHarness } from "./replay/index.mjs";

/** Current wire-contract version for runner protocol artifacts. */
export const PROTOCOL_SCHEMA_VERSION = 3;

/** Version of the runner protocol implementation. */
export const INTENT_FACTORY_VERSION = "0.3.0";

const HARNESSES = new Map([
  ["claude", claudeHarness],
  ["codex", codexHarness],
  ["agy", agyHarness],
  ["dsh", dshHarness],
  ["zcode", zcodeHarness],
  ["exec-jsonl", execJsonlHarness],
  ["replay", replayHarness],
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

/** @typedef {{structuredOutput: boolean, promptTransport: "stdin"|"argv", sandbox: boolean, permissions: boolean, continuation: boolean, tokenBudget: boolean, costBudget: boolean, usage: boolean, cost: boolean, toolPolicy: boolean, streamsOutput: boolean, maxArgvPromptBytes?: number}} HarnessCapabilities */

/** @typedef {{structuredOutput?: boolean, promptTransport?: "stdin"|"argv", sandbox?: boolean, permissions?: boolean, continuation?: boolean, tokenBudget?: boolean, costBudget?: boolean, usage?: boolean, cost?: boolean, toolPolicy?: boolean, streamsOutput?: boolean}} CapabilityRequirements */

/** @typedef {{executable: string, args: string[], promptTransport: "stdin"|"argv", input: string|null, env?: Record<string, string|null>}} HarnessCommand */

/** @typedef {HarnessCommand & {harness: string, model: string, capabilities: HarnessCapabilities}} ProviderCommand */

/**
 * Which runtime field controls command execution, which values execute, and
 * the value used when the contract omits that field. `null` means the harness
 * has no permission mode that can deny command execution.
 *
 * @typedef {{field: "permissionMode"|"sandbox", executingModes: string[], defaultMode: string}|null} PermissionExecutionPolicy
 */

/** @typedef {{status: "done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled", result: string|null, continuationId: string|null, usage: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}, costUsd: number|null, error: {code: string, message: string, resetAt?: string|null}|null, exhaustedUntil?: string|null, judgeCandidates?: number}} ProviderEnvelope */

/**
 * One declared runtime. `harness` names a registered adapter (`claude`,
 * `codex`, `agy`, `dsh`, `zcode`, `exec-jsonl`, or `replay`) and `model` names
 * what that harness asks; the two are independent. replay requires
 * `config["replay.recording"]` for commands, and dsh requires
 * `config.provider` for the provider route every attempt runs on.
 *
 * @typedef {{id?: string, harness: string, model: string, reasoning?: string, sandbox?: string, permissionMode?: string, config?: Record<string, unknown>, printTimeout?: string, tools?: string[], executable?: string, args?: string[], versionArgs?: string[], maxArgvPromptBytes?: number, requiredCapabilities?: CapabilityRequirements, tier?: number|string, vendor?: string}} HarnessRuntime
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
 * @typedef {{capabilities: HarnessCapabilities, permissionExecution: PermissionExecutionPolicy, executable: (runtime: HarnessRuntime) => string, versionArgs: (runtime: HarnessRuntime) => string[], parseVersion: (stdout: string, stderr?: string) => string|null, command: (runtime: HarnessRuntime, prompt: string, options: CommandOptions) => HarnessCommand, normalize: (stdout: string, exitCode: number|null, signal: string|null, options?: NormalizeOptions) => ProviderEnvelope}} HarnessAdapter
 */

/**
 * Result of a read-only runtime probe.
 *
 * @typedef {{id: string|null, harness: string, executable: string, model: string, version: string|null, capabilities: HarnessCapabilities, requiredCapabilities: CapabilityRequirements, requiredCapabilitySets: CapabilityRequirements[], ok: boolean, detail: string|null, availability?: {available: boolean, exhaustedUntil: string|null, reason: string}, live?: boolean, liveStatus?: string, usage?: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}, costUsd?: number|null}} ProbeResult
 */

/** @typedef {{id?: string}} RuntimeIdentity */

/**
 * Every registered harness name, for callers that must account for the whole
 * registry. Declaration order only — callers that display harnesses sort it
 * themselves.
 *
 * @returns {string[]}
 */
export function registeredHarnesses() {
  return [...HARNESSES.keys()];
}

/**
 * @param {string} name
 * @returns {HarnessAdapter}
 */
export function getHarness(name) {
  const harness = HARNESSES.get(name);
  if (!harness) throw new TypeError(`unknown harness: ${name}`);
  return harness;
}

/**
 * @param {{harness: string}} runtime
 * @returns {HarnessCapabilities}
 */
export function harnessCapabilities(runtime) {
  return { ...getHarness(runtime.harness).capabilities };
}

/**
 * @param {{harness: string, permissionMode?: string, sandbox?: string}} runtime
 * @returns {{executes: boolean, field: "permissionMode"|"sandbox"|null, mode: string|null, executingModes: string[]}}
 */
export function resolvePermissionExecution(runtime) {
  const policy = getHarness(runtime.harness).permissionExecution;
  if (!policy) return { executes: true, field: null, mode: null, executingModes: [] };
  const mode = /** @type {string} */ (runtime[policy.field] ?? policy.defaultMode);
  return { executes: policy.executingModes.includes(mode), field: policy.field, mode, executingModes: policy.executingModes };
}

/**
 * The vendor a harness talks to when no provider configuration says
 * otherwise. `replay` and `exec-jsonl` stand in for whatever the recording or
 * the exec'd binary actually is, so neither gets a default here — a contract
 * using either must declare `vendor` outright.
 */
const DEFAULT_HARNESS_VENDORS = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  agy: "google",
  zcode: "zhipu",
});

/**
 * Resolve one runtime's vendor identity: an explicit `vendor` wins outright,
 * then a provider-configuration override (the codex `model_provider` trap —
 * a codex runtime configured for deepseek is a deepseek vendor, not openai),
 * then the harness's own default. `null` means the caller must reject the
 * runtime: nothing here named a vendor for it.
 *
 * @param {{harness: string, vendor?: string, config?: Record<string, unknown>}} runtime
 * @returns {string|null}
 */
export function resolveVendor(runtime) {
  if (typeof runtime.vendor === "string" && runtime.vendor.length) return runtime.vendor;
  const provider = runtime.config?.model_provider;
  if (typeof provider === "string" && provider.length) return provider;
  return /** @type {Record<string, string>} */ (DEFAULT_HARNESS_VENDORS)[runtime.harness] ?? null;
}

/**
 * Build one provider invocation. Prompt transport is explicit in the result:
 * stdin adapters return `input`, while argv adapters append the prompt. An
 * optional `env` overlay is merged over the runner environment at spawn time;
 * a null value removes the ambient variable.
 *
 * @param {HarnessRuntime} runtime
 * @param {string} prompt
 * @param {CommandOptions} options
 * @returns {ProviderCommand}
 */
export function providerCommand(runtime, prompt, options = {}) {
  const harness = getHarness(runtime.harness);
  const command = harness.command(runtime, prompt, options);
  if (command.promptTransport === "argv") {
    const limit = runtime.maxArgvPromptBytes ?? harness.capabilities.maxArgvPromptBytes;
    if (typeof limit === "number" && Number.isFinite(limit) && Buffer.byteLength(prompt, "utf8") > limit) {
      const error = /** @type {Error & {code: string}} */ (new Error(`prompt exceeds argv limit of ${limit} bytes for ${runtime.harness}`));
      error.code = "prompt_too_large";
      throw error;
    }
  }
  return {
    ...command,
    harness: runtime.harness,
    model: runtime.model,
    capabilities: harnessCapabilities(runtime),
  };
}

/**
 * @param {string|{harness: string}} runtimeOrHarness
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {NormalizeOptions} options
 * @returns {ProviderEnvelope}
 */
export function normalizeProviderResult(runtimeOrHarness, stdout, exitCode, signal, options = {}) {
  const runtime = typeof runtimeOrHarness === "string" ? { harness: runtimeOrHarness } : runtimeOrHarness;
  const harness = getHarness(runtime.harness);
  return harness.normalize(stdout, exitCode, signal, options);
}

/**
 * Normalize a provider envelope or recorded response into the availability
 * shape used by doctor and runtime assignment.
 *
 * @param {string|{harness: string}} runtimeOrHarness
 * @param {unknown} response
 * @param {number|null} [exitCode]
 * @param {string|null} [signal]
 * @returns {{available: boolean, exhaustedUntil: string|null, reason: string}}
 */
export function normalizeProviderAvailability(runtimeOrHarness, response, exitCode = 0, signal = null) {
  let envelope;
  try {
    envelope = response && typeof response === "object" && !Array.isArray(response) && typeof /** @type {Record<string, unknown>} */ (response).status === "string"
      ? /** @type {ProviderEnvelope} */ (response)
      : normalizeProviderResult(runtimeOrHarness, String(response ?? ""), exitCode, signal);
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
    return { available: false, exhaustedUntil: exhaustedUntilOf(envelope), reason: code || "quota_exhausted" };
  }
  if (classified?.reason === "authentication_failed") return classified;
  return { available: false, exhaustedUntil: null, reason: code || "provider_unavailable" };
}

/**
 * The absolute instant an exhaustion envelope announces, taken from whichever
 * field carries it: the envelope's own `exhaustedUntil`, the error's `resetAt`,
 * or a reset sentence inside the error message. `null` means the provider named
 * no reset, which is the controller's signal to take the failover edge instead
 * of waiting on the same runtime.
 *
 * @param {unknown} envelope
 * @returns {string|null}
 */
export function exhaustedUntilOf(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const record = /** @type {Record<string, unknown>} */ (envelope);
  const error = record.error && typeof record.error === "object"
    ? /** @type {Record<string, unknown>} */ (record.error)
    : null;
  return resetTimestamp(record.exhaustedUntil ?? error?.resetAt ?? (typeof error?.message === "string" ? error.message : null));
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
 * @param {HarnessCapabilities} capabilities
 * @param {CapabilityRequirements} requirements
 * @returns {string[]}
 */
export function missingCapabilities(capabilities, requirements = {}) {
  return Object.keys(requirements).flatMap((name) => {
    if (!isCapabilityName(name)) return [];
    const required = requirements[name];
    return capabilities[name] === required
      ? []
      : [`${name}=${String(required)} (harness provides ${name}=${String(capabilities[name])})`];
  });
}

/** @param {string} name @returns {name is CapabilityName} */
function isCapabilityName(name) {
  return CAPABILITY_NAMES.has(name);
}

/** @param {HarnessCapabilities} capabilities @param {CapabilityRequirements[]} requirementSets */
function missingCapabilitySets(capabilities, requirementSets) {
  return requirementSets.flatMap((requirements, index) =>
    missingCapabilities(capabilities, requirements).map((missing) => `requirement ${index + 1}: ${missing}`),
  );
}

/**
 * Probe an executable version without sending a prompt or exposing secrets.
 *
 * @param {HarnessRuntime} runtime
 * @param {{cwd?: string, timeoutSec?: number, requiredCapabilities?: CapabilityRequirements, requiredCapabilitySets?: CapabilityRequirements[]}} options
 * @returns {Promise<ProbeResult>}
 */
export function probeRuntime(runtime, options = {}) {
  const harness = getHarness(runtime.harness);
  const executable = harness.executable(runtime);
  const requirementSets = (options.requiredCapabilitySets ?? [options.requiredCapabilities])
    .filter((requirements) => requirements !== undefined)
    .map((requirements, index) => validateCapabilityRequirements(requirements, `requiredCapabilitySets[${index}]`));
  const missingEnvironment = missingEnvironmentVariables(runtime);
  const base = {
    id: runtime.id ?? null,
    harness: runtime.harness,
    executable,
    model: runtime.model,
    version: null,
    capabilities: harnessCapabilities(runtime),
    requiredCapabilities: requirementSets.length === 1 ? requirementSets[0] : {},
    requiredCapabilitySets: requirementSets,
    ok: false,
    detail: null,
    availability: { available: false, exhaustedUntil: null, reason: "provider_unavailable" },
  };
  const missing = missingCapabilitySets(base.capabilities, requirementSets);
  const args = harness.versionArgs(runtime);
  const timeoutSec = options.timeoutSec ?? 120;
  const identity = (/** @type {string|null} */ version) => `${runtime.harness} · ${executable} · ${runtime.model} · ${version ?? "version unavailable"}`;
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
      const version = harness.parseVersion(redactSecrets(stdout), redactSecrets(stderr));
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
 * @param {HarnessRuntime} runtime
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
