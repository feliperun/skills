import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendJournal, campaignDir, closeCampaign, initializeCampaign, readCampaign, readJournal } from "../scripts/campaign.mjs";
import {
  CAMPAIGN_PLAN_FILE,
  CAMPAIGN_LEASE_FILE,
  CAMPAIGN_STATE_FILE,
  campaignStatus,
  causalFailureNode,
  checkRunLiveness,
  classifyTransition,
  configureCampaign,
  createRepairContract,
  createControllerSnapshot,
  detachSelf,
  readCampaignPlan,
  startCampaign,
  superviseCampaignOnce,
} from "../scripts/campaign-autonomy.mjs";
import {
  CAMPAIGN_OUTBOX_FILE,
  drainNotifications,
  enqueueNotification,
  readNotificationOutbox,
  watchCampaign,
} from "../scripts/outbox.mjs";
import { readHeartbeat } from "../scripts/heartbeat.mjs";
import { projectEvent } from "../scripts/events.mjs";
import { acquireFileMutationLock, acquireLease, LeaseBusyError, writeJsonAtomic } from "../scripts/store.mjs";
import { runContract } from "../scripts/runner.mjs";
import { delay, fixture, packet, withFakeCodex, writeContract } from "./helpers.mjs";

const runnerPath = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
const sourceRoot = dirname(dirname(runnerPath));

function budgetProfile() {
  return {
    estimatedWeightedInputTokens: 50,
    estimatedTurns: 2,
    contextWindowTokens: 1_000,
    safetyFraction: 0.75,
    minimumSegmentTokens: 10,
    growthIncrementTokens: 10,
    preambleBytes: 40,
    tokenizerEstimate: { bytes: 4, tokens: 1, source: "campaign test measurement" },
    continuation: { enabled: false, maxSegments: 1, segmentReserveTokens: 0 },
  };
}

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
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }] }),
      budgetProfile: budgetProfile(),
      progressPolicy: { graceSec: 0, intervalSec: 1, maxDryHeartbeats: 3 },
      gate: false,
    }],
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

/**
 * Enqueue one projected event through the public outbox API. The helper keeps
 * the mechanical projectEvent call next to each assertion.
 *
 * @param {string} campaignPath
 * @param {string} type
 * @param {string} key
 * @param {Record<string, unknown>} [options]
 * @param {string} [progressCoalesceKey]
 */
function enqueue(campaignPath, type, key, options = {}, progressCoalesceKey) {
  enqueueNotification(campaignPath, projectEvent({ type, campaignId: "campaign", ...options, key }), key, progressCoalesceKey ?? key);
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
  assert.equal(classifyTransition({ authority, status: "exhausted", errorCode: "provider_exhausted", currentRuntime: "luna", run: { failoverHistory: ["sol"] } }).action, "attention");
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

test("a completed repair settles its failed source run and completes the campaign", async () => {
  const value = tempRepo();
  try {
    await startCampaign(value.campaignPath, { executor: async () => {} });
    const statePath = join(value.campaignPath, CAMPAIGN_STATE_FILE);
    const attentionState = JSON.parse(readFileSync(statePath, "utf8"));
    attentionState.status = "attention";
    attentionState.attention = { code: "stale", message: "stale attention" };
    writeJsonAtomic(statePath, attentionState);
    const initialContractPath = join(value.campaignPath, value.plan.initialRunContract);
    const initialContract = JSON.parse(readFileSync(initialContractPath, "utf8"));
    const initialRunDir = join(value.root, ".runs", "initial-run");
    mkdirSync(join(initialRunDir, "nodes"), { recursive: true });
    writeJsonAtomic(join(initialRunDir, "contract.json"), initialContract);
    writeJsonAtomic(join(initialRunDir, "nodes", "build.json"), {
      id: "build",
      status: "failed",
      attempt: 1,
      error: { code: "verification_failed", message: "red" },
    });

    let dispatched = 0;
    await superviseCampaignOnce(value.campaignPath, { executor: async () => { dispatched += 1; } });
    assert.equal(dispatched, 1, "the failed source run dispatches one repair");
    const stateAfterRepair = JSON.parse(readFileSync(join(value.campaignPath, CAMPAIGN_STATE_FILE), "utf8"));
    const repair = stateAfterRepair.runs.find(/** @param {{kind: string}} run */ (run) => run.kind === "repair");
    assert.ok(repair, "the repair run is recorded");
    const repairContract = JSON.parse(readFileSync(repair.contractPath, "utf8"));
    const repairRunDir = join(value.root, ".runs", repair.id);
    mkdirSync(join(repairRunDir, "nodes"), { recursive: true });
    writeJsonAtomic(join(repairRunDir, "contract.json"), repairContract);
    writeJsonAtomic(join(repairRunDir, "nodes", "repair.json"), { id: "repair", status: "done" });

    const status = await superviseCampaignOnce(value.campaignPath, { executor: async () => { throw new Error("must not dispatch a completed repair"); } });
    assert.equal(status.status, "completed");
    assert.equal(status.attention, null);
    const runs = /** @type {{status: string}[]} */ (status.runs);
    assert.ok(runs.every((run) => run.status === "done"));
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
    enqueue(value.campaignPath, "campaign.attention", "same");
    enqueue(value.campaignPath, "campaign.attention", "same");
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

test("outbox mutation lock serializes a cross-process enqueue without losing events", async () => {
  const value = tempRepo();
  /** @type {import("node:child_process").ChildProcess|null} */
  let child = null;
  let lock = null;
  try {
    const readyPath = join(value.root, "child-ready");
    const outboxPath = fileURLToPath(new URL("../scripts/outbox.mjs", import.meta.url));
    const eventsPath = fileURLToPath(new URL("../scripts/events.mjs", import.meta.url));
    lock = acquireFileMutationLock(value.campaignPath, CAMPAIGN_OUTBOX_FILE);
    const spawned = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync } from "node:fs";
      import { enqueueNotification } from ${JSON.stringify(outboxPath)};
      import { projectEvent } from ${JSON.stringify(eventsPath)};
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      enqueueNotification(${JSON.stringify(value.campaignPath)}, projectEvent({ type: "node.terminal", campaignId: "campaign", runId: "child", nodeId: "child", data: { runId: "child", nodeId: "child", status: "done" }, key: "child" }), "child");
    `], { stdio: ["ignore", "pipe", "pipe"] });
    child = spawned;
    let childStderr = "";
    spawned.stderr?.on("data", (chunk) => { childStderr += chunk; });
    const childExited = new Promise((resolve) => spawned.once("exit", (code) => resolve(code)));
    let success = false;
    try {
      await waitFor(() => (existsSync(readyPath) ? true : null), 5_000);
      await delay(300);
      assert.equal(spawned.exitCode, null, `child exited while the outbox lock was held: ${childStderr}`);
      assert.equal(readNotificationOutbox(value.campaignPath).some((event) => event.type === "node.terminal" && event.data?.nodeId === "child"), false, "child enqueued while the outbox lock was held");
      const outbox = readNotificationOutbox(value.campaignPath);
      outbox.push({
        eventId: `parent-terminal-${Date.now()}`,
        type: "node.terminal",
        campaignId: "campaign",
        at: new Date().toISOString(),
        summary: "parent done",
        data: {},
        deliveredAt: null,
        attempts: 0,
        lastError: null,
      });
      writeJsonAtomic(join(value.campaignPath, CAMPAIGN_OUTBOX_FILE), outbox);
      success = true;
    } finally {
      if (!success) { try { spawned.kill("SIGKILL"); } catch {} }
      lock.release();
      lock = null;
    }
    const exitCode = await Promise.race([childExited, delay(10_000).then(() => null)]);
    assert.notEqual(exitCode, null, `child did not exit after lock release: ${childStderr}`);
    assert.equal(exitCode, 0, childStderr);
    const terminals = readNotificationOutbox(value.campaignPath).filter((event) => event.type === "node.terminal");
    assert.equal(terminals.length, 2);
    assert.equal(terminals.filter((event) => event.data?.nodeId === "child").length, 1);
    assert.equal(terminals.filter((event) => event.summary === "parent done").length, 1);
    assert.equal(new Set(terminals.map((event) => event.eventId)).size, 2);
  } finally {
    if (child && child.exitCode === null) { try { child.kill("SIGKILL"); } catch {} }
    cleanup(value);
  }
});

test("a saturated outbox prioritizes terminal events and rejects terminal-only overflow", () => {
  const value = tempRepo();
  try {
    for (let index = 0; index < 99; index += 1) {
      enqueue(value.campaignPath, "node.terminal", `node-${index}`, { runId: "initial-run", nodeId: `node-${index}` });
    }
    enqueue(value.campaignPath, "campaign.progress", "run:working", { runId: "initial-run" }, "run");
    enqueue(value.campaignPath, "campaign.completed", "campaign");
    let outbox = readNotificationOutbox(value.campaignPath);
    assert.equal(outbox.length, 100);
    assert.equal(outbox.some((event) => event.type === "campaign.progress"), false);
    assert.equal(outbox.some((event) => event.type === "campaign.completed"), true);
    enqueue(value.campaignPath, "campaign.attention", "attention", { identifiers: { errorCode: "provider_exhausted" } });
    outbox = readNotificationOutbox(value.campaignPath);
    assert.equal(outbox.length, 100);
    assert.equal(outbox.some((event) => event.type === "campaign.attention"), false);
  } finally { cleanup(value); }
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
    enqueue(value.campaignPath, "campaign.attention", "automatic", { identifiers: { errorCode: "provider_exhausted" } });
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
  const value = tempRepo(`import { mkdirSync, renameSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const id = process.argv[4]; const cwd = process.argv[process.argv.indexOf("--cwd") + 1]; const nonce = process.env.INTENT_FACTORY_CAMPAIGN_BOOTSTRAP_NONCE; const path = join(cwd, ".runs", "campaigns", id); const ack = join(path, "controller-bootstrap.json." + nonce + ".json"); const temporary = ack + "." + process.pid + ".tmp"; mkdirSync(path, { recursive: true }); writeFileSync(temporary, JSON.stringify({ status: "ready", pid: process.pid })); renameSync(temporary, ack); setInterval(() => {}, 1000);\n`);
  try {
    const result = await detachSelf(value.campaignPath, { intervalMs: 100 });
    assert.ok(result.pid > 0);
    process.kill(result.pid, "SIGTERM");
  } finally { cleanup(value); }
});

test("detached supervisor interval crosses the public CLI boundary once: 30 seconds to 30000 ms", async () => {
  const value = tempRepo(`import { mkdirSync, renameSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const id = process.argv[4]; const cwd = process.argv[process.argv.indexOf("--cwd") + 1]; const nonce = process.env.INTENT_FACTORY_CAMPAIGN_BOOTSTRAP_NONCE; const path = join(cwd, ".runs", "campaigns", id); const ack = join(path, "controller-bootstrap.json." + nonce + ".json"); const temporary = ack + "." + process.pid + ".tmp"; mkdirSync(path, { recursive: true }); writeFileSync(join(path, "detached-argv.json"), JSON.stringify(process.argv)); writeFileSync(temporary, JSON.stringify({ status: "ready", pid: process.pid })); renameSync(temporary, ack); setInterval(() => {}, 1000);\n`);
  try {
    const result = await detachSelf(value.campaignPath, { intervalMs: 30_000 });
    assert.ok(result.pid > 0);
    process.kill(result.pid, "SIGTERM");
    const argv = JSON.parse(readFileSync(join(value.campaignPath, "detached-argv.json"), "utf8"));
    // The child re-enters the public CLI, so it must receive seconds, not the
    // internal milliseconds; the child converts once back to 30000 ms.
    assert.equal(argv[argv.indexOf("--interval") + 1], "30");
  } finally { cleanup(value); }
});

/**
 * A run whose provider root (runtime sol, no authorized route from it) failed
 * exhausted while its dependent node is merely dependency-blocked.
 *
 * @param {{root: string}} value
 * @returns {{contract: Record<string, unknown>, root: Record<string, unknown>, dependent: Record<string, unknown>}}
 */
function exhaustedRunWithBlockedDescendant(value) {
  const runContract = fixture({
    id: "initial-run",
    campaignId: "campaign",
    cwd: ".",
    nodes: [
      { id: "provider-root", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }] }), gate: false, dependsOn: [] },
      { id: "dependent", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }] }), gate: false, dependsOn: ["provider-root"] },
    ],
  });
  const runDir = join(value.root, ".runs", "initial-run");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeJsonAtomic(join(runDir, "contract.json"), runContract);
  const root = { id: "provider-root", status: "exhausted", error: { code: "provider_exhausted", message: "sol is out of quota" }, runtime: { id: "sol" } };
  const dependent = { id: "dependent", status: "blocked", blockedBy: ["provider-root"] };
  writeJsonAtomic(join(runDir, "nodes", "dependent.json"), dependent);
  writeJsonAtomic(join(runDir, "nodes", "provider-root.json"), root);
  return { contract: runContract, root, dependent };
}

test("inspectRun reports the causal failure root regardless of node directory order", () => {
  const value = tempRepo();
  try {
    const { contract, root, dependent } = exhaustedRunWithBlockedDescendant(value);
    // The selection is pure: both readdir orders must resolve to the exhausted
    // root, never to the dependency-blocked descendant.
    assert.equal(causalFailureNode([dependent, root], contract)?.id, "provider-root");
    assert.equal(causalFailureNode([root, dependent], contract)?.id, "provider-root");
    const observed = /** @type {Record<string, unknown>} */ ((/** @type {Record<string, unknown>} */ ((/** @type {unknown[]} */ (campaignStatus(value.campaignPath).runs))[0])).observed);
    const failedNode = /** @type {Record<string, unknown>} */ (observed.failedNode);
    const error = /** @type {Record<string, unknown>} */ (observed.error);
    assert.equal(failedNode.id, "provider-root");
    assert.equal(observed.status, "exhausted");
    assert.equal(error.code, "provider_exhausted");
  } finally { cleanup(value); }
});

test("provider exhaustion with no authorized failover route is attention, never repair", async () => {
  const value = tempRepo();
  try {
    exhaustedRunWithBlockedDescendant(value);
    const status = await superviseCampaignOnce(value.campaignPath, { executor: async () => { throw new Error("no dispatch expected"); } });
    const attention = /** @type {Record<string, unknown>} */ (status.attention);
    assert.equal(status.status, "attention");
    assert.equal(attention.code, "provider_exhausted_without_declared_failover");
    assert.equal((/** @type {unknown[]} */ (status.runs)).length, 1);
    const outboxEvents = readNotificationOutbox(value.campaignPath).filter((event) => event.type === "campaign.attention");
    assert.equal(outboxEvents.length, 1, "the supervisor projects one campaign attention event");
    assert.equal(outboxEvents[0].requiresUser, true, "the supervisor passes its zero-remaining-edge fact so exhaustion is actionable");
    assert.equal(outboxEvents[0].next, "run resume or supervise");
  } finally { cleanup(value); }
});

test("budget liveness drain pushes attention through adapters but never progress", async () => {
  const value = tempRepo();
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  /** @type {Record<string, unknown>[]} */
  const delivered = [];
  const adapter = {
    id: "test-push",
    capabilities: { canPush: true, canWake: false, canRenderAmbient: false },
    /** @param {Record<string, unknown>} event */
    async deliver(event) {
      delivered.push(event);
      return { ok: true };
    },
  };
  try {
    if (previous !== undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    enqueue(value.campaignPath, "campaign.progress", "initial-run:build:running", { runId: "initial-run", nodeId: "build", counters: { attempt: 1 } }, "initial-run");
    enqueue(value.campaignPath, "run.attention", "initial-run:build:budget_attention", { runId: "initial-run", nodeId: "build", identifiers: { errorCode: "budget_attention" } });
    const drained = await drainNotifications(value.campaignPath, { adapters: [adapter] });
    assert.equal(drained.pending, 1, "only the never-pushed progress event stays pending");
    assert.equal(delivered.length, 1, "the adapter saw exactly the attention event");
    assert.equal(delivered[0].type, "run.attention");
    const outbox = readNotificationOutbox(value.campaignPath);
    const attention = outbox.find((event) => event.type === "run.attention");
    assert.ok(attention, "run.attention event exists in the outbox");
    assert.notEqual(attention.deliveredAt, null);
    const progress = outbox.find((event) => event.type === "campaign.progress");
    assert.ok(progress, "campaign.progress event exists in the outbox");
    assert.equal(progress.deliveredAt, null, "campaign.progress is never delivered by an adapter");
    assert.ok(!delivered.some((event) => event.type === "campaign.progress"), "progress was never handed to the adapter");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
    cleanup(value);
  }
});

test("a failing adapter with a multi-kilobyte error leaves the event pending with a bounded lastError", async () => {
  const value = tempRepo();
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  const longError = `adapter rejected: ${"e".repeat(6 * 1024)}`;
  const adapter = {
    id: "failing-push",
    capabilities: { canPush: true, canWake: false, canRenderAmbient: false },
    /** @returns {Promise<{ok: false, error: string}>} */
    async deliver() {
      return { ok: false, error: longError };
    },
  };
  try {
    if (previous !== undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    // Retain an event with the largest bounded payload the projector allows so
    // an unbounded persisted error would push the serialized record past the
    // 8 KiB writeOutbox retention bound.
    enqueue(value.campaignPath, "run.attention", "initial-run:build:budget_attention", {
      runId: "initial-run",
      nodeId: "build",
      identifiers: { errorCode: "budget_attention" },
      data: { runId: "initial-run", nodeId: "build", code: "budget_attention", detail: "d".repeat(2 * 1024) },
    });
    const drained = await drainNotifications(value.campaignPath, { adapters: [adapter] });
    assert.equal(drained.pending, 1, "the failed push must leave the event pending");
    const outbox = readNotificationOutbox(value.campaignPath);
    assert.equal(outbox.length, 1, "the oversized retry history must not erase the event");
    const event = outbox[0];
    assert.equal(event.deliveredAt, null, "the event stays undelivered");
    assert.equal(event.attempts, 1);
    assert.equal(typeof event.lastError, "string");
    assert.ok((event.lastError ?? "").length <= 200, "lastError is bounded to 200 characters");
    assert.ok((event.lastError ?? "").endsWith("…"), "lastError truncates with an ellipsis marker");
    assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") <= 8 * 1024, "the retained event stays inside the serialized budget");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
    cleanup(value);
  }
});

test("campaign progress events coalesce by key until delivered", async () => {
  const value = tempRepo();
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  try {
    /** @param {string} key @param {number} attempt @param {number} done @param {number} total @param {string} coalesceKey */
    const progress = (key, attempt, done, total, coalesceKey) => enqueue(
      value.campaignPath,
      "campaign.progress",
      key,
      {
        runId: "initial-run",
        nodeId: "build",
        counters: { attempt, done, total },
        data: { runId: "initial-run", nodeId: "build", done, total },
      },
      coalesceKey,
    );
    progress("initial-run:one", 1, 1, 3, "initial-run");
    const firstId = readNotificationOutbox(value.campaignPath)[0].eventId;
    progress("initial-run:two", 2, 2, 3, "initial-run");
    enqueue(value.campaignPath, "campaign.progress", "repair-1:one", {
      runId: "repair-1",
      nodeId: "build",
      counters: { attempt: 3, done: 1, total: 1 },
      data: { runId: "repair-1", nodeId: "build", done: 1, total: 1 },
    }, "repair-1");
    let outbox = readNotificationOutbox(value.campaignPath);
    assert.equal(outbox.length, 2);
    assert.notEqual(outbox.find((event) => event.coalesceKey === "initial-run")?.eventId, firstId, "new material state gets its own stable event ID");
    assert.equal(outbox.find((event) => event.coalesceKey === "initial-run")?.summary, "node build progress · attempt 2 · revisions 0");
    assert.deepEqual(outbox.find((event) => event.coalesceKey === "initial-run")?.data, { runId: "initial-run", nodeId: "build", done: 2, total: 3 });
    enqueue(value.campaignPath, "campaign.completed", "campaign", { data: { runCount: 1 } });
    assert.equal(readNotificationOutbox(value.campaignPath).length, 3);
    const notify = join(value.root, "notify.mjs");
    writeFileSync(notify, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n`);
    chmodSync(notify, 0o755);
    process.env.INTENT_FACTORY_NOTIFY_BIN = notify;
    assert.equal((await drainNotifications(value.campaignPath)).pending, 0);
    progress("initial-run:three", 4, 3, 3, "initial-run");
    outbox = readNotificationOutbox(value.campaignPath);
    assert.equal(outbox.filter((event) => event.deliveredAt !== null).length, 3);
    assert.equal(outbox.filter((event) => event.deliveredAt === null).length, 1);
    assert.equal(outbox.find((event) => event.deliveredAt === null)?.summary, "node build progress · attempt 4 · revisions 0");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
    cleanup(value);
  }
});

test("campaign watch orders events, advances cursors incrementally, and validates inputs", () => {
  const value = tempRepo();
  try {
    /** @param {number} seconds @returns {string} */
    const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
    /** @param {string} eventId @param {string} type @param {number} seconds @param {string} summary */
    const event = (eventId, type, seconds, summary) => ({
      eventId,
      type,
      campaignId: "campaign",
      at: at(seconds),
      summary,
      data: {},
      deliveredAt: null,
      attempts: 0,
      lastError: null,
    });
    writeJsonAtomic(join(value.campaignPath, CAMPAIGN_OUTBOX_FILE), [
      event("b", "campaign.progress", 2, "second"),
      event("a", "campaign.attention", 1, "first"),
      event("c", "campaign.completed", 3, "done"),
    ]);
    const first = watchCampaign(value.campaignPath, { cursor: "watcher" });
    assert.deepEqual(first.events.map((entry) => entry.eventId), ["a", "b", "c"]);
    assert.deepEqual(first.cursor, { cursorId: "watcher", at: at(3), eventId: "c" });
    const second = watchCampaign(value.campaignPath, { cursor: "watcher" });
    assert.equal(second.events.length, 0);
    assert.deepEqual(second.cursor, first.cursor);
    assert.deepEqual(watchCampaign(value.campaignPath, { since: "b" }).events.map((entry) => entry.eventId), ["c"]);
    assert.throws(() => watchCampaign(value.campaignPath, { since: "missing" }), /not retained/u);
    assert.throws(() => watchCampaign(value.campaignPath, {}), /exactly one/u);
    assert.throws(() => watchCampaign(value.campaignPath, { since: at(1), cursor: "watcher" }), /exactly one/u);
    assert.throws(() => watchCampaign(value.campaignPath, { cursor: "../escape" }), /safe identifier/u);
  } finally { cleanup(value); }
});

test("watch over a session cursor never advances the ack-owned cursor", () => {
  const value = tempRepo();
  try {
    enqueue(value.campaignPath, "campaign.attention", "session-watch", { identifiers: { errorCode: "open-question" }, data: { code: "open-question" } });
    const sessionCursor = join(value.campaignPath, "watch-cursors", "session-s1.json");
    const first = watchCampaign(value.campaignPath, { cursor: "session-s1" });
    assert.equal(first.events.length, 1, "the first watch read reports the unseen event");
    const second = watchCampaign(value.campaignPath, { cursor: "session-s1" });
    assert.equal(second.events.length, 1, "a session cursor is not advanced by watch, so the event stays unseen");
    assert.deepEqual(second.events.map((entry) => entry.eventId), first.events.map((entry) => entry.eventId));
    assert.equal(existsSync(sessionCursor), false, "watch never writes a session-* cursor file");
    const firstCli = JSON.parse(runPublicCampaignCli(value.root, ["watch", "campaign", "--cwd", value.root, "--cursor", "session-s1"]));
    const secondCli = JSON.parse(runPublicCampaignCli(value.root, ["watch", "campaign", "--cwd", value.root, "--cursor", "session-s1"]));
    assert.equal(firstCli.events.length, 1);
    assert.equal(secondCli.events.length, 1, "the public watch over a session cursor repeats the unseen event");
    assert.equal(secondCli.cursor.cursorId, "session-s1");
    assert.equal(existsSync(sessionCursor), false, "the public watch over a session cursor leaves no durable cursor file");
  } finally { cleanup(value); }
});

test("public campaign CLI watch streams events and rejects combined flags", () => {
  const value = tempRepo();
  try {
    enqueue(value.campaignPath, "campaign.progress", "initial-run", { runId: "initial-run" });
    const first = JSON.parse(runPublicCampaignCli(value.root, ["watch", "campaign", "--cwd", value.root, "--cursor", "progress"]));
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].summary, "run initial-run progress · attempt 0 · revisions 0");
    assert.equal(first.cursor.cursorId, "progress");
    const second = JSON.parse(runPublicCampaignCli(value.root, ["watch", "campaign", "--cwd", value.root, "--cursor", "progress"]));
    assert.equal(second.events.length, 0);
    const rejected = spawnSync(process.execPath, [runnerPath, "campaign", "watch", "campaign", "--cwd", value.root, "--since", first.events[0].eventId, "--cursor", "both"], {
      cwd: value.root,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
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
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
    writeJsonAtomic(contractPath, fixture({
      id: "cli-run",
      campaignId,
      cwd: ".",
      runtimes: {
        luna: { driver: "codex", model: "fake-luna" },
        sol: { driver: "codex", model: "fake-sol" },
      },
      nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }] }), gate: false }],
    }));
    runPublicCampaignCli(root, ["init", campaignId, "--cwd", root, "--goal", "Prove detached campaign autonomy"], env);
    runPublicCampaignCli(root, ["configure", campaignId, "--cwd", root, "--contract", contractPath, "--source-root", sourceRoot], env);
    runPublicCampaignCli(root, ["start", campaignId, "--cwd", root], env);
    runPublicCampaignCli(root, ["supervise", campaignId, "--cwd", root, "--detach", "--interval", "0.01"], env);

    const campaignPath = join(root, ".runs", "campaigns", campaignId);
    const statePath = join(campaignPath, CAMPAIGN_STATE_FILE);
    await waitFor(() => {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.status !== "completed") return null;
        const outbox = readNotificationOutbox(campaignPath);
        return outbox.some(/** @param {{type: string}} event */ (event) => event.type === "campaign.completed") ? state : null;
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

test("watchdog stale liveness emits one deduplicated attention event and refreshes the heartbeat", async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-watchdog-"));
  try {
    const runsDir = join(root, ".runs");
    const created = initializeCampaign(runsDir, { campaignId: "watchdog", goal: "Watchdog staleness" });
    const runDir = join(runsDir, "stale-run");
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    // Both passes share one injected clock: the epoch is a property of the
    // observed timestamps, never of how long the two calls took to run.
    const observedAt = Date.now();
    const updatedAt = new Date(observedAt - 2 * 60 * 60 * 1000).toISOString();
    writeJsonAtomic(join(runDir, "nodes", "build.json"), { id: "build", status: "running", phase: "worker", updatedAt });
    const first = await checkRunLiveness(created.path, runDir, { staleSec: 1, now: observedAt });
    assert.equal(first.stale, true);
    assert.equal(first.eventKey, `stale-run:stale_liveness:${updatedAt}`);
    await checkRunLiveness(created.path, runDir, { staleSec: 1, now: observedAt });
    const attention = readNotificationOutbox(created.path).filter((event) => event.type === "run.attention" && event.data?.code === "stale_liveness");
    assert.equal(attention.length, 1, "repeated passes in the same staleness epoch enqueue exactly one event");
    assert.deepEqual(attention[0].data, { runId: "stale-run", code: "stale_liveness", staleSec: 1, lastObservedAt: updatedAt });
    const heartbeat = readHeartbeat(created.path);
    assert.ok(heartbeat !== null, "the watchdog refreshes the heartbeat");
    assert.equal(heartbeat.state, "blocked");
    assert.match(String(heartbeat.attention), /stale liveness/u);
    assert.equal(heartbeat.lastProgressAt, Math.floor(Date.parse(updatedAt) / 1000));
    const liveness = readJournal(created.path).filter((entry) => entry.type === "liveness");
    assert.equal(liveness.length, 1, "the staleness epoch journals exactly one liveness fact");
    assert.equal(liveness[0].state, "blocked");
    assert.equal(liveness[0].attention, "stale liveness: no progress for 120 min");
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test("campaign liveness planless works without plan.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-planless-"));
  try {
    const runsDir = join(root, ".runs");
    const created = initializeCampaign(runsDir, { campaignId: "planless", goal: "Watchdog without a plan" });
    const campaignPath = created.path;
    assert.equal(existsSync(join(campaignPath, CAMPAIGN_PLAN_FILE)), false);
    assert.equal(existsSync(join(campaignPath, CAMPAIGN_STATE_FILE)), false);
    const runDir = join(runsDir, "planless-run");
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeJsonAtomic(join(runDir, "nodes", "build.json"), {
      id: "build",
      status: "running",
      phase: "worker",
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const result = await checkRunLiveness(campaignPath, runDir, { staleSec: 1 });
    assert.equal(result.stale, true);
    const outbox = readNotificationOutbox(campaignPath);
    assert.equal(outbox.filter((event) => event.type === "run.attention" && event.data?.code === "stale_liveness").length, 1);
    assert.equal(existsSync(join(campaignPath, CAMPAIGN_PLAN_FILE)), false, "the watchdog never writes a plan");
    assert.equal(existsSync(join(campaignPath, CAMPAIGN_STATE_FILE)), false, "the watchdog never writes control state");
    assert.equal(existsSync(join(campaignPath, "campaign.json")), true);
    assert.equal(existsSync(join(campaignPath, "journal.jsonl")), true);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test("campaign sync attaches once per day, prints header, liveness and unseen events, and never writes the cursor", () => {
  const value = tempRepo();
  try {
    /** @param {number} seconds @returns {string} */
    const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
    const sessionId = "s1";
    // A heartbeat ~1 minute in the past keeps the minutes-since-last-progress
    // fact deterministic for the liveness line assertion.
    const lastProgressAt = Math.floor(Date.now() / 1000) - 65;
    writeJsonAtomic(join(value.campaignPath, "heartbeat.json"), {
      schemaVersion: 1,
      campaignId: "campaign",
      phase: "P2",
      checkpoints: { done: 1, total: 3 },
      activeNode: "build",
      runtime: "luna",
      state: "running",
      weightedUsed: 100,
      weightedCap: 6_000_000,
      lastProgressAt,
      attention: null,
      generatedAt: lastProgressAt + 60,
    });
    enqueue(value.campaignPath, "campaign.progress", "one", { runId: "initial-run", nodeId: "build", counters: { attempt: 1 }, at: at(1) }, "initial-run");
    enqueue(value.campaignPath, "run.attention", "two", { runId: "initial-run", identifiers: { errorCode: "budget_attention" }, at: at(2) });
    enqueue(value.campaignPath, "node.terminal", "three", { runId: "initial-run", nodeId: "build", counters: { attempt: 1 }, identifiers: { errorCode: "blocked_context" }, at: at(3) });
    const output = runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    const lines = output.trimEnd().split("\n");
    assert.match(lines[0], /^campaign campaign · status \S+ · attention none$/u);
    assert.equal(
      lines[1],
      `liveness: running · checkpoints 1/3 · active node build · last progress ${new Date(lastProgressAt * 1000).toISOString()} · 1 min since last progress · attention none`,
    );
    assert.deepEqual(lines.slice(2), [
      `${at(1)} campaign.progress node build progress · attempt 1 · revisions 0`,
      `${at(2)} run.attention run initial-run attention · budget_attention`,
      `${at(3)} node.terminal node build terminal · attempt 1 · revisions 0 · blocked_context`,
    ]);
    assert.equal(existsSync(join(value.campaignPath, "watch-cursors", `session-${sessionId}.json`)), false, "sync never writes the session cursor");
    const attaches = readJournal(value.campaignPath).filter((entry) => entry.type === "session.attached" && entry.sessionId === sessionId);
    assert.equal(attaches.length, 1, "sync attaches the session once");
    assert.equal(attaches[0].transcriptUnavailable, true);
    runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    assert.equal(
      readJournal(value.campaignPath).filter((entry) => entry.type === "session.attached" && entry.sessionId === sessionId).length,
      1,
      "an already-attached session is not attached twice in the same day",
    );
  } finally { cleanup(value); }
});

test("sync attaches the session once daily even after the campaign is closed", () => {
  const value = tempRepo();
  try {
    const sessionId = "closed-s1";
    const closedAt = new Date().toISOString();
    // A closed campaign requires a recorded retrospective before closeCampaign
    // accepts the closure, mirroring the public completion flow.
    appendJournal(value.campaignPath, {
      type: "retrospective",
      eventId: "closed-campaign-retrospective",
      at: closedAt,
      sessionId,
      text: "campaign retrospective recorded",
    });
    const closed = closeCampaign(value.campaignPath, { at: closedAt, eventId: "closed-campaign-event" }).campaign;
    assert.equal(closed.status, "closed");
    enqueue(value.campaignPath, "node.terminal", "closed-campaign-terminal", { runId: "initial-run", nodeId: "build", counters: { attempt: 1 } });
    const output = runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    assert.ok(output.includes("node build terminal · attempt 1 · revisions 0"), "the first sync after completion still reads the unseen events");
    const attaches = readJournal(value.campaignPath).filter((entry) => entry.type === "session.attached" && entry.sessionId === sessionId);
    assert.equal(attaches.length, 1, "the first sync after campaign completion records the session attach");
    assert.equal(attaches[0].transcriptUnavailable, true);
    assert.equal(readCampaign(value.campaignPath).status, "closed", "sync never reopens a closed campaign");
    runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    assert.equal(
      readJournal(value.campaignPath).filter((entry) => entry.type === "session.attached" && entry.sessionId === sessionId).length,
      1,
      "a second same-day sync over the closed campaign does not attach again",
    );
  } finally { cleanup(value); }
});

test("campaign ack validates retained event ids and atomically advances the session cursor", () => {
  const value = tempRepo();
  try {
    /** @param {number} seconds @returns {string} */
    const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
    const sessionId = "s1";
    enqueue(value.campaignPath, "run.attention", "one", { runId: "initial-run", identifiers: { errorCode: "budget_attention" }, at: at(1) });
    const firstId = readNotificationOutbox(value.campaignPath)[0].eventId;
    enqueue(value.campaignPath, "node.terminal", "two", { runId: "initial-run", nodeId: "build", counters: { attempt: 2 }, at: at(2) });
    const secondId = readNotificationOutbox(value.campaignPath).find((entry) => entry.eventId !== firstId)?.eventId;
    assert.ok(secondId, "the second event is retained");
    const cursorFile = join(value.campaignPath, "watch-cursors", `session-${sessionId}.json`);
    const firstAck = runPublicCampaignCli(value.root, ["ack", "campaign", "--cwd", value.root, "--session-id", sessionId, "--event-id", firstId]);
    assert.equal(firstAck.trim(), `[campaign] session ${sessionId} acknowledged up to ${firstId}`);
    assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).eventId, firstId);
    const cursorBytesAfterFirstAck = readFileSync(cursorFile);
    const secondAck = runPublicCampaignCli(value.root, ["ack", "campaign", "--cwd", value.root, "--session-id", sessionId, "--event-id", firstId]);
    assert.equal(secondAck, firstAck, "acking the same id twice is a no-op with identical output");
    assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).eventId, firstId, "the cursor does not move on a repeated ack");
    assert.ok(readFileSync(cursorFile).equals(cursorBytesAfterFirstAck), "repeated ack of the current id is a durable no-op: the cursor file stays byte-identical (updatedAt is never rewritten)");
    const synced = runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    assert.match(synced, /liveness: no heartbeat yet/u);
    assert.ok(!synced.includes("run initial-run attention"), "events at or before the acknowledged cursor are unseen by sync");
    assert.ok(synced.includes("node build terminal · attempt 2 · revisions 0"), "sync lists only events after the acknowledged cursor");
    runPublicCampaignCli(value.root, ["ack", "campaign", "--cwd", value.root, "--session-id", sessionId, "--event-id", secondId]);
    assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).eventId, secondId);
    const drained = runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    assert.ok(!drained.includes("node build terminal"), "once every event is acknowledged sync has nothing new to list");
    const rejected = spawnSync(process.execPath, [runnerPath, "campaign", "ack", "campaign", "--cwd", value.root, "--session-id", sessionId, "--event-id", "missing"], {
      cwd: value.root,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0, "acking an event that is neither retained nor previously acknowledged is rejected");
  } finally { cleanup(value); }
});

test("no requiresUser event for healthy progress (D27 precondition)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-no-requires-user-"));
  try {
    const path = writeContract(directory, fixture({
      id: "no-requires-user-run",
      pollIntervalMs: 10,
      nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    }));
    const result = await withFakeCodex(directory, "pass", () => runContract(path));
    assert.equal(result.ok, true, "the healthy contract finishes done");
    const outbox = readNotificationOutbox(campaignDir(join(directory, ".runs"), "test-campaign"));
    assert.ok(outbox.length > 0, "a healthy run to done emits progress and terminal events");
    assert.ok(
      outbox.every((event) => typeof event.requiresUser === "boolean" && event.requiresUser === false),
      "every outbox event from healthy progress is requiresUser false",
    );
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

test("campaign sync output stays under 8000 bytes and reports truncation", () => {
  const value = tempRepo();
  try {
    const sessionId = "s1";
    for (let index = 0; index < 100; index += 1) {
      enqueue(value.campaignPath, "node.terminal", `terminal-${index}`, { runId: "initial-run", nodeId: `build-${index}`, counters: { attempt: 1 } });
    }
    const output = runPublicCampaignCli(value.root, ["sync", "campaign", "--cwd", value.root, "--session-id", sessionId]);
    assert.ok(Buffer.byteLength(output, "utf8") <= 8000, `sync output is ${Buffer.byteLength(output, "utf8")} bytes`);
    assert.match(output, /sync truncated: \d+ more events/u, "a large unseen backlog reports the truncation footer");
    assert.equal(existsSync(join(value.campaignPath, "watch-cursors", `session-${sessionId}.json`)), false, "sync never writes the cursor even when truncating");
  } finally { cleanup(value); }
});

test("several outgoing failover routes are all walked before exhaustion", () => {
  // A runtime may declare more than one outgoing edge. Exhaustion — and with
  // it the only requiresUser attention of this class — is true only once
  // every configured edge has already been attempted.
  const authority = {
    retryLimit: 1,
    repairLimit: 1,
    runtimeFailover: { routes: [{ from: "luna", to: "sol" }, { from: "luna", to: "gemini" }] },
  };
  /** @param {string[]} failoverHistory */
  const walk = (failoverHistory) => classifyTransition({
    authority,
    status: "exhausted",
    errorCode: "provider_exhausted",
    currentRuntime: "luna",
    run: { failoverHistory },
  });
  /** @param {number|undefined} remainingEdges */
  const attentionRequiresUser = (remainingEdges) => projectEvent({
    type: "campaign.attention",
    campaignId: "campaign",
    identifiers: { errorCode: "provider_exhausted_without_declared_failover" },
    remainingEdges,
  }).requiresUser;

  const first = walk([]);
  assert.equal(first.action, "resume");
  assert.equal(first.failoverTo, "sol");
  assert.equal(first.remainingEdges, 2);

  const second = walk(["sol"]);
  assert.equal(second.action, "resume", "the second configured edge is used, not reported as exhaustion");
  assert.equal(second.failoverTo, "gemini");
  assert.equal(second.remainingEdges, 1);
  assert.equal(attentionRequiresUser(second.remainingEdges), false, "an unused edge never wakes the user");

  const exhausted = walk(["sol", "gemini"]);
  assert.equal(exhausted.action, "attention");
  assert.equal(exhausted.reason, "provider_exhausted_without_declared_failover");
  assert.equal(exhausted.remainingEdges, 0);
  assert.equal(attentionRequiresUser(exhausted.remainingEdges), true);
});

test("persisted outbox records stay bounded across delivery mutations", async () => {
  const value = tempRepo();
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  /** @param {import("../scripts/events.mjs").PersistedEvent} event @returns {number} */
  const bytes = (event) => Buffer.byteLength(JSON.stringify(event), "utf8");
  try {
    enqueue(value.campaignPath, "run.terminal", "boundary", {
      runId: "r".repeat(120),
      nodeId: "n".repeat(120),
      identifiers: { runtimeId: "t".repeat(80), errorCode: "provider_exhausted" },
      data: { detail: "d".repeat(600) },
    });
    const [stored] = readNotificationOutbox(value.campaignPath);
    assert.ok(stored !== undefined, "a boundary-sized record is persisted, never dropped by its metadata");
    assert.ok(bytes(stored) > 900, `the fixture must sit near the ceiling, got ${bytes(stored)} bytes`);
    assert.ok(bytes(stored) <= 1024, `enqueued record is ${bytes(stored)} bytes`);

    const notify = join(value.root, "notify.mjs");
    const flag = join(value.root, "notify.failed");
    writeFileSync(notify, `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => { if (existsSync(${JSON.stringify(flag)})) process.exit(0); writeFileSync(${JSON.stringify(flag)}, "1"); process.stderr.write("E".repeat(1024)); process.exit(1); });\n`);
    chmodSync(notify, 0o755);
    process.env.INTENT_FACTORY_NOTIFY_BIN = notify;

    await drainNotifications(value.campaignPath);
    const [failed] = readNotificationOutbox(value.campaignPath);
    assert.equal(failed.attempts, 1);
    assert.ok(bytes(failed) <= 1024, `record after a failed delivery is ${bytes(failed)} bytes`);
    // At the ceiling the envelope yields to the canonical record: the error
    // text is bounded away instead of growing the persisted record.
    assert.ok(
      failed.lastError === null || (typeof failed.lastError === "string" && failed.lastError.length <= 200),
      "a delivery error never grows the record past the ceiling",
    );

    await drainNotifications(value.campaignPath);
    const [delivered] = readNotificationOutbox(value.campaignPath);
    assert.equal(delivered.attempts, 2);
    assert.ok(typeof delivered.deliveredAt === "string", "delivery metadata is recorded");
    assert.ok(bytes(delivered) <= 1024, `record after delivery is ${bytes(delivered)} bytes`);

    // A small record has room for the error: it is retained, capped, and the
    // persisted record still honours the ceiling.
    rmSync(flag, { force: true });
    enqueue(value.campaignPath, "run.terminal", "small", { runId: "initial-run", nodeId: "build" });
    await drainNotifications(value.campaignPath);
    const small = readNotificationOutbox(value.campaignPath).find((event) => event.nodeId === "build");
    assert.ok(small !== undefined);
    assert.equal(typeof small.lastError, "string");
    assert.ok(String(small.lastError).length <= 200, `lastError is ${String(small.lastError).length} characters`);
    assert.ok(bytes(small) <= 1024, `small record after a failed delivery is ${bytes(small)} bytes`);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
    cleanup(value);
  }
});
