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
import { readRunNodes, runContract } from "./engine/scheduler.mjs";
import { resumeRun } from "./engine/resume.mjs";
import { cancelRun } from "./engine/cancel.mjs";

import { delay, errorCode, errorMessage } from "./util.mjs";
import { bootstrapNonceForProcess, cleanupBootstrapNonce, waitForBootstrapAcknowledgement } from "./engine/detach.mjs";
import { render } from "./report/final.mjs";
import { emptyUsage } from "./run/usage.mjs";
import { validateContract } from "./contract/index.mjs";
import { validateNodeSnapshot } from "./contract/snapshot.mjs";
import { detachSelf, waitForBootstrap, writeBootstrapFailure } from "./cli/launch.mjs";
import { preflightContract, reusedDoneWarnings } from "./engine/live-preflight.mjs";

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

export { runContract } from "./engine/scheduler.mjs";
export { resumeRun } from "./engine/resume.mjs";
export { cancelRun } from "./engine/cancel.mjs";

/** @param {number|null|undefined} value */
function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "-";
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
