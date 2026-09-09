import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** @typedef {{status: "ready", path: string, branch: string, commit: string|null, baseSha: string}} AttemptWorktree */
/** @typedef {{sha: string, empty: boolean}} SealedAttempt */

/** @param {string} runId @returns {string} */
export function runRefName(runId) {
  return `refs/intent-factory/${runId}/run`;
}

/** @param {string} runId @returns {string} */
export function candidateRefName(runId) {
  return `refs/intent-factory/${runId}/candidate`;
}

/** @param {string} runDir @param {string} runId @returns {string} */
function worktreeRoot(runDir, runId) {
  return join(dirname(runDir), "worktrees", runId);
}

/** @param {string} runDir @param {string} runId @param {string} nodeId @param {number} attempt @returns {string} */
export function attemptWorktreePath(runDir, runId, nodeId, attempt) {
  return join(worktreeRoot(runDir, runId), `${nodeId}.${attempt}`);
}

/** @param {string} runId @param {string} nodeId @param {number} attempt @returns {string} */
function attemptBranchName(runId, nodeId, attempt) {
  return `if/${runId}/${nodeId}/${attempt}`;
}

/** @param {string} runDir @param {string} runId @returns {string} */
export function candidateWorktreePath(runDir, runId) {
  return join(worktreeRoot(runDir, runId), ".candidate");
}

/** @param {string} repo @param {string[]} args @returns {string} */
export function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @param {string} repo @param {string} [ref] @returns {string|null} */
export function gitHead(repo, ref = "HEAD") {
  try {
    return git(repo, ["rev-parse", ref]);
  } catch {
    return null;
  }
}

/** @param {string} repo @param {string} runId @param {string|null|undefined} head @returns {string} */
export function createRunRef(repo, runId, head) {
  if (!head) throw Object.assign(new Error("an execution repository must have at least one commit"), { code: "git_head_required" });
  const ref = runRefName(runId);
  if (gitHead(repo, ref)) throw new Error(`run ref already exists: ${ref}`);
  execFileSync("git", ["-C", repo, "update-ref", ref, head], { stdio: "ignore" });
  return ref;
}

/**
 * @param {{repo: string, runDir: string, runId: string, nodeId: string, attempt: number, base?: string}} args
 *   `base` cuts the new branch from a sealed sha instead of the run ref tip —
 *   the previous attempt's sealed work, when it left one (TECH-SPEC lean
 *   v0.3 section 3 rule 4). Omitted, it falls back to the run ref tip as
 *   before.
 * @returns {AttemptWorktree}
 */
export function createAttemptWorktree({ repo, runDir, runId, nodeId, attempt, base }) {
  const runRefSha = gitHead(repo, runRefName(runId));
  if (!runRefSha) throw Object.assign(new Error(`integration ref is unavailable for ${runId}`), { code: "run_ref_missing" });
  const path = attemptWorktreePath(runDir, runId, nodeId, attempt);
  const branch = attemptBranchName(runId, nodeId, attempt);
  mkdirSync(dirname(path), { recursive: true });
  const existingCommit = gitHead(path);
  const existingBranch = gitHead(repo, branch);
  if (existingCommit) {
    if (existingBranch !== existingCommit) throw new Error(`attempt worktree identity does not match ${branch}: ${path}`);
  } else if (existingBranch) {
    execFileSync("git", ["-C", repo, "worktree", "add", path, branch], { stdio: "ignore" });
  } else {
    execFileSync("git", ["-C", repo, "worktree", "add", path, "-b", branch, base ?? runRefName(runId)], { stdio: "ignore" });
  }
  linkNodeModules(repo, path);
  return { status: "ready", path, branch, commit: gitHead(path), baseSha: base ?? runRefSha };
}

/**
 * Link the repository's installed `node_modules` into a fresh attempt
 * worktree as a symlink — never copied — so repository-level tooling that
 * needs installed binaries (commitlint through the commit-msg hook,
 * `npm run typecheck`) works inside the attempt without an install. A no-op
 * when the repository has nothing installed, or the worktree already has an
 * entry at that path.
 *
 * @param {string} repo @param {string} path @returns {void}
 */
function linkNodeModules(repo, path) {
  const source = join(repo, "node_modules");
  if (!existsSync(source)) return;
  const target = join(path, "node_modules");
  if (existsSync(target) || isSymlink(target)) return;
  symlinkSync(source, target);
}

/** @param {string} path @returns {boolean} */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * @param {{repo: string, path: string, baseSha: string|null, runId: string, nodeId: string, attempt: number}} args
 * @returns {SealedAttempt}
 */
export function sealAttempt({ repo, path, baseSha, runId, nodeId, attempt }) {
  // The attempt-local `.runs` result sidecar must never enter the attempt
  // commit. Naming it through an exclude pathspec makes `git add` exit 1 with
  // advice.addIgnoredFile as soon as the sidecar exists in a repository that
  // ignores `.runs/` (every real worker writes it), so stage everything and
  // unstage the sidecar afterwards; that also covers a repository that does
  // not ignore it.
  const dirty = git(path, ["status", "--porcelain=v1", "--", ".", ":(exclude).runs"]);
  if (dirty) {
    execFileSync("git", ["-C", path, "add", "-A", "--", "."], { stdio: "ignore" });
    // node_modules is linked into the worktree as a symlink, which `node_modules/`
    // in .gitignore does not match; never let the link into the attempt commit.
    execFileSync("git", ["-C", path, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".runs", "node_modules"], { stdio: "ignore" });
    execFileSync("git", [
      "-C", path,
      "-c", "user.email=runner@example.test",
      "-c", "user.name=intent-factory",
      "-c", "commit.gpgSign=false",
      "commit", "-qm", `intent-factory ${runId} ${nodeId} attempt ${attempt}`,
    ], { stdio: "ignore" });
  }
  const sha = gitHead(path);
  if (!sha) throw new Error(`attempt worktree has no commit: ${path}`);
  const empty = Boolean(baseSha && gitDiffEmpty(path, baseSha, sha));
  return { sha, empty };
}

/** @param {string} repo @param {string} base @param {string} head @returns {boolean} */
export function gitDiffEmpty(repo, base, head) {
  try {
    execFileSync("git", ["-C", repo, "diff", "--quiet", base, head], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} repo @param {string} ref @param {string} next @param {string} previous @returns {void} */
export function updateRefConditional(repo, ref, next, previous) {
  execFileSync("git", ["-C", repo, "update-ref", ref, next, previous], { stdio: "ignore" });
}

/** @param {string} repo @param {string} ref @returns {void} */
export function deleteRef(repo, ref) {
  try {
    execFileSync("git", ["-C", repo, "update-ref", "-d", ref], { stdio: "ignore" });
  } catch {
    // Deleting an already absent cleanup ref is idempotent.
  }
}

/**
 * @param {{repo: string, runDir: string, runId: string, ref?: string}} args
 * @returns {string}
 */
export function createCandidateWorktree({ repo, runDir, runId, ref = candidateRefName(runId) }) {
  const path = candidateWorktreePath(runDir, runId);
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", path, ref], { stdio: "ignore" });
  return path;
}

/** @param {string} repo @param {string|null|undefined} path @returns {void} */
export function removeWorktree(repo, path) {
  if (!path) return;
  try {
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", path], { stdio: "ignore" });
  } catch (error) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    else if (/** @type {{status?: number}} */ (error)?.status !== 128) throw error;
  }
}

/** @param {string} repo @param {string} runDir @param {string} runId @returns {void} */
export function cleanupCandidate(repo, runDir, runId) {
  removeWorktree(repo, candidateWorktreePath(runDir, runId));
  deleteRef(repo, candidateRefName(runId));
}
