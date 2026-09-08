import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initializeCampaign } from "../scripts/campaign.mjs";
import { recordLiveness } from "../scripts/heartbeat.mjs";

/** @typedef {import("../scripts/heartbeat.mjs").LivenessFact} LivenessFact */

const scriptPath = fileURLToPath(new URL("../statusline/claude-code.sh", import.meta.url));

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {LivenessFact}
 */
function makeFact(overrides = {}) {
  return /** @type {LivenessFact} */ ({
    type: "liveness",
    eventId: "live-1",
    at: "2026-09-02T12:00:00.000Z",
    campaignId: "hb",
    runId: "run-a",
    nodeId: "node-a",
    phase: "P2",
    checkpointsDone: 3,
    checkpointsTotal: 7,
    runtime: "codex",
    state: "running",
    lastProgressAt: "2026-09-02T11:50:00.000Z",
    attention: null,
    ...overrides,
  });
}

/**
 * Build the restricted PATH fixture: only the stated shell parsing tools
 * (sh, sed, awk) and no jq and no date.
 *
 * @returns {{ binDir: string, env: NodeJS.ProcessEnv }}
 */
function restrictedEnv() {
  const binDir = mkdtempSync(join(tmpdir(), "if-statusline-bin-"));
  /** @type {[string, string[]][]} */
  const candidates = [
    ["sh", ["/bin/sh"]],
    ["sed", ["/usr/bin/sed", "/bin/sed"]],
    ["awk", ["/usr/bin/awk", "/bin/awk"]],
  ];
  for (const [name, sources] of candidates) {
    const source = sources.find((path) => existsSync(path));
    assert.ok(source !== undefined, `no ${name} binary found`);
    symlinkSync(source, join(binDir, name));
  }
  return { binDir, env: { PATH: binDir } };
}

/**
 * Serialize a canonical heartbeat (key-sorted, compact, trailing newline,
 * recent lastProgressAt) exactly like the bounded writer does.
 *
 * @param {string|null} attention
 * @returns {string}
 */
function canonicalHeartbeat(attention) {
  const nowSec = Math.floor(Date.now() / 1000);
  return `${JSON.stringify({
    activeNode: "node-a",
    attention,
    campaignId: "hb",
    checkpoints: { done: 3, total: 7 },
    generatedAt: nowSec,
    lastProgressAt: nowSec - 60,
    phase: "P2",
    runtime: "codex",
    schemaVersion: 1,
    state: "running",
  })}\n`;
}

/**
 * Run the status-line script with a fixture session JSON for `directory`.
 *
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} stdout
 */
function render(directory, env) {
  const result = spawnSync(scriptPath, [], {
    input: JSON.stringify({ cwd: directory, workspace: { current_dir: directory } }),
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** @param {string} stdout @returns {string} */
function singleLine(stdout) {
  assert.equal(stdout.endsWith("\n"), true, "exactly one line plus newline");
  const line = stdout.slice(0, -1);
  assert.equal(line.includes("\n"), false, "no embedded newline");
  return line;
}

test("statusline renders heartbeat fields and prefers the newest heartbeat", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-render-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "hb", goal: "Prove the status line" });
  const lastProgressMs = Date.now() - 130_000;
  recordLiveness(created.path, makeFact({
    eventId: "render-1",
    lastProgressAt: new Date(lastProgressMs).toISOString(),
    attention: null,
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "render-1" });

  const older = initializeCampaign(runsDir, { campaignId: "hb-old", goal: "Older campaign" });
  recordLiveness(older.path, makeFact({
    eventId: "old-1",
    campaignId: "hb-old",
    nodeId: "old-node",
    lastProgressAt: new Date(lastProgressMs).toISOString(),
    attention: null,
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "old-1" });
  const backdated = new Date(Date.now() - 3_600_000);
  utimesSync(join(older.path, "heartbeat.json"), backdated, backdated);

  const expectedBefore = Math.floor((Date.now() - lastProgressMs) / 60_000);
  const stdout = render(directory);
  const expectedAfter = Math.floor((Date.now() - lastProgressMs) / 60_000);
  const line = singleLine(stdout);

  assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
  const age = /(\d+)m ago$/.exec(line);
  assert.ok(age !== null, line);
  const ageMinutes = Number(age[1]);
  assert.ok(ageMinutes === expectedBefore || ageMinutes === expectedAfter, `age ${ageMinutes} not in [${expectedBefore}, ${expectedAfter}]`);
});

test("statusline renders heartbeat attention text", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-attention-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Attention text" });
  recordLiveness(created.path, makeFact({
    eventId: "attention-1",
    lastProgressAt: new Date(Date.now() - 60_000).toISOString(),
    attention: "waiting on the gate",
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "attention-1" });
  const line = singleLine(render(directory));
  assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
  assert.ok(line.includes("· attention: waiting on the gate"), line);
});

test("statusline degrades to empty lines without jq or a heartbeat", () => {
  const { binDir, env } = restrictedEnv();
  assert.equal(existsSync(join(binDir, "jq")), false, "jq must be absent from the degrade PATH");
  assert.equal(existsSync(join(binDir, "date")), false, "date must be absent from the degrade PATH");

  const directory = mkdtempSync(join(tmpdir(), "if-statusline-degrade-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Degrade proof" });
  recordLiveness(created.path, makeFact({
    eventId: "degrade-1",
    lastProgressAt: new Date(Date.now() - 60_000).toISOString(),
    attention: "waiting on the gate",
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "degrade-1" });
  const line = singleLine(render(directory, env));
  assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
  assert.ok(line.includes("· attention: waiting on the gate"), line);
  assert.ok(/\d+m ago · attention: waiting on the gate$/.test(line), line);

  const withoutRuns = mkdtempSync(join(tmpdir(), "if-statusline-none-"));
  assert.equal(render(withoutRuns, env), "\n");

  const brokenDir = mkdtempSync(join(tmpdir(), "if-statusline-broken-"));
  const broken = initializeCampaign(join(brokenDir, ".runs"), { campaignId: "hb", goal: "Broken heartbeat" });
  writeFileSync(join(broken.path, "heartbeat.json"), "not json at all\n");
  assert.equal(render(brokenDir, env), "\n");
});

test("statusline renders quoted or newline attention without corrupting state", () => {
  // A valid bounded attention may carry escapes such as \n and \"; the
  // renderer must show it faithfully on one line and never let it forge a
  // second state record.
  const heartbeatJson = canonicalHeartbeat("wait\nstate=done \"quoted\"");

  for (const mode of ["jq", "fallback"]) {
    const directory = mkdtempSync(join(tmpdir(), `if-statusline-attn-${mode}-`));
    const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Tricky attention" });
    writeFileSync(join(created.path, "heartbeat.json"), heartbeatJson);
    const line = singleLine(render(directory, mode === "fallback" ? restrictedEnv().env : undefined));
    assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
    assert.ok(line.includes("· attention: wait\\nstate=done \\\"quoted\\\""), line);
    assert.ok(/\d+m ago/.test(line), line);
  }
});

test("statusline degrades silently on a heartbeat larger than the read window", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-oversize-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Oversized heartbeat" });
  recordLiveness(created.path, makeFact({
    eventId: "oversize-1",
    lastProgressAt: new Date(Date.now() - 60_000).toISOString(),
    attention: null,
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "oversize-1" });

  // Valid JSON prefix followed by whitespace, pushed past the 1 KiB cap: the
  // size check and the read cap come from the same bounded mechanism, so the
  // renderer prints an empty line with exit 0.
  const heartbeatPath = join(created.path, "heartbeat.json");
  const original = readFileSync(heartbeatPath, "utf8");
  writeFileSync(heartbeatPath, `${original}${" ".repeat(2048)}`);
  assert.equal(render(directory), "\n");
});

test("statusline bounded output stays within 160 characters", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-bound-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Bound the status line" });
  recordLiveness(created.path, makeFact({
    eventId: "bound-1",
    campaignId: "c".repeat(128),
    runId: "r".repeat(128),
    nodeId: "n".repeat(128),
    phase: "p".repeat(128),
    runtime: "t".repeat(128),
    attention: "A".repeat(80),
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "bound-1" });
  const line = singleLine(render(directory));
  assert.ok(line.length <= 160, `rendered ${line.length} characters: ${line}`);
});

test("statusline truncates attention within the 160-character bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-attn-bound-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Bound attention" });
  recordLiveness(created.path, makeFact({
    eventId: "attn-bound-1",
    campaignId: "c".repeat(64),
    lastProgressAt: new Date(Date.now() - 60_000).toISOString(),
    attention: "A".repeat(80),
  }), { generatedAt: "2026-09-02T12:00:00.000Z", eventId: "attn-bound-1" });
  const line = singleLine(render(directory));
  assert.ok(line.length <= 160, `rendered ${line.length} characters: ${line}`);
  assert.ok(line.includes("· attention: A"), "attention must appear on the rendered line");
  assert.equal(line.includes("A".repeat(80)), false, "attention must be truncated to fit the bound");
});

test("statusline renders with no external tool on PATH", () => {
  // The process budget is builtins plus jq plus one bounded-read process:
  // with an empty PATH none of them exists, and the builtin reader still
  // renders the line.
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-builtin-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Builtin-only render" });
  writeFileSync(join(created.path, "heartbeat.json"), canonicalHeartbeat("waiting on the gate"));
  const line = singleLine(render(directory, { PATH: "" }));
  assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
  assert.ok(line.includes("· attention: waiting on the gate"), line);
});

test("statusline degrades on an oversized heartbeat without jq", () => {
  const { env } = restrictedEnv();
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-oversize-nojq-"));
  const created = initializeCampaign(join(directory, ".runs"), { campaignId: "hb", goal: "Oversized without jq" });
  const heartbeatPath = join(created.path, "heartbeat.json");

  // Bytes beyond the single bounded line: the read window ends at that line,
  // so the file is not the bounded artifact and degrades.
  writeFileSync(heartbeatPath, `${canonicalHeartbeat(null)}${" ".repeat(2048)}`);
  assert.equal(render(directory, env), "\n");

  // One line already past the 1 KiB cap degrades with and without jq.
  writeFileSync(heartbeatPath, canonicalHeartbeat("A".repeat(1200)));
  assert.equal(render(directory, env), "\n");
  assert.equal(render(directory), "\n");
});
