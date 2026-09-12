import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  closeCampaign,
  discoverCampaigns,
  initializeCampaign,
  registerRun,
  renderHandoff,
  resolveCampaign,
} from "../../src/campaign/index.mjs";
import { appendJsonl } from "../../src/run/store.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { runContract } from "../../src/cli.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { appendJournal, readJournal, validateJournalEntry } from "../../src/campaign/journal.mjs";
import { HANDOFF_BYTES, HANDOFF_FILE, HANDOFF_LIMIT, JOURNAL_FILE, JOURNAL_TEXT_BYTES, PROJECTION_FILE, campaignDir } from "../../src/campaign/layout.mjs";

// The other half of campaign.test.mjs: folding the journal into state and
// rendering HANDOFF.md inside its byte budget.

test("projection recovery after a partial trailing journal line beyond the tail window does not duplicate", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-projection-tail-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "projtail", goal: "Prove tail recovery" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "constraint", eventId: "c0", at, sessionId: "codex-1", text: "constraint-0" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "constraint-1" });
  appendJournal(created.path, { type: "constraint", eventId: "c2", at, sessionId: "codex-1", text: "constraint-2" });
  const journalPath = join(created.path, "journal.jsonl");
  const partial = `{"type":"intent","eventId":"partial","at":"${at}","sessionId":"codex-1","text":"${"P".repeat(20000)}`;
  writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}${partial}`);

  const first = renderHandoff(created.path, runsDir);
  let projection = JSON.parse(readFileSync(join(created.path, PROJECTION_FILE), "utf8"));
  assert.ok(projection.byte > 0);
  assert.equal(projection.projection.constraints.length, 3);
  assert.equal(projection.projection.intents.length, 0);

  const second = renderHandoff(created.path, runsDir);
  projection = JSON.parse(readFileSync(join(created.path, PROJECTION_FILE), "utf8"));
  assert.equal(projection.projection.constraints.length, 3);
  assert.equal(projection.projection.intents.length, 0);
  assert.equal(second, first);
  assert.match(second, /constraint-2/u);
  assert.doesNotMatch(second, /P{50}/u);
});

test("a stale projection record with byte 0 but folded entries is reparsed, not duplicated", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-projection-stale-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "staleproj", goal: "Prove stale guard" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "constraint", eventId: "c0", at, sessionId: "codex-1", text: "constraint-0" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "constraint-1" });
  const journalPath = join(created.path, "journal.jsonl");
  const journal = readJournal(created.path);
  const stale = {
    cursor: journal.length,
    byte: 0,
    size: statSync(journalPath).size,
    projection: {
      updatedAt: at,
      decisions: {},
      questions: {},
      constraints: journal.filter((entry) => entry.type === "constraint"),
      intents: [],
      outcomes: [],
      sessions: [],
      next: null,
      evicted: {},
    },
  };
  writeFileSync(join(created.path, PROJECTION_FILE), JSON.stringify(stale));
  renderHandoff(created.path, runsDir);
  const projection = JSON.parse(readFileSync(join(created.path, PROJECTION_FILE), "utf8"));
  assert.equal(projection.projection.constraints.length, 2);
  assert.ok(projection.byte > 0);
});
test("initializes a campaign with an empty bounded handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-init-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "launch", goal: "Ship the durable handoff" });
  assert.equal(created.campaign.goal, "Ship the durable handoff");
  assert.equal(readJournal(created.path)[0].type, "campaign.initialized");
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /# campaign launch handoff/u);
  assert.match(handoff, /Ship the durable handoff/u);
  assert.match(handoff, /No linked runs yet/u);
});

test("rejects dot and dotdot campaign ids", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-dot-id-"));
  const runsDir = join(directory, ".runs");
  for (const campaignId of [".", ".."]) {
    assert.throws(() => campaignDir(runsDir, campaignId), /campaignId/u);
    assert.throws(
      () => initializeCampaign(runsDir, { campaignId, goal: "Prove bounded campaign paths" }),
      /campaignId/u,
    );
    assert.throws(() => resolveCampaign(runsDir, campaignId), /campaignId/u);
  }
  assert.equal(existsSync(join(runsDir, "campaigns")), false);
});

test("session lineage records transcripts and explicit unavailability", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-session-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "sessions", goal: "Prove lineage" });
  appendJournal(created.path, {
    type: "session.attached",
    eventId: "session-1",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    tool: "codex",
    transcript: join(directory, "codex-1.jsonl"),
    transcriptUnavailable: false,
    format: "jsonl",
    cursor: "42",
  });
  appendJournal(created.path, {
    type: "session.attached",
    eventId: "session-2",
    at: new Date().toISOString(),
    sessionId: "claude-1",
    tool: "claude",
    transcript: null,
    transcriptUnavailable: true,
    format: null,
    cursor: null,
  });
  appendJournal(created.path, {
    type: "intent",
    eventId: "intent-1",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Continue without reading the full transcript",
  });
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /Updated: \d{4}-\d{2}-\d{2}T/u);
  assert.match(handoff, /codex codex-1 · transcript: .*codex-1\.jsonl · format: jsonl · cursor: 42/u);
  assert.match(handoff, /claude claude-1 · transcript: unavailable · format: - · cursor: -/u);
  assert.match(handoff, /Recent user intents[\s\S]*Continue without reading the full transcript/u);
});

test("decision supersession removes replaced decisions from the handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-supersede-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "decisions", goal: "Prove supersession" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "decision", eventId: "decision-1", at, sessionId: "codex-1", decisionId: "d1", text: "Use JSONL" });
  appendJournal(created.path, { type: "decision", eventId: "decision-2", at, sessionId: "codex-1", decisionId: "d2", text: "Use Markdown handoff" });
  appendJournal(created.path, { type: "supersede", eventId: "supersede-1", at, sessionId: "codex-1", supersedes: "d1", text: "Replaced by d2" });
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /\[d2\] Use Markdown handoff/u);
  assert.doesNotMatch(handoff, /\[d1\] Use JSONL/u);
});

test("handoff projection preserves constraints beyond 20 when the budget allows", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-bounded-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "bounded", goal: "Prove bounded projection" });
  for (let index = 0; index < HANDOFF_LIMIT + 5; index += 1) {
    appendJournal(created.path, {
      type: "constraint",
      eventId: `constraint-${String(index).padStart(3, "0")}`,
      at: new Date().toISOString(),
      sessionId: "codex-1",
      text: `constraint-${String(index).padStart(3, "0")}`,
    });
  }
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /constraint-000/u);
  assert.match(handoff, /constraint-024/u);
  assert.doesNotMatch(handoff, /earlier user constraints omitted/u);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
});

test("session lineage beyond 20 sessions survives when the budget allows", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-sessions-bounded-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "lineage", goal: "Prove lineage budgeting" });
  for (let index = 0; index < HANDOFF_LIMIT + 5; index += 1) {
    appendJournal(created.path, {
      type: "session.attached",
      eventId: `session-${String(index).padStart(3, "0")}`,
      at: new Date().toISOString(),
      sessionId: `codex-${String(index).padStart(3, "0")}`,
      tool: "codex",
      transcript: join(directory, `transcript-${index}.jsonl`),
      transcriptUnavailable: false,
      format: "jsonl",
      cursor: String(index),
    });
  }
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /codex codex-000/u);
  assert.match(handoff, /codex codex-024/u);
  assert.doesNotMatch(handoff, /earlier session lineage omitted/u);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
});

test("run registration links the run and handoff reflects fresh node status", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-run-"));
  const path = writeContract(directory, fixture({
    id: "linked-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const runsDir = join(directory, ".runs");
  const campaign = resolveCampaign(runsDir, "test-campaign");
  assert.deepEqual(campaign.campaign.linkedRunIds, ["linked-run"]);
  const handoff = renderHandoff(campaign.path, runsDir);
  assert.match(handoff, /## Linked runs/u);
  assert.match(handoff, /- linked-run: 1 nodes · 1 done/u);
});

test("run registration is idempotent across resume", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-idempotent-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "idempotent", goal: "Prove idempotent registration" });
  registerRun(created.path, "same-run");
  registerRun(created.path, "same-run");
  assert.deepEqual(resolveCampaign(runsDir, "idempotent").campaign.linkedRunIds, ["same-run"]);
  assert.equal(readJournal(created.path).filter((entry) => entry.type === "run.registered").length, 1);
});

test("rejects malformed journal events before append", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-invalid-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "invalid", goal: "Prove validation" });
  assert.throws(
    () => validateJournalEntry({ type: "intent", sessionId: "codex-1", text: "missing timestamp" }),
    /entry\.at/u,
  );
  assert.throws(
    () => appendJournal(created.path, { type: "intent", sessionId: "codex-1", text: "missing timestamp" }),
    /entry\.at/u,
  );
  assert.throws(
    () => appendJournal(created.path, { type: "intent", eventId: "bad-text", at: new Date().toISOString(), sessionId: "codex-1", text: "" }),
    /entry\.text/u,
  );
  assert.throws(
    () => appendJournal(created.path, { type: "session.attached", eventId: "bad-path", at: new Date().toISOString(), sessionId: "codex-1", tool: "codex", transcript: "relative.jsonl", transcriptUnavailable: false, format: "jsonl", cursor: null }),
    /absolute path/u,
  );
});

test("refuses ambiguous campaign discovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-ambiguous-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "alpha", goal: "First" });
  initializeCampaign(runsDir, { campaignId: "beta", goal: "Second" });
  assert.throws(() => resolveCampaign(runsDir), /multiple campaigns found/u);
  assert.equal(resolveCampaign(runsDir, "beta").campaign.id, "beta");
});

test("campaign CLI initializes, attaches, records via stdin, and shows the handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-"));
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const init = spawnSync(process.execPath, [runner, "campaign", "init", "cli", "--cwd", directory, "--goal", "Ship CLI"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /cli initialized/u);

  const attach = spawnSync(process.execPath, [
    runner, "campaign", "attach", "cli", "--cwd", directory,
    "--tool", "codex", "--session-id", "codex-1", "--transcript", join(directory, "transcript.jsonl"),
    "--format", "jsonl", "--cursor", "12",
  ], { encoding: "utf8" });
  assert.equal(attach.status, 0, attach.stderr);

  const record = spawnSync(process.execPath, [
    runner, "campaign", "note", "cli", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "decision", "--decision-id", "d1", "--text", "-",
  ], { encoding: "utf8", input: "Use a bounded handoff" });
  assert.equal(record.status, 0, record.stderr);

  const show = spawnSync(process.execPath, [runner, "campaign", "show", "cli", "--cwd", directory], { encoding: "utf8" });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Use a bounded handoff/u);
  assert.match(show.stdout, /codex codex-1/u);
});

test("campaign CLI refuses a malformed checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-invalid-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "cli-invalid", goal: "Prove CLI validation" });
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    runner, "campaign", "note", "cli-invalid", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "bogus", "--text", "bad",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--kind must be/u);
});

test("campaign CLI lists, closes, and resolves questions", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-lifecycle-"));
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const initA = spawnSync(process.execPath, [runner, "campaign", "init", "alpha", "--cwd", directory, "--goal", "Ship A"], { encoding: "utf8" });
  assert.equal(initA.status, 0, initA.stderr);
  const initB = spawnSync(process.execPath, [runner, "campaign", "init", "beta", "--cwd", directory, "--goal", "Ship B"], { encoding: "utf8" });
  assert.equal(initB.status, 0, initB.stderr);

  const listed = spawnSync(process.execPath, [runner, "campaign", "list", "--cwd", directory], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /alpha · active/u);
  assert.match(listed.stdout, /beta · active/u);

  const note = spawnSync(process.execPath, [
    runner, "campaign", "note", "alpha", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "open-question", "--question-id", "q1", "--text", "Is the handoff bounded?",
  ], { encoding: "utf8" });
  assert.equal(note.status, 0, note.stderr);
  const resolved = spawnSync(process.execPath, [
    runner, "campaign", "resolve", "alpha", "--cwd", directory,
    "--session-id", "codex-1", "--question-id", "q1", "--text", "Yes, semantically.",
  ], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const show = spawnSync(process.execPath, [runner, "campaign", "show", "alpha", "--cwd", directory], { encoding: "utf8" });
  assert.equal(show.status, 0, show.stderr);
  assert.doesNotMatch(show.stdout, /Is the handoff bounded\?/u);

  const closeWithoutRetro = spawnSync(process.execPath, [runner, "campaign", "close", "beta", "--cwd", directory], { encoding: "utf8" });
  assert.notEqual(closeWithoutRetro.status, 0);
  assert.match(closeWithoutRetro.stderr, /no recorded retrospective/u);
  const retro = spawnSync(process.execPath, [
    runner, "campaign", "note", "beta", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "retrospective", "--text", "Retrospective: shipped B; improvements recorded.",
  ], { encoding: "utf8" });
  assert.equal(retro.status, 0, retro.stderr);
  const closed = spawnSync(process.execPath, [runner, "campaign", "close", "beta", "--cwd", directory], { encoding: "utf8" });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /beta closed/u);
  const listedAgain = spawnSync(process.execPath, [runner, "campaign", "list", "--cwd", directory], { encoding: "utf8" });
  assert.equal(listedAgain.status, 0, listedAgain.stderr);
  assert.match(listedAgain.stdout, /beta · closed/u);

  const noteOnClosed = spawnSync(process.execPath, [
    runner, "campaign", "note", "beta", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "intent", "--text", "too late",
  ], { encoding: "utf8" });
  assert.notEqual(noteOnClosed.status, 0);
  assert.match(noteOnClosed.stderr, /closed/u);
});

test("campaign CLI attach retries with a stable event id are idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-idem-"));
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const init = spawnSync(process.execPath, [runner, "campaign", "init", "idem", "--cwd", directory, "--goal", "Ship"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const args = [
    runner, "campaign", "attach", "idem", "--cwd", directory,
    "--tool", "codex", "--session-id", "codex-1", "--transcript", join(directory, "transcript.jsonl"),
    "--format", "jsonl", "--cursor", "1", "--event-id", "attach-1",
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const retry = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(retry.status, 0, retry.stderr);
  const runsDir = join(directory, ".runs");
  const campaign = resolveCampaign(runsDir, "idem");
  const sessions = readJournal(campaign.path).filter((entry) => entry.type === "session.attached");
  assert.equal(sessions.length, 1);
});

test("campaign CLI accepts --no-transcript and rejects unknown options", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-strict-"));
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const init = spawnSync(process.execPath, [runner, "campaign", "init", "strict", "--cwd", directory, "--goal", "Ship"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const attach = spawnSync(process.execPath, [
    runner, "campaign", "attach", "strict", "--cwd", directory,
    "--tool", "codex", "--session-id", "codex-1", "--no-transcript",
  ], { encoding: "utf8" });
  assert.equal(attach.status, 0, attach.stderr);
  const unknown = spawnSync(process.execPath, [
    runner, "campaign", "note", "strict", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "intent", "--text", "x", "--bogus", "y",
  ], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown option '--bogus'/u);
});

test("campaign CLI scopes flags to operations and note kinds", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-scoped-"));
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const init = spawnSync(process.execPath, [runner, "campaign", "init", "scoped", "--cwd", directory, "--goal", "Ship"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const listWithGoal = spawnSync(process.execPath, [runner, "campaign", "list", "--cwd", directory, "--goal", "ignored"], { encoding: "utf8" });
  assert.notEqual(listWithGoal.status, 0);
  assert.match(listWithGoal.stderr, /Unknown option '--goal'/u);
  const showWithGoal = spawnSync(process.execPath, [runner, "campaign", "show", "scoped", "--cwd", directory, "--goal", "ignored"], { encoding: "utf8" });
  assert.notEqual(showWithGoal.status, 0);
  assert.match(showWithGoal.stderr, /Unknown option '--goal'/u);
  const noteWithWrongKindFlag = spawnSync(process.execPath, [
    runner, "campaign", "note", "scoped", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "intent", "--text", "x", "--decision-id", "d1",
  ], { encoding: "utf8" });
  assert.notEqual(noteWithWrongKindFlag.status, 0);
  assert.match(noteWithWrongKindFlag.stderr, /--decision-id is only valid for --kind decision/u);
});

test("campaign CLI watch --wake parses --interval as a positive number of seconds", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-interval-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "interval", goal: "Prove the public interval unit" });
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  for (const interval of ["0", "abc"]) {
    const result = spawnSync(process.execPath, [runner, "campaign", "watch", "interval", "--cwd", directory, "--wake", "--interval", interval], { encoding: "utf8" });
    assert.notEqual(result.status, 0, interval);
    assert.match(result.stderr, /--interval must be a positive number of seconds/u);
  }
});

test("linked-run corruption cannot kill a controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-corrupt-run-"));
  const path = writeContract(directory, fixture({
    id: "clean-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runsDir = join(directory, ".runs");
  const campaign = resolveCampaign(runsDir, "test-campaign");
  registerRun(campaign.path, "broken-run");
  mkdirSync(join(runsDir, "broken-run", "nodes"), { recursive: true });
  writeFileSync(join(runsDir, "broken-run", "nodes", "bad.json"), '{ "status": ');
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const handoff = renderHandoff(campaign.path, runsDir);
  assert.match(handoff, /broken-run: unreadable/u);
  assert.match(handoff, /- clean-run: 1 nodes · 1 done/u);
});

test("handoff projection failure records a diagnostic and cannot kill a controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-diagnostic-"));
  const path = writeContract(directory, fixture({
    id: "diag-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runsDir = join(directory, ".runs");
  const campaign = resolveCampaign(runsDir, "test-campaign");
  const journalPath = join(campaign.path, "journal.jsonl");
  writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}{ not json\n`);
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "campaign.handoff-failed"));
});

test("appendJsonl repairs a partial trailing line from a bounded tail", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-jsonl-repair-"));
  const path = join(directory, "events.jsonl");
  appendJsonl(path, { n: 1 });
  const partial = openSync(path, "a");
  try {
    writeSync(partial, '{"n":2');
  } finally {
    closeSync(partial);
  }
  appendJsonl(path, { n: 3 });
  const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [{ n: 1 }, { n: 3 }]);
});

test("appendJsonl recovers a large journal from its bounded tail", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-jsonl-repair-tail-"));
  const path = join(directory, "events.jsonl");
  const fd = openSync(path, "w");
  try {
    for (let index = 0; index < 12_000; index += 1) writeSync(fd, `{"n":${index}}\n`);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(path).size > 64 * 1024);
  const partial = openSync(path, "a");
  try {
    writeSync(partial, '{"n":');
  } finally {
    closeSync(partial);
  }
  appendJsonl(path, { n: -1 });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 12_001);
  const penultimate = lines.at(-2);
  const lastLine = lines.at(-1);
  assert.ok(penultimate && lastLine, "bounded journal keeps the last records");
  assert.deepEqual(JSON.parse(penultimate), { n: 11_999 });
  assert.deepEqual(JSON.parse(lastLine), { n: -1 });
});
