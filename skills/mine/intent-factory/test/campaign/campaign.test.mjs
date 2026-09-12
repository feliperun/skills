import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeCampaign,
  discoverCampaigns,
  initializeCampaign,
  registerRun,
  renderHandoff,
  resolveCampaign,
} from "../../src/campaign/index.mjs";
import { appendJournal, readJournal, validateJournalEntry } from "../../src/campaign/journal.mjs";
import { HANDOFF_BYTES, HANDOFF_FILE, JOURNAL_FILE, JOURNAL_TEXT_BYTES, PROJECTION_FILE } from "../../src/campaign/layout.mjs";

// Campaign lifecycle: init, discover, resolve, journal append, close.
// Projection and handoff rendering are in projection.test.mjs.

test("semantic budget keeps critical sections and evicts oldest low-priority history above 16 KiB", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-budget-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "budget", goal: "Ship the durable handoff" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId, decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId, text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId, questionId: "q1", text: "Is the handoff bounded?" });

  mkdirSync(join(runsDir, "attention-run", "nodes"), { recursive: true });
  writeFileSync(join(runsDir, "attention-run", "nodes", "a.json"), JSON.stringify({ id: "a", status: "failed", error: { message: "boom" } }));
  writeFileSync(join(runsDir, "attention-run", "nodes", "b.json"), JSON.stringify({ id: "b", status: "done" }));
  registerRun(created.path, "attention-run");

  for (let index = 0; index < 4; index += 1) {
    appendJournal(created.path, { type: "intent", eventId: `i-${index}`, at, sessionId, text: `intent-${String(index).padStart(3, "0")} ${"B".repeat(2040)}` });
  }
  for (let index = 0; index < 10; index += 1) {
    appendJournal(created.path, { type: "outcome", eventId: `o-${index}`, at, sessionId, text: `outcome-${String(index).padStart(3, "0")} ${"A".repeat(2040)}` });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /Ship the durable handoff/u);
  assert.match(handoff, /Render the next handoff/u);
  assert.match(handoff, /\[d1\] Use semantic budgeting/u);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /Is the handoff bounded\?/u);
  assert.match(handoff, /codex codex-1/u);
  assert.match(handoff, /attention-run: 2 nodes · 1 failed · 1 done/u);
  assert.match(handoff, /a: failed · boom/u);
  assert.doesNotMatch(handoff, /outcome-000 /u);
  assert.match(handoff, /outcome-009 /u);
  assert.match(handoff, /earlier attempts and outcomes omitted/u);
});

test("many linked runs cannot starve critical handoff sections", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-run-flood-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "runflood", goal: "Ship the durable handoff" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId, decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId, text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId, questionId: "q1", text: "Is the handoff bounded?" });
  for (let index = 0; index < 600; index += 1) {
    const runId = `run-${String(index).padStart(3, "0")}`;
    mkdirSync(join(runsDir, runId, "nodes"), { recursive: true });
    writeFileSync(join(runsDir, runId, "nodes", "node.json"), JSON.stringify({ id: "node", status: "done" }));
    registerRun(created.path, runId);
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /Ship the durable handoff/u);
  assert.match(handoff, /## Latest next action/u);
  // Stamped with session and timestamp so a superseded next action is visibly stale.
  assert.match(handoff, /- Render the next handoff[^\n]* · [^\n]+ · \d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
  assert.match(handoff, /## Session lineage/u);
  assert.match(handoff, /codex codex-1/u);
  assert.match(handoff, /## Active decisions/u);
  assert.match(handoff, /\[d1\] Use semantic budgeting/u);
  assert.match(handoff, /## User constraints/u);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /## Open questions/u);
  assert.match(handoff, /Is the handoff bounded\?/u);
  assert.match(handoff, /run-599: 1 nodes · 1 done/u);
  assert.doesNotMatch(handoff, /run-000:/u);
  assert.match(handoff, /earlier run summaries omitted/u);
});

test("attention-needed run states survive budget pressure with an omission note", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-attention-flood-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "attention", goal: "Preserve attention states" });
  registerRun(created.path, "flood-run");
  mkdirSync(join(runsDir, "flood-run", "nodes"), { recursive: true });
  for (let index = 0; index < 400; index += 1) {
    writeFileSync(
      join(runsDir, "flood-run", "nodes", `node-${String(index).padStart(3, "0")}.json`),
      JSON.stringify({ id: `node-${String(index).padStart(3, "0")}`, status: "failed", error: { message: "N".repeat(200) } }),
    );
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /- flood-run: 400 nodes · 400 failed/u);
  assert.match(handoff, /node-399: failed/u);
  assert.doesNotMatch(handoff, /node-000: failed/u);
  assert.match(handoff, /earlier attention-needed run states omitted/u);
});

test("active decisions and unresolved questions beyond twenty are preserved when they fit", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-beyond-cap-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "beyond", goal: "Prove no silent truncation" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  for (let index = 0; index < 30; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId,
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(2, "0")}`,
    });
    appendJournal(created.path, {
      type: "open-question", eventId: `q-${index}`, at, sessionId,
      questionId: `q-${index}`, text: `question-${String(index).padStart(2, "0")}`,
    });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /\[d-0\] decision-00/u);
  assert.match(handoff, /\[d-29\] decision-29/u);
  assert.match(handoff, /question-00/u);
  assert.match(handoff, /question-29/u);
  assert.doesNotMatch(handoff, /earlier active decisions omitted/u);
  assert.doesNotMatch(handoff, /earlier open questions omitted/u);
});

test("decisions evicted by the projection cap still produce an omission summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-evicted-decisions-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "evicted", goal: "Prove eviction summary" });
  const at = new Date().toISOString();
  for (let index = 0; index < 120; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId: "codex-1",
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(3, "0")}`,
    });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /\[d-119\] decision-119/u);
  assert.doesNotMatch(handoff, /\[d-19\] decision-019/u);
  assert.match(handoff, /- 20 earlier active decisions omitted/u);
});

test("a critical section larger than the whole budget keeps its latest entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-critical-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "critical", goal: "Ship the durable handoff" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  // 20 active decisions at ~2 KiB each: the section alone exceeds the 16 KiB budget.
  for (let index = 0; index < 20; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId,
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(3, "0")} ${"C".repeat(2040)}`,
    });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /## Active decisions/u);
  assert.match(handoff, /Render the next handoff/u);
  assert.match(handoff, /\[d-19\] decision-019/u);
  assert.doesNotMatch(handoff, /\[d-0\] decision-000/u);
  assert.match(handoff, /earlier active decisions omitted/u);
});

test("fitHandoff shrinks entry text until every critical entry survives", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-shrink-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "shrink", goal: "Preserve every critical entry" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  // 20 large active decisions exhaust the budget for later critical sections.
  for (let index = 0; index < 20; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId,
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(3, "0")} ${"C".repeat(2040)}`,
    });
  }
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId, text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId, questionId: "q1", text: "Is the handoff bounded?" });

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /Is the handoff bounded\?/u);
  assert.doesNotMatch(handoff, /none fits the remaining budget/u);
});

test("oldest low-priority history is evicted first with a bounded omission summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-evict-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "evict", goal: "Prove eviction" });
  const at = new Date().toISOString();
  for (let index = 0; index < 25; index += 1) {
    appendJournal(created.path, {
      type: "outcome", eventId: `out-${index}`, at, sessionId: "codex-1",
      text: `outcome-${String(index).padStart(3, "0")} ${"A".repeat(2040)}`,
    });
  }
  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.doesNotMatch(handoff, /outcome-000 /u);
  assert.match(handoff, /outcome-024 /u);
  assert.match(handoff, /earlier attempts and outcomes omitted/u);
});

test("resolved questions leave the active handoff projection", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-question-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "questions", goal: "Prove resolution" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId: "codex-1", questionId: "q1", text: "What is the budget?" });
  appendJournal(created.path, { type: "open-question", eventId: "q2", at, sessionId: "codex-1", questionId: "q2", text: "Who owns discovery?" });
  appendJournal(created.path, { type: "question.resolved", eventId: "r1", at, sessionId: "codex-1", questionId: "q1", text: "16 KiB, semantically" });
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /Who owns discovery\?/u);
  assert.doesNotMatch(handoff, /What is the budget\?/u);
  assert.doesNotMatch(handoff, /16 KiB, semantically/u);
});

test("campaigns close and implicit discovery considers only active campaigns", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-close-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "alpha", goal: "First" });
  const beta = initializeCampaign(runsDir, { campaignId: "beta", goal: "Second" });
  assert.throws(() => closeCampaign(beta.path), /no recorded retrospective/u);
  appendJournal(beta.path, {
    type: "retrospective",
    eventId: "beta-retro",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Retrospective: shipped Second; no follow-ups.",
  });
  const closed = closeCampaign(beta.path);
  assert.equal(closed.campaign.status, "closed");
  assert.equal(resolveCampaign(runsDir).campaign.id, "alpha");
  assert.throws(() => closeCampaign(beta.path), /already closed/u);
  assert.throws(() => registerRun(beta.path, "late-run"), /closed/u);
  const { campaigns } = discoverCampaigns(runsDir);
  const betaEntry = campaigns.find((entry) => entry.campaign.id === "beta");
  assert.ok(betaEntry, "beta campaign discovered");
  assert.equal(betaEntry.campaign.status, "closed");
  const journal = readJournal(beta.path);
  const last = journal.at(-1);
  assert.ok(last, "journal has a closing entry");
  assert.equal(last.type, "campaign.closed");
});

test("corrupt campaign entries are surfaced instead of silently dropped", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-corrupt-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "good", goal: "Healthy" });
  mkdirSync(join(runsDir, "campaigns", "bad"), { recursive: true });
  writeFileSync(join(runsDir, "campaigns", "bad", "campaign.json"), "{ not json");
  mkdirSync(join(runsDir, "campaigns", "nocamp"), { recursive: true });
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  assert.equal(campaigns.length, 1);
  assert.deepEqual(corrupt.map((entry) => entry.id).sort(), ["bad", "nocamp"]);
  assert.throws(() => resolveCampaign(runsDir), /corrupt campaign entries: bad, nocamp/u);
});

test("journal appends are idempotent by event id", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-dedupe-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "dedupe", goal: "Prove idempotency" });
  const at = new Date().toISOString();
  const first = appendJournal(created.path, { type: "intent", eventId: "intent-retry", at, sessionId: "codex-1", text: "Material intent" });
  const second = appendJournal(created.path, { type: "intent", eventId: "intent-retry", at, sessionId: "codex-1", text: "Material intent" });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  const journal = readJournal(created.path);
  assert.equal(journal.filter((entry) => entry.type === "intent").length, 1);
  const handoff = renderHandoff(created.path, runsDir);
  assert.equal(handoff.match(/Material intent/gu)?.length ?? 0, 1);
});

test("liveness journal entries validate, dedupe by event id and stay out of the projection and handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-liveness-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "amb", goal: "Prove ambient facts stay out of the handoff" });
  const at = new Date().toISOString();
  const fact = {
    type: "liveness",
    eventId: "live-1",
    at,
    campaignId: "amb",
    runId: "run-1",
    nodeId: "node-1",
    phase: "P2",
    checkpointsDone: 3,
    checkpointsTotal: 7,
    runtime: "codex",
    state: "running",
    lastProgressAt: at,
    attention: null,
  };
  assert.doesNotThrow(() => validateJournalEntry(fact));
  const first = appendJournal(created.path, fact);
  const second = appendJournal(created.path, { ...fact, eventId: "live-1" });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  const journal = readJournal(created.path);
  assert.equal(journal.filter((entry) => entry.type === "liveness").length, 1);
  assert.throws(
    () => appendJournal(created.path, { ...fact, eventId: "live-2", extra: "not allowed" }),
    (error) => error instanceof TypeError && /unexpected field extra/u.test(error.message),
  );
  appendJournal(created.path, { type: "intent", eventId: "i-1", at, sessionId: "codex-1", text: "Continue after liveness" });
  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(existsSync(join(created.path, PROJECTION_FILE)));
  const projection = JSON.parse(readFileSync(join(created.path, PROJECTION_FILE), "utf8"));
  assert.doesNotMatch(JSON.stringify(projection.projection), /live-1|node-1/u);
  assert.match(handoff, /Continue after liveness/u);
  assert.doesNotMatch(handoff, /live-1|node-1/u);
  const handoffFile = readFileSync(join(created.path, HANDOFF_FILE), "utf8");
  assert.doesNotMatch(handoffFile, /live-1|node-1/u);
});

test("readJournal ignores the pre-diet weightedUsed and weightedCap fields on a historical liveness fact", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-legacy-liveness-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "legacy", goal: "Keep an old journal readable" });
  const at = new Date().toISOString();
  const legacyLine = JSON.stringify({
    type: "liveness",
    eventId: "live-legacy-1",
    at,
    campaignId: "legacy",
    runId: "run-1",
    nodeId: "scope-advisory",
    phase: "worker",
    checkpointsDone: 0,
    checkpointsTotal: 3,
    runtime: "sonnet",
    state: "running",
    weightedUsed: 0,
    weightedCap: 6_000_000,
    lastProgressAt: at,
    attention: null,
  });
  appendFileSync(join(created.path, JOURNAL_FILE), `${legacyLine}\n`);
  const journal = readJournal(created.path);
  const entry = journal.find((item) => item.eventId === "live-legacy-1");
  assert.ok(entry, "the legacy liveness line is read, not rejected");
  assert.equal(/** @type {Record<string, unknown>} */ (entry).weightedUsed, undefined, "the legacy field is dropped, not carried forward");
});

test("handoff projection recovers from deletion and corruption", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-projection-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "proj", goal: "Prove recovery" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId: "codex-1", decisionId: "d1", text: "Keep the journal" });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId: "codex-1", text: "Recover the projection" });
  const first = renderHandoff(created.path, runsDir);
  assert.ok(existsSync(join(created.path, PROJECTION_FILE)));
  assert.match(first, /Keep the journal/u);
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "Append-only" });
  const second = renderHandoff(created.path, runsDir);
  assert.match(second, /Append-only/u);
  unlinkSync(join(created.path, PROJECTION_FILE));
  assert.equal(renderHandoff(created.path, runsDir), second);
  writeFileSync(join(created.path, PROJECTION_FILE), "{ not json");
  assert.equal(renderHandoff(created.path, runsDir), second);
});

test("journal text is normalized and bounded so entries cannot inject headings", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-normalize-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "normalize", goal: "Prove normalization" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "intent", eventId: "i1", at, sessionId: "codex-1", text: "## Fake heading\nline two" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "X".repeat(10000) });
  const journal = readJournal(created.path);
  const constraint = journal.find((entry) => entry.type === "constraint");
  assert.ok(constraint, "constraint entry present");
  assert.ok(constraint.text !== undefined, "constraint entry has text");
  assert.ok(Buffer.byteLength(constraint.text, "utf8") <= JOURNAL_TEXT_BYTES);
  const handoff = renderHandoff(created.path, runsDir);
  assert.doesNotMatch(handoff, /^## Fake/mu);
  assert.match(handoff, /Fake heading line two/u);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
});

test("attention-needed linked-run states survive when critical sections exhaust the budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-attention-critical-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "attentioncritical", goal: "G".repeat(4000) });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "t.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  for (let index = 0; index < 100; index += 1) {
    appendJournal(created.path, { type: "decision", eventId: `d-${index}`, at, sessionId, decisionId: `d-${index}`, text: `decision-${index} ${"C".repeat(2040)}` });
    appendJournal(created.path, { type: "open-question", eventId: `q-${index}`, at, sessionId, questionId: `q-${index}`, text: `question-${index} ${"D".repeat(2040)}` });
  }
  for (let index = 0; index < 60; index += 1) {
    appendJournal(created.path, { type: "constraint", eventId: `c-${index}`, at, sessionId, text: `constraint-${index} ${"E".repeat(2040)}` });
  }
  mkdirSync(join(runsDir, "attention-run", "nodes"), { recursive: true });
  writeFileSync(join(runsDir, "attention-run", "nodes", "a.json"), JSON.stringify({ id: "a", status: "failed", error: { message: "boom" } }));
  registerRun(created.path, "attention-run");

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /## Linked runs/u);
  assert.match(handoff, /attention-run: 1 nodes · 1 failed/u);
  assert.match(handoff, /a: failed · boom/u);
  assert.doesNotMatch(handoff, /none fits the remaining budget/u);
});

test("large valid identifiers cannot starve later critical sections", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-large-ids-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "largeids", goal: "Ship" });
  const at = new Date().toISOString();
  const big = "Y".repeat(20000);
  for (let index = 0; index < 60; index += 1) {
    appendJournal(created.path, {
      type: "session.attached", eventId: `s-${index}`, at, sessionId: `${big}-${index}`, tool: "codex",
      transcript: join(directory, "t.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
    });
  }
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId: "codex-1", text: "Render the next handoff" });
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId: "codex-1", decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId: "codex-1", questionId: "q1", text: "Is the handoff bounded?" });

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /## Latest next action/u);
  assert.match(handoff, /Render the next handoff/u);
  assert.match(handoff, /## Session lineage/u);
  assert.match(handoff, /## Active decisions/u);
  assert.match(handoff, /Use semantic budgeting/u);
  assert.match(handoff, /## User constraints/u);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /## Open questions/u);
  assert.doesNotMatch(handoff, /none fits the remaining budget/u);
});
