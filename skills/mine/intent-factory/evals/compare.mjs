/**
 * Comparing what a case actually produced against what it declared, and proving
 * the case can fail.
 *
 * `applyDiscriminator` is the second half and the more important one: it undoes
 * the fix a case is meant to cover and asserts the case then fails. A green
 * eval suite where every case would pass without the fix is a suite that
 * measures nothing, which is what `--verify-discriminating` refuses.
 */
import { attemptWorktreePath, candidateWorktreePath, gitHead, runRefName } from "../src/repo/worktree.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readIntegrationJournal } from "../src/repo/integrate.mjs";

/**
 * @param {string} nodeId
 * @param {Record<string, unknown>} expectedNode
 * @param {string} runDir
 * @returns {string[]}
 */
export function compareNode(nodeId, expectedNode, runDir) {
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
    const runtimeIds = (actual.invocations ?? []).map((/** @type {{runtimeId?: string|null}} */ invocation) => invocation.runtimeId);
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
 * Compare a case's `preflight` expectation against the `preflight.json` a
 * `preflight` setup step wrote (see `executeStep`) — one static probe result
 * per reachable runtime, keyed by runtime id.
 *
 * @param {Record<string, unknown>} expectedPreflight
 * @param {string} workDir
 * @returns {string[]}
 */
export function comparePreflight(expectedPreflight, workDir) {
  const path = join(workDir, "preflight.json");
  if (!existsSync(path)) {
    return [`preflight: no preflight.json was written; the case needs a "preflight" setup step`];
  }
  const results = /** @type {{id: string|null, availability?: {available: boolean, exhaustedUntil: string|null, reason: string}}[]} */ (
    JSON.parse(readFileSync(path, "utf8"))
  );
  const byId = Object.fromEntries(results.map((entry) => [entry.id, entry]));
  /** @type {string[]} */
  const failures = [];
  for (const [runtimeId, expectedEntry] of Object.entries(expectedPreflight)) {
    const actualEntry = byId[runtimeId]?.availability ?? null;
    if (JSON.stringify(actualEntry) !== JSON.stringify(expectedEntry)) {
      failures.push(`preflight.${runtimeId}.availability: expected ${JSON.stringify(expectedEntry)}, got ${JSON.stringify(actualEntry)}`);
    }
  }
  return failures;
}
/**
 * Compare a case's `gc` expectation against the actual `.runs/` directory
 * listing and `.runs/gc.jsonl` after every `setup` step has run — the disk-
 * pressure garbage collector (`disk-gc.mjs`) has no node snapshot of its own
 * to read, since it can span (and remove) run directories no single node
 * belongs to.
 *
 * @param {{removed?: string[], kept?: string[], events?: {path: string, reason: string}[]}} expectedGc
 * @param {string} workDir
 * @returns {string[]}
 */
export function compareGc(expectedGc, workDir) {
  const runsRoot = join(workDir, ".runs");
  /** @type {string[]} */
  const failures = [];
  for (const id of expectedGc.removed ?? []) {
    if (existsSync(join(runsRoot, id))) failures.push(`gc: expected ${id} to have been removed by garbage collection, but it still exists`);
  }
  for (const id of expectedGc.kept ?? []) {
    if (!existsSync(join(runsRoot, id))) failures.push(`gc: expected ${id} to still exist, but it is gone`);
  }
  if (expectedGc.events !== undefined) {
    const gcLogPath = join(runsRoot, "gc.jsonl");
    const events = existsSync(gcLogPath)
      ? readFileSync(gcLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    for (const expectedEvent of expectedGc.events) {
      const match = events.some((event) => typeof event.path === "string" && event.path.endsWith(expectedEvent.path) && event.reason === expectedEvent.reason);
      if (!match) failures.push(`gc.events: no gc.jsonl event matching ${JSON.stringify(expectedEvent)} (got ${JSON.stringify(events)})`);
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
export function compareIntegration(expectedIntegration, { repo, runDir, runId }) {
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
export function normalizedSteps(spec) {
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
export function applyDiscriminator(spec, discriminator) {
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
