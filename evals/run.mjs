#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runContract, resumeRun } from "../skills/mine/intent-factory/scripts/runner.mjs";
import { acquire as acquireControllerLock, lockPath, processStartToken as computeProcessStartToken } from "../skills/mine/intent-factory/scripts/lock.mjs";
import { writeJsonAtomic } from "../skills/mine/intent-factory/scripts/store.mjs";
import { initializeCampaign } from "../skills/mine/intent-factory/scripts/campaign.mjs";
import { readIntegrationJournal } from "../skills/mine/intent-factory/scripts/integrate.mjs";
import { attemptWorktreePath, candidateWorktreePath, gitHead, runRefName } from "../skills/mine/intent-factory/scripts/worktree.mjs";

const EVALS_ROOT = fileURLToPath(new URL(".", import.meta.url));
const DETERMINISTIC_ROOT = join(EVALS_ROOT, "deterministic");

const MODEL_BIN_VARS = [
  "INTENT_FACTORY_CODEX_BIN",
  "INTENT_FACTORY_CLAUDE_BIN",
  "INTENT_FACTORY_AGY_BIN",
  "INTENT_FACTORY_GLM_BIN",
];

const CLI_OPTIONS = {
  class: { type: "string" },
  case: { type: "string" },
  json: { type: "boolean" },
  "assert-no-model": { type: "boolean" },
  "verify-discriminating": { type: "boolean" },
};

/** @param {string} message @returns {never} */
function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: evals/run.mjs (--class deterministic | --case <id> | --verify-discriminating) [--assert-no-model] [--json]\n",
  );
  process.exitCode = 2;
  throw new UsageError(message);
}

class UsageError extends Error {}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
function safeJoin(root, relativePath) {
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`path escapes the case workspace: ${relativePath}`);
  }
  return resolved;
}

/**
 * @param {string} caseId
 * @returns {string}
 */
function caseDirFor(caseId) {
  return join(DETERMINISTIC_ROOT, caseId);
}

/** @returns {string[]} */
function discoverCaseIds() {
  if (!existsSync(DETERMINISTIC_ROOT)) return [];
  return readdirSync(DETERMINISTIC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(DETERMINISTIC_ROOT, entry.name, "case.json")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} caseId
 * @returns {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}}
 */
function loadCase(caseId) {
  const caseDir = caseDirFor(caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8"));
  if (spec.id !== caseId) throw new Error(`case.json id "${spec.id}" does not match its directory ${caseId}`);
  return { caseDir, spec, expected };
}

/**
 * @param {Record<string, unknown>|undefined} overlay
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
async function withEnvOverlay(overlay, fn) {
  const keys = Object.keys(overlay ?? {});
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = /** @type {Record<string, unknown>} */ (overlay)[key];
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withModelBinsUnavailable(fn) {
  const previous = {};
  for (const key of MODEL_BIN_VARS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of MODEL_BIN_VARS) {
      if (previous[key] !== undefined) process.env[key] = previous[key];
    }
  }
}

/**
 * @param {string} workDir
 * @returns {void}
 */
function initializeGitRepo(workDir) {
  writeFileSync(join(workDir, ".gitignore"), "node_modules/\n.runs/\n");
  writeFileSync(join(workDir, "README.md"), "intent-factory eval case workspace\n");
  execFileSync("git", ["init", "-q", workDir], { stdio: "ignore" });
  execFileSync("git", ["-C", workDir, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", [
    "-C", workDir,
    "-c", "user.email=evals@example.test",
    "-c", "user.name=intent-factory-evals",
    "-c", "commit.gpgSign=false",
    "commit", "-qm", "eval case baseline",
  ], { stdio: "ignore" });
}

/**
 * Materialize one case's contract into a fresh temporary git repository, with
 * every recording copied in and every declared runtime's
 * `config["replay.recording"]` pointed at that copy.
 *
 * @param {string} caseDir
 * @param {Record<string, unknown>} spec
 * @returns {{workDir: string, contractPath: string, runDir: string, contract: Record<string, unknown>}}
 */
function materializeCase(caseDir, spec) {
  const workDir = mkdtempSync(join(tmpdir(), `intent-factory-eval-${spec.id}-`));
  initializeGitRepo(workDir);

  const recordings = /** @type {Record<string, string>} */ (spec.recordings ?? {});
  const recordingsDir = join(workDir, ".eval-recordings");
  mkdirSync(recordingsDir, { recursive: true });

  const contract = JSON.parse(JSON.stringify(spec.contract));
  delete contract.cwd;
  for (const [runtimeId, filename] of Object.entries(recordings)) {
    const source = join(caseDir, filename);
    if (!existsSync(source)) throw new Error(`case ${spec.id} declares recording ${filename} for runtime ${runtimeId}, but the file does not exist`);
    const dest = join(recordingsDir, filename);
    copyFileSync(source, dest);
    const runtime = contract.runtimes?.[runtimeId];
    if (!runtime) throw new Error(`case ${spec.id} declares a recording for unknown runtime ${runtimeId}`);
    contract.runtimes[runtimeId] = { ...runtime, config: { ...(runtime.config ?? {}), "replay.recording": dest } };
  }

  const contractPath = join(workDir, "contract.json");
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  initializeCampaign(join(workDir, ".runs"), { campaignId: contract.campaignId, goal: contract.goal });

  const runDir = join(workDir, ".runs", contract.id);
  return { workDir, contractPath, runDir, contract };
}

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
 * @param {string} nodeId
 * @param {Record<string, unknown>} expectedNode
 * @param {string} runDir
 * @returns {string[]}
 */
function compareNode(nodeId, expectedNode, runDir) {
  /** @type {string[]} */
  const failures = [];
  const statePath = join(runDir, "nodes", `${nodeId}.json`);
  if (!existsSync(statePath)) {
    failures.push(`node ${nodeId}: state file is missing at ${statePath}`);
    return failures;
  }
  const actual = JSON.parse(readFileSync(statePath, "utf8"));

  if (expectedNode.status !== undefined && actual.status !== expectedNode.status) {
    failures.push(`node ${nodeId}.status: expected ${JSON.stringify(expectedNode.status)}, got ${JSON.stringify(actual.status)}`);
  }
  if (expectedNode.errorCode !== undefined) {
    const errorCode = actual.error?.code ?? null;
    if (errorCode !== expectedNode.errorCode) {
      failures.push(`node ${nodeId}.errorCode: expected ${JSON.stringify(expectedNode.errorCode)}, got ${JSON.stringify(errorCode)}`);
    }
  }
  if (expectedNode.revisions !== undefined) {
    const revisions = actual.revisions ?? 0;
    if (revisions !== expectedNode.revisions) {
      failures.push(`node ${nodeId}.revisions: expected ${expectedNode.revisions}, got ${revisions}`);
    }
  }
  if (expectedNode.runtimeIds !== undefined) {
    const runtimeIds = (actual.invocations ?? []).map((invocation) => invocation.runtimeId);
    if (JSON.stringify(runtimeIds) !== JSON.stringify(expectedNode.runtimeIds)) {
      failures.push(`node ${nodeId}.runtimeIds: expected ${JSON.stringify(expectedNode.runtimeIds)}, got ${JSON.stringify(runtimeIds)}`);
    }
  }
  if (expectedNode.routingHistoryLength !== undefined) {
    const length = (actual.routing?.history ?? []).length;
    if (length !== expectedNode.routingHistoryLength) {
      failures.push(`node ${nodeId}.routing.history length: expected ${expectedNode.routingHistoryLength}, got ${length}`);
    }
  }
  if (expectedNode.integratedHead !== undefined) {
    const integratedHead = actual.integratedHead ?? null;
    if (expectedNode.integratedHead === true && typeof integratedHead !== "string") {
      failures.push(`node ${nodeId}.integratedHead: expected a published sha, got ${JSON.stringify(integratedHead)}`);
    } else if (expectedNode.integratedHead === false && integratedHead !== null) {
      failures.push(`node ${nodeId}.integratedHead: expected null, got ${JSON.stringify(integratedHead)}`);
    } else if (typeof expectedNode.integratedHead === "string" && integratedHead !== expectedNode.integratedHead) {
      failures.push(`node ${nodeId}.integratedHead: expected ${JSON.stringify(expectedNode.integratedHead)}, got ${JSON.stringify(integratedHead)}`);
    }
  }
  return failures;
}

/**
 * Facts about integration recovery that live outside any single node's
 * snapshot: the run ref, the integration journal, and worktree cleanup.
 *
 * @param {Record<string, unknown>|undefined} expectedIntegration
 * @param {{repo: string, runDir: string, runId: string}} context
 * @returns {string[]}
 */
function compareIntegration(expectedIntegration, { repo, runDir, runId }) {
  if (!expectedIntegration) return [];
  /** @type {string[]} */
  const failures = [];

  for (const nodeId of /** @type {string[]} */ (expectedIntegration.runRefMatchesIntegratedHead ?? [])) {
    const statePath = join(runDir, "nodes", `${nodeId}.json`);
    if (!existsSync(statePath)) {
      failures.push(`integration.runRefMatchesIntegratedHead: node ${nodeId} has no state file`);
      continue;
    }
    const actual = JSON.parse(readFileSync(statePath, "utf8"));
    const runRef = gitHead(repo, runRefName(runId));
    if (!runRef) {
      failures.push(`integration.runRefMatchesIntegratedHead: run ref ${runRefName(runId)} does not exist`);
      continue;
    }
    if (!actual.integratedHead) {
      failures.push(`integration.runRefMatchesIntegratedHead: node ${nodeId}.integratedHead is not set`);
      continue;
    }
    if (runRef !== actual.integratedHead) {
      failures.push(`integration.runRefMatchesIntegratedHead: run ref ${runRef} does not match node ${nodeId}.integratedHead ${actual.integratedHead}`);
    }
  }

  const journal = readIntegrationJournal(runDir);
  for (const record of /** @type {{node: string, attempt: number}[]} */ (expectedIntegration.acceptedRecords ?? [])) {
    const found = journal.some((entry) => entry.node === record.node && entry.attempt === record.attempt && entry.status === "accepted");
    if (!found) failures.push(`integration.acceptedRecords: no accepted record for node ${record.node} attempt ${record.attempt}`);
  }

  const worktreesAbsent = /** @type {{attempts?: {node: string, attempt: number}[], candidate?: boolean}|undefined} */ (expectedIntegration.worktreesAbsent);
  if (worktreesAbsent) {
    for (const attempt of worktreesAbsent.attempts ?? []) {
      const path = attemptWorktreePath(runDir, runId, attempt.node, attempt.attempt);
      if (existsSync(path)) failures.push(`integration.worktreesAbsent: attempt worktree still exists at ${path}`);
    }
    if (worktreesAbsent.candidate) {
      const path = candidateWorktreePath(runDir, runId);
      if (existsSync(path)) failures.push(`integration.worktreesAbsent: candidate worktree still exists at ${path}`);
    }
  }

  return failures;
}

/**
 * @param {Record<string, unknown>} spec
 * @returns {Record<string, unknown>[]}
 */
function normalizedSteps(spec) {
  return Array.isArray(spec.setup) && spec.setup.length ? spec.setup : [{ type: "run" }];
}

/**
 * A discriminator names one mutation that must make its case fail. It is
 * applied to the normalized step list, never to a file on disk, so it can
 * never touch a versioned fixture.
 *
 * @param {Record<string, unknown>[]} steps
 * @param {Record<string, unknown>|undefined} discriminator
 * @returns {Record<string, unknown>[]}
 */
function applyDiscriminator(steps, discriminator) {
  if (!discriminator || typeof discriminator !== "object") throw new Error("case has no discriminator block");
  if (discriminator.type === "removeSetupStep") {
    const indices = new Set(/** @type {number[]} */ (discriminator.indices ?? []));
    if (!indices.size) throw new Error(`discriminator "removeSetupStep" needs a non-empty "indices" array`);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        throw new Error(`discriminator "removeSetupStep" index ${index} is out of range for ${steps.length} step(s)`);
      }
    }
    return steps.filter((_, index) => !indices.has(index));
  }
  throw new Error(`unknown discriminator type: ${discriminator.type}`);
}

/**
 * @param {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}} loaded
 * @param {{assertNoModel: boolean, stepsOverride?: Record<string, unknown>[]}} options
 * @returns {Promise<{id: string, title: string, proves: string, ok: boolean, failures: string[]}>}
 */
async function runCase({ caseDir, spec, expected }, options) {
  const id = /** @type {string} */ (spec.id);
  const title = /** @type {string} */ (spec.title ?? id);
  const proves = /** @type {string} */ (spec.proves ?? "");

  if (options.assertNoModel) {
    const nonReplay = Object.entries(/** @type {Record<string, {driver?: string}>} */ (spec.contract?.runtimes ?? {}))
      .filter(([, runtime]) => runtime.driver !== "replay")
      .map(([runtimeId, runtime]) => `${runtimeId} (${runtime.driver})`);
    if (nonReplay.length) {
      return { id, title, proves, ok: false, failures: [`--assert-no-model: non-replay runtime(s): ${nonReplay.join(", ")}`] };
    }
  }

  try {
    const { workDir, contractPath, runDir, contract } = materializeCase(caseDir, spec);
    const steps = options.stepsOverride ?? normalizedSteps(spec);
    for (const step of steps) await executeStep(/** @type {Record<string, unknown>} */ (step), { workDir, contractPath, runDir });

    const expectedNodes = /** @type {Record<string, Record<string, unknown>>} */ (expected.nodes ?? {});
    const failures = [
      ...Object.entries(expectedNodes).flatMap(([nodeId, expectedNode]) => compareNode(nodeId, expectedNode, runDir)),
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
    let stepsOverride;
    try {
      stepsOverride = applyDiscriminator(normalizedSteps(entry.spec), /** @type {Record<string, unknown>|undefined} */ (entry.spec.discriminator));
    } catch (error) {
      outcomes.push({ id, ok: false, failures: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    const result = await runCase(entry, { assertNoModel: false, stepsOverride });
    if (result.ok) {
      outcomes.push({ id, ok: false, failures: [`case still passes with its discriminator mutation (${JSON.stringify(entry.spec.discriminator)}) applied`] });
    } else {
      outcomes.push({ id, ok: true, failures: [] });
    }
  }
  return outcomes;
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
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

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) return;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
