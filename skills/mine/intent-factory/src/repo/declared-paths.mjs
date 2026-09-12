/**
 * Whether the paths a packet declared are paths the controller can actually
 * observe, and whether its verification commands cover what it writes.
 *
 * Both answers come from git: a declared write inside an ignored directory
 * leaves no diff to inspect, so the node would pass on evidence that cannot
 * exist. These are warnings, not refusals -- the author may mean it -- but they
 * are the warnings worth reading.
 *
 * It lived in `contract/index.mjs` and it runs `git check-ignore`: repository
 * knowledge validating a contract, which is why it now sits in `repo/`.
 */
import { errorCode, exitStatus } from "../util.mjs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */

const ALWAYS_UNOBSERVABLE_ROOTS = new Set([".runs", ".git"]);
/**
 * @param {ValidatedNode} node
 * @param {number} index
 * @param {string} cwd
 * @returns {string[]}
 */
export function unsnapshottedWriteWarnings(node, index, cwd) {
  const declarations = /** @type {{kind: "writeFiles"|"writeRoots", path: string}[]} */ ([
    ...(node.taskPacket.writeFiles ?? []).map((path) => ({ kind: "writeFiles", path })),
    ...(node.taskPacket.writeRoots ?? []).map((path) => ({ kind: "writeRoots", path })),
  ]);
  const hidden = new Map();
  for (const declaration of declarations) {
    if (!isUnobservableDeclaredPath(cwd, declaration.path, declaration.kind)) continue;
    const path = process.platform === "win32" ? String(declaration.path).replaceAll("\\", "/") : String(declaration.path);
    const root = path.split("/")[0];
    const key = `${declaration.kind}:${root}`;
    hidden.set(key, { kind: declaration.kind, root, path });
  }
  return [...hidden.values()].map(({ kind, root, path }) =>
    `nodes[${index}] (${node.id}): ${path.includes("/") ? `${kind} under ${root}/` : `${kind} ${path}`} are outside the workspace snapshot, so the closed-scope gate cannot observe them`,
  );
}
/**
 * @param {string|undefined} cwd
 * @param {string} declaredPath
 * @param {"writeFiles"|"writeRoots"} kind
 * @returns {boolean}
 */
function isUnobservableDeclaredPath(cwd, declaredPath, kind) {
  if (!cwd) return false;
  const path = process.platform === "win32" ? String(declaredPath).replaceAll("\\", "/") : String(declaredPath);
  const root = path.split("/")[0];
  if (ALWAYS_UNOBSERVABLE_ROOTS.has(root)) return true;
  return gitDeclaredPathState(cwd, path, kind) === "ignored";
}
/**
 * @param {string} cwd
 * @param {string} path
 * @param {"writeFiles"|"writeRoots"} kind
 * @returns {"tracked"|"ignored"|"visible"|"unknown"}
 */
function gitDeclaredPathState(cwd, path, kind) {
  const literals = kind === "writeRoots" ? [path, `${path}/`] : [path];
  try {
    execFileSync("git", ["-C", cwd, "ls-files", "--cached", "--error-unmatch", "--", path], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "tracked";
  } catch (error) {
    if (exitStatus(error) !== 1) return "unknown";
  }

  let hasIntentfactoryIgnore = false;
  try {
    hasIntentfactoryIgnore = lstatSync(resolve(cwd, ".intentfactoryignore")).isFile();
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return "unknown";
  }
  const intentfactoryIgnore = hasIntentfactoryIgnore ? resolve(cwd, ".intentfactoryignore") : undefined;
  for (const literal of literals) {
    const combined = checkCombinedGitIgnore(cwd, literal, intentfactoryIgnore);
    if (combined === "unknown") return "unknown";
    if (combined === false) return "visible";
  }
  return "ignored";
}
/**
 * Use the same combined Git enumeration as workspace snapshots for paths
 * that already exist. Missing declarations fall through to check-ignore so
 * validation can still warn about future paths hidden by a rule.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string|undefined} extraExclude
 * @returns {boolean|"unknown"|undefined}
 */
function checkCombinedGitIgnore(cwd, path, extraExclude) {
  let exists = true;
  try {
    lstatSync(resolve(cwd, path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") exists = false;
    else return "unknown";
  }
  if (!exists) {
    return checkMissingCombinedGitIgnore(cwd, path, extraExclude);
  }

  try {
    const args = ["-C", cwd, "ls-files", "--others", "--exclude-standard"];
    if (extraExclude) args.push(`--exclude-from=${extraExclude}`);
    args.push("-z", "--", path);
    const output = execFileSync("git", args, { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    return output.length === 0;
  } catch {
    return "unknown";
  }
}
/**
 * A missing path cannot be checked with the snapshot enumeration. Ask Git for
 * the standard result in the real repository, then ask Git whether the extra
 * source matched in an isolated context so repository `.gitignore` files
 * cannot outrank it.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string|undefined} extraExclude
 * @returns {boolean|"unknown"}
 */
function checkMissingCombinedGitIgnore(cwd, path, extraExclude) {
  const standard = checkGitIgnore(cwd, path);
  if (!extraExclude || standard === "unknown") return standard;
  const temporaryWorktree = mkdtempSync(join(tmpdir(), "intent-factory-ignore-check-"));
  try {
    execFileSync("git", ["init", "-q", temporaryWorktree], { stdio: ["ignore", "ignore", "ignore"] });
    const temporaryGit = resolve(temporaryWorktree, ".git");
    writeFileSync(resolve(temporaryGit, "info", "exclude"), readFileSync(extraExclude), { mode: 0o600 });
    const args = ["--git-dir", temporaryGit, "--work-tree", temporaryWorktree, "-c", `core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "check-ignore", "--no-index", "--verbose", "--", path];
    let customMatched;
    try {
      execFileSync("git", args, { stdio: ["ignore", "ignore", "ignore"] });
      customMatched = true;
    } catch (error) {
      if (exitStatus(error) !== 1) return "unknown";
      customMatched = false;
    }

    if (!customMatched) return standard;
    try {
      execFileSync("git", args.toSpliced(-3, 1, "--quiet"), { stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch (error) {
      return exitStatus(error) === 1 ? false : "unknown";
    }
  } catch {
    return "unknown";
  } finally {
    rmSync(temporaryWorktree, { recursive: true, force: true });
  }
}
/**
 * Ask Git to classify a path even when it does not exist yet. For the
 * optional runner ignore file, temporarily use Git's configured global
 * exclude slot so Git remains the pattern parser.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string|undefined} [extraExclude]
 * @returns {boolean|"unknown"}
 */
function checkGitIgnore(cwd, path, extraExclude) {
  const args = ["-C", cwd];
  if (extraExclude) args.push("-c", `core.excludesFile=${extraExclude}`);
  args.push("check-ignore", "--no-index", "--quiet", "--", path);
  try {
    execFileSync("git", args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch (error) {
    return exitStatus(error) === 1 ? false : "unknown";
  }
}
/**
 * @param {ValidatedNode} node
 * @param {number} index
 * @returns {string[]}
 */
export function commandCoverageWarnings(node, index) {
  if (!Array.isArray(node.definitionOfDone) || node.definitionOfDone.length === 0) return [];
  const dodText = node.definitionOfDone.map((item) => item.text).join("\n");
  const warnings = [];
  const lines = node.taskPacket.verification.map((command) => command.argv.join(" "));
  for (const line of lines) {
    const target = extractCommandTarget(line);
    if (target && !dodText.includes(target)) {
      warnings.push(`nodes[${index}] (${node.id}): command target "${target}" is not mentioned in any Definition of Done item`);
    }
  }
  return warnings;
}
/**
 * @param {string} line
 * @returns {string|null}
 */
function extractCommandTarget(line) {
  const trimmed = line.trim();
  const patterns = [
    [/^cargo test\b/u, /cargo test(?:\s+\S+)*\s+([a-z_]+::[a-z_:]+)/u],
    [/^pnpm exec vitest run\b/u, /vitest run\s+(\S+)/u],
    [/^(?:pnpm exec )?playwright test\b/u, /playwright test\s+(\S+)/u],
    [/^node\s+/u, /^node\s+(\S+\.(?:mjs|js))/u],
    [/^(?:pnpm|npm) run\s+/u, /^(?:pnpm|npm) run\s+(\S+)/u],
  ];
  for (const [trigger, extract] of patterns) {
    if (!trigger.test(trimmed)) continue;
    return extract.exec(trimmed)?.[1] ?? null;
  }
  return null;
}
