/**
 * Running a verification command and bounding what comes back.
 *
 * The controller runs each command itself, in the attempt workspace, with a
 * deliberately narrow environment (`VERIFICATION_ENV_BASE_NAMES`): a worker must
 * not be able to make a suite pass by exporting something. Output is captured
 * head-and-tail rather than whole, because a fuzz log will happily fill a disk,
 * and the process is killed by group so a test runner's children die with it.
 *
 * The schema for what may be run lives in `contract/verification.mjs`; this is
 * only the doing.
 */
import { Buffer } from "node:buffer";
import { VERIFICATION_LIMITS, compactVerification, resolveVerificationCwd, validateVerificationCommands } from "../contract/verification.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
/** @typedef {import("../contract/verification.mjs").VerificationOptions} VerificationOptions */

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {import("../contract/verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/verification.mjs").VerificationCommand} VerificationCommand */
/** @typedef {import("../contract/verification.mjs").VerificationCommandResult} VerificationCommandResult */
/** @typedef {import("../contract/verification.mjs").VerificationResult} VerificationResult */

// Verification children receive only the declared environment-variable names
// plus a minimal base set needed to spawn a process. Ambient controller
// variables (including secrets) must never leak into verification commands.
const VERIFICATION_ENV_BASE_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
]);

/**
 * @param {VerificationCommand} command
 * @returns {Record<string, string|undefined>}
 */
function verificationEnv(command) {
  const names = new Set([...(command.env ?? []), ...VERIFICATION_ENV_BASE_NAMES]);
  /** @type {Record<string, string|undefined>} */
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
/**
 * Run every declared command `repeat` times inside the workspace.
 *
 * @param {unknown} commands
 * @param {string} baseCwd
 * @param {VerificationOptions} options
 * @returns {Promise<VerificationResult>}
 */
export async function runVerification(commands, baseCwd, options = {}) {
  const validated = validateVerificationCommands(commands);
  /** @type {VerificationCommandResult[]} */
  const results = [];
  for (const [commandIndex, command] of validated.entries()) {
    /** @type {VerificationAttemptResult[]} */
    const attempts = [];
    const repeat = command.repeat ?? 1;
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      attempts.push(await runCommand(command, baseCwd, command.cwd ?? ".", attempt, options.signal, options, commandIndex));
    }
    const result = { ...command, cwd: resolveVerificationCwd(baseCwd, command.cwd ?? "."), passed: attempts.every((item) => item.passed), attempts };
    results.push(result);
    if (options.logDir) {
      mkdirSync(options.logDir, { recursive: true });
      writeFileSync(`${options.logDir}/verification-${results.length}.json`, `${JSON.stringify(compactVerification({ passed: result.passed, commands: [result] }))}\n`, { mode: 0o600 });
    }
  }
  return { passed: results.every((result) => result.passed), commands: results };
}
/**
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {string} commandCwd
 * @param {number} attempt
 * @param {AbortSignal|undefined} signal
 * @param {VerificationOptions} options
 * @param {number} commandIndex
 * @returns {Promise<VerificationAttemptResult>}
 */
function runCommand(command, baseCwd, commandCwd, attempt, signal, options, commandIndex) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const stdout = boundedTail(VERIFICATION_LIMITS.stdoutBytes);
    const stderr = boundedTail(VERIFICATION_LIMITS.stderrBytes);
    let settled = false;
    let timedOut = false;
    /** @type {import("node:child_process").ChildProcess|null} */
    let child = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {(() => void)|null} */
    let abortHandler = null;
    /** @type {VerificationAttempt|null} */
    let identity = null;
    let completionReported = false;
    const terminate = (/** @type {string} */ name) => {
      timedOut ||= name === "timeout";
      if (!child?.pid) return;
      terminateGroup(child);
    };
    /**
     * @param {number|null} exitCode
     * @param {string|null} signalName
     * @param {Error|null} error
     */
    const finish = (exitCode, signalName, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      if (child?.pid && !error && !signalName && !timedOut) terminateGroup(child);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const result = {
        attempt,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Math.round(durationMs * 100) / 100,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signalName ?? null,
        timedOut,
        error: error ? String(error.message ?? error) : null,
        passed: !error && !timedOut && exitCode === 0 && !signalName,
      };
      if (!completionReported && identity) {
        completionReported = true;
        try { options?.onAttemptComplete?.({ ...identity, status: result.passed ? "closed" : "failed", completedAt: new Date().toISOString(), result }); } catch {}
      }
      resolveResult(result);
    };
    try {
      const cwd = resolveVerificationCwd(baseCwd, commandCwd);
      const startedAt = new Date().toISOString();
      identity = {
        invocationId: randomUUID(), commandIndex, attempt, pid: null, processStartToken: null, processGroupId: null,
        startedAt, deadlineAt: new Date(Date.parse(startedAt) + (command.timeoutSec ?? 120) * 1_000).toISOString(), status: "active",
      };
      options?.onAttemptStart?.({ ...identity });
      const env = verificationEnv(command);
      child = spawn(command.argv[0], command.argv.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const pid = child.pid ?? null;
      let paused = false;
      if (process.platform !== "win32" && pid) {
        try { process.kill(-pid, "SIGSTOP"); paused = true; } catch {}
      }
      Object.assign(identity, { pid, processGroupId: process.platform === "win32" ? null : pid });
      options?.onAttemptSpawn?.({ ...identity });
      if (paused && pid) {
        try { process.kill(-pid, "SIGCONT"); } catch {}
      }
      const childStdout = /** @type {import("node:stream").Readable} */ (child.stdout);
      const childStderr = /** @type {import("node:stream").Readable} */ (child.stderr);
      childStdout.on("data", (chunk) => stdout.add(chunk));
      childStderr.on("data", (chunk) => stderr.add(chunk));
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signalName) => finish(code, signalName));
      abortHandler = () => terminate("abort");
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
    } catch (error) {
      if (child?.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGCONT"); } catch {}
      }
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
    }
    if (child) timer = setTimeout(() => terminate("timeout"), (command.timeoutSec ?? 120) * 1_000);
  });
}
/**
 * @param {import("node:child_process").ChildProcess} child
 */
function terminateGroup(child) {
  try {
    if (process.platform !== "win32") process.kill(-/** @type {number} */ (child.pid), "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try {
      if (process.platform !== "win32") process.kill(-/** @type {number} */ (child.pid), "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 100).unref();
}
/**
 * @param {number} maxBytes
 */
function boundedTail(maxBytes) {
  let value = Buffer.alloc(0);
  return {
    /**
     * @param {string|Buffer} chunk
     */
    add(chunk) {
      value = Buffer.concat([value, Buffer.from(chunk)]);
      if (value.length > maxBytes) {
        let start = value.length - maxBytes;
        while (start < value.length && (value[start] & 0xc0) === 0x80) start += 1;
        value = value.subarray(start);
      }
    },
    value: () => value.toString("utf8"),
  };
}
