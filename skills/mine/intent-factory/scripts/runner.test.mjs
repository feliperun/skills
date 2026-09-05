import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  renderFindings,
  renderReport,
  renderStatus,
  validateContract,
} from "./lib.mjs";
import { renderReportJson, renderStatusJson } from "./render.mjs";
import { cancelRun, preflightContract, runContract, resumeRun, superviseRun, rotationTrigger, ROTATION_AVG_CACHE_READ_TOKENS, ROTATION_HANDOFF_MAX_BYTES, ROTATION_MAX_TURNS, ROTATION_MAX_TURNS_CLAUDE_FAMILY, ROTATION_MIN_TURNS_FOR_AVERAGE } from "./runner.mjs";
import { invocationAlive, invocationResult, processStartToken, quotaResetSchedule } from "./supervisor.mjs";
import { failoverEdges, nextHop, nextSynthesizedRuntime } from "./failover.mjs";
import { NETWORK_BACKOFF_CAP_MS, NETWORK_MAX_ATTEMPTS, backoffDelayMs, classifyTransition, isRepairable, isTimeoutOrStall, networkBackoffAttempts } from "./backoff.mjs";
import { captureWorkspaceSnapshot } from "./verification.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, bootstrapPath, cleanupBootstrapAttempts, writeJsonAtomic } from "./store.mjs";
import { getDriver } from "./drivers/index.mjs";
import { deriveBudgetDecision } from "./budget.mjs";
import { buildCapsule } from "./capsule.mjs";
import { pruneRun } from "./contract-prune.mjs";
import { CAMPAIGN_PROGRESS_TYPE, readNotificationOutbox } from "./outbox.mjs";
import {
  closeResult,
  delay,
  fakeCodex,
  fakeExecJsonl,
  fixture,
  initializeGit,
  orphan,
  packet,
  readStatus,
  waitForValue,
  withFakeAgy,
  withFakeCodex,
  writeContract,
} from "../test/helpers.mjs";

/** @param {import("./runner.mjs").RunOutcome} result @param {string} [id] @returns {import("./contract.mjs").NodeSnapshot} */
function nodeState(result, id = "build") {
  const state = result.states.get(id);
  if (!state) throw new Error(`missing node state for ${id}`);
  return state;
}

function budgetProfile(overrides = {}) {
  return {
    estimatedWeightedInputTokens: 500,
    estimatedTurns: 2,
    contextWindowTokens: 10_000,
    safetyFraction: 0.75,
    minimumSegmentTokens: 100,
    growthIncrementTokens: 100,
    preambleBytes: 400,
    tokenizerEstimate: { bytes: 4, tokens: 1, source: "runner test measurement" },
    continuation: { enabled: false, maxSegments: 1, segmentReserveTokens: 0 },
    ...overrides,
  };
}

/**
 * @param {string} directory
 * @param {{continuationDelayMs?: number}} [options] hold the continuation
 *   provider silent for the given delay before announcing its session so a
 *   test can observe the persisted pending budget segment mid-run
 */
function budgetContinuationCodex(directory, options = {}) {
  const continuationDelayMs = options.continuationDelayMs ?? 0;
  const executable = join(directory, "budget-continuation-codex.mjs");
  const calls = join(directory, ".runs", "budget-continuation-calls.jsonl");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("budget-continuation-codex 1.0.0");
else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const continuation = input.startsWith("Continue node build in a fresh provider session");
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ continuation }) + "\\n");
    const announce = () => {
      console.log(JSON.stringify({ type: "thread.started", thread_id: continuation ? "segment-2" : "segment-1" }));
      if (continuation) {
        const resultPath = /file: (\\S+\\.json)/.exec(input)?.[1];
        const result = JSON.stringify({ status: "done", summary: "continued exactly once", changedFiles: ["README.md"], verification: [], artifacts: [], missingContext: [] });
        if (resultPath) writeFileSync(resultPath, result);
        console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }));
        return;
      }
      writeFileSync("README.md", "budget progress\\n");
      let turns = 0;
      setInterval(() => {
        turns += 1;
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: turns * 20, output_tokens: 1 } }));
      }, 30);
    };
    if (continuation && ${continuationDelayMs} > 0) setTimeout(announce, ${continuationDelayMs});
    else announce();
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, calls };
}

/** @param {import("node:child_process").ChildProcess} child @returns {number} */
function childPid(child) {
  if (child.pid === undefined) throw new Error("child pid unavailable");
  return child.pid;
}

/**
 * @param {string} directory
 * @param {{emitSessionId?: boolean, costUsd?: number}} [options]
 * @returns {{executable: string, requestLog: string}}
 */
function fakeClaudeLike(directory, options = {}) {
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
function flagValue(args, flag) {
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
function resultFileCodex(directory, mode) {
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

/** @param {string} directory @param {"file-first"|"missing-then-mutates"|"missing-then-file-vs-message"|"missing-then-noop"|"revision-regrinds"} mode @param {string} path @returns {Promise<import("./runner.mjs").RunOutcome>} */
async function withResultFileCodex(directory, mode, path) {
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
function citedGateCodex(directory) {
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
async function withCitedGateCodex(directory, fn) {
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
function advisoryGateCodex(directory) {
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
async function withAdvisoryGateCodex(directory, fn) {
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
function brokenGateCodex(directory) {
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
async function withBrokenGateCodex(directory, fn) {
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
 * A codex-shaped provider for automatic worker rotation. The fat session
 * emits turn events until a rotation threshold is crossed and then parks
 * until the controller terminates it; the one-turn handoff writes an
 * intentionally oversized handoff document (or misbehaves per mode); the
 * fresh rotated session completes the node. "turns" crosses the turn
 * threshold, "cache" the average cache-read threshold, "no-threshold" stays
 * under both, "no-continuation" never exposes a session identity,
 * "handoff-missing" acknowledges without writing the document, and
 * "handoff-parks" never finishes the handoff turn so cancellation lands on
 * it. "fat-log" buries the 80 threshold-crossing turns under more than
 * 128 KiB of padding events first, so the rotation only fires when live
 * monitoring keeps observing past a fixed window.
 *
 * @param {string} directory
 * @param {"turns"|"cache"|"no-threshold"|"no-continuation"|"handoff-missing"|"handoff-parks"|"fat-log"} mode
 * @returns {{executable: string, argvLog: string}}
 */
function rotatingCodex(directory, mode) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-rotating-")), `rotating-${mode}.mjs`);
  const argvLog = join(directory, ".runs", `rotating-${mode}-argv.jsonl`);
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const handoffTurn = prompt.startsWith("The worker session is being rotated");
    const freshTurn = prompt.startsWith("Continue node build in a fresh provider session");
    appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ resume: process.argv.includes("resume"), handoffTurn, freshTurn }) + "\\n");
    const result = (summary) => JSON.stringify({ status: "done", summary, changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (handoffTurn) {
      if (mode !== "handoff-missing" && mode !== "handoff-parks") {
        const handoffPath = /to: (\\S+\\.md)/.exec(prompt)?.[1];
        // Oversized on purpose: the controller must bound it to 16 KiB.
        if (handoffPath) writeFileSync(handoffPath, "## Handoff\\n\\n- done: fat session work\\n- pending: fresh session completion\\n- commands: node --test passes\\n- files: README.md\\n\\n" + "x".repeat(20 * 1024));
      }
      if (mode === "handoff-parks") { setInterval(() => {}, 60_000); return; }
      console.log(JSON.stringify({ type: "thread.started", thread_id: "fat-thread" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "handoff written" } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 6, output_tokens: 1 } }));
      return;
    }
    if (freshTurn) {
      const resultPath = /file: (\\S+\\.json)/.exec(prompt)?.[1];
      if (resultPath) writeFileSync(resultPath, result("fresh session complete"));
      console.log(JSON.stringify({ type: "thread.started", thread_id: "fresh-thread" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result("fresh session complete") } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 2 } }));
      return;
    }
    // Fat worker session: emit turn evidence, then park until rotated.
    if (mode !== "no-continuation") console.log(JSON.stringify({ type: "thread.started", thread_id: "fat-thread" }));
    if (mode === "cache") {
      // Two cumulative turn.completed records: the cache-read average is only
      // trusted across at least two observed turns, so a single completed
      // turn must never rotate a finishing invocation.
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 1, cached_input_tokens: 130000 } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, output_tokens: 1, cached_input_tokens: 260000 } }));
    } else if (mode === "no-threshold") {
      // 78 turn events plus the closing one stay strictly under 80 observed.
      for (let index = 0; index < 78; index += 1) {
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0 } }));
      }
      const resultPath = /file: (\\S+\\.json)/.exec(prompt)?.[1];
      if (resultPath) writeFileSync(resultPath, result("completed without rotation"));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result("completed without rotation") } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0 } }));
      return;
    } else {
      if (mode === "fat-log") {
        // Padding first: a fixed live window would never reach the turns.
        for (let index = 0; index < 60; index += 1) {
          console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "p".repeat(4096) } }));
        }
      }
      for (let index = 0; index < 80; index += 1) {
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0 } }));
      }
    }
    setInterval(() => {}, 60_000);
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, argvLog };
}

/**
 * @param {string} directory
 * @param {"turns"|"cache"|"no-threshold"|"no-continuation"|"handoff-missing"|"handoff-parks"|"fat-log"} mode
 * @param {string} path
 * @returns {Promise<{result: import("./runner.mjs").RunOutcome, argvLog: string}>}
 */
async function withRotatingCodex(directory, mode, path) {
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  const { executable, argvLog } = rotatingCodex(directory, mode);
  process.env.INTENT_FACTORY_CODEX_BIN = executable;
  try {
    return { result: await runContract(path), argvLog };
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
}

test("runs the CLI through an installed symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-symlink-"));
  const contractPath = writeContract(directory, fixture({
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["build"], gate: false },
    ],
  }));
  const link = join(directory, "runner-link.mjs");
  symlinkSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, "validate", contractPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "valid\n");
});

test("doctor checks repository prerequisites without mutating anything", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  const payload = /** @type {{schemaVersion: number, ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  const names = payload.checks.map((check) => check.name);
  assert.ok(names.includes("git repository"));
  assert.ok(names.includes(".runs ignored"));
  const runsIgnored = payload.checks.find((check) => check.name === ".runs ignored");
  assert.ok(runsIgnored, ".runs ignored check present");
  assert.equal(runsIgnored.ok, true);
  assert.equal(payload.checks.some((check) => check.detail.includes("required by contract")), false, "no contract means no required driver");
  assert.equal(readdirSync(directory).sort().join(","), ".git,.gitignore", "doctor creates no run state");
});

test("doctor does not fail a driver resolved through an explicit executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-override-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const worker = join(directory, "my-worker.mjs");
  writeFileSync(worker, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('my-worker 1.0.0');\n");
  chmodSync(worker, 0o755);
  const contract = join(directory, "contract.json");
  writeFileSync(contract, `${JSON.stringify({
    schemaVersion: 2,
    contractVersion: "0.1.0",
    id: "doctor-run",
    campaignId: "doctor-campaign",
    goal: "doctor",
    cwd: ".",
    maxInputTokens: 1_000,
    usagePolicy: false,
    runtimeDefaults: { worker: "wrapped", judge: "wrapped" },
    runtimes: { wrapped: { driver: "exec-jsonl", model: "m", executable: "./my-worker.mjs" } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", phase: "doctor", dependsOn: [], taskPacket: packet(), gate: false }],
  })}\n`);
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory, contract], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const payload = /** @type {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.ok, true);
  const binaryCheck = payload.checks.find((check) => check.name === "binary exec-jsonl");
  assert.ok(binaryCheck, "exec-jsonl binary check present");
  assert.equal(binaryCheck.ok, true);
  assert.match(binaryCheck.detail, /override/u);
});

test("status --json and report --json emit stable machine-readable output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-json-status-"));
  const path = writeContract(directory, fixture({
    id: "json-status-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const status = spawnSync(process.execPath, [cli, "status", "--json", runDir], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.schemaVersion, 1);
  assert.equal(statusPayload.run, "json-status-run");
  assert.equal(statusPayload.leaseHealthy, false);
  assert.equal(statusPayload.nodes[0].status, "done");
  const report = spawnSync(process.execPath, [cli, "report", "--json", runDir], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  const reportPayload = JSON.parse(report.stdout);
  assert.equal(reportPayload.schemaVersion, 1);
  assert.equal(reportPayload.totals.inputTokens, 10);
  assert.equal(reportPayload.nodes[0].revisions, 0);
});

test("incident freeze rejects resume mutations while status and report remain readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-incident-freeze-"));
  const path = writeContract(directory, fixture({ id: "incident-freeze-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(runDir, "incident-freeze.json"), "{}\n");
  await assert.rejects(
    () => resumeRun(runDir),
    (error) => error instanceof Error && /** @type {{code?: string}} */ (error).code === "incident_frozen",
  );
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  for (const command of ["status", "report"]) {
    const result = spawnSync(process.execPath, [cli, command, "--json", runDir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
  }
});

test("cancel subcommand terminates a stale running node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-cli-"));
  const path = writeContract(directory, fixture({
    id: "cancel-cli-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const cli = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "cancel", runDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const node = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(node.status, "canceled");
  assert.equal(readFileSync(join(runDir, "cancel.request.json"), "utf8").length > 0, true);
});

test("run --detach leaves a controller that outlives the invoker and completes the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-detach-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", "--detach", contractPath], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/\[run\] ([a-z0-9-]+) detached · pid (\d+) · (.+)/u);
  assert.ok(match, result.stdout);
  assert.equal(match[1], contract.id);
  assert.equal(match[3], runDir);
  const pid = Number(match[2]);
  try {
    // The invoker is already gone; the controller must still be alive while the run is in flight.
    const alive = await waitForValue(() => {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch {
        return readStatus(nodePath) === "done" ? "done" : null;
      }
    }, 10_000);
    assert.ok(alive === "alive" || alive === "done", `detached controller died while the run was in flight: ${alive}`);
    assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
    assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).pid, pid);
  } finally {
    cleanupBootstrapAttempts(runDir);
    const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    if (invocationAlive({ pid, processStartToken: metadata.processStartToken })) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});

test("resume --detach restarts a failed node through a detached controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-detach-resume-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  await withFakeCodex(directory, "worker-fail", () => runContract(contractPath));
  assert.equal(readStatus(nodePath), "failed");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[resume\] detached · pid \d+ · .*/u);
  assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
});

test("runs a worker and treats minor judge findings as advisory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-run-"));
  const contract = fixture({
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  });
  const path = writeContract(directory, contract);
  const result = await withAdvisoryGateCodex(directory, () => runContract(path));
  assert.equal(result.ok, true);
  assert.equal(nodeState(result).status, "done");
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /minor advisory/u);
});

test("runs a full contract through the generic exec-jsonl driver end to end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-jsonl-run-"));
  const fake = join(directory, "fake-jsonl.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-jsonl 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.type !== "run.request" || request.schemaVersion !== 1) process.exit(2);
  const judge = request.prompt.startsWith("Review node");
  const result = judge
    ? JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor advisory", findings: [{ severity: "minor", description: "style on [works]", evidence: "line 1" }] })
    : JSON.stringify({ status: "done", summary: "jsonl worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "jsonl-thread" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "message", text: "working" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "jsonl-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 }, costUsd: 0.01 }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "jsonl-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 1);
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.maxSeverity, "minor");
  assert.equal(state.gate?.summary, "minor advisory");
  assert.equal(state.usage?.inputTokens, 10, "worker and judge usage both accrue");
  assert.equal(state.usage?.outputTokens, 4);
  assert.equal(state.usage?.cacheReadInputTokens, 2);
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /minor advisory/u);
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.worker.jsonl")), true, "normalized protocol events are persisted");
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.judge.jsonl")), true, "judge protocol events are persisted");
});

test("blocks a structured blocked_context worker result without invoking a judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-blocked-context-"));
  const path = writeContract(directory, fixture({
    id: "blocked-context-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const result = await withFakeCodex(directory, "blocked-context", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "blocked node records an error");
  assert.equal(state.error.code, "context_missing");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  const artifact = JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8"));
  assert.equal(artifact.nodes[0].error.code, "context_missing");
  assert.deepEqual(artifact.nodes[0].missingContext, ["missing.txt"]);
});

test("discovery blocked_context maps to the blocked terminal state, not an invalid-result retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-discovery-blocked-context-"));
  const path = writeContract(directory, fixture({
    id: "discovery-blocked-context-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "discover",
      type: "backend",
      taskPacket: packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Find the entrypoint" }),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "blocked-context", () => runContract(path));
  const state = nodeState(result, "discover");
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "discovery blocked node records an error");
  assert.equal(state.error.code, "context_missing");
  assert.deepEqual(/** @type {{missingContext: string[]}} */ (state.result).missingContext, ["missing.txt"]);
  assert.equal(state.attempt, 1);
  assert.equal(state.revisions, 0);
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("resume preserves a terminal blocked_context node without re-running or judging it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-blocked-context-"));
  const path = writeContract(directory, fixture({
    id: "resume-blocked-context-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: {} }],
  }));
  const runDir = await withFakeCodex(directory, "blocked-context", async () => (await runContract(path)).runDir);

  // A provider that would complete the node proves the blocked outcome is not re-executed.
  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "resumed blocked node records an error");
  assert.equal(state.error.code, "context_missing");
  assert.deepEqual(/** @type {{missingContext: string[]}} */ (state.result).missingContext, ["missing.txt"]);
  assert.equal(state.attempt, 1);
  assert.ok(!readdirSync(join(resumed.runDir, "logs")).some((name) => name.includes("judge")));
});

test("worker result with prose before the JSON still parses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-prose-json-"));
  const path = writeContract(directory, fixture({
    id: "prose-json-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "prose-json", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{status: string}} */ (state.result).status, "done");
  assert.deepEqual(
    JSON.parse(readFileSync(join(result.runDir, "results", "build.json"), "utf8")),
    state.result,
    "a valid provider fallback is durably materialized in the run-owned result file",
  );
});

test("canonical worker result file wins over the redundant provider message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-result-file-first-"));
  const path = writeContract(directory, fixture({
    id: "result-file-first-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "file-first", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "from file", "the run-owned file is authoritative over the final message");
});

test("result-only materialization rejects workspace mutation outside its authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-result-mutates-"));
  const path = writeContract(directory, fixture({
    id: "result-mutates-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-mutates", path);
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.match(state.error?.message ?? "", /result materialization changed workspace paths/u);
  assert.equal((state.invocations ?? []).length, 2, "exactly one result-only continuation ran");
});

test("resume adoption treats the canonical result file as primary evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-file-first-"));
  const path = writeContract(directory, fixture({
    id: "resume-file-first-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  // The provider message and its operation settlement both say "worker
  // complete"; the canonical file is rewritten to disagree.
  writeFileSync(join(runDir, "results", "build.json"), JSON.stringify({
    status: "done", summary: "from canonical file", changedFiles: [], verification: [], artifacts: [], missingContext: [],
  }));
  orphan(runDir, "build");

  // With the provider stream intact, adoption must still follow the file.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "from canonical file");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume adoption follows the canonical file when the provider stream is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-file-only-"));
  const path = writeContract(directory, fixture({
    id: "resume-file-only-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(runDir, "results", "build.json"), JSON.stringify({
    status: "done", summary: "from canonical file", changedFiles: [], verification: [], artifacts: [], missingContext: [],
  }));
  // Removing the transcript leaves only the settlement and the file; without
  // the file this would restart completed work instead of adopting it.
  for (const name of readdirSync(join(runDir, "logs"))) {
    if (name.endsWith(".worker.jsonl")) unlinkSync(join(runDir, "logs", name));
  }
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "from canonical file");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume judge recovery surfaces an invalid canonical result file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-judge-invalid-file-"));
  const path = writeContract(directory, fixture({
    id: "resume-judge-invalid-file-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  // The judge completed, but the durable result file is corrupt. Presence is
  // authoritative: judge-phase recovery must not fall back to the worker
  // transcript, which still holds a valid final message.
  writeFileSync(join(runDir, "results", "build.json"), "not the result protocol\n");
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "failed", "the transcript result must not be adopted through judge recovery");
  assert.equal(state.result, null);
  assert.equal(state.revisions, 1, "the invalid durable record consumed the gate revision");
  assert.equal((state.invocations ?? []).length, 3, "the revision retried the worker exactly once");
});

test("resume of an interrupted result materialization adopts the file with strict scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-materialized-"));
  const path = writeContract(directory, fixture({
    id: "resume-materialized-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-file-vs-message", path);
  assert.equal(nodeState(result).status, "done");
  // The controller "crashes" after the one result-only turn: rewind the node
  // to running so resume must recover the materialization invocation itself.
  orphan(result.runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(result.runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "materialized from file", "the canonical file outranks the recovered provider message");
  assert.equal((state.invocations ?? []).length, 2, "recovery schedules no fresh worker");
  assert.equal(state.attempt, 1);
});

test("resume of an interrupted result materialization rejects declared-path mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-materialized-mutation-"));
  const path = writeContract(directory, fixture({
    id: "resume-materialized-mutation-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-file-vs-message", path);
  orphan(result.runDir, "build");
  // README.md is a declared packet write file: the lenient worker check would
  // accept this change, but a result-only turn had no authority to make it.
  writeFileSync(join(directory, "README.md"), "mutated across the recovery window\\n");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(result.runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.match(state.error?.message ?? "", /result materialization changed workspace paths/u);
});

test("resume of a resultless materialization turn fails terminally instead of rerunning the worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-materialized-noop-"));
  const path = writeContract(directory, fixture({
    id: "resume-materialized-noop-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "missing-then-noop", path);
  assert.equal(nodeState(result).status, "failed");
  assert.equal(nodeState(result).error?.code, "missing_worker_result");
  orphan(result.runDir, "build");

  // A provider that would happily run a generic worker must never be invoked:
  // the single result-only turn was already spent.
  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(result.runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "missing_worker_result");
  assert.equal((state.invocations ?? []).length, 2, "no third invocation was spawned");
  assert.equal(state.attempt, 1);
});

test("a gate revision clears the stale canonical result file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-result-regrind-"));
  const path = writeContract(directory, fixture({
    id: "result-regrind-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const result = await withResultFileCodex(directory, "revision-regrinds", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 1);
  assert.equal(
    /** @type {{summary: string}} */ (state.result).summary,
    "worker attempt 2",
    "the fresh worker attempt must not reuse the previous attempt's result file",
  );
});

test("invalid worker result consumes a bounded revision before failing terminally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-invalid-result-"));
  const path = writeContract(directory, fixture({
    id: "invalid-result-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 1 } }],
  }));
  const result = await withFakeCodex(directory, "prose-retry", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 1);
  assert.equal(state.attempt, 2);
});

test("a spent repair blocks on protocol_failure and raises attention when no failover edge remains", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-invalid-result-terminal-"));
  const path = writeContract(directory, fixture({
    id: "invalid-result-terminal-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await withFakeCodex(directory, "prose-retry", () => runContract(path));
  const state = nodeState(result);
  // One runtime, no revision left: there is nowhere to route the protocol
  // failure, so the node stops visibly rather than filing a quiet exhaustion.
  assert.equal(state.status, "blocked");
  assert.ok(state.error, "invalid worker result records an error");
  assert.equal(state.error.code, "protocol_failure");
  assert.equal(state.revisions, 0);
  assert.equal(state.routing?.history?.length ?? 0, 0, "a blocked protocol failure records no route");
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "protocol_failure"));
});

test("a second unparseable worker result takes the failover edge before it blocks with attention", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-protocol-failover-"));
  const first = fakeCodex(directory, "prose-retry");
  const second = fakeCodex(directory, "prose-retry");
  const path = writeContract(directory, fixture({
    id: "protocol-failover-run",
    pollIntervalMs: 10,
    runtimeRules: [],
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, costRank: 1 },
      second: { driver: "codex", model: "second", executable: second, costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "protocol_failure");
  assert.equal(state.revisions, 0, "a protocol failover never consumes a gate revision");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
  const history = state.routing?.history ?? [];
  assert.equal(history.length, 1, "exactly one edge before the chain is spent");
  assert.equal(history[0].errorCode, "protocol_failure");
  assert.equal(history[0].nextRuntime, "second");
  assert.equal(history[0].hop, 1);
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "protocol_failure"));
});

test("fails deterministic verification before the judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-fail-"));
  const path = writeContract(directory, fixture({
    id: "verification-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }), gate: {} }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  assert.ok(state.verification, "verification state persisted");
  assert.ok(state.verification.commands, "verification commands persisted");
  // Default repeat is 1: the last worker attempt's single command run replaces
  // the phase state.
  assert.equal(state.verification.commands[0].attempts.length, 1);
  assert.equal(state.verification.completed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  assert.equal(state.verification.attempts.length, 1);
  assert.equal(new Set(state.verification.attempts.map((attempt) => attempt.invocationId)).size, 1);
  assert.ok(state.verification.attempts.every((attempt) => attempt.status === "failed" && Number.isInteger(attempt.pid) && Number.isInteger(attempt.processGroupId)));
  assert.equal(state.attempt, 2);
  assert.equal(state.revisions, 1);
  assert.ok(state.gate, "verification failure still records a gate");
  assert.equal(state.gate.verdict, "fail");
  assert.equal(state.gate.maxSeverity, "critical");
  assert.match(state.gate.findings[0].evidence, /exit=2/u);
});

test("oversized judge prompt fails before judge spawn or persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-prompt-cap-"));
  const path = writeContract(directory, fixture({
    id: "judge-prompt-cap-run",
    pollIntervalMs: 10,
    // The judge must be required (a judgment item) for the prompt cap to bite:
    // a purely mechanical Definition of Done now settles without a judge.
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: /** @type {import("./definition-of-done.mjs").DefinitionOfDoneItem[]} */ ([
        { id: "huge-0", text: "x".repeat(2 * 1024), judgment: true },
        ...Array.from({ length: 40 }, (_, index) => ({ id: `huge-${index + 1}`, text: "y".repeat(2 * 1024), proof: { kind: "command", ref: "true" } })),
      ]),
      taskPacket: packet(),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "judge prompt cap records an error");
  assert.equal(state.error.code, "judge_prompt_too_large");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0);
});

test("skips the judge when every Definition of Done item is mechanical", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-mechanical-gate-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-mechanical-gate-out-"));
  const script = join(outDir, "mechanical-proof.mjs");
  const marker = join(outDir, "proved.txt");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "proved");\n`);
  const fake = join(directory, "mechanical-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("mechanical-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "mech" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "mech", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "mechanical-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "marker", text: "marker file exists", proof: { kind: "command", ref: `${process.execPath} ${script}` } }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass", "the mechanical gate records a green verdict");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge invocation for a purely mechanical Definition of Done");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  assert.equal(readFileSync(marker, "utf8"), "proved", "the mechanical proof command ran in the contract workspace");
});

test("invokes the judge with the deterministic checklist when a judgment item exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judgment-gate-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judgment-gate-out-"));
  writeFileSync(join(directory, "proved.txt"), "proved");
  const promptPath = join(outDir, "judge-prompt.txt");
  const fake = join(directory, "judgment-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("judgment-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    writeFileSync(${JSON.stringify(promptPath)}, request.prompt);
    const result = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "quality passes", findings: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judgment-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [
        { id: "proved", text: "marker file exists", proof: { kind: "path", ref: "proved.txt" } },
        { id: "quality", text: "the result is high quality", judgment: true },
      ],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 1, "the judgment item invokes the judge");
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.judge.jsonl")), true, "judge protocol events are persisted");
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /Judgment items — arbitrate only these:\n- \[quality\]/u);
  assert.match(prompt, /Deterministic items — already proven by the controller/u);
  assert.match(prompt, /- \[proved\] PASS — marker file exists \(proof: path proved\.txt\)/u);
  assert.match(prompt, /do not re-arbitrate them/u);
  assert.match(prompt, /Arbitrate only the judgment items/u);
});

test("a failing mechanical proof rejects the worker generation without any judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-mechanical-fail-"));
  const fake = join(directory, "mechanical-fail-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("mechanical-fail-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "mech" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "mech", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "mechanical-fail-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "must-pass", text: "the check passes", proof: { kind: "command", ref: `${process.execPath} -e ${JSON.stringify("process.exit(3)")}` } }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "mechanical_gate_failed");
  assert.equal(state.revisions, 1, "a failing mechanical proof consumes a bounded revision like deterministic verification");
  assert.equal(state.attempt, 2);
  assert.equal(state.gate?.verdict, "fail");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge was ever invoked");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("an uncited judge rejection re-asks once then blocks attention without consuming a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptOne = join(outDir, "judge-prompt-1.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(promptOne)} : ${JSON.stringify(promptTwo)}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(state.attempt, 1);
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "judge_protocol"));
});

test("skips the judge for an empty Definition of Done checklist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-empty-dod-gate-"));
  const judgeCalls = join(directory, ".runs", "empty-dod-judge-calls.txt");
  const fake = join(directory, "empty-dod-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("empty-dod-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    appendFileSync(${JSON.stringify(judgeCalls)}, "x\\n");
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "unexpected-judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: "not a structured judge result", continuationId: "unexpected-judge", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "empty-dod-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass", "an empty checklist settles mechanically with a green verdict");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "an empty Definition of Done never invokes the judge");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")), "no judge protocol events for an empty Definition of Done");
  assert.ok(!existsSync(judgeCalls), "the judge provider is never spawned for an empty Definition of Done");
});

test("an uncited fail below the gate failOn threshold is a judge protocol failure, not a pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-below-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-below-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptOne = join(outDir, "judge-prompt-1.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "major", summary: "major but uncited", findings: [{ severity: "major", description: "the work needs rework", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-below-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-below-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(promptOne)} : ${JSON.stringify(promptTwo)}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-below-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(state.attempt, 1);
  assert.equal(state.gate?.verdict, "fail", "the below-threshold verdict is recorded");
  assert.equal(state.gate?.maxSeverity, "major", "an uncited major fail under failOn [critical] is a protocol failure, not a pass");
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "the bounded re-ask still applies below the failOn threshold");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "judge_protocol"));
});

test("a judge protocol re-ask over a mixed checklist neither reruns mechanical proofs nor consumes a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-mixed-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-mixed-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const proofRuns = join(outDir, "proof-runs.txt");
  const proofScript = join(outDir, "counting-proof.mjs");
  // Passes on its first execution and fails on every later one, so a re-ask
  // that reran it would turn the mechanical gate red instead of blocking.
  writeFileSync(proofScript, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(proofRuns)}, "x\\n");\nprocess.exit(readFileSync(${JSON.stringify(proofRuns)}, "utf8").trim().split("\\n").filter(Boolean).length > 1 ? 1 : 0);\n`);
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-mixed-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-mixed-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(join(outDir, "judge-prompt-1.txt"))} : ${JSON.stringify(join(outDir, "judge-prompt-2.txt"))}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-mixed-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [
        { id: "proved", text: "the proof command runs", proof: { kind: "command", ref: `${process.execPath} ${proofScript}` } },
        { id: "quality", text: "the result is high quality", judgment: true },
      ],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "the judge protocol failure never consumes a worker revision");
  assert.equal(state.attempt, 1);
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal(readFileSync(proofRuns, "utf8").trim().split("\n").filter(Boolean).length, 1, "the mechanical proof runs exactly once and is not rerun by the re-ask");
  assert.match(readFileSync(join(outDir, "judge-prompt-2.txt"), "utf8"), /already proven by the controller/u);
});

test("the judge re-ask bound survives a controller crash in either gap because it is persisted with the node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-reask-durable-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-reask-durable-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const runDir = join(directory, ".runs", "judge-reask-durable-run");
  // Crash images the controller itself persisted, taken at the two instants a
  // standalone marker left open: the write that dispatches the bounded re-ask,
  // and the moment its verdict is durable while the blocked transition is not.
  // Each excludes what no successor controller inherits: the dead controller's
  // lease, its in-flight atomic temporaries and its file locks.
  const dispatchGap = join(directory, ".runs", "judge-reask-dispatch-gap");
  const verdictGap = join(directory, ".runs", "judge-reask-verdict-gap");
  /** @param {string} source @returns {boolean} */
  const inherited = (source) => !source.endsWith(".tmp") && !source.endsWith(".lock") && !source.endsWith("controller-lease.json");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "durable-provider.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("durable-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(join(outDir, "judge-prompt-1.txt"))} : ${JSON.stringify(promptTwo)}, request.prompt);
    // The re-ask is in flight and its verdict is not written yet: this is the
    // image a controller loss leaves behind between dispatch and verdict.
    if (count === 1) cpSync(${JSON.stringify(runDir)}, ${JSON.stringify(dispatchGap)}, { recursive: true, filter: ${inherited.toString()} });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: ${JSON.stringify(uncited)}, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-reask-durable-run",
    // Wide enough that the closed re-ask stays durable-but-unapplied for a
    // whole poll interval, the window the verdict-gap image is taken in.
    pollIntervalMs: 250,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: fake } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const nodePath = join(runDir, "nodes", "build.json");
  let capturedVerdictGap = false;
  const capturing = setInterval(() => {
    if (capturedVerdictGap) return;
    let persisted;
    try { persisted = JSON.parse(readFileSync(nodePath, "utf8")); } catch { return; }
    const last = /** @type {Record<string, unknown>[]} */ (persisted.invocations ?? []).at(-1);
    const spent = /** @type {Record<string, unknown>[]} */ (persisted.executionOverrides ?? []).some((item) => item.kind === "judge-reask");
    if (!spent || persisted.status !== "running" || last?.phase !== "judge" || last?.status !== "closed") return;
    capturedVerdictGap = true;
    cpSync(runDir, verdictGap, { recursive: true, filter: inherited });
  }, 5);
  const state = nodeState(await runContract(path).finally(() => clearInterval(capturing)));
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal(existsSync(join(runDir, "judge-reask")), false, "the bound is node state, not a standalone marker beside it");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);

  // Gap one: the write that spends the bound is the write that dispatches the
  // re-ask, so no crash image can hold one without the other.
  const dispatched = JSON.parse(readFileSync(join(dispatchGap, "nodes", "build.json"), "utf8"));
  assert.ok(
    /** @type {Record<string, unknown>[]} */ (dispatched.executionOverrides).some((item) => item.kind === "judge-reask"),
    "the crash image carries the bound in the node snapshot",
  );
  assert.equal(
    /** @type {Record<string, unknown>[]} */ (dispatched.invocations).filter((item) => item.phase === "judge").length,
    2,
    "the same atomic write carries the re-ask that bound permits",
  );
  const afterDispatch = nodeState(await resumeRun(dispatchGap));
  assert.equal(afterDispatch.status, "blocked", afterDispatch.error?.message);
  assert.equal(afterDispatch.phase, "judge");
  assert.equal(afterDispatch.error?.code, "judge_protocol", "the replayed re-ask blocks instead of asking a second one");
  assert.equal(afterDispatch.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(afterDispatch.attempt, 1, "the recovered re-ask does not burn a worker attempt");
  assert.equal((afterDispatch.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((afterDispatch.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "recovery replays the interrupted re-ask exactly once");

  // Gap two: the re-ask verdict is durable and the blocked transition is not,
  // so recovery reads the spent bound from the node and blocks rather than
  // treating the second uncited verdict as a first failure.
  assert.ok(capturedVerdictGap, "the controller persisted the re-ask verdict before the blocked transition");
  const afterVerdict = nodeState(await resumeRun(verdictGap));
  assert.equal(afterVerdict.status, "blocked", afterVerdict.error?.message);
  assert.equal(afterVerdict.phase, "judge");
  assert.equal(afterVerdict.error?.code, "judge_protocol", "the recovered second uncited verdict is not a first failure");
  assert.equal(afterVerdict.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal((afterVerdict.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "the recovered verdict settles the node without another judge invocation");
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "judge_protocol"));
});

test("provider diagnostics stay bounded and recovery consumes only a bounded tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-raw-bounded-"));
  const path = writeContract(directory, fixture({ id: "raw-bounded-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "large-output", () => runContract(path));
  const logs = readdirSync(join(result.runDir, "logs"));
  const rawPath = logs.find((name) => name.endsWith(".worker.jsonl"));
  assert.ok(rawPath);
  const raw = readFileSync(join(result.runDir, "logs", rawPath));
  assert.ok(raw.length <= 512 * 1024);
  assert.ok(raw.toString().includes("turn.completed"));
  const boundedInput = `${"x".repeat(700000)}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "tail", changedFiles: [], verification: [], artifacts: [], missingContext: [] }) } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`;
  const recoveryPath = join(directory, "recovery.jsonl");
  writeFileSync(recoveryPath, boundedInput);
  const recovered = invocationResult({ stdoutPath: recoveryPath }, { driver: "codex", model: "test" }, { preferStructured: false });
  assert.ok(recovered, "recovery returns an envelope");
  assert.equal(recovered.status, "done");
});

test("fails closed on unexpected writes and preserves pre-existing dirt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-"));
  writeFileSync(join(directory, "preexisting.txt"), "keep me\n");
  const path = writeContract(directory, fixture({
    id: "scope-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "unexpected write records an error");
  assert.equal(state.error.code, "unexpected_write");
  assert.ok(state.scope, "scope snapshot persisted");
  assert.ok(state.scope.unexpectedPaths.includes("unexpected.txt"));
  const scopeFindings = /** @type {{nodes: {id: string, unexpectedPaths?: string[]}[]}} */ (
    JSON.parse(readFileSync(join(directory, ".runs", "scope-run", "findings.json"), "utf8"))
  );
  assert.deepEqual(scopeFindings.nodes[0].unexpectedPaths, ["unexpected.txt"]);

  const cleanDirectory = mkdtempSync(join(tmpdir(), "runner-scope-clean-"));
  writeFileSync(join(cleanDirectory, "preexisting.txt"), "keep me\n");
  const cleanPath = writeContract(cleanDirectory, fixture({
    id: "scope-clean-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const clean = await withFakeCodex(cleanDirectory, "pass", () => runContract(cleanPath));
  assert.equal(nodeState(clean).status, "done");
});

test("a worker-created symlink cannot authorize its target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-new-symlink-"));
  writeFileSync(join(directory, "outside.txt"), "baseline\n");
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-new-symlink-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "new-symlink-escape", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt"]);
  assert.equal(readFileSync(join(directory, "outside.txt"), "utf8"), "unauthorized target\n");
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
});

test("retargeting a contained alias cannot authorize the new target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-retargeted-symlink-"));
  writeFileSync(join(directory, "src.txt"), "source\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  symlinkSync("src.txt", join(directory, "alias.txt"));
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-retargeted-symlink-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "retargeted-symlink-escape", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
});

test("a pre-existing contained alias remains an authorized write path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-contained-alias-"));
  writeFileSync(join(directory, "src.txt"), "source\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  symlinkSync("src.txt", join(directory, "alias.txt"));
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-contained-alias-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "contained-alias", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.equal(readFileSync(join(directory, "src.txt"), "utf8"), "authorized target\n");
});

test("autonomous heartbeats observe progress made through a contained alias", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-alias-heartbeat-"));
  mkdirSync(join(directory, "src"));
  symlinkSync("src", join(directory, "alias"));
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-alias-heartbeat-run",
    pollIntervalMs: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacket,
      progressPolicy: { graceSec: 0, intervalSec: 0.25, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "alias-heartbeat", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.progress?.heartbeatCount, 3);
  assert.equal(state.progress?.dryHeartbeatCount, 0);
  assert.ok(state.scope?.boundary?.roots.includes("alias"));
  assert.ok(state.scope?.boundary?.roots.includes("src"));
  assert.ok(readFileSync(join(directory, "src", "progress.txt"), "utf8"));
});

test("rejects parallel execution until isolation exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-max-parallel-"));
  const path = writeContract(directory, fixture({ maxParallel: 2 }));
  assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /maxParallel must be 1/u);
});

test("marks a silent provider stalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-stall-"));
  mkdirSync(join(directory, "work"));
  writeFileSync(join(directory, "work", "README.md"), "read me");
  const path = writeContract(directory, fixture({
    id: "stall-run",
    cwd: "work",
    pollIntervalMs: 10,
    stallTimeoutSec: 0.05,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"] }), gate: false }],
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "silent");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(nodeState(result).status, "stalled");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("preserves the worker report when the judge provider fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-fail-"));
  const path = writeContract(directory, fixture({
    id: "judge-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const result = await withFakeCodex(directory, "judge-fail", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "one bounded judge retry before blocking");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
});

test("a judge whose tool host is disabled never yields a verdict and blocks as judge_unavailable after one retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-tool-host-"));
  const path = writeContract(directory, fixture({
    id: "judge-tool-host-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const result = await withFakeCodex(directory, "judge-tool-host-disabled", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.match(state.error?.message ?? "", /code-mode host is disabled/u);
  assert.equal(state.gate, null, "no fabricated verdict is ever adopted");
  const judgeInvocations = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judgeInvocations.length, 2, "exactly one bounded judge retry after the first tool-host failure");
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "judge_unavailable"));
});

test("enforces the wall-clock cap even while output changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-"));
  const path = writeContract(directory, fixture({
    id: "timeout-run",
    pollIntervalMs: 10,
    stallTimeoutSec: 1,
    timeoutSec: 0.05,
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "heartbeat");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result).status, "exhausted");
    const timedOut = nodeState(result);
    assert.ok(timedOut.error, "timeout records an error");
    assert.equal(timedOut.error.code, "wall_clock_timeout");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("spends the wall-clock budget per phase, not per node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-budget-"));
  const path = writeContract(directory, fixture({
    id: "phase-budget-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  // The worker takes 3.5s of a 5s budget. A node-wide clock leaves the judge
  // 1.5s for work that needs 2s and kills a healthy reviewer.
  const result = await withFakeCodex(directory, "slow", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.ok(state.gate, "judge gate recorded");
  assert.equal(state.gate.summary, "minor advisory");
});

test("bounds gate retries and reports exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-retry-"));
  const path = writeContract(directory, fixture({
    id: "retry-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 1 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  assert.equal(result.ok, false);
  assert.equal(nodeState(result).status, "exhausted");
  assert.equal(nodeState(result).attempt, 2);
});

test("resume adopts an orphaned worker result instead of repeating the work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-"));
  const path = writeContract(directory, fixture({ id: "resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  unlinkSync(join(runDir, "results", "build.json"));
  orphan(runDir, "build");

  // A provider that fails every worker call proves the result came from the orphaned log.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "worker complete");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume refuses a driver that was known but is now unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-driver-drift-"));
  const path = writeContract(directory, fixture({ id: "resume-driver-drift-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  await assert.rejects(
    () => withFakeCodex(directory, "version-fail", () => resumeRun(runDir)),
    /driver probe unavailable for luna; resume refused/u,
  );
});

test("resume permits worker edits only to packet write files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-write-boundary-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "resume-write-boundary-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "write-allowed", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
});

test("resume accepts allowed changes reached through an autonomous symlink root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-symlink-root-"));
  mkdirSync(join(directory, "src"));
  symlinkSync("src", join(directory, "alias"));
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-symlink-root-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(directory, "src", "allowed.txt"), "allowed\n");
  orphan(runDir, "build");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume source identity uses the pre-execution symlink boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-scope-boundary-"));
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "outside"));
  writeFileSync(join(directory, "outside", "baseline.txt"), "outside\n");
  symlinkSync("src", join(directory, "alias"));
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-scope-boundary-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const persisted = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.deepEqual(persisted.scope.boundary.roots, ["alias", "src"]);
  unlinkSync(join(directory, "alias"));
  symlinkSync("outside", join(directory, "alias"));
  writeFileSync(join(directory, "alias", "unauthorized.txt"), "unauthorized target\n");
  orphan(runDir, "build");
  await assert.rejects(
    () => withFakeCodex(directory, "worker-fail", () => resumeRun(runDir)),
    /source drift detected in dirtyTreeFingerprint/u,
  );
});

test("resume fails closed when the persisted scope boundary is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-missing-scope-boundary-"));
  const path = writeContract(directory, fixture({ id: "resume-missing-scope-boundary-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  state.scope = null;
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  await assert.rejects(
    () => withFakeCodex(directory, "pass", () => resumeRun(runDir)),
    /persisted worker scope boundary|scope boundary/u,
  );
});

test("resume rejects source drift outside packet write files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-unexpected-drift-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "resume-unexpected-drift-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(work, "unexpected.txt"), "not in packet\n");
  orphan(runDir, "build");
  await assert.rejects(() => withFakeCodex(directory, "worker-fail", () => resumeRun(runDir)), /source drift detected in dirtyTreeFingerprint/u);
});

test("resume adopts a completed orphan judge without running it twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-gate-"));
  const path = writeContract(directory, fixture({
    id: "resume-gate-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
  assert.ok(state.gate, "adopted gate recorded");
  assert.equal(state.gate.summary, "minor advisory");
  assert.equal(existsSync(join(runDir, "logs", "build.1.judge.r2.jsonl")), false, "a completed judge must be adopted once");
});

test("invalid orphan judge output is rejudged without charging worker usage twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-invalid-judge-"));
  const path = writeContract(directory, fixture({
    id: "resume-invalid-judge-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{invocations: Array<{id: string, phase: string, stdoutPath: string}>}} */
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const judgeInvocation = state.invocations.at(-1);
  assert.ok(judgeInvocation, "persisted judge invocation exists");
  writeFileSync(judgeInvocation.stdoutPath, "not a structured judge result\n");
  writeFileSync(nodePath, JSON.stringify({ ...state, status: "running", phase: "judge" }, null, 2));

  const resumed = await withAdvisoryGateCodex(directory, () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 30, "worker usage is not added again while rejudging");
  assert.ok(final.executionOverrides, "execution overrides persisted");
  assert.equal(final.executionOverrides.filter((item) => item.invocationId === judgeInvocation.id).length, 1);
  const resumedAgain = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const finalAgain = nodeState(resumedAgain);
  assert.ok(finalAgain.usage, "usage persisted on second resume");
  assert.equal(finalAgain.usage.inputTokens, 30, "a second resume does not charge the orphan judge again");
});

test("invalid orphan judge usage survives a full worker restart exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-invalid-restart-"));
  const path = writeContract(directory, fixture({
    id: "resume-invalid-restart-run",
    pollIntervalMs: 10,
    usagePolicy: { epoch: "resume-invalid-restart", maxInputTokens: 1000, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1000, maxInvocationTokens: 500, cacheReadWeight: 0.1 },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{invocations: Array<{id: string, phase: string, stdoutPath: string, usage?: unknown}>}} */
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const judgeInvocation = state.invocations.at(-1);
  const workerInvocation = state.invocations.find((invocation) => invocation.phase === "worker");
  assert.ok(judgeInvocation && workerInvocation, "persisted judge and worker invocations exist");
  writeFileSync(workerInvocation.stdoutPath, "not a provider stream\n");
  writeFileSync(judgeInvocation.stdoutPath, [
    { type: "thread.started", thread_id: "orphan-judge" },
    { type: "item.completed", item: { type: "agent_message", text: "not a structured verdict" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  const { usage: _judgeUsage, ...judgeWithoutUsage } = judgeInvocation;
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "judge",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
    invocations: state.invocations.map((invocation) => invocation.id === judgeInvocation.id ? judgeWithoutUsage : invocation),
  }, null, 2));
  const ledgerPath = join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  delete ledger.epochs["resume-invalid-restart"].invocations[judgeInvocation.id];
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const resumed = await withAdvisoryGateCodex(directory, () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 2, "an unusable worker forces a full worker restart");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 40, "the orphan judge usage is charged before the replacement phase");
  const recoveredLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const recoveredEntries = Object.values(recoveredLedger.epochs["resume-invalid-restart"].invocations);
  assert.equal(recoveredEntries.length, 4, "four invocation usages are present exactly once");
  assert.ok(final.executionOverrides, "execution overrides persisted");
  assert.equal(final.executionOverrides.filter((item) => item.invocationId === judgeInvocation.id).length, 1);
  const resumedAgain = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const finalAgain = nodeState(resumedAgain);
  assert.ok(finalAgain.usage, "usage persisted on second resume");
  assert.equal(finalAgain.usage.inputTokens, 40, "the second resume does not charge the judge again");
  const resumedLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(Object.keys(resumedLedger.epochs["resume-invalid-restart"].invocations).length, Object.keys(recoveredLedger.epochs["resume-invalid-restart"].invocations).length, "a second resume does not add a ledger entry");
});

test("resume restarts a node with no usable worker output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-restart-"));
  const path = writeContract(directory, fixture({ id: "resume-restart-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 2);
});

test("orphan worker failure usage is recovered into the campaign ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-failure-usage-"));
  const path = writeContract(directory, fixture({
    id: "orphan-failure-usage-run",
    pollIntervalMs: 10,
    usagePolicy: { epoch: "orphan-failure-usage", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
  }));
  const runDir = await withFakeCodex(directory, "failure-with-usage", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations[0];
  const { usage: _usage, costUsd: _cost, ...withoutAccounting } = invocation;
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    usage: undefined,
    costUsd: undefined,
    invocations: [{ ...withoutAccounting, status: "closed", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null }, costUsd: null }],
  }, null, 2));
  const ledgerPath = join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  ledger.epochs["orphan-failure-usage"].invocations = {};
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.deepEqual(final.usage, { inputTokens: 15, outputTokens: 5, cacheReadInputTokens: 2 });
  const finalLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(Object.keys(finalLedger.epochs["orphan-failure-usage"].invocations).length, 2);
  assert.deepEqual(finalLedger.epochs["orphan-failure-usage"].invocations[invocation.id].usage, { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 });
});

test("simultaneous resumes allow one controller and reject the other", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-concurrent-resume-"));
  const path = writeContract(directory, fixture({ id: "concurrent-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const started = join(directory, ".runs", "provider-started");
  const release = join(directory, ".runs", "provider-release");
  const slow = fakeCodex(directory, "wait-for-release");
  const first = spawn(process.execPath, [runner, "resume", runDir], {
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: slow },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // A freshly spawned `resume` controller spends several seconds in startup
    // (identity probing, snapshots) before its first provider spawn, so the
    // lease-held observation needs a wider window than the 5s default.
    await waitForValue(() => {
      try {
        return existsSync(started)
          && first.exitCode === null
          && JSON.parse(readFileSync(join(runDir, "controller-lease.json"), "utf8")).pid === first.pid
          ? "held"
          : null;
      } catch {
        return null;
      }
    }, 20_000);
    const second = spawn(process.execPath, [runner, "resume", runDir], {
      env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const secondResult = await closeResult(second);
    assert.notEqual(secondResult.code, 0, secondResult.stderr);
    assert.match(secondResult.stderr, /lease/u);
    writeFileSync(release, "release");
    const firstResult = await closeResult(first);
    assert.equal(firstResult.code, 0, `${firstResult.stderr}\n${firstResult.stdout}`);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    writeFileSync(release, "release");
    try { first.kill("SIGKILL"); } catch {}
  }
});

test("cancelRun confirms controller death and terminates every recorded provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-confirmation-"));
  const path = writeContract(directory, fixture({ id: "cancel-confirmation-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const controller = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  /** @param {import("node:child_process").ChildProcess} child */
  const childExit = (child) => new Promise((resolve) => child.once("exit", resolve));
  const controllerExit = childExit(controller);
  const providerExit = childExit(provider);
  const verificationExit = childExit(verificationProcess);
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const invocation = {
    id: "cancel-provider",
    pid: childPid(provider),
    processGroupId: process.platform === "win32" ? null : childPid(provider),
    processStartToken: processStartToken(childPid(provider)),
    driver: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
    phase: "worker",
    promptPath: null,
    stdoutPath: join(runDir, "logs", "missing.jsonl"),
    stderrPath: null,
    startedAt,
    updatedAt: startedAt,
    deadlineAt: new Date(now + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
  };
  state.status = "running";
  state.phase = "worker";
  state.verification = {
    passed: false,
    completed: false,
    commands: [],
    attempts: [{
      invocationId: "cancel-verification",
      commandIndex: 0,
      attempt: 1,
      pid: childPid(verificationProcess),
      processGroupId: process.platform === "win32" ? null : childPid(verificationProcess),
      processStartToken: processStartToken(childPid(verificationProcess)),
      startedAt,
      deadlineAt: new Date(now + 60_000).toISOString(),
      status: "active",
      completedAt: null,
      result: null,
    }],
  };
  writeFileSync(nodePath, JSON.stringify({ ...state, invocations: [invocation] }, null, 2));
  writeFileSync(join(runDir, "controller-lease.json"), JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "controller-under-test",
    generation: 1,
    pid: childPid(controller),
    processStartToken: processStartToken(childPid(controller)),
    acquiredAt: new Date(now - 100).toISOString(),
    renewedAt: new Date(now - 100).toISOString(),
    expiresAt: new Date(now + 250).toISOString(),
  }, null, 2));
  try {
    await cancelRun(runDir);
    await Promise.all([controllerExit, providerExit, verificationExit]);
    assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).status, "canceled");
    assert.equal(invocationAlive({ pid: childPid(controller), processStartToken: processStartToken(childPid(controller)) }), false);
    assert.equal(invocationAlive(invocation), false);
    assert.equal(invocationAlive({ pid: childPid(verificationProcess), processStartToken: processStartToken(childPid(verificationProcess)) }), false);
    assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).verification.attempts[0].status, "canceled");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(controller) : -childPid(controller), "SIGKILL"); } catch {}
    try { process.kill(process.platform === "win32" ? childPid(provider) : -childPid(provider), "SIGKILL"); } catch {}
    try { process.kill(process.platform === "win32" ? childPid(verificationProcess) : -childPid(verificationProcess), "SIGKILL"); } catch {}
  }
});

test("resume adopts a still-live orphan invocation after its stream completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-orphan-"));
  const path = writeContract(directory, fixture({ id: "live-orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const stdoutPath = join(runDir, "logs", "active-orphan.jsonl");
  const stream = [
    { type: "thread.started", thread_id: "orphan-thread" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "adopted worker", changedFiles: [], verification: [], artifacts: [], missingContext: [] }) } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const child = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(stdoutPath)}, ${JSON.stringify(stream)}), 50); setTimeout(() => {}, 10000)`], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  // The synthetic invocation below fabricates a fresh attempt by hand; a real
  // attempt start clears the previous attempt's canonical result file, so the
  // fabricated one must not inherit it.
  rmSync(join(runDir, "results", "build.json"), { force: true });
  const snapshotPath = join(runDir, "logs", "active-orphan.snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(captureWorkspaceSnapshot(directory)));
  const now = new Date().toISOString();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.invocations = [{
    id: "live-orphan",
    pid: childPid(child),
    processGroupId: process.platform === "win32" ? null : childPid(child),
    processStartToken: processStartToken(childPid(child)),
    driver: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
    phase: "worker",
    promptPath: null,
    stdoutPath,
    stderrPath: null,
    startedAt: now,
    updatedAt: now,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
    snapshotPath,
  }];
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "done");
    assert.equal(/** @type {{summary: string}} */ (final.result).summary, "adopted worker");
    assert.ok(final.invocations, "adopted invocation persisted");
    assert.equal(final.invocations.length, 1);
    assert.equal(final.invocations[0].id, "live-orphan");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(child) : -childPid(child), "SIGKILL"); } catch {}
  }
});

test("resume applies the persisted progress heartbeat to a noisy live worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-progress-resume-"));
  mkdirSync(join(directory, "src"));
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["src"] });
  const path = writeContract(directory, fixture({
    id: "live-progress-resume-run",
    pollIntervalMs: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacket,
      progressPolicy: { graceSec: 300, intervalSec: 120, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const stdoutPath = join(runDir, "logs", "active-progress.jsonl");
  writeFileSync(stdoutPath, "working\n");
  const child = spawn(process.execPath, ["-e", `const fs = require("node:fs"); setInterval(() => fs.appendFileSync(${JSON.stringify(stdoutPath)}, "working\\n"), 5);`], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const snapshotPath = join(runDir, "logs", "active-progress.snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(captureWorkspaceSnapshot(directory)));
  const now = new Date().toISOString();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.progress = {
    ...state.progress,
    revision: 0,
    heartbeatCount: 2,
    dryHeartbeatCount: 2,
    nextCheckAt: new Date(Date.now() - 1_000).toISOString(),
  };
  state.invocations = [{
    id: "live-progress",
    pid: childPid(child),
    processGroupId: process.platform === "win32" ? null : childPid(child),
    processStartToken: processStartToken(childPid(child)),
    driver: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
    phase: "worker",
    promptPath: null,
    stdoutPath,
    stderrPath: null,
    startedAt: now,
    updatedAt: now,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
    snapshotPath,
  }];
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "stalled");
    assert.equal(final.error?.code, "progress_stalled");
    assert.equal(final.progress?.dryHeartbeatCount, 3);
    assert.equal(final.invocations?.[0]?.status, "closed");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(child) : -childPid(child), "SIGKILL"); } catch {}
  }
});

test("resume terminates an interrupted verification attempt and re-runs the phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-resume-"));
  const path = writeContract(directory, fixture({ id: "verification-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const now = Date.now();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.verification = {
    passed: false,
    completed: false,
    commands: [],
    attempts: [{
      invocationId: "crashed-verification",
      commandIndex: 0,
      attempt: 1,
      pid: childPid(verificationProcess),
      processGroupId: process.platform === "win32" ? null : childPid(verificationProcess),
      processStartToken: processStartToken(childPid(verificationProcess)),
      startedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 60_000).toISOString(),
      status: "active",
      completedAt: null,
      result: null,
    }],
  };
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "done");
    assert.ok(final.verification, "verification state persisted");
    assert.equal(final.verification.passed, true);
    assert.ok(final.verification.attempts, "verification attempts persisted");
    assert.equal(final.verification.attempts[0].status, "crashed");
    // The fabricated crashed attempt is preserved and the phase re-runs once
    // (default repeat 1).
    assert.equal(final.verification.attempts.length, 2);
    assert.equal(final.revisions, 0);
    assert.equal(invocationAlive({ pid: childPid(verificationProcess), processStartToken: processStartToken(childPid(verificationProcess)) }), false);
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(verificationProcess) : -childPid(verificationProcess), "SIGKILL"); } catch {}
  }
});

test("verification output beyond the snapshot budget does not crash the controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-large-"));
  const path = writeContract(directory, fixture({
    id: "verification-large-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000))"] }] }),
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.ok(state.verification, "verification state persisted");
  assert.equal(state.verification.passed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  const boundedAttempt = state.verification.attempts[0];
  assert.ok(boundedAttempt.result, "bounded attempt result persisted");
  assert.ok(Buffer.byteLength(boundedAttempt.result.stdout, "utf8") <= 2 * 1024);
  assert.ok(Buffer.byteLength(boundedAttempt.result.stderr, "utf8") <= 2 * 1024);
});

test("resume rejects a dead completion whose persisted close time is past the absolute deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-deadline-"));
  const path = writeContract(directory, fixture({
    id: "resume-deadline-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations.at(-1);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const timeoutAt = new Date(Date.now() - 10_000).toISOString();
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: timeoutAt, reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt: new Date().toISOString() }],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 2, "an overdue completion is restarted rather than adopted");
});

test("resume adopts a dead completion closed before its deadline after downtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-downtime-"));
  const path = writeContract(directory, fixture({
    id: "resume-downtime-run",
    timeoutSec: 10,
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations.at(-1);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const closedAt = new Date(Date.now() - 19_000).toISOString();
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: new Date(Date.now() - 20_000).toISOString(), reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt }],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 1, "a completion closed before the deadline remains adoptable after downtime");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 10);
});

test("resume preserves a durable pending judge phase instead of resetting to worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-pending-judge-"));
  const path = writeContract(directory, fixture({
    id: "resume-pending-judge-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "judge",
    result: { status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] },
    gate: null,
  }, null, 2));

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 1, "the pending judge does not repeat the worker attempt");
});

test("ledger enforcement on resume lets a done budgeted worker reach its judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-gate-budget-resume-"));
  const path = writeContract(directory, fixture({
    id: "judge-gate-budget-resume-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    usagePolicy: { epoch: "judge-gate-budget-resume", maxInputTokens: 1_000_000, judgeReserveInputTokens: 500_000, maxPhaseInputTokens: 1_000_000, maxInvocationTokens: 100_000, cacheReadWeight: 1 },
    nodes: [
      { id: "gated", type: "backend", taskPacket: packet({ objective: "Finish at the derived cap" }), maxInputTokens: 500, budgetProfile: budgetProfile({ estimatedWeightedInputTokens: 500 }), progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 }, definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } },
      { id: "revision", type: "backend", taskPacket: packet({ objective: "Re-dispatch for a gate revision" }), maxInputTokens: 500, budgetProfile: budgetProfile({ estimatedWeightedInputTokens: 500 }), progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 }, definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } },
      { id: "sibling", type: "backend", taskPacket: packet({ objective: "No persisted result" }), maxInputTokens: 500, budgetProfile: budgetProfile({ estimatedWeightedInputTokens: 500 }), progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 }, definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } },
    ],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  /** @param {string} id @returns {string} */
  const persistedPath = (id) => join(runDir, "nodes", `${id}.json`);
  /** @type {Array<[id: string, phase: string, keepResult: boolean]>} */
  const plans = [["gated", "judge", true], ["revision", "worker", true], ["sibling", "worker", false]];
  for (const [id, phase, keepResult] of plans) {
    /** @type {{budgetState?: {currentCapTokens?: number}|null, invocations?: Array<{id: string, phase: string, usage?: {inputTokens?: number, outputTokens?: number, cacheReadInputTokens?: number}|null}>|null, result?: unknown|null}} */
    const persisted = JSON.parse(readFileSync(persistedPath(id), "utf8"));
    const cap = Math.max(1, Math.ceil(persisted.budgetState?.currentCapTokens ?? 500));
    const worker = (persisted.invocations ?? []).find((invocation) => invocation.phase === "worker");
    const invocations = (persisted.invocations ?? []).map((invocation) => invocation.id === worker?.id
      ? { ...invocation, usage: { inputTokens: cap, outputTokens: 0, cacheReadInputTokens: 0 } }
      : { ...invocation, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 } });
    writeFileSync(persistedPath(id), JSON.stringify({
      ...persisted,
      status: "pending",
      phase,
      result: keepResult ? persisted.result : null,
      gate: null,
      error: null,
      usage: undefined,
      costUsd: undefined,
      invocations,
    }, null, 2));
  }

  const resumed = await withAdvisoryGateCodex(directory, () => resumeRun(runDir));
  const gated = nodeState(resumed, "gated");
  assert.equal(gated.status, "done", `done worker must reach its judge: ${gated.error?.message ?? gated.status}`);
  assert.equal(gated.phase, "complete");
  assert.equal(gated.error, null);
  assert.equal(gated.attempt, 1, "the pending judge does not repeat the worker attempt");
  assert.ok(gated.gate, "the re-dispatched judge records a verdict");
  assert.ok((gated.invocations ?? []).filter((invocation) => invocation.phase === "judge").length >= 2, "the gate judge starts after resume");
  const sibling = nodeState(resumed, "sibling");
  assert.equal(sibling.status, "blocked", `an equivalent node without a worker result stays capped: ${sibling.error?.message ?? sibling.status}`);
  assert.equal(sibling.error?.code, "budget_attention");
  const revision = nodeState(resumed, "revision");
  assert.equal(revision.status, "blocked", `a pending worker owing a gate revision stays capped despite its done result: ${revision.error?.message ?? revision.status}`);
  assert.equal(revision.error?.code, "budget_attention");
});

test("resume gives a never-started pending node zero usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-never-started-"));
  const path = writeContract(directory, fixture({ id: "resume-never-started-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "waiting",
    attempt: 0,
    invocations: [],
    usage: undefined,
    costUsd: undefined,
    result: null,
    verification: null,
    gate: null,
    error: null,
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.deepEqual(nodeState(resumed).usage, { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 });
});

test("resume does not re-enable a disabled gate from the stored contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-no-gate-"));
  const path = writeContract(directory, fixture({ id: "resume-no-gate-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  assert.equal(JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")).nodes[0].gate.enabled, false);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  const logs = readdirSync(join(runDir, "logs"));
  assert.ok(!logs.some((name) => name.includes("judge")), "a disabled gate must not run a judge after resume");
});

test("gate revisions are not consumed by attempts burned in restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-revisions-"));
  const path = writeContract(directory, fixture({
    id: "revisions-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 1 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).attempt, 2);

  // The judge must cite the judgment item id it rejects: an uncited rejection
  // is a protocol failure (bounded re-ask, then attention), never a revision.
  const final = await withCitedGateCodex(directory, () => resumeRun(runDir));
  assert.equal(nodeState(final).status, "exhausted");
  assert.equal(nodeState(final).attempt, 4, "two burned starts plus the gate retry start");
  assert.equal(nodeState(final).revisions, 1, "one real gate rejection consumed");
});

test("status separates a live running node from an orphaned one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-"));
  const path = writeContract(directory, fixture({ id: "orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  assert.match(renderStatus(runDir), /build still claims to be running/u);

  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    schemaVersion: 2,
    contractVersion: "0.1.0",
    pid: 2_147_483_647,
    startedAt: "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run", contractId: "orphan-run", campaignId: "test-campaign" },
  }));
  assert.match(renderStatus(runDir), /build still claims to be running/u);
});

test("status --json flags an orphaned running node with leaseHealthy false", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-json-"));
  const path = writeContract(directory, fixture({ id: "orphan-json-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const payload = /** @type {{leaseHealthy: boolean, summary: string, nodes: {id: string, status: string}[]}} */ (JSON.parse(renderStatusJson(runDir)));
  assert.equal(payload.leaseHealthy, false, "a missing controller lease while a node claims running must be machine-readable");
  assert.equal(payload.nodes.find((node) => node.id === "build")?.status, "running");
});

test("status and resume reject unknown persisted protocol fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-validation-"));
  const path = writeContract(directory, fixture({ id: "persisted-validation-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({ ...node, typo: true }));
  assert.throws(() => renderStatus(runDir), /node snapshot has unexpected field typo/u);
  writeFileSync(nodePath, JSON.stringify(node));
  writeFileSync(nodePath, JSON.stringify({ ...node, id: "other" }));
  assert.throws(() => renderStatus(runDir), /node snapshot\.id does not match/u);
  assert.throws(() => renderReport(runDir), /node snapshot\.id does not match/u);
  assert.throws(() => renderFindings(runDir), /node snapshot\.id does not match/u);
  await assert.rejects(() => resumeRun(runDir), /node snapshot\.id does not match/u);
  writeFileSync(nodePath, JSON.stringify(node));

  const runPath = join(runDir, "run.json");
  const metadata = JSON.parse(readFileSync(runPath, "utf8"));
  writeFileSync(runPath, JSON.stringify({ ...metadata, typo: true }));
  assert.throws(() => renderStatus(runDir), /run metadata has unexpected field typo/u);
  await assert.rejects(() => resumeRun(runDir), /run metadata has unexpected field typo/u);
});

test("report aggregates per-node status, attempts, revisions, and tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-report-"));
  const path = writeContract(directory, fixture({
    id: "report-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  const report = renderReport(runDir);
  assert.match(report, /1 nodes · 1 done/u);
  // The node ends on its judge runtime, and tokens sum worker plus judge.
  assert.match(report, /build\s+done\s+1\s+0\s+codex\/gpt-5\.6-sol/u);
  assert.match(report, /totals · in 20 · out 4 · cache -/u);
});

test("events record attempt, runtime, and gate verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-events-"));
  const path = writeContract(directory, fixture({
    id: "events-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const started = events.find((event) => event.to === "running" && event.phase === "worker");
  assert.equal(started.attempt, 1);
  assert.equal(started.runtime, "luna");
  const rejected = events.find((event) => event.to === "exhausted");
  assert.equal(rejected.verdict, "fail");
  assert.equal(rejected.error, "revision_cap");
  assert.equal(rejected.phase, "judge");
});

test("runner emits campaign.progress only for material node changes and keeps terminal events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-progress-emission-"));
  const path = writeContract(directory, fixture({
    id: "progress-emission-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const campaignPath = join(directory, ".runs", "campaigns", "test-campaign");
  const notifier = join(directory, "notify-success.mjs");
  writeFileSync(notifier, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  let result;
  try {
    result = await withFakeCodex(directory, "pass", () => runContract(path));
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
  }
  assert.equal(result.ok, true);
  const outbox = readNotificationOutbox(campaignPath);
  const progress = outbox.filter((event) => event.type === CAMPAIGN_PROGRESS_TYPE);
  assert.deepEqual(progress.map((event) => event.data), [
    { runId: "progress-emission-run", nodeId: "build", status: "running", phase: "worker", attempt: 1, revisions: 0, runtime: "luna" },
    { runId: "progress-emission-run", nodeId: "build", status: "done", phase: "complete", attempt: 1, revisions: 0, runtime: "luna" },
  ]);
  assert.deepEqual(progress.map((event) => event.coalesceKey), [
    "progress-emission-run:build",
    "progress-emission-run:build",
  ]);
  // The projector summary carries counters and identifiers only, never the
  // status/phase text or a model note, so both material states of the node
  // render the same deterministic line; the data field keeps them distinct.
  assert.equal(progress[0].summary, "node build progress · attempt 1 · revisions 0 · runtime luna");
  assert.equal(progress[1].summary, "node build progress · attempt 1 · revisions 0 · runtime luna");
  const terminal = outbox.filter((event) => event.type === "node.terminal");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].coalesceKey, undefined, "terminal events are never coalesced");
  assert.deepEqual(terminal[0].data, { runId: "progress-emission-run", nodeId: "build", status: "done" });
  assert.equal(terminal[0].summary, "node build terminal · attempt 1 · revisions 0");
  assert.equal(outbox.filter((event) => event.type === "run.terminal").length, 1);
});

test("idle polls and resume seeding emit no extra progress and coalesce undelivered progress", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-progress-idle-"));
  const path = writeContract(directory, fixture({
    id: "progress-idle-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const campaignPath = join(directory, ".runs", "campaigns", "test-campaign");
  const started = join(directory, ".runs", "provider-started");
  const release = join(directory, ".runs", "provider-release");
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "wait-for-release");
  let runDir;
  try {
    const pending = runContract(path);
    await waitForValue(() => (existsSync(started) ? "started" : null));
    // Let several controller polls pass while the node stays running: idle
    // passes must not create progress events.
    await delay(200);
    writeFileSync(release, "release");
    runDir = (await pending).runDir;
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
  let outbox = readNotificationOutbox(campaignPath);
  assert.equal(outbox.filter((event) => event.type === CAMPAIGN_PROGRESS_TYPE).length, 1, "undelivered progress coalesces to the latest material state");
  assert.equal(outbox.find((event) => event.type === CAMPAIGN_PROGRESS_TYPE)?.data?.status, "done");
  assert.equal(outbox.filter((event) => event.type === "node.terminal").length, 1);
  assert.equal(outbox.filter((event) => event.type === "run.terminal").length, 1);
  // Rewind the finished node to running and resume. The provider that would
  // fail any fresh worker proves the result is adopted, the still-pending
  // "done" progress is rewritten in place, and the seeded "running" state is
  // not re-emitted.
  orphan(runDir, "build");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  outbox = readNotificationOutbox(campaignPath);
  const progress = outbox.filter((event) => event.type === CAMPAIGN_PROGRESS_TYPE);
  assert.equal(progress.length, 1, "resume must not duplicate progress");
  assert.equal(progress[0]?.data?.status, "done");
  assert.equal(outbox.filter((event) => event.type === "node.terminal").length, 1, "terminal events deduplicate");
  assert.equal(outbox.filter((event) => event.type === "run.terminal").length, 1);
});

test("preflight probes every routed worker and judge runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id).sort(), ["luna", "sol"]);
  assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
});

test("preflight runs an agy runtime through its native stream protocol", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-agy-"));
  const path = writeContract(directory, fixture({
    runtimeDefaults: { worker: "agy", judge: "sol" },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const checks = await withFakeAgy(directory, () => preflightContract(path));
  assert.deepEqual(checks.map((check) => check.id), ["agy"]);
  assert.equal(checks[0].ok, true, checks[0].detail ?? undefined);
});

test("preflight reports a missing credential by variable name only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-key-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "mechanic", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
    assert.deepEqual(checks.map((check) => check.id), ["flash"]);
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].driver, "codex");
    assert.match(checks[0].executable, /fake-codex-pass\.mjs$/u);
    assert.equal(checks[0].model, "deepseek-v4-flash");
    assert.equal(checks[0].version, "fake-codex 1.0.0");
    assert.match(checks[0].detail ?? "", /missing environment variable DEEPSEEK_API_KEY/u);
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("preflight fails a runtime the provider rejects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-fail-"));
  const path = writeContract(directory, fixture());
  const checks = await withFakeCodex(directory, "version-fail", () => preflightContract(path));
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail ?? "", /deliberate failure/u);
});

test("preflight preserves conflicting runtime and node capability requirements", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-capabilities-"));
  const path = writeContract(directory, fixture({
    runtimes: {
      luna: { driver: "codex", model: "gpt-5.6-luna", requiredCapabilities: { sandbox: true } },
      sol: { driver: "codex", model: "gpt-5.6-sol" },
    },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      requiredCapabilities: { sandbox: false },
      gate: false,
    }],
  }));
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path));
  // With no declared rules the worker's synthesized chain reaches sol as well,
  // so both runtimes are capability-checked against the node's demand before
  // anything spends — and the codex sandbox conflicts with sandbox=false on both.
  assert.deepEqual(checks.map((check) => check.ok), [false, false]);
  assert.match(checks[0].detail ?? "", /requirement 2: sandbox=false/u);
});

test("live preflight proves generation, redacts failures, and static mode stays mutation-free", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-preflight-"));
  const executable = fakeExecJsonl(directory, "secret");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const previous = process.env.INTENT_FACTORY_TEST_LIVE_SECRET;
  process.env.INTENT_FACTORY_TEST_LIVE_SECRET = "preflight-secret-value";
  try {
    const checks = await preflightContract(path);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].version, "fake-jsonl 1.0.0");
    assert.equal(checks[0].liveStatus, "failed");
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail ?? "", /402/u);
    assert.doesNotMatch(checks[0].detail ?? "", /preflight-secret-value/u);
    assert.equal(existsSync(join(directory, ".runs")), false);

    const staticExecutable = fakeExecJsonl(directory, "pass");
    const staticPath = join(directory, "static-contract.json");
    writeFileSync(staticPath, `${JSON.stringify(fixture({
      runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
      runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: staticExecutable } },
      runtimeRules: [],
      nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    }), null, 2)}\n`);
    const staticChecks = await preflightContract(staticPath, { static: true });
    assert.equal(staticChecks[0].ok, true);
    assert.equal(staticChecks[0].live, undefined);
    assert.equal(existsSync(join(directory, ".runs")), false);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_TEST_LIVE_SECRET;
    else process.env.INTENT_FACTORY_TEST_LIVE_SECRET = previous;
  }
});

test("live preflight providers never receive the controller-only notification transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-preflight-notify-env-"));
  const marker = join(directory, "preflight-env.json");
  const provider = join(directory, "preflight-provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("preflight-provider 1.0.0");
} else {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    notify: process.env.INTENT_FACTORY_NOTIFY_BIN ?? null,
    ambient: process.env.INTENT_FACTORY_AMBIENT ?? null,
  }));
  const result = JSON.stringify({ status: "done", summary: "ok", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "fake-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 }, costUsd: 0.01 }));
}
`);
  chmodSync(provider, 0o755);
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: provider } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  const previousAmbient = process.env.INTENT_FACTORY_AMBIENT;
  process.env.INTENT_FACTORY_NOTIFY_BIN = provider;
  process.env.INTENT_FACTORY_AMBIENT = "ambient-value";
  try {
    const checks = await preflightContract(path);
    assert.equal(checks[0].ok, true, checks[0].detail ?? undefined);
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.notify, null, "INTENT_FACTORY_NOTIFY_BIN must not reach the live preflight provider");
    assert.equal(observed.ambient, "ambient-value", "ambient runtime variables must survive");
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
    if (previousAmbient === undefined) delete process.env.INTENT_FACTORY_AMBIENT;
    else process.env.INTENT_FACTORY_AMBIENT = previousAmbient;
  }
});

test("preflight deduplicates initial runtimes and follows failover targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-reachable-"));
  const executable = fakeExecJsonl(directory, "pass");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "exec-jsonl", model: "primary", executable },
      backup: { driver: "exec-jsonl", model: "backup", executable },
    },
    runtimeRules: [{ match: { currentRuntime: "primary", status: "failed" }, runtime: "backup" }],
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }), null, 2)}\n`);
  const checks = await preflightContract(path, { static: true });
  assert.deepEqual(checks.map((check) => check.id), ["primary", "backup"]);
});

test("provider exhaustion follows multiple declared runtimes without consuming revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-multi-hop-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "exhausted");
  const third = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-multi-hop-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first },
      second: { driver: "codex", model: "second", executable: second },
      third: { driver: "codex", model: "third", executable: third },
    },
    runtimeRules: [
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second" },
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "second" }, runtime: "third" },
    ],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second", "third"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.nextRuntime), ["second", "third"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.hop), [1, 2]);
});

test("provider exhaustion without a rule is terminal and cycles do not reuse a runtime", async () => {
  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-failover-no-rule-"));
  const exhausted = fakeCodex(terminalDirectory, "exhausted");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "failover-no-rule-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: { first: { driver: "codex", model: "first", executable: exhausted } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const terminal = nodeState(await runContract(terminalPath));
  assert.equal(terminal.status, "exhausted");
  assert.equal(terminal.routing?.history?.length ?? 0, 0);

  const cycleDirectory = mkdtempSync(join(tmpdir(), "runner-failover-cycle-"));
  const cycleFirst = fakeCodex(cycleDirectory, "exhausted");
  const cycleSecond = fakeCodex(cycleDirectory, "exhausted");
  const cyclePath = writeContract(cycleDirectory, fixture({
    id: "failover-cycle-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: cycleFirst },
      second: { driver: "codex", model: "second", executable: cycleSecond },
    },
    runtimeRules: [
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second" },
      { match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "second" }, runtime: "first" },
    ],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const cycle = nodeState(await runContract(cyclePath));
  assert.equal(cycle.status, "exhausted");
  assert.equal(cycle.error?.code, "provider_failover_cycle");
  assert.deepEqual((cycle.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
});

test("provider failover persists and honors backoff before rescheduling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-backoff-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-backoff-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first },
      second: { driver: "codex", model: "second", executable: second },
    },
    runtimeRules: [{ match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second", backoffSec: 0.05 }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const started = Date.now();
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.routing?.history?.[0]?.backoffSec, 0.05);
  assert.ok(Date.parse(state.routing?.history?.[0]?.backoffUntil ?? "") <= Date.now());
  assert.ok(Date.now() - started >= 40);
});

test("recovered provider exhaustion does not charge persisted usage or cost twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-no-double-charge-"));
  const executable = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-no-double-charge-run",
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { driver: "codex", model: "worker", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = (await runContract(path)).runDir;
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations[0];
  const usage = { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 };
  const costUsd = 0.01;
  writeFileSync(invocation.stdoutPath, `${JSON.stringify({ type: "turn.failed", error: { code: "budget_exceeded", message: "budget_exceeded" } })}\n`);
  const recovered = {
    ...state,
    status: "running",
    phase: "worker",
    result: null,
    gate: null,
    error: null,
    usage,
    costUsd,
    invocations: [{ ...invocation, status: "closed", usage, costUsd, closedAt: new Date().toISOString(), exitCode: 0, signal: null }],
  };
  writeFileSync(nodePath, JSON.stringify(recovered, null, 2));
  const final = nodeState(await resumeRun(runDir));
  assert.equal(final.status, "exhausted");
  assert.deepEqual(final.usage, usage);
  assert.equal(final.costUsd, costUsd);
});

test("ordinary provider failure usage is counted from its invocation once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failure-usage-once-"));
  const path = writeContract(directory, fixture({
    id: "failure-usage-once-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "failure-with-usage", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.deepEqual(state.usage, { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 });
  assert.deepEqual(state.invocations?.map((invocation) => invocation.usage), [{ inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 }]);
});

test("judge provider failover preserves the completed worker result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-judge-"));
  const worker = fakeCodex(directory, "pass");
  const judgeFirst = fakeCodex(directory, "exhausted");
  const judgeSecond = advisoryGateCodex(directory);
  const path = writeContract(directory, fixture({
    id: "failover-judge-run",
    runtimeDefaults: { worker: "worker", judge: "judge-first" },
    runtimes: {
      worker: { driver: "codex", model: "worker", executable: worker },
      "judge-first": { driver: "codex", model: "judge-first", executable: judgeFirst },
      "judge-second": { driver: "codex", model: "judge-second", executable: judgeSecond },
    },
    runtimeRules: [{ match: { role: "judge", status: "exhausted", errorCode: "provider_error", currentRuntime: "judge-first" }, runtime: "judge-second" }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(/** @type {{status?: string}|null} */ (state.result)?.status, "done");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["worker", "judge-first", "judge-second"]);
  assert.equal(state.routing?.history?.[0]?.role, "judge");
});

test("rejects monetary budgets when a reachable runtime cannot return cost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-capability-"));
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture({
    maxCostUsd: 0.01,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }), null, 2)}\n`);
  const checks = await withFakeCodex(directory, "pass", () => preflightContract(path, { static: true }));
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail ?? "", /cost=false/u);
  await assert.rejects(() => withFakeCodex(directory, "pass", () => runContract(path)), /cost capability/u);
  assert.equal(existsSync(join(directory, ".runs")), false);
});

test("persists and recovers cost exactly once and reports totals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-recovery-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const executable = fakeExecJsonl(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "cost-recovery-run",
    pollIntervalMs: 10,
    usagePolicy: { epoch: "cost-recovery", maxInputTokens: 100, judgeReserveInputTokens: 10, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: {} }],
  }));
  const runDir = (await runContract(path)).runDir;
  const first = nodeState(await resumeRun(runDir));
  assert.equal(first.costUsd, 0.02);
  assert.deepEqual((first.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  assert.deepEqual(Object.values(ledger.epochs["cost-recovery"].invocations).map((invocation) => invocation.costUsd), [0.01, 0.01]);
  assert.equal(JSON.parse(renderReportJson(runDir)).totals.costUsd, 0.02);
  assert.match(renderReport(runDir), /cost \$0\.020000/u);
  const nodePath = join(runDir, "nodes", "build.json");
  const crashed = JSON.parse(readFileSync(nodePath, "utf8"));
  const worker = /** @type {Record<string, unknown>[]} */ (crashed.invocations).find((invocation) => invocation.phase === "worker");
  crashed.status = "running";
  crashed.phase = "worker";
  crashed.result = null;
  crashed.gate = null;
  crashed.costUsd = undefined;
  crashed.usage = undefined;
  crashed.invocations = [{ ...worker, status: "closed", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null }, costUsd: null }];
  writeFileSync(nodePath, JSON.stringify(crashed, null, 2));
  const recovered = nodeState(await resumeRun(runDir));
  assert.equal(recovered.costUsd, 0.02);
  assert.deepEqual((recovered.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
});

test("blocks new work at contract and node monetary budgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-budget-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const executable = fakeExecJsonl(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "cost-budget-run",
    maxCostUsd: 0.01,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(nodeState(result, "first").status, "done");
  assert.equal(nodeState(result, "second").status, "blocked");
  assert.equal(nodeState(result, "second").error?.code, "cost_budget_exceeded");

  const nodeBudgetPath = writeContract(directory, fixture({
    id: "node-cost-budget-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", maxCostUsd: 0.01, taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: {} }],
  }));
  const nodeBudget = await runContract(nodeBudgetPath);
  assert.equal(nodeState(nodeBudget).status, "blocked");
  assert.equal(nodeState(nodeBudget).error?.code, "cost_budget_exceeded");
});

test("resume keeps the bounded wall-clock budget of a node that exhausted it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-double-"));
  const path = writeContract(directory, fixture({ id: "double-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "exhausted",
    error: { code: "wall_clock_timeout", message: "worker ran longer than 2400s" },
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  const stored = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].timeoutSec, undefined, "the original contract remains immutable");
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).executionOverrides?.some(/** @param {Record<string, unknown>} item */ (item) => item.kind === "timeout"), false, "resume does not create an automatic timeout override");
});

test("findings renders exhausted gate findings ready for a fix node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-"));
  const path = writeContract(directory, fixture({
    id: "findings-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const rendered = renderFindings(result.runDir);
  assert.match(rendered, /## build/u);
  assert.match(rendered, /\[critical\] broken/u);
  assert.match(rendered, /Evidence: test failed/u);
});

test("a finished run with non-done nodes writes a findings.json handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-artifact-"));
  const path = writeContract(directory, fixture({
    id: "findings-artifact-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    const artifact = JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8"));
    assert.equal(artifact.run, "findings-artifact-run");
    assert.equal(artifact.goal, "Prove the runner works");
    assert.match(artifact.summary, /1 exhausted/u);
    assert.equal(artifact.nodes.length, 1);
    const node = artifact.nodes[0];
    assert.equal(node.id, "build");
    assert.equal(node.status, "exhausted");
    assert.equal(node.error.code, "revision_cap");
    assert.equal(node.gate.maxSeverity, "critical");
    assert.equal(node.gate.findings[0].evidence, "test failed");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("a fully done run writes no findings.json", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-clean-"));
  const path = writeContract(directory, fixture({ id: "findings-clean-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(result).status, "done");
  assert.equal(existsSync(join(result.runDir, "findings.json")), false);
});

test("resume removes a stale findings.json after driving the run to done", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-resume-"));
  const path = writeContract(directory, fixture({
    id: "findings-resume-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }],
      gate: { failOn: ["critical"], maxRevisions: 0 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "critical", async () => (await runContract(path)).runDir);
  assert.equal(existsSync(join(runDir, "findings.json")), true, "the exhausted run wrote the artifact");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(existsSync(join(runDir, "findings.json")), false, "a done run leaves no stale artifact");
});

test("usagePolicy blocks pending nodes once the weighted budget is spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-token-budget-"));
  const path = writeContract(directory, fixture({
    id: "budget-run",
    usagePolicy: { epoch: "test-budget", maxInputTokens: 5, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Implement it too" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, false);
  assert.equal(nodeState(result, "first").status, "done");
  const blocked = nodeState(result, "second");
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.error, "budget block records an error");
  assert.equal(blocked.error.code, "budget_exceeded");
});

test("a scope-gate failure still persists the usage its invocation spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-usage-"));
  const path = writeContract(directory, fixture({
    id: "scope-usage-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.equal(state.usage?.inputTokens, 10, "transcript usage survives the scope failure");
  const invocation = state.invocations?.at(-1);
  assert.equal(invocation?.usage?.inputTokens, 10, "invocation record carries the same usage");
});

test("a wall-clock kill persists usage backfilled from the transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-usage-"));
  const path = writeContract(directory, fixture({
    id: "timeout-usage-run",
    pollIntervalMs: 10,
    timeoutSec: 1,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ objective: "Flood tokens" }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "token-flood-timeout", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "wall_clock_timeout");
  assert.ok((state.usage?.inputTokens ?? 0) > 0, "killed worker reports its observed input tokens");
});

test("budget attention D36 terminates an active worker at its derived cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-node-cap-"));
  const path = writeContract(directory, fixture({
    id: "node-cap-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Flood tokens" }),
      maxInputTokens: 500,
      budgetProfile: budgetProfile(),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "budget_attention");
  assert.equal(state.budgetDecision?.initialAllocationTokens, 500);
  assert.ok((state.usage?.inputTokens ?? 0) >= 500, "usage observed before the kill is persisted");
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(outbox.some((event) => event.type === "run.attention" && event.data?.code === "budget_attention"));
});

test("a judge invocation on a budgeted node is not killed by the worker input token cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-worker-cap-"));
  const path = writeContract(directory, fixture({
    id: "judge-worker-cap-run",
    maxInputTokens: 5_000_000,
    pollIntervalMs: 10,
    timeoutSec: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Complete and judge" }),
      maxInputTokens: 500,
      budgetProfile: budgetProfile({ estimatedWeightedInputTokens: 500 }),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await withFakeCodex(directory, "complete-exit-1", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "complete");
  assert.equal(state.error, null);
});

test("an active judge consumes its reserved budget after the run cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-reserve-"));
  const release = join(directory, "judge-reserve-release");
  const executable = join(directory, "judge-reserve-codex.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const release = ${JSON.stringify(release)};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitForRelease = async () => { while (!existsSync(release)) await pause(); };
if (process.argv.includes("--version")) {
  console.log("judge-reserve-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "judge-reserve-thread" }));
    if (judge) {
      // The judge reports cumulative spend while staying alive so the run cap
      // crossing is observed by the controller, not raced against exit.
      for (let turn = 1; turn <= 8; turn += 1) {
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: turn * 100, output_tokens: 1 } }));
      }
      await waitForRelease();
      const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 801, output_tokens: 1 } }));
      return;
    }
    const resultPath = /(?:file|to): (\\S+\\.json)/.exec(prompt)?.[1];
    const result = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    if (resultPath) {
      const parent = resultPath.slice(0, resultPath.lastIndexOf("/"));
      if (parent) mkdirSync(parent, { recursive: true });
      writeFileSync(resultPath, result);
    }
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-reserve-overrun-run",
    maxInputTokens: 1_000,
    pollIntervalMs: 10,
    timeoutSec: 30,
    usagePolicy: { epoch: "judge-reserve-overrun", maxInputTokens: 1_200, judgeReserveInputTokens: 400, maxPhaseInputTokens: 2_000, maxInvocationTokens: 2_000, cacheReadWeight: 0.1 },
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Complete and use the judge reserve" }),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const runDir = join(directory, ".runs", "judge-reserve-overrun-run");
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = executable;
  try {
    const runPromise = runContract(path);
    try {
      // Await the durable override event instead of racing provider output:
      // the judge parks until the cap crossing is observed and recorded.
      const override = await waitForValue(() => {
        try {
          const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
          return events.find((event) => event.budgetAction?.type === "judge_reserve_override") ?? null;
        } catch {
          return null;
        }
      }, 20_000);
      assert.ok(override, "the run cap is reached while the judge is active and the durable override is recorded");
    } finally {
      writeFileSync(release, "release");
    }
    const result = await runPromise;
    const state = nodeState(result);
    assert.equal(state.status, "done", state.error?.message);
    assert.equal(state.gate?.verdict, "pass");
    const judgeInvocations = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
    assert.equal(judgeInvocations.length, 1, "the active judge is never killed and completes exactly once");
    assert.ok((judgeInvocations[0]?.usage?.inputTokens ?? 0) >= 500, "the judge completes from the judge reserve and reports its spend");
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const overrides = events.filter((event) => event.budgetAction?.type === "judge_reserve_override");
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].budgetAction.reason, "an active judge is protected from the run worker cap");
    assert.equal(overrides[0].budgetAction.judgeReserveInputTokens, 400);
    const epoch = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8")).epochs["judge-reserve-overrun"];
    const invocations = Object.values(epoch.invocations);
    const spent = invocations.reduce((total, invocation) => total + (invocation.usage?.inputTokens ?? 0), 0);
    assert.ok(spent >= epoch.policy.maxInputTokens, `worker plus judge spend (${spent}) reaches the campaign cap (${epoch.policy.maxInputTokens})`);
    assert.ok(invocations.some((invocation) => invocation.role === "judge" && (invocation.usage?.inputTokens ?? 0) >= 500), "the judge spend is recorded against the campaign ledger");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    try { writeFileSync(release, "release"); } catch {}
  }
});

test("an active worker stops before consuming the judge reserve", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-worker-reserve-"));
  const path = writeContract(directory, fixture({
    id: "worker-reserve-run",
    maxInputTokens: 1_000,
    pollIntervalMs: 10,
    timeoutSec: 5,
    usagePolicy: { epoch: "worker-reserve", maxInputTokens: 1_000, judgeReserveInputTokens: 500, maxPhaseInputTokens: 1_000, maxInvocationTokens: 200, cacheReadWeight: 0.1 },
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ objective: "Flood the worker allowance" }), gate: { failOn: ["critical"] } }],
  }));
  const result = await withFakeCodex(directory, "worker-reserve-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "budget_exceeded");
  assert.equal(state.usage?.inputTokens, 600);
});

test("budget failover boundary D37 never routes a local budget stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-budget-no-failover-"));
  const path = writeContract(directory, fixture({
    id: "budget-no-failover-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "codex", model: "primary" },
      backup: { driver: "codex", model: "backup" },
    },
    runtimeRules: [{ match: { currentRuntime: "primary", status: "exhausted" }, runtime: "backup" }],
    nodes: [{
      id: "build",
      type: "backend",
      runtime: "primary",
      taskPacket: packet({ objective: "Flood tokens locally" }),
      maxInputTokens: 500,
      budgetProfile: budgetProfile(),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "budget_attention");
  assert.deepEqual(state.invocations?.map(invocation => invocation.runtimeId), ["primary"]);
  assert.equal(state.routing?.history.length, 0);
});

/** @param {string} prefix @param {Record<string, unknown>} overrides @returns {import("./contract.mjs").ValidatedContract} */
function failoverContract(prefix, overrides) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = writeContract(directory, fixture({
    id: `${prefix}contract`,
    runtimeDefaults: { worker: "mid", judge: "mid" },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", runtime: "mid", taskPacket: packet(), gate: false }],
    ...overrides,
  }));
  return validateContract(JSON.parse(readFileSync(path, "utf8")), path);
}

/** Three runtimes whose costRank deliberately disagrees with declaration order. @returns {Record<string, unknown>} */
function rankedRuntimes() {
  return {
    mid: { driver: "codex", model: "mid", costRank: 2 },
    dear: { driver: "codex", model: "dear", costRank: 9 },
    cheap: { driver: "codex", model: "cheap", costRank: 1 },
  };
}

test("synthesized failover edges follow costRank, not declaration order", () => {
  const contract = failoverContract("runner-synth-failover-", { runtimes: rankedRuntimes() });
  assert.deepEqual(
    failoverEdges(contract).filter((edge) => edge.from === "mid").map((edge) => edge.to),
    ["cheap", "dear"],
    "the cheapest healthy runtime is tried before the dear one",
  );
  assert.ok(failoverEdges(contract).every((edge) => edge.source === "synthesized"));
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid"), "cheap");
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid", ["cheap"]), "dear");
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid", ["cheap", "dear"]), null, "a spent chain routes nowhere");
  assert.equal(nextSynthesizedRuntime(contract, "judge", "mid"), null, "a judge stays on the runtime the contract named");
});

test("an unranked runtime sorts last in the synthesized failover chain", () => {
  const contract = failoverContract("runner-unranked-failover-", {
    runtimes: {
      mid: { driver: "codex", model: "mid", costRank: 2 },
      unranked: { driver: "codex", model: "unranked" },
      cheap: { driver: "codex", model: "cheap", costRank: 1 },
    },
  });
  assert.deepEqual(failoverEdges(contract).filter((edge) => edge.from === "mid").map((edge) => edge.to), ["cheap", "unranked"]);
});

test("an unranked runtime sorts after even the most expensive costRank in the failover chain", () => {
  // costRank only has to be a finite non-negative number, so a contract may
  // declare one at or past any sentinel a ranked-last encoding could pick.
  const contract = failoverContract("runner-extreme-rank-failover-", {
    runtimes: {
      mid: { driver: "codex", model: "mid", costRank: 2 },
      unranked: { driver: "codex", model: "unranked" },
      astronomical: { driver: "codex", model: "astronomical", costRank: Number.MAX_SAFE_INTEGER },
    },
  });
  assert.deepEqual(
    failoverEdges(contract).filter((edge) => edge.from === "mid").map((edge) => edge.to),
    ["astronomical", "unranked"],
    "every ranked runtime is still cheaper than an unranked one",
  );
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid"), "astronomical");
});

test("declared runtimeRules suppress failover synthesis entirely", () => {
  const contract = failoverContract("runner-declared-failover-", {
    runtimes: rankedRuntimes(),
    runtimeRules: [{ match: { role: "worker", currentRuntime: "mid" }, runtime: "dear" }],
  });
  assert.deepEqual(failoverEdges(contract), [{ from: "mid", to: "dear", source: "declared", ruleIndex: 0 }]);
  assert.equal(nextSynthesizedRuntime(contract, "worker", "mid"), null, "a declared rule set owns its routing outright");
});

// A fixed clock keeps these cases deterministic: the schedule is judged against
// now at both ends, so wall-clock drift must not decide the assertions.
const RESET_NOW = Date.parse("2026-09-04T06:00:00.000Z");

test("a quota reset before the node deadline schedules the retry at the reset time", () => {
  const resetAt = "2026-09-04T12:00:00.000Z";
  const deadline = "2026-09-04T18:00:00.000Z";
  assert.deepEqual(quotaResetSchedule({ error: { code: "quota_exhausted", resetAt } }, deadline, RESET_NOW), { kind: "reset", at: resetAt });
  assert.deepEqual(quotaResetSchedule({ resetAt: Date.parse(resetAt) }, deadline, RESET_NOW), { kind: "reset", at: resetAt });
  assert.deepEqual(quotaResetSchedule({ resetAt }, null, RESET_NOW), { kind: "reset", at: resetAt }, "a node with no deadline can always wait");
});

test("a quota reset at or after the node deadline takes the failover edge", () => {
  const deadline = "2026-09-04T12:00:00.000Z";
  assert.deepEqual(quotaResetSchedule({ error: { resetAt: "2026-09-04T18:00:00.000Z" } }, deadline, RESET_NOW), { kind: "failover" });
  assert.deepEqual(quotaResetSchedule({ resetAt: deadline }, deadline, RESET_NOW), { kind: "failover" }, "a reset exactly at the deadline is too late");
  assert.deepEqual(quotaResetSchedule({ error: { code: "quota_exhausted" } }, deadline, RESET_NOW), { kind: "failover" }, "no announced reset always fails over");
  assert.deepEqual(quotaResetSchedule({ resetAt: "not a time" }, deadline, RESET_NOW), { kind: "failover" });
  assert.deepEqual(quotaResetSchedule(null, deadline, RESET_NOW), { kind: "failover" });
});

test("a quota reset at or before now takes the failover edge instead of hot-looping", () => {
  const deadline = "2026-09-04T18:00:00.000Z";
  // A stale reset would otherwise park the phase on a zero-length backoff and
  // re-invoke the exhausted runtime at once, forever if the provider repeats it.
  assert.deepEqual(quotaResetSchedule({ resetAt: "2026-09-04T05:00:00.000Z" }, deadline, RESET_NOW), { kind: "failover" }, "a reset already in the past buys no wait");
  assert.deepEqual(quotaResetSchedule({ error: { resetAt: new Date(RESET_NOW) } }, deadline, RESET_NOW), { kind: "failover" }, "a reset exactly at now buys no wait");
  assert.deepEqual(quotaResetSchedule({ resetAt: RESET_NOW + 1 }, deadline, RESET_NOW), { kind: "reset", at: new Date(RESET_NOW + 1).toISOString() }, "one millisecond of wait still beats a hop");
});

test("a quota reset retry spends no failover hop", () => {
  const reset = /** @type {const} */ ({ kind: "reset" });
  const failover = /** @type {const} */ ({ kind: "failover" });
  const parked = { routing: { currentOverride: { role: "worker", revision: 0, hop: 1 }, history: [{ role: "worker", revision: 0, hop: 1 }] } };
  assert.equal(nextHop({ routing: null }, "worker", 0, failover), 1, "the first real edge is hop 1");
  assert.equal(nextHop({ routing: null }, "worker", 0, reset), 0, "a reset retry off a fresh node stays at hop 0");
  assert.equal(nextHop(parked, "worker", 0, reset), 1, "waiting again never advances the budget");
  assert.equal(nextHop(parked, "worker", 0, failover), 2, "only an actual edge advances it");
  // The regression the hop cap made possible: with two runtimes the cap is 2,
  // so charging a reset retry would push the following real edge to 2 and get
  // it rejected before the second runtime was ever tried.
  assert.equal(nextHop({ routing: { currentOverride: { role: "worker", revision: 0, hop: nextHop({ routing: null }, "worker", 0, reset) } } }, "worker", 0, failover), 1);
  assert.equal(nextHop({ routing: { history: [{ role: "worker", revision: 0, hop: 3 }, { role: "judge", revision: 0, hop: 9 }] } }, "worker", 0, failover), 4, "another role's hops are not this role's budget");
  assert.equal(nextHop({ routing: { history: [{ role: "worker", revision: 0, hop: 3 }] } }, "worker", 1, failover), 1, "a new revision starts its budget over");
});

const NETWORK_NOW = Date.parse("2026-09-04T06:00:00.000Z");
const NETWORK_DEADLINE = "2026-09-04T12:00:00.000Z";
/** Fixed jitter draw: the classification under test, not the random number generator. */
const halfJitter = () => 0.5;

test("network backoff classifies a dropped connection but hands node-owned deadlines straight to failover", () => {
  const options = { now: NETWORK_NOW, random: halfJitter, deadline: NETWORK_DEADLINE };
  assert.deepEqual(
    classifyTransition({ status: "failed", error: { code: "provider_error", message: "socket hang up" } }, options),
    { kind: "reset", at: new Date(NETWORK_NOW + 750).toISOString(), reason: "network_backoff" },
    "a CLI that reports only prose is still classified off its message",
  );
  assert.equal(classifyTransition({ error: { code: "ECONNRESET", message: "" } }, options).reason, "network_backoff", "an error class needs no message");
  assert.equal(classifyTransition({ error: { code: "provider_error", message: "boom" } }, { ...options, exitCode: 28 }).reason, "network_backoff", "a timeout exit code is enough on its own");
  assert.deepEqual(
    classifyTransition({ error: { code: "provider_error", message: "deliberate failure" } }, { ...options, exitCode: 1 }),
    { kind: "failover", reason: "provider" },
    "a provider CLI exits 1 for everything, so exit 1 is evidence of nothing",
  );
  for (const error of [
    { code: "wall_clock_timeout", message: "worker ran longer than 30s" },
    { code: "progress_stalled", message: "allowed workspace scope made no progress" },
    { code: "stall_timeout", message: "no provider output for 30s" },
  ]) {
    assert.equal(isTimeoutOrStall(error), true, `${error.code} is the node's own deadline`);
    assert.equal(classifyTransition({ error }, options).reason, "provider", `${error.code} never buys a network wait`);
  }
  assert.equal(isTimeoutOrStall({ code: "ECONNRESET", message: "socket hang up" }), false);
  assert.equal(
    classifyTransition({ error: { code: "unexpected_write", message: "verification log mentions connection reset by peer" } }, options).reason,
    "provider",
    "a failure the run imposed on itself keeps its own settlement, whatever its message quotes",
  );
  assert.equal(
    classifyTransition({ resetAt: "2026-09-04T07:00:00.000Z", error: { code: "ECONNRESET", message: "" } }, options).reason,
    "quota_reset",
    "an announced reset instant outranks a guessed wait",
  );
});

test("network backoff windows grow exponentially, stay jittered, and cap at two minutes", () => {
  assert.equal(backoffDelayMs(0, () => 0), 500);
  assert.equal(backoffDelayMs(0, () => 1), 1_000);
  assert.equal(backoffDelayMs(1, () => 0), 1_000);
  assert.equal(backoffDelayMs(2, () => 1), 4_000);
  assert.equal(backoffDelayMs(20, () => 1), NETWORK_BACKOFF_CAP_MS, "the cap holds however far the exponent runs");
  assert.equal(backoffDelayMs(20, () => 0), NETWORK_BACKOFF_CAP_MS / 2);
  // No wait may round to zero: a zero-length backoff parks the phase and
  // re-invokes the same failing runtime in the same tick, forever.
  for (let attempt = 0; attempt < 8; attempt += 1) assert.ok(backoffDelayMs(attempt, () => 0) > 0, `attempt ${attempt} waited nothing`);
});

test("network backoff spends three attempts on the warm runtime before it takes the failover edge", () => {
  const envelope = { status: "failed", error: { code: "provider_error", message: "connection reset by peer" } };
  const options = { now: NETWORK_NOW, random: halfJitter, deadline: NETWORK_DEADLINE };
  /** @param {number} count @param {string} [errorCode] */
  const parked = (count, errorCode = "network_backoff:provider_error") => ({
    routing: {
      history: Array.from({ length: count }, () => ({ role: "worker", revision: 0, runtime: "first", nextRuntime: "first", errorCode })),
      currentOverride: null,
    },
  });
  for (let spent = 0; spent < NETWORK_MAX_ATTEMPTS; spent += 1) {
    const attempt = networkBackoffAttempts(parked(spent), "worker", 0);
    assert.equal(attempt, spent, "the attempt budget is read back off the durable node");
    assert.equal(classifyTransition(envelope, { ...options, attempt }).kind, "reset");
  }
  assert.deepEqual(classifyTransition(envelope, { ...options, attempt: NETWORK_MAX_ATTEMPTS }), { kind: "failover", reason: "network_backoff" });
  assert.equal(networkBackoffAttempts(parked(3), "judge", 0), 0, "another role's waits are not this role's budget");
  assert.equal(networkBackoffAttempts(parked(3), "worker", 1), 0, "a new revision starts its budget over");
  assert.equal(networkBackoffAttempts(parked(3, "quota_exhausted"), "worker", 0), 0, "a quota wait is not a network wait");
  assert.deepEqual(
    classifyTransition(envelope, { ...options, deadline: new Date(NETWORK_NOW + 100).toISOString() }),
    { kind: "failover", reason: "network_backoff" },
    "a wait the node cannot outlive is not a recovery",
  );
  assert.equal(nextHop({ routing: null }, "worker", 0, classifyTransition(envelope, options)), 0, "staying on the warm runtime costs no hop");
});

test("an unspent repair keeps the worker result on its provider and a spent one takes the failover edge", () => {
  assert.equal(isRepairable({ gate: { enabled: true, maxRevisions: 1 } }, { revisions: 0 }), true);
  assert.equal(isRepairable({ gate: { enabled: true, maxRevisions: 1 } }, { revisions: 1 }), false);
  assert.equal(isRepairable({ gate: { enabled: true, maxRevisions: 0 } }, { revisions: 0 }), false);
  assert.equal(isRepairable({ gate: { enabled: true } }, { revisions: 0 }), true, "one repair by default");
  assert.equal(isRepairable({ gate: { enabled: false, maxRevisions: 3 } }, { revisions: 0 }), false, "a gateless node has no repair to spend");
});

test("a transient network failure retries on the warm runtime before it spends a failover hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-network-backoff-"));
  // The counter lives outside the workspace: a provider that writes into the
  // contract cwd trips the unexpected-write gate before the network path runs.
  const outside = mkdtempSync(join(tmpdir(), "runner-network-calls-"));
  const calls = join(outside, "network-calls.txt");
  const flaky = join(outside, "flaky-provider.mjs");
  writeFileSync(flaky, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("flaky 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(calls)}, "call\\n");
  const seen = readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length;
  console.log(JSON.stringify({ type: "thread.started", thread_id: "flaky" }));
  if (seen === 1) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "socket hang up: connection reset by peer" } }));
    process.exit(1);
  }
  const text = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
});
`);
  chmodSync(flaky, 0o755);
  const path = writeContract(directory, fixture({
    id: "network-backoff-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeRules: [],
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "codex", model: "primary", executable: flaky, costRank: 1 },
      spare: { driver: "codex", model: "spare", executable: fakeCodex(directory, "pass"), costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["primary", "primary"], "the warm runtime gets the retry, not the spare");
  const history = state.routing?.history ?? [];
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "failed");
  assert.equal(history[0].errorCode, "network_backoff:provider_error", "the wait is countable and the provider's own code stays visible");
  assert.equal(history[0].nextRuntime, "primary");
  assert.equal(history[0].hop, 0, "a network wait spends no failover hop");
  const waited = history[0].backoffSec ?? 0;
  assert.ok(waited > 0 && waited <= 1, `unexpected backoff ${waited}`);
});

test("a judge that lost its socket takes the network backoff, not its one judge_unavailable re-dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-network-backoff-"));
  // Outside the workspace: a provider that writes into the contract cwd trips
  // the unexpected-write gate before the network path ever runs.
  const outside = mkdtempSync(join(tmpdir(), "runner-judge-network-calls-"));
  const calls = join(outside, "judge-calls.txt");
  const flaky = join(outside, "flaky-judge.mjs");
  writeFileSync(flaky, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("flaky 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  console.log(JSON.stringify({ type: "thread.started", thread_id: "flaky" }));
  if (!prompt.startsWith("Review node")) {
    const text = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  appendFileSync(${JSON.stringify(calls)}, "judge\\n");
  const seen = readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length;
  if (seen === 1) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "socket hang up: connection reset by peer" } }));
    process.exit(1);
  }
  const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
});
`);
  chmodSync(flaky, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-network-backoff-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeRules: [],
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: { primary: { driver: "codex", model: "primary", executable: flaky } },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.judgeFailures ?? 0, 0, "a network wait spends none of the judge_unavailable budget");
  const history = (state.routing?.history ?? []).filter((entry) => entry.role === "judge");
  assert.equal(history.length, 1);
  assert.equal(history[0].errorCode, "network_backoff:provider_error");
  assert.equal(history[0].nextRuntime, "primary", "the judge stays on the runtime the gate named");
  assert.equal(history[0].hop, 0, "a network wait spends no failover hop");
  const outbox = readNotificationOutbox(join(directory, ".runs", "campaigns", "test-campaign"));
  assert.ok(!outbox.some((event) => event.type === "run.attention"), "a recovered socket raises no attention");
});

test("undeclared quota exhaustion takes the synthesized failover edge to the cheapest runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-synth-quota-failover-"));
  const exhausted = fakeCodex(directory, "quota-429");
  const cheap = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "synth-failover-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeRules: [],
    runtimeDefaults: { worker: "mid", judge: "mid" },
    runtimes: {
      mid: { driver: "codex", model: "mid", executable: exhausted, costRank: 2 },
      dear: { driver: "codex", model: "dear", executable: exhausted, costRank: 9 },
      cheap: { driver: "codex", model: "cheap", executable: cheap, costRank: 1 },
    },
    nodes: [{ id: "build", type: "backend", runtime: "mid", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["mid", "cheap"]);
  assert.equal(state.routing?.history?.[0]?.nextRuntime, "cheap");
  assert.equal(state.routing?.history?.[0]?.ruleIndex, undefined, "a synthesized edge cites no declared rule");
});

test("quota exhaustion routes through the declared failover edge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-quota-failover-"));
  const primary = fakeCodex(directory, "quota-429");
  const backup = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "quota-failover-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "codex", model: "primary", executable: primary },
      backup: { driver: "codex", model: "backup", executable: backup },
    },
    runtimeRules: [{ match: { role: "worker", status: "exhausted", errorCode: "quota_exhausted", currentRuntime: "primary" }, runtime: "backup" }],
    nodes: [{ id: "build", type: "backend", runtime: "primary", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["primary", "backup"]);
  assert.equal(state.routing?.history?.length ?? 0, 1);
  assert.equal(state.routing?.history?.[0]?.nextRuntime, "backup");
  assert.equal(state.routing?.history?.[0]?.errorCode, "quota_exhausted");
  const first = state.invocations?.[0];
  assert.ok(first, "first invocation exists");
  const settlement = JSON.parse(readFileSync(join(result.runDir, "operations", `${first.id}.settlement.json`), "utf8"));
  assert.equal(settlement.error?.code, "quota_exhausted");
});

test("codex invocation limit derives from the current derived cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-invocation-limit-"));
  const executable = join(directory, "argv-recording-codex.mjs");
  const argvLog = join(directory, ".runs", "codex-argv.jsonl");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("argv-codex 1.0.0");
else {
  appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "limit-thread" }));
  const text = JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
}
`);
  chmodSync(executable, 0o755);
  const cacheReadWeight = 0.2;
  const maxInvocationTokens = 1000;
  const profile = budgetProfile({ estimatedWeightedInputTokens: 120 });
  const decision = deriveBudgetDecision(profile, {
    packetHash: "a".repeat(64),
    scopeHash: "b".repeat(64),
    verificationHash: "c".repeat(64),
    runtimeId: "primary",
    packetBytes: 100,
    phaseRemainingTokens: 10_000,
    campaignRemainingTokens: 10_000,
    judgeReserveTokens: 0,
    pendingReserveTokens: 0,
    explicitHardCeilingTokens: null,
  });
  assert.equal(decision.status, "allocated", decision.rejectReason ?? "");
  const expectedLimit = Math.min(maxInvocationTokens, Math.floor(decision.initialAllocationTokens / cacheReadWeight));
  const path = writeContract(directory, fixture({
    id: "invocation-limit-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    usagePolicy: { epoch: "invocation-limit", maxInputTokens: 10_000, judgeReserveInputTokens: 0, maxPhaseInputTokens: 10_000, maxInvocationTokens, cacheReadWeight },
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: { primary: { driver: "codex", model: "primary", executable } },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      runtime: "primary",
      taskPacket: packet(),
      budgetProfile: profile,
      progressPolicy: { graceSec: 0, intervalSec: 0.05, maxDryHeartbeats: 1000 },
      gate: false,
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.budgetDecision?.initialAllocationTokens, decision.initialAllocationTokens);
  const args = /** @type {string[]} */ (JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0]));
  const rollout = args.find((arg) => arg.startsWith("features.rollout_budget="));
  assert.ok(rollout, "codex receives the native rollout budget");
  assert.match(rollout, new RegExp(`limit_tokens=${expectedLimit}(?:[^0-9]|$)`));
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const limitEvents = events.filter((event) => event.budgetAction?.type === "invocation_limit");
  assert.equal(limitEvents.length, 1);
  assert.equal(limitEvents[0].budgetAction.limitTokens, expectedLimit);
  assert.equal(limitEvents[0].budgetAction.remainingWeighted, decision.initialAllocationTokens);
  assert.equal(limitEvents[0].budgetAction.cacheReadWeight, cacheReadWeight);
});

test("rollout budget exhaustion settles as a derived budget stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rollout-budget-stop-"));
  const path = writeContract(directory, fixture({
    id: "rollout-budget-stop-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    maxInputTokens: 2000,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Run against the native rollout budget" }),
      budgetProfile: budgetProfile({
        estimatedWeightedInputTokens: 500,
        continuation: { enabled: true, maxSegments: 2, segmentReserveTokens: 500 },
      }),
      progressPolicy: { graceSec: 0, intervalSec: 0.05, maxDryHeartbeats: 1000 },
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "rollout-budget", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "budget_attention");
  assert.equal(state.routing?.history?.length ?? 0, 0);
  assert.equal(state.budgetState?.status, "attention");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["luna"]);
});

test("wall-clock kill without usage charges the remaining derived cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-wallclock-estimate-"));
  const path = writeContract(directory, fixture({
    id: "wallclock-estimate-run",
    pollIntervalMs: 10,
    timeoutSec: 1,
    usagePolicy: { epoch: "wallclock-estimate", maxInputTokens: 2000, judgeReserveInputTokens: 0, maxPhaseInputTokens: 2000, maxInvocationTokens: 1000, cacheReadWeight: 0.1 },
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Run silently past the wall clock" }),
      budgetProfile: budgetProfile(),
      progressPolicy: { graceSec: 0, intervalSec: 0.05, maxDryHeartbeats: 1000 },
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "silent", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "wall_clock_timeout");
  const invocation = state.invocations?.[0];
  assert.equal(invocation?.usageEstimated, true, "killed invocation usage is flagged as estimated");
  assert.equal(invocation?.usage?.inputTokens, state.budgetState?.currentCapTokens, "estimate charges the remaining derived cap");
  assert.equal(state.usage?.inputTokens, state.budgetState?.currentCapTokens);
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  const entries = Object.values(ledger.epochs["wallclock-estimate"].invocations);
  assert.equal(entries.length, 1, "the estimated charge reaches the campaign ledger once");
  assert.equal(entries[0].usage.inputTokens, state.budgetState?.currentCapTokens);
});

test("budget continuation D35 checkpoints and activates one predeclared segment with identical continuation scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-budget-continuation-"));
  // The continuation provider stays silent before announcing its session so
  // the persisted pending segment is observable from the node snapshot while
  // it exists, before activateBudgetContinuation settles it.
  const provider = budgetContinuationCodex(directory, { continuationDelayMs: 350 });
  const path = writeContract(directory, fixture({
    id: "budget-continuation-run",
    pollIntervalMs: 5,
    timeoutSec: 5,
    runtimes: { worker: { driver: "codex", model: "budget-test", executable: provider.executable } },
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimeRules: [],
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Continue at the declared budget boundary" }),
      maxInputTokens: 1_000,
      budgetProfile: budgetProfile({
        estimatedWeightedInputTokens: 500,
        continuation: { enabled: true, maxSegments: 2, segmentReserveTokens: 500 },
      }),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 100 },
      gate: false,
    }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{status: string, phase: string, pending: Record<string, unknown>, decision: Record<string, unknown>}[]} */
  const pendingSamples = [];
  const sampler = setInterval(() => {
    try {
      const node = JSON.parse(readFileSync(nodePath, "utf8"));
      const pending = /** @type {Record<string, unknown>|null|undefined} */ (node.budgetState?.pendingSegment);
      const decision = /** @type {Record<string, unknown>|null|undefined} */ (node.budgetDecision);
      if (pending && decision) pendingSamples.push({ status: node.status, phase: node.phase, pending, decision });
    } catch {}
  }, 2);
  try {
    const result = await runContract(path);
    const state = nodeState(result);
    assert.equal(state.status, "done", state.error?.message);
    assert.deepEqual(state.budgetState?.activatedSegments, [1, 2]);
    assert.equal(state.budgetState?.pendingSegment, null);
    // While the predeclared continuation was pending, its frozen identity hashes
    // must equal the budget decision that authorized it.
    assert.ok(pendingSamples.length > 0, "observed the pending segment before it was activated");
    for (const sample of pendingSamples) {
      assert.equal(sample.pending.packetHash, sample.decision.packetHash, "pending packetHash matches the budget decision while the segment exists");
      assert.equal(sample.pending.scopeHash, sample.decision.scopeHash, "pending scopeHash matches the budget decision while the segment exists");
      assert.equal(sample.pending.verificationHash, sample.decision.verificationHash, "pending verificationHash matches the budget decision while the segment exists");
    }
    const calls = readFileSync(provider.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.continuation), [false, true]);
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.budgetAction?.type === "continuation_planned").length, 1);
    assert.equal(events.filter(event => event.budgetAction?.type === "continuation_activated").length, 1);
    const planned = events.find((event) => event.budgetAction?.type === "continuation_planned");
    const packetHash = state.budgetDecision?.packetHash;
    assert.ok(packetHash && typeof planned?.budgetAction?.id === "string" && planned.budgetAction.id.startsWith(packetHash), `planned segment ${planned?.budgetAction?.id ?? ""} must carry the frozen decision packetHash ${packetHash ?? "missing"}`);
  } finally {
    clearInterval(sampler);
  }
});

test("budget liveness D36 records heartbeat attention and a human-channel event within one supervisor interval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-liveness-"));
  const path = writeContract(directory, fixture({
    id: "node-cap-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Flood tokens" }),
      maxInputTokens: 500,
      budgetProfile: budgetProfile(),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const campaignPath = join(directory, ".runs", "campaigns", "test-campaign");
  const notifier = join(directory, "notify-success.mjs");
  writeFileSync(notifier, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  let result;
  try {
    result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
  }
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "budget_attention");
  const heartbeatPath = join(campaignPath, "heartbeat.json");
  assert.equal(existsSync(heartbeatPath), true, "heartbeat.json exists in the campaign directory");
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8"));
  assert.equal(heartbeat.state, "blocked");
  assert.match(String(heartbeat.attention ?? ""), /budget/u, "heartbeat attention names the budget block");
  const journal = readFileSync(join(campaignPath, "journal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(journal.some((entry) => entry.type === "liveness"), "journal.jsonl records at least one liveness fact");
  const outbox = readNotificationOutbox(campaignPath);
  const attention = outbox.find((event) => event.type === "run.attention" && event.data?.code === "budget_attention");
  assert.ok(attention, "outbox holds the budget_attention run.attention event");
  assert.notEqual(attention.deliveredAt, null, "the attention event reached the human-channel transport");
});

test("liveness progress ignores invocation-only churn and never uses the current time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-liveness-progress-"));
  // The noise worker only emits provider turns (invocation updates rewrite
  // node.updatedAt with no status or phase change); the build worker finishes.
  // The slow notifier widens the gap between a transition and its liveness
  // record so churn landing in that gap would otherwise advance lastProgressAt.
  const executable = join(directory, "mixed-worker.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("mixed-worker 1.0.0");
else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.includes("Noise flood")) {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "noise-thread" }));
      let turns = 0;
      setInterval(() => {
        turns += 1;
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: turns * 10, output_tokens: 1 } }));
      }, 10);
      return;
    }
    console.log(JSON.stringify({ type: "thread.started", thread_id: "build-thread" }));
    const resultPath = /file: (\\S+\\.json)/.exec(input)?.[1];
    if (resultPath) writeFileSync(resultPath, JSON.stringify({ status: "done", summary: "build done", changedFiles: [], verification: [], artifacts: [], missingContext: [] }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "build done" } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "liveness-progress-run",
    pollIntervalMs: 5,
    timeoutSec: 5,
    maxInputTokens: 1_000_000,
    runtimes: { worker: { driver: "codex", model: "mixed", executable } },
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimeRules: [],
    nodes: [
      { id: "noise", type: "backend", taskPacket: packet({ objective: "Noise flood" }), timeoutSec: 1, gate: false },
      { id: "build", type: "backend", taskPacket: packet({ objective: "Build quickly" }), gate: false },
    ],
  }));
  const notifier = join(directory, "notify-slow.mjs");
  writeFileSync(notifier, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 120);\n`);
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result, "noise").status, "exhausted", "the flooding node is stopped by its wall-clock deadline");
    assert.equal(nodeState(result, "build").status, "done", "the quiet node completes");
    const campaignPath = join(directory, ".runs", "campaigns", "test-campaign");
    const journal = readFileSync(join(campaignPath, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const facts = journal.filter((entry) => entry.type === "liveness");
    assert.ok(facts.length >= 2, "the run records liveness facts around its material transitions");
    const transitions = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line))
      .filter((event) => event.node && event.from && event.to && event.from !== event.to);
    assert.ok(transitions.length >= 2, "the run records distinct status transitions");
    for (const fact of facts) {
      const preceding = transitions.filter((event) => event.at <= fact.at);
      assert.ok(preceding.length > 0, `every liveness fact follows a status transition (fact ${fact.at})`);
      const newestTransitionAt = preceding.reduce((newest, event) => event.at > newest ? event.at : newest, "0");
      assert.ok(
        fact.lastProgressAt <= newestTransitionAt,
        `liveness lastProgressAt ${fact.lastProgressAt} must not exceed the newest transition ${newestTransitionAt} recorded before fact ${fact.at} (invocation-only churn must not count as progress)`,
      );
    }
    const newestTransitionAt = transitions.reduce((newest, event) => event.at > newest ? event.at : newest, "0");
    assert.equal(facts.at(-1)?.lastProgressAt, newestTransitionAt, "the terminal liveness fact folds the last transition, never the current time");
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
  }
});

test("liveness state reports paused_quota only while a provider backoff is pending and failed once exhaustion is terminal", async () => {
  // A failover edge with a future backoffUntil holds its node as pending, so
  // liveness must report paused_quota for that shape and only that shape.
  // Terminal exhaustion with no failover route derives failed even when the
  // error is quota-flavored: the run is not waiting for a provider to come
  // back, it is over.
  const directory = mkdtempSync(join(tmpdir(), "runner-liveness-state-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const backoffPath = writeContract(directory, fixture({
    id: "liveness-backoff-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first },
      second: { driver: "codex", model: "second", executable: second },
    },
    // The backoff window must exceed the event-loop delay under full-suite load so a poll journals paused_quota inside it.
    runtimeRules: [{ match: { role: "worker", status: "exhausted", errorCode: "provider_error", currentRuntime: "first" }, runtime: "second", backoffSec: 2 }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const backoffResult = await runContract(backoffPath);
  const backoffState = nodeState(backoffResult);
  assert.equal(backoffState.status, "done", backoffState.error?.message);
  const backoffFacts = readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "journal.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "liveness");
  const backoffStates = backoffFacts.map((fact) => fact.state);
  assert.ok(backoffStates.includes("paused_quota"), `a run awaiting its failover backoff journals paused_quota (saw ${backoffStates.join(",")})`);

  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-liveness-terminal-"));
  const quotaPrimary = fakeCodex(terminalDirectory, "quota-429");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "liveness-quota-terminal-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: { primary: { driver: "codex", model: "primary", executable: quotaPrimary } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const terminalResult = await runContract(terminalPath);
  const terminalState = nodeState(terminalResult);
  assert.equal(terminalState.status, "exhausted", terminalState.error?.message);
  assert.equal(terminalState.error?.code, "quota_exhausted");
  const terminalFacts = readFileSync(join(terminalDirectory, ".runs", "campaigns", "test-campaign", "journal.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "liveness");
  const terminalStates = terminalFacts.map((fact) => fact.state);
  assert.ok(terminalStates.includes("failed"), `terminal quota exhaustion without a failover route journals failed (saw ${terminalStates.join(",")})`);
  assert.ok(!terminalStates.includes("paused_quota"), `terminal exhaustion must not be reported as a live quota pause (saw ${terminalStates.join(",")})`);
  assert.equal(terminalStates.at(-1), "failed", `the terminal run's final liveness fact reports failed (saw ${terminalStates.join(",")})`);
});

test("campaign maxInputTokens stops a running worker once the budget is spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cap-"));
  const path = writeContract(directory, fixture({
    id: "campaign-cap-run",
    maxInputTokens: 2000,
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ objective: "Flood tokens" }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "token-flood", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "budget_exceeded");
  assert.equal(result.ok, false);
  assert.ok((state.usage?.inputTokens ?? 0) > 0, "stopped worker still reports its spend");
});

test("native rollout-budget exhaustion charges the declared ceiling when Codex omits usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rollout-budget-accounting-"));
  const path = writeContract(directory, fixture({
    id: "rollout-budget-accounting-run",
    usagePolicy: { epoch: "rollout-budget-accounting", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "rollout-budget", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.deepEqual(state.usage, { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 0 });
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  assert.deepEqual(Object.values(ledger.epochs["rollout-budget-accounting"].invocations).map((entry) => entry.usage), [
    { inputTokens: 50, outputTokens: null, cacheReadInputTokens: null },
  ]);
});

test("reuses one worker continuation per ordered phase and charges the campaign ledger once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-reuse-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-reuse-run",
    usagePolicy: { epoch: "phase-reuse", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet({ objective: "Continue it" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, "phase-thread"]);
  assert.deepEqual(result.states.get("second")?.invocations?.map((invocation) => invocation.continuationMode), ["reuse"]);
  const ledger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
  assert.equal(Object.keys(ledger.epochs["phase-reuse"].invocations).length, 2);
  assert.equal(JSON.parse(renderReportJson(result.runDir)).campaignUsage, 2.2);
  assert.equal(JSON.parse(renderReportJson(result.runDir)).campaignRawInput, 4);
});

test("rotates a phase continuation at the soft boundary with a deterministic handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-rotate-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-rotate-run",
    usagePolicy: { epoch: "phase-rotate", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet({ objective: "Continue it" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, null]);
  assert.match(requests[1].prompt, /Prior structured node summaries/u);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
});

test("does not reuse a phase continuation after a runtime identity change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-runtime-identity-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-runtime-identity-run",
    usagePolicy: { epoch: "phase-runtime-identity", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { driver: "exec-jsonl", model: "same-model", executable },
      backup: { driver: "exec-jsonl", model: "same-model", executable },
    },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", runtime: "primary", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", runtime: "backup", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, null]);
  // The runtime identity changed between the two nodes, so the second worker
  // is composed from the portable continuation capsule instead of reusing or
  // rotating the prior session.
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "fresh");
  assert.match(requests[1].prompt, /Portable continuation capsule \(digest /u);
});

test("selects the latest phase continuation by invocation chronology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-chronology-"));
  const requestLog = join(directory, ".runs", "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  const continuationId = request.continuationId ? request.continuationId + "-next" : "phase-1";
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }), continuationId, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-chronology-run",
    usagePolicy: { epoch: "phase-chronology", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "phase-model", executable } },
    runtimeRules: [],
    nodes: [
      { id: "third", type: "backend", phase: "implementation", dependsOn: ["second"], taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, "phase-1", "phase-1-next"]);
});

test("Claude phase reuse passes the first explicit session through --resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-claude-phase-reuse-"));
  const fake = fakeClaudeLike(directory);
  const path = writeContract(directory, fixture({
    id: "claude-phase-reuse-run",
    usagePolicy: false,
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, "session-1"]);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "reuse");
});

test("a completed phase without a continuation ID remains a fresh invocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-no-id-"));
  const fake = fakeClaudeLike(directory, { emitSessionId: false });
  const path = writeContract(directory, fixture({
    id: "phase-no-id-run",
    usagePolicy: false,
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
    runtimeRules: [],
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, null]);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "fresh");
});

test("a non-continuing runtime gets a deterministic fresh phase handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-no-continuation-"));
  const fake = fakeClaudeLike(directory);
  const adapter = getDriver("claude");
  const previous = adapter.capabilities.continuation;
  adapter.capabilities.continuation = false;
  try {
    const path = writeContract(directory, fixture({
      id: "phase-no-continuation-run",
      usagePolicy: false,
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { driver: "claude", model: "test-model", executable: fake.executable } },
      runtimeRules: [],
      nodes: [
        { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
        { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
      ],
    }));
    const result = await runContract(path);
    const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, null]);
    assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
    assert.match(requests[1].prompt, /fresh provider session/u);
  } finally {
    adapter.capabilities.continuation = previous;
  }
});

test("Claude and GLM receive the smallest positive remaining monetary allowance", async () => {
  for (const driver of ["claude", "glm"]) {
    const directory = mkdtempSync(join(tmpdir(), `runner-${driver}-cost-cap-`));
    const fake = fakeClaudeLike(directory, { costUsd: 0.2 });
    const path = writeContract(directory, fixture({
      id: `${driver}-cost-cap-run`,
      maxCostUsd: 0.7,
      usagePolicy: { epoch: `${driver}-cost-cap`, maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { driver, model: "test-model", executable: fake.executable } },
      runtimeRules: [],
      nodes: [
        { id: "first", type: "backend", phase: "implementation", maxCostUsd: 0.6, taskPacket: packet(), gate: false },
        { id: "second", type: "backend", phase: "implementation", maxCostUsd: 2, dependsOn: ["first"], taskPacket: packet(), gate: false },
      ],
    }));
    const result = await runContract(path);
    assert.equal(result.ok, true);
    const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--max-budget-usd")), ["0.6", "0.5"]);
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--max-invocation-tokens")), [null, null]);
  }
});

test("retains a live Codex continuation before capped logs are truncated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-continuation-"));
  const path = writeContract(directory, fixture({
    id: "live-continuation-run",
    usagePolicy: { epoch: "live-continuation", maxInputTokens: 100, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100, maxInvocationTokens: 50, cacheReadWeight: 0.1 },
    timeoutSec: 1,
    pollIntervalMs: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "thread-large-timeout");
  try {
    const first = await runContract(path);
    const firstState = nodeState(first);
    assert.equal(firstState.status, "exhausted");
    assert.equal(firstState.invocations?.[0]?.continuationId, "fake-thread");
    assert.deepEqual(firstState.invocations?.[0]?.usage, { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 1 });
    const firstLedger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
    assert.equal(Object.keys(firstLedger.epochs["live-continuation"].invocations).length, 1, "timeout usage reaches the campaign ledger");
    const resumed = await resumeRun(first.runDir);
    assert.equal(nodeState(resumed).status, "done");
    const finalLedger = JSON.parse(readFileSync(join(directory, ".runs", "campaigns", "test-campaign", "usage-ledger.json"), "utf8"));
    assert.equal(Object.keys(finalLedger.epochs["live-continuation"].invocations).length, 2, "resumed invocation is ledgered once");
    assert.match(readFileSync(join(directory, ".runs", "resume-continuation.txt"), "utf8"), /resume --json .* fake-thread /u);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("a finished run prints the token report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-auto-report-"));
  const path = writeContract(directory, fixture({ pollIntervalMs: 10 }));
  const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
  const result = await withFakeCodex(directory, "pass", () => spawnSync(process.execPath, [runner, "run", path], { encoding: "utf8" }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /totals · in 10/u, "auto-report table");
  assert.match(result.stdout, /worker complete/u, "node note surfaces the worker summary");
});

test("ordinary runs deliver bounded node and run terminal notifications", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-run-notifications-"));
  const path = writeContract(directory, fixture({ id: "run-notifications", pollIntervalMs: 10 }));
  const delivered = join(directory, "delivered.jsonl");
  const notifier = join(directory, "notify.mjs");
  writeFileSync(notifier, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(delivered)}, input); });\n`);
  chmodSync(notifier, 0o755);
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  try {
    await withFakeCodex(directory, "pass", () => runContract(path));
    const events = readFileSync(delivered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "node.terminal" && event.data.nodeId === "build"));
    assert.ok(events.some((event) => event.type === "run.terminal" && event.data.runId === "run-notifications"));
    assert.ok(events.every((event) => event.deliveredAt === null), "delivery payload is the durable pre-delivery event");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
  }
});
test("run warns when a node id is already done in another run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-guard-"));
  const firstPath = writeContract(directory, fixture({ id: "first-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));

  const secondPath = writeContract(directory, fixture({ id: "second-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", secondPath], {
      encoding: "utf8",
    }),
  );
  assert.match(result.stdout, /\[warn\] node build is already done in run first-run/u);
  assert.match(result.stdout, /\[warn\] single-node contract/u);
});

test("run warnings ignore an unrelated historical run with an obsolete contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-obsolete-"));
  const currentPath = writeContract(directory, fixture({ id: "current-run", pollIntervalMs: 10 }));
  const obsoleteRun = join(directory, ".runs", "obsolete-run");
  mkdirSync(join(obsoleteRun, "nodes"), { recursive: true });
  writeFileSync(join(obsoleteRun, "contract.json"), "{ this is obsolete and invalid JSON\n");
  writeFileSync(join(obsoleteRun, "nodes", "old-node.json"), "{}\n");
  const result = await withFakeCodex(directory, "pass", () => spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", currentPath],
    { encoding: "utf8" },
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /obsolete-run/u);
});

test("run warnings ignore a historical snapshot from an older capability schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-old-snapshot-"));
  const firstPath = writeContract(directory, fixture({ id: "old-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));
  const oldNodePath = join(directory, ".runs", "old-run", "nodes", "build.json");
  const oldNode = JSON.parse(readFileSync(oldNodePath, "utf8"));
  delete oldNode.runtime.capabilities.toolPolicy;
  writeFileSync(oldNodePath, `${JSON.stringify(oldNode)}\n`);

  const secondPath = writeContract(directory, fixture({ id: "current-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "run", secondPath],
    { encoding: "utf8" },
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /old-run/u);
});

test("supervise resumes a run whose controller died", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-supervise-"));
  const path = writeContract(directory, fixture({ id: "supervise-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  // Simulate a controller that died mid-work: the node claims running but the
  // recorded pid is gone.
  orphan(runDir, "build");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...metadata, pid: 2_147_483_647 }));

  // The supervisor's resumed controller inherits the supervisor's environment, so
  // the fake provider must stay installed for the whole supervise lifetime.
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "pass");
  const supervisor = spawn(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "supervise", runDir, "--interval", "0.05"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    let stdout = "";
    supervisor.stdout.on("data", (chunk) => { stdout += chunk; });
    const finished = await waitForValue(
      () => (stdout.includes("resumed") && stdout.includes("finished") ? "done" : null),
      20_000,
    );
    assert.equal(finished, "done", stdout);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    supervisor.kill("SIGTERM");
  }
});

test("supervise continues when a stale-lease resume loses to a concurrently healthy controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-supervise-lease-race-"));
  const path = writeContract(directory, fixture({ id: "supervise-lease-race-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...metadata, pid: 2_147_483_647 }));

  // The supervisor sees a stale controller lease and spawns a detached resume.
  writeJsonAtomic(join(runDir, "controller-lease.json"), {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "stale-holder",
    generation: 1,
    pid: 2_147_483_647,
    processStartToken: null,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    renewedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:01.000Z",
  });
  // Hold the controller lease mutation lock before the supervisor starts so the
  // detached resume deterministically loses the takeover instead of stealing the
  // stale lease while the test installs the concurrent healthy controller.
  const lockPath = join(runDir, "controller-lease.json.lock");
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    holderId: "test-lock-holder",
    expiresAt: new Date(Date.now() + 4_000).toISOString(),
  })}\n`, { flag: "wx", mode: 0o600 });

  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "pass");
  const supervisor = spawn(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "supervise", runDir, "--interval", "0.05"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    let stdout = "";
    supervisor.stdout.on("data", (chunk) => { stdout += chunk; });
    const resumed = await waitForValue(() => (stdout.includes("controller lease expired · resumed") ? "resumed" : null), 20_000);
    assert.equal(resumed, "resumed", stdout);

    // A concurrently healthy controller owns the run lease. The detached resume
    // loses the lease race and supervision must continue without attention.
    writeJsonAtomic(join(runDir, "controller-lease.json"), {
      schemaVersion: 1,
      contractVersion: "0.1.0",
      holderId: "concurrent-controller",
      generation: 2,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    unlinkSync(lockPath);

    const contended = await waitForValue(() => (stdout.includes("lease contended") ? "contended" : null), 20_000);
    assert.equal(contended, "contended", stdout);
    assert.equal(existsSync(join(runDir, "supervisor-attention.json")), false, "benign lease contention must not raise attention");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    try { unlinkSync(lockPath); } catch {}
    supervisor.kill("SIGTERM");
  }
});

test("supervisor persists and delivers attention when resume is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-supervisor-attention-"));
  const path = writeContract(directory, fixture({ id: "supervisor-attention-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  metadata.sourceIdentity.cwd = "/unexpected-source";
  writeFileSync(join(runDir, "run.json"), JSON.stringify(metadata));
  const delivered = join(directory, "attention.jsonl");
  const notifier = join(directory, "notify-attention.mjs");
  writeFileSync(notifier, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(delivered)}, input); });\n`);
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  const previousCodex = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "pass");
  try {
    await superviseRun(runDir, 0.01);
    const attention = JSON.parse(readFileSync(join(runDir, "supervisor-attention.json"), "utf8"));
    assert.equal(attention.code, "resume_failed");
    const events = readFileSync(delivered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "run.attention" && event.data.code === "resume_failed"));
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
    if (previousCodex === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previousCodex;
  }
});

test("detached resume surfaces bootstrap failure before reporting success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-failure-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-failure-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  metadata.sourceIdentity.cwd = "/unexpected-source";
  writeFileSync(join(runDir, "run.json"), JSON.stringify(metadata));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source drift detected in cwd/u);
  const bootstrapFailed = await waitForValue(
    () => {
      try { return readFileSync(join(runDir, "bootstrap.json"), "utf8").includes('"status": "failed"') ? "failed" : null; } catch { return null; }
    },
    15_000,
  );
  assert.equal(bootstrapFailed, "failed");
  assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith("bootstrap.json.")), [], "failed detached attempts are cleaned up");
});

test("bootstrap attempt cleanup leaves concurrent failure temp writes intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-cleanup-race-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-cleanup-race-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const temporary = join(runDir, `bootstrap.json.${process.pid}.7a6b4a44-77a7-47a7-97a7-7a7a7a7a7a7a.tmp`);
  const staleAttempt = bootstrapAttemptPath(runDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  writeFileSync(temporary, JSON.stringify({ status: "failed" }));
  writeFileSync(staleAttempt, "{}");
  cleanupBootstrapAttempts(runDir);
  assert.equal(existsSync(staleAttempt), false);
  assert.equal(existsSync(temporary), true);
  renameSync(temporary, bootstrapPath(runDir));
  assert.equal(JSON.parse(readFileSync(bootstrapPath(runDir), "utf8")).status, "failed");
});

test("detached ACK timeout and parse errors clean only their nonce attempt and ACK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-ack-cleanup-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-ack-cleanup-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const errorNonce = "11111111-1111-4111-8111-111111111111";
  writeFileSync(bootstrapAckPath(runDir, errorNonce), "not json\n");
  const errorResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: errorNonce, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.notEqual(errorResult.status, 0);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${errorNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, errorNonce)), false);

  const timeoutNonce = "22222222-2222-4222-8222-222222222222";
  const timeoutResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: timeoutNonce, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.equal(timeoutResult.status, 0, timeoutResult.stderr);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${timeoutNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, timeoutNonce)), false);
});

test("blocks downstream nodes after a failed dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-dependency-"));
  const path = writeContract(directory, fixture({
    id: "dependency-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet({ objective: "Fail" }), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Never run" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "worker-fail");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result, "first").status, "failed");
    assert.equal(nodeState(result, "second").status, "blocked");
    const artifact = /** @type {{nodes: Array<{id: string, error: {code: string}, blockedBy?: string[]}>}} */ (JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8")));
    assert.equal(artifact.nodes.length, 2);
    const blockedNode = artifact.nodes.find((node) => node.id === "second");
    assert.ok(blockedNode, "blocked node recorded in the artifact");
    assert.equal(blockedNode.error.code, "dependency_failed");
    assert.deepEqual(blockedNode.blockedBy, ["first"]);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});

test("rotation triggers at exactly 80 turns or 120000 average cache-read tokens per turn", () => {
  assert.equal(ROTATION_MAX_TURNS, 80);
  assert.equal(ROTATION_AVG_CACHE_READ_TOKENS, 120_000);
  assert.equal(ROTATION_MIN_TURNS_FOR_AVERAGE, 2);
  assert.equal(ROTATION_MAX_TURNS_CLAUDE_FAMILY, 600);
  assert.equal(ROTATION_HANDOFF_MAX_BYTES, 16 * 1024);
  assert.equal(rotationTrigger({ turns: 0, cacheReadInputTokens: 10_000_000, completed: false }), null, "no observed turn means no trusted per-turn average");
  assert.equal(rotationTrigger({ turns: 1, cacheReadInputTokens: 10_000_000, completed: false }), null, "a single observed turn never triggers the average rule");
  assert.equal(rotationTrigger({ turns: 79, cacheReadInputTokens: 79 * 119_999, completed: false }), null, "79 turns under the average stay put");
  assert.equal(rotationTrigger({ turns: 2, cacheReadInputTokens: 2 * ROTATION_AVG_CACHE_READ_TOKENS - 1, completed: false }), null, "one token under the average is not premature");
  assert.match(rotationTrigger({ turns: 80, cacheReadInputTokens: 0, completed: false }) ?? "", /observed turns 80 >= 80/u);
  assert.match(rotationTrigger({ turns: 3, cacheReadInputTokens: 3 * ROTATION_AVG_CACHE_READ_TOKENS, completed: false }) ?? "", /weighted cache-read input 120000/u);
  // The cache-read trigger weights cache reads: a bounded-preamble worker that
  // re-reads a large but cheap context each turn must not rotate every turn.
  assert.equal(rotationTrigger({ turns: 1, cacheReadInputTokens: 374_400, completed: false }, 0.1), null, "cheap cache reads under the weighted threshold stay put");
  assert.match(rotationTrigger({ turns: 2, cacheReadInputTokens: 2_600_000, completed: false }, 0.1) ?? "", /weighted cache-read input 130000 >= 120000/u, "genuinely bloated weighted context still rotates across two turns");
  // claude-family drivers fold one record per assistant turn: the 80-turn
  // provider ceiling would hand off a reading-heavy glm worker every few
  // minutes, so the family gets its own much higher turn ceiling while the
  // cache-read average rule stays identical.
  assert.equal(rotationTrigger({ turns: 81, cacheReadInputTokens: 0, completed: false }, 1, "claude"), null, "81 claude assistant turns never rotate");
  assert.equal(rotationTrigger({ turns: 81, cacheReadInputTokens: 0, completed: false }, 1, "glm"), null, "81 glm assistant turns never rotate");
  assert.match(rotationTrigger({ turns: 600, cacheReadInputTokens: 0, completed: false }, 1, "claude") ?? "", /observed turns 600 >= 600/u);
  assert.match(rotationTrigger({ turns: 600, cacheReadInputTokens: 0, completed: false }, 1, "glm") ?? "", /observed turns 600 >= 600/u);
  assert.match(rotationTrigger({ turns: 600, cacheReadInputTokens: 0, completed: false }) ?? "", /observed turns 600 >= 80/u, "codex keeps the provider-turn ceiling");
  assert.equal(rotationTrigger({ turns: 80, cacheReadInputTokens: 10_000_000, completed: true }), null, "a completed invocation is never rotated, whatever the observed turns");
  assert.equal(rotationTrigger({ turns: 2, cacheReadInputTokens: 2_600_000, completed: true }, 0.1), null, "the completed flag outranks the cache-read trigger");
});

test("automatic rotation turns a fat worker session over at 80 observed turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-turns-"));
  const path = writeContract(directory, fixture({
    id: "rotation-turns-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const { result, argvLog } = await withRotatingCodex(directory, "turns", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  const invocations = state.invocations ?? [];
  assert.equal(invocations.length, 3, "fat session, one-turn handoff, fresh session");
  assert.equal(invocations[1].continuationMode, "reuse", "the handoff resumes the rotated session for one turn");
  assert.equal(invocations[1].continuationId, "fat-thread");
  assert.equal(invocations[2].continuationMode, "fresh", "the post-rotation session is a fresh provider session");
  assert.notEqual(invocations[2].continuationId, "fat-thread", "the fresh session never carries the rotated session identity");
  const rotations = (state.executionOverrides ?? []).filter((item) => item.kind === "rotation");
  assert.equal(rotations.length, 2, "trigger and handoff overrides are durable");
  assert.match(rotations[0].reason ?? "", /observed turns 80 >= 80/u);
  assert.equal(rotations[1].decision, "rotated", "the commissioned handoff is consumed exactly once");
  const runs = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(runs.map((run) => [run.handoffTurn, run.freshTurn]), [[false, false], [true, false], [false, true]]);
  assert.equal(runs[1].resume, true, "the handoff turn resumes the rotated session");
  assert.equal(runs[2].resume, false, "the fresh session does not resume anything");
  const handoff = readFileSync(join(result.runDir, "rotations", "build.1.1.md"), "utf8");
  assert.ok(Buffer.byteLength(handoff, "utf8") <= ROTATION_HANDOFF_MAX_BYTES, "the materialized handoff never exceeds 16 KiB");
  assert.match(handoff, /## Handoff/u);
  assert.match(handoff, /- done: fat session work/u);
  const freshPrompt = readFileSync(/** @type {string} */ (invocations[2].promptPath), "utf8");
  assert.match(freshPrompt, /Continue node build in a fresh provider session/u);
  assert.match(freshPrompt, /Rotation handoff from the previous session/u);
  assert.match(freshPrompt, /- pending: fresh session completion/u, "the handoff content carries over");
  assert.match(freshPrompt, /Bounded git status --short/u);
  assert.match(freshPrompt, /Current closed task packet/u);
  assert.equal(freshPrompt.includes("fat session work"), true);
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "fresh session complete");
});

test("automatic rotation triggers on average cache-read input without 80 turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-cache-"));
  const path = writeContract(directory, fixture({
    id: "rotation-cache-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const { result } = await withRotatingCodex(directory, "cache", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  const rotations = (state.executionOverrides ?? []).filter((item) => item.kind === "rotation");
  assert.equal(rotations.length, 2);
  assert.match(rotations[0].reason ?? "", /weighted cache-read input 130000 >= 120000 tokens\/turn over 2 turns/u);
  assert.equal((state.invocations ?? []).length, 3, "the cache trigger also rotates through the handoff into a fresh session");
});

test("automatic rotation still fires when the transcript outgrows the live observation window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-fat-log-"));
  const path = writeContract(directory, fixture({
    id: "rotation-fat-log-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const { result } = await withRotatingCodex(directory, "fat-log", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  const rotations = (state.executionOverrides ?? []).filter((item) => item.kind === "rotation");
  assert.equal(rotations.length, 2, "trigger and handoff fire despite the padding");
  assert.match(rotations[0].reason ?? "", /observed turns 80 >= 80/u);
  assert.equal((state.invocations ?? []).length, 3, "fat session, one-turn handoff, fresh session");
  assert.equal((state.invocations ?? []).at(-1)?.continuationMode, "fresh");
});

test("a session under both rotation thresholds completes without rotating", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-under-"));
  const path = writeContract(directory, fixture({
    id: "rotation-under-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const { result } = await withRotatingCodex(directory, "no-threshold", path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal((state.invocations ?? []).length, 1, "no rotation, no handoff turn, no fresh session");
  assert.deepEqual((state.executionOverrides ?? []).filter((item) => item.kind === "rotation"), [], "no premature rotation is recorded");
  assert.equal(existsSync(join(result.runDir, "rotations")), false, "no handoff artifact materializes");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "completed without rotation");
});

test("a rotation without a resumable session fails with a precise bounded error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-unresumable-"));
  const path = writeContract(directory, fixture({
    id: "rotation-unresumable-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const { result } = await withRotatingCodex(directory, "no-continuation", path);
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "rotation_continuation_unavailable");
  assert.match(state.error?.message ?? "", /no continuation identity/u, "the failure names exactly what is missing");
  assert.ok(Buffer.byteLength(state.error?.message ?? "", "utf8") < 512, "the failure stays bounded");
  assert.equal((state.invocations ?? []).length, 1, "no handoff turn was spent without a session to resume");
});

test("a rotation handoff that writes no document fails bounded instead of restarting work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-handoff-missing-"));
  const path = writeContract(directory, fixture({
    id: "rotation-handoff-missing-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const { result } = await withRotatingCodex(directory, "handoff-missing", path);
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "rotation_handoff_missing");
  assert.match(state.error?.message ?? "", /wrote no document/u);
  assert.equal((state.invocations ?? []).length, 2, "the fresh session never started");
});

test("cancellation during a rotation handoff cancels the node without resurrecting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-cancel-"));
  const path = writeContract(directory, fixture({
    id: "rotation-cancel-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = join(directory, ".runs", "rotation-cancel-run");
  const canceler = (async () => {
    await waitForValue(() => {
      try {
        const snapshot = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
        return (snapshot.invocations ?? []).length >= 2 && snapshot.status === "running" ? true : null;
      } catch {
        return null;
      }
    }, 30_000);
    writeFileSync(join(runDir, "cancel.request.json"), "{}\n");
  })();
  const executable = rotatingCodex(directory, "handoff-parks").executable;
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = executable;
  let result;
  try {
    result = await runContract(path);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
  await canceler;
  const state = nodeState(result);
  assert.equal(state.status, "canceled");
  assert.equal((state.invocations ?? []).length, 2, "the parked handoff turn is the last invocation");
  assert.equal(result.ok, false);
});

test("resume continues a commissioned rotation handoff in a fresh session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rotation-resume-"));
  const path = writeContract(directory, fixture({
    id: "rotation-resume-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  // Rewind to the rotation boundary: the handoff is commissioned but the
  // fresh session has not started, exactly as if the controller died there.
  const handoffPath = join(runDir, "rotations", "build.1.1.md");
  mkdirSync(join(runDir, "rotations"));
  writeFileSync(handoffPath, "## Handoff\n\n- done: rotation\n- pending: resume\n");
  const nodePath = join(runDir, "nodes", "build.json");
  const persisted = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...persisted,
    status: "pending",
    phase: "worker",
    attempt: 1,
    result: null,
    gate: null,
    error: null,
    verification: null,
    executionOverrides: [
      { kind: "rotation", at: new Date().toISOString(), decision: "trigger", invocationId: persisted.invocations?.[0]?.id ?? "invocation", phase: "worker", reason: "observed turns 80 >= 80" },
      { kind: "rotation", at: new Date().toISOString(), decision: "handoff", invocationId: "handoff-invocation", phase: "worker", reason: "observed turns 80 >= 80", result: handoffPath },
    ],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  const rotations = (state.executionOverrides ?? []).filter((item) => item.kind === "rotation");
  assert.equal(rotations[1].decision, "rotated", "the resumed fresh session consumed the handoff exactly once");
  const fresh = state.invocations?.at(-1);
  assert.equal(fresh?.continuationMode, "fresh", "resume starts the fresh rotated session, not the rotated provider session");
  assert.notEqual(fresh?.id, rotations[1].invocationId);
  const freshPrompt = readFileSync(/** @type {string} */ (fresh?.promptPath), "utf8");
  assert.match(freshPrompt, /Continue node build in a fresh provider session/u);
  assert.match(freshPrompt, /- pending: resume/u, "the durable handoff content carries into the resumed fresh session");
  assert.match(freshPrompt, /Bounded git status --short/u);
  assert.match(freshPrompt, /Current closed task packet/u);
});

test("a completed worker turn with a non-zero exit code is adopted as done without rotation or continuation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-complete-exit-1-"));
  const path = writeContract(directory, fixture({
    id: "complete-exit-1-run",
    pollIntervalMs: 10,
    usagePolicy: { epoch: "complete-exit-1-epoch", maxInputTokens: 100_000_000, judgeReserveInputTokens: 0, maxPhaseInputTokens: 100_000_000, maxInvocationTokens: 100_000_000, cacheReadWeight: 0.1 },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "complete-exit-1", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal((state.invocations ?? []).length, 1, "the finished turn is adopted, never rotated or continued");
  const rotations = (state.executionOverrides ?? []).filter((item) => item.kind === "rotation");
  assert.equal(
    rotations.some((item) => item.decision === "trigger" || item.decision === "handoff"),
    false,
    "a finishing invocation is never rotation-terminated; an advise-fresh decision is allowed",
  );
  assert.equal(existsSync(join(result.runDir, "results", "build.json")), true, "the durable canonical result survives");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "completed despite non-zero exit");
});

test("budget stop never dispatches a rotation handoff the node cannot afford, and a dispatched handoff settles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-budget-bounded-"));
  const path = writeContract(directory, fixture({
    id: "budget-bounded-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Flood tokens" }),
      maxInputTokens: 1_000_000,
      budgetProfile: budgetProfile({
        estimatedWeightedInputTokens: 500,
        contextWindowTokens: 300_000,
        continuation: { enabled: false, maxSegments: 1, segmentReserveTokens: 0 },
      }),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  // The cache-rotating session crosses its derived cap mid-flight: the live
  // budget stop (or the rotation dispatch gate) must refuse the one-turn
  // rotation handoff and settle the node through the budget attention path
  // instead of dispatching a bounded call that would then be terminated.
  const { result } = await withRotatingCodex(directory, "cache", path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.error?.code, "budget_attention");
  assert.equal(state.budgetState?.status, "attention");
  assert.equal((state.invocations ?? []).length, 1, "no one-turn rotation handoff was dispatched beyond the node budget");
  const rotations = (state.executionOverrides ?? []).filter((item) => item.kind === "rotation");
  assert.equal(rotations.some((item) => item.decision === "handoff"), false, "the unaffordable bounded handoff never starts, so nothing budget-terminates it");
});

test("a dispatched rotation handoff settles under a derived budget before the node completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-budget-handoff-settles-"));
  const path = writeContract(directory, fixture({
    id: "budget-handoff-settles-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ objective: "Rotate within budget" }),
      maxInputTokens: 1_000_000,
      budgetProfile: budgetProfile(),
      progressPolicy: { graceSec: 0, intervalSec: 0.01, maxDryHeartbeats: 3 },
      gate: false,
    }],
  }));
  const { result } = await withRotatingCodex(directory, "turns", path);
  const state = nodeState(result);
  assert.equal(state.status, "done", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  const invocations = state.invocations ?? [];
  assert.equal(invocations.length, 3, "the one-turn handoff and the fresh session both ran to settlement");
  assert.equal(invocations[1].continuationMode, "reuse", "the handoff resumes the rotated session for one bounded turn");
  assert.equal(invocations[1].status, "closed", "the bounded handoff invocation settled normally, never canceled by a budget stop");
  assert.equal(state.error, null);
});

test("a continuation attempt adopts an existing canonical worker result instead of deleting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-continuation-adopts-"));
  const path = writeContract(directory, fixture({
    id: "continuation-adopts-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  // Rewind to a pending continuation boundary with a valid canonical result
  // already on disk, exactly as if the controller planned a continuation
  // after a completed worker turn.
  const preWritten = { status: "done", summary: "pre-written canonical result", changedFiles: [], verification: [], artifacts: [], missingContext: [] };
  writeFileSync(join(runDir, "results", "build.json"), JSON.stringify(preWritten));
  const nodePath = join(runDir, "nodes", "build.json");
  const persisted = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...persisted,
    status: "pending",
    phase: "worker",
    attempt: 1,
    result: null,
    gate: null,
    error: null,
    verification: null,
    budgetState: null,
    budgetDecision: null,
  }, null, 2));

  // The continuation attempt fails at the provider, yet the durable result
  // file must survive startWorker and be adopted through the done path.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "pre-written canonical result", "the continuation adopts the existing canonical result");
  assert.equal(
    JSON.parse(readFileSync(join(runDir, "results", "build.json"), "utf8")).summary,
    "pre-written canonical result",
    "startWorker never cleared the valid canonical file",
  );
});

test("an advise-fresh override forces the next continuation into a fresh session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-advise-fresh-"));
  const path = writeContract(directory, fixture({
    id: "advise-fresh-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const persisted = JSON.parse(readFileSync(nodePath, "utf8"));
  const sourceInvocation = persisted.invocations?.[0];
  writeFileSync(nodePath, JSON.stringify({
    ...persisted,
    status: "pending",
    phase: "worker",
    attempt: 1,
    result: null,
    gate: null,
    error: null,
    verification: null,
    executionOverrides: [
      { kind: "rotation", at: new Date().toISOString(), decision: "advise-fresh", invocationId: sourceInvocation?.id ?? "invocation", phase: "worker", reason: "completed worker turn with weighted cache-read input 130000 >= 120000 tokens/turn" },
    ],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  const fresh = state.invocations?.at(-1);
  assert.equal(fresh?.continuationMode, "fresh", "the advise-fresh decision is consumed like a rotation: the next attempt is fresh");
  assert.notEqual(fresh?.id, sourceInvocation?.id, "the fresh continuation starts a new invocation rather than resuming the bloated one");
  assert.notEqual(fresh?.promptPath, undefined, "the fresh continuation carries its own prompt");
  assert.equal(
    (state.executionOverrides ?? []).filter((item) => item.kind === "rotation" && item.decision === "advise-fresh").length,
    0,
    "the advise-fresh decision was consumed exactly once",
  );
});

test("worker invocations send no tool policy to a driver that cannot enforce it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-tool-policy-"));
  const marker = join(directory, ".runs", "tool-policy-request.json");
  const provider = join(directory, "policy-provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("policy-provider 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(marker)}, input);
    const result = JSON.stringify({ status: "done", summary: "ok", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: null, usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
  });
}
`);
  chmodSync(provider, 0o755);
  const path = writeContract(directory, fixture({
    id: "tool-policy-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { driver: "exec-jsonl", model: "fake", executable: provider } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  assert.equal(nodeState(result).status, "done");
  const request = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(
    "toolPolicy" in request,
    false,
    "an adapter without an enforceable hook surface receives no policy to pretend with; enforcement lives on the claude-compatible --settings boundary",
  );
});

test("finalVerification runs on the phase-terminal node and not on its dependencies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-terminal-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-terminal-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["build"], gate: false },
    ],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const build = nodeState(result, "build");
  const ship = nodeState(result, "ship");
  assert.equal(build.status, "done");
  assert.equal(ship.status, "done");
  assert.equal(build.verification?.commands?.length, 1, "a node with a dependant runs only its packet verification");
  assert.equal(ship.verification?.commands?.length, 2, "the phase-terminal node also runs the contract finalVerification");
  assert.deepEqual(ship.verification?.commands?.[1].argv, [process.execPath, "-e", "process.exit(0)"]);
});

test("a failing finalVerification stops the phase-terminal node before the judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-fail-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-fail-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(3)"] }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "final verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.equal(state.verification?.passed, false);
  assert.equal(state.verification?.commands?.[0].passed, true, "the packet verification still passed");
  assert.equal(state.verification?.commands?.[1].passed, false);
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("a targetedFix node runs finalVerification even with a dependant node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-targeted-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-targeted-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
    nodes: [
      { id: "fix", type: "backend", targetedFix: true, taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["fix"], gate: false },
    ],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  assert.equal(nodeState(result, "fix").verification?.commands?.length, 2, "targetedFix carries the final checkpoint on a non-terminal node");
  assert.equal(nodeState(result, "ship").verification?.commands?.length, 2);
});

test("a contract without finalVerification leaves controller verification untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-absent-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-absent-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(result).status, "done");
  assert.equal(nodeState(result).verification?.commands?.length, 1);
});

const RUNNER_CLI = fileURLToPath(new URL("./runner.mjs", import.meta.url));

/**
 * A run directory as `run` leaves it: the persisted contract, one state file
 * per node that reached a status, and the capsules attempts left behind.
 *
 * @param {string} directory
 * @param {Record<string, unknown>} contract
 * @param {Record<string, string>} statuses
 * @param {Record<string, unknown>} [capsules] keyed by `<nodeId>.<attempt>`
 * @returns {string}
 */
function prunableRun(directory, contract, statuses, capsules = {}) {
  const runDir = join(directory, ".runs", String(contract.id));
  writeJsonAtomic(join(runDir, "contract.json"), { ...contract, cwd: directory });
  for (const [id, status] of Object.entries(statuses)) {
    writeJsonAtomic(join(runDir, "nodes", `${id}.json`), { status });
  }
  for (const [name, capsule] of Object.entries(capsules)) {
    writeJsonAtomic(join(runDir, "capsules", `${name}.json`), capsule);
  }
  return runDir;
}

/** @param {string} runId @param {string} nodeId @param {Partial<import("./capsule.mjs").Capsule>} [overrides] */
function prunableCapsule(runId, nodeId, overrides = {}) {
  return buildCapsule({
    runId,
    nodeId,
    attemptId: "1",
    objective: "Implement it",
    decisions: ["the schema stays at version 2"],
    changedFiles: ["README.md"],
    verifications: [{ argv: "npm run check", pass: true }],
    nextAction: "finish the second half of the packet",
    ...overrides,
  });
}

test("contract prune drops done nodes and seeds the survivors with their capsules", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-prune-"));
  // the packets read `contract.json` relative to the contract cwd
  writeContract(directory, fixture());
  const contract = fixture({
    id: "prune-source",
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet(), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ objective: "Continue it" }), dependsOn: ["alpha"], gate: false },
      { id: "gamma", type: "backend", taskPacket: packet({ objective: "Close it" }), dependsOn: ["alpha", "beta"], gate: false },
    ],
  });
  const runDir = prunableRun(
    directory,
    contract,
    { alpha: "done", beta: "failed", gamma: "pending" },
    { "beta.0": prunableCapsule("prune-source", "beta", { nextAction: "stale" }), "beta.1": prunableCapsule("prune-source", "beta") },
  );
  const out = join(directory, "continuation.json");

  const pruned = pruneRun(runDir, { out });

  assert.deepEqual(pruned.dropped, ["alpha"]);
  assert.deepEqual(pruned.kept, ["beta", "gamma"]);
  assert.deepEqual(pruned.seeded, ["beta"], "only the node with a capsule is seeded");
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.id, "prune-source-continuation", "a pruned run never resumes the frozen one");
  assert.deepEqual(written.nodes.map((/** @type {{id: string}} */ node) => node.id), ["beta", "gamma"]);
  assert.deepEqual(written.nodes[0].dependsOn, [], "the settled dependency is already satisfied");
  assert.deepEqual(written.nodes[1].dependsOn, ["beta"], "a dependency on a surviving node stays");
  const seed = written.nodes[0].taskPacket.decisions;
  assert.match(seed[0], /^continuation seed from attempt 1 of run prune-source \(capsule [0-9a-f]{64}\)$/u);
  assert.ok(seed.includes("continuation seed next action: finish the second half of the packet"), "the newest capsule wins");
  assert.ok(seed.includes("continuation seed decided: the schema stays at version 2"));
  assert.ok(seed.includes("continuation seed already changed: README.md"));
  assert.ok(seed.includes("continuation seed passed: npm run check"));
  assert.deepEqual(written.nodes[1].taskPacket.decisions, [], "a node without a capsule keeps its packet");
  assert.equal(written.nodes[0].packetHash, undefined, "the stale packet hash never survives a reseeded packet");
  assert.equal(written.nodes.some((/** @type {{targetedFix?: boolean}} */ node) => node.targetedFix), false);

  const validated = spawnSync(process.execPath, [RUNNER_CLI, "validate", out], { encoding: "utf8" });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, "valid\n");
});

test("contract prune writes a single remaining node only with --targeted-fix", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-prune-targeted-"));
  writeContract(directory, fixture());  // the packets read `contract.json` relative to the contract cwd
  const contract = fixture({
    id: "prune-targeted",
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet(), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ objective: "Continue it" }), dependsOn: ["alpha"], gate: false },
    ],
  });
  const runDir = prunableRun(directory, contract, { alpha: "done", beta: "exhausted" });
  const refused = join(directory, "refused.json");

  assert.throws(() => pruneRun(runDir, { out: refused }), /leaves the single node beta.*--targeted-fix/su);
  assert.equal(existsSync(refused), false, "a refused prune writes nothing");

  const out = join(directory, "targeted.json");
  const pruned = pruneRun(runDir, { out, targetedFix: true });
  assert.deepEqual(pruned.kept, ["beta"]);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.nodes.length, 1);
  assert.equal(written.nodes[0].targetedFix, true, "the flag is stamped on the surviving node");

  const validated = spawnSync(process.execPath, [RUNNER_CLI, "contract", "validate", out], { encoding: "utf8" });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, "valid\n", "a targeted fix is not warned about for being alone");
});

test("validate rejects a single-node contract that is not a targeted fix", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-validate-targeted-"));
  const serial = writeContract(directory, fixture({ id: "serial-micro-contract" }));

  for (const argv of [["validate", serial], ["contract", "validate", serial]]) {
    const result = spawnSync(process.execPath, [RUNNER_CLI, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /single node build without targetedFix: true/u);
    assert.equal(result.stdout, "", "a rejected contract is never reported as valid");
  }
});
