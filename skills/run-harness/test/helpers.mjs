import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { campaignDir, initializeCampaign } from "../scripts/campaign.mjs";

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Poll `read` until it returns a non-null value or the deadline passes.
 *
 * @param {() => unknown} read
 * @param {number} [timeoutMs]
 * @param {number} [intervalMs]
 * @returns {Promise<unknown>}
 */
export async function waitForValue(read, timeoutMs = 5_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await delay(intervalMs);
  }
  throw new Error(`condition was not reached within ${timeoutMs}ms`);
}

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @param {Record<string, unknown>} [patch]
 * @returns {void}
 */
export function orphan(runDir, nodeId, patch = {}) {
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    result: null,
    gate: null,
    ...patch,
  }, null, 2));
}

/**
 * @template T
 * @param {string} directory
 * @param {string} mode
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withFakeCodex(directory, mode, body) {
  const previous = process.env.HARNESS_CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = fakeCodex(directory, mode);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = previous;
  }
}

/**
 * @template T
 * @param {string} directory
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withFakeAgy(directory, body) {
  const previous = process.env.HARNESS_AGY_BIN;
  process.env.HARNESS_AGY_BIN = fakeAgy(directory);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_AGY_BIN;
    else process.env.HARNESS_AGY_BIN = previous;
  }
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function fixture(overrides = {}) {
  return {
    schemaVersion: 1,
    harnessVersion: "0.1.0",
    id: "test-run",
    campaignId: "test-campaign",
    goal: "Prove the runner works",
    cwd: ".",
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      luna: { driver: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" },
      sol: { driver: "codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
      opus: { driver: "claude", model: "opus", reasoning: "high" },
      agy: { driver: "agy", model: "gemini-3.7-flash-low" },
      flash: {
        driver: "codex",
        model: "deepseek-v4-flash",
        config: { model_provider: "deepseek", "model_providers.deepseek.env_key": "DEEPSEEK_API_KEY" },
      },
    },
    runtimeRules: [
      { match: { type: "frontend" }, runtime: "opus" },
      { match: { type: "mechanic" }, runtime: "flash" },
    ],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function packet(overrides = {}) {
  return {
    mode: "execution",
    objective: "Implement it",
    instructions: ["Implement the requested behavior"],
    readFiles: ["contract.json"],
    writeFiles: ["README.md"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
    ...overrides,
  };
}

/**
 * @param {string} directory
 * @param {Record<string, unknown>} value
 * @returns {string}
 */
export function writeContract(directory, value) {
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  const cwd = join(directory, typeof value.cwd === "string" ? value.cwd : ".");
  const runsDir = join(cwd, ".runs");
  const campaignId = value.campaignId;
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    throw new TypeError("contract.campaignId must be a non-empty string");
  }
  const pathForCampaign = campaignDir(runsDir, campaignId);
  if (!existsSync(pathForCampaign)) {
    initializeCampaign(runsDir, { campaignId, goal: value.goal });
  }
  return path;
}

/**
 * @param {string} directory
 * @returns {void}
 */
export function initializeGit(directory) {
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "-c", "user.email=harness@example.test", "-c", "user.name=harness", "commit", "-qm", "fixture"]);
}

/**
 * @param {string} directory
 * @param {string} [mode]
 * @returns {string}
 */
export function fakeCodex(directory, mode = "pass") {
  const path = join(mkdtempSync(join(tmpdir(), "harness-fake-codex-")), `fake-codex-${mode}.mjs`);
  writeFileSync(path, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
if (process.argv.includes("--version")) {
  if (mode === "version-fail") {
    console.error("deliberate failure");
    process.exitCode = 1;
  } else {
    console.log("fake-codex 1.0.0");
  }
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input;
    console.log(JSON.stringify({type:"thread.started",thread_id:"fake-thread"}));
    if (mode === "write-allowed" && !prompt.startsWith("Review node")) writeFileSync("README.md", "worker output\\n");
    if (mode === "write-unexpected" && !prompt.startsWith("Review node")) writeFileSync("unexpected.txt", "out of scope\\n");
    if (mode === "large-output") {
      for (let index = 0; index < 7000; index += 1) console.log(JSON.stringify({ type: "progress", text: "A".repeat(100) }));
      for (let index = 0; index < 7000; index += 1) console.error("E".repeat(100));
    }
    if (mode === "slow") {
      const wait = prompt.startsWith("Review node") ? 2000 : 3500;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
    if (mode === "prose-retry" && !prompt.startsWith("Review node")) {
      if (!prompt.includes("quality gate rejected")) {
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"All requirements are already in place; nothing to do."}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
        return;
      }
    }
    if (mode === "prose-json" && !prompt.startsWith("Review node")) {
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"All checks pass, my only modification is the declared write file.\\n\\n" + JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] })}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      return;
    }
    if (mode === "silent") setTimeout(() => {}, 60_000);
    else if (mode === "heartbeat") setInterval(() => console.error("working"), 10);
    else if (prompt.includes("FAIL_WORKER") || (mode === "worker-fail" && !prompt.startsWith("Review node")) || (mode === "judge-fail" && prompt.startsWith("Review node"))) {
      console.log(JSON.stringify({type:"turn.failed",error:{message:"deliberate failure"}}));
    } else {
      const judge = prompt.startsWith("Review node");
      const text = judge
        ? mode === "critical"
          ? JSON.stringify({verdict:"fail",maxSeverity:"critical",summary:"critical defect",findings:[{severity:"critical",description:"broken",evidence:"test failed"}]})
          : JSON.stringify({verdict:"fail",maxSeverity:"minor",summary:"minor advisory",findings:[{severity:"minor",description:"style",evidence:"line 1"}]})
        : mode === "blocked-context"
          ? JSON.stringify({ status: "blocked_context", summary: "missing context", changedFiles: [], verification: [], artifacts: [], missingContext: ["missing.txt"] })
          : JSON.stringify({ status: "done", summary: "worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] });
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
    }
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * @param {string} directory
 * @returns {string}
 */
export function fakeAgy(directory) {
  const path = join(mkdtempSync(join(tmpdir(), "harness-fake-agy-")), "fake-agy.mjs");
  writeFileSync(path, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("agy 1.0.0");
} else {
console.log(JSON.stringify({event:"init",conversation_id:"fake-conversation"}));
console.log(JSON.stringify({event:"result",result:{
  conversation_id:"fake-conversation",
  status:"SUCCESS",
  response:"READY",
  usage:{input_tokens:4,output_tokens:1,cache_read_tokens:2}
}}));
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * @param {string} nodePath
 * @returns {string|null}
 */
export function readStatus(nodePath) {
  try {
    return JSON.parse(readFileSync(nodePath, "utf8")).status;
  } catch {
    return null;
  }
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
export function closeResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
}
