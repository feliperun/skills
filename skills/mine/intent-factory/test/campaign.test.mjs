import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendJournal,
  campaignDir,
  closeCampaign,
  discoverCampaigns,
  HANDOFF_BYTES,
  HANDOFF_LIMIT,
  JOURNAL_TEXT_BYTES,
  initializeCampaign,
  PROJECTION_FILE,
  readJournal,
  registerRun,
  renderHandoff,
  resolveCampaign,
  validateJournalEntry,
} from "../scripts/campaign.mjs";
import { appendJsonl } from "../scripts/store.mjs";
import { validateContract } from "../scripts/contract.mjs";
import { runContract } from "../scripts/runner.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "./helpers.mjs";

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
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
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
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    runner, "campaign", "note", "cli-invalid", "--cwd", directory,
    "--session-id", "codex-1", "--kind", "bogus", "--text", "bad",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--kind must be/u);
});

test("campaign CLI lists, closes, and resolves questions", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-lifecycle-"));
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
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
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
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
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
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
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
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

test("campaign CLI supervise parses --interval as a positive number of seconds", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-cli-interval-"));
  const runsDir = join(directory, ".runs");
  initializeCampaign(runsDir, { campaignId: "interval", goal: "Prove the public interval unit" });
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  for (const interval of ["0", "abc"]) {
    const result = spawnSync(process.execPath, [runner, "campaign", "supervise", "interval", "--cwd", directory, "--interval", interval], { encoding: "utf8" });
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
