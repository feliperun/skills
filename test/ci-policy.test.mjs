import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
