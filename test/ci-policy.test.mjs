import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITLINT = join(ROOT, "node_modules", ".bin", "commitlint");
const COMMIT_MSG_HOOK = join(ROOT, ".husky", "commit-msg");

/** @param {string} rel */
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** @param {string} yaml @param {string} key */
function matrixList(yaml, key) {
  const found = yaml.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]+)\\]`, "m"));
  assert.ok(found, `missing matrix key "${key}"`);
  return found[1].split(",").map((v) => v.trim().replace(/"/g, ""));
}

/** @param {string} yaml */
const runSteps = (yaml) =>
  [...yaml.matchAll(/- run:\s*(.+)$/gm)].map((m) => m[1].trim());

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  return {
    status: /** @type {number | null} */ (result.status),
    stderr: /** @type {string} */ (result.stderr),
  };
}

/** @param {string} message */
function messageFile(message) {
  const file = join(mkdtempSync(join(tmpdir(), "ci-policy-")), "MESSAGE");
  writeFileSync(file, message);
  return file;
}

const SCRIPTS_DIR = join(ROOT, "skills", "mine", "intent-factory", "scripts");

/** @returns {string[]} production .mjs paths under SCRIPTS_DIR, relative with forward slashes */
function productionScriptFiles() {
  /** @type {string[]} */
  const files = [];
  /**
   * @param {string} dir
   */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        files.push(relative(SCRIPTS_DIR, path));
      }
    }
  };
  walk(SCRIPTS_DIR);
  return files;
}

// ratchet — lower the ceiling whenever the count drops; never raise it (spec rule 4)
const EMPTY_CATCH_CEILING = 32;

// ratchet — ceilings only decrease (spec section 9.1)
/** @type {Record<string, number>} */
const LINE_CEILINGS = {
  "runner.mjs": 7200,
  "contract.mjs": 1700,
  "campaign-autonomy.mjs": 1550,
  "campaign.mjs": 1300,
  "heartbeat.mjs": 650,
  "drivers/exec-jsonl.mjs": 1250,
};
const DEFAULT_LINE_CEILING = 900;

const VALID_MESSAGE = "feat(ci): add policy gates\n\nBody line.\n";
const INVALID_MESSAGE = "bad message\n";

test("ci.yml runs the required matrix on push to main and pull_request", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(ci, /pull_request:/);
  assert.deepEqual(matrixList(ci, "os"), ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(matrixList(ci, "node"), ["22", "24"]);
  assert.deepEqual(runSteps(ci), ["npm ci", "npm run check", "npm run typecheck", "npm test"]);
});

test("pr-policy.yml is scoped to main pull requests and merge groups", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /pull_request:\s*\n\s*branches:\s*\[main\]/);
  assert.match(policy, /merge_group:\s*\n\s*branches:\s*\[main\]/);
  assert.doesNotMatch(policy, /push:/);
});

test("pr-policy.yml rejects a blank PR body", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /PR body is blank/);
  assert.match(policy, /tr -d '\[:space:\]'/);
});

test("pr-policy.yml validates title plus body as the squash commit message", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(policy, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.match(policy, /printf '%s\\n\\n%s\\n' "\$PR_TITLE" "\$PR_BODY"/);
  assert.match(policy, /commitlint --edit/);
});

test("pr-policy.yml validates every non-merge candidate commit", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /--no-merges[^\n]*origin\/main\.\.HEAD/);
  assert.match(policy, /commitlint --edit "\$f"/);
});

test("commitlint extends the conventional config and enforces it offline", async () => {
  const config = await import(new URL("../commitlint.config.mjs", import.meta.url).href);
  assert.deepEqual(config.default.extends, ["@commitlint/config-conventional"]);
  const good = run(COMMITLINT, ["--edit", messageFile(VALID_MESSAGE)]);
  assert.equal(good.status, 0, good.stderr);
  const bad = run(COMMITLINT, ["--edit", messageFile(INVALID_MESSAGE)]);
  assert.notEqual(bad.status, 0);
});

test("package.json wires husky and keeps runtime dependencies at zero", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.prepare, "husky");
  for (const dep of ["@commitlint/cli", "@commitlint/config-conventional", "husky"]) {
    assert.ok(pkg.devDependencies[dep], `devDependency ${dep} missing`);
  }
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test("hooks are wired, executable, and enforce Conventional Commits", () => {
  for (const hook of [".husky/pre-commit", ".husky/commit-msg"]) {
    accessSync(join(ROOT, hook), constants.X_OK);
  }
  assert.match(read(".husky/pre-commit"), /set -eu\b/);
  assert.match(read(".husky/pre-commit"), /npm run check/);
  assert.match(read(".husky/commit-msg"), /commitlint --edit "\$1"/);
  const good = run(COMMIT_MSG_HOOK, [messageFile(VALID_MESSAGE)]);
  assert.equal(good.status, 0, good.stderr);
  const bad = run(COMMIT_MSG_HOOK, [messageFile(INVALID_MESSAGE)]);
  assert.notEqual(bad.status, 0);
});

test("AGENT.md, CLAUDE.md, CURSOR.md and GEMINI.md stay symlinks to AGENTS.md", () => {
  const names = ["AGENT.md", "CLAUDE.md", "CURSOR.md", "GEMINI.md"];
  const result = spawnSync("git", ["ls-files", "-s", ...names], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 4, `expected 4 symlink entries, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^120000 /);
  }
  for (const name of names) {
    assert.equal(readlinkSync(join(ROOT, name)), "AGENTS.md");
  }
});

test("empty catch blocks in production scripts never increase", () => {
  let count = 0;
  for (const rel of productionScriptFiles()) {
    const contents = readFileSync(join(SCRIPTS_DIR, rel), "utf8");
    count += (contents.match(/catch\s*\{\s*\}/g) ?? []).length;
  }
  assert.ok(count <= EMPTY_CATCH_CEILING, `${count} empty catch blocks exceed ceiling ${EMPTY_CATCH_CEILING}`);
});

test("production script line counts stay at or below their ratchet ceilings", () => {
  for (const rel of productionScriptFiles()) {
    const lines = readFileSync(join(SCRIPTS_DIR, rel), "utf8").split("\n").length;
    const ceiling = LINE_CEILINGS[rel] ?? DEFAULT_LINE_CEILING;
    assert.ok(lines <= ceiling, `${rel}: ${lines} lines exceeds ceiling ${ceiling}`);
  }
});
