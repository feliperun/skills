import { Buffer } from "node:buffer";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fail, isContained, tailText } from "../util.mjs";

export const VERIFICATION_LIMITS = Object.freeze({
  stdoutBytes: 16 * 1024,
  stderrBytes: 16 * 1024,
  maxCommands: 32,
  maxRepeat: 8,
  maxTimeoutSec: 600,
  stateStdoutBytes: 2 * 1024,
  stateCommands: 16,
  stateAttempts: 4,
  stateAttemptRecords: 16,
  stateArgvBytes: 8 * 1024,
  stateEnvBytes: 4 * 1024,
  maxArgvBytes: 32 * 1024,
  maxEnvBytes: 8 * 1024,
  snapshotEntries: 4096,
  snapshotPathBytes: 1024,
});

/** @typedef {"active"|"closed"|"failed"|"crashed"|"canceled"} VerificationAttemptStatus */

/**
 * One declared deterministic check: an argv command run by the controller.
 *
 * @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[], mutation?: {threshold: number}}} VerificationCommand
 */

/**
 * A single attempt of a verification command.
 *
 * @typedef {{attempt: number, invocationId: string, commandIndex: number, pid: number|null, processStartToken: string|null, processGroupId: number|null, startedAt: string, deadlineAt: string, status: VerificationAttemptStatus, completedAt?: string|null, result?: VerificationAttemptResult|null}} VerificationAttempt
 */

/**
 * Bounded evidence captured for one attempt.
 *
 * @typedef {{passed: boolean, stdout: string, stderr: string, error: string|null, exitCode: number|null, signal: string|null, timedOut: boolean, durationMs: number|null}} VerificationAttemptResult
 */

/**
 * A command with its repeated attempts.
 *
 * @typedef {VerificationCommand & {passed: boolean, attempts: VerificationAttemptResult[]}} VerificationCommandResult
 */

/**
 * Aggregated verification result.
 *
 * @typedef {{passed: boolean, commands: VerificationCommandResult[]}} VerificationResult
 */

/**
 * Callbacks and options for {@link runVerification}.
 *
 * @typedef {{signal?: AbortSignal, logDir?: string, writeFiles?: string[], onAttemptStart?: (attempt: VerificationAttempt) => void, onAttemptSpawn?: (attempt: VerificationAttempt) => void, onAttemptComplete?: (attempt: VerificationAttempt) => void}} VerificationOptions
 */

/**
 * @param {unknown} cwd
 * @param {string} label
 */
function validateRelativeCwd(cwd, label) {
  if (typeof cwd !== "string" || isAbsolute(cwd) || /^[A-Za-z]:[\\/]/u.test(cwd) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(cwd)) {
    throw fail("verification_cwd_invalid", `${label}.cwd must be a relative path without ..`);
  }
}

/**
 * @param {string} baseCwd
 * @param {string} commandCwd
 * @returns {string}
 */
export function resolveVerificationCwd(baseCwd, commandCwd = ".") {
  validateRelativeCwd(commandCwd, "verification command");
  const baseReal = realpathSync(baseCwd);
  const candidate = resolve(baseReal, commandCwd);
  const targetReal = realpathSync(candidate);
  if (!isContained(baseReal, targetReal)) {
    throw fail("verification_cwd_escape", `verification cwd escapes workspace: ${commandCwd}`);
  }
  if (!statSync(targetReal).isDirectory()) throw fail("verification_cwd_invalid", `verification cwd is not a directory: ${commandCwd}`);
  return targetReal;
}

/**
 * @param {unknown} commands
 * @param {string} label
 * @returns {VerificationCommand[]}
 */
export function validateVerificationCommands(commands, label = "verification") {
  if (!Array.isArray(commands) || commands.length > VERIFICATION_LIMITS.maxCommands) {
    throw new TypeError(`${label} must be an array of at most ${VERIFICATION_LIMITS.maxCommands} command objects`);
  }
  return commands.map((command, index) => validateVerificationCommand(command, `${label}[${index}]`));
}

/**
 * @param {unknown} command
 * @param {string} label
 * @returns {VerificationCommand}
 */
function validateVerificationCommand(command, label = "verification command") {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new TypeError(`${label} must be an argv command object`);
  const record = /** @type {Record<string, unknown>} */ (command);
  const allowed = new Set(["argv", "cwd", "timeoutSec", "repeat", "env", "mutation"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.length > 64 || record.argv.some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > 8 * 1024)) {
    throw new TypeError(`${label}.argv must be a non-empty array of strings`);
  }
  const argvBytes = record.argv.reduce((sum, item) => sum + Buffer.byteLength(/** @type {string} */ (item), "utf8"), 0);
  if (argvBytes > VERIFICATION_LIMITS.maxArgvBytes) throw new TypeError(`${label}.argv exceeds aggregate byte limit`);
  if (record.cwd !== undefined) validateRelativeCwd(record.cwd, label);
  const timeoutSec = record.timeoutSec === undefined ? 120 : record.timeoutSec;
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > VERIFICATION_LIMITS.maxTimeoutSec) throw new TypeError(`${label}.timeoutSec must be between 0 and ${VERIFICATION_LIMITS.maxTimeoutSec}`);
  // Default single attempt: the worker already ran these commands inside its
  // session and the controller run is the independent confirmation; repeating
  // by default doubled suite cost for no extra signal.
  const repeat = record.repeat === undefined ? 1 : record.repeat;
  if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat <= 0 || repeat > VERIFICATION_LIMITS.maxRepeat) throw new TypeError(`${label}.repeat must be between 1 and ${VERIFICATION_LIMITS.maxRepeat}`);
  const env = record.env ?? [];
  if (!Array.isArray(env) || env.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new TypeError(`${label}.env must be an array of environment-variable names`);
  const envBytes = env.reduce((sum, name) => sum + Buffer.byteLength(/** @type {string} */ (name), "utf8"), 0);
  if (envBytes > VERIFICATION_LIMITS.maxEnvBytes) throw new TypeError(`${label}.env exceeds aggregate byte limit`);
  // Mutation testing is opt-in per entry: it re-runs the same argv against
  // deliberately broken copies of the node's written files. `threshold` is the
  // fraction of mutants the suite must kill, so 0 accepts any suite and 1
  // demands every sampled mutant fail it.
  /** @type {{threshold: number}|undefined} */
  let mutation;
  if (record.mutation !== undefined) {
    const rawMutation = record.mutation;
    if (!rawMutation || typeof rawMutation !== "object" || Array.isArray(rawMutation)) throw new TypeError(`${label}.mutation must be an object with a threshold between 0 and 1`);
    const mutationRecord = /** @type {Record<string, unknown>} */ (rawMutation);
    for (const key of Object.keys(mutationRecord)) if (key !== "threshold") throw new TypeError(`${label}.mutation has unexpected field ${key}`);
    if (typeof mutationRecord.threshold !== "number" || !Number.isFinite(mutationRecord.threshold) || mutationRecord.threshold < 0 || mutationRecord.threshold > 1) {
      throw new TypeError(`${label}.mutation.threshold must be a number between 0 and 1`);
    }
    mutation = { threshold: mutationRecord.threshold };
  }
  /** @type {VerificationCommand} */
  const normalized = { argv: [.../** @type {string[]} */ (record.argv)], timeoutSec, repeat, env: [.../** @type {string[]} */ (env)] };
  if (record.cwd !== undefined) normalized.cwd = /** @type {string} */ (record.cwd);
  if (mutation !== undefined) normalized.mutation = mutation;
  return normalized;
}

/**
 * Bound a verification result for persisted node state.
 *
 * @param {VerificationResult|undefined} result
 * @returns {VerificationResult}
 */
export function compactVerification(result) {
  /** @type {VerificationCommandResult[]} */
  const commands = [];
  let argvBytes = 0;
  let envBytes = 0;
  for (const command of result?.commands ?? []) {
    if (commands.length >= VERIFICATION_LIMITS.stateCommands) break;
    const nextArgvBytes = argvBytes + command.argv.reduce((sum, item) => sum + Buffer.byteLength(String(item), "utf8"), 0);
    const nextEnvBytes = envBytes + (command.env ?? []).reduce((sum, item) => sum + Buffer.byteLength(String(item), "utf8"), 0);
    if (nextArgvBytes > VERIFICATION_LIMITS.stateArgvBytes || nextEnvBytes > VERIFICATION_LIMITS.stateEnvBytes) break;
    argvBytes = nextArgvBytes;
    envBytes = nextEnvBytes;
    commands.push({
      argv: command.argv,
      cwd: command.cwd,
      timeoutSec: command.timeoutSec,
      repeat: command.repeat,
      env: command.env,
      passed: Boolean(command.passed),
      attempts: (command.attempts ?? []).slice(0, VERIFICATION_LIMITS.stateAttempts).map((attempt) => ({
        ...attempt,
        stdout: tailText(attempt.stdout, VERIFICATION_LIMITS.stateStdoutBytes),
        stderr: tailText(attempt.stderr, VERIFICATION_LIMITS.stateStdoutBytes),
      })),
    });
  }
  return { passed: Boolean(result?.passed), commands };
}

