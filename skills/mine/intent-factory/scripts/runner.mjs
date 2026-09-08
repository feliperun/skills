#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  TERMINAL,
  normalizeProviderResult,
  renderFindings,
  renderReport,
  renderStatus,
  validateContract,
} from "./lib.mjs";
import { probeRuntime, providerCommand } from "./drivers/index.mjs";
import { doctorCommand, environmentPreflight, reachableRuntimes } from "./env-preflight.mjs";
import { renderReportJson, renderStatusJson } from "./render.mjs";
import { validateNodeSnapshot } from "./contract.mjs";
import {
  bootstrapAckPath,
  bootstrapAttemptPath,
  bootstrapPath,
  cleanupBootstrapAttempts,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from "./store.mjs";
import { acquire as acquireLock, processStartToken, readLock } from "./lock.mjs";
import { renderRunHandoff } from "./campaign.mjs";
import { campaignCli } from "./campaign-cli.mjs";
import { contractCli, validateContractFile } from "./contract-cli.mjs";
import {
  bootstrapFailureMatchesChild,
  bootstrapMatchesChild,
  sameProcessStartToken,
  validBootstrapNonce,
} from "./lease-liveness.mjs";
import { METRICS_OPTIONS, renderCampaignMetrics } from "./metrics.mjs";
import { cancelRun, readRunNodes, resumeRun, runContract } from "./scheduler.mjs";
import {
  delay,
  emptyUsage,
  errorCode,
  errorMessage,
  render,
} from "./node.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./contract.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./contract.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("./contract.mjs").RunMetadata} RunMetadata */
/** @typedef {import("./contract.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("./contract.mjs").EventRecord} EventRecord */
/** @typedef {import("./contract.mjs").Usage} Usage */
/** @typedef {import("./contract.mjs").GateResult} GateResult */
/** @typedef {import("./contract.mjs").SnapshotError} SnapshotError */
/** @typedef {import("./contract.mjs").BoundedScope} BoundedScope */
/** @typedef {import("./lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("./drivers/index.mjs").DriverRuntime} DriverRuntime */
/** @typedef {import("./drivers/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("./drivers/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("./campaign.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./node.mjs").Job} Job */
/** @typedef {import("./node.mjs").Invocation} Invocation */
/** @typedef {import("./scheduler.mjs").RunOutcome} RunOutcome */
/** @typedef {import("node:child_process").ChildProcess & {bootstrapNonce?: string, bootstrapProcessStartToken?: string|null}} DetachedChild */
/** @typedef {{status?: string, nonce?: string, pid?: number, processStartToken?: string|null, holderId?: string, generation?: number, error?: unknown, runDir?: string}} BootstrapRecord */

export { runContract, resumeRun, cancelRun } from "./scheduler.mjs";

const LIVE_PREFLIGHT_PROMPT = "Respond with exactly INTENT_FACTORY_PREFLIGHT_OK and do not use tools.";

const LIVE_PREFLIGHT_OUTPUT_LIMIT_BYTES = 512 * 1024;

/**
 * @param {string} contractPath
 * @param {{static?: boolean, liveTimeoutSec?: number}} [options]
 * @returns {Promise<ProbeResult[]>}
 */
export async function preflightContract(contractPath, options = {}) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContract(JSON.parse(readFileSync(absoluteContractPath, "utf8")), absoluteContractPath);
  const runtimes = reachableRuntimes(contract);
  const staticChecks = await Promise.all([...runtimes.values()].map(({ runtime, requiredCapabilitySets }) =>
    probeRuntime(runtime, { cwd: contract.cwd, requiredCapabilitySets }),
  ));
  if (options.static === true) return staticChecks;

  const timeoutSec = livePreflightTimeout(options.liveTimeoutSec);
  let liveRepo;
  try {
    liveRepo = createLivePreflightRepo();
  } catch (error) {
    return staticChecks.map((check) => ({
      ...check,
      ok: false,
      live: true,
      liveStatus: "failed",
      detail: `${check.detail ?? "static probe failed"} · live preflight repository failed: ${redactProviderText(errorMessage(error))}`,
    }));
  }
  try {
    return await Promise.all(staticChecks.map(async (check, index) => {
      const runtime = [...runtimes.values()][index].runtime;
      const live = await livePreflight(runtime, liveRepo, timeoutSec);
      const liveDetail = live.status === "done"
        ? `live done · usage ${formatUsage(live.usage)} · cost ${formatCost(live.costUsd)}`
        : `live ${live.status} · ${live.error?.code ?? "provider_error"}: ${redactProviderText(live.error?.message ?? "generation failed")} · usage ${formatUsage(live.usage)} · cost ${formatCost(live.costUsd)}`;
      return {
        ...check,
        ok: check.ok && live.status === "done",
        live: true,
        liveStatus: live.status,
        usage: live.usage,
        costUsd: live.costUsd,
        detail: `${check.detail ?? "static probe failed"} · ${liveDetail}`,
      };
    }));
  } finally {
    rmSync(liveRepo, { recursive: true, force: true });
  }
}

/** @param {number|undefined} configured */
function livePreflightTimeout(configured) {
  const raw = configured ?? (process.env.INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC === undefined
    ? 15
    : Number(process.env.INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC));
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new TypeError("preflight live timeout must be a positive number of seconds");
  }
  return raw;
}

/** @returns {string} */
function createLivePreflightRepo() {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-preflight-"));
  const result = spawnSync("git", ["init", "-q", directory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`git init failed${result.stderr ? `: ${redactProviderText(result.stderr)}` : ""}`);
  }
  return directory;
}

/**
 * @param {RuntimeSnapshot} runtime
 * @returns {RuntimeSnapshot}
 */
function safeLiveRuntime(runtime) {
  if (runtime.driver === "codex") return { ...runtime, sandbox: "read-only" };
  if (runtime.driver === "claude" || runtime.driver === "glm") return { ...runtime, permissionMode: "plan" };
  return { ...runtime };
}

/**
 * @param {RuntimeSnapshot} runtime
 * @param {string} cwd
 * @param {number} timeoutSec
 * @returns {Promise<ProviderEnvelope>}
 */
function livePreflight(runtime, cwd, timeoutSec) {
  const safeRuntime = safeLiveRuntime(runtime);
  let command;
  try {
    command = providerCommand(safeRuntime, LIVE_PREFLIGHT_PROMPT);
  } catch (error) {
    return Promise.resolve({
      status: "failed",
      result: null,
      continuationId: null,
      usage: emptyUsage(),
      costUsd: null,
      error: { code: "command_invalid", message: errorMessage(error) },
    });
  }
  return new Promise((settle) => {
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
    let child;
    try {
      const env = { ...process.env };
      for (const [key, value] of Object.entries(command.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      delete env.INTENT_FACTORY_NOTIFY_BIN;
      child = /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (spawn(command.executable, command.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: [command.promptTransport === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
      }));
    } catch (error) {
      settle({
        status: "failed",
        result: null,
        continuationId: null,
        usage: emptyUsage(),
        costUsd: null,
        error: { code: "spawn_error", message: errorMessage(error) },
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let killTimer = null;
    /** @param {ProviderEnvelope} envelope */
    const finish = (envelope) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      settle(envelope);
    };
    /** @param {NodeJS.Signals} name */
    const signal = (name) => {
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-/** @type {number} */ (child.pid), name);
      } catch {}
    };
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, LIVE_PREFLIGHT_OUTPUT_LIMIT_BYTES); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, LIVE_PREFLIGHT_OUTPUT_LIMIT_BYTES); });
    child.once("error", (error) => finish({
      status: "failed",
      result: null,
      continuationId: null,
      usage: emptyUsage(),
      costUsd: null,
      error: { code: "spawn_error", message: redactProviderText(errorMessage(error)) },
    }));
    child.once("close", (exitCode, signalName) => {
      if (timedOut) {
        finish({
          status: "failed",
          result: null,
          continuationId: null,
          usage: emptyUsage(),
          costUsd: null,
          error: { code: "preflight_timeout", message: `live generation timed out after ${timeoutSec}s` },
        });
        return;
      }
      /** @type {ProviderEnvelope} */
      let envelope;
      try {
        envelope = normalizeProviderResult(safeRuntime, stdout, exitCode, signalName);
      } catch (error) {
        envelope = {
          status: "failed",
          result: null,
          continuationId: null,
          usage: emptyUsage(),
          costUsd: null,
          error: { code: "invalid_output", message: redactProviderText(errorMessage(error)) },
        };
      }
      if (envelope.error) envelope.error = { ...envelope.error, message: redactProviderText(envelope.error.message) };
      finish(envelope);
    });
    timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 100);
    }, timeoutSec * 1_000);
    if (command.promptTransport === "stdin") child.stdin.end(command.input);
  });
}

/** @param {string} current @param {Uint8Array|string} chunk @param {number} limit */
function appendBounded(current, chunk, limit) {
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  return (combined.length > limit ? combined.subarray(combined.length - limit) : combined).toString("utf8");
}

/** @param {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}|undefined} usage */
function formatUsage(usage) {
  if (!usage) return "in - out - cache -";
  return `in ${compactMetric(usage.inputTokens)} out ${compactMetric(usage.outputTokens)} cache ${compactMetric(usage.cacheReadInputTokens)}`;
}

/** @param {number|null|undefined} value */
function compactMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

/** @param {number|null|undefined} value */
function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "-";
}

/** @param {string} value */
function redactProviderText(value) {
  let result = String(value);
  for (const secret of Object.values(process.env)) {
    if (typeof secret === "string" && secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

/**
 * @param {ValidatedContract} contract
 * @returns {string[]}
 */
function reusedDoneWarnings(contract) {
  /** @type {string[]} */
  const warnings = [];
  const runsDir = join(contract.cwd, ".runs");
  if (!existsSync(runsDir)) return warnings;
  const ownRunDir = join(runsDir, contract.id);
  for (const name of readdirSync(runsDir)) {
    const otherRunDir = join(runsDir, name);
    const nodeDir = join(otherRunDir, "nodes");
    if (otherRunDir === ownRunDir || !existsSync(nodeDir)) continue;
    const relevantNodes = contract.nodes.filter((node) => existsSync(join(nodeDir, `${node.id}.json`)));
    if (!relevantNodes.length) continue;
    const otherContractPath = join(otherRunDir, "contract.json");
    if (!existsSync(otherContractPath)) throw new TypeError(`missing persisted contract ${otherContractPath}`);
    // A historical contract may reference paths that no longer exist (e.g. a
    // rename); reusing its done nodes is best-effort and must not block a new run.
    let otherContract;
    try {
      otherContract = validateContract(JSON.parse(readFileSync(otherContractPath, "utf8")), otherContractPath, { persisted: true });
    } catch {
      continue;
    }
    for (const node of relevantNodes) {
      const statePath = join(nodeDir, `${node.id}.json`);
      const otherNode = otherContract.nodes.find((candidate) => candidate.id === node.id);
      if (!otherNode) continue;
      try {
        if (validateNodeSnapshot(JSON.parse(readFileSync(statePath, "utf8")), otherNode).status === "done") warnings.push(`node ${node.id} is already done in run ${name}`);
      } catch {
        // Historical snapshots are advisory only. A snapshot written by an
        // older protocol revision must not prevent a new run from starting;
        // the new run still validates its own contract and snapshots strictly.
      }
    }
  }
  return warnings;
}

/**
 * @param {string} command
 * @param {string} target
 * @param {string[]} [extraArgs]
 * @returns {DetachedChild}
 */
function detachSelf(command, target, extraArgs = []) {
  const nonce = randomUUID();
  const child = /** @type {DetachedChild} */ (spawn(process.execPath, [fileURLToPath(import.meta.url), command, target, ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: nonce },
    detached: process.platform !== "win32", stdio: "ignore",
  }));
  child.unref();
  child.bootstrapNonce = nonce;
  child.bootstrapProcessStartToken = processStartToken(child.pid ?? null);
  return child;
}

/**
 * @param {string} runDir
 * @param {number} pid
 * @param {DetachedChild|null} [child]
 * @param {number} [timeoutMs]
 * @returns {Promise<BootstrapRecord>}
 */
async function waitForBootstrap(runDir, pid, child = null, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const nonce = child?.bootstrapNonce;
  if (!nonce) throw new Error(`detached bootstrap has no start nonce for pid ${pid}`);
  if (!validBootstrapNonce(nonce) || child.pid !== pid) throw new Error(`detached bootstrap has invalid child identity for pid ${pid}`);
  let expectedProcessStartToken = child.bootstrapProcessStartToken ?? null;
  let exited = false;
  child?.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    const childExited = exited || child?.exitCode !== null || child?.signalCode !== null;
    if (expectedProcessStartToken === null && !childExited) expectedProcessStartToken = processStartToken(pid);
    for (const path of [bootstrapAttemptPath(runDir, nonce), bootstrapPath(runDir)]) {
      try {
        const bootstrap = /** @type {BootstrapRecord} */ (readJson(path));
        const childIdentity = bootstrapMatchesChild(bootstrap, pid, nonce, expectedProcessStartToken);
        if (bootstrap.status === "failed" && bootstrapFailureMatchesChild(bootstrap, pid, nonce, expectedProcessStartToken)) {
          cleanupBootstrapAttempts(runDir);
          throw new Error(`detached bootstrap failed: ${bootstrap.error}`);
        }
        const lock = readLock(runDir);
        const currentOwner = lockOwnedBy(lock, pid, expectedProcessStartToken);
        if (!childExited && bootstrap.status === "ready" && childIdentity && currentOwner && runIsNonterminal(runDir)) {
          cleanupBootstrapAttempts(runDir);
          try {
            writeBootstrapAcknowledgement(runDir, bootstrap, expectedProcessStartToken);
          } catch (error) {
            cleanupBootstrapNonce(runDir, nonce);
            throw error;
          }
          return bootstrap;
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          cleanupBootstrapNonce(runDir, nonce);
          cleanupBootstrapAttempts(runDir);
          throw error;
        }
      }
    }
    if (childExited) {
      try {
        const failure = /** @type {BootstrapRecord} */ (readJson(bootstrapAttemptPath(runDir, nonce)));
        if (failure.status === "failed" && bootstrapFailureMatchesChild(failure, pid, nonce, expectedProcessStartToken)) {
          cleanupBootstrapAttempts(runDir);
          throw new Error(`detached bootstrap failed: ${failure.error}`);
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          cleanupBootstrapNonce(runDir, nonce);
          cleanupBootstrapAttempts(runDir);
          throw error;
        }
      }
      cleanupBootstrapNonce(runDir, nonce);
      cleanupBootstrapAttempts(runDir);
      throw new Error(`detached bootstrap failed before readiness for pid ${pid}`);
    }
    await delay(50);
  }
  cleanupBootstrapNonce(runDir, nonce);
  cleanupBootstrapAttempts(runDir);
  throw new Error(`detached bootstrap did not become ready for pid ${pid}`);
}

/**
 * @param {string} runDir
 * @param {BootstrapRecord} bootstrap
 * @param {string|null} expectedProcessStartToken
 */
function writeBootstrapAcknowledgement(runDir, bootstrap, expectedProcessStartToken) {
  if (!bootstrap.nonce) throw new Error("bootstrap record has no nonce");
  writeJsonAtomic(bootstrapAckPath(runDir, bootstrap.nonce), {
    status: "acknowledged",
    nonce: bootstrap.nonce,
    pid: bootstrap.pid ?? null,
    processStartToken: expectedProcessStartToken,
    at: new Date().toISOString(),
  });
}

/**
 * @param {string} runDir
 * @param {{nonce: string, pid: number, processStartToken: string|null}} expected
 * @returns {Promise<void>}
 */
export async function waitForBootstrapAcknowledgement(runDir, expected) {
  if (!validBootstrapNonce(expected.nonce)) return;
  const deadline = Date.now() + 5_000;
  const path = bootstrapAckPath(runDir, expected.nonce);
  try {
    while (Date.now() < deadline) {
      try {
        const acknowledgement = /** @type {BootstrapRecord} */ (readJson(path));
        if (
          acknowledgement.status === "acknowledged" &&
          acknowledgement.nonce === expected.nonce &&
          acknowledgement.pid === expected.pid &&
          sameProcessStartToken(acknowledgement.processStartToken, expected.processStartToken)
        ) {
          return;
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await delay(25);
    }
  } finally {
    cleanupBootstrapNonce(runDir, expected.nonce);
  }
}

/**
 * @param {string} runDir
 * @param {string} nonce
 */
function cleanupBootstrapNonce(runDir, nonce) {
  if (!validBootstrapNonce(nonce)) return;
  for (const path of [bootstrapAttemptPath(runDir, nonce), bootstrapAckPath(runDir, nonce)]) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/**
 * @param {string} runDir
 * @returns {boolean}
 */
function runIsNonterminal(runDir) {
  try {
    const contractPath = join(runDir, "contract.json");
    const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
    const nodes = readRunNodes(runDir, contract);
    return nodes.length > 0 && nodes.some((node) => !TERMINAL.has(node.status));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * @param {string} command
 * @param {string|undefined} target
 * @returns {string|null}
 */
function bootstrapRunDir(command, target) {
  try {
    if (command === "run") {
      if (!target) return null;
      const path = resolve(target);
      const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
      return join(contract.cwd, ".runs", contract.id);
    }
    if (["resume", "cancel"].includes(command)) {
      if (!target) return null;
      return resolve(target);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {string} command
 * @param {string|undefined} target
 * @param {Error} error
 */
function writeBootstrapFailure(command, target, error) {
  const runDir = bootstrapRunDir(command, target);
  if (!runDir || !existsSync(runDir)) return;
  const nonce = validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE) ? process.env.INTENT_FACTORY_BOOTSTRAP_NONCE : null;
  const failure = { status: "failed", pid: process.pid, processStartToken: processStartToken(process.pid), runDir, nonce, at: new Date().toISOString(), error: error.message };
  if (command === "run" && existsSync(join(runDir, "contract.json"))) return;
  /** @type {BootstrapRecord|null} */
  let current = null;
  try {
    current = /** @type {BootstrapRecord} */ (readJson(bootstrapPath(runDir)));
    const controllerLock = readLock(runDir);
    const currentOwnerActive = current.status === "ready" && current.pid !== process.pid
      && lockOwnedBy(controllerLock, current.pid, current.processStartToken);
    if (currentOwnerActive) return;
  } catch (readError) {
    if (errorCode(readError) !== "ENOENT") return;
  }
  // Only a detached bootstrap child records an attempt file for its own nonce;
  // a --detach parent that observed the failure must not recreate attempt
  // artifacts with an ambient nonce it does not own.
  if (nonce && !process.argv.includes("--detach") && !(current?.status === "ready" && current.pid === process.pid)) {
    try { writeJsonAtomic(bootstrapAttemptPath(runDir, nonce), failure); } catch {}
  }
  try { writeJsonAtomic(bootstrapPath(runDir), failure); } catch {}
}

/**
 * @param {import("./lock.mjs").ReadLockResult} lock
 * @param {number|undefined} pid
 * @param {string|null|undefined} processStartToken
 * @returns {boolean}
 */
function lockOwnedBy(lock, pid, processStartToken) {
  return lock !== null && !lock.invalid && lock.pid === pid
    && sameProcessStartToken(lock.processStartToken, processStartToken);
}

/** @returns {boolean} */
export function hasDetachedBootstrapNonce() {
  if (!validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)) return false;
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * @returns {string}
 */
export function bootstrapNonceForProcess() {
  return validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)
    ? /** @type {string} */ (process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)
    : randomUUID();
}

/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const COMMAND_OPTIONS = {
  run: { detach: { type: "boolean" } },
  resume: { detach: { type: "boolean" }, node: { type: "string" }, reconcile: { type: "string" } },
  cancel: {},
  preflight: { static: { type: "boolean" }, json: { type: "boolean" } },
  validate: {},
  status: { json: { type: "boolean" } },
  report: { json: { type: "boolean" } },
  findings: {},
  doctor: { cwd: { type: "string" }, json: { type: "boolean" }, discover: { type: "boolean" } },
  metrics: METRICS_OPTIONS,
};

/**
 * Strict per-command parsing: unknown options, missing positionals, and extra
 * positionals are rejected. Flags are scoped to the commands that declare them.
 *
 * @param {string[]} argv
 * @param {boolean} [quiet]
 * @returns {{command: string, target: string|undefined, values: Record<string, unknown>}|null}
 */
function parseCli(argv, quiet = false) {
  const [command, ...rest] = argv;
  if (!command || !COMMAND_OPTIONS[command]) return null;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: COMMAND_OPTIONS[command], allowPositionals: true, strict: true });
  } catch (error) {
    if (!quiet) process.stderr.write(`${errorMessage(error)}\n`);
    return null;
  }
  if (parsed.positionals.length > 1) return null;
  if (command !== "doctor" && parsed.positionals.length !== 1) return null;
  return {
    command,
    target: parsed.positionals[0],
    values: /** @type {Record<string, unknown>} */ (parsed.values),
  };
}

/**
 * The retry-in-place options of a `resume` invocation, validated before any
 * lock is taken.
 *
 * @param {Record<string, unknown>} values
 * @returns {{node?: string, reconcile?: string}}
 */
function resumeOptionsOf(values) {
  const node = typeof values.node === "string" && values.node ? values.node : undefined;
  const reconcile = typeof values.reconcile === "string" && values.reconcile ? values.reconcile : undefined;
  return { node, reconcile };
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv[0] === "campaign") { await campaignCli(argv.slice(1)); return; }
  if (argv[0] === "contract") { contractCli(argv.slice(1)); return; }
  const parsed = parseCli(argv);
  if (!parsed) { usage(); return; }
  const { command, values } = parsed;
  const target = parsed.target;
  if (command === "doctor") {
    const ok = await doctorCommand(target, {
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
      json: values.json === true,
      discover: values.discover === true,
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (!target) { usage(); return; }
  if (command === "run") {
    const absolute = resolve(target);
    const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
    const runDir = join(contract.cwd, ".runs", contract.id);
    if (values.detach === true) {
      if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
      for (const warning of [...contract.warnings, ...reusedDoneWarnings(contract)]) process.stdout.write(`[warn] ${warning}\n`);
      const child = detachSelf("run", target);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[run] ${contract.id} detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    for (const warning of [...contract.warnings, ...reusedDoneWarnings(contract)]) process.stdout.write(`[warn] ${warning}\n`);
    const result = await runContract(target);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "resume") {
    const resumeOptions = resumeOptionsOf(values);
    if (values.detach === true) {
      const runDir = resolve(target);
      if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
      const extraArgs = [
        ...(resumeOptions.node ? ["--node", resumeOptions.node] : []),
        ...(resumeOptions.reconcile ? ["--reconcile", resumeOptions.reconcile] : []),
      ];
      const child = detachSelf("resume", target, extraArgs);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[resume] detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    const result = await resumeRun(target, resumeOptions);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "cancel") { await cancelRun(target); return; }
  if (command === "preflight") {
    const absolute = resolve(target);
    const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
    const checks = await preflightContract(absolute, { static: values.static === true });
    const environment = environmentPreflight({
      cwd: contract.cwd,
      runtimes: reachableRuntimes(contract),
      driverVersions: Object.fromEntries(checks.map((check) => [check.id, check.version])),
    });
    const ok = environment.ok && checks.every((check) => check.ok);
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        contractId: contract.id,
        ok,
        environment: environment.checks,
        checks: checks.map((check) => ({
          id: check.id,
          driver: check.driver,
          executable: check.executable,
          model: check.model,
          version: check.version,
          ok: check.ok,
          live: check.live === true,
          liveStatus: check.liveStatus ?? null,
          usage: check.usage ?? null,
          costUsd: check.costUsd ?? null,
          detail: check.detail,
        })),
      })}\n`);
    } else {
      for (const check of environment.checks) process.stdout.write(`[${check.ok ? "ok" : check.advisory ? "warn" : "fail"}] ${check.name} · ${check.detail}\n`);
      for (const check of checks) process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.id} · ${check.detail}\n`);
    }
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "status") {
    const runDir = resolve(target);
    if (values.json === true) {
      process.stdout.write(renderStatusJson(runDir));
      return;
    }
    const status = renderStatus(runDir);
    writeTextAtomic(join(runDir, "STATUS.md"), status);
    try {
      renderRunHandoff(runDir);
    } catch (error) {
      process.stderr.write(`[warn] campaign handoff render failed: ${errorMessage(error)}\n`);
    }
    process.stdout.write(status);
    return;
  }
  if (command === "report") {
    process.stdout.write(values.json === true ? renderReportJson(resolve(target)) : renderReport(resolve(target)));
    return;
  }
  if (command === "metrics") { process.stdout.write(renderCampaignMetrics(target, values)); return; }
  if (command === "findings") { process.stdout.write(renderFindings(resolve(target))); return; }
  if (command === "validate") { validateContractFile(resolve(target)); return; }
  usage();
}

function usage() {
  process.stderr.write(
    "usage: runner.mjs <run|validate|preflight> <contract.json> [--detach] | " +
    "<resume|cancel> <run-dir> [--detach] | " +
    "<status|report> <run-dir> [--json] | findings <run-dir> | " +
    "doctor [<contract.json>] [--cwd <dir>] [--discover] [--json] | contract <prune|validate> ... | " +
    "metrics <campaign-id> [--cwd <dir>] [--json] | " +
    "campaign <init|attach|note|resolve|close|show|list> ...\n",
  );
  process.exitCode = 2;
}

// A closed stdout pipe (orphaned monitor, ended pipeline) must never kill a
// controller through an unhandled EPIPE. Run state lives in the run directory;
// console output is advisory.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const isMain = process.argv[1] && sameFile(process.argv[1], import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  const parsed = parseCli(process.argv.slice(2), true);
  const command = parsed?.command;
  const target = parsed?.target;
  writeBootstrapFailure(command ?? "", target, error);
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});

/**
 * @param {string|undefined} left
 * @param {string} right
 * @returns {boolean}
 */
function sameFile(left, right) {
  try { return realpathSync(resolve(left ?? "")) === realpathSync(new URL(right)); } catch { return false; }
}
