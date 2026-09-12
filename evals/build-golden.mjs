#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds `evals/golden/` from this repository's own git history — one task
 * directory per real commit, never a hand-written scenario — plus the
 * single shared `evals/golden/fixtures.bundle` every task's `meta.json`
 * points into. Regenerate with `node evals/build-golden.mjs`; the task list
 * and bundle it produces are a function of the repository's history and the
 * curated list below, not of anything typed by hand into `evals/golden/`
 * itself.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const GOLDEN_ROOT = join(REPO_ROOT, "evals", "golden");
const BUNDLE_PATH = join(GOLDEN_ROOT, "fixtures.bundle");

/**
 * The commits the intent-factory itself integrated into `main`, curated in
 * `docs/intent-factory/TECH-SPEC-2026-09-09.md` §C1.3. That list also names
 * `a32a2d8`, the candidate merge commit for `anthropic-soft-limit-fixture`;
 * it is dropped here because its first-parent diff is byte-identical to
 * `57a35d9` (the plain attempt commit for the same node, merged in one
 * commit later with nothing else changing that file) — keeping both would
 * give the golden set two tasks with the same statement and the same fix.
 */
const FACTORY_SHAS = [
  "b952c7bf5567f21ecef24fb05e291928b4d73110", // cli-usage-string
  "c528159166513ba1c77f8166266da2dfe8c6d506", // dead-export-sweep
  "9994efec96e73fb16e354a72fe858f83401a87ab", // split-runner-test
  "57a35d9dfb8ebb6b54b8e4d559abdf7eeb3ea3ac", // anthropic-soft-limit-fixture
  "772efa3aece4439fbd966e91f6df2684884383e1", // macos-process-start-token
  "124f34e75eb2b012c09ca24baf2ec2f8483ee0ba", // deepseek-balance-classification
  "f150386d2c9f9e3057617319652cb2c9c9262981", // lease-liveness-fold
];

/** Node fields in a `taskPacket`, per `skills/mine/intent-factory/src/contract/task-packet.mjs`. */
const FACTORY_MESSAGE_RE = /^intent-factory (?:candidate )?(\S+) (\S+) attempt (\d+)/u;

/**
 * @param {string[]} args
 * @returns {string}
 */
function runGit(args) {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(/** @type {{stderr: unknown}} */ (error).stderr) : "";
    if (stderr.trim()) /** @type {Error} */ (error).message = `${/** @type {Error} */ (error).message.split("\n")[0]}: ${stderr.trim()}`;
    throw error;
  }
}

/**
 * Every commit on `main` whose subject starts with `fix` and whose own
 * first-parent diff touches both `skills/mine/intent-factory/src/` and
 * `skills/mine/intent-factory/test/` — a correction landed together with
 * the test that pins it. Walked mechanically over the whole branch so the
 * pool is regenerable, never a hand-picked list.
 *
 * @returns {string[]}
 */
function discoverFixShas() {
  const shas = runGit(["log", "main", "--format=%H"]).split("\n").filter(Boolean);
  const picked = [];
  for (const sha of shas) {
    const subject = runGit(["log", "-1", "--format=%s", sha]);
    if (!/^fix/iu.test(subject)) continue;
    const parent = `${sha}^`;
    if (!gitRevExists(parent)) continue; // a root commit has no parent to diff against
    const files = diffNameStatus(parent, sha).map((entry) => entry.path);
    const touchesScripts = files.some((path) => path.startsWith("skills/mine/intent-factory/src/"));
    const touchesTest = files.some((path) => path.startsWith("skills/mine/intent-factory/test/"));
    if (touchesScripts && touchesTest) picked.push(sha);
  }
  return picked;
}

/** @param {string} rev @returns {boolean} */
function gitRevExists(rev) {
  try {
    runGit(["rev-parse", "--verify", "-q", rev]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} fromSha
 * @param {string} toSha
 * @returns {{status: string, path: string}[]}
 */
function diffNameStatus(fromSha, toSha) {
  return runGit(["diff", "--name-status", fromSha, toSha])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      return { status: fields[0], path: fields[fields.length - 1] };
    });
}

/**
 * @param {string} text
 * @returns {string}
 */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
}

/**
 * @param {string} sha
 * @param {string} subject
 * @returns {{taskId: string, runId: string|null, nodeId: string|null}}
 */
function identifyTask(sha, subject) {
  const match = FACTORY_MESSAGE_RE.exec(subject);
  if (match) return { taskId: slug(match[2]), runId: match[1], nodeId: match[2] };
  return { taskId: slug(subject.replace(/^fix\(intent-factory\):\s*/iu, "")), runId: null, nodeId: null };
}

/**
 * A node's `taskPacket`, read from the contract this repository still holds
 * at `.runs/<runId>/contract.json`, when that run directory survived. Most
 * runs this old have been pruned, in which case this returns `null` and the
 * caller falls back to the commit message — never a later, contaminating
 * rewrite of what the task actually asked for.
 *
 * @param {string|null} runId
 * @param {string|null} nodeId
 * @returns {unknown|null}
 */
function findTaskPacket(runId, nodeId) {
  if (!runId || !nodeId) return null;
  const contractPath = join(REPO_ROOT, ".runs", runId, "contract.json");
  if (!existsSync(contractPath)) return null;
  /** @type {{nodes?: {id?: string, taskPacket?: unknown}[]}} */
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    return null;
  }
  const node = Array.isArray(contract.nodes) ? contract.nodes.find((entry) => entry && entry.id === nodeId) : undefined;
  return node && node.taskPacket !== undefined ? node.taskPacket : null;
}

/**
 * Records of one JSONL artefact, same discipline as `evals/metrics.mjs`'s
 * own reader: a missing file or an unterminated final line reads as no
 * records, never a parse error.
 *
 * @param {string} path
 * @returns {Record<string, unknown>[]}
 */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  /** @type {Record<string, unknown>[]} */
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) continue;
    try {
      records.push(JSON.parse(lines[index]));
    } catch {
      // not a committed record either
    }
  }
  return records;
}

/**
 * A node's original runtime, cost and wall clock, read from the same run
 * directory's `events.jsonl`/`usage.jsonl` `findTaskPacket` just checked.
 * Any measurement with nothing to support it is `null`, never `0` — the
 * same rule `evals/metrics.mjs` follows for the campaign-level indicators.
 *
 * @param {string|null} runId
 * @param {string|null} nodeId
 * @returns {{runtime: string|null, costUsd: number|null, wallClockSec: number|null}}
 */
function findNodeMeta(runId, nodeId) {
  if (!runId || !nodeId) return { runtime: null, costUsd: null, wallClockSec: null };
  const runDir = join(REPO_ROOT, ".runs", runId);
  const events = readJsonl(join(runDir, "events.jsonl")).filter((event) => event.node === nodeId);
  const usage = readJsonl(join(runDir, "usage.jsonl")).filter((record) => record.nodeId === nodeId);
  const runtimes = events.filter((event) => event.phase === "worker" && typeof event.runtime === "string").map((event) => /** @type {string} */ (event.runtime));
  const runtime = runtimes.length > 0 ? runtimes[runtimes.length - 1] : null;
  const costRecords = usage.filter((record) => typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== "unknown");
  const costUsd = costRecords.length > 0 ? Math.round(costRecords.reduce((sum, record) => sum + /** @type {number} */ (record.costUsd), 0) * 10000) / 10000 : null;
  const timestamps = events.map((event) => Date.parse(/** @type {string} */ (event.at))).filter((atMs) => Number.isFinite(atMs));
  const wallClockSec = timestamps.length >= 2 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 1000 : null;
  return { runtime, costUsd, wallClockSec };
}

/**
 * `statement.md`'s content: the taskPacket exactly as recorded (serialized,
 * never paraphrased) when the run directory survived, otherwise the
 * commit's own message untouched.
 *
 * @param {string} sha
 * @param {unknown} packet
 * @returns {string}
 */
function statementFor(sha, packet) {
  if (packet !== null) {
    return `<!-- verbatim taskPacket recorded in .runs/<runId>/contract.json at commit time; not rewritten -->\n\n\`\`\`json\n${JSON.stringify(packet, null, 2)}\n\`\`\`\n`;
  }
  return `${runGit(["log", "-1", "--format=%B", sha]).replace(/\s+$/u, "")}\n`;
}

/**
 * `verify.json`'s commands when no taskPacket survived to name the node's
 * own declared verification: one `node --check` per non-test `.mjs` file
 * the commit touches (still present afterwards) and one `node --test` per
 * test file it touches — the same two checks `npm run check`/`npm test`
 * apply repository-wide, scoped to exactly what this commit changed.
 *
 * @param {string} parentSha
 * @param {string} sha
 * @returns {{argv: string[]}[]}
 */
function verifyCommandsFromDiff(parentSha, sha) {
  const commands = [];
  for (const { status, path } of diffNameStatus(parentSha, sha)) {
    if (status.startsWith("D") || !path.endsWith(".mjs")) continue;
    const isTest = path.endsWith(".test.mjs");
    commands.push({ argv: isTest ? ["node", "--test", path] : ["node", "--check", path] });
  }
  return commands;
}

/**
 * @param {unknown} packet
 * @returns {{source: "taskPacket", commands: unknown}|null}
 */
function verifyCommandsFromPacket(packet) {
  if (!packet || typeof packet !== "object") return null;
  const verification = /** @type {{verification?: unknown}} */ (packet).verification;
  if (!Array.isArray(verification) || verification.length === 0) return null;
  return { source: "taskPacket", commands: verification };
}

/**
 * @param {string} sha
 * @returns {{taskId: string, commitSha: string, parentSha: string, parentTreeSha: string, statement: string, verify: {source: string, commands: unknown}, meta: Record<string, unknown>}}
 */
function buildTask(sha) {
  const subject = runGit(["log", "-1", "--format=%s", sha]);
  const { taskId, runId, nodeId } = identifyTask(sha, subject);
  const parentSha = runGit(["rev-parse", `${sha}^`]);
  const parentTreeSha = runGit(["rev-parse", `${parentSha}^{tree}`]);
  const packet = findTaskPacket(runId, nodeId);
  const nodeMeta = findNodeMeta(runId, nodeId);
  const verify = verifyCommandsFromPacket(packet) ?? { source: "diff", commands: verifyCommandsFromDiff(parentSha, sha) };
  return {
    taskId,
    commitSha: sha,
    parentSha,
    parentTreeSha,
    statement: statementFor(sha, packet),
    verify,
    meta: {
      commitSha: sha,
      parentSha,
      runtimeOriginal: nodeMeta.runtime,
      costUsdOriginal: nodeMeta.costUsd,
      wallClockSecOriginal: nodeMeta.wallClockSec,
      statementSource: packet !== null ? "taskPacket" : "commit-message",
    },
  };
}

function main() {
  const shas = [...FACTORY_SHAS, ...discoverFixShas()];
  const fullShas = shas.map((sha) => runGit(["rev-parse", sha]));
  const uniqueShas = [...new Set(fullShas)];
  if (uniqueShas.length !== fullShas.length) throw new Error("duplicate commit sha in the selected pool");

  const tasks = uniqueShas.map((sha) => buildTask(sha));
  const seenIds = new Set();
  for (const task of tasks) {
    if (seenIds.has(task.taskId)) throw new Error(`duplicate task id: ${task.taskId} (${task.commitSha})`);
    seenIds.add(task.taskId);
  }

  rmSync(GOLDEN_ROOT, { recursive: true, force: true });
  mkdirSync(GOLDEN_ROOT, { recursive: true });
  for (const task of tasks) {
    const taskDir = join(GOLDEN_ROOT, task.taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "statement.md"), task.statement);
    writeFileSync(join(taskDir, "verify.json"), `${JSON.stringify(task.verify, null, 2)}\n`);
    writeFileSync(
      join(taskDir, "meta.json"),
      `${JSON.stringify({ ...task.meta, parentTreeSha: task.parentTreeSha }, null, 2)}\n`,
    );
  }

  buildBundle(tasks.map((task) => task.parentSha));

  process.stdout.write(`built ${tasks.length} golden tasks under ${GOLDEN_ROOT}\n`);
  for (const task of tasks) process.stdout.write(`  ${task.taskId} <- ${task.commitSha.slice(0, 7)} (parent ${task.parentSha.slice(0, 7)}, ${task.verify.source})\n`);
}

/**
 * One shared `fixtures.bundle` covering every task's parent commit. `git
 * bundle create` refuses a set of bare SHAs (it needs named refs to record),
 * so each unique parent gets a throwaway tag for the duration of the build
 * and none of them survive it — the bundle is the only artefact this
 * leaves behind.
 *
 * @param {string[]} parentShas
 */
function buildBundle(parentShas) {
  const uniqueParents = [...new Set(parentShas)];
  const tagNames = uniqueParents.map((sha, index) => `golden-build-tmp/${index}`);
  try {
    uniqueParents.forEach((sha, index) => runGit(["tag", "-f", tagNames[index], sha]));
    runGit(["bundle", "create", BUNDLE_PATH, ...tagNames]);
  } finally {
    for (const tagName of tagNames) {
      try {
        runGit(["tag", "-d", tagName]);
      } catch {
        // never created — leave it
      }
    }
  }
}

main();
