import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DISCOVERY_RUNTIME_DEFINITIONS, composeAssignments } from "../scripts/runtime-discovery.mjs";
import { MODEL_HARNESS_ORDER, parseAgyModels } from "../scripts/models.mjs";
import { registeredHarnesses, resolveVendor } from "../scripts/harnesses/index.mjs";
import { fakeAgy } from "./helpers.mjs";
import { RUNNER_CLI } from "./runner-helpers.mjs";

/**
 * Every harness's executable is pinned to a path that does not exist unless a
 * test says otherwise: the host's own binaries (and, above all, a real `agy`
 * answering `models`) must never reach an assertion.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
function hermeticEnv(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "models-absent-"));
  /** @type {Record<string, string>} */
  const env = {};
  for (const harness of ["claude", "codex", "agy", "dsh", "zcode", "exec-jsonl", "replay"]) {
    env[`INTENT_FACTORY_${harness.replace(/-/gu, "_").toUpperCase()}_BIN`] = join(directory, `absent-${harness}`);
  }
  return { ...env, ...overrides };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function modelsCli(argv, env) {
  const result = spawnSync(process.execPath, [RUNNER_CLI, "models", ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @returns {any}
 */
function modelsJson(argv, env) {
  const result = modelsCli([...argv, "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/**
 * @param {any} report
 * @param {string} harness
 * @returns {any}
 */
function blockOf(report, harness) {
  return /** @type {any[]} */ (report.harnesses).find((view) => view.harness === harness);
}

/**
 * @param {any} block
 * @param {string} id
 * @returns {any}
 */
function modelOf(block, id) {
  const model = /** @type {any[]} */ (block.models).find((entry) => entry.id === id);
  assert.ok(model, `${block.harness} does not list ${id}`);
  return model;
}

test("a harness whose catalogue nothing declares is listed with its source named, never dropped", async () => {
  const report = modelsJson([], hermeticEnv());
  for (const harness of ["exec-jsonl", "replay"]) {
    const block = blockOf(report, harness);
    assert.ok(block, `${harness} is registered but missing from the report`);
    assert.equal(block.catalogue, "runtime-declared", "the report names who supplies the models");
    assert.deepEqual(block.models, [], "no model id is invented for a runtime-defined harness");
    assert.equal(block.effortTransport, null, `${harness} has no effort surface to report`);
  }
  const text = modelsCli([], hermeticEnv()).stdout;
  assert.match(text, /\[exec-jsonl\][^\n]*catalogue runtime-declared/u);
  assert.match(text, /\[replay\][^\n]*catalogue runtime-declared/u);
});

test("the report covers every registered harness exactly once, in the documented order", async () => {
  const report = modelsJson([], hermeticEnv());
  const listed = /** @type {any[]} */ (report.harnesses).map((view) => view.harness);
  assert.deepEqual([...listed].sort(), [...registeredHarnesses()].sort(), "no registered harness is missing and none is invented");
  assert.deepEqual(listed, [...listed].sort((left, right) => MODEL_HARNESS_ORDER.indexOf(left) - MODEL_HARNESS_ORDER.indexOf(right)), "the fixed order, not registry or object order");
  for (const view of report.harnesses) {
    assert.ok(view.executable.length > 0, `${view.harness} resolves an executable`);
    assert.ok(view.vendor !== undefined && view.vendorNote !== undefined, `${view.harness} resolves or explains its vendor`);
  }
});

test("without an agy binary the declared catalogue stands, and with one the CLI catalogue wins", async () => {
  const absent = modelsJson([], hermeticEnv());
  const declared = blockOf(absent, "agy");
  assert.equal(declared.catalogue, "declared");
  assert.equal(declared.models.some((/** @type {any} */ model) => model.id === "gemini-3.1-pro-low"), false, "an id only the live CLI knows cannot appear");

  const fake = fakeAgy(mkdtempSync(join(tmpdir(), "models-agy-")));
  const live = modelsJson([], hermeticEnv({
    INTENT_FACTORY_AGY_BIN: fake,
    PATH: `${dirname(fake)}${delimiter}${process.env.PATH ?? ""}`,
  }));
  const agy = blockOf(live, "agy");
  assert.equal(agy.catalogue, "agy-cli", "the provider CLI's own catalogue is used when it answers");
  const ids = agy.models.map((/** @type {any} */ model) => model.id);
  assert.deepEqual(ids, ["claude-sonnet-4-6", "gemini-3.1-pro-low", "gemini-3.8-flash-high"], "the listing is sorted, so the CLI's own order never reaches the output");
  assert.equal(modelOf(agy, "gemini-3.1-pro-low").contextWindowTokens, null, "an unknown window stays unknown");
});

test("parseAgyModels reads the measured `id<TAB>display name` shape and nothing else", () => {
  const parsed = parseAgyModels("Fetching available models...\n\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n");
  assert.deepEqual(parsed.map((model) => model.id), ["gemini-3.1-pro-low", "gemini-3.8-flash-high"]);
  assert.deepEqual(parseAgyModels("no models found\n"), []);
});

test("the effort vocabulary is the vendor's real one: dsh defaults to high, agy encodes the level in the id", async () => {
  const report = modelsJson([], hermeticEnv());
  const dsh = modelOf(blockOf(report, "dsh"), "deepseek-v4-pro");
  assert.deepEqual(dsh.efforts, ["off", "low", "high", "max"]);
  assert.equal(dsh.defaultEffort, "high", "high is dsh's default, not codex's xhigh");
  assert.equal(dsh.contextWindowTokens, 1_000_000);
  assert.equal(dsh.effortInModelId, null, "dsh names the level outside the model id");

  const agyHigh = modelOf(blockOf(report, "agy"), "gemini-3.8-flash-high");
  assert.equal(agyHigh.effortInModelId, "high", "the id fixes the level");
  assert.equal(agyHigh.defaultEffort, "high");
  assert.deepEqual(agyHigh.efforts, ["low", "medium", "high"], "the adapter's effort vocabulary still applies");

  const zcode = modelOf(blockOf(report, "zcode"), "glm-5.3");
  assert.deepEqual(zcode.efforts, [], "zcode's adapter passes no effort flag at all");

  const text = modelsCli([], hermeticEnv()).stdout;
  assert.match(text, /model ids ending in -low\/-medium\/-high fix the level themselves, and the adapter still passes --effort on top/u, "the double specification is stated, not hidden");
});

test("a model reachable by two paths shows both resolved vendors", async () => {
  const report = modelsJson([], hermeticEnv());
  assert.deepEqual(modelOf(blockOf(report, "claude"), "claude-sonnet-4-6").declaredBy, [{ harness: "agy", vendor: "google" }]);
  assert.deepEqual(modelOf(blockOf(report, "agy"), "claude-sonnet-4-6").declaredBy, [{ harness: "claude", vendor: "anthropic" }]);
  assert.equal(blockOf(report, "claude").vendor, "anthropic");
  assert.equal(blockOf(report, "agy").vendor, "google", "agy resells the same id under its own vendor");
});

test("the suggested allocation is the discovery law's own answer, cross-vendor and byte-stable", async () => {
  const env = hermeticEnv();
  const first = modelsCli([], env).stdout;
  const second = modelsCli([], env).stdout;
  assert.equal(first, second, "the same command twice is the same bytes");

  const report = modelsJson([], env);
  const available = Object.fromEntries(Object.keys(DISCOVERY_RUNTIME_DEFINITIONS).map((id) => [id, { available: true, exhaustedUntil: null, reason: "declared" }]));
  const expected = composeAssignments({
    runtimes: Object.fromEntries(Object.entries(DISCOVERY_RUNTIME_DEFINITIONS).map(([id, definition]) => {
      const vendor = resolveVendor(definition);
      assert.ok(vendor, `${id} resolves a vendor`);
      return [id, { ...definition, vendor }];
    })),
    runtimeDefaults: {},
    nodes: [{ id: "models", gate: { enabled: true } }],
  }, available).models;
  assert.equal(report.suggestion.worker.id, expected.worker);
  assert.equal(report.suggestion.judge.id, expected.judge);
  assert.notEqual(report.suggestion.worker.vendor, report.suggestion.judge.vendor, "worker and judge are distinct vendors by construction");
  assert.equal(report.suggestion.vendorException, null, "no same-vendor exception is declared here");
  assert.match(modelsCli([], env).stdout, /cross-vendor: worker vendor \w+ differs from judge vendor \w+/u);
});

test("neither surface carries a date, a clock, or a locale-dependent number", async () => {
  for (const argv of [[], ["--json"]]) {
    const output = modelsCli(argv, hermeticEnv()).stdout;
    assert.doesNotMatch(output, /\d{4}-\d{2}-\d{2}/u, "no date reaches the report");
    assert.doesNotMatch(output, /\d{1,2}:\d{2}/u, "no clock reaches the report");
    assert.doesNotMatch(output, /\b\d{1,3}(,\d{3})+/u, "big numbers are plain integers, not locale-grouped");
  }
});

test("probe mode reports per-runtime reachability with the existing probe and adds nothing else", async () => {
  const fake = fakeAgy(mkdtempSync(join(tmpdir(), "models-probe-agy-")));
  const report = modelsJson(["--probe"], hermeticEnv({ INTENT_FACTORY_AGY_BIN: fake }));
  assert.match(report.availability, /doctor/u, "probe mode still points at doctor as authoritative");
  for (const view of report.harnesses) {
    assert.ok(view.probe, `${view.harness} carries a probe result`);
    assert.equal(typeof view.probe.ok, "boolean");
  }
  assert.equal(blockOf(report, "agy").probe.available, true);
  assert.equal(blockOf(report, "codex").probe.available, false);
  assert.equal(blockOf(report, "codex").probe.reason, "not_found");

  const plain = modelsJson([], hermeticEnv());
  assert.equal(blockOf(plain, "agy").probe, undefined, "probe results are opt-in only");
});

test("models takes no positional and rejects one", () => {
  const rejected = modelsCli(["contract.json"], hermeticEnv());
  assert.equal(rejected.status, 2, "a stray positional is a usage error");
  assert.match(rejected.stderr, /usage: runner\.mjs/u);
  assert.match(rejected.stderr, /models \[--probe\] \[--json\]/u, "usage names the new subcommand");
});
