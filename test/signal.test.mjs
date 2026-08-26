import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIGNAL_END,
  SIGNAL_START,
  syncAgentSignal,
} from "../skills/mine/intent-factory/scripts/signal.mjs";
import {
  closeCampaign,
  initializeCampaign,
} from "../skills/mine/intent-factory/scripts/campaign.mjs";

/**
 * @returns {{repo: string, runsDir: string, agentsPath: string}}
 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "signal-repo-"));
  const runsDir = join(repo, ".runs");
  const agentsPath = join(repo, "AGENTS.md");
  writeFileSync(agentsPath, "# Rules\n\nline one\n");
  return { repo, runsDir, agentsPath };
}

/**
 * @param {string} runsDir
 * @param {string} runId
 * @param {string[]} statuses
 */
function writeRunNodes(runsDir, runId, statuses) {
  const nodeDir = join(runsDir, runId, "nodes");
  mkdirSync(nodeDir, { recursive: true });
  statuses.forEach((status, index) => {
    writeFileSync(join(nodeDir, `node-${index}.json`), JSON.stringify({ status }));
  });
}

test("writes a signal block for an active campaign and an active run", () => {
  const { repo, runsDir, agentsPath } = makeRepo();
  initializeCampaign(runsDir, { campaignId: "demo", goal: "deliver demo" });
  writeRunNodes(runsDir, "run-a", ["done", "running"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.match(text, /^# Rules\n\nline one\n\n<!-- intent-factory-active:start/, "original content kept on top");
  assert.match(text, /campaign `demo`: active/);
  assert.match(text, /run `run-a`: active \(1\/2 nodes done\)/);
  assert.match(text, /deterministic detached process/u);
  assert.match(text, /do not poll `status` in a loop/u);
  assert.equal(text.split(SIGNAL_START).length - 1, 1, "single block");
});

test("updates the block in place without duplicating", () => {
  const { runsDir, agentsPath } = makeRepo();
  writeRunNodes(runsDir, "run-a", ["running"]);
  syncAgentSignal(runsDir);
  assert.equal(syncAgentSignal(runsDir), false, "no change means no write");
  writeRunNodes(runsDir, "run-b", ["pending"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.equal(text.split(SIGNAL_START).length - 1, 1);
  assert.match(text, /run `run-a`/);
  assert.match(text, /run `run-b`/);
});

test("removes the block when everything is terminal", () => {
  const { runsDir, agentsPath } = makeRepo();
  const campaign = initializeCampaign(runsDir, { campaignId: "demo", goal: "g" });
  writeRunNodes(runsDir, "run-a", ["done", "failed"]);
  syncAgentSignal(runsDir);
  closeCampaign(campaign.path);
  writeRunNodes(runsDir, "run-a", ["done", "done"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.ok(!text.includes(SIGNAL_START) && !text.includes(SIGNAL_END), "block removed");
  assert.match(text, /^# Rules\n\nline one\n$/, "original content intact");
});

test("does nothing when AGENTS.md is missing", () => {
  const repo = mkdtempSync(join(tmpdir(), "signal-no-agents-"));
  const runsDir = join(repo, ".runs");
  writeRunNodes(runsDir, "run-a", ["running"]);
  assert.equal(syncAgentSignal(runsDir), false);
  assert.ok(!existsSync(join(repo, "AGENTS.md")), "no file created");
});
