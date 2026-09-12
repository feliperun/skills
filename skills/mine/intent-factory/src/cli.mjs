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
} from "./engine/prompts.mjs";
import { normalizeProviderResult, probeRuntime, providerCommand } from "./harnesses/index.mjs";
import { modelsCommand } from "./harnesses/catalogue.mjs";
import { doctorCommand, environmentPreflight, reachableRuntimes, timeVerificationCommands } from "./host/preflight.mjs";
import { renderFindings, renderReport, renderReportJson, renderStatus, renderStatusJson } from "./report/render.mjs";

import {
  bootstrapAckPath,
  bootstrapAttemptPath,
  bootstrapPath,
  cleanupBootstrapAttempts,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from "./run/store.mjs";
import {
  acquire as acquireLock,
  bootstrapFailureMatchesChild,
  bootstrapMatchesChild,
  processStartToken,
  readLock,
  sameProcessStartToken,
  validBootstrapNonce,
} from "./run/lock.mjs";
import { renderRunHandoff } from "./campaign/index.mjs";
import { campaignCli } from "./cli/campaign.mjs";
import { contractCli, validateContractFile } from "./cli/contract.mjs";
import { METRICS_OPTIONS, renderCampaignMetrics } from "./campaign/metrics.mjs";
import { cancelRun, readRunNodes, resumeRun, runContract } from "./engine/scheduler.mjs";

import { delay, errorCode, errorMessage } from "./util.mjs";
import { bootstrapNonceForProcess, cleanupBootstrapNonce, waitForBootstrapAcknowledgement } from "./engine/detach.mjs";
import { render } from "./report/final.mjs";
import { emptyUsage } from "./run/usage.mjs";
import { validateContract } from "./contract/index.mjs";
import { validateNodeSnapshot } from "./contract/snapshot.mjs";

/** @typedef {import("./contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("./contract/index.mjs").RunMetadata} RunMetadata */
/** @typedef {import("./contract/index.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("./contract/index.mjs").EventRecord} EventRecord */
/** @typedef {import("./contract/index.mjs").Usage} Usage */
/** @typedef {import("./contract/index.mjs").GateResult} GateResult */
/** @typedef {import("./contract/index.mjs").SnapshotError} SnapshotError */
/** @typedef {import("./contract/index.mjs").BoundedScope} BoundedScope */
/** @typedef {import("./run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("./harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("./harnesses/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("./harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("./campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./engine/lifecycle.mjs").Job} Job */
/** @typedef {import("./engine/lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./engine/scheduler.mjs").RunOutcome} RunOutcome */
/** @typedef {import("node:child_process").ChildProcess & {bootstrapNonce?: string, bootstrapProcessStartToken?: string|null}} DetachedChild */
/** @typedef {{status?: string, nonce?: string, pid?: number, processStartToken?: string|null, holderId?: string, generation?: number, error?: unknown, runDir?: string}} BootstrapRecord */

export { runContract, resumeRun, cancelRun } from "./engine/scheduler.mjs";

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
  if (runtime.harness === "codex") return { ...runtime, sandbox: "read-only" };
  if (runtime.harness === "dsh") return { ...runtime, sandbox: "read-only" };
  if (runtime.harness === "claude") return { ...runtime, permissionMode: "plan" };
  // `plan` is the ZCode mode that reads without writing; the adapter's own
  // default is `yolo`, which a preflight prompt must never reach.
  if (runtime.harness === "zcode") return { ...runtime, permissionMode: "plan" };
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
        envelope = normalizeProviderResult(safeRuntime, stdout, exitCode, signalName, { stderr });
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
 * @param {import("./run/lock.mjs").ReadLockResult} lock
 * @param {number|undefined} pid
 * @param {string|null|undefined} processStartToken
 * @returns {boolean}
 */
function lockOwnedBy(lock, pid, processStartToken) {
  return lock !== null && !lock.invalid && lock.pid === pid
    && sameProcessStartToken(lock.processStartToken, processStartToken);
}

/**
 * Whether this process is a detached bootstrap child of the CLI: it carries a
 * launcher-issued nonce *and* this file is what was executed. The second half
 * is why this stays here and not in `engine/detach.mjs` -- `evals/run.mjs` and
 * the tests import `runContract` directly, and an inherited nonce must not make
 * them wait for an acknowledgement nobody will write.
 *
 * @returns {boolean}
 */
export function hasDetachedBootstrapNonce() {
  if (!validBootstrapNonce(process.env.INTENT_FACTORY_BOOTSTRAP_NONCE)) return false;
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const COMMAND_OPTIONS = {
  run: { detach: { type: "boolean" } },
  resume: { detach: { type: "boolean" }, node: { type: "string" }, reconcile: { type: "string" } },
  cancel: {},
  preflight: { static: { type: "boolean" }, json: { type: "boolean" }, "time-verification": { type: "boolean" } },
  validate: {},
  status: { json: { type: "boolean" } },
  report: { json: { type: "boolean" } },
  findings: {},
  doctor: { cwd: { type: "string" }, json: { type: "boolean" }, discover: { type: "boolean" } },
  models: { probe: { type: "boolean" }, json: { type: "boolean" } },
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
  if (command === "models" && parsed.positionals.length !== 0) return null;
  if (command !== "doctor" && command !== "models" && parsed.positionals.length !== 1) return null;
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
  if (command === "models") {
    await modelsCommand({ probe: values.probe === true, json: values.json === true });
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
    const result = await runContract(target, { detachedBootstrap: hasDetachedBootstrapNonce() });
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
    const result = await resumeRun(target, { ...resumeOptions, detachedBootstrap: hasDetachedBootstrapNonce() });
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
      harnessVersions: Object.fromEntries(checks.map((check) => [check.id, check.version])),
    });
    // Opt-in: this actually runs the contract's verification commands, so it
    // costs whatever they cost. It is the only check that can prove a command
    // fits the timeout the contract gives it.
    const timing = values["time-verification"] === true ? timeVerificationCommands(contract) : [];
    const ok = environment.ok && checks.every((check) => check.ok) && timing.every((check) => check.ok || check.advisory);
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        contractId: contract.id,
        ok,
        environment: [...environment.checks, ...timing],
        checks: checks.map((check) => ({
          id: check.id,
          harness: check.harness,
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
      for (const check of [...environment.checks, ...timing]) process.stdout.write(`[${check.ok ? "ok" : check.advisory ? "warn" : "fail"}] ${check.name} · ${check.detail}\n`);
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
    "usage: runner.mjs <run|validate> <contract.json> [--detach] | preflight <contract.json> [--static] [--time-verification] [--json] | " +
    "<resume|cancel> <run-dir> [--detach] | " +
    "<status|report> <run-dir> [--json] | findings <run-dir> | " +
    "doctor [<contract.json>] [--cwd <dir>] [--discover] [--json] | models [--probe] [--json] | " +
    "contract validate <contract.json> | " +
    "metrics <campaign-id> [--cwd <dir>] [--json] | " +
    "campaign <init|watch|attach|note|resolve|close|show|list|sync|ack> ...\n",
  );
  process.exitCode = 2;
}

// A closed stdout pipe (orphaned monitor, ended pipeline) must never kill a
// controller through an unhandled EPIPE. Run state lives in the run directory;
// console output is advisory.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

/**
 * Dispatch one CLI invocation, recording a bootstrap failure before reporting
 * it so a `--detach` launcher watching the run directory sees why its child
 * died. Exported because `bin/intent-factory.mjs` is the installed entry point
 * and `import.meta.url` cannot see it.
 *
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
export async function runCli(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (error) {
    const parsed = parseCli(argv, true);
    writeBootstrapFailure(parsed?.command ?? "", parsed?.target, error instanceof Error ? error : new Error(errorMessage(error)));
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

// `node src/cli.mjs …` still works, and the tests and evals invoke it that way.
// A detached child is always spawned as this file (see spawnDetached), so the
// nonce check below keeps working whichever entry the launcher itself used.
if (process.argv[1] && sameFile(process.argv[1], import.meta.url)) runCli();

/**
 * @param {string|undefined} left
 * @param {string} right
 * @returns {boolean}
 */
function sameFile(left, right) {
  try { return realpathSync(resolve(left ?? "")) === realpathSync(new URL(right)); } catch { return false; }
}
