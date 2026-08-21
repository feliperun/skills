#!/usr/bin/env node
/**
 * SessionStart hook — injects a fresh .claude/session-handoff.md into the new
 * session as additional context. Prints nothing when the file is missing,
 * empty, or stale (older than 48 hours), so a normal session start stays
 * silent.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HANDOFF = ".claude/session-handoff.md";
const FRESH_MS = 48 * 60 * 60 * 1000;

/**
 * @param {string} cwd
 * @param {number} now
 * @returns {string | null} stdout payload for the hook, or null to stay silent
 */
export function buildInjection(cwd, now) {
  const path = join(cwd, HANDOFF);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (now - stat.mtimeMs > FRESH_MS) return null;
  const content = readFileSync(path, "utf8");
  if (!content.trim()) return null;
  const injected = `${content.trim()}\n\n---\n\nSession handoff injected by the SessionStart hook. Verify state before trusting it; delete .claude/session-handoff.md once absorbed.\n`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: injected,
    },
  });
}

function main() {
  const payload = buildInjection(process.cwd(), Date.now());
  if (payload) process.stdout.write(payload);
}

main();
