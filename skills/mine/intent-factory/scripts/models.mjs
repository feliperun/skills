import { spawnSync } from "node:child_process";
import { getDriver, probeRuntime, registeredDrivers, resolveVendor } from "./drivers/index.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS, composeAssignments } from "./runtime-discovery.mjs";

/**
 * Model catalogue report: which models each registered driver can run, the
 * effort levels each accepts, and the worker/judge allocation the discovery
 * law already implies.
 *
 * Only `agy` exposes a catalogue of its own — `agy models`, measured
 * 2026-09-11: one `id<TAB>display name` line per model on stdout, a progress
 * line on stderr, exit 0, no flags — so the report runs it when that binary is
 * present and falls back to the declared entries when it is not. Every other
 * driver's catalogue is declared below. No catalogue here is fetched from a
 * network service of our own: `agy models` is the provider CLI's own surface,
 * and no invocation spends tokens.
 *
 * Determinism: driver order is the canonical constant below, never object or
 * Map iteration order (the registry decides membership only); declared model
 * arrays are canonical; `agy models` output is sorted by id before rendering.
 * No clock and no locale reaches the default report; `--probe` is the one
 * opt-in that reads the host.
 */

/** Display order of the registered drivers: claude, codex, agy, glm, dsh, zcode, exec-jsonl, replay. */
export const MODEL_DRIVER_ORDER = Object.freeze([
  "claude",
  "codex",
  "agy",
  "glm",
  "dsh",
  "zcode",
  "exec-jsonl",
  "replay",
]);

const CLAUDE_EFFORTS = Object.freeze(["low", "medium", "high", "max"]);
const CODEX_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
const GLM_EFFORTS = Object.freeze(["low", "medium", "high"]);
const AGY_EFFORTS = Object.freeze(["low", "medium", "high"]);
/** agy.mjs collapses both of these onto `high` before `--effort` is built. */
const AGY_EFFORT_ALIASES = Object.freeze({ max: "high", xhigh: "high" });
const DSH_EFFORTS = Object.freeze(["off", "low", "high", "max"]);
/** @type {readonly string[]} */
const NO_EFFORTS = Object.freeze([]);

/** Measured: the harness accepts off/low/high/max and defaults to high; 1M tokens is its default window. */
const DSH_CONTEXT_WINDOW_TOKENS = 1_000_000;
/** glm.mjs pairs the [1m] model tier with a 1,048,576-token compaction window and everything else with 200,000. */
const GLM_CONTEXT_WINDOW_TOKENS = 200_000;
const GLM_ONE_MILLION_CONTEXT_WINDOW_TOKENS = 1_048_576;

/**
 * @typedef {{id: string, contextWindowTokens: number|null, efforts: readonly string[], defaultEffort: string|null, effortInModelId: string|null}} DeclaredModel
 * @typedef {{driver: string, vendor: string|null}} ModelPath
 * @typedef {{id: string, contextWindowTokens: number|null, efforts: string[], defaultEffort: string|null, effortInModelId: string|null, declaredBy: ModelPath[]}} ModelView
 * @typedef {{ok: boolean, available: boolean, reason: string, version: string|null}} ProbeView
 * @typedef {{driver: string, executable: string, vendor: string|null, vendorNote: string|null, catalogue: string, effortTransport: string|null, effortAliases: Record<string, string>, effortNotes: string[], models: ModelView[], probe?: ProbeView}} DriverView
 * @typedef {{id: string, driver: string, model: string, vendor: string, tier: number|string|null, costRank: number|null}} AllocationRuntime
 * @typedef {{worker: AllocationRuntime, judge: AllocationRuntime, vendorException: string|null, reason: string}} AllocationSuggestion
 * @typedef {{schemaVersion: number, availability: string, drivers: DriverView[], suggestion: AllocationSuggestion}} ModelsReport
 */

/**
 * Repository-declared catalogues. `exec-jsonl` and `replay` stand in for an
 * arbitrary executable and a recording, so both name no models at all: the
 * runtime declaration supplies the model id.
 *
 * @type {Readonly<Record<string, readonly DeclaredModel[]>>}
 */
export const DECLARED_MODEL_CATALOGUES = Object.freeze({
  claude: Object.freeze([
    declaredModel("claude-sonnet-5", { efforts: CLAUDE_EFFORTS }),
    declaredModel("claude-opus-5", { efforts: CLAUDE_EFFORTS }),
    declaredModel("claude-sonnet-4-6", { efforts: CLAUDE_EFFORTS }),
  ]),
  codex: Object.freeze([
    declaredModel("gpt-5.6", { efforts: CODEX_EFFORTS }),
    declaredModel("gpt-5.6-luna", { efforts: CODEX_EFFORTS }),
    declaredModel("gpt-5.6-sol", { efforts: CODEX_EFFORTS }),
  ]),
  agy: Object.freeze([
    agyModel("gemini-3.8-flash-high"),
    agyModel("gemini-3.8-flash-medium"),
    agyModel("gemini-3.8-flash-low"),
    agyModel("claude-sonnet-4-6"),
    agyModel("claude-opus-4-6-thinking"),
    agyModel("gpt-oss-120b-medium"),
  ]),
  glm: Object.freeze([
    declaredModel("glm-5.3-flash", { contextWindowTokens: GLM_CONTEXT_WINDOW_TOKENS, efforts: GLM_EFFORTS }),
    declaredModel("glm-5.3", { contextWindowTokens: GLM_CONTEXT_WINDOW_TOKENS, efforts: GLM_EFFORTS }),
    declaredModel("glm-5.3[1m]", { contextWindowTokens: GLM_ONE_MILLION_CONTEXT_WINDOW_TOKENS, efforts: GLM_EFFORTS }),
  ]),
  dsh: Object.freeze([
    declaredModel("deepseek-flash", { contextWindowTokens: DSH_CONTEXT_WINDOW_TOKENS, efforts: DSH_EFFORTS, defaultEffort: "high" }),
    declaredModel("deepseek-v4-flash", { contextWindowTokens: DSH_CONTEXT_WINDOW_TOKENS, efforts: DSH_EFFORTS, defaultEffort: "high" }),
    declaredModel("deepseek-v4-pro", { contextWindowTokens: DSH_CONTEXT_WINDOW_TOKENS, efforts: DSH_EFFORTS, defaultEffort: "high" }),
    declaredModel("deepseek-v4-flash-vision-exp", { contextWindowTokens: DSH_CONTEXT_WINDOW_TOKENS, efforts: DSH_EFFORTS, defaultEffort: "high" }),
  ]),
  zcode: Object.freeze([
    declaredModel("glm-5.3-flash", { contextWindowTokens: GLM_CONTEXT_WINDOW_TOKENS, efforts: NO_EFFORTS }),
    declaredModel("glm-5.3", { contextWindowTokens: GLM_CONTEXT_WINDOW_TOKENS, efforts: NO_EFFORTS }),
    declaredModel("glm-5.3[1m]", { contextWindowTokens: GLM_ONE_MILLION_CONTEXT_WINDOW_TOKENS, efforts: NO_EFFORTS }),
  ]),
  "exec-jsonl": Object.freeze([]),
  replay: Object.freeze([]),
});

/** @type {Readonly<Record<string, string>>} */
const CATALOGUE_SOURCES = Object.freeze({
  claude: "declared",
  codex: "declared",
  glm: "declared",
  dsh: "declared",
  zcode: "declared",
  "exec-jsonl": "runtime-declared",
  replay: "runtime-declared",
});

/**
 * The field each adapter turns `runtime.reasoning` into.
 *
 * @type {Readonly<Record<string, string|null>>}
 */
const EFFORT_TRANSPORT = Object.freeze({
  claude: "--effort",
  codex: "config.model_reasoning_effort",
  agy: "--effort",
  glm: "--effort",
  dsh: "--reasoning (harness reasoningEffort)",
  zcode: null,
  "exec-jsonl": null,
  replay: null,
});

/**
 * Why a driver resolves no vendor: dsh, exec-jsonl, and replay have no driver default.
 *
 * @type {Readonly<Record<string, string>>}
 */
const VENDOR_NOTES = Object.freeze({
  dsh: "unresolved: dsh declares no driver default; the contract names the vendor",
  "exec-jsonl": "unresolved: exec-jsonl declares no driver default; the contract names the vendor",
  replay: "unresolved: replay declares no driver default; the contract names the vendor",
});

const AGY_CATALOGUE_TIMEOUT_MS = 10_000;

const AVAILABILITY_NOTES = Object.freeze({
  declared: "declared catalogue only; live availability is `doctor`'s report (`--probe` adds per-runtime reachability)",
  probe: "probed per runtime (executable reachability only); `doctor` remains authoritative",
});

const ALLOCATION_LAW = "cheapest declared runtime by tier then costRank executes; the strongest runtime with a different resolved vendor judges";

/**
 * @param {string} id
 * @param {{contextWindowTokens?: number, efforts: readonly string[], defaultEffort?: string, effortInModelId?: string}} options
 * @returns {DeclaredModel}
 */
function declaredModel(id, options) {
  return Object.freeze({
    id,
    contextWindowTokens: options.contextWindowTokens ?? null,
    efforts: options.efforts,
    defaultEffort: options.defaultEffort ?? null,
    effortInModelId: options.effortInModelId ?? null,
  });
}

/**
 * An agy model: the adapter's `--effort` vocabulary applies to every id, and
 * an id ending in -low/-medium/-high fixes that level itself, which is the
 * double specification the report has to show.
 *
 * @param {string} id
 * @param {number|null} [contextWindowTokens]
 * @returns {DeclaredModel}
 */
function agyModel(id, contextWindowTokens = null) {
  const encoded = /-(low|medium|high)$/u.exec(id)?.[1] ?? null;
  return Object.freeze({
    id,
    contextWindowTokens,
    efforts: AGY_EFFORTS,
    defaultEffort: encoded,
    effortInModelId: encoded,
  });
}

/**
 * @param {{probe?: boolean, cwd?: string}} [options]
 * @returns {Promise<ModelsReport>}
 */
export async function modelsReport(options = {}) {
  const cliCatalogue = agyCliCatalogue(options.cwd);
  const declaredPaths = declaredPathIndex();
  /** @type {DriverView[]} */
  const drivers = [];
  for (const driver of displayOrder()) {
    const declared = DECLARED_MODEL_CATALOGUES[driver] ?? [];
    const entries = driver === "agy" ? cliCatalogue ?? declared : declared;
    const template = { driver, model: entries[0]?.id ?? "runtime-defined" };
    /** @type {DriverView} */
    const view = {
      driver,
      executable: getDriver(driver).executable(template),
      vendor: resolveVendor(template),
      vendorNote: VENDOR_NOTES[driver] ?? null,
      catalogue: driver === "agy" ? (cliCatalogue ? "agy-cli" : "declared") : CATALOGUE_SOURCES[driver] ?? "runtime-declared",
      effortTransport: EFFORT_TRANSPORT[driver] ?? null,
      effortAliases: driver === "agy" ? { ...AGY_EFFORT_ALIASES } : {},
      effortNotes: driver === "agy"
        ? ["model ids ending in -low/-medium/-high fix the level themselves, and the adapter still passes --effort on top (double specification)"]
        : [],
      models: entries.map((entry) => modelView(driver, entry, declaredPaths)),
    };
    if (options.probe === true) view.probe = probeView(await probeRuntime(template, { cwd: options.cwd }));
    drivers.push(view);
  }
  return {
    schemaVersion: 1,
    availability: AVAILABILITY_NOTES[options.probe === true ? "probe" : "declared"],
    drivers,
    suggestion: suggestedAllocation(),
  };
}

/**
 * @param {{json?: boolean, probe?: boolean, cwd?: string}} [options]
 * @returns {Promise<void>}
 */
export async function modelsCommand(options = {}) {
  const report = await modelsReport(options);
  process.stdout.write(options.json === true ? stableJson(report) : renderModelsReport(report));
}

/**
 * @param {string} driver
 * @param {DeclaredModel} entry
 * @param {Map<string, ModelPath[]>} declaredPaths
 * @returns {ModelView}
 */
function modelView(driver, entry, declaredPaths) {
  return {
    id: entry.id,
    contextWindowTokens: entry.contextWindowTokens,
    efforts: [...entry.efforts],
    defaultEffort: entry.defaultEffort,
    effortInModelId: entry.effortInModelId,
    declaredBy: (declaredPaths.get(entry.id) ?? []).filter((path) => path.driver !== driver),
  };
}

/**
 * Every declared model id, with the drivers that declare it and the vendor
 * each of those paths resolves to. Two paths can serve one model under
 * different resolved vendors (agy resells claude-sonnet-4-6, which the claude
 * driver also declares), and the allocation law compares those vendors.
 *
 * @returns {Map<string, ModelPath[]>}
 */
function declaredPathIndex() {
  /** @type {Map<string, ModelPath[]>} */
  const paths = new Map();
  for (const driver of displayOrder()) {
    const vendor = resolveVendor({ driver });
    for (const entry of DECLARED_MODEL_CATALOGUES[driver] ?? []) {
      const existing = paths.get(entry.id);
      if (existing) existing.push({ driver, vendor });
      else paths.set(entry.id, [{ driver, vendor }]);
    }
  }
  return paths;
}

/**
 * Registered drivers in canonical display order. The registry supplies
 * membership; a registered driver missing from the canonical constant is
 * appended in codepoint order so the report still covers every adapter.
 *
 * @returns {string[]}
 */
function displayOrder() {
  const registered = new Set(registeredDrivers());
  const extra = [...registered].filter((driver) => !MODEL_DRIVER_ORDER.includes(driver)).sort(codepointOrder);
  return [...MODEL_DRIVER_ORDER.filter((driver) => registered.has(driver)), ...extra];
}

/**
 * The provider CLI's own catalogue. An absent binary, a non-zero exit, or an
 * unparsable listing falls back to the declared entries.
 *
 * @param {string|undefined} cwd
 * @returns {DeclaredModel[]|null}
 */
function agyCliCatalogue(cwd) {
  const executable = getDriver("agy").executable({ driver: "agy", model: "agy-models" });
  const result = spawnSync(executable, ["models"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: AGY_CATALOGUE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  const models = parseAgyModels(String(result.stdout ?? ""));
  return models.length ? models : null;
}

/**
 * `agy models` prints one model per line as `id<TAB>display name`; the
 * progress line and anything else without a plausible id is ignored, and the
 * surviving ids are sorted so the CLI's own listing order never reaches the
 * report.
 *
 * @param {string} stdout
 * @returns {DeclaredModel[]}
 */
export function parseAgyModels(stdout) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const line of String(stdout).replace(/\[[0-9;]*m/gu, "").split(/\r?\n/u)) {
    const candidate = line.split("\t")[0].trim();
    if (!/^[a-z0-9][a-z0-9._[\]-]*$/iu.test(candidate)) continue;
    ids.add(candidate);
  }
  return [...ids].sort(codepointOrder).map((id) => agyModel(id));
}

/**
 * @param {import("./drivers/index.mjs").ProbeResult} result
 * @returns {ProbeView}
 */
function probeView(result) {
  return {
    ok: result.ok,
    available: result.availability?.available === true,
    reason: result.availability?.reason ?? "provider_unavailable",
    version: result.version,
  };
}

/**
 * The same law `validatedContract` applies when a contract omits `runtimes`:
 * `contract.mjs` feeds `DISCOVERY_RUNTIME_DEFINITIONS` to `composeAssignments`
 * in its declared order, so the same object and the same function are reused
 * here with every runtime declared available. No availability probe feeds the
 * suggestion — live reachability stays `doctor`'s and `--probe`'s business.
 *
 * @returns {AllocationSuggestion}
 */
function suggestedAllocation() {
  /** @type {Record<string, {driver: string, model: string, vendor: string, tier: number|string, costRank: number}>} */
  const runtimes = {};
  /** @type {Record<string, {available: boolean, exhaustedUntil: string|null, reason: string}>} */
  const availability = {};
  for (const [id, definition] of Object.entries(DISCOVERY_RUNTIME_DEFINITIONS)) {
    const vendor = resolveVendor(definition);
    if (!vendor) throw new Error(`discovery runtime ${id} resolves no vendor`);
    runtimes[id] = { ...definition, vendor };
    availability[id] = { available: true, exhaustedUntil: null, reason: "declared" };
  }
  /** @param {boolean} enabled */
  const node = (enabled) => ({ id: "models", gate: { enabled } });
  try {
    const assignment = composeAssignments({ runtimes, runtimeDefaults: {}, nodes: [node(true)] }, availability).models;
    return allocation(assignment.worker, assignment.judge, null, ALLOCATION_LAW, runtimes);
  } catch (error) {
    // No cross-vendor judge is admissible among the declared discovery
    // runtimes: name the runtime the same law still picks for both roles, and
    // say out loud that the pair is a declared same-vendor exception.
    const assignment = composeAssignments({ runtimes, runtimeDefaults: {}, nodes: [node(false)] }, availability).models;
    const vendor = runtimes[assignment.worker]?.vendor ?? "unresolved";
    return allocation(
      assignment.worker,
      assignment.judge,
      vendor,
      `declared exception (${errorMessage(error)}): the worker runtime also judges`,
      runtimes,
    );
  }
}

/**
 * @param {string} worker
 * @param {string} judge
 * @param {string|null} vendorException
 * @param {string} reason
 * @param {Record<string, {driver: string, model: string, vendor: string, tier: number|string, costRank: number}>} runtimes
 * @returns {AllocationSuggestion}
 */
function allocation(worker, judge, vendorException, reason, runtimes) {
  return {
    worker: allocationRuntime(worker, runtimes),
    judge: allocationRuntime(judge, runtimes),
    vendorException,
    reason,
  };
}

/**
 * @param {string} id
 * @param {Record<string, {driver: string, model: string, vendor: string, tier: number|string, costRank: number}>} runtimes
 * @returns {AllocationRuntime}
 */
function allocationRuntime(id, runtimes) {
  const runtime = runtimes[id];
  if (!runtime) throw new Error(`allocation named an unknown runtime ${id}`);
  return {
    id,
    driver: runtime.driver,
    model: runtime.model,
    vendor: runtime.vendor,
    tier: runtime.tier ?? null,
    costRank: runtime.costRank ?? null,
  };
}

/**
 * @param {ModelsReport} report
 * @returns {string}
 */
export function renderModelsReport(report) {
  const lines = [`models · availability: ${report.availability}`, ""];
  for (const driver of report.drivers) {
    const vendor = driver.vendor ?? driver.vendorNote ?? "unresolved";
    lines.push(`[${driver.driver}] executable ${driver.executable} · vendor ${vendor} · catalogue ${driver.catalogue}`);
    lines.push(`  effort: ${effortTransportLine(driver)}`);
    for (const model of driver.models) lines.push(`  ${modelLine(driver, model)}`);
    if (!driver.models.length) lines.push("  models: none declared — the runtime declaration names the model");
    if (driver.probe) lines.push(`  probe: ${driver.probe.available ? `reachable${driver.probe.version ? ` (${driver.probe.version})` : ""}` : `unreachable (${driver.probe.reason})`}`);
    lines.push("");
  }
  lines.push("suggested allocation");
  lines.push(`  worker: ${allocationLine(report.suggestion.worker)}`);
  lines.push(`  judge: ${allocationLine(report.suggestion.judge)}`);
  lines.push(`  reason: ${report.suggestion.reason}`);
  lines.push(report.suggestion.vendorException
    ? `  cross-vendor: worker and judge resolve to ${report.suggestion.vendorException} — declared exception`
    : `  cross-vendor: worker vendor ${report.suggestion.worker.vendor} differs from judge vendor ${report.suggestion.judge.vendor}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * @param {DriverView} driver
 * @returns {string}
 */
function effortTransportLine(driver) {
  if (driver.effortTransport === null) return "none (this harness has no effort flag)";
  const aliases = Object.keys(driver.effortAliases).sort(codepointOrder);
  const aliasText = aliases.length ? ` (${aliases.map((key) => `${key}→${driver.effortAliases[key]}`).join(", ")})` : "";
  const notes = driver.effortNotes.length ? ` · ${driver.effortNotes.join(" · ")}` : "";
  return `${driver.effortTransport}${aliasText}${notes}`;
}

/**
 * @param {DriverView} driver
 * @param {ModelView} model
 * @returns {string}
 */
function modelLine(driver, model) {
  const parts = [model.id, `context ${model.contextWindowTokens ?? "unknown"}`, effortLine(model)];
  for (const path of model.declaredBy) parts.push(`also declared by ${path.driver} (vendor ${path.vendor ?? "unresolved"})`);
  if (model.effortInModelId && driver.effortTransport !== null) {
    parts.push(`${driver.effortTransport} is passed on top of the id-encoded level`);
  }
  return parts.join(" · ");
}

/**
 * @param {ModelView} model
 * @returns {string}
 */
function effortLine(model) {
  if (!model.efforts.length) return "effort none";
  const levels = model.efforts.map((effort) => (effort === model.defaultEffort ? `${effort} (default)` : effort)).join(", ");
  if (model.defaultEffort) return `effort ${levels}${model.effortInModelId ? ", fixed by the model id" : ""}`;
  return `effort ${levels} · default: the harness decides`;
}

/**
 * @param {AllocationRuntime} runtime
 * @returns {string}
 */
function allocationLine(runtime) {
  const tier = runtime.tier === null ? "" : ` · tier ${runtime.tier}`;
  const costRank = runtime.costRank === null ? "" : ` · costRank ${runtime.costRank}`;
  return `${runtime.id} · driver ${runtime.driver} · model ${runtime.model} · vendor ${runtime.vendor}${tier}${costRank}`;
}

/** @param {string} left @param {string} right @returns {number} */
function codepointOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * JSON with every object's keys in codepoint order, so the same report always
 * serializes to the same bytes.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  return `${JSON.stringify(sortedKeys(value), null, 2)}\n`;
}

/** @param {unknown} value @returns {unknown} */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(Object.keys(record).sort(codepointOrder).map((key) => [key, sortedKeys(record[key])]));
}
