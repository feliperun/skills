/**
 * The plan-runner signal block in the target repository's AGENTS.md.
 *
 * Every agent that opens the repository — whatever the harness — reads
 * AGENTS.md before its first prompt. The runner mirrors its active state
 * there so a takeover session learns that active work exists without
 * probing .runs/. The block is machine-managed: agents read it, never edit
 * it.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TERMINAL } from "./lib.mjs";
import { HANDOFF_FILE, campaignsDir, discoverCampaigns } from "./campaign.mjs";

export const SIGNAL_START = "<!-- plan-runner-active:start (managed by plan-runner — read, never edit) -->";
export const SIGNAL_END = "<!-- plan-runner-active:end -->";

/**
 * @param {string} runsDir
 * @returns {string[]}
 */
function activeCampaignLines(runsDir) {
  const root = campaignsDir(runsDir);
  if (!existsSync(root)) return [];
  const { campaigns } = discoverCampaigns(runsDir);
  return campaigns
    .filter(({ campaign }) => campaign.status !== "closed")
    .map(({ campaign }) => `- plan-runner campaign \`${campaign.id}\`: active — read \`.runs/campaigns/${campaign.id}/${HANDOFF_FILE}\``);
}

/**
 * @param {string} runsDir
 * @returns {string[]}
 */
function activeRunLines(runsDir) {
  if (!existsSync(runsDir)) return [];
  /** @type {string[]} */
  const lines = [];
  for (const name of readdirSync(runsDir)) {
    const nodeDir = join(runsDir, name, "nodes");
    if (!existsSync(nodeDir)) continue;
    const statuses = readdirSync(nodeDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          const status = /** @type {{status?: unknown}} */ (JSON.parse(readFileSync(join(nodeDir, file), "utf8"))).status;
          return typeof status === "string" ? status : null;
        } catch {
          return null;
        }
      });
    const done = statuses.filter((status) => status === "done").length;
    const active = statuses.some((status) => status !== null && !TERMINAL.has(status));
    if (active) {
      lines.push(`- plan-runner run \`${name}\`: active (${done}/${statuses.length} nodes done) — read \`.runs/${name}/STATUS.md\`; \`resume\` or \`supervise\` it`);
    }
  }
  return lines;
}

/**
 * Rewrites the managed signal block at the bottom of <repo>/AGENTS.md from
 * the current .runs state. Leaves the file untouched when there is no
 * AGENTS.md, no active work, or nothing changed. Returns true when the file
 * was written.
 *
 * @param {string} runsDir
 * @returns {boolean}
 */
export function syncAgentSignal(runsDir) {
  const agentsPath = join(dirname(runsDir), "AGENTS.md");
  if (!existsSync(agentsPath)) return false;
  const current = readFileSync(agentsPath, "utf8");
  const lines = [...activeCampaignLines(runsDir), ...activeRunLines(runsDir)];
  const block = lines.length
    ? `${SIGNAL_START}\nActive work in this repository — continue it instead of starting over:\n\n${lines.join("\n")}\n${SIGNAL_END}`
    : "";
  const start = current.indexOf(SIGNAL_START);
  const end = current.indexOf(SIGNAL_END);
  if (!lines.length && start < 0 && end < 0) return false;
  let before;
  let after;
  if (start >= 0 && end > start) {
    before = current.slice(0, start).trimEnd();
    after = current.slice(end + SIGNAL_END.length);
  } else if (start >= 0) {
    before = current.slice(0, start).trimEnd();
    after = "";
  } else if (end >= 0) {
    before = current.slice(0, end).trimEnd();
    after = current.slice(end + SIGNAL_END.length);
  } else {
    before = current.trimEnd();
    after = "";
  }
  const next = [before, block, after.trimStart()].filter((part) => part.length).join("\n\n") + "\n";
  if (next === current) return false;
  writeFileSync(agentsPath, next);
  return true;
}
