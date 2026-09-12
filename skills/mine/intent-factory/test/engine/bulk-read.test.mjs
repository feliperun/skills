import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { bulkRead, writeBulkReadPack } from "../../src/engine/bulk-read.mjs";
import { READ_LINE_LIMIT } from "../../src/harnesses/index.mjs";

// The replay harness stands in for the provider, so no test here spends a token.

const corpusLine = 'const padding = "the asking context never sees these bytes"; // 0123456789abcdef';

/**
 * Neuter the accounting pair for the duration of a test: an ambient
 * INTENT_FACTORY_RUN_DIR would write test delegations into a real run ledger.
 *
 * @returns {() => void} restore
 */
function clearDelegationEnv() {
  const saved = [process.env.INTENT_FACTORY_RUN_DIR, process.env.INTENT_FACTORY_NODE_ID];
  delete process.env.INTENT_FACTORY_RUN_DIR;
  delete process.env.INTENT_FACTORY_NODE_ID;
  return () => {
    if (saved[0] !== undefined) process.env.INTENT_FACTORY_RUN_DIR = saved[0];
    if (saved[1] !== undefined) process.env.INTENT_FACTORY_NODE_ID = saved[1];
  };
}

/**
 * @param {string} directory
 * @param {string} name
 * @param {number} lines
 * @returns {string}
 */
function writeCorpusFile(directory, name, lines) {
  const path = join(directory, name);
  writeFileSync(path, `${Array.from({ length: lines }, (_, index) => `${corpusLine} ${index + 1}`).join("\n")}\n`);
  return path;
}

/**
 * @param {string} result
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadInputTokens?: number}} [usage]
 * @param {number|null} [costUsd]
 */
function doneEnvelope(result, usage = {}, costUsd = null) {
  return {
    status: "done",
    result,
    continuationId: null,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cacheReadInputTokens: usage.cacheReadInputTokens ?? 0 },
    costUsd,
    error: null,
  };
}

/**
 * @param {string} directory
 * @param {string} name
 * @param {{envelope: Record<string, unknown>}[]} entries
 * @returns {string}
 */
function writeRecording(directory, name, entries) {
  const recording = join(directory, name);
  writeFileSync(recording, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return recording;
}

/** @param {string} recording @returns {{harness: string, model: string, config: Record<string, unknown>}} */
function replayRuntime(recording) {
  return { harness: "replay", model: "replay-bulk-model", config: { "replay.recording": recording } };
}

/** @param {string} recording @returns {Record<string, unknown>[]} */
function recordedInvocations(recording) {
  return readFileSync(`${recording}.invocations.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("bulk read structured output", async () => {
  const restore = clearDelegationEnv();
  const directory = mkdtempSync(join(tmpdir(), "bulk-read-structured-"));
  const bullets = "src/engine/bulk-read.mjs:1 — packs the corpus\nproviderCommand — builds the delegation";
  const recording = writeRecording(directory, "answer.jsonl", [
    { envelope: doneEnvelope(bullets, { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 1 }, 0.00021) },
  ]);
  const result = await bulkRead({
    question: "where does the corpus get packed?",
    paths: [writeCorpusFile(directory, "corpus.txt", READ_LINE_LIMIT + 100)],
    runtimes: { answering: replayRuntime(recording) },
  });
  assert.deepEqual(result, {
    status: "done",
    result: bullets,
    runtimeId: "answering",
    usage: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 1 },
    costUsd: 0.00021,
    reason: null,
    error: null,
  });
  restore();
});

test("bulk read context isolation", async () => {
  const restore = clearDelegationEnv();
  const directory = mkdtempSync(join(tmpdir(), "bulk-read-isolation-"));
  const corpus = writeCorpusFile(directory, "corpus.txt", 2_000);
  const corpusBytes = statSync(corpus).size;
  const recording = writeRecording(directory, "answer.jsonl", [{ envelope: doneEnvelope("bulk-read.mjs:1 — one bullet") }]);
  const result = await bulkRead({ question: "what does the corpus import?", paths: [corpus], runtimes: { answering: replayRuntime(recording) } });
  assert.equal(result.status, "done", result.error?.message);
  const invocations = recordedInvocations(recording);
  assert.equal(invocations.length, 1);
  const promptBytes = Number(invocations[0].promptBytes);
  assert.ok(promptBytes < corpusBytes / 10, `the prompt carried ${promptBytes} bytes for a ${corpusBytes}-byte corpus`);
  assert.ok(promptBytes < 4_096, "the prompt names the pack file; it never carries the corpus");
  assert.equal(result.result, "bulk-read.mjs:1 — one bullet");
  restore();
});

test("bulk read routing is table driven", async () => {
  const restore = clearDelegationEnv();
  const directory = mkdtempSync(join(tmpdir(), "bulk-read-routing-"));
  const recordings = {
    strong: writeRecording(directory, "strong.jsonl", [{ envelope: doneEnvelope("strong runtime answered") }]),
    mid: writeRecording(directory, "mid.jsonl", [{ envelope: doneEnvelope("mid runtime answered") }]),
    cheap: writeRecording(directory, "cheap.jsonl", [{ envelope: doneEnvelope("cheap runtime answered") }]),
  };
  // Declaration order opposes routing order: the tier-2 entry is declared first.
  const runtimes = {
    strong: { ...replayRuntime(recordings.strong), tier: 2, costRank: 2 },
    mid: { ...replayRuntime(recordings.mid), tier: 1, costRank: 2 },
    cheap: { ...replayRuntime(recordings.cheap), tier: 1, costRank: 1 },
  };
  const result = await bulkRead({ question: "q", paths: [writeCorpusFile(directory, "corpus.txt", READ_LINE_LIMIT + 1)], runtimes });
  assert.equal(result.runtimeId, "cheap", "routing follows tier then costRank, never declaration order or a model name");
  assert.equal(readFileSync(`${recordings.cheap}.cursor`, "utf8"), "1\n");
  assert.equal(existsSync(`${recordings.strong}.invocations.jsonl`), false, "the tier-2 runtime was never invoked");
  assert.equal(existsSync(`${recordings.mid}.invocations.jsonl`), false, "the costRank-2 runtime was never invoked");

  // A declared window that cannot hold the corpus removes the runtime from
  // the route; glm-5.3-flash declares a 200_000-token window, and this corpus
  // estimates well past it.
  const wideCorpus = join(directory, "wide.txt");
  writeFileSync(wideCorpus, `${"x".repeat(600)}\n`.repeat(READ_LINE_LIMIT + 500));
  const refused = await bulkRead({
    question: "q",
    paths: [wideCorpus],
    runtimes: { flash: { harness: "zcode", model: "glm-5.3-flash", vendor: "zhipu", tier: 1, costRank: 1 } },
  });
  assert.equal(refused.status, "refused");
  assert.match(refused.reason ?? "", /window/u);
  restore();
});

test("bulk read usage accounted", async () => {
  const restore = clearDelegationEnv();
  const runDir = mkdtempSync(join(tmpdir(), "bulk-read-ledger-"));
  const directory = mkdtempSync(join(tmpdir(), "bulk-read-accounted-"));
  const recording = writeRecording(directory, "answer.jsonl", [
    { envelope: doneEnvelope("bulk-read.mjs:1 — accounted", { inputTokens: 9, outputTokens: 4, cacheReadInputTokens: 2 }, 0.0005) },
    { envelope: doneEnvelope("bulk-read.mjs:1 — unaccounted") },
  ]);
  const corpus = writeCorpusFile(directory, "corpus.txt", READ_LINE_LIMIT + 1);
  const runtimes = { deleg: replayRuntime(recording) };
  process.env.INTENT_FACTORY_RUN_DIR = runDir;
  process.env.INTENT_FACTORY_NODE_ID = "delegating-node";
  const accounted = await bulkRead({ question: "q", paths: [corpus], runtimes });
  assert.equal(accounted.status, "done", accounted.error?.message);
  const records = readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].nodeId, "delegating-node");
  assert.equal(records[0].runId, basename(runDir));
  assert.equal(records[0].role, "worker");
  assert.equal(records[0].runtimeId, "deleg");
  assert.equal(records[0].model, "replay-bulk-model");
  assert.equal(records[0].inputTokens, 9);
  assert.equal(records[0].outputTokens, 4);
  assert.equal(records[0].cacheReadInputTokens, 2);
  assert.equal(records[0].costUsd, 0.0005);
  assert.equal(records[0].costProvenance, "provider");
  assert.ok(typeof records[0].invocationId === "string" && records[0].invocationId.length > 0);

  // A human terminal exports no pair: the same delegation runs, nothing is
  // appended, and nothing errors.
  delete process.env.INTENT_FACTORY_RUN_DIR;
  delete process.env.INTENT_FACTORY_NODE_ID;
  const unaccounted = await bulkRead({ question: "q", paths: [corpus], runtimes });
  assert.equal(unaccounted.status, "done", unaccounted.error?.message);
  assert.equal(readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").length, 1, "no second record without the env pair");
  restore();
});

test("bulk read byte fidelity", () => {
  const directory = mkdtempSync(join(tmpdir(), "bulk-read-fidelity-"));
  const crlfUtf8 = join(directory, "crlf-utf8.txt");
  const noTrailingNewline = join(directory, "no-newline.txt");
  const trailingNewline = join(directory, "newline.txt");
  writeFileSync(crlfUtf8, Buffer.from("alpha\r\nbeta café ✨\r\ngamma", "utf8"));
  writeFileSync(noTrailingNewline, Buffer.from("no final newline", "utf8"));
  writeFileSync(trailingNewline, Buffer.from("ends with one\n", "utf8"));
  const paths = [crlfUtf8, noTrailingNewline, trailingNewline];
  const packPath = join(directory, "corpus.pack");
  const pack = writeBulkReadPack(paths, packPath);
  const expected = Buffer.concat(paths.flatMap((path) => [
    Buffer.from(`<file path="${path}">`, "utf8"),
    readFileSync(path),
    Buffer.from("</file>", "utf8"),
  ]));
  assert.deepEqual(readFileSync(packPath), expected);
  assert.equal(pack.lines, 3, "two CRLF lines plus one LF line; headers and footers never add one");
  assert.equal(pack.bytes, expected.length);
  assert.equal(pack.files, 3);
});

test("bulk read refuses small files", async () => {
  const restore = clearDelegationEnv();
  const directory = mkdtempSync(join(tmpdir(), "bulk-read-small-"));
  const recording = writeRecording(directory, "answer.jsonl", [{ envelope: doneEnvelope("never delegated") }]);
  const result = await bulkRead({
    question: "q",
    paths: [
      writeCorpusFile(directory, "half-a.txt", 1_000),
      writeCorpusFile(directory, "half-b.txt", READ_LINE_LIMIT - 1_001),
    ],
    runtimes: { answering: replayRuntime(recording) },
  });
  assert.equal(result.status, "refused");
  assert.match(result.reason ?? "", new RegExp(String(READ_LINE_LIMIT), "u"));
  assert.match(result.reason ?? "", /directly/u);
  assert.equal(existsSync(`${recording}.invocations.jsonl`), false, "a refused delegation invokes no provider");

  // At exactly the floor the corpus is not below it: the delegation runs.
  const boundary = await bulkRead({
    question: "q",
    paths: [writeCorpusFile(directory, "boundary.txt", READ_LINE_LIMIT)],
    runtimes: { answering: replayRuntime(recording) },
  });
  assert.equal(boundary.status, "done", boundary.reason ?? boundary.error?.message);
  restore();
});
