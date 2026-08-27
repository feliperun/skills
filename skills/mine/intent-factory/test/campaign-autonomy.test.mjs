import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { campaignDir, initializeCampaign } from "../scripts/campaign.mjs";
import {
  CAMPAIGN_LEASE_FILE,
  CAMPAIGN_STATE_FILE,
  classifyTransition,
  configureCampaign,
  createRepairContract,
  createControllerSnapshot,
  detachSelf,
  drainNotifications,
  enqueueNotification,
  readCampaignPlan,
  readNotificationOutbox,
  startCampaign,
  superviseCampaignOnce,
} from "../scripts/campaign-autonomy.mjs";
import { acquireLease, LeaseBusyError, writeJsonAtomic } from "../scripts/store.mjs";
import { fixture, packet } from "./helpers.mjs";

const runnerPath = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
const sourceRoot = dirname(dirname(runnerPath));

function tempRepo(runnerCode = "process.exit(0);\n") {
  const root = mkdtempSync(join(tmpdir(), "campaign-autonomy-"));
  mkdirSync(join(root, "repair-root"), { recursive: true });
  writeFileSync(join(root, "contract.json"), "{}\n");
  writeFileSync(join(root, "README.md"), "ready\n");
  const controller = join(root, "controller-source", "scripts");
  mkdirSync(controller, { recursive: true });
  writeFileSync(join(root, "controller-source", "README.md"), "controller\n");
  writeFileSync(join(controller, "runner.mjs"), runnerCode);
  const contractPath = join(root, "initial.json");
  writeJsonAtomic(contractPath, fixture({
    id: "initial-run",
    campaignId: "campaign",
    cwd: ".",
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }] }), gate: false }],
  }));
  const created = initializeCampaign(join(root, ".runs"), { campaignId: "campaign", goal: "Test campaign autonomy" });
  const configured = configureCampaign(created.path, {
    initialRunContract: contractPath,
    sourceRoot: join(root, "controller-source"),
    authority: {
      repairRoots: ["repair-root"],
      allowedVerification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
      retryLimit: 1,
      repairLimit: 2,
      runtimeFailover: { allowedRuntimes: ["luna", "sol"], routes: [{ from: "luna", to: "sol" }] },
      maxInputTokens: 100,
      maxCostUsd: 1,
      irreversibleActionsForbidden: true,
    },
  });
  return { root, campaignPath: created.path, plan: configured.plan };
}

/** @param {{root: string}} value */
function cleanup(value) {
  try { rmSync(value.root, { recursive: true, force: true }); } catch {}
}

/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [extraEnv] */
function runPublicCampaignCli(cwd, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [runnerPath, "campaign", ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** @param {string} root @returns {string} */
function fakeCampaignProvider(root) {
  const path = join(root, "fake-campaign-provider.mjs");
  writeFileSync(path, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-campaign-provider 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "campaign-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "campaign worker complete", changedFiles: [], verification: [], artifacts: [], missingContext: [] }) } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }));
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/** @param {() => unknown} read @param {number} [timeoutMs] */
async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition was not reached within ${timeoutMs}ms`);
}

test("classifies bounded retries, failover, repairs, attention, and completion", () => {
  const authority = {
    retryLimit: 1,
    repairLimit: 1,
    runtimeFailover: { routes: [{ from: "luna", to: "sol" }] },
  };
  assert.equal(classifyTransition({ authority, status: "stalled", retryCount: 0 }).action, "resume");
  assert.equal(classifyTransition({ authority, status: "stalled", retryCount: 1 }).reason, "retry_limit_exhausted");
  assert.equal(classifyTransition({ authority, status: "exhausted", errorCode: "provider_exhausted", currentRuntime: "luna" }).failoverTo, "sol");
  assert.equal(classifyTransition({ authority, status: "exhausted", errorCode: "provider_exhausted", currentRuntime: "sol" }).action, "attention");
  assert.equal(classifyTransition({ authority, status: "exhausted", errorCode: "retry_limit_exhausted" }).reason, "unclassified_terminal_failure");
  assert.equal(classifyTransition({ authority, status: "blocked", errorCode: "budget_exceeded" }).reason, "budget_exhausted");
  assert.equal(classifyTransition({ authority, status: "blocked", errorCode: "context_missing", repairCount: 0 }).action, "repair");
  assert.equal(classifyTransition({ authority, status: "failed", errorCode: "scope_violation" }).action, "attention");
  assert.equal(classifyTransition({ authority, allGreen: true }).action, "complete");
  assert.equal(classifyTransition({ authority, status: "running", controllerAlive: false, retryCount: 1 }).action, "attention");
});

test("controller snapshots are versioned and cannot be overwritten", () => {
  const value = tempRepo();
  try {
    const snapshot = createControllerSnapshot(value.campaignPath, { version: "v-test", sourceRoot: join(value.root, "controller-source") });
    assert.equal(snapshot.contentHash, readCampaignPlan(value.campaignPath).controller.contentHash);
    assert.throws(() => createControllerSnapshot(value.campaignPath, { version: "v-test", sourceRoot: join(value.root, "controller-source") }), /already exists/u);
  } finally { cleanup(value); }
});

test("repair contract creation is exact-once across controller restart", async () => {
  const value = tempRepo();
  try {
    await startCampaign(value.campaignPath, { executor: async () => {} });
    const state = JSON.parse(readFileSync(join(value.campaignPath, CAMPAIGN_STATE_FILE), "utf8"));
    const failedRun = state.runs[0];
    const failedNode = { id: "build", type: "backend", status: "failed", attempt: 1, error: { code: "verification_failed", message: "red" } };
    const first = createRepairContract(value.campaignPath, value.plan, state, failedRun, failedNode, { currentRuntime: "luna" });
    state.repairs[first.repairKey] = first.repairId;
    state.runs.push({ id: first.repairId, kind: "repair", contractPath: first.contractPath, status: "planned" });
    writeJsonAtomic(join(value.campaignPath, CAMPAIGN_STATE_FILE), state);
    const restarted = JSON.parse(readFileSync(join(value.campaignPath, CAMPAIGN_STATE_FILE), "utf8"));
    const second = createRepairContract(value.campaignPath, value.plan, restarted, failedRun, failedNode, { currentRuntime: "luna" });
    assert.equal(second.repairId, first.repairId);
    assert.equal(restarted.runs.filter(/** @param {{id: string}} run */ (run) => run.id === first.repairId).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(first.contractPath, "utf8")), first.contract);
  } finally { cleanup(value); }
});

test("lease exclusion is durable", () => {
  const value = tempRepo();
  let lease;
  try {
    lease = acquireLease(value.campaignPath, { fileName: CAMPAIGN_LEASE_FILE, contractVersion: "test" });
    assert.throws(() => acquireLease(value.campaignPath, { fileName: CAMPAIGN_LEASE_FILE, contractVersion: "test" }), LeaseBusyError);
  } finally { lease?.release(); cleanup(value); }
});

test("fake execution reaches automatic completion", async () => {
  const value = tempRepo();
  try {
    let dispatched = 0;
    await startCampaign(value.campaignPath, { executor: async () => { dispatched += 1; } });
    assert.equal(dispatched, 1);
    const contract = JSON.parse(readFileSync(join(value.campaignPath, "contracts", "initial-run.json"), "utf8"));
    const runDir = join(value.root, ".runs", "initial-run");
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeJsonAtomic(join(runDir, "contract.json"), contract);
    writeJsonAtomic(join(runDir, "nodes", "build.json"), { status: "done", id: "build" });
    const status = await superviseCampaignOnce(value.campaignPath, { executor: async () => { throw new Error("must not dispatch green run"); } });
    assert.equal(status.status, "completed");
    assert.equal(readNotificationOutbox(value.campaignPath).filter((event) => event.type === "campaign.completed").length, 1);
  } finally { cleanup(value); }
});

test("notification outbox is bounded, deduplicated, and retried", async () => {
  const value = tempRepo();
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  try {
    enqueueNotification(value.campaignPath, "campaign.attention", "same", "attention");
    enqueueNotification(value.campaignPath, "campaign.attention", "same", "attention");
    assert.equal(readNotificationOutbox(value.campaignPath).length, 1);
    const notify = join(value.root, "notify.mjs");
    const counter = join(value.root, "notify.count");
    writeFileSync(notify, `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => { if (!existsSync(${JSON.stringify(counter)})) { writeFileSync(${JSON.stringify(counter)}, "1"); process.exit(1); } process.exit(0); });\n`);
    chmodSync(notify, 0o755);
    process.env.INTENT_FACTORY_NOTIFY_BIN = notify;
    assert.equal((await drainNotifications(value.campaignPath)).pending, 1);
    assert.equal((await drainNotifications(value.campaignPath)).pending, 0);
    assert.equal(readNotificationOutbox(value.campaignPath)[0].attempts, 2);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
    cleanup(value);
  }
});

test("campaign supervision drains notifications automatically", async () => {
  const value = tempRepo();
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  try {
    const delivered = join(value.root, "campaign-delivered.json");
    const notify = join(value.root, "campaign-notify.mjs");
    writeFileSync(notify, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => { writeFileSync(${JSON.stringify(delivered)}, input); });\n`);
    chmodSync(notify, 0o755);
    process.env.INTENT_FACTORY_NOTIFY_BIN = notify;
    enqueueNotification(value.campaignPath, "campaign.attention", "automatic", "attention");
    await superviseCampaignOnce(value.campaignPath, { executor: async () => {} });
    assert.equal(JSON.parse(readFileSync(delivered, "utf8")).type, "campaign.attention");
    assert.equal(readNotificationOutbox(value.campaignPath)[0].deliveredAt !== null, true);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
    cleanup(value);
  }
});

test("detached supervisor reports readiness from the pinned runner", async () => {
  const value = tempRepo(`import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const id = process.argv[4]; const cwd = process.argv[process.argv.indexOf("--cwd") + 1]; const nonce = process.env.INTENT_FACTORY_CAMPAIGN_BOOTSTRAP_NONCE; const path = join(cwd, ".runs", "campaigns", id); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "controller-bootstrap.json." + nonce + ".json"), JSON.stringify({ status: "ready", pid: process.pid })); setInterval(() => {}, 1000);\n`);
  try {
    const result = await detachSelf(value.campaignPath, { intervalMs: 100 });
    assert.ok(result.pid > 0);
    process.kill(result.pid, "SIGTERM");
  } finally { cleanup(value); }
});

test("public campaign CLI continues a detached controller after the launcher exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-cli-autonomy-"));
  const campaignId = "cli-campaign";
  const contractPath = join(root, "initial.json");
  const provider = fakeCampaignProvider(root);
  const env = { INTENT_FACTORY_CODEX_BIN: provider };
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, ".gitignore"), ".runs/\n");
    writeFileSync(join(root, "README.md"), "ready\n");
    writeFileSync(join(root, "contract.json"), "{}\n");
    writeJsonAtomic(contractPath, fixture({
      id: "cli-run",
      campaignId,
      cwd: ".",
      runtimes: {
        luna: { driver: "codex", model: "fake-luna" },
        sol: { driver: "codex", model: "fake-sol" },
      },
      runtimeRules: [],
      nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }] }), gate: false }],
    }));
    runPublicCampaignCli(root, ["init", campaignId, "--cwd", root, "--goal", "Prove detached campaign autonomy"], env);
    runPublicCampaignCli(root, ["configure", campaignId, "--cwd", root, "--contract", contractPath, "--source-root", sourceRoot], env);
    runPublicCampaignCli(root, ["start", campaignId, "--cwd", root], env);
    runPublicCampaignCli(root, ["supervise", campaignId, "--cwd", root, "--detach", "--interval", "0.01"], env);

    const statePath = join(root, ".runs", "campaigns", campaignId, CAMPAIGN_STATE_FILE);
    await waitFor(() => {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        return state.status === "completed" ? state : null;
      } catch {
        return null;
      }
    }, 30_000);
    const status = JSON.parse(runPublicCampaignCli(root, ["status", campaignId, "--cwd", root], env));
    assert.equal(status.status, "completed");
    assert.equal(status.runs[0].observed.allGreen, true);
    assert.ok(status.outbox.some(/** @param {{type: string}} event */ (event) => event.type === "campaign.completed"));
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
