/**
 * The workspace as evidence: what a worktree held before a worker ran, what it
 * held after, and whether the difference stayed inside the paths the packet
 * declared.
 *
 * Snapshots are of the *tracked and untracked* tree minus what git ignores, and
 * `captureIgnoreSources` is why: the ignore rules themselves are hashed, so a
 * worker that edits `.gitignore` mid-run cannot quietly move a file out of view.
 * That check is the reason a package install inside a worktree fails a node --
 * `snapshot_ignore_changed` -- rather than passing with an unexplained diff.
 *
 * This is repository knowledge, not contract knowledge: it stats files, reads
 * ignore rules and resolves symlinks. It lived in `contract/verification.mjs`
 * because the verification schema happened to be in the same file.
 */
import { Buffer } from "node:buffer";
import { VERIFICATION_LIMITS } from "../contract/verification.mjs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { errorCode } from "../util.mjs";
import { execFileSync } from "node:child_process";
import { fail, isContained } from "../util.mjs";
import { normalizeManagedSignalBlock } from "./signal-block.mjs";

/**
 * One entry of a workspace snapshot.
 *
 * @typedef {{path: string, kind: "file"|"symlink"|"missing", digest?: string, size?: number}} SnapshotEntry
 */
/** @typedef {{entries: SnapshotEntry[], ignoreSources: SnapshotEntry[], truncated: boolean}} WorkspaceSnapshot */
/** @typedef {{literal: string, paths: string[]}} WorkspaceScopeOrigin */
/** @typedef {{schemaVersion: 1, files: string[], roots: string[], fileRoots?: string[], fileOrigins: WorkspaceScopeOrigin[], rootOrigins: WorkspaceScopeOrigin[]}} WorkspaceScopeBoundary */
/** @typedef {{files?: string[], roots?: string[], boundary?: WorkspaceScopeBoundary}} WorkspaceScope */
/**
 * Result of comparing a baseline snapshot against the current workspace.
 *
 * @typedef {{after: WorkspaceSnapshot, changedPaths: string[], unexpectedPaths: string[]}} ScopeComparison
 */


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
      const identity = fileIdentity(child, metadata);
      add({ path: rel, kind: "file", digest: identity.digest, size: identity.size });
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
  const allowed = /** @type {WorkspaceScopeBoundary} */ (scope.boundary
    ? validateWorkspaceScopeBoundary(root, scope.boundary, scope)
    : {
      files: expandScopePaths(root, normalizeScopePaths(scope.files ?? [], "files")),
      roots: expandScopePaths(root, normalizeScopePaths(scope.roots ?? [], "roots")),
    });
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
  // A root that names a regular file authorizes exactly that path; only a
  // directory root covers what is beneath it (TECH-SPEC lean, rule 1).
  const fileRoots = new Set(allowed.fileRoots ?? []);
  const directoryRoots = allowed.roots.filter((scopeRoot) => !fileRoots.has(scopeRoot));
  const unexpectedPaths = changedPaths.filter((path) =>
    !allowed.files.includes(path) &&
    !fileRoots.has(path) &&
    !directoryRoots.some((scopeRoot) => path === scopeRoot || path.startsWith(`${scopeRoot}/`)));
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
  const rootPaths = [...new Set(rootOrigins.flatMap((origin) => origin.paths))];
  return validateWorkspaceScopeBoundary(cwd, {
    schemaVersion: 1,
    files: [...new Set(fileOrigins.flatMap((origin) => origin.paths))],
    roots: rootPaths,
    fileRoots: rootPaths.filter((path) => isRegularWorkspaceFile(root, path)),
    fileOrigins,
    rootOrigins,
  }, { files: declaredFiles, roots: declaredRoots });
}
/**
 * Whether a declared scope root is an existing regular file. Decided once at
 * capture time and carried in the persisted boundary: a worker that later
 * replaces the file with a same-named directory must not win directory
 * authority over the path.
 *
 * @param {string} root
 * @param {string} path
 * @returns {boolean}
 */
function isRegularWorkspaceFile(root, path) {
  try {
    return statSync(resolve(root, path)).isFile();
  } catch {
    return false;
  }
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
  const fileRoots = value.fileRoots === undefined ? [] : normalizeScopePaths(value.fileRoots, "boundary.fileRoots");
  if (files.length + roots.length + fileRoots.length + value.fileOrigins.length + value.rootOrigins.length > VERIFICATION_LIMITS.snapshotEntries) {
    throw fail("scope_boundary_too_large", "persisted worker scope boundary is too large");
  }
  if (fileRoots.some((path) => !roots.includes(path))) {
    throw fail("scope_boundary_invalid", "persisted worker scope file roots must be declared roots");
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
    fileRoots: [...new Set(fileRoots)],
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
  const paths = new Set([".intentfactoryignore", ".gitignore", ".git/config"]);
  /** @type {Map<string, string>} */
  const gitPaths = new Map();
  /** @param {string} name @param {string} logical @returns {string|null} */
  const resolveGitPath = (name, logical) => {
    try {
      const value = execFileSync("git", ["-C", root, "rev-parse", "--git-path", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!value) return null;
      const actual = isAbsolute(value) ? value : resolve(root, value);
      gitPaths.set(logical, actual);
      return actual;
    } catch {
      return null;
    }
  };
  resolveGitPath("config", ".git/config");
  const excludePath = resolveGitPath("info/exclude", ".git/info/exclude");
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
      // A directory that vanished between the parent's readdir and this one
      // (a test suite's temporary tree under an ignored `target/`, a build
      // cache being rotated) is not a snapshot failure: it holds no ignore
      // source any more. Only a directory that exists and cannot be read is.
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
      throw fail("snapshot_read_error", `cannot inspect workspace directory ${relativeWorkspacePath(root, directory)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".runs") continue;
      // Same exclusions as the entries snapshot (see the task-packet
      // reference): `node_modules` at any depth, and the agent runtimes'
      // scratch state at the root (`.claude`, `.codex`). Ignore files inside
      // them never change what git sees of the workspace, while a package
      // install or an agent worktree under `.claude/worktrees/` adds and
      // removes `.gitignore` files mid-node — which used to fail the node
      // with `snapshot_ignore_changed`.
      // A virtual environment is the same class as node_modules: it and its
      // packages carry .gitignore files that would move the fingerprint.
      if (entry.name === "node_modules" || entry.name === ".venv" || entry.name === "venv") continue;
      if (directory === root && (entry.name === ".claude" || entry.name === ".codex")) continue;
      const child = resolve(directory, entry.name);
      if (entry.isDirectory() && isVirtualEnv(child)) continue;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name === ".gitignore") {
        paths.add(relativeWorkspacePath(root, child));
      }
    }
  };
  walk(root);

  try {
    if (excludePath && (lstatSync(excludePath).isFile() || lstatSync(excludePath).isSymbolicLink())) paths.add(".git/info/exclude");
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
      throw fail("snapshot_read_error", `cannot inspect Git exclude source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** @param {string} path @returns {SnapshotEntry[]} */
  const capturePath = (path) => {
    const child = gitPaths.get(path) ?? resolve(root, path);
    const isEffectiveGitPath = gitPaths.has(path);
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
    if (!isEffectiveGitPath && !isContained(root, sourceReal)) throw fail("snapshot_symlink_escape", `workspace symlink escapes workspace: ${path}`);
    if (metadata.isSymbolicLink()) {
      let target;
      let targetReal;
      try {
        target = readlinkSync(child);
        targetReal = realpathSync(child);
      } catch (error) {
        throw fail("snapshot_read_error", `cannot resolve ignore source symlink ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isEffectiveGitPath && !isContained(root, targetReal)) throw fail("snapshot_symlink_escape", `workspace symlink escapes workspace: ${path}`);
      return [{ path, kind: "symlink", digest: `link:${target}:${targetReal}` }];
    }
    if (!metadata.isFile()) throw fail("snapshot_unsupported_entry", `unsupported ignore source: ${path}`);
    if (path === ".git/config") {
      // Only the ignore-relevant settings of the repository config are part
      // of the fingerprint. The file also carries branch tracking, remotes and
      // worktree bookkeeping that any git client edits at will — a sibling
      // session creating a tracking branch mid-node used to fail the node with
      // `snapshot_ignore_changed` although no ignore rule had moved.
      const relevant = readFileSync(child, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /excludesfile/iu.test(line))
        .sort()
        .join("\n");
      const bytes = Buffer.byteLength(relevant, "utf8");
      return [{ path, kind: "file", digest: `config:${createHash("sha256").update(relevant).digest("hex")}:${bytes}`, size: bytes }];
    }
    return [{ path, kind: "file", digest: fileIdentity(child, metadata).digest, size: metadata.size }];
  };
  return [...paths].sort().flatMap(capturePath);
}
/** @param {SnapshotEntry[]} before @param {SnapshotEntry[]} after @returns {boolean} */
function sameSnapshotEntries(before, after) {
  if (before.length !== after.length) return false;
  return before.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after[index]));
}
/** @param {string} root @param {string[]} paths @returns {string[]} */
function expandScopePaths(root, paths) {
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
    lstatSync(resolve(cwd, ".intentfactoryignore"));
    args.push("--exclude-from=.intentfactoryignore");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw fail("snapshot_read_error", `cannot inspect .intentfactoryignore: ${error instanceof Error ? error.message : String(error)}`);
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
    // Same exclusion as the ignore-source walk above: a repository's
    // gitignore conventionally excludes `node_modules/` as a directory
    // pattern, which does not match the symlink an attempt worktree links it
    // in as (TECH-SPEC lean v0.3 section 3 rule 4). Exclude it here too, so
    // linking never turns an installed dependency tree into an unexpected
    // workspace write or a symlink escape.
    if (value === "node_modules" || value.startsWith("node_modules/")) continue;
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
 * @returns {{digest: string, size: number}}
 */
function fileIdentity(path, metadata) {
  if (basename(path) === "AGENTS.md") {
    // The runner rewrites the machine-managed signal block as run state
    // changes. Hash the file with only that complete block normalized so
    // runner-owned block edits are not mistaken for worker scope drift, while
    // human-authored guidance outside the block still changes the identity.
    const normalized = normalizeManagedSignalBlock(readFileSync(path, "utf8"));
    const bytes = Buffer.from(normalized, "utf8");
    return {
      digest: `file:${createHash("sha256").update(normalized).digest("hex")}:${bytes.byteLength}:${metadata.mode}`,
      size: bytes.byteLength,
    };
  }
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
  return { digest: `file:${hash.digest("hex")}:${metadata.size}:${metadata.mode}`, size: metadata.size };
}
/** A virtual environment under any name, identified by its marker file. @param {string} directory @returns {boolean} */
function isVirtualEnv(directory) { try { return statSync(resolve(directory, "pyvenv.cfg")).isFile(); } catch { return false; } }
