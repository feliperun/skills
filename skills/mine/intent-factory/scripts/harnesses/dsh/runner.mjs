/**
 * Intent Factory's DeepSeek Harness client: one prompt on stdin, one JSONL
 * transcript on stdout, no interactive surface. The adapter runs this file
 * under `process.execPath`, so spawning it never depends on a shebang, an
 * executable bit, or `node` being on the provider's PATH.
 *
 * Why JSON-RPC instead of `dsh --profile headless`: headless discards every
 * usage chunk it receives and prints the answer alone, so the tokens the
 * controller records would be invented. `--profile sdk` streams every session
 * event, including `assistant/message.data.usage`, and closes the turn with a
 * structured reason whose `error.code` carries the provider's own QUOTA or
 * RATE_LIMIT verdict — the fact the declared failover edge depends on.
 *
 * Transcript, the only thing this process writes to stdout:
 *   {"type":"dsh.started","sessionId":string}
 *   {"type":"dsh.message","text":string}          one per non-empty assistant message
 *   {"type":"dsh.completed","sessionId":string,"result":string,"usage":Usage}
 *   {"type":"dsh.failed","sessionId":string,"kind":string,"error":{...},"usage":Usage}
 * where Usage is `{inputTokens, outputTokens, cacheReadInputTokens}` with
 * `inputTokens` excluding the cached prefix, matching `canonicalUsage`.
 */

import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const HANDSHAKE_ID = 1;
const PROMPT_ID = 2;

/** Effective provider name for a failed harness start with no protocol output. */
const HARNESS_EXIT_CODE = "harness_exit";

/** @typedef {{dsh: string, provider: string|null, model: string|null, reasoning: string|null, sandbox: string|null, patches: string[]}} RunnerOptions */

/**
 * @param {string[]} argv
 * @returns {RunnerOptions}
 */
function parseArgs(argv) {
  /** @type {RunnerOptions} */
  const options = {
    dsh: "dsh",
    provider: null,
    model: null,
    reasoning: null,
    sandbox: null,
    patches: [],
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== "string") throw new Error(`${flag} needs a value`);
    if (flag === "--dsh") options.dsh = value;
    else if (flag === "--provider") options.provider = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--reasoning") options.reasoning = value;
    else if (flag === "--sandbox") options.sandbox = value;
    else if (flag === "--patch") options.patches.push(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!options.provider) throw new Error("--provider is required");
  if (!options.model) throw new Error("--model is required");
  return options;
}

/**
 * Whole-line writes to fd 1: `process.exit` cannot lose an unfinished write.
 *
 * @param {Record<string, unknown>} event
 */
function emit(event) {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  for (let written = 0; written < line.length; ) written += writeSync(1, line, written);
}

async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number}} totals
 * @param {unknown} usage
 * @returns {boolean} whether any counter was observed
 */
function addUsage(totals, usage) {
  if (!usage || typeof usage !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (usage);
  let observed = false;
  /** @type {[string, keyof typeof totals][]} */
  const counters = [["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"], ["cacheReadTokens", "cacheReadInputTokens"]];
  for (const [source, target] of counters) {
    const value = record[source];
    if (typeof value === "number" && Number.isFinite(value)) {
      totals[target] += value;
      observed = true;
    }
  }
  return observed;
}

/** @param {unknown} reason @returns {{kind: string, error: {code: string, message: string, retryAfterMs?: number} | null}} */
function describeReason(reason) {
  const record = reason && typeof reason === "object" ? /** @type {Record<string, unknown>} */ (reason) : {};
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  const failure = record.error && typeof record.error === "object" ? /** @type {Record<string, unknown>} */ (record.error) : null;
  if (!failure) return { kind, error: null };
  const code = typeof failure.code === "string" ? failure.code : kind;
  const message = typeof failure.message === "string" ? failure.message : `${code}`;
  const retryAfterMs = failure.providerRetryAfterMs;
  const retryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {};
  return { kind, error: { code, message, ...retryAfter } };
}

const options = parseArgs(process.argv.slice(2));
const prompt = await readPrompt();
const sessionId = `intent-factory-${process.pid}-${Date.now().toString(36)}`;
const env = { ...process.env };
// The harness owns the boundary: `sandbox` names the file-effect mode the
// contract asked for, and DSH derives its approval policy from the same value.
if (options.sandbox) env.DSH_PERMISSION_MODE = options.sandbox;

const args = ["--profile", "sdk"];
for (const patch of options.patches) args.push("--patch", patch);
const child = spawn(options.dsh, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });

const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
let sawUsage = false;
/** @type {string[]} */
const texts = [];
let stderrTail = "";
let buffered = "";
let prompted = false;
let settled = false;

/** @param {Record<string, unknown>} event @param {number} exitCode */
function settle(event, exitCode) {
  if (settled) return;
  settled = true;
  emit({ ...event, usage: sawUsage ? usage : null });
  child.kill("SIGTERM");
  process.exit(exitCode);
}

/** @param {string} kind @param {{code: string, message: string, retryAfterMs?: number}} error @param {number} [exitCode] */
function fail(kind, error, exitCode = 1) {
  settle({ type: "dsh.failed", sessionId, kind, error }, exitCode);
}

/** @param {Record<string, any>} event */
function fold(event) {
  if (event.type === "assistant/message") {
    const data = event.data && typeof event.data === "object" ? /** @type {Record<string, unknown>} */ (event.data) : {};
    sawUsage = addUsage(usage, data.usage) || sawUsage;
    const message = data.message && typeof data.message === "object" ? /** @type {Record<string, unknown>} */ (data.message) : {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : "")).join("");
    if (text.trim()) {
      texts.push(text);
      // Every message, not only the last: a judge that returns two verdicts
      // must be visible as two, and the adapter counts them here.
      emit({ type: "dsh.message", text });
    }
    return;
  }
  if (event.type !== "turn/end") return;
  const data = event.data && typeof event.data === "object" ? /** @type {Record<string, unknown>} */ (event.data) : {};
  const { kind, error } = describeReason(data.reason);
  if (kind === "completed") {
    settle({ type: "dsh.completed", sessionId, result: texts.at(-1) ?? "" }, 0);
    return;
  }
  fail(kind, error ?? { code: kind, message: `the turn ended: ${kind}` });
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout carries the JSON-RPC transport only; a non-JSON line is a
      // harness defect, not provider prose, and must not be silently dropped.
      fail("invalid_protocol", { code: "invalid_protocol", message: `the harness wrote a non-JSON line: ${line.slice(0, 200)}` });
      return;
    }
    if (message.id === HANDSHAKE_ID) {
      if (message.error) {
        fail("initialize_failed", { code: "initialize_failed", message: JSON.stringify(message.error).slice(0, 512) });
        return;
      }
      if (prompted) continue;
      prompted = true;
      emit({ type: "dsh.started", sessionId });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: PROMPT_ID,
        method: "session/prompt",
        params: { sessionId, contentBlocks: [{ type: "text", text: prompt }] },
      })}\n`);
      continue;
    }
    if (message.id === PROMPT_ID && message.error) {
      fail("prompt_rejected", { code: "prompt_rejected", message: JSON.stringify(message.error).slice(0, 512) });
      return;
    }
    if (message.method === "session.event" && message.params?.sessionId === sessionId && message.params.event) {
      fold(message.params.event);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-4096);
  process.stderr.write(chunk);
});

child.on("error", (error) => {
  fail(HARNESS_EXIT_CODE, { code: HARNESS_EXIT_CODE, message: `cannot start ${options.dsh}: ${error.message}` });
});

child.on("close", (code) => {
  const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-512)}` : "";
  fail(HARNESS_EXIT_CODE, {
    code: HARNESS_EXIT_CODE,
    message: `the harness exited with code ${code ?? 1} before the turn ended${detail}`,
  });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    child.kill(/** @type {NodeJS.Signals} */ (signal));
    process.exit(1);
  });
}

child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: HANDSHAKE_ID,
  method: "initialize",
  params: {
    cwd: process.cwd(),
    provider: options.provider,
    model: options.model,
    ...(options.reasoning ? { reasoningEffort: options.reasoning } : {}),
  },
})}\n`);

process.on("exit", () => {
  // `settle` already asked the harness to stop; only an exit that never
  // reached it leaves a harness that must not outlive this process.
  if (!settled) child.kill("SIGKILL");
});
