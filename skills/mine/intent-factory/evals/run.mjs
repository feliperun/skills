#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runContract, resumeRun } from "../src/cli.mjs";
import { preflightContract } from "../src/engine/live-preflight.mjs";
import { acquire as acquireControllerLock, lockPath, processStartToken as computeProcessStartToken } from "../src/run/lock.mjs";
import { writeJsonAtomic } from "../src/run/store.mjs";
import { initializeCampaign } from "../src/campaign/index.mjs";
import { readIntegrationJournal } from "../src/repo/integrate.mjs";
import { attemptWorktreePath, candidateWorktreePath, createAttemptWorktree, gitHead, runRefName } from "../src/repo/worktree.mjs";
import { validateVerificationCommands } from "../src/contract/verification.mjs";
import { compareEvalReports, mergeEvalRunSources, projectEvalIndicators, readEvalRunSources, renderEvalComparisonReport } from "./metrics.mjs";
import { discoverCaseIds, loadCase, materializeCase, safeJoin, withEnvOverlay, withModelBinsUnavailable } from "./case.mjs";
import { applyDiscriminator, compareGc, compareIntegration, compareNode, comparePreflight, normalizedSteps } from "./compare.mjs";
import { runValidateGolden, runVerifyFixtures } from "./golden.mjs";
import { UsageError, usageError } from "./paths.mjs";

/** @typedef {Record<string, unknown>} JsonObject */

/** @type {import("node:util").ParseArgsOptionsConfig} */
const CLI_OPTIONS = {
  class: { type: "string" },
  case: { type: "string" },
  json: { type: "boolean" },
  "assert-no-model": { type: "boolean" },
  "verify-discriminating": { type: "boolean" },
};

/**
 * @param {Record<string, unknown>} step
 * @param {{workDir: string, contractPath: string, runDir: string}} context
 * @returns {Promise<void>}
 */
async function executeStep(step, context) {
  const type = step.type;
  const env = /** @type {Record<string, unknown>|undefined} */ (step.env);
  const expectError = typeof step.expectError === "string" ? step.expectError : null;

  if (type === "run" || type === "resume") {
    let rejected = null;
    try {
      await withEnvOverlay(env, () => (
        type === "run"
          ? runContract(context.contractPath)
          : resumeRun(context.runDir, /** @type {Record<string, unknown>} */ (step.options ?? {}))
      ));
    } catch (error) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }
    if (expectError) {
      if (!rejected) throw new Error(`setup step "${type}" was expected to reject matching /${expectError}/, but it resolved`);
      if (!new RegExp(expectError, "iu").test(rejected.message)) {
        throw new Error(`setup step "${type}" rejected with "${rejected.message}", which does not match /${expectError}/`);
      }
      return;
    }
    if (rejected) throw rejected;
    return;
  }
  if (type === "holdControllerLock") {
    acquireControllerLock(context.runDir, { pid: process.pid });
    return;
  }
  if (type === "writeLock") {
    // A raw, unmediated write to controller.lock: the only way to plant a
    // record acquire() itself would refuse to install over a live holder.
    // Writing this process's own pid with a token that does not match its
    // own live token stands in for a controller pid later reused by a
    // different, unrelated live process — the fact the takeover logic keys
    // on rather than pid liveness alone.
    const processStartTokenValue = step.processStartToken === undefined
      ? computeProcessStartToken(process.pid)
      : (typeof step.processStartToken === "string" ? step.processStartToken : null);
    writeJsonAtomic(lockPath(context.runDir), {
      schemaVersion: 1,
      pid: process.pid,
      processStartToken: processStartTokenValue,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
    });
    return;
  }
  if (type === "rewindNodeToRunning") {
    // Simulates a controller that died with this node's provider invocation
    // already finished on disk but never processed: the node's own status is
    // wound back to "running" with no result or gate verdict, exactly as
    // test/helpers.mjs's `orphan()` does, so resume's recovery has to decide
    // what an invocation it never dispatched itself actually produced.
    const nodeId = /** @type {string} */ (step.node);
    const nodePath = join(context.runDir, "nodes", `${nodeId}.json`);
    const state = JSON.parse(readFileSync(nodePath, "utf8"));
    writeJsonAtomic(nodePath, { ...state, status: "running", phase: "worker", result: null, gate: null });
    return;
  }
  if (type === "recreateAttemptWorktree") {
    // A node already integrated has had its attempt worktree removed by the
    // sealing step; recovering it as a still-running orphan needs that
    // worktree back so the recovered result can be re-verified and re-sealed,
    // exactly as test/helpers.mjs's `ensureAttemptWorktree()` does. A no-op
    // when the worktree was never removed.
    const nodeId = /** @type {string} */ (step.node);
    const nodePath = join(context.runDir, "nodes", `${nodeId}.json`);
    const state = JSON.parse(readFileSync(nodePath, "utf8"));
    if (state.worktree?.status === "removed" && state.worktree.branch) {
      const recreated = createAttemptWorktree({
        repo: context.workDir,
        runDir: context.runDir,
        runId: basename(context.runDir),
        nodeId,
        attempt: state.attempt,
        base: state.worktree.baseSha,
      });
      writeJsonAtomic(nodePath, {
        ...state,
        worktree: { ...state.worktree, status: "ready", path: recreated.path, commit: recreated.commit },
      });
    }
    return;
  }
  if (type === "preflight") {
    // The static preflight probe (probeRuntime, never a recording) reports
    // every reachable runtime's own availability and never throws on a bad
    // one — unlike run/resume, which refuse to dispatch at all when any
    // reachable runtime cannot be probed. Written to a fixed path so a case
    // with no run/resume step at all can still assert on it.
    const results = await preflightContract(context.contractPath, { static: true });
    writeFileSync(join(context.workDir, "preflight.json"), JSON.stringify(results, null, 2));
    return;
  }
  if (type === "mkdirp") {
    mkdirSync(safeJoin(context.workDir, /** @type {string} */ (step.path)), { recursive: true });
    return;
  }
  if (type === "writeFile") {
    const target = safeJoin(context.workDir, /** @type {string} */ (step.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, /** @type {string} */ (step.content ?? ""));
    return;
  }
  throw new Error(`unknown setup step type: ${type}`);
}

/**
 * @param {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}} loaded
 * @param {{assertNoModel: boolean, stepsOverride?: Record<string, unknown>[], patch?: {contractPatch?: {path: (string|number)[], value?: unknown, remove?: boolean}|null, recordingPatch?: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}}} options
 * @returns {Promise<{id: string, title: string, proves: string, ok: boolean, failures: string[]}>}
 */
async function runCase({ caseDir, spec, expected }, options) {
  const id = /** @type {string} */ (spec.id);
  const title = /** @type {string} */ (spec.title ?? id);
  const proves = /** @type {string} */ (spec.proves ?? "");

  if (options.assertNoModel) {
    const nonReplay = Object.entries(/** @type {Record<string, {harness?: string}>} */ ((/** @type {{runtimes?: unknown}} */ (spec.contract ?? {})).runtimes ?? {}))
      .filter(([, runtime]) => runtime.harness !== "replay")
      .map(([runtimeId, runtime]) => `${runtimeId} (${runtime.harness})`);
    if (nonReplay.length) {
      return { id, title, proves, ok: false, failures: [`--assert-no-model: non-replay runtime(s): ${nonReplay.join(", ")}`] };
    }
  }

  try {
    const { workDir, contractPath, runDir, contract } = materializeCase(caseDir, spec, options.patch);
    const steps = options.stepsOverride ?? normalizedSteps(spec);
    for (const step of steps) await executeStep(/** @type {Record<string, unknown>} */ (step), { workDir, contractPath, runDir });

    const expectedNodes = /** @type {Record<string, Record<string, unknown>>} */ (expected.nodes ?? {});
    const failures = [
      ...Object.entries(expectedNodes).flatMap(([nodeId, expectedNode]) => compareNode(nodeId, expectedNode, runDir)),
      ...(expected.preflight ? comparePreflight(/** @type {Record<string, unknown>} */ (expected.preflight), workDir) : []),
      ...(expected.gc ? compareGc(/** @type {{removed?: string[], kept?: string[], events?: {path: string, reason: string}[]}} */ (expected.gc), workDir) : []),
      ...compareIntegration(/** @type {Record<string, unknown>|undefined} */ (expected.integration), {
        repo: workDir,
        runDir,
        runId: /** @type {string} */ (contract.id),
      }),
    ];
    return { id, title, proves, ok: failures.length === 0, failures };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, title, proves, ok: false, failures: [`case threw: ${message}`] };
  }
}

/**
 * @param {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}[]} loaded
 * @returns {Promise<{id: string, ok: boolean, failures: string[]}[]>}
 */
async function verifyDiscriminating(loaded) {
  const outcomes = [];
  for (const entry of loaded) {
    const id = /** @type {string} */ (entry.spec.id);
    let mutation;
    try {
      mutation = applyDiscriminator(entry.spec, /** @type {Record<string, unknown>|undefined} */ (entry.spec.discriminator));
    } catch (error) {
      outcomes.push({ id, ok: false, failures: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    const result = await runCase(entry, {
      assertNoModel: false,
      stepsOverride: mutation.steps,
      patch: { contractPatch: mutation.contractPatch, recordingPatch: mutation.recordingPatch },
    });
    if (result.ok) {
      outcomes.push({ id, ok: false, failures: [`case still passes with its discriminator mutation (${JSON.stringify(entry.spec.discriminator)}) applied`] });
    } else {
      outcomes.push({ id, ok: true, failures: [] });
    }
  }
  return outcomes;
}

/**
 * A report file on disk is either a bare indicator map (the `EvalReport`
 * shape `projectEvalIndicators` returns) or that same map wrapped with a
 * `provenance` block (what `--project` writes and what `evals/baseline.json`
 * and `evals/fixtures/*.json` carry). Either way, `compareEvalReports` only
 * ever wants the indicator map.
 *
 * @param {unknown} parsed
 * @returns {JsonObject}
 */
function evalIndicatorsOf(parsed) {
  const object = /** @type {JsonObject} */ (parsed);
  return object && typeof object.indicators === "object" && object.indicators !== null ? /** @type {JsonObject} */ (object.indicators) : object;
}

/**
 * `evals/run.mjs --compare <before.json> <after.json> [--json]`: compare two
 * already-projected eval reports and print the result.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runCompare(rest) {
  const asJson = rest.includes("--json");
  const positionals = rest.filter((arg) => arg !== "--json");
  if (positionals.length !== 2) {
    usageError("--compare needs exactly two report paths: <before.json> <after.json>");
    return;
  }
  const [beforePath, afterPath] = positionals;
  const before = evalIndicatorsOf(JSON.parse(readFileSync(resolve(beforePath), "utf8")));
  const after = evalIndicatorsOf(JSON.parse(readFileSync(resolve(afterPath), "utf8")));
  const comparison = compareEvalReports(before, after);
  process.stdout.write(asJson ? `${JSON.stringify({ schemaVersion: 1, indicators: comparison }, null, 2)}\n` : renderEvalComparisonReport(comparison));
}

/**
 * `evals/run.mjs --project <runDir>... [--campaign <id>] [--note <text>] [--json]`:
 * project indicators straight from one or more runs' own `events.jsonl`/
 * `usage.jsonl` (concatenated when more than one directory is given — a
 * campaign run across several sequential orchestrator attempts has no
 * single directory holding every record) and print the result together with
 * its provenance, so a report on disk can be regenerated and audited
 * against the run directories it claims to measure instead of trusted as a
 * bare number.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runProject(rest) {
  const asJson = rest.includes("--json");
  /** @type {string|null} */
  let campaign = null;
  /** @type {string|null} */
  let note = null;
  /** @type {string[]} */
  const runDirs = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") continue;
    if (arg === "--campaign") {
      index += 1;
      campaign = rest[index] ?? null;
      continue;
    }
    if (arg === "--note") {
      index += 1;
      note = rest[index] ?? null;
      continue;
    }
    runDirs.push(arg);
  }
  if (runDirs.length === 0) {
    usageError("--project needs at least one run directory");
    return;
  }
  const resolvedRunDirs = runDirs.map((runDir) => resolve(runDir));
  const merged = mergeEvalRunSources(resolvedRunDirs.map((runDir) => readEvalRunSources(runDir)));
  const indicators = projectEvalIndicators(merged);
  const report = {
    schemaVersion: 1,
    provenance: { campaign, runIds: resolvedRunDirs.map((runDir) => basename(runDir)), runDirs: resolvedRunDirs, generatedAt: new Date().toISOString(), note },
    indicators,
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`provenance: ${JSON.stringify(report.provenance)}\n`);
  for (const [name, indicator] of Object.entries(indicators)) {
    process.stdout.write(`${name}: ${JSON.stringify(/** @type {JsonObject} */ (indicator).value)} (n=${/** @type {JsonObject} */ (indicator).count})\n`);
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv[0] === "--compare") {
    runCompare(argv.slice(1));
    return;
  }
  if (argv[0] === "--project") {
    runProject(argv.slice(1));
    return;
  }
  if (argv[0] === "--validate-golden") {
    runValidateGolden(argv.slice(1));
    return;
  }
  if (argv[0] === "--verify-fixtures") {
    runVerifyFixtures(argv.slice(1));
    return;
  }
  /** @type {{values: Record<string, unknown>}} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: false, strict: true });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
    return;
  }
  const { values } = parsed;
  const assertNoModel = values["assert-no-model"] === true;
  const verifyDiscriminatingFlag = values["verify-discriminating"] === true;
  const asJson = values.json === true;

  if (values.class === undefined && values.case === undefined && !verifyDiscriminatingFlag) {
    usageError("one of --class or --case is required");
    return;
  }
  if (values.class !== undefined && values.class !== "deterministic") {
    usageError(`unknown --class: ${values.class}`);
    return;
  }

  let caseIds = discoverCaseIds();
  if (values.case !== undefined) {
    if (!caseIds.includes(/** @type {string} */ (values.case))) {
      usageError(`unknown --case: ${values.case}`);
      return;
    }
    caseIds = [/** @type {string} */ (values.case)];
  }

  const loaded = caseIds.map((id) => loadCase(id));
  // Cases run one at a time: a step's env overlay and a synthesized
  // controller.lock both mutate process-global state, which parallel cases
  // would otherwise race on and corrupt.
  if (verifyDiscriminatingFlag) {
    const outcomes = await verifyDiscriminating(loaded);
    const ok = outcomes.every((outcome) => outcome.ok);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, cases: outcomes }, null, 2)}\n`);
    } else {
      for (const outcome of outcomes) {
        process.stdout.write(`[${outcome.ok ? "ok" : "fail"}] ${outcome.id}\n`);
        for (const failure of outcome.failures) process.stdout.write(`      ${failure}\n`);
      }
      const passed = outcomes.filter((outcome) => outcome.ok).length;
      process.stdout.write(`${passed}/${outcomes.length} discriminate\n`);
    }
    if (!ok) process.exitCode = 1;
    return;
  }

  const run = async () => {
    const outcomes = [];
    for (const entry of loaded) outcomes.push(await runCase(entry, { assertNoModel }));
    return outcomes;
  };
  const results = await (assertNoModel ? withModelBinsUnavailable(run) : run());

  const ok = results.every((result) => result.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, cases: results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`[${result.ok ? "ok" : "fail"}] ${result.id} · ${result.title}\n`);
      for (const failure of result.failures) process.stdout.write(`      ${failure}\n`);
    }
    const passed = results.filter((result) => result.ok).length;
    process.stdout.write(`${passed}/${results.length} passed\n`);
  }
  if (!ok) process.exitCode = 1;
}

/**
 * Whether this module was launched directly (`node evals/run.mjs ...`)
 * rather than imported — `main()` must run only in the former case, so a
 * test can import the pure projector/comparator functions above without
 * also triggering a CLI run against its own argv.
 *
 * @param {string|undefined} scriptPath
 * @returns {boolean}
 */
function isEvalsRunMain(scriptPath) {
  try {
    return Boolean(scriptPath) && realpathSync(resolve(/** @type {string} */ (scriptPath))) === realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}

if (isEvalsRunMain(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof UsageError) return;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
