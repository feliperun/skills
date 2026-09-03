#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const ENVELOPE_STATUSES = new Set(["done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled"]);
const LINE_KEYS = new Set(["envelope", "files", "delayMs", "exitCode", "stdoutRaw"]);
const ENVELOPE_KEYS = new Set(["status", "result", "continuationId", "usage", "costUsd", "error"]);
const USAGE_KEYS = new Set(["inputTokens", "outputTokens", "cacheReadInputTokens"]);
const FILE_KEYS = new Set(["path", "content"]);
const ERROR_KEYS = new Set(["code", "message"]);
const METADATA_ROOTS = new Set([".git", ".runs", "node_modules", ".claude", ".codex"]);
const PREFLIGHT_TOKEN = "INTENT_FACTORY_PREFLIGHT_OK";

const PREFLIGHT_ENVELOPE = Object.freeze({
  status: "done",
  result: PREFLIGHT_TOKEN,
  continuationId: null,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  costUsd: null,
  error: null,
});

/** @param {string[]} args @param {string} name @returns {string|null} */
function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`replay: ${message}\n`);
  process.exit(2);
}

/** @param {number} lineIndex @param {string} message @returns {never} */
function failSchema(lineIndex, message) {
  fail(`recording line ${lineIndex + 1} violates schema: ${message}`);
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {{status: "failed", result: null, continuationId: null, usage: {inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0}, costUsd: null, error: {code: string, message: string}}}
 */
function failedEnvelope(code, message) {
  return {
    status: "failed",
    result: null,
    continuationId: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: null,
    error: { code, message },
  };
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((settle) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => settle(input));
    process.stdin.on("error", () => settle(input));
  });
}

/** @param {string} recording @returns {string[]} */
function readRecordingLines(recording) {
  if (!existsSync(recording)) return [];
  let text;
  try {
    text = readFileSync(recording, "utf8");
  } catch (error) {
    fail(`cannot read recording ${recording}: ${String(error)}`);
  }
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

/** @param {string} cursorPath @returns {number} */
function readCursor(cursorPath) {
  if (!existsSync(cursorPath)) return 0;
  const raw = readFileSync(cursorPath, "utf8").trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    fail(`cursor file ${cursorPath} must contain a non-negative integer`);
  }
  return Number(raw);
}

/** @param {string} cursorPath @param {number} value @returns {void} */
function writeCursor(cursorPath, value) {
  const temporary = `${cursorPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${value}\n`);
  renameSync(temporary, cursorPath);
}

/**
 * @param {unknown} value
 * @param {number} lineIndex
 * @returns {{envelope: Record<string, unknown>, files: {path: string, content: string}[], delayMs: number|undefined, exitCode: number|undefined, stdoutRaw: string|undefined}}
 */
function parseRecord(value, lineIndex) {
  if (!value || typeof value !== "object" || Array.isArray(value)) failSchema(lineIndex, "must be an object");
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record)) {
    if (!LINE_KEYS.has(key)) failSchema(lineIndex, `has unknown field ${key}`);
  }
  if (!Object.hasOwn(record, "envelope")) failSchema(lineIndex, "is missing envelope");
  const envelope = parseEnvelope(record.envelope, lineIndex);
  /** @type {{path: string, content: string}[]} */
  const files = [];
  if (record.files !== undefined) {
    if (!Array.isArray(record.files)) failSchema(lineIndex, "files must be an array");
    files.push(...record.files.map((file, fileIndex) => parseFile(file, lineIndex, fileIndex)));
  }
  let delayMs;
  if (record.delayMs !== undefined) {
    if (typeof record.delayMs !== "number" || !Number.isFinite(record.delayMs) || record.delayMs < 0) {
      failSchema(lineIndex, "delayMs must be a non-negative number");
    }
    delayMs = record.delayMs;
  }
  let exitCode;
  if (record.exitCode !== undefined) {
    if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode) || record.exitCode < 0 || record.exitCode > 255) {
      failSchema(lineIndex, "exitCode must be an integer between 0 and 255");
    }
    exitCode = record.exitCode;
  }
  let stdoutRaw;
  if (record.stdoutRaw !== undefined) {
    if (typeof record.stdoutRaw !== "string") failSchema(lineIndex, "stdoutRaw must be a string");
    stdoutRaw = record.stdoutRaw;
  }
  return { envelope, files, delayMs, exitCode, stdoutRaw };
}

/**
 * @param {unknown} value
 * @param {number} lineIndex
 * @returns {Record<string, unknown>}
 */
function parseEnvelope(value, lineIndex) {
  if (!value || typeof value !== "object" || Array.isArray(value)) failSchema(lineIndex, "envelope must be an object");
  const envelope = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_KEYS.has(key)) failSchema(lineIndex, `envelope has unknown field ${key}`);
  }
  for (const key of ENVELOPE_KEYS) {
    if (!Object.hasOwn(envelope, key)) failSchema(lineIndex, `envelope is missing ${key}`);
  }
  const status = envelope.status;
  if (typeof status !== "string" || !ENVELOPE_STATUSES.has(status)) {
    failSchema(lineIndex, `envelope.status must be one of ${[...ENVELOPE_STATUSES].join(", ")}`);
  }
  const result = envelope.result;
  if (result !== null && typeof result !== "string") failSchema(lineIndex, "envelope.result must be a string or null");
  const continuationId = envelope.continuationId;
  if (continuationId !== null && typeof continuationId !== "string") {
    failSchema(lineIndex, "envelope.continuationId must be a string or null");
  }
  const usage = envelope.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) failSchema(lineIndex, "envelope.usage must be an object");
  for (const key of Object.keys(usage)) {
    if (!USAGE_KEYS.has(key)) failSchema(lineIndex, `envelope.usage has unknown field ${key}`);
  }
  for (const key of USAGE_KEYS) {
    if (!Object.hasOwn(usage, key)) failSchema(lineIndex, `envelope.usage is missing ${key}`);
    const raw = /** @type {Record<string, unknown>} */ (usage)[key];
    if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) {
      failSchema(lineIndex, `envelope.usage.${key} must be a non-negative integer or null`);
    }
  }
  const costUsd = envelope.costUsd;
  if (costUsd !== null && (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)) {
    failSchema(lineIndex, "envelope.costUsd must be a non-negative number or null");
  }
  parseError(envelope.error, lineIndex);
  return envelope;
}

/**
 * @param {unknown} value
 * @param {number} lineIndex
 * @param {number} fileIndex
 * @returns {{path: string, content: string}}
 */
function parseFile(value, lineIndex, fileIndex) {
  const label = `files[${fileIndex}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) failSchema(lineIndex, `${label} must be an object`);
  const file = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.has(key)) failSchema(lineIndex, `${label} has unknown field ${key}`);
  }
  const path = file.path;
  if (typeof path !== "string" || path.length === 0) failSchema(lineIndex, `${label}.path must be a non-empty string`);
  const content = file.content;
  if (typeof content !== "string") failSchema(lineIndex, `${label}.content must be a string`);
  return { path, content };
}

/**
 * @param {unknown} value
 * @param {number} lineIndex
 * @returns {void}
 */
function parseError(value, lineIndex) {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) failSchema(lineIndex, "envelope.error must be an object or null");
  const error = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(error)) {
    if (!ERROR_KEYS.has(key)) failSchema(lineIndex, `envelope.error has unknown field ${key}`);
  }
  if (typeof error.code !== "string" || error.code.length === 0 || typeof error.message !== "string") {
    failSchema(lineIndex, "envelope.error must carry a non-empty code and a string message");
  }
}

/**
 * Fail closed when a recorded file target could escape the real workspace:
 * relative paths only, no `..` segments, no metadata roots, and no symlinked
 * ancestor whose realpath leaves the workspace.
 *
 * @param {string} path
 * @param {string} workspace
 * @returns {string|null}
 */
function containmentProblem(path, workspace) {
  if (isAbsolute(path)) return `replay file path must be relative: ${path}`;
  const segments = path.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return `replay file path must not traverse outside the workspace: ${path}`;
  }
  if (segments.length === 0 || METADATA_ROOTS.has(segments[0])) {
    return `replay file path must not target a metadata root: ${path}`;
  }
  const target = join(process.cwd(), path);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let ancestorReal = null;
  try {
    ancestorReal = realpathSync(ancestor);
  } catch {
    ancestorReal = null;
  }
  if (ancestorReal === null || !(ancestorReal === workspace || ancestorReal.startsWith(`${workspace}${sep}`))) {
    return `replay file path escapes the workspace through a symlink: ${path}`;
  }
  return null;
}

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("replay 1.0.0\n");
  process.exit(0);
}

const recordingArg = argValue(args, "--recording");
if (recordingArg === null) {
  fail("--recording <recording.jsonl> is required");
}
const recording = resolve(recordingArg);
const prompt = await readStdin();

if (prompt.includes(PREFLIGHT_TOKEN)) {
  process.stdout.write(`${JSON.stringify(PREFLIGHT_ENVELOPE)}\n`);
  process.exit(0);
}

const lines = readRecordingLines(recording);
const cursorPath = `${recording}.cursor`;
const cursor = readCursor(cursorPath);
if (cursor >= lines.length) {
  const suffix = lines.length === 1 ? "" : "s";
  process.stdout.write(`${JSON.stringify(failedEnvelope("replay_exhausted", `replay recording exhausted at cursor ${cursor} (${lines.length} line${suffix})`))}\n`);
  process.exit(1);
}

const rawLine = lines[cursor];
/** @type {unknown} */
let parsed;
try {
  parsed = JSON.parse(rawLine);
} catch (error) {
  fail(`recording line ${cursor + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const record = parseRecord(parsed, cursor);
const workspace = realpathSync(process.cwd());

for (const file of record.files) {
  const problem = containmentProblem(file.path, workspace);
  if (problem !== null) {
    process.stdout.write(`${JSON.stringify(failedEnvelope("replay_path_escape", problem))}\n`);
    process.exit(2);
  }
}
for (const file of record.files) {
  const target = join(process.cwd(), file.path);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  } catch (error) {
    fail(`cannot write ${file.path}: ${String(error)}`);
  }
}

writeCursor(cursorPath, cursor + 1);
appendFileSync(
  `${recording}.invocations.jsonl`,
  `${JSON.stringify({ at: new Date().toISOString(), index: cursor, promptBytes: Buffer.byteLength(prompt, "utf8"), args })}\n`,
);

if (record.delayMs !== undefined && record.delayMs > 0) {
  await new Promise((settle) => setTimeout(settle, record.delayMs));
}
if (record.stdoutRaw !== undefined) {
  process.stdout.write(record.stdoutRaw);
} else {
  process.stdout.write(`${JSON.stringify(record.envelope)}\n`);
}
process.exitCode = record.exitCode ?? 0;
