/**
 * Spending one trivial token on each routed runtime before spending the run's.
 *
 * A static probe proves a binary exists and reports a version. It does not
 * prove the credential works, the quota is not spent, or the model answers --
 * and each of those fails a run several minutes in, after a worktree and a
 * campaign event already exist. So this sends a real prompt, in a throwaway git
 * repository, with every runtime clamped to its read-only mode by
 * `safeLiveRuntime`.
 *
 * Every provider string that comes back is redacted against the environment
 * before it reaches a log: a preflight failure is exactly where a token tends
 * to appear in an error message.
 */
import { emptyUsage } from "../run/usage.mjs";
import { errorMessage } from "../util.mjs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeProviderResult, probeRuntime, providerCommand } from "../harnesses/index.mjs";
import { reachableRuntimes } from "../host/preflight.mjs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { validateContract } from "../contract/index.mjs";
import { validateNodeSnapshot } from "../contract/snapshot.mjs";
import { compactCost as formatCost } from "../util.mjs";

/** @typedef {import("../harnesses/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

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
      } catch {
        // ESRCH: the child is already gone, so there is no process to signal.
      }
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
export function reusedDoneWarnings(contract) {
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
