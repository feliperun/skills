/**
 * The golden task set: real commits from this repository's history, each with
 * the statement a model would be given and the tree it starts from.
 *
 * A task's parent commit is restored from one shared `fixtures.bundle`, and
 * `--verify-fixtures` proves the bundle reconstructs exactly the tree each task
 * recorded. Its `verify.json` is schema-checked and never executed: those
 * commands belong to the task's own parent commit, not to the current tree. See
 * `README.md`.
 */
import { EVALS_ROOT, usageError } from "./paths.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateVerificationCommands } from "../src/contract/verification.mjs";

/** @typedef {import("../src/notify/index.mjs").JsonObject} JsonObject */

const GOLDEN_ROOT = join(EVALS_ROOT, "golden");
const GOLDEN_BUNDLE_PATH = join(GOLDEN_ROOT, "fixtures.bundle");
/** Every task directory directly under `evals/golden/`, sorted for stable output. @returns {string[]} */
export function discoverGoldenTaskIds() {
  if (!existsSync(GOLDEN_ROOT)) return [];
  return readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
/**
 * `evals/run.mjs --validate-golden --min <n> [--json]`: fail unless the
 * golden set has at least `n` task directories and every one of them carries
 * `statement.md`, `verify.json` (a well-formed argv command list, the same
 * shape `validateVerificationCommands` enforces on a real contract's
 * `taskPacket.verification`), and `meta.json` naming the commit and its
 * parent.
 *
 * @param {string[]} rest
 * @returns {void}
 */
export function runValidateGolden(rest) {
  const asJson = rest.includes("--json");
  const minIndex = rest.indexOf("--min");
  if (minIndex === -1 || rest[minIndex + 1] === undefined) {
    usageError("--validate-golden needs --min <n>");
    return;
  }
  const min = Number(rest[minIndex + 1]);
  if (!Number.isInteger(min) || min < 0) {
    usageError(`--min must be a non-negative integer: ${rest[minIndex + 1]}`);
    return;
  }

  const taskIds = discoverGoldenTaskIds();
  /** @type {string[]} */
  const failures = [];
  for (const taskId of taskIds) {
    const taskDir = join(GOLDEN_ROOT, taskId);
    for (const file of ["statement.md", "verify.json", "meta.json"]) {
      if (!existsSync(join(taskDir, file))) failures.push(`${taskId}: missing ${file}`);
    }
    const verifyPath = join(taskDir, "verify.json");
    if (existsSync(verifyPath)) {
      try {
        const verify = /** @type {{commands?: unknown}} */ (JSON.parse(readFileSync(verifyPath, "utf8")));
        validateVerificationCommands(verify.commands, `${taskId}/verify.json.commands`);
      } catch (error) {
        failures.push(`${taskId}: invalid verify.json (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const metaPath = join(taskDir, "meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = /** @type {JsonObject} */ (JSON.parse(readFileSync(metaPath, "utf8")));
        if (typeof meta.commitSha !== "string" || !meta.commitSha) failures.push(`${taskId}: meta.json.commitSha missing`);
        if (typeof meta.parentSha !== "string" || !meta.parentSha) failures.push(`${taskId}: meta.json.parentSha missing`);
      } catch (error) {
        failures.push(`${taskId}: invalid meta.json (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  if (taskIds.length < min) failures.unshift(`only ${taskIds.length} golden task(s) found, need at least ${min}`);

  const ok = failures.length === 0;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok, min, count: taskIds.length, failures }, null, 2)}\n`);
  } else if (ok) {
    process.stdout.write(`ok: ${taskIds.length} golden tasks, all complete (min ${min})\n`);
  } else {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
  }
  if (!ok) process.exitCode = 1;
}
/**
 * `evals/run.mjs --verify-fixtures [--json]`: restore each golden task's
 * parent commit from the one shared `evals/golden/fixtures.bundle` and
 * confirm the restored tree matches the tree `meta.json` recorded at build
 * time — proof the bundle actually reconstructs what every task claims,
 * not just that the file is present. Nothing is written to a working tree:
 * fetching the parent commit's objects into a throwaway bare repository and
 * comparing tree ids is enough to prove the restore, and is far cheaper
 * than materializing 26 checkouts.
 *
 * @param {string[]} rest
 * @returns {void}
 */
export function runVerifyFixtures(rest) {
  const asJson = rest.includes("--json");
  const taskIds = discoverGoldenTaskIds();
  if (!existsSync(GOLDEN_BUNDLE_PATH)) {
    usageError(`--verify-fixtures needs ${GOLDEN_BUNDLE_PATH}`);
    return;
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "evals-golden-verify-"));
  /** @type {{taskId: string, ok: boolean, reason?: string}[]} */
  const results = [];
  try {
    execFileSync("git", ["init", "-q", "--bare", tmpRoot], { stdio: ["ignore", "pipe", "pipe"] });
    for (const taskId of taskIds) {
      const metaPath = join(GOLDEN_ROOT, taskId, "meta.json");
      if (!existsSync(metaPath)) {
        results.push({ taskId, ok: false, reason: "missing meta.json" });
        continue;
      }
      /** @type {JsonObject} */
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const parentSha = /** @type {string} */ (meta.parentSha);
      const expectedTreeSha = /** @type {string} */ (meta.parentTreeSha);
      if (typeof parentSha !== "string" || typeof expectedTreeSha !== "string") {
        results.push({ taskId, ok: false, reason: "meta.json missing parentSha or parentTreeSha" });
        continue;
      }
      try {
        execFileSync("git", ["-C", tmpRoot, "fetch", "-q", GOLDEN_BUNDLE_PATH, parentSha], { stdio: ["ignore", "pipe", "pipe"] });
        const restoredTreeSha = execFileSync("git", ["-C", tmpRoot, "rev-parse", `${parentSha}^{tree}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (restoredTreeSha !== expectedTreeSha) {
          results.push({ taskId, ok: false, reason: `restored tree ${restoredTreeSha} does not match meta.json's ${expectedTreeSha}` });
        } else {
          results.push({ taskId, ok: true });
        }
      } catch (error) {
        results.push({ taskId, ok: false, reason: error instanceof Error ? error.message.split("\n")[0] : String(error) });
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const ok = results.length > 0 && results.every((result) => result.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  } else {
    for (const result of results) process.stdout.write(`${result.ok ? "[ok]" : "[fail]"} ${result.taskId}${result.reason ? ` — ${result.reason}` : ""}\n`);
  }
  if (!ok) process.exitCode = 1;
}
