import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../.claude/hooks/session-start.mjs", import.meta.url));

/**
 * @param {string} cwd
 */
function runHook(cwd) {
  const result = spawnSync(process.execPath, [HOOK], { cwd, encoding: "utf8" });
  return {
    status: /** @type {number | null} */ (result.status),
    stdout: /** @type {string} */ (result.stdout),
    stderr: /** @type {string} */ (result.stderr),
  };
}

/**
 * @param {string} cwd
 * @param {string} content
 */
function writeHandoff(cwd, content) {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "session-handoff.md"), content);
}

test("injects a fresh handoff as SessionStart additional context", () => {
  const cwd = mkdtempSync(join(tmpdir(), "session-start-fresh-"));
  writeHandoff(cwd, "# Session handoff\n\nSaved: just now\n\n## Pending\n1. continue work\n");
  const result = runHook(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /^# Session handoff/);
  assert.match(payload.hookSpecificOutput.additionalContext, /injected by the SessionStart hook/);
});

test("stays silent when the handoff is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "session-start-missing-"));
  const result = runHook(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("stays silent when the handoff is empty", () => {
  const cwd = mkdtempSync(join(tmpdir(), "session-start-empty-"));
  writeHandoff(cwd, "\n");
  const result = runHook(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("stays silent when the handoff is stale (older than 48 hours)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "session-start-stale-"));
  writeHandoff(cwd, "# Session handoff\n\nold\n");
  const stale = Date.now() / 1000 - 49 * 60 * 60;
  utimesSync(join(cwd, ".claude", "session-handoff.md"), stale, stale);
  const result = runHook(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
