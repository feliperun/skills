/**
 * Recording and envelope builders shared by the replay tests, split out when
 * `replay.test.mjs` was cut into the adapter half and the whole-run half.
 */
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
export function envelope(overrides = {}) {
  return {
    status: "done",
    result: "ok",
    continuationId: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
    costUsd: null,
    error: null,
    ...overrides,
  };
}

/** @param {string} summary @returns {Record<string, unknown>} */
export function workerResult(summary) {
  return { status: "done", summary, changedFiles: [], verification: [], artifacts: [], missingContext: [] };
}

/** @param {string} directory @param {unknown[]} lines @param {string} [name] @returns {string} */
export function writeRecording(directory, lines, name = "recording.jsonl") {
  const path = join(directory, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/**
 * The runner spawns the replay executable directly (never through
 * process.execPath), so replay/bin.mjs must stay executable in git
 * (mode 0o755) for every replay test below to run.
 */
export const REPLAY_BIN = fileURLToPath(new URL("../../src/harnesses/replay/bin.mjs", import.meta.url));

/**
 * @returns {void}
 */
export function assertExecutable() {
  assert.ok(existsSync(REPLAY_BIN), "replay/bin.mjs must exist");
  assert.notEqual(statSync(REPLAY_BIN).mode & 0o111, 0, "replay/bin.mjs must be executable (mode 0o755)");
}
