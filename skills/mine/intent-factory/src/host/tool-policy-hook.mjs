#!/usr/bin/env node
/**
 * Repository-owned enforcement hook for the mechanical worker tool policy at
 * the Claude-compatible CLI boundary (RETROSPECTIVE-2026-08-28 P0.7/P1.1).
 * The runner registers one command for both events through `--settings`:
 *
 * - PreToolUse denies, in order: a `Bash` invocation with `run_in_background:
 *   true` and the background-output tools; a `Write`/`Edit`/`NotebookEdit`
 *   outside the declared write scope; a whole-file `Read`, or the same read
 *   done through `Bash` (`cat`/`less`/`more`, or `head`/`tail` with no
 *   explicit limit), above `--max-read-lines`. Every denial reason tells the
 *   model how to retry. The write-scope and read-threshold judgment calls
 *   live in `tool-policy-decisions.mjs`; this module is the argv wiring and
 *   event dispatch, not the decisions themselves.
 * - PostToolUse bounds the textual evidence of a Bash result to at most
 *   `--max-tool-output-bytes` UTF-8 bytes, keeping head and tail; small
 *   results are emitted unchanged (no output at all leaves them untouched).
 *
 * A write made through `Bash` is not intercepted here: sniffing shell syntax
 * for a write is a race no static read of `command` wins, and the post-hoc
 * scope gate in `engine/scope.mjs` already catches the effect once the
 * attempt completes.
 *
 * The settings that wire this hook are installed inline via `--settings` on
 * every provider invocation; nothing is written to the worktree, so there is
 * no file to remove when the attempt is sealed.
 *
 * Every decision is pure and exported so the settings wiring and the hook
 * behavior stay testable without a live provider.
 */
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { TOOL_OUTPUT_LIMIT_BYTES, truncateToolOutput } from "../harnesses/exec-jsonl/index.mjs";
import { bashReadDecision, readThresholdDecision, writeScopeDecision } from "./tool-policy-decisions.mjs";

/** Absolute path of this hook, embedded in generated settings. */
export const HOOK_PATH = fileURLToPath(import.meta.url);

/** Tools whose only purpose is to observe a background invocation. */
const BACKGROUND_OUTPUT_TOOLS = ["TaskOutput", "BashOutput", "Monitor"];

/** PreToolUse matcher covering every tool the policy may deny. */
export const PRE_TOOL_MATCHER = ["Bash", ...BACKGROUND_OUTPUT_TOOLS, "Write", "Edit", "NotebookEdit", "Read"].join("|");

/** Standard foreground-only denial; it tells the model how to retry. */
export const FOREGROUND_ONLY_DENIAL = "background tool invocation denied by the foreground-only tool policy; rerun the tool in the foreground and wait for it to finish";

/** The policy shape as parsed off argv: `workspace` is null when the flag was omitted, unlike the always-populated {@link import("../harnesses/index.mjs").ToolPolicy} the engine builds.
 * @typedef {{foregroundOnly: boolean, maxToolOutputBytes: number, workspace: string|null, writeFiles: string[], writeRoots: string[], maxReadLines: number|null}} ParsedPolicy
 */

/**
 * @param {string[]} argv
 * @returns {ParsedPolicy}
 */
function parsePolicy(argv) {
  const flags = parseArgs({ args: argv, options: {
    "foreground-only": { type: "boolean", default: false },
    "max-tool-output-bytes": { type: "string" },
    "workspace": { type: "string" },
    "write-file": { type: "string", multiple: true, default: [] },
    "write-root": { type: "string", multiple: true, default: [] },
    "max-read-lines": { type: "string" },
  } });
  const raw = Number(flags.values["max-tool-output-bytes"]);
  const rawMaxReadLines = Number(flags.values["max-read-lines"]);
  return {
    foregroundOnly: Boolean(flags.values["foreground-only"]),
    maxToolOutputBytes: Number.isInteger(raw) && raw > 0 ? raw : TOOL_OUTPUT_LIMIT_BYTES,
    workspace: typeof flags.values.workspace === "string" ? flags.values.workspace : null,
    writeFiles: /** @type {string[]} */ (flags.values["write-file"] ?? []),
    writeRoots: /** @type {string[]} */ (flags.values["write-root"] ?? []),
    maxReadLines: flags.values["max-read-lines"] === undefined
      ? null
      : (Number.isInteger(rawMaxReadLines) && rawMaxReadLines > 0 ? rawMaxReadLines : null),
  };
}

/**
 * The hook command string registered in generated settings, carrying the
 * policy it enforces as explicit arguments.
 *
 * @param {import("../harnesses/index.mjs").ToolPolicy} policy
 * @returns {string}
 */
export function hookCommand(policy) {
  const argv = [process.execPath, HOOK_PATH];
  if (policy.foregroundOnly) argv.push("--foreground-only");
  if (typeof policy.maxToolOutputBytes === "number" && policy.maxToolOutputBytes > 0) {
    argv.push("--max-tool-output-bytes", String(policy.maxToolOutputBytes));
  }
  if (typeof policy.workspace === "string" && policy.workspace) argv.push("--workspace", policy.workspace);
  for (const file of policy.writeFiles ?? []) argv.push("--write-file", file);
  for (const root of policy.writeRoots ?? []) argv.push("--write-root", root);
  if (typeof policy.maxReadLines === "number" && policy.maxReadLines > 0) {
    argv.push("--max-read-lines", String(policy.maxReadLines));
  }
  return argv.map(shellQuote).join(" ");
}

/**
 * The Claude-compatible `--settings` payload wiring this hook for the policy:
 * PreToolUse denial where foreground-only applies, PostToolUse bounding where
 * a byte limit applies.
 *
 * @param {import("../harnesses/index.mjs").ToolPolicy} policy
 * @returns {{hooks: Record<string, {matcher: string, hooks: {type: "command", command: string}[]}[]>}}
 */
export function hookSettings(policy) {
  /** @type {Record<string, {matcher: string, hooks: {type: "command", command: string}[]}[]>} */
  const hooks = {};
  const hasWriteScope = Boolean((policy.writeFiles ?? []).length || (policy.writeRoots ?? []).length);
  const hasReadThreshold = typeof policy.maxReadLines === "number" && policy.maxReadLines > 0;
  if (policy.foregroundOnly || hasWriteScope || hasReadThreshold) {
    hooks.PreToolUse = [{ matcher: PRE_TOOL_MATCHER, hooks: [hookEntry(policy)] }];
  }
  if (typeof policy.maxToolOutputBytes === "number" && policy.maxToolOutputBytes > 0) {
    hooks.PostToolUse = [{ matcher: "Bash", hooks: [hookEntry(policy)] }];
  }
  return { hooks };
}

/**
 * The mechanical PreToolUse decision: the standard denial when the policy
 * forbids what the invocation asks for, null when it may run.
 *
 * @param {{foregroundOnly: boolean}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: string}}|null}
 */
function preToolUseDecision(policy, payload) {
  if (policy.foregroundOnly !== true) return null;
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  const input = payload?.tool_input;
  const backgroundBash = name === "Bash"
    && Boolean(input) && typeof input === "object"
    && /** @type {Record<string, unknown>} */ (input).run_in_background === true;
  if (!backgroundBash && !BACKGROUND_OUTPUT_TOOLS.includes(name)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: FOREGROUND_ONLY_DENIAL,
    },
  };
}

/**
 * Bound the textual evidence of one tool response without changing its shape:
 * a string stays a string, an object keeps every key, and the retained text
 * totals at most `maxBytes` UTF-8 bytes. Null means nothing needed bounding.
 *
 * @param {number} maxBytes
 * @param {unknown} toolResponse
 * @returns {string|Record<string, unknown>|null}
 */
function boundedToolOutput(maxBytes, toolResponse) {
  if (typeof toolResponse === "string") {
    const bounded = truncateToolOutput(toolResponse, maxBytes);
    return bounded === toolResponse ? null : bounded;
  }
  if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) return null;
  const record = /** @type {Record<string, unknown>} */ (toolResponse);
  const fields = Object.keys(record).filter((key) => typeof record[key] === "string");
  const sizes = fields.map((key) => Buffer.byteLength(/** @type {string} */ (record[key]), "utf8"));
  if (sizes.reduce((sum, size) => sum + size, 0) <= maxBytes) return null;
  const budgets = allocateTextBudgets(sizes, maxBytes);
  const updated = { ...record };
  fields.forEach((key, index) => {
    updated[key] = truncateToolOutput(/** @type {string} */ (record[key]), budgets[index]);
  });
  return updated;
}

/**
 * Deterministic budget split across textual fields: proportional shares, with
 * surplus from fields that fit flowing to the fields that do not.
 *
 * @param {number[]} sizes
 * @param {number} maxBytes
 * @returns {number[]}
 */
function allocateTextBudgets(sizes, maxBytes) {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const budgets = sizes.map((size) => Math.floor((size * maxBytes) / total));
  let surplus = maxBytes - budgets.reduce((sum, budget) => sum + budget, 0);
  for (let index = 0; index < sizes.length; index += 1) {
    if (budgets[index] < sizes[index]) continue;
    surplus += budgets[index] - sizes[index];
    budgets[index] = sizes[index];
  }
  for (let index = 0; index < sizes.length && surplus > 0; index += 1) {
    const room = sizes[index] - budgets[index];
    if (room <= 0) continue;
    budgets[index] += Math.min(room, surplus);
    surplus -= Math.min(room, surplus);
  }
  return budgets;
}

/**
 * One hook decision for one parsed payload, or null when the tool result must
 * pass through untouched. The order among the PreToolUse decisions only
 * matters for the reason the model reads; foregroundOnly stays first because
 * it was the first policy this hook enforced.
 *
 * @param {ParsedPolicy} policy
 * @param {unknown} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
function hookDecision(policy, payload) {
  if (!payload || typeof payload !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  const event = typeof record.hook_event_name === "string"
    ? record.hook_event_name
    : record.tool_response === undefined ? "PreToolUse" : "PostToolUse";
  if (event === "PreToolUse") {
    return preToolUseDecision(policy, record)
      ?? writeScopeDecision(policy, record)
      ?? readThresholdDecision(policy, record)
      ?? bashReadDecision(policy, record);
  }
  if (event === "PostToolUse") {
    if (typeof record.tool_name === "string" && record.tool_name !== "Bash") return null;
    const bounded = boundedToolOutput(policy.maxToolOutputBytes, record.tool_response);
    return bounded === null ? null : { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: bounded } };
  }
  return null;
}

/**
 * @param {import("../harnesses/index.mjs").ToolPolicy} policy
 * @returns {{type: "command", command: string}}
 */
function hookEntry(policy) {
  return { type: "command", command: hookCommand(policy) };
}

/** @param {string} value @returns {string} */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** @returns {boolean} */
function invokedAsScript() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === HOOK_PATH;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  const policy = parsePolicy(process.argv.slice(2));
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    // An unparsable payload must never break the provider: decide nothing.
    let payload = null;
    try {
      payload = JSON.parse(input);
    } catch {
      // SyntaxError on malformed input leaves payload null; hookDecision then decides nothing, as above.
    }
    const decision = hookDecision(policy, payload);
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  });
}
