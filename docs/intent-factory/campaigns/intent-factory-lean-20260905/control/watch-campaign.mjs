#!/usr/bin/env node
// Campaign watcher for the control session: prints one line per actionable
// change and nothing for progress. Meant to run under a persistent harness
// monitor so the orchestrator is woken only when it has to act:
//   - a linked run reaches a terminal state (all nodes terminal)
//   - a node enters an attention state (failed, exhausted, stalled, canceled,
//     or blocked for a reason other than a failed dependency)
//   - a run is not terminal but its controller process is gone (orphan)
//   - the campaign is active and no run has been active for 20 minutes
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2] ?? process.cwd();
const campaignId = process.argv[3];
const pollMs = Number(process.argv[4] ?? 30_000);
const idleAfterMs = 20 * 60_000;
const idleRepeatMs = 60 * 60_000;
if (!campaignId) { console.error("usage: watch-campaign.mjs <repo> <campaign-id> [pollMs]"); process.exit(2); }

const TERMINAL = new Set(["done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);
const ATTENTION = new Set(["failed", "exhausted", "stalled", "canceled", "cancelled"]);
const runsDir = join(repo, ".runs");
const campaignPath = join(runsDir, "campaigns", campaignId);

/** @type {Map<string, string>} */
const runSignatures = new Map();
/** @type {Set<string>} */
const announced = new Set();
let lastActiveAt = Date.now();
let lastIdleAnnounceAt = 0;
let first = true;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function nodeStates(runDir) {
  const dir = join(runDir, "nodes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))).filter(Boolean);
}

function tick() {
  const campaign = readJson(join(campaignPath, "campaign.json"));
  if (!campaign) return;
  if (campaign.status !== "active") { console.log(`campaign-watch: ${campaignId} is ${campaign.status}; stopping`); process.exit(0); }
  let anyActive = false;
  for (const runId of campaign.linkedRunIds ?? []) {
    const runDir = join(runsDir, runId);
    const nodes = nodeStates(runDir);
    if (!nodes.length) continue;
    const terminal = nodes.every((n) => TERMINAL.has(n.status));
    const signature = nodes.map((n) => `${n.id}:${n.status}:${n.error?.code ?? ""}`).join("|");
    const previous = runSignatures.get(runId);
    runSignatures.set(runId, signature);
    if (!terminal) {
      anyActive = true;
      const run = readJson(join(runDir, "run.json"));
      const lease = readJson(join(runDir, "controller-lease.json"));
      const pid = lease?.pid ?? run?.pid;
      const key = `orphan:${runId}`;
      if (!pidAlive(pid) && !first) {
        if (!announced.has(key)) { announced.add(key); console.log(`campaign-watch: ${runId} has non-terminal nodes but no live controller (pid ${pid ?? "?"}); resume it`); }
      } else announced.delete(key);
    }
    if (first) continue;
    if (previous === signature) continue;
    for (const n of nodes) {
      const key = `node:${runId}:${n.id}:${n.status}:${n.error?.code ?? ""}`;
      const attention = ATTENTION.has(n.status) || (n.status === "blocked" && n.error?.code && n.error.code !== "dependency_failed");
      if (attention && !announced.has(key)) { announced.add(key); console.log(`campaign-watch: ${runId} node ${n.id} ${n.status}${n.error ? ` [${n.error.code}] ${String(n.error.message ?? "").slice(0, 160)}` : ""}`); }
    }
    if (terminal) {
      const key = `terminal:${runId}`;
      if (!announced.has(key)) {
        announced.add(key);
        const counts = {};
        for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1;
        console.log(`campaign-watch: ${runId} terminal · ${Object.entries(counts).map(([s, c]) => `${c} ${s}`).join(" · ")}`);
      }
    }
  }
  const now = Date.now();
  if (anyActive) { lastActiveAt = now; lastIdleAnnounceAt = 0; }
  else if (!first && now - lastActiveAt >= idleAfterMs && now - lastIdleAnnounceAt >= idleRepeatMs) {
    lastIdleAnnounceAt = now;
    console.log(`campaign-watch: ${campaignId} active but no run has been active for ${Math.round((now - lastActiveAt) / 60_000)} min; dispatch the next step`);
  }
  first = false;
}

tick();
setInterval(tick, pollMs);
