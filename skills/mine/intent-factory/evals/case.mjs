/**
 * Turning a deterministic eval case on disk into a repository it can run in.
 *
 * A case declares a contract, recordings and a git history; this materialises
 * all three into a throwaway directory. `withModelBinsUnavailable` then removes
 * every provider binary from the environment, which is what makes
 * `--assert-no-model` a proof rather than a promise: a case that secretly
 * reaches a real provider fails to spawn instead of quietly costing money.
 *
 * `resolveRelativeTimestamps` exists because a recording pinned to an absolute
 * instant expires. Cases say `-5m` and mean it.
 */
import { EVALS_ROOT } from "./paths.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { initializeCampaign } from "../src/campaign/index.mjs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const DETERMINISTIC_ROOT = join(EVALS_ROOT, "deterministic");
const MODEL_BIN_VARS = [
  "INTENT_FACTORY_CODEX_BIN",
  "INTENT_FACTORY_CLAUDE_BIN",
  "INTENT_FACTORY_AGY_BIN",
  "INTENT_FACTORY_GLM_BIN",
];
/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
export function safeJoin(root, relativePath) {
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
export function caseDirFor(caseId) {
  return join(DETERMINISTIC_ROOT, caseId);
}
/** @returns {string[]} */
export function discoverCaseIds() {
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
export function loadCase(caseId) {
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
export async function withEnvOverlay(overlay, fn) {
  const keys = Object.keys(overlay ?? {});
  /** @type {Record<string, string|undefined>} */
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
export async function withModelBinsUnavailable(fn) {
  /** @type {Record<string, string|undefined>} */
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
export function initializeGitRepo(workDir) {
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
 * untouched. The replay harness itself never sees the placeholder, only the
 * resolved literal string — exactly the shape a real harness would produce.
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
export function materializeCase(caseDir, spec, patch = {}) {
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
