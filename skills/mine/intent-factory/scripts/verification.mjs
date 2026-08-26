import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const VERIFICATION_LIMITS = Object.freeze({
  stdoutBytes: 16 * 1024,
  stderrBytes: 16 * 1024,
  maxCommands: 32,
  maxRepeat: 8,
  maxTimeoutSec: 600,
  stateStdoutBytes: 2 * 1024,
  stateCommands: 16,
  stateAttempts: 4,
  stateAttemptRecords: 16,
  stateArgvBytes: 8 * 1024,
  stateEnvBytes: 4 * 1024,
  maxArgvBytes: 32 * 1024,
  maxEnvBytes: 8 * 1024,
  snapshotEntries: 4096,
  snapshotPathBytes: 1024,
});

// Verification children receive only the declared environment-variable names
// plus a minimal base set needed to spawn a process. Ambient controller
// variables (including secrets) must never leak into verification commands.
const VERIFICATION_ENV_BASE_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
]);

/** @typedef {"active"|"closed"|"failed"|"crashed"|"canceled"} VerificationAttemptStatus */

/**
 * One declared deterministic check: an argv command run by the controller.
 *
 * @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[]}} VerificationCommand
 */

/**
 * A single attempt of a verification command.
 *
 * @typedef {{attempt: number, invocationId: string, commandIndex: number, pid: number|null, processStartToken: string|null, processGroupId: number|null, startedAt: string, deadlineAt: string, status: VerificationAttemptStatus, completedAt?: string|null, result?: VerificationAttemptResult|null}} VerificationAttempt
 */

/**
 * Bounded evidence captured for one attempt.
 *
 * @typedef {{passed: boolean, stdout: string, stderr: string, error: string|null, exitCode: number|null, signal: string|null, timedOut: boolean, durationMs: number|null}} VerificationAttemptResult
 */

/**
 * A command with its repeated attempts.
 *
 * @typedef {VerificationCommand & {passed: boolean, attempts: VerificationAttemptResult[]}} VerificationCommandResult
 */

/**
 * Aggregated verification result.
 *
 * @typedef {{passed: boolean, commands: VerificationCommandResult[]}} VerificationResult
 */

/**
 * Callbacks and options for {@link runVerification}.
 *
 * @typedef {{signal?: AbortSignal, logDir?: string, onAttemptStart?: (attempt: VerificationAttempt) => void, onAttemptSpawn?: (attempt: VerificationAttempt) => void, onAttemptComplete?: (attempt: VerificationAttempt) => void}} VerificationOptions
 */

/**
 * One entry of a workspace snapshot.
 *
 * @typedef {{path: string, kind: "file"|"symlink"|"missing", digest?: string, size?: number}} SnapshotEntry
 */

/** @typedef {{entries: SnapshotEntry[], ignoreSources: SnapshotEntry[], truncated: boolean}} WorkspaceSnapshot */

/** @typedef {{literal: string, paths: string[]}} WorkspaceScopeOrigin */
/** @typedef {{schemaVersion: 1, files: string[], roots: string[], fileOrigins: WorkspaceScopeOrigin[], rootOrigins: WorkspaceScopeOrigin[]}} WorkspaceScopeBoundary */
/** @typedef {{files?: string[], roots?: string[], boundary?: WorkspaceScopeBoundary}} WorkspaceScope */

/**
 * Result of comparing a baseline snapshot against the current workspace.
 *
 * @typedef {{after: WorkspaceSnapshot, changedPaths: string[], unexpectedPaths: string[]}} ScopeComparison
 */

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function fail(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/** @param {unknown} error @returns {string|undefined} */
function errorCode(error) {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * @param {string} cwd
 * @param {SnapshotEntry[]} [expectedIgnoreSources]
 * @returns {WorkspaceSnapshot}
 */
export function captureWorkspaceSnapshot(cwd, expectedIgnoreSources) {
  const root = realpathSync(cwd);
  const ignoreSources = captureIgnoreSources(root);
  if (expectedIgnoreSources !== undefined && !sameSnapshotEntries(expectedIgnoreSources, ignoreSources)) {
    throw fail("snapshot_ignore_changed", "workspace ignore sources changed during worker execution");
  }
  /** @type {SnapshotEntry[]} */
  const entries = [];
  const add = (/** @type {SnapshotEntry} */ entry) => {
    if (entries.length >= VERIFICATION_LIMITS.snapshotEntries) {
      throw fail("snapshot_too_large", `workspace snapshot exceeds ${VERIFICATION_LIMITS.snapshotEntries} entries`);
    }
    entries.push(entry);
  };
  for (const rel of relevantWorkspacePaths(root)) {
    if (Buffer.byteLength(rel, "utf8") > VERIFICATION_LIMITS.snapshotPathBytes) {
      throw fail("snapshot_path_too_long", `workspace path exceeds ${VERIFICATION_LIMITS.snapshotPathBytes} bytes: ${rel.slice(0, 128)}`);
    }
    const child = resolve(root, rel);
    let metadata;
    try {
      metadata = lstatSync(child);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        add({ path: rel, kind: "missing" });
        continue;
      }
      throw fail("snapshot_read_error", `cannot inspect workspace path ${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (metadata.isDirectory()) continue;
    if (metadata.isSymbolicLink()) {
      let target;
      let targetReal;
      try {
        target = readlinkSync(child);
        targetReal = realpathSync(child);
      } catch (error) {
        throw fail("snapshot_read_error", `cannot resolve workspace symlink ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isContained(root, targetReal)) {
        throw fail("snapshot_symlink_escape", `workspace symlink escapes workspace: ${rel}`);
      }
      add({ path: rel, kind: "symlink", digest: `link:${target}:${targetReal}` });
    } else if (metadata.isFile()) {
      add({ path: rel, kind: "file", digest: readFileIdentity(child, metadata), size: metadata.size });
    } else {
      throw fail("snapshot_unsupported_entry", `unsupported workspace entry: ${rel}`);
    }
  }
  return { entries, ignoreSources, truncated: false };
}

/**
 * @param {WorkspaceSnapshot|undefined} before
 * @param {string} cwd
 * @param {WorkspaceScope} scope
 * @returns {ScopeComparison}
 */
export function compareWorkspaceSnapshot(before, cwd, scope = {}) {
  if (!before || !Array.isArray(before.entries) || !Array.isArray(before.ignoreSources) || before.truncated) {
    throw fail("snapshot_invalid", "workspace baseline snapshot is missing or truncated");
  }
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw fail("scope_invalid", "workspace scope must be an object");
  }
  const root = realpathSync(cwd);
  const allowed = scope.boundary
    ? validateWorkspaceScopeBoundary(root, scope.boundary, scope)
    : {
      files: expandScopePaths(root, normalizeScopePaths(scope.files ?? [], "files")),
      roots: expandScopePaths(root, normalizeScopePaths(scope.roots ?? [], "roots")),
    };
  const after = captureWorkspaceSnapshot(cwd, before.ignoreSources);
  if (!sameSnapshotEntries(before.ignoreSources, after.ignoreSources)) {
    throw fail("snapshot_ignore_changed", "workspace ignore sources changed during worker execution");
  }
  const prior = new Map(before.entries.map((/** @type {SnapshotEntry} */ entry) => [entry.path, JSON.stringify(entry)]));
  const current = new Map(after.entries.map((/** @type {SnapshotEntry} */ entry) => [entry.path, JSON.stringify(entry)]));
  const changed = new Set();
  for (const path of new Set([...prior.keys(), ...current.keys()])) {
    if (prior.get(path) !== current.get(path)) changed.add(path);
  }
  const changedPaths = [...changed].sort();
  const unexpectedPaths = changedPaths.filter((path) => !allowed.files.includes(path) && !allowed.roots.some((scopeRoot) => path === scopeRoot || path.startsWith(`${scopeRoot}/`)));
  return { after, changedPaths, unexpectedPaths };
}

/**
 * Resolve a declared worker scope before an untrusted worker starts. The
 * returned paths are the literal declarations plus the contained target paths
 * reached through symlinks that exist at capture time.
 *
 * @param {string} cwd
 * @param {WorkspaceScope} scope
 * @returns {WorkspaceScopeBoundary}
 */
export function captureWorkspaceScope(cwd, scope = {}) {
  const root = realpathSync(cwd);
  const declaredFiles = normalizeScopePaths(scope.files ?? [], "files");
  const declaredRoots = normalizeScopePaths(scope.roots ?? [], "roots");
  const fileOrigins = declaredFiles.map((literal) => ({ literal, paths: expandScopePaths(root, [literal]) }));
  const rootOrigins = declaredRoots.map((literal) => ({ literal, paths: expandScopePaths(root, [literal]) }));
  return validateWorkspaceScopeBoundary(cwd, {
    schemaVersion: 1,
    files: [...new Set(fileOrigins.flatMap((origin) => origin.paths))],
    roots: [...new Set(rootOrigins.flatMap((origin) => origin.paths))],
    fileOrigins,
    rootOrigins,
  }, { files: declaredFiles, roots: declaredRoots });
}

/**
 * Validate a persisted worker scope without following its current symlink
 * graph. Only lexical, relative paths from the captured boundary are used.
 *
 * @param {string} cwd
 * @param {unknown} boundary
 * @param {WorkspaceScope} [declared]
 * @returns {WorkspaceScopeBoundary}
 */
export function validateWorkspaceScopeBoundary(cwd, boundary, declared = {}) {
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
    throw fail("scope_boundary_invalid", "persisted worker scope boundary must be an object");
  }
  const value = /** @type {Record<string, unknown>} */ (boundary);
  if (value.schemaVersion !== 1 || !Array.isArray(value.files) || !Array.isArray(value.roots) || !Array.isArray(value.fileOrigins) || !Array.isArray(value.rootOrigins)) {
    throw fail("scope_boundary_invalid", "persisted worker scope boundary is malformed");
  }
  const root = realpathSync(cwd);
  const files = normalizeScopePaths(value.files, "boundary.files");
  const roots = normalizeScopePaths(value.roots, "boundary.roots");
  if (files.length + roots.length + value.fileOrigins.length + value.rootOrigins.length > VERIFICATION_LIMITS.snapshotEntries) {
    throw fail("scope_boundary_too_large", "persisted worker scope boundary is too large");
  }
  const declaredFiles = normalizeScopePaths(declared.files ?? [], "files");
  const declaredRoots = normalizeScopePaths(declared.roots ?? [], "roots");
  /**
   * @param {unknown[]} rawOrigins
   * @param {"file"|"root"} kind
   * @param {string[]} declaredPaths
   * @param {string[]} boundedPaths
   * @returns {WorkspaceScopeOrigin[]}
   */
  const validateOrigins = (rawOrigins, kind, declaredPaths, boundedPaths) => {
    const origins = [];
    const literals = new Set();
    const union = [];
    for (const raw of /** @type {unknown[]} */ (rawOrigins)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("scope_boundary_invalid", `persisted ${kind} scope origins are malformed`);
      const origin = /** @type {Record<string, unknown>} */ (raw);
      if (Object.keys(origin).some((key) => key !== "literal" && key !== "paths")) throw fail("scope_boundary_invalid", `persisted ${kind} scope origins are malformed`);
      const literal = normalizeScopePaths([origin.literal], `${kind}Origins.literal`)[0];
      const paths = normalizeScopePaths(origin.paths, `${kind}Origins.paths`);
      if (literals.has(literal) || !declaredPaths.includes(literal) || !paths.includes(literal)) {
        throw fail("scope_boundary_inconsistent", `persisted ${kind} scope origins do not match the declared scope`);
      }
      literals.add(literal);
      union.push(...paths);
      origins.push({ literal, paths: [...new Set(paths)] });
    }
    if (literals.size !== declaredPaths.length || declaredPaths.some((path) => !literals.has(path))) {
      throw fail("scope_boundary_inconsistent", `persisted ${kind} scope origins do not match the declared scope`);
    }
    const actual = [...new Set(boundedPaths)];
    const expected = [...new Set(union)];
    if (actual.length !== expected.length || actual.some((path) => !expected.includes(path))) {
      throw fail("scope_boundary_inconsistent", `persisted ${kind} scope boundary paths do not match their origins`);
    }
    return origins;
  };
  const fileOrigins = validateOrigins(value.fileOrigins, "file", declaredFiles, files);
  const rootOrigins = validateOrigins(value.rootOrigins, "root", declaredRoots, roots);
  // Keep the cwd resolution as an explicit portability/containment check. The
  // paths themselves are relative and must never be converted through the
  // current symlink graph during validation.
  if (!root) throw fail("scope_boundary_invalid", "workspace cwd is unavailable");
  return {
    schemaVersion: 1,
    files: [...new Set(files)],
    roots: [...new Set(roots)],
    fileOrigins,
    rootOrigins,
  };
}

/**
 * Snapshot the files Git can use to hide workspace changes. These entries are
 * kept separate from the relevant-file entry cap. A worker cannot replace
 * ignore rules and then make the new rules authoritative for the comparison.
 * Any source change fails closed before scope matching.
 *
 * @param {string} root
 * @returns {SnapshotEntry[]}
 */
function captureIgnoreSources(root) {
  /** @type {Set<string>} */
  const paths = new Set([".planrunnerignore", ".gitignore", ".git/config"]);
  try {
    if (lstatSync(resolve(root, ".git")).isFile()) paths.add(".git");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw fail("snapshot_read_error", `cannot inspect Git repository identity: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const walk = (/** @type {string} */ directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw fail("snapshot_read_error", `cannot inspect workspace directory ${relativeWorkspacePath(root, directory)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".runs") continue;
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name === ".gitignore") {
        paths.add(relativeWorkspacePath(root, child));
      }
    }
  };
  walk(root);

  const gitExclude = resolve(root, ".git", "info", "exclude");
  try {
    if (lstatSync(gitExclude).isFile() || lstatSync(gitExclude).isSymbolicLink()) paths.add(relativeWorkspacePath(root, gitExclude));
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
      throw fail("snapshot_read_error", `cannot inspect Git exclude source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** @param {string} path @returns {SnapshotEntry[]} */
  const capturePath = (path) => {
    const child = resolve(root, path);
    let metadata;
    try {
      metadata = lstatSync(child);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
      throw fail("snapshot_read_error", `cannot inspect ignore source ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Buffer.byteLength(path, "utf8") > VERIFICATION_LIMITS.snapshotPathBytes) {
      throw fail("snapshot_path_too_long", `workspace path exceeds ${VERIFICATION_LIMITS.snapshotPathBytes} bytes: ${path.slice(0, 128)}`);
    }
    let sourceReal;
    try {
      sourceReal = realpathSync(child);
    } catch (error) {
      throw fail("snapshot_read_error", `cannot resolve ignore source ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isContained(root, sourceReal)) throw fail("snapshot_symlink_escape", `workspace symlink escapes workspace: ${path}`);
    if (metadata.isSymbolicLink()) {
      let target;
      let targetReal;
      try {
        target = readlinkSync(child);
        targetReal = realpathSync(child);
      } catch (error) {
        throw fail("snapshot_read_error", `cannot resolve ignore source symlink ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isContained(root, targetReal)) throw fail("snapshot_symlink_escape", `workspace symlink escapes workspace: ${path}`);
      return [{ path, kind: "symlink", digest: `link:${target}:${targetReal}` }];
    }
    if (!metadata.isFile()) throw fail("snapshot_unsupported_entry", `unsupported ignore source: ${path}`);
    return [{ path, kind: "file", digest: readFileIdentity(child, metadata), size: metadata.size }];
  };
  return [...paths].sort().flatMap(capturePath);
}

/** @param {SnapshotEntry[]} before @param {SnapshotEntry[]} after @returns {boolean} */
function sameSnapshotEntries(before, after) {
  if (before.length !== after.length) return false;
  return before.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after[index]));
}

/** @param {string} root @param {string[]} paths @returns {string[]} */
export function expandScopePaths(root, paths) {
  return [...new Set(paths.flatMap((path) => {
    const resolvedPath = resolveScopePath(root, path);
    return resolvedPath === path ? [path] : [path, resolvedPath];
  }))];
}

/**
 * Resolve a declared path through existing symlinks while retaining any new
 * trailing components. Git reports files below a symlink using the target's
 * path, so both the declared spelling and its contained target spelling are
 * accepted for that explicit scope.
 *
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
function resolveScopePath(root, path) {
  const components = workspacePathComponents(path);
  let current = root;
  let index = 0;
  for (; index < components.length; index += 1) {
    const candidate = resolve(current, components[index]);
    try {
      const target = realpathSync(candidate);
      if (!isContained(root, target)) throw fail("scope_symlink_escape", `workspace scope path escapes workspace: ${path}`);
      current = target;
    } catch (error) {
      if (errorCode(error) === "ENOTDIR") throw fail("scope_invalid", `workspace scope path is not a directory: ${path}`);
      if (errorCode(error) !== "ENOENT") throw error;
      current = resolve(current, ...components.slice(index));
      break;
    }
  }
  const resolvedPath = relativeWorkspacePath(root, current);
  return resolvedPath || path;
}

/**
 * @param {string} cwd
 * @returns {string[]}
 */
function relevantWorkspacePaths(cwd) {
  const args = ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"];
  try {
    lstatSync(resolve(cwd, ".planrunnerignore"));
    args.push("--exclude-from=.planrunnerignore");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw fail("snapshot_read_error", `cannot inspect .planrunnerignore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  args.push("-z");
  let output;
  try {
    output = execFileSync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: VERIFICATION_LIMITS.snapshotEntries * (VERIFICATION_LIMITS.snapshotPathBytes + 1) + 1,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw fail("snapshot_git_error", `cannot enumerate relevant workspace files: ${error instanceof Error ? error.message : String(error)}`);
  }
  const paths = new Set();
  for (const value of output.toString("utf8").split("\0")) {
    if (!value) continue;
    if (value === ".runs" || value.startsWith(".runs/")) continue;
    if (paths.size >= VERIFICATION_LIMITS.snapshotEntries) {
      throw fail("snapshot_too_large", `workspace snapshot exceeds ${VERIFICATION_LIMITS.snapshotEntries} entries`);
    }
    paths.add(value);
  }
  return [...paths].sort();
}

/**
 * @param {unknown} paths
 * @param {string} label
 * @returns {string[]}
 */
function normalizeScopePaths(paths, label) {
  if (!Array.isArray(paths)) throw fail("scope_invalid", `workspace scope.${label} must be an array`);
  return paths.map((path) => {
    const separators = process.platform === "win32" ? /[\\/]/u : /\//u;
    if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path) || new RegExp(`(?:^|${separators.source})\\.\\.(?:${separators.source}|$)`, "u").test(path)) {
      throw fail("scope_invalid", `workspace scope.${label} contains an invalid path`);
    }
    const normalized = (process.platform === "win32" ? path.replaceAll("\\", "/") : path).replace(/\/+$/u, "");
    if (!normalized || normalized === ".") throw fail("scope_invalid", `workspace scope.${label} contains an invalid path`);
    if (Buffer.byteLength(normalized, "utf8") > VERIFICATION_LIMITS.snapshotPathBytes) {
      throw fail("scope_path_too_long", `workspace scope.${label} path exceeds ${VERIFICATION_LIMITS.snapshotPathBytes} bytes`);
    }
    return normalized;
  });
}

/** @param {string} root @param {string} path @returns {string} */
function relativeWorkspacePath(root, path) {
  const value = relative(root, path);
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

/** @param {string} path @returns {string[]} */
function workspacePathComponents(path) {
  return (process.platform === "win32" ? path.replaceAll("\\", "/") : path).split("/").filter((component) => component && component !== ".");
}

/**
 * @param {string} path
 * @param {import("node:fs").Stats} metadata
 * @returns {string}
 */
function readFileIdentity(path, metadata) {
  const hash = createHash("sha256");
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (read <= 0) throw fail("snapshot_read_error", `short read for workspace file ${path}`);
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } catch (error) {
    throw error && typeof error === "object" && "code" in error ? error : fail("snapshot_read_error", `cannot hash workspace file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return `file:${hash.digest("hex")}:${metadata.size}:${metadata.mode}`;
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isContained(root, target) {
  const distance = relative(root, target);
  return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
}

/**
 * @param {unknown} cwd
 * @param {string} label
 */
function validateRelativeCwd(cwd, label) {
  if (typeof cwd !== "string" || isAbsolute(cwd) || /^[A-Za-z]:[\\/]/u.test(cwd) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(cwd)) {
    throw fail("verification_cwd_invalid", `${label}.cwd must be a relative path without ..`);
  }
}

/**
 * @param {string} baseCwd
 * @param {string} commandCwd
 * @returns {string}
 */
function resolveVerificationCwd(baseCwd, commandCwd = ".") {
  validateRelativeCwd(commandCwd, "verification command");
  const baseReal = realpathSync(baseCwd);
  const candidate = resolve(baseReal, commandCwd);
  const targetReal = realpathSync(candidate);
  if (!isContained(baseReal, targetReal)) {
    throw fail("verification_cwd_escape", `verification cwd escapes workspace: ${commandCwd}`);
  }
  if (!statSync(targetReal).isDirectory()) throw fail("verification_cwd_invalid", `verification cwd is not a directory: ${commandCwd}`);
  return targetReal;
}

/**
 * @param {unknown} commands
 * @param {string} label
 * @returns {VerificationCommand[]}
 */
export function validateVerificationCommands(commands, label = "verification") {
  if (!Array.isArray(commands) || commands.length > VERIFICATION_LIMITS.maxCommands) {
    throw new TypeError(`${label} must be an array of at most ${VERIFICATION_LIMITS.maxCommands} command objects`);
  }
  return commands.map((command, index) => validateVerificationCommand(command, `${label}[${index}]`));
}

/**
 * @param {unknown} command
 * @param {string} label
 * @returns {VerificationCommand}
 */
export function validateVerificationCommand(command, label = "verification command") {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new TypeError(`${label} must be an argv command object`);
  const record = /** @type {Record<string, unknown>} */ (command);
  const allowed = new Set(["argv", "cwd", "timeoutSec", "repeat", "env"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.length > 64 || record.argv.some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > 8 * 1024)) {
    throw new TypeError(`${label}.argv must be a non-empty array of strings`);
  }
  const argvBytes = record.argv.reduce((sum, item) => sum + Buffer.byteLength(/** @type {string} */ (item), "utf8"), 0);
  if (argvBytes > VERIFICATION_LIMITS.maxArgvBytes) throw new TypeError(`${label}.argv exceeds aggregate byte limit`);
  if (record.cwd !== undefined) validateRelativeCwd(record.cwd, label);
  const timeoutSec = record.timeoutSec === undefined ? 120 : record.timeoutSec;
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > VERIFICATION_LIMITS.maxTimeoutSec) throw new TypeError(`${label}.timeoutSec must be between 0 and ${VERIFICATION_LIMITS.maxTimeoutSec}`);
  const repeat = record.repeat === undefined ? 2 : record.repeat;
  if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat <= 0 || repeat > VERIFICATION_LIMITS.maxRepeat) throw new TypeError(`${label}.repeat must be between 1 and ${VERIFICATION_LIMITS.maxRepeat}`);
  const env = record.env ?? [];
  if (!Array.isArray(env) || env.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new TypeError(`${label}.env must be an array of environment-variable names`);
  const envBytes = env.reduce((sum, name) => sum + Buffer.byteLength(/** @type {string} */ (name), "utf8"), 0);
  if (envBytes > VERIFICATION_LIMITS.maxEnvBytes) throw new TypeError(`${label}.env exceeds aggregate byte limit`);
  /** @type {VerificationCommand} */
  const normalized = { argv: [.../** @type {string[]} */ (record.argv)], timeoutSec, repeat, env: [.../** @type {string[]} */ (env)] };
  if (record.cwd !== undefined) normalized.cwd = /** @type {string} */ (record.cwd);
  return normalized;
}

/**
 * @param {VerificationCommand} command
 * @returns {Record<string, string|undefined>}
 */
function verificationEnv(command) {
  const names = new Set([...(command.env ?? []), ...VERIFICATION_ENV_BASE_NAMES]);
  /** @type {Record<string, string|undefined>} */
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/**
 * Run every declared command `repeat` times inside the workspace.
 *
 * @param {unknown} commands
 * @param {string} baseCwd
 * @param {VerificationOptions} options
 * @returns {Promise<VerificationResult>}
 */
export async function runVerification(commands, baseCwd, options = {}) {
  const validated = validateVerificationCommands(commands);
  /** @type {VerificationCommandResult[]} */
  const results = [];
  for (const [commandIndex, command] of validated.entries()) {
    /** @type {VerificationAttemptResult[]} */
    const attempts = [];
    const repeat = command.repeat ?? 2;
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      attempts.push(await runCommand(command, baseCwd, command.cwd ?? ".", attempt, options.signal, options, commandIndex));
    }
    const result = { ...command, cwd: resolveVerificationCwd(baseCwd, command.cwd ?? "."), passed: attempts.every((item) => item.passed), attempts };
    results.push(result);
    if (options.logDir) {
      mkdirSync(options.logDir, { recursive: true });
      writeFileSync(`${options.logDir}/verification-${results.length}.json`, `${JSON.stringify(compactVerification({ passed: result.passed, commands: [result] }))}\n`, { mode: 0o600 });
    }
  }
  return { passed: results.every((result) => result.passed), commands: results };
}

/**
 * Bound a verification result for persisted node state.
 *
 * @param {VerificationResult|undefined} result
 * @returns {VerificationResult}
 */
export function compactVerification(result) {
  /** @type {VerificationCommandResult[]} */
  const commands = [];
  let argvBytes = 0;
  let envBytes = 0;
  for (const command of result?.commands ?? []) {
    if (commands.length >= VERIFICATION_LIMITS.stateCommands) break;
    const nextArgvBytes = argvBytes + command.argv.reduce((sum, item) => sum + Buffer.byteLength(String(item), "utf8"), 0);
    const nextEnvBytes = envBytes + (command.env ?? []).reduce((sum, item) => sum + Buffer.byteLength(String(item), "utf8"), 0);
    if (nextArgvBytes > VERIFICATION_LIMITS.stateArgvBytes || nextEnvBytes > VERIFICATION_LIMITS.stateEnvBytes) break;
    argvBytes = nextArgvBytes;
    envBytes = nextEnvBytes;
    commands.push({
      argv: command.argv,
      cwd: command.cwd,
      timeoutSec: command.timeoutSec,
      repeat: command.repeat,
      env: command.env,
      passed: Boolean(command.passed),
      attempts: (command.attempts ?? []).slice(0, VERIFICATION_LIMITS.stateAttempts).map((attempt) => ({
        ...attempt,
        stdout: tailText(attempt.stdout, VERIFICATION_LIMITS.stateStdoutBytes),
        stderr: tailText(attempt.stderr, VERIFICATION_LIMITS.stateStdoutBytes),
      })),
    });
  }
  return { passed: Boolean(result?.passed), commands };
}

/**
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {string} commandCwd
 * @param {number} attempt
 * @param {AbortSignal|undefined} signal
 * @param {VerificationOptions} options
 * @param {number} commandIndex
 * @returns {Promise<VerificationAttemptResult>}
 */
function runCommand(command, baseCwd, commandCwd, attempt, signal, options, commandIndex) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const stdout = boundedTail(VERIFICATION_LIMITS.stdoutBytes);
    const stderr = boundedTail(VERIFICATION_LIMITS.stderrBytes);
    let settled = false;
    let timedOut = false;
    /** @type {import("node:child_process").ChildProcess|null} */
    let child = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {(() => void)|null} */
    let abortHandler = null;
    /** @type {VerificationAttempt|null} */
    let identity = null;
    let completionReported = false;
    const terminate = (/** @type {string} */ name) => {
      timedOut ||= name === "timeout";
      if (!child?.pid) return;
      terminateGroup(child);
    };
    /**
     * @param {number|null} exitCode
     * @param {string|null} signalName
     * @param {Error|null} error
     */
    const finish = (exitCode, signalName, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      if (child?.pid && !error && !signalName && !timedOut) terminateGroup(child);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const result = {
        attempt,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Math.round(durationMs * 100) / 100,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signalName ?? null,
        timedOut,
        error: error ? String(error.message ?? error) : null,
        passed: !error && !timedOut && exitCode === 0 && !signalName,
      };
      if (!completionReported && identity) {
        completionReported = true;
        try { options?.onAttemptComplete?.({ ...identity, status: result.passed ? "closed" : "failed", completedAt: new Date().toISOString(), result }); } catch {}
      }
      resolveResult(result);
    };
    try {
      const cwd = resolveVerificationCwd(baseCwd, commandCwd);
      const startedAt = new Date().toISOString();
      identity = {
        invocationId: randomUUID(), commandIndex, attempt, pid: null, processStartToken: null, processGroupId: null,
        startedAt, deadlineAt: new Date(Date.parse(startedAt) + (command.timeoutSec ?? 120) * 1_000).toISOString(), status: "active",
      };
      options?.onAttemptStart?.({ ...identity });
      const env = verificationEnv(command);
      child = spawn(command.argv[0], command.argv.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const pid = child.pid ?? null;
      let paused = false;
      if (process.platform !== "win32" && pid) {
        try { process.kill(-pid, "SIGSTOP"); paused = true; } catch {}
      }
      Object.assign(identity, { pid, processGroupId: process.platform === "win32" ? null : pid });
      options?.onAttemptSpawn?.({ ...identity });
      if (paused && pid) {
        try { process.kill(-pid, "SIGCONT"); } catch {}
      }
      const childStdout = /** @type {import("node:stream").Readable} */ (child.stdout);
      const childStderr = /** @type {import("node:stream").Readable} */ (child.stderr);
      childStdout.on("data", (chunk) => stdout.add(chunk));
      childStderr.on("data", (chunk) => stderr.add(chunk));
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signalName) => finish(code, signalName));
      abortHandler = () => terminate("abort");
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
    } catch (error) {
      if (child?.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGCONT"); } catch {}
      }
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
    }
    if (child) timer = setTimeout(() => terminate("timeout"), (command.timeoutSec ?? 120) * 1_000);
  });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 */
function terminateGroup(child) {
  try {
    if (process.platform !== "win32") process.kill(-/** @type {number} */ (child.pid), "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try {
      if (process.platform !== "win32") process.kill(-/** @type {number} */ (child.pid), "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 100).unref();
}

/**
 * @param {number} maxBytes
 */
function boundedTail(maxBytes) {
  let value = Buffer.alloc(0);
  return {
    /**
     * @param {string|Buffer} chunk
     */
    add(chunk) {
      value = Buffer.concat([value, Buffer.from(chunk)]);
      if (value.length > maxBytes) {
        let start = value.length - maxBytes;
        while (start < value.length && (value[start] & 0xc0) === 0x80) start += 1;
        value = value.subarray(start);
      }
    },
    value: () => value.toString("utf8"),
  };
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function tailText(value, maxBytes) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
