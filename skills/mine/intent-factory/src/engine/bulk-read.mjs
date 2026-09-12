/**
 * One question about many files, answered without the files ever entering the
 * asking context: the exact bytes are packed into a single temp file, a
 * delegated provider reads that one file and answers in bullets, and only the
 * bullets come back. Packing, table-driven delegation routing, and the
 * usage.jsonl accounting of a delegation live here because all three are
 * engine work; the CLI shape belongs to cli.mjs and the command build to the
 * adapter registry.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DECLARED_MODEL_CATALOGUES, stableJsonDocument } from "../harnesses/catalogue.mjs";
import { READ_LINE_LIMIT, normalizeProviderResult, providerCommand } from "../harnesses/index.mjs";
import { appendUsageRecord, emptyUsage } from "../run/usage.mjs";
import { errorMessage, fail } from "../util.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "./runtime-discovery.mjs";

/** Fixed-size copy buffer: the pack is built through this, never through a corpus-sized string. */
const CHUNK_BYTES = 64 * 1024;
/** Answer budget: bullets are small, so anything past this is a runaway provider, not evidence. */
const ANSWER_LIMIT_BYTES = 512 * 1024;
/** Rough bytes-per-token heuristic, not a measurement; it only sizes windows an order apart. */
const CORPUS_BYTES_PER_TOKEN = 4;
/** Wall clock for one delegated read+answer. Not measured; generous on purpose, SIGKILL backs the SIGTERM. */
const DELEGATION_TIMEOUT_MS = 300_000;

/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("./process.mjs").Invocation} Invocation */

/**
 * A routing-table entry: the same shape `DISCOVERY_RUNTIME_DEFINITIONS` carries,
 * with `vendor` optional because routing never compares vendors.
 *
 * @typedef {{harness: string, model: string, vendor?: string, tier?: number, costRank?: number, config?: Record<string, unknown>}} BulkReadRuntime
 */

/** @typedef {{question: string, paths: string[], cwd?: string, runtimes?: Record<string, BulkReadRuntime>}} BulkReadOptions */

/** @typedef {{status: "done"|"refused"|"failed", result: string|null, runtimeId: string|null, usage: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}|null, costUsd: number|null, reason: string|null, error: {code: string, message: string}|null}} BulkReadResult */

/**
 * Copy every path's exact bytes into one pack file through a fixed-size chunk
 * buffer — header, byte-a-byte content, footer, no inserted newlines — so no
 * buffer or string the size of the corpus is ever allocated. Line counts cover
 * content only, the way the delegation floor is measured.
 *
 * @param {string[]} paths
 * @param {string} packPath
 * @returns {{bytes: number, lines: number, files: number}}
 */
export function writeBulkReadPack(paths, packPath) {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const out = openSync(packPath, "wx", 0o600);
  let bytes = 0;
  let lines = 0;
  try {
    for (const path of paths) {
      const header = `<file path="${path.replaceAll("\"", "&quot;")}">`;
      bytes += writeSync(out, header, null, "utf8");
      const fd = openSync(path, "r");
      try {
        let read;
        while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          for (let index = 0; index < read; index += 1) {
            if (chunk[index] === 0x0a) lines += 1;
          }
          bytes += writeSync(out, chunk, 0, read);
        }
      } finally {
        closeSync(fd);
      }
      bytes += writeSync(out, "</file>", null, "utf8");
    }
  } finally {
    closeSync(out);
  }
  return { bytes, lines, files: paths.length };
}

/**
 * Sort key mirroring the discovery allocation law: tier first, costRank
 * second, declaration order through sort stability.
 *
 * @param {BulkReadRuntime} runtime
 * @returns {[number, number]}
 */
function bulkReadOrder(runtime) {
  return [runtime.tier ?? runtime.costRank ?? Number.MAX_SAFE_INTEGER, runtime.costRank ?? Number.MAX_SAFE_INTEGER];
}

/**
 * The declared context window of a runtime's model, from the catalogue the
 * `models` report already keeps. `null` means undeclared, and an undeclared
 * window is no reason to refuse a runtime.
 *
 * @param {BulkReadRuntime} runtime
 * @returns {number|null}
 */
function declaredContextWindow(runtime) {
  const model = (DECLARED_MODEL_CATALOGUES[runtime.harness] ?? []).find((entry) => entry.id === runtime.model);
  return model?.contextWindowTokens ?? null;
}

/**
 * The cheapest table entry whose declared window holds the corpus.
 *
 * @param {Record<string, BulkReadRuntime>} runtimes
 * @param {number} corpusTokens
 * @returns {string|null}
 */
function selectBulkReadRuntime(runtimes, corpusTokens) {
  return Object.entries(runtimes)
    .filter(([, runtime]) => {
      const window = declaredContextWindow(runtime);
      return window === null || corpusTokens <= window;
    })
    .sort((left, right) => {
      const [leftTier, leftRank] = bulkReadOrder(left[1]);
      const [rightTier, rightRank] = bulkReadOrder(right[1]);
      return leftTier - rightTier || leftRank - rightRank;
    })
    .at(0)?.[0] ?? null;
}

/**
 * @param {string} packPath
 * @param {number} files
 * @param {string} question
 * @returns {string}
 */
function delegationPrompt(packPath, files, question) {
  return [
    `Answer one question about ${files} files packed into one file.`,
    `Read ${packPath}. It holds each file's exact bytes wrapped as <file path="...">…</file>.`,
    "Answer with bullets only. Every bullet starts with the exact symbol name or file:line number it concerns. No greeting, no prose.",
    `Question: ${question}`,
  ].join("\n");
}

/**
 * @typedef {{startedAt: string, stdout: string, stderr: string, exitCode: number|null, signal: string|null, spawnError: string|null}} DelegationObservation */

/**
 * The runner environment plus the command's env overlay — a null overlay value
 * removes the ambient variable, the same contract the spawn gate applies.
 *
 * @param {Record<string, string|null>|undefined} overlay
 * @returns {NodeJS.ProcessEnv}
 */
function environmentWith(overlay) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Spawn one delegated provider with the command `providerCommand` builds — the
 * same argv, prompt transport, and env overlay every other invocation uses —
 * and collect a bounded answer.
 *
 * @param {HarnessRuntime} runtime
 * @param {string} prompt
 * @param {string} cwd
 * @returns {Promise<DelegationObservation>}
 */
function invokeDelegation(runtime, prompt, cwd) {
  const command = providerCommand(runtime, prompt);
  /** @type {DelegationObservation} */
  const observation = { startedAt: new Date().toISOString(), stdout: "", stderr: "", exitCode: null, signal: null, spawnError: null };
  return new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd,
        env: environmentWith(command.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      observation.spawnError = errorMessage(error);
      resolve(observation);
      return;
    }
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(observation);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      observation.stdout = (observation.stdout + chunk).slice(-ANSWER_LIMIT_BYTES);
    });
    child.stderr?.on("data", (chunk) => {
      observation.stderr = (observation.stderr + chunk).slice(-4096);
    });
    // stdin adapters own the prompt stream; argv adapters carry it in args and
    // still get their unused stdin pipe closed.
    child.stdin?.on("error", () => {
      // A provider exiting before draining stdin is not a failure of the answer.
    });
    child.stdin?.end(command.promptTransport === "stdin" ? command.input ?? undefined : undefined);
    timer = setTimeout(() => {
      observation.signal = "SIGTERM";
      child.kill("SIGTERM");
      // A delegation that outlives its SIGTERM gets SIGKILL five seconds later.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, DELEGATION_TIMEOUT_MS);
    child.once("error", (error) => {
      observation.spawnError = errorMessage(error);
      finish();
    });
    child.once("close", (exitCode, signal) => {
      observation.exitCode = exitCode;
      observation.signal = observation.signal ?? signal;
      finish();
    });
  });
}

/**
 * Record the delegation in the owning run's usage.jsonl when the controller
 * exported the run directory and node it belongs to. A human terminal exports
 * neither, and the accounting is skipped without error.
 *
 * @param {string} runtimeId
 * @param {HarnessRuntime} runtime
 * @param {ProviderEnvelope} envelope
 * @param {DelegationObservation} observation
 */
function accountDelegation(runtimeId, runtime, envelope, observation) {
  const runDir = process.env.INTENT_FACTORY_RUN_DIR;
  const nodeId = process.env.INTENT_FACTORY_NODE_ID;
  if (!runDir || !nodeId) return;
  appendUsageRecord(runDir, /** @type {Invocation} */ ({
    id: randomUUID(),
    runId: basename(runDir),
    nodeId,
    role: "worker",
    runtimeId,
    model: runtime.model,
    usage: envelope.usage,
    costUsd: envelope.costUsd ?? null,
    startedAt: observation.startedAt,
    closedAt: new Date().toISOString(),
  }));
}

/** @param {string} reason @returns {BulkReadResult} */
function refused(reason) {
  return { status: "refused", result: null, runtimeId: null, usage: null, costUsd: null, reason, error: null };
}

/**
 * Ask one question about many files. Refuses — never tolerates — a corpus the
 * delegation floor says to read directly, and a corpus no declared window
 * holds.
 *
 * @param {BulkReadOptions} options
 * @returns {Promise<BulkReadResult>}
 */
export async function bulkRead(options) {
  const question = options.question.trim();
  const paths = [...new Set(options.paths.map((path) => path.trim()).filter(Boolean))];
  if (!question) throw fail("invalid_options", "bulk-read requires a question");
  if (!paths.length) throw fail("invalid_options", "bulk-read requires at least one path");
  for (const path of paths) {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw fail("invalid_path", `not a readable file: ${path}`);
  }
  const runtimes = options.runtimes ?? DISCOVERY_RUNTIME_DEFINITIONS;
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-bulk-read-"));
  const packPath = join(directory, "corpus.pack");
  try {
    const pack = writeBulkReadPack(paths, packPath);
    if (pack.lines < READ_LINE_LIMIT) {
      return refused(`corpus is ${pack.lines} lines across ${pack.files} files, below the ${READ_LINE_LIMIT}-line delegation floor — read the files directly`);
    }
    const corpusTokens = Math.ceil(pack.bytes / CORPUS_BYTES_PER_TOKEN);
    const runtimeId = selectBulkReadRuntime(runtimes, corpusTokens);
    if (!runtimeId) {
      return refused(`corpus of ~${corpusTokens} tokens fits no declared runtime context window — split the paths or read the files directly`);
    }
    const runtime = /** @type {HarnessRuntime} */ ({ ...runtimes[runtimeId], id: runtimeId });
    const observation = await invokeDelegation(runtime, delegationPrompt(packPath, pack.files, question), options.cwd ?? process.cwd());
    const envelope = observation.spawnError !== null
      ? {
        status: /** @type {"failed"} */ ("failed"),
        result: null,
        continuationId: null,
        usage: emptyUsage(),
        costUsd: null,
        error: { code: "spawn_error", message: observation.spawnError },
      }
      : normalizeProviderResult(runtime, observation.stdout, observation.exitCode, observation.signal, { stderr: observation.stderr });
    accountDelegation(runtimeId, runtime, envelope, observation);
    if (envelope.status !== "done" && envelope.status !== "no-op") {
      return {
        status: "failed",
        result: null,
        runtimeId,
        usage: envelope.usage,
        costUsd: envelope.costUsd ?? null,
        reason: null,
        error: envelope.error ?? { code: `provider_${envelope.status}`, message: observation.stderr.split(/\r?\n/u).filter(Boolean).at(-1) ?? envelope.status },
      };
    }
    return { status: "done", result: envelope.result ?? "", runtimeId, usage: envelope.usage, costUsd: envelope.costUsd ?? null, reason: null, error: null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The CLI shape, in the `modelsCommand` pattern: normalize the parsed options,
 * run the work, write the report. Bullets go to stdout on success; a refusal
 * or failure explains itself on stderr and fails the exit code.
 *
 * @param {{question?: unknown, paths?: unknown, json?: boolean}} options
 * @returns {Promise<void>}
 */
export async function bulkReadCommand(options = {}) {
  const question = typeof options.question === "string" ? options.question.trim() : "";
  const paths = (Array.isArray(options.paths) ? options.paths : [])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!question || !paths.length) throw fail("invalid_options", "bulk-read requires --question <text> and --paths <a,b,c>");
  const result = await bulkRead({ question, paths });
  if (options.json === true) {
    process.stdout.write(stableJsonDocument(result));
  } else if (result.status === "done") {
    process.stdout.write(`${(result.result ?? "").trim()}\n`);
  } else {
    process.stderr.write(`[bulk-read] ${result.reason ?? `${result.error?.code ?? "failed"}: ${result.error?.message ?? ""}`}\n`);
  }
  if (result.status !== "done") process.exitCode = 1;
}
