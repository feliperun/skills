import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import { buildSnapshot, snapshotSignature, startServer, tailJsonl } from "../dashboard/dashboard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";
const CAMPAIGN_ID = "dash-campaign";
const RUN_ID = "dash-run";
const ORPHAN_RUN_ID = "dash-run-orphan";

test("tailJsonl returns the last complete entries and drops a torn line", () => {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-dashboard-"));
  try {
    const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({ seq: index }));
    writeFileSync(join(directory, "j.jsonl"), `${lines.join("\n")}\n{\"seq\":\"tor`);
    const entries = tailJsonl(join(directory, "j.jsonl"), 5);
    assert.deepEqual(entries.map((entry) => entry.seq), [15, 16, 17, 18, 19]);
    assert.deepEqual(tailJsonl(join(directory, "missing.jsonl"), 5), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tailJsonl truncates by bytes and resumes at the next full line", () => {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-dashboard-"));
  try {
    const lines = Array.from({ length: 50 }, (_, index) => JSON.stringify({ seq: index, pad: "x".repeat(40) }));
    writeFileSync(join(directory, "j.jsonl"), `${lines.join("\n")}\n`);
    const entries = tailJsonl(join(directory, "j.jsonl"), 1000, 400);
    assert.ok(entries.length < 50);
    assert.equal(entries.at(-1)?.seq, 49);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the server serves the snapshot for a recorded run directory with the documented sources and none of the deleted ones", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    assert.equal(snapshot.selectedCampaignId, CAMPAIGN_ID);
    assert.equal(snapshot.now.state, "active");
    assert.equal(snapshot.now.runId, RUN_ID);
    assert.equal(snapshot.runs.length, 2);
    assert.equal(snapshot.runs.find((/** @type {any} */ run) => run.id === RUN_ID).goal, "Ship the dashboard rewrite");
    assert.equal(snapshot.handoff.includes("campaign handoff body"), true);
    assert.equal(snapshot.drawer, null, "no drawer without a selected run");
    const reconcile = snapshot.needsYou.find((/** @type {any} */ item) => item.nodeId === "gamma");
    assert.equal(reconcile.command, `resume ${join(world.runsDir, RUN_ID)} --reconcile gamma`);
    const plain = snapshot.needsYou.find((/** @type {any} */ item) => item.nodeId === "beta");
    assert.equal(plain.command, `resume ${join(world.runsDir, RUN_ID)}`);
    const orphan = snapshot.needsYou.find((/** @type {any} */ item) => item.status === "orphaned");
    assert.equal(orphan.command, `resume ${join(world.runsDir, ORPHAN_RUN_ID)}`);
    const serialized = JSON.stringify(snapshot).toLowerCase();
    for (const deleted of ["ledger", "outbox", "journaltail", "weighted", "heartbeat", "epoch", "decisions", "constraints", "sessions"]) {
      assert.equal(serialized.includes(deleted), false, `snapshot must not carry ${deleted}`);
    }
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the run drawer detail reads the worker log, verification, diff and prompt from the node JSON and its logged files", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: RUN_ID, nodeId: "alpha" }));
    const detail = snapshot.drawer.detail;
    assert.deepEqual(detail.log.lines, ["line one", "line two"]);
    assert.equal(detail.verification.commands[0].command, "npm run check");
    assert.equal(detail.verification.commands[0].passed, true);
    assert.match(detail.verification.commands[0].outputTail, /ok/u);
    assert.equal(detail.diff.stat, "1 file changed");
    assert.deepEqual(detail.diff.files, ["README.md"]);
    assert.equal(detail.findings, null);
    assert.match(detail.prompt, /Implement the dashboard rewrite/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("gate findings surface on the exhausted node's findings tab", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: RUN_ID, nodeId: "beta" }));
    const findings = snapshot.drawer.detail.findings;
    assert.equal(findings.verdict, "fail");
    assert.equal(findings.findings[0].severity, "major");
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("an idle campaign with a terminal run and no live controller reports idle in the now strip and no needs-you items", () => {
  const world = makeIdleWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: "idle-campaign" }));
    assert.equal(snapshot.now.state, "idle");
    assert.equal(snapshot.now.runId, "idle-run");
    assert.deepEqual(snapshot.needsYou, []);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the payload stays under 200 KB with a long worker log", () => {
  const world = makeWorld({ longLog: true });
  try {
    const snapshot = buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: RUN_ID, nodeId: "alpha" });
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 200 * 1024);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("an unknown campaign id falls back to the active campaign instead of throwing", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: "no-such-campaign" }));
    assert.equal(snapshot.selectedCampaignId, CAMPAIGN_ID);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the DOM test renders the snapshot's five sections in order, with the needs-you banner only when attention exists", () => {
  const { window } = runDashboardScript();
  const render = window.__dashboardTestHooks.renderSectionsHtml;
  const withAttention = render(fixtureSnapshot({ needsYou: [{ runId: RUN_ID, nodeId: "beta", status: "exhausted", errorCode: null, command: `resume ${RUN_ID}` }] }));
  const markers = ['id="now"', 'id="needsyou"', 'id="runs"', 'id="drawer"', 'id="handoff"'];
  const positions = markers.map((marker) => withAttention.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0), "every section must be present");
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "sections must appear in the section-4 order");
  assert.doesNotMatch(withAttention, /weighted/iu);
  const withoutAttention = render(fixtureSnapshot({ needsYou: [] }));
  assert.equal(withoutAttention.includes('id="needsyou"'), false, "the banner is absent without attention");
});

test("server serves the page, a snapshot and a 404 for an unknown route", async () => {
  const world = makeWorld();
  const server = startServer({ runsDir: world.runsDir, port: 0 });
  try {
    await once(server);
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await page.text(), /Intent Factory/u);
    const snapshot = /** @type {any} */ (await (await fetch(`${base}/api/snapshot?campaign=${CAMPAIGN_ID}`)).json());
    assert.equal(snapshot.selectedCampaignId, CAMPAIGN_ID);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the SSE endpoint emits an update when status.json changes", async () => {
  const world = makeWorld();
  const server = startServer({ runsDir: world.runsDir, port: 0, pollMs: 40 });
  try {
    await once(server);
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stream?campaign=${CAMPAIGN_ID}`);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @param {number} count */
    const readUpdates = async (count) => {
      const deadline = Date.now() + 5_000;
      while ((buffer.match(/^event: update$/gmu) ?? []).length < count) {
        if (Date.now() > deadline) throw new Error(`only ${(buffer.match(/^event: update$/gmu) ?? []).length} updates arrived`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stream read timed out")), 5_000)),
        ]);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUpdates(1);
    const statusPath = join(world.runsDir, RUN_ID, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    status.nodes[0].status = "done";
    writeFileSync(statusPath, JSON.stringify(status));
    await readUpdates(2);
    const datas = buffer.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    assert.equal(datas.at(-1).runs.find((/** @type {any} */ run) => run.id === RUN_ID).nodesDone, 1);
    await reader.cancel();
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("snapshotSignature changes when a node snapshot changes and is stable otherwise", () => {
  const world = makeWorld();
  try {
    const selection = { campaignId: CAMPAIGN_ID };
    const before = snapshotSignature(world.runsDir, selection);
    assert.equal(snapshotSignature(world.runsDir, selection), before);
    const nodePath = join(world.runsDir, RUN_ID, "nodes", "alpha.json");
    const node = JSON.parse(readFileSync(nodePath, "utf8"));
    writeFileSync(nodePath, JSON.stringify({ ...node, updatedAt: LATER }));
    assert.notEqual(snapshotSignature(world.runsDir, selection), before);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

/** @param {import("node:http").Server} server @returns {Promise<void>} */
function once(server) {
  return new Promise((resolve) => server.on("listening", resolve));
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

/**
 * A campaign with one active-controller run (three nodes covering running,
 * exhausted-with-gate-findings and blocked-needing-reconcile) and one
 * orphaned run whose controller is gone while a node still claims to run.
 *
 * @param {{longLog?: boolean}} [options]
 * @returns {{directory: string, runsDir: string}}
 */
function makeWorld({ longLog = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-dashboard-"));
  const runsDir = join(directory, ".runs");
  const campaignPath = join(runsDir, "campaigns", CAMPAIGN_ID);
  mkdirSync(campaignPath, { recursive: true });
  writeJson(join(campaignPath, "campaign.json"), {
    id: CAMPAIGN_ID, goal: "Ship the dashboard rewrite", status: "active",
    linkedRunIds: [RUN_ID, ORPHAN_RUN_ID], createdAt: NOW, updatedAt: LATER,
  });
  writeFileSync(join(campaignPath, "HANDOFF.md"), "# handoff\n\ncampaign handoff body\n");

  const runDir = join(runsDir, RUN_ID);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const logPath = join(runDir, "logs", "alpha.1.worker.jsonl");
  writeFileSync(logPath, longLog ? `${"x".repeat(80)}\n`.repeat(6_000) : "line one\nline two\n");
  const promptPath = join(runDir, "logs", "alpha.1.worker.prompt");
  writeFileSync(promptPath, longLog ? "Implement the dashboard rewrite. ".repeat(4_000) : "Implement the dashboard rewrite.");

  writeJson(join(runDir, "run.json"), { schemaVersion: 1, contractVersion: "0.1.0", pid: process.pid, processStartToken: null, startedAt: NOW, sourceIdentity: { kind: "run" } });
  writeJson(join(runDir, "status.json"), {
    schemaVersion: 1, run: RUN_ID, contractId: RUN_ID, campaignId: CAMPAIGN_ID, goal: "Ship the dashboard rewrite",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 500, costUsd: 1.5 },
    controller: { state: "active", pid: process.pid, since: NOW, lastTick: null },
    identityWarnings: [], summary: "1 running · 1 exhausted · 1 blocked",
    nodes: [
      { id: "alpha", status: "running", phase: "p0", executionPhase: "worker", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 1, revisions: 0, pendingHandoff: null, note: "phase p0 · fresh · worker", scopeFindings: null, errorCode: null, blockedBy: [] },
      { id: "beta", status: "exhausted", phase: "p0", executionPhase: "complete", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 1, revisions: 1, pendingHandoff: null, note: "gate fail (major) · needs work", scopeFindings: null, errorCode: null, blockedBy: [] },
      { id: "gamma", status: "blocked", phase: "p1", executionPhase: "complete", runtime: null, continuation: null, attempt: 1, revisions: 0, pendingHandoff: null, note: "unknown_effect_reconciled", scopeFindings: null, errorCode: "unknown_effect_reconciled", blockedBy: [] },
    ],
  });
  writeJson(join(runDir, "nodes", "alpha.json"), {
    id: "alpha", status: "running", startedAt: NOW, updatedAt: NOW, costUsd: 1.5,
    runtime: { driver: "claude", model: "claude-sonnet-5" }, gate: null,
    invocations: [{ role: "worker", stdoutPath: logPath, promptPath }],
    scope: { changedPaths: ["README.md"], changedPathCount: 1, unexpectedPaths: [], unexpectedPathCount: 0 },
    verification: { passed: true, commands: [{ argv: ["npm", "run", "check"], passed: true, attempts: [{ durationMs: 120, stdout: "ok", stderr: "", passed: true }] }] },
  });
  writeJson(join(runDir, "nodes", "beta.json"), {
    id: "beta", status: "exhausted", startedAt: NOW, updatedAt: LATER, costUsd: 0.4,
    runtime: { driver: "claude", model: "claude-sonnet-5" },
    gate: { verdict: "fail", maxSeverity: "major", summary: "needs work", findings: [{ severity: "major", description: "desc", evidence: "ev" }] },
    invocations: [], scope: null, verification: null,
  });
  writeJson(join(runDir, "nodes", "gamma.json"), {
    id: "gamma", status: "blocked", startedAt: null, updatedAt: LATER, costUsd: null,
    runtime: null, gate: null, invocations: [], scope: null, verification: null,
  });
  writeFileSync(join(runDir, "events.jsonl"), `${JSON.stringify({ at: LATER, node: "beta", from: "running", to: "exhausted" })}\n`);
  writeFileSync(join(runDir, "notify.jsonl"), `${JSON.stringify({ type: "attention", runId: RUN_ID, nodeId: "beta", status: "no_transport", at: LATER })}\n`);
  writeFileSync(join(runDir, "usage.jsonl"), `${JSON.stringify({ invocationId: "i1", runId: RUN_ID, nodeId: "alpha", role: "worker", inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 500, costUsd: 1.5, startedAt: NOW, finishedAt: LATER })}\n`);

  const orphanDir = join(runsDir, ORPHAN_RUN_ID);
  mkdirSync(join(orphanDir, "nodes"), { recursive: true });
  writeJson(join(orphanDir, "run.json"), { schemaVersion: 1, contractVersion: "0.1.0", pid: 1, processStartToken: null, startedAt: NOW, sourceIdentity: { kind: "run" } });
  writeJson(join(orphanDir, "status.json"), {
    schemaVersion: 1, run: ORPHAN_RUN_ID, contractId: ORPHAN_RUN_ID, campaignId: CAMPAIGN_ID, goal: "orphaned run",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: null },
    controller: { state: "none", pid: null, since: null, lastTick: null },
    identityWarnings: [], summary: "1 running",
    nodes: [{ id: "solo", status: "running", phase: "p0", executionPhase: "worker", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 1, revisions: 0, pendingHandoff: null, note: null, scopeFindings: null, errorCode: null, blockedBy: [] }],
  });
  writeJson(join(orphanDir, "nodes", "solo.json"), { id: "solo", status: "running", startedAt: NOW, updatedAt: NOW, costUsd: null, runtime: null, gate: null, invocations: [], scope: null, verification: null });
  writeFileSync(join(orphanDir, "events.jsonl"), `${JSON.stringify({ at: NOW, node: "solo", from: "pending", to: "running" })}\n`);
  writeFileSync(join(orphanDir, "notify.jsonl"), "");
  writeFileSync(join(orphanDir, "usage.jsonl"), "");

  return { directory, runsDir };
}

/** A campaign whose only run is terminal with no live controller. @returns {{directory: string, runsDir: string}} */
function makeIdleWorld() {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-dashboard-"));
  const runsDir = join(directory, ".runs");
  const campaignPath = join(runsDir, "campaigns", "idle-campaign");
  mkdirSync(campaignPath, { recursive: true });
  writeJson(join(campaignPath, "campaign.json"), { id: "idle-campaign", goal: "already shipped", status: "active", linkedRunIds: ["idle-run"], createdAt: NOW, updatedAt: LATER });
  writeFileSync(join(campaignPath, "HANDOFF.md"), "# handoff\n\ndone\n");
  const runDir = join(runsDir, "idle-run");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeJson(join(runDir, "run.json"), { schemaVersion: 1, contractVersion: "0.1.0", pid: 1, processStartToken: null, startedAt: NOW, sourceIdentity: { kind: "run" } });
  writeJson(join(runDir, "status.json"), {
    schemaVersion: 1, run: "idle-run", contractId: "idle-run", campaignId: "idle-campaign", goal: "already shipped",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, costUsd: 0.1 },
    controller: { state: "none", pid: null, since: null, lastTick: null },
    identityWarnings: [], summary: "1 done",
    nodes: [{ id: "build", status: "done", phase: "p0", executionPhase: "complete", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 1, revisions: 0, pendingHandoff: null, note: "complete", scopeFindings: null, errorCode: null, blockedBy: [] }],
  });
  writeJson(join(runDir, "nodes", "build.json"), { id: "build", status: "done", startedAt: NOW, updatedAt: LATER, costUsd: 0.1, runtime: { driver: "claude", model: "claude-sonnet-5" }, gate: null, invocations: [], scope: null, verification: null });
  writeFileSync(join(runDir, "events.jsonl"), `${JSON.stringify({ at: LATER, node: "build", from: "running", to: "done" })}\n`);
  writeFileSync(join(runDir, "notify.jsonl"), "");
  writeFileSync(join(runDir, "usage.jsonl"), "");
  return { directory, runsDir };
}

/** @param {Record<string, unknown>} overrides @returns {Record<string, unknown>} */
function fixtureSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    campaigns: [{ id: CAMPAIGN_ID, goal: "Ship the dashboard rewrite", status: "active" }],
    corrupt: [],
    selectedCampaignId: CAMPAIGN_ID,
    now: { state: "active", runId: RUN_ID, nodeId: "alpha", elapsedMs: 60_000, costUsd: 1.5, updatedAt: LATER },
    needsYou: [],
    runs: [{ id: RUN_ID, corrupt: null, campaignId: CAMPAIGN_ID, goal: "Ship the dashboard rewrite", nodesDone: 0, nodesTotal: 3, attempts: 1, elapsedMs: null, costUsd: 1.5, startedAt: NOW, updatedAt: LATER, controllerActive: true, state: "active" }],
    drawer: null,
    handoff: "campaign handoff body",
    ...overrides,
  };
}

/** Loads dashboard/index.html's inline script into a minimal DOM-shimmed vm context. @returns {{window: any}} */
function runDashboardScript() {
  const html = readFileSync(join(HERE, "..", "dashboard", "index.html"), "utf8");
  const code = /** @type {string} */ (html.match(/<script>([\s\S]*?)<\/script>/u)?.[1]);
  const elements = new Map();
  const element = () => ({
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; },
    addEventListener() {},
    classList: { toggle() {} },
    querySelector() { return { className: "" }; },
    querySelectorAll() { return []; },
    textContent: "",
    dataset: {},
  });
  const document_ = {
    /** @param {string} id */
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    hidden: false,
  };
  const context = /** @type {any} */ ({
    document: document_,
    console,
    URLSearchParams,
    setInterval: () => 0,
    clearInterval() {},
    EventSource: class { addEventListener() {} close() {} },
    fetch: async () => { throw new Error("no network in test"); },
    AbortSignal: { timeout: () => undefined },
  });
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return { window: context };
}
