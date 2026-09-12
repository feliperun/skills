/**
 * The three PreToolUse decisions the tool policy hook carries but does not
 * yet apply: a write outside the declared scope, a whole-file read above the
 * line threshold, and the same read done through `Bash` (`cat`/`less`/`more`,
 * or `head`/`tail` with no explicit limit). Kept out of tool-policy-hook.mjs
 * so that module stays the wiring (argv, settings, event dispatch) and this
 * one stays the judgment calls, each a pure function of policy and payload.
 *
 * The two read decisions only deny what they can measure: a file that is
 * missing, unreadable, or not a regular file passes through, because the hook
 * must never be the reason a model cannot see the tool's own error. The write
 * decision is different in kind -- scope membership is a fact about the path,
 * not about the disk -- so it judges a target that does not exist yet exactly
 * like one that does. Creating a new file outside the declared scope is the
 * ordinary violation, and skipping it would leave the decision firing only on
 * overwrites.
 *
 * A write made through `Bash` (`>`, `sed -i`, `tee`) is deliberately not
 * caught here: sniffing shell syntax for a write is a race no static read of
 * `command` wins, and the post-hoc scope gate in `engine/scope.mjs` already
 * catches the effect once the attempt completes.
 */
import { basename, isAbsolute, relative, resolve } from "node:path";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Tool name to the payload field carrying the path it would write. */
const WRITE_SCOPE_FIELDS = { Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path" };

/** Bash commands that read a whole file by default. */
const WHOLE_FILE_READERS = new Set(["cat", "less", "more"]);

/** Bash commands that read a whole file only when given no explicit limit. */
const BOUNDED_BY_DEFAULT_READERS = new Set(["head", "tail"]);

/** A command containing any of these is a pipeline, redirection or chain: the named file is a filter's input, not read-tool evidence. */
const SHELL_COMPOSITION_TOKENS = ["|", ">>", ">", "<", "&&", "||", ";"];

/**
 * DECISION 1: deny a `Write`, `Edit`, or `NotebookEdit` call whose target path
 * is neither a declared write file nor beneath a declared write root. An empty
 * scope (no writeFiles and no writeRoots) is the absence of a declared scope,
 * not a closed one, and denies nothing. Existence is not consulted: a path is
 * in the declared scope or it is not, and a file the attempt is about to
 * create is exactly the case worth catching before it exists.
 *
 * @param {{workspace: string|null, writeFiles: string[], writeRoots: string[]}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
export function writeScopeDecision(policy, payload) {
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  const field = /** @type {Record<string, string>} */ (WRITE_SCOPE_FIELDS)[name];
  if (!field) return null;
  const writeFiles = policy.writeFiles ?? [];
  const writeRoots = policy.writeRoots ?? [];
  if (!writeFiles.length && !writeRoots.length) return null;
  const workspace = typeof policy.workspace === "string" ? policy.workspace : "";
  if (!workspace) return null;
  const input = payload?.tool_input;
  const rawPath = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input)[field] : undefined;
  if (typeof rawPath !== "string" || !rawPath) return null;
  const rel = workspaceRelativePath(workspace, rawPath);
  if (rel !== null && (writeFiles.includes(rel) || writeRoots.some((root) => rel === root || rel.startsWith(`${root}/`)))) {
    return null;
  }
  return denyPreTool(writeScopeDenialReason(writeFiles, writeRoots));
}

/**
 * @param {string[]} writeFiles
 * @param {string[]} writeRoots
 * @returns {string}
 */
function writeScopeDenialReason(writeFiles, writeRoots) {
  const declared = [...writeFiles, ...writeRoots.map((root) => `${root}/`)];
  const shown = declared.slice(0, 12);
  const omitted = declared.length - shown.length;
  const remainder = omitted > 0 ? ` (and ${omitted} more not shown)` : "";
  return `write denied: this path is outside the declared write scope. Declared write paths: ${shown.join(", ")}${remainder}. Write only to one of those.`;
}

/**
 * DECISION 2: deny a `Read` call that would read an entire file above
 * `policy.maxReadLines` with neither `offset` nor `limit`. A file that cannot
 * be measured -- missing, unreadable, not a regular file -- passes through.
 *
 * @param {{maxReadLines: number|null}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
export function readThresholdDecision(policy, payload) {
  if (typeof payload?.tool_name !== "string" || payload.tool_name !== "Read") return null;
  const maxReadLines = policy.maxReadLines;
  if (typeof maxReadLines !== "number" || maxReadLines <= 0) return null;
  const input = payload?.tool_input;
  if (!input || typeof input !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (input);
  if (record.offset !== undefined || record.limit !== undefined) return null;
  const rawPath = record.file_path;
  if (typeof rawPath !== "string" || !rawPath) return null;
  const lines = countLines(rawPath);
  if (lines === null || lines <= maxReadLines) return null;
  return denyPreTool(readThresholdDenialReason(lines, maxReadLines));
}

/**
 * DECISION 3: deny the same whole-file read done through `Bash` -- a single
 * `cat`/`less`/`more` invocation, or `head`/`tail` with no explicit limit --
 * over a file above the threshold. A command carrying a pipe, redirection, or
 * chain passes without analysis: the named file is then a filter's input, not
 * evidence entering the model's context.
 *
 * @param {{maxReadLines: number|null}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
export function bashReadDecision(policy, payload) {
  if (typeof payload?.tool_name !== "string" || payload.tool_name !== "Bash") return null;
  const maxReadLines = policy.maxReadLines;
  if (typeof maxReadLines !== "number" || maxReadLines <= 0) return null;
  const input = payload?.tool_input;
  const command = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input).command : undefined;
  if (typeof command !== "string" || !command.trim()) return null;
  if (SHELL_COMPOSITION_TOKENS.some((token) => command.includes(token))) return null;
  const tokens = command.trim().split(/\s+/u);
  const program = basename(tokens[0] ?? "");
  const args = tokens.slice(1);
  if (WHOLE_FILE_READERS.has(program)) {
    return bashTargetDenial(args, maxReadLines);
  }
  if (BOUNDED_BY_DEFAULT_READERS.has(program) && !hasExplicitLimit(args)) {
    return bashTargetDenial(args, maxReadLines);
  }
  return null;
}

/**
 * @param {string[]} args
 * @param {number} maxReadLines
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
function bashTargetDenial(args, maxReadLines) {
  const target = [...args].reverse().find((token) => !token.startsWith("-"));
  if (!target) return null;
  const lines = countLines(target);
  if (lines === null || lines <= maxReadLines) return null;
  return denyPreTool(readThresholdDenialReason(lines, maxReadLines, true));
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function hasExplicitLimit(args) {
  return args.some((arg) => arg === "-n" || arg === "-c" || /^-[nc]\d+$/u.test(arg) || /^-\d+$/u.test(arg));
}

/**
 * @param {number} lines
 * @param {number} maxReadLines
 * @param {boolean} [viaBash]
 * @returns {string}
 */
function readThresholdDenialReason(lines, maxReadLines, viaBash = false) {
  const retry = viaBash
    ? "rerun with an explicit limit (head -n, tail -n) or use the Read tool with an offset and limit"
    : "reread it with an offset and limit instead of the whole file";
  return `read denied: this file has ${lines} lines, above the ${maxReadLines}-line read threshold; ${retry}.`;
}

/**
 * @param {string} workspace
 * @param {string} rawPath
 * @returns {string|null} the workspace-relative, forward-slash path, or null when it names a path outside the workspace
 */
function workspaceRelativePath(workspace, rawPath) {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath);
  const rel = relative(workspace, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return null;
  return process.platform === "win32" ? rel.replaceAll("\\", "/") : rel;
}

/**
 * Count lines in a file without loading it fully into memory: newline bytes
 * plus one more line when the file does not end on a newline. `null` means
 * the path does not exist, is not a regular file, or cannot be read -- the
 * caller must pass the invocation through rather than fabricate a denial for
 * evidence it cannot prove.
 *
 * @param {string} path
 * @returns {number|null}
 */
function countLines(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return null;
    if (stats.size === 0) return 0;
    const buffer = Buffer.alloc(64 * 1024);
    let lines = 0;
    let position = 0;
    let lastByte = -1;
    while (position < stats.size) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] === 0x0a) lines += 1;
      }
      lastByte = buffer[read - 1];
      position += read;
    }
    return lastByte === 0x0a ? lines : lines + 1;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} reason
 * @returns {{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: string}}}
 */
function denyPreTool(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
