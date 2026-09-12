import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runContract } from "../src/engine/scheduler.mjs";

import { fixture, packet, writeContract } from "./helpers.mjs";
import { validateContract } from "../src/contract/index.mjs";

/** @param {import("../src/cli.mjs").RunOutcome} result @param {string} [id] @returns {import("../src/contract/index.mjs").NodeSnapshot} */
export function nodeState(result, id = "build") {
  const state = result.states.get(id);
  if (!state) throw new Error(`missing node state for ${id}`);
  return state;
}

/** @param {string} runDir @returns {Record<string, unknown>[]} */
export function notifications(runDir) {
  const path = join(runDir, "notify.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * A completed run merges its work onto the run ref, not into the shared
 * repository's own working tree: the isolated attempt worktree that made the
 * change is already removed by the time the run finishes.
 * @param {string} repo @param {string} ref @param {string} path @returns {string}
 */
export function showRefFile(repo, ref, path) {
  return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8" });
}

/** @param {import("node:child_process").ChildProcess} child @returns {number} */
export function childPid(child) {
  if (child.pid === undefined) throw new Error("child pid unavailable");
  return child.pid;
}

/**
 * @param {string} directory
 * @param {{emitSessionId?: boolean, costUsd?: number}} [options]
 * @returns {{executable: string, requestLog: string}}
 */
export function fakeClaudeLike(directory, options = {}) {
  const executable = join(directory, "fake-claude-like.mjs");
  const requestLog = join(mkdtempSync(join(tmpdir(), "runner-fake-claude-log-")), "provider-requests.jsonl");
  const emitSessionId = options.emitSessionId !== false;
  const costUsd = options.costUsd ?? 0.2;
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("fake-claude-like 1.0.0");
else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ args, prompt: input }) + "\\n");
    const result = JSON.stringify({ status: "done", summary: "fake provider complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "result", result, ${emitSessionId ? 'session_id: args.includes("--resume") ? "session-2" : "session-1",' : ""} usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: ${costUsd} }));
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, requestLog };
}

/** @param {string[]} args @param {string} flag @returns {string|null} */
export function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] ?? null;
}

/**
 * A codex-shaped provider for the durable worker-result protocol: the worker
 * prompt carries the canonical result-file path, and each mode proves one
 * recovery property. "file-first" writes a result file that differs from its
 * final message, "missing-then-mutates" completes the first worker turn with
 * no message and no file then mutates the workspace during the one-turn
 * materialization, "missing-then-file-vs-message" materializes a file that
 * contradicts its final message, "missing-then-noop" ends the one result-only
 * turn with neither file nor message, and "revision-regrinds" writes a
 * counter-suffixed result per worker run so a gate revision must clear the
 * stale file.
 *
 * @param {string} directory
 * @param {"file-first"|"missing-then-mutates"|"missing-then-file-vs-message"|"missing-then-noop"|"revision-regrinds"} mode
 * @returns {string}
 */
export function resultFileCodex(directory, mode) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-result-file-")), `result-file-${mode}.mjs`);
  const workerCounter = join(directory, ".runs", `result-file-${mode}-workers`);
  const judgeCounter = join(directory, ".runs", `result-file-${mode}-judges`);
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const resultless = mode === "missing-then-mutates" || mode === "missing-then-file-vs-message" || mode === "missing-then-noop";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const materialization = prompt.startsWith("The implementation is already complete");
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const result = (summary) => JSON.stringify({ status: "done", summary, changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "result-file-thread" }));
    if (resultless && !materialization && !judge) {
      // Worker completes with usage but no final message and no canonical result file.
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
      return;
    }
    if (mode === "missing-then-mutates" && materialization) {
      writeFileSync("unexpected.txt", "outside the materialization authority\\n");
    }
    if (mode === "missing-then-file-vs-message" && materialization) {
      // The one result-only turn writes a canonical file that contradicts its
      // own final message: only the file is authoritative.
      if (resultPath) writeFileSync(resultPath, result("materialized from file"));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result("materialized from message") } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 6, output_tokens: 1 } }));
      return;
    }
    if (mode === "missing-then-noop" && materialization) {
      // The one result-only turn ends without the canonical file or any message.
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 6, output_tokens: 1 } }));
      return;
    }
    if (judge) {
      appendFileSync(${JSON.stringify(judgeCounter)}, "x\\n");
      const run = readFileSync(${JSON.stringify(judgeCounter)}, "utf8").trim().split("\\n").length;
      const text = run === 1
        ? JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "critical defect", findings: [{ severity: "critical", description: "broken [works]", evidence: "test failed" }] })
        : JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
      return;
    }
    appendFileSync(${JSON.stringify(workerCounter)}, "x\\n");
    const run = readFileSync(${JSON.stringify(workerCounter)}, "utf8").trim().split("\\n").length;
    const summary = mode === "file-first" ? "from message" : \`worker attempt \${run}\`;
    if (resultPath) writeFileSync(resultPath, result(mode === "file-first" ? "from file" : \`worker attempt \${run}\`));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result(summary) } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @param {string} directory @param {"file-first"|"missing-then-mutates"|"missing-then-file-vs-message"|"missing-then-noop"|"revision-regrinds"} mode @param {string} path @returns {Promise<import("../src/cli.mjs").RunOutcome>} */
export async function withResultFileCodex(directory, mode, path) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = resultFileCodex(directory, mode);
  try {
    return await runContract(path);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-mode provider whose judge always rejects the judgment item it is
 * asked to arbitrate with a cited critical finding, so the rejection is a
 * legitimate gate revision rather than an uncited protocol failure.
 *
 * @param {string} directory
 * @returns {string}
 */
export function citedGateCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-cited-gate-")), "cited-gate.mjs");
  const workerCounter = join(directory, ".runs", "cited-gate-workers");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    if (!prompt.startsWith("Review node")) {
      const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
      appendFileSync(${JSON.stringify(workerCounter)}, "x\\n");
      const run = readFileSync(${JSON.stringify(workerCounter)}, "utf8").trim().split("\\n").length;
      const result = JSON.stringify({ status: "done", summary: \`worker attempt \${run}\`, changedFiles: [], verification: [], artifacts: [], missingContext: [] });
      if (resultPath) writeFileSync(resultPath, result);
      console.log(JSON.stringify({ type: "thread.started", thread_id: "cited-gate-thread" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
      return;
    }
    const text = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "judgment item [works] is not satisfied", findings: [{ severity: "critical", description: "item [works] is not satisfied", evidence: "quality is below the bar for works" }] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "cited-gate-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} fn @returns {Promise<T>} */
export async function withCitedGateCodex(directory, fn) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = citedGateCodex(directory);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-mode provider whose judge returns a cited minor advisory verdict
 * that settles below failOn critical, with the same usage shape as the
 * generic fake codex so token-total assertions keep holding under the
 * conditional judge (uncited fail verdicts are now protocol failures).
 *
 * @param {string} directory
 * @returns {string}
 */
export function advisoryGateCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-advisory-gate-")), "advisory-gate.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const text = judge
      ? JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor advisory", findings: [{ severity: "minor", description: "minor advisory on [works]", evidence: "advisory" }] })
      : JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (!judge && resultPath) writeFileSync(resultPath, text);
    console.log(JSON.stringify({ type: "thread.started", thread_id: "advisory-gate-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} fn @returns {Promise<T>} */
export async function withAdvisoryGateCodex(directory, fn) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = advisoryGateCodex(directory);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-mode provider whose judge rejects the judgment item it is asked to
 * arbitrate with a cited critical finding, so the rejection is a legitimate
 * gate revision rather than an uncited protocol failure.
 *
 * @param {string} directory
 * @returns {string}
 */
export function brokenGateCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-broken-gate-")), "broken-gate.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const text = judge
      ? JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "critical defect", findings: [{ severity: "critical", description: "broken [works]", evidence: "test failed" }] })
      : JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (!judge && resultPath) writeFileSync(resultPath, text);
    console.log(JSON.stringify({ type: "thread.started", thread_id: "broken-gate-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} fn @returns {Promise<T>} */
export async function withBrokenGateCodex(directory, fn) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = brokenGateCodex(directory);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-shaped provider whose judge produces one review-protocol defect.
 * `two-verdicts` streams two agent messages that each carry a verdict,
 * `empty-output` ends a finished turn without any verdict, and `no-terminal`
 * streams a verdict but never its terminal envelope. With `again` the defect
 * repeats on the bounded re-ask; otherwise the re-ask returns a clean verdict.
 *
 * @param {string} directory
 * @param {"two-verdicts"|"empty-output"|"no-terminal"|"two-verdicts-then-fail"} defect
 * @param {{again?: boolean}} [options]
 * @returns {string}
 */
export function judgeDefectCodex(directory, defect, options = {}) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-judge-defect-")), `judge-defect-${defect}.mjs`);
  const calls = join(directory, ".runs", `judge-defect-${defect}${options.again ? "-again" : ""}-judges`);
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const defect = ${JSON.stringify(defect)};
const again = ${options.again ? "true" : "false"};
const calls = ${JSON.stringify(calls)};
if (process.argv.includes("--version")) {
  console.log("judge-defect 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const verdict = (summary) => JSON.stringify({ verdict: "pass", maxSeverity: "none", summary, findings: [] });
  const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
  console.log(JSON.stringify({ type: "thread.started", thread_id: "defect-thread" }));
  if (!prompt.startsWith("Review node")) {
    const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  appendFileSync(calls, "x\\n");
  const run = readFileSync(calls, "utf8").trim().split("\\n").filter(Boolean).length;
  if (run > 1 && !again && defect !== "two-verdicts-then-fail") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("clean re-ask") } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
    return;
  }
  if (defect === "two-verdicts-then-fail" && run > 1) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "re-ask provider died" } }));
    return;
  }
  if (defect === "two-verdicts") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("first verdict") } }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("second verdict") } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
    return;
  }
  if (defect === "no-terminal") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict("clean but unsealed") } }));
    return;
  }
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
});
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {"two-verdicts"|"empty-output"|"no-terminal"|"two-verdicts-then-fail"} defect @param {{again?: boolean}} options @param {() => T | Promise<T>} runner @returns {Promise<T>} */
export async function withJudgeDefectCodex(directory, defect, options, runner) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = judgeDefectCodex(directory, defect, options);
  try {
    return await runner();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/**
 * A codex-shaped provider whose worker finishes at once and whose judge keeps
 * emitting nothing past any wall-clock budget, so the judge phase is killed.
 *
 * @param {string} directory
 * @returns {string}
 */
export function stallingJudgeCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-judge-stall-")), "judge-stall.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("judge-stall 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
  console.log(JSON.stringify({ type: "thread.started", thread_id: "stall-thread" }));
  if (!prompt.startsWith("Review node")) {
    const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
});
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @template T @param {string} directory @param {() => T | Promise<T>} runner @returns {Promise<T>} */
export async function withStallingJudgeCodex(directory, runner) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = stallingJudgeCodex(directory);
  try {
    return await runner();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/** @param {string} prefix @param {Record<string, unknown>} overrides @returns {import("../src/contract/index.mjs").ValidatedContract} */
export function failoverContract(prefix, overrides) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = writeContract(directory, fixture({
    id: `${prefix}contract`,
    runtimeDefaults: { worker: "mid", judge: "mid" },
    nodes: [{ id: "build", type: "backend", runtime: "mid", taskPacket: packet(), gate: false }],
    ...overrides,
  }));
  return validateContract(JSON.parse(readFileSync(path, "utf8")), path);
}

// A fixed clock keeps these cases deterministic: the schedule is judged against
// now at both ends, so wall-clock drift must not decide the assertions.
export const RESET_NOW = Date.parse("2026-09-04T06:00:00.000Z");

export const NETWORK_NOW = Date.parse("2026-09-04T06:00:00.000Z");

export const NETWORK_DEADLINE = "2026-09-04T12:00:00.000Z";

/** Fixed jitter draw: the classification under test, not the random number generator. */
export const halfJitter = () => 0.5;

export const RUNNER_CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

/**
 * Rewrite a persisted node snapshot the way the failure being resumed would
 * have left it.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {{status: string, code: string, message?: string, blockedBy?: string[], attempt?: number}} failure
 * @returns {void}
 */
export function persistFailure(runDir, nodeId, failure) {
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({
    ...state,
    status: failure.status,
    phase: failure.status === "blocked" ? "dependency" : "worker",
    result: null,
    gate: null,
    verification: null,
    scopeFindings: null,
    attempt: failure.attempt ?? state.attempt,
    blockedBy: failure.blockedBy ?? [],
    error: { code: failure.code, message: failure.message ?? failure.code.replace(/_/g, " ") },
  }, null, 2));
}

/**
 * A codex-shaped provider whose worker prompts are logged before it completes,
 * so a test can read the prompt a retry in place regenerated.
 *
 * @param {string} directory
 * @returns {{executable: string, log: string}}
 */
export function promptLoggingCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-prompt-log-")), "prompt-log.mjs");
  const log = join(directory, ".runs", "worker-prompts.txt");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.startsWith("Review node")) {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] }) } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
      return;
    }
    appendFileSync(${JSON.stringify(log)}, input);
    const result = JSON.stringify({ status: "done", summary: "retried worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    const resultPath = /canonical result file: (\\S+\\.json)/.exec(input)?.[1];
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, log };
}

/** @template T @param {string} executable @param {() => T | Promise<T>} body @returns {Promise<T>} */
export async function withCodexBinary(executable, body) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = executable;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

/** @param {string} runDir @returns {{identityWarnings?: string[], sourceIdentity: {gitHead: string|null}}} */
export function runMetadata(runDir) {
  return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
}

/** @param {string} runDir @returns {string[]} */
export function recoveryDecisions(runDir) {
  try {
    return readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => /** @type {{recovery?: string}} */ (JSON.parse(line)).recovery ?? "");
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * A codex whose first judge turn returns two verdicts (blocking review blocks
 * as judge_unavailable) and whose later judge turns return exactly one clean
 * verdict, so the same provider can drive the resume that re-judges it.
 *
 * @param {string} directory
 * @returns {string}
 */
export function retryJudgeCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "retry-judge-")), "retry-judge.mjs");
  const judges = join(directory, ".runs", "retry-judge-calls");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const judges = ${JSON.stringify(judges)};
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean re-judge", findings: [] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "retry-judge-thread" }));
    if (!prompt.startsWith("Review node")) {
      const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
      const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
      if (resultPath) writeFileSync(resultPath, result);
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
      return;
    }
    appendFileSync(judges, "x\\n");
    const run = readFileSync(judges, "utf8").trim().split("\\n").filter(Boolean).length;
    if (run <= 2) {
      // The first round and its bounded re-ask both return two verdicts: that
      // is the judge_unavailable boundary the resume has to clear.
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
    } else {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
    }
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}
