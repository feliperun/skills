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

import { runContract, resumeRun } from "../skills/mine/intent-factory/scripts/runner.mjs";
import { acquire as acquireControllerLock, lockPath, processStartToken as computeProcessStartToken } from "../skills/mine/intent-factory/scripts/lock.mjs";
import { writeJsonAtomic } from "../skills/mine/intent-factory/scripts/store.mjs";
import { initializeCampaign } from "../skills/mine/intent-factory/scripts/campaign.mjs";
import { readIntegrationJournal } from "../skills/mine/intent-factory/scripts/integrate.mjs";
import { attemptWorktreePath, candidateWorktreePath, createAttemptWorktree, gitHead, runRefName } from "../skills/mine/intent-factory/scripts/worktree.mjs";
import { validateVerificationCommands } from "../skills/mine/intent-factory/scripts/verification.mjs";
import { compareEvalReports, mergeEvalRunSources, projectEvalIndicators, readEvalRunSources, renderEvalComparisonReport } from "./metrics.mjs";

/** @typedef {Record<string, unknown>} JsonObject */

const EVALS_ROOT = fileURLToPath(new URL(".", import.meta.url));
const DETERMINISTIC_ROOT = join(EVALS_ROOT, "deterministic");
const GOLDEN_ROOT = join(EVALS_ROOT, "golden");
const GOLDEN_BUNDLE_PATH = join(GOLDEN_ROOT, "fixtures.bundle");

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
    "usage: evals/run.mjs (--class deterministic | --case <id> | --verify-discriminating | --compare <before.json> <after.json> | --project <runDir>... [--campaign <id>] [--note <text>] | --validate-golden --min <n> | --verify-fixtures) [--assert-no-model] [--json]\n",
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
 * Set or remove one field inside a contract, addressed by a path of object
 * keys and array indices, in place.
 *
 * @param {Record<string, unknown>} contract
 * @param {{path: (string|number)[], value?: unknown, remove?: boolean}} contractPatch
 * @returns {void}
 */
function applyContractPatch(contract, { path, value, remove }) {
  let target = /** @type {Record<string, unknown>} */ (contract);
  for (const key of path.slice(0, -1)) {
    target = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (target)[key]);
    if (!target || typeof target !== "object") {
      throw new Error(`discriminator "patchContractField" path ${JSON.stringify(path)} does not resolve inside the contract`);
    }
  }
  const lastKey = /** @type {string|number} */ (path[path.length - 1]);
  if (remove) delete target[lastKey];
  else target[lastKey] = value;
}

/**
 * Rewrite one recorded envelope's `error.code` inside a jsonl recording,
 * leaving every other line untouched.
 *
 * @param {string} content
 * @param {{index: number, code: string}} recordingPatch
 * @returns {string}
 */
function patchRecordingErrorCode(content, { index, code }) {
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`discriminator "patchRecordingErrorCode" index ${index} is out of range for ${lines.length} recorded envelope(s)`);
  }
  const patched = lines.map((line, lineIndex) => {
    if (lineIndex !== index) return line;
    const record = JSON.parse(line);
    if (!record.envelope?.error) throw new Error(`discriminator "patchRecordingErrorCode" line ${index} has no envelope.error to patch`);
    record.envelope = { ...record.envelope, error: { ...record.envelope.error, code } };
    return JSON.stringify(record);
  });
  return `${patched.join("\n")}\n`;
}

/**
 * Set or remove one field inside a single recorded envelope, addressed by a
 * path relative to that envelope (e.g. `["error", "resetAt"]`).
 *
 * @param {string} content
 * @param {{index: number, path: (string|number)[], value?: unknown, remove?: boolean}} recordingPatch
 * @returns {string}
 */
function patchRecordingEnvelopeField(content, { index, path, value, remove }) {
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`discriminator "patchRecordingEnvelopeField" index ${index} is out of range for ${lines.length} recorded envelope(s)`);
  }
  const patched = lines.map((line, lineIndex) => {
    if (lineIndex !== index) return line;
    const record = JSON.parse(line);
    let target = record.envelope;
    if (!target || typeof target !== "object") throw new Error(`discriminator "patchRecordingEnvelopeField" line ${index} has no envelope to patch`);
    for (const key of path.slice(0, -1)) {
      target = /** @type {Record<string, unknown>} */ (target)[key];
      if (!target || typeof target !== "object") {
        throw new Error(`discriminator "patchRecordingEnvelopeField" path ${JSON.stringify(path)} does not resolve inside line ${index}'s envelope`);
      }
    }
    const lastKey = /** @type {string|number} */ (path[path.length - 1]);
    if (remove) delete /** @type {Record<string, unknown>} */ (target)[lastKey];
    else /** @type {Record<string, unknown>} */ (target)[lastKey] = value;
    return JSON.stringify(record);
  });
  return `${patched.join("\n")}\n`;
}

/**
 * A recorded envelope's `error.resetAt` or top-level `exhaustedUntil` may
 * carry a relative placeholder — the string `"+<milliseconds>"` — instead of
 * an absolute timestamp, since a fixture checked into git cannot know what
 * "soon" means relative to whenever the suite actually runs. Resolved once,
 * at materialization time, into a real ISO timestamp measured from now; every
 * other value (an absolute timestamp, or the field's absence) passes through
 * untouched. The replay driver itself never sees the placeholder, only the
 * resolved literal string — exactly the shape a real driver would produce.
 *
 * @param {string} content
 * @returns {string}
 */
function resolveRelativeTimestamps(content) {
  const lines = content.split("\n").filter((line) => line.length > 0);
  const resolved = lines.map((line) => {
    const record = JSON.parse(line);
    const envelope = record.envelope;
    if (!envelope || typeof envelope !== "object") return line;
    let changed = false;
    if (envelope.error && typeof envelope.error === "object" && typeof envelope.error.resetAt === "string") {
      const resolvedAt = resolveRelativeTimestamp(envelope.error.resetAt);
      if (resolvedAt !== envelope.error.resetAt) {
        envelope.error = { ...envelope.error, resetAt: resolvedAt };
        changed = true;
      }
    }
    if (typeof envelope.exhaustedUntil === "string") {
      const resolvedUntil = resolveRelativeTimestamp(envelope.exhaustedUntil);
      if (resolvedUntil !== envelope.exhaustedUntil) {
        envelope.exhaustedUntil = resolvedUntil;
        changed = true;
      }
    }
    return changed ? JSON.stringify({ ...record, envelope }) : line;
  });
  return `${resolved.join("\n")}\n`;
}

/** @param {string} value @returns {string} */
function resolveRelativeTimestamp(value) {
  const match = /^\+(\d+)$/u.exec(value);
  if (!match) return value;
  return new Date(Date.now() + Number(match[1])).toISOString();
}

/**
 * Materialize one case's contract into a fresh temporary git repository, with
 * every recording copied in and every declared runtime's
 * `config["replay.recording"]` pointed at that copy.
 *
 * @param {string} caseDir
 * @param {Record<string, unknown>} spec
 * @param {{contractPatch?: {path: (string|number)[], value?: unknown, remove?: boolean}|null, recordingPatch?: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}} [patch]
 * @returns {{workDir: string, contractPath: string, runDir: string, contract: Record<string, unknown>}}
 */
function materializeCase(caseDir, spec, patch = {}) {
  const workDir = mkdtempSync(join(tmpdir(), `intent-factory-eval-${spec.id}-`));
  initializeGitRepo(workDir);

  const recordings = /** @type {Record<string, string>} */ (spec.recordings ?? {});
  const recordingsDir = join(workDir, ".eval-recordings");
  mkdirSync(recordingsDir, { recursive: true });

  const contract = JSON.parse(JSON.stringify(spec.contract));
  delete contract.cwd;
  if (patch.contractPatch) applyContractPatch(contract, patch.contractPatch);
  for (const [runtimeId, filename] of Object.entries(recordings)) {
    const source = join(caseDir, filename);
    if (!existsSync(source)) throw new Error(`case ${spec.id} declares recording ${filename} for runtime ${runtimeId}, but the file does not exist`);
    const dest = join(recordingsDir, filename);
    let content = resolveRelativeTimestamps(readFileSync(source, "utf8"));
    if (patch.recordingPatch && patch.recordingPatch.runtime === runtimeId) {
      content = "code" in patch.recordingPatch
        ? patchRecordingErrorCode(content, patch.recordingPatch)
        : patchRecordingEnvelopeField(content, patch.recordingPatch);
    }
    writeFileSync(dest, content);
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
 * A discriminator names one mutation that must make its case fail. Step
 * removal is applied to the normalized step list; the other mutation types
 * are applied to a case's contract or a recording only in memory, once
 * materialized into a fresh temporary workspace — never to a file on disk, so
 * a discriminator can never touch a versioned fixture.
 *
 * @param {Record<string, unknown>} spec
 * @param {Record<string, unknown>|undefined} discriminator
 * @returns {{steps: Record<string, unknown>[], contractPatch: {path: (string|number)[], value?: unknown, remove?: boolean}|null, recordingPatch: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}}
 */
function applyDiscriminator(spec, discriminator) {
  const caseId = /** @type {string} */ (spec.id);
  const steps = normalizedSteps(spec);
  if (!discriminator || typeof discriminator !== "object") throw new Error(`case ${caseId} has no discriminator block`);

  if (discriminator.type === "removeSetupStep") {
    const indices = new Set(/** @type {number[]} */ (discriminator.indices ?? []));
    if (!indices.size) throw new Error(`discriminator "removeSetupStep" needs a non-empty "indices" array`);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        throw new Error(`discriminator "removeSetupStep" index ${index} is out of range for ${steps.length} step(s)`);
      }
    }
    const remaining = steps.filter((_, index) => !indices.has(index));
    // A mutation that erases every step that actually invokes the runner
    // makes the case fail because nothing ran at all, not because of
    // whatever the case claims to prove — that passes --verify-discriminating
    // for a trivial reason instead of a real one.
    const hadExecutingStep = steps.some((step) => step.type === "run" || step.type === "resume");
    const stillHasExecutingStep = remaining.some((step) => step.type === "run" || step.type === "resume");
    if (hadExecutingStep && !stillHasExecutingStep) {
      throw new Error(`case ${caseId}: discriminator "removeSetupStep" removes every "run"/"resume" step, leaving nothing to execute — pick a mutation that isolates what the case actually proves`);
    }
    return { steps: remaining, contractPatch: null, recordingPatch: null };
  }

  if (discriminator.type === "patchContractField") {
    const path = /** @type {(string|number)[]} */ (discriminator.path);
    if (!Array.isArray(path) || path.length === 0) throw new Error(`discriminator "patchContractField" needs a non-empty "path" array`);
    const remove = discriminator.remove === true;
    if (!remove && !("value" in discriminator)) throw new Error(`discriminator "patchContractField" needs a "value" (or "remove": true)`);
    return { steps, contractPatch: { path, value: discriminator.value, remove }, recordingPatch: null };
  }

  if (discriminator.type === "patchRecordingErrorCode") {
    const runtime = discriminator.runtime;
    const code = discriminator.code;
    if (typeof runtime !== "string" || !runtime) throw new Error(`discriminator "patchRecordingErrorCode" needs a "runtime"`);
    if (typeof code !== "string" || !code) throw new Error(`discriminator "patchRecordingErrorCode" needs a "code"`);
    const index = typeof discriminator.index === "number" ? discriminator.index : 0;
    return { steps, contractPatch: null, recordingPatch: { runtime, index, code } };
  }

  if (discriminator.type === "patchRecordingEnvelopeField") {
    const runtime = discriminator.runtime;
    const path = /** @type {(string|number)[]} */ (discriminator.path);
    if (typeof runtime !== "string" || !runtime) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a "runtime"`);
    if (!Array.isArray(path) || path.length === 0) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a non-empty "path" array`);
    const remove = discriminator.remove === true;
    if (!remove && !("value" in discriminator)) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a "value" (or "remove": true)`);
    const index = typeof discriminator.index === "number" ? discriminator.index : 0;
    return { steps, contractPatch: null, recordingPatch: { runtime, index, path, value: discriminator.value, remove } };
  }

  throw new Error(`unknown discriminator type: ${discriminator.type}`);
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
    const nonReplay = Object.entries(/** @type {Record<string, {driver?: string}>} */ (spec.contract?.runtimes ?? {}))
      .filter(([, runtime]) => runtime.driver !== "replay")
      .map(([runtimeId, runtime]) => `${runtimeId} (${runtime.driver})`);
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

/** Every task directory directly under `evals/golden/`, sorted for stable output. @returns {string[]} */
function discoverGoldenTaskIds() {
  if (!existsSync(GOLDEN_ROOT)) return [];
  return readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * `evals/run.mjs --validate-golden --min <n> [--json]`: fail unless the
 * golden set has at least `n` task directories and every one of them carries
 * `statement.md`, `verify.json` (a well-formed argv command list, the same
 * shape `validateVerificationCommands` enforces on a real contract's
 * `taskPacket.verification`), and `meta.json` naming the commit and its
 * parent.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runValidateGolden(rest) {
  const asJson = rest.includes("--json");
  const minIndex = rest.indexOf("--min");
  if (minIndex === -1 || rest[minIndex + 1] === undefined) {
    usageError("--validate-golden needs --min <n>");
    return;
  }
  const min = Number(rest[minIndex + 1]);
  if (!Number.isInteger(min) || min < 0) {
    usageError(`--min must be a non-negative integer: ${rest[minIndex + 1]}`);
    return;
  }

  const taskIds = discoverGoldenTaskIds();
  /** @type {string[]} */
  const failures = [];
  for (const taskId of taskIds) {
    const taskDir = join(GOLDEN_ROOT, taskId);
    for (const file of ["statement.md", "verify.json", "meta.json"]) {
      if (!existsSync(join(taskDir, file))) failures.push(`${taskId}: missing ${file}`);
    }
    const verifyPath = join(taskDir, "verify.json");
    if (existsSync(verifyPath)) {
      try {
        const verify = /** @type {{commands?: unknown}} */ (JSON.parse(readFileSync(verifyPath, "utf8")));
        validateVerificationCommands(verify.commands, `${taskId}/verify.json.commands`);
      } catch (error) {
        failures.push(`${taskId}: invalid verify.json (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const metaPath = join(taskDir, "meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = /** @type {JsonObject} */ (JSON.parse(readFileSync(metaPath, "utf8")));
        if (typeof meta.commitSha !== "string" || !meta.commitSha) failures.push(`${taskId}: meta.json.commitSha missing`);
        if (typeof meta.parentSha !== "string" || !meta.parentSha) failures.push(`${taskId}: meta.json.parentSha missing`);
      } catch (error) {
        failures.push(`${taskId}: invalid meta.json (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  if (taskIds.length < min) failures.unshift(`only ${taskIds.length} golden task(s) found, need at least ${min}`);

  const ok = failures.length === 0;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok, min, count: taskIds.length, failures }, null, 2)}\n`);
  } else if (ok) {
    process.stdout.write(`ok: ${taskIds.length} golden tasks, all complete (min ${min})\n`);
  } else {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
  }
  if (!ok) process.exitCode = 1;
}

/**
 * `evals/run.mjs --verify-fixtures [--json]`: restore each golden task's
 * parent commit from the one shared `evals/golden/fixtures.bundle` and
 * confirm the restored tree matches the tree `meta.json` recorded at build
 * time — proof the bundle actually reconstructs what every task claims,
 * not just that the file is present. Nothing is written to a working tree:
 * fetching the parent commit's objects into a throwaway bare repository and
 * comparing tree ids is enough to prove the restore, and is far cheaper
 * than materializing 26 checkouts.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runVerifyFixtures(rest) {
  const asJson = rest.includes("--json");
  const taskIds = discoverGoldenTaskIds();
  if (!existsSync(GOLDEN_BUNDLE_PATH)) {
    usageError(`--verify-fixtures needs ${GOLDEN_BUNDLE_PATH}`);
    return;
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "evals-golden-verify-"));
  /** @type {{taskId: string, ok: boolean, reason?: string}[]} */
  const results = [];
  try {
    execFileSync("git", ["init", "-q", "--bare", tmpRoot], { stdio: ["ignore", "pipe", "pipe"] });
    for (const taskId of taskIds) {
      const metaPath = join(GOLDEN_ROOT, taskId, "meta.json");
      if (!existsSync(metaPath)) {
        results.push({ taskId, ok: false, reason: "missing meta.json" });
        continue;
      }
      /** @type {JsonObject} */
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const parentSha = /** @type {string} */ (meta.parentSha);
      const expectedTreeSha = /** @type {string} */ (meta.parentTreeSha);
      if (typeof parentSha !== "string" || typeof expectedTreeSha !== "string") {
        results.push({ taskId, ok: false, reason: "meta.json missing parentSha or parentTreeSha" });
        continue;
      }
      try {
        execFileSync("git", ["-C", tmpRoot, "fetch", "-q", GOLDEN_BUNDLE_PATH, parentSha], { stdio: ["ignore", "pipe", "pipe"] });
        const restoredTreeSha = execFileSync("git", ["-C", tmpRoot, "rev-parse", `${parentSha}^{tree}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (restoredTreeSha !== expectedTreeSha) {
          results.push({ taskId, ok: false, reason: `restored tree ${restoredTreeSha} does not match meta.json's ${expectedTreeSha}` });
        } else {
          results.push({ taskId, ok: true });
        }
      } catch (error) {
        results.push({ taskId, ok: false, reason: error instanceof Error ? error.message.split("\n")[0] : String(error) });
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const ok = results.length > 0 && results.every((result) => result.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  } else {
    for (const result of results) process.stdout.write(`${result.ok ? "[ok]" : "[fail]"} ${result.taskId}${result.reason ? ` — ${result.reason}` : ""}\n`);
  }
  if (!ok) process.exitCode = 1;
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
