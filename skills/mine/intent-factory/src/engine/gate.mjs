/**
 * The provider gate: a standalone program the controller spawns in the worker's
 * place, which holds the provider process until the controller writes the
 * release file. It exists so the controller can record an operation intent
 * before a single token is spent -- the gate is already the running process and
 * its pid is already persisted, so a crash between spawn and release leaves a
 * recoverable record rather than an unknown effect.
 *
 * It is spawned by path (`spawn(process.execPath, [gate.mjs])`), not imported,
 * and it talks to its parent only through the environment:
 *   INTENT_FACTORY_GATE_CONFIG        the invocation to run, as JSON
 *   INTENT_FACTORY_GATE_RELEASE       the file whose appearance releases it
 *   INTENT_FACTORY_GATE_PARENT_PID    the controller it must not outlive
 *   INTENT_FACTORY_GATE_PARENT_TOKEN  that pid's start token, so a reused pid
 *                                     is not mistaken for a live controller
 *
 * Until 2026-09-11 this was a `String.raw` template inside node.mjs, spawned
 * with `node -e`. As a real file it is covered by `npm run check` and by
 * `tsc` -- which found eleven type errors in it on the first run, none of them
 * reachable while the code was a string -- and it shows up in a stack trace.
 *
 * Nothing here is exported for a caller: this file is a program. Every name
 * below is module-local.
 */
import { existsSync, readFileSync, statSync, openSync, closeSync, readSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

/** @typedef {{executable: string, args: string[], cwd: string, promptTransport: "stdin"|"argv", harness: string, env: Record<string, string|null>|null, stdoutPath: string, stderrPath: string}} GateConfig */

/**
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** @type {GateConfig} */
const config = JSON.parse(readFileSync(requiredEnv("INTENT_FACTORY_GATE_CONFIG"), "utf8"));
const releasePath = requiredEnv("INTENT_FACTORY_GATE_RELEASE");
const parentPid = Number(process.env.INTENT_FACTORY_GATE_PARENT_PID);
const parentToken = process.env.INTENT_FACTORY_GATE_PARENT_TOKEN || null;
const maxLogBytes = 512 * 1024;

/**
 * @param {number} pid
 * @returns {string|null}
 */
function startToken(pid) {
  if (process.platform !== "linux" || !pid) return null;
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8").trim();
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

/** @returns {boolean} */
function parentAlive() {
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error
      && /** @type {{code: unknown}} */ (error).code === "EPERM";
  }
  return !parentToken || process.platform !== "linux" || startToken(parentPid) === parentToken;
}

/** @type {import("node:child_process").ChildProcess|null} */
let provider = null;
let inputEnded = config.promptTransport !== "stdin";
/** @type {Buffer[]} */
const pendingInput = [];
if (config.promptTransport === "stdin") {
  process.stdin.on("data", (chunk) => {
    if (provider) provider.stdin?.write(chunk);
    else pendingInput.push(chunk);
  });
  process.stdin.on("end", () => {
    inputEnded = true;
    if (provider) provider.stdin?.end();
  });
}

/** @param {NodeJS.Signals} signal */
function killGroup(signal) {
  try { process.kill(-process.pid, signal); } catch {
    // ESRCH: the process group is already gone, so there is nothing to signal.
  }
}

function stopProvider() {
  try { provider?.kill("SIGTERM"); } catch {
    // No provider yet, or it already exited: a failed SIGTERM needs no action.
  }
  setTimeout(() => killGroup("SIGKILL"), 100).unref();
}

/**
 * Providers write directly into the log files: a provider with non-blocking
 * stdout (EAGAIN on a full pipe) must never die because the controller's event
 * loop is briefly busy. Cap the files to the last maxLogBytes afterwards.
 *
 * @param {string} path
 * @param {boolean} [preservePrefix]
 */
function capLog(path, preservePrefix = false) {
  try {
    const size = statSync(path).size;
    if (size <= maxLogBytes) return;
    if (preservePrefix) {
      const prefixLimit = Math.min(64 * 1024, maxLogBytes - 1);
      const prefix = Buffer.alloc(prefixLimit);
      const prefixFd = openSync(path, "r");
      readSync(prefixFd, prefix, 0, prefixLimit, 0);
      closeSync(prefixFd);
      const prefixEnd = prefix.lastIndexOf(10);
      if (prefixEnd >= 0) {
        const tailLimit = maxLogBytes - prefixEnd - 1;
        const tail = Buffer.alloc(tailLimit);
        const tailFd = openSync(path, "r");
        readSync(tailFd, tail, 0, tailLimit, size - tailLimit);
        closeSync(tailFd);
        const tailStart = tail.indexOf(10);
        const suffix = tailStart >= 0 ? tail.subarray(tailStart + 1) : Buffer.alloc(0);
        const out = openSync(path, "w");
        writeSync(out, Buffer.concat([prefix.subarray(0, prefixEnd + 1), suffix]));
        closeSync(out);
        return;
      }
    }
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxLogBytes);
    readSync(fd, buffer, 0, maxLogBytes, size - maxLogBytes);
    closeSync(fd);
    const out = openSync(path, "w");
    writeSync(out, buffer);
    closeSync(out);
  } catch {
    // Best-effort cap: any filesystem error leaves the log uncapped, which is safe.
  }
}

/** @returns {Record<string, string|undefined>} */
function childEnv() {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  // Worker providers are not a notification surface: strip the controller-only
  // transport after the harness overlay so no harness can reintroduce it.
  delete merged.INTENT_FACTORY_NOTIFY_BIN;
  return merged;
}

process.on("SIGTERM", () => stopProvider());
process.on("SIGINT", () => stopProvider());

const timer = setInterval(() => {
  if (!parentAlive()) { clearInterval(timer); stopProvider(); return; }
  if (!existsSync(releasePath)) return;
  clearInterval(timer);
  const stdoutFd = openSync(config.stdoutPath, "wx", 0o600);
  const stderrFd = openSync(config.stderrPath, "wx", 0o600);
  provider = spawn(config.executable, config.args, {
    cwd: config.cwd,
    env: childEnv(),
    stdio: [config.promptTransport === "stdin" ? "pipe" : "ignore", stdoutFd, stderrFd],
  });
  if (config.promptTransport === "stdin") {
    for (const chunk of pendingInput) provider.stdin?.write(chunk);
    pendingInput.length = 0;
    if (inputEnded) provider.stdin?.end();
  }
  provider.once("error", () => process.exitCode = 127);
  provider.once("close", (code) => {
    capLog(config.stdoutPath, config.harness === "codex");
    capLog(config.stderrPath);
    process.exit(code ?? 1);
  });
}, 10);
