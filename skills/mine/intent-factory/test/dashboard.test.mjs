import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateContract } from "../scripts/contract.mjs";
import { appendJournal, campaignDir, registerRun } from "../scripts/campaign.mjs";
import { buildCampaignDetail, buildOverview, buildSnapshot, campaignSignature, startServer, tailJsonl } from "../dashboard/dashboard.mjs";
import { fixture, packet, writeContract } from "./helpers.mjs";

const NOW = "2026-01-01T00:00:00.000Z";
const CAMPAIGN_ID = "dash-campaign";

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
    assert.ok(entries.every((entry) => Number.isInteger(entry.seq)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overview counts nodes per campaign, flags live work and sums weighted ledger usage", () => {
  const world = makeWorld();
  try {
    const overview = /** @type {any} */ (buildOverview(world.runsDir));
    const entry = overview.campaigns.find((/** @type {any} */ candidate) => candidate.id === CAMPAIGN_ID);
    assert.equal(entry.runCount, 1);
    assert.deepEqual(entry.nodeCounts, { done: 1, running: 1 });
    assert.equal(entry.live, true);
    assert.equal(entry.weightedInputTokens, 1_100_000);
    assert.equal(overview.activeCampaignId, CAMPAIGN_ID);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("campaign detail folds projection, ledger, outbox, journal and run state", () => {
  const world = makeWorld();
  try {
    const detail = /** @type {any} */ (buildCampaignDetail(world.runsDir, CAMPAIGN_ID));
    assert.equal(detail.next.text, "ship it");
    assert.deepEqual(detail.decisions.map((/** @type {any} */ decision) => decision.decisionId), ["d2", "d1"]);
    assert.deepEqual(detail.outcomes.map((/** @type {any} */ outcome) => outcome.text), ["second", "first"]);
    const epoch = detail.ledger.epochs[0];
    assert.equal(epoch.weightedInputTokens, 1_100_000);
    assert.equal(epoch.conservativeInputTokens, 2_000_000);
    assert.deepEqual(epoch.byRole, { worker: 1, judge: 1 });
    assert.equal(detail.outbox.pending.length, 1);
    assert.equal(detail.outbox.recent.length, 1);
    assert.equal(detail.journalTail[0].text, "newest journal entry");
    const run = detail.runs[0];
    assert.equal(run.id, "dash-run");
    assert.equal(run.startedAt, NOW);
    assert.equal(run.summary, "1 running · 1 done");
    assert.equal(run.lastEventAt, "2026-01-01T00:01:00.000Z");
    const running = run.nodes.find((/** @type {any} */ node) => node.id === "alpha");
    assert.equal(running.status, "running");
    assert.equal(running.usage.inputTokens, 10);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("an unreadable linked run is listed as corrupt instead of breaking the detail", () => {
  const world = makeWorld();
  try {
    rmSync(join(world.runDir, "contract.json"));
    const detail = /** @type {any} */ (buildCampaignDetail(world.runsDir, CAMPAIGN_ID));
    assert.match(detail.runs[0].corrupt, /contract\.json/u);
    assert.ok(Array.isArray(detail.runs[0].eventsTail));
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("unknown campaigns and traversal ids are rejected", () => {
  const world = makeWorld();
  try {
    assert.throws(() => buildCampaignDetail(world.runsDir, "no-such-campaign"), /unknown campaign/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("server serves the UI, the overview and one campaign detail", async () => {
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
    const overview = /** @type {any} */ (await (await fetch(`${base}/api/overview`)).json());
    assert.equal(overview.activeCampaignId, CAMPAIGN_ID);
    const detail = /** @type {any} */ (await (await fetch(`${base}/api/campaigns/${CAMPAIGN_ID}`)).json());
    assert.equal(detail.campaign.id, CAMPAIGN_ID);
    assert.equal((await fetch(`${base}/api/campaigns/${encodeURIComponent("../secrets")}`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("snapshot bundles the overview with the selected campaign detail in milliseconds", () => {
  const world = makeWorld();
  try {
    const started = performance.now();
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, null));
    const elapsed = performance.now() - started;
    assert.equal(snapshot.selected, CAMPAIGN_ID);
    assert.equal(snapshot.runsDir, world.runsDir);
    assert.equal(snapshot.detail.campaign.id, CAMPAIGN_ID);
    assert.equal(snapshot.detail.runs[0].nodes.length, 2);
    assert.equal(snapshot.error, null);
    assert.ok(elapsed < 500, `snapshot took ${elapsed}ms; it must never validate contracts`);
    const unknown = /** @type {any} */ (buildSnapshot(world.runsDir, "no-such-campaign"));
    assert.equal(unknown.detail, null);
    assert.match(unknown.error, /unknown campaign/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("campaign signature changes when a node snapshot or journal changes", () => {
  const world = makeWorld();
  try {
    const before = campaignSignature(world.runsDir, CAMPAIGN_ID);
    assert.equal(campaignSignature(world.runsDir, CAMPAIGN_ID), before, "stable while nothing changes");
    const nodePath = join(world.runDir, "nodes", "alpha.json");
    const node = JSON.parse(readFileSync(nodePath, "utf8"));
    writeFileSync(nodePath, JSON.stringify({ ...node, status: "done", updatedAt: "2026-01-01T00:05:00.000Z" }, null, 2));
    assert.notEqual(campaignSignature(world.runsDir, CAMPAIGN_ID), before);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("default stream follows the active campaign and pushes on-disk changes", async () => {
  const world = makeWorld();
  const server = startServer({ runsDir: world.runsDir, port: 0, pollMs: 40 });
  try {
    await once(server);
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stream`);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @param {number} count */
    const readEvents = async (count) => {
      const deadline = Date.now() + 5_000;
      while ((buffer.match(/^event: update$/gmu) ?? []).length < count) {
        if (Date.now() > deadline) throw new Error(`stream produced ${(buffer.match(/^event: update$/gmu) ?? []).length} updates: ${buffer.slice(0, 200)}`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error("stream update timed out")), 5_000);
            timer.unref();
          }),
        ]);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readEvents(1);
    const first = JSON.parse(/** @type {string} */ (buffer.split("\n").find((line) => line.startsWith("data: "))).slice(6));
    assert.equal(first.detail.campaign.id, CAMPAIGN_ID);
    assert.equal(first.detail.runs[0].nodes.find((/** @type {any} */ node) => node.id === "alpha").status, "running");
    const nodePath = join(world.runDir, "nodes", "alpha.json");
    const node = JSON.parse(readFileSync(nodePath, "utf8"));
    writeFileSync(nodePath, JSON.stringify({ ...node, status: "done", updatedAt: "2026-01-01T00:05:00.000Z" }, null, 2));
    await readEvents(2);
    const datas = buffer.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    assert.equal(datas.at(-1).detail.runs[0].nodes.find((/** @type {any} */ candidate) => candidate.id === "alpha").status, "done");
    await reader.cancel();
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

/** @param {import("node:http").Server} server @returns {Promise<void>} */
function once(server) {
  return new Promise((resolve) => server.on("listening", resolve));
}

/**
 * A temp repository with one campaign, one two-node run, journal, projection,
 * ledger and outbox.
 *
 * @returns {{directory: string, runsDir: string, runDir: string}}
 */
function makeWorld() {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-dashboard-"));
  const contractPath = writeContract(directory, fixture({
    campaignId: CAMPAIGN_ID,
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet(), gate: false },
      { id: "beta", type: "backend", taskPacket: packet(), gate: false },
    ],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runsDir = join(directory, ".runs");
  const campaignPath = campaignDir(runsDir, CAMPAIGN_ID);
  const runDir = join(runsDir, "dash-run");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  cpSync(contractPath, join(runDir, "contract.json"));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    pid: process.pid,
    processStartToken: null,
    startedAt: NOW,
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  writeNode(runDir, contract, "alpha", { status: "running", phase: "worker" });
  writeNode(runDir, contract, "beta", { status: "done", phase: "complete" });
  writeFileSync(join(runDir, "events.jsonl"), [
    JSON.stringify({ at: "2026-01-01T00:00:10.000Z", node: "alpha", from: "pending", to: "running", attempt: 1, runtime: "luna" }),
    JSON.stringify({ at: "2026-01-01T00:01:00.000Z", node: "beta", from: "running", to: "done", attempt: 1 }),
  ].map((line) => `${line}\n`).join(""));
  registerRun(campaignPath, "dash-run");
  appendJournal(campaignPath, { type: "decision", eventId: cryptoId(1), at: "2026-01-01T00:00:20.000Z", sessionId: "s1", text: "first decision", decisionId: "d1" });
  appendJournal(campaignPath, { type: "decision", eventId: cryptoId(2), at: "2026-01-01T00:00:30.000Z", sessionId: "s1", text: "second decision", decisionId: "d2" });
  appendJournal(campaignPath, { type: "outcome", eventId: cryptoId(3), at: "2026-01-01T00:02:00.000Z", sessionId: "s1", text: "newest journal entry" });
  writeJson(join(campaignPath, "projection.json"), {
    cursor: 3,
    projection: {
      updatedAt: NOW,
      next: { type: "next", eventId: cryptoId(4), at: NOW, sessionId: "s1", text: "ship it" },
      decisions: {
        d1: { type: "decision", at: "2026-01-01T00:00:20.000Z", sessionId: "s1", text: "first", decisionId: "d1" },
        d2: { type: "decision", at: "2026-01-01T00:00:30.000Z", sessionId: "s1", text: "second", decisionId: "d2" },
      },
      questions: {},
      constraints: [],
      intents: [],
      outcomes: [
        { type: "outcome", at: "2026-01-01T00:00:10.000Z", sessionId: "s1", text: "first" },
        { type: "outcome", at: "2026-01-01T00:00:40.000Z", sessionId: "s1", text: "second" },
      ],
      sessions: [],
    },
  });
  writeJson(join(campaignPath, "usage-ledger.json"), {
    schemaVersion: 1,
    epochs: {
      "e1": {
        policy: { epoch: "e1", maxInputTokens: 2_000_000, judgeReserveInputTokens: 200_000, cacheReadWeight: 0.1 },
        invocations: {
          one: { runId: "dash-run", campaignId: CAMPAIGN_ID, role: "worker", usage: { inputTokens: 500_000, outputTokens: 1, cacheReadInputTokens: 1_000_000 } },
          two: { runId: "dash-run", campaignId: CAMPAIGN_ID, role: "judge", usage: { inputTokens: 500_000, outputTokens: null, cacheReadInputTokens: 0 } },
        },
      },
    },
  });
  writeJson(join(campaignPath, "notification-outbox.json"), [
    { eventId: "a", type: "run.attention", at: NOW, summary: "pending one", deliveredAt: null },
    { eventId: "b", type: "node.terminal", at: NOW, summary: "delivered one", deliveredAt: NOW },
  ]);
  return { directory, runsDir, runDir };
}

/**
 * @param {string} runDir
 * @param {ReturnType<typeof validateContract>} contract
 * @param {string} id
 * @param {{status: string, phase: string}} overrides
 */
function writeNode(runDir, contract, id, { status, phase }) {
  const planNode = /** @type {import("../scripts/contract.mjs").ValidatedNode} */ (contract.nodes.find((candidate) => candidate.id === id));
  writeFileSync(join(runDir, "nodes", `${id}.json`), `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    id,
    type: planNode.type,
    sourceIdentity: planNode.sourceIdentity,
    packetHash: planNode.packetHash,
    status,
    phase,
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: NOW,
    updatedAt: NOW,
    result: null,
    gate: null,
    error: null,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
  }, null, 2)}\n`);
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

let sequence = 0;
/** @param {number} seed */
function cryptoId(seed) {
  sequence += 1;
  return `id-${seed}-${String(sequence).padStart(4, "0")}`;
}
