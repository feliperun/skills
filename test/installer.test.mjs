import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/skills.mjs", import.meta.url));

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} [extraEnv]
 */
function run(args, cwd, extraEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: /** @type {number | null} */ (result.status),
    stdout: /** @type {string} */ (result.stdout),
    stderr: /** @type {string} */ (result.stderr),
  };
}

test("installs the catalog into .claude/skills by default", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skills-install-"));
  const result = run([], cwd);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["intent-factory", "init-agentkit"]) {
    assert.ok(existsSync(join(cwd, ".claude", "skills", name, "SKILL.md")), `${name} missing`);
  }
  assert.match(result.stdout, /installed intent-factory/);
  assert.match(result.stdout, /installed init-agentkit/);
  assert.match(result.stdout, /2 installed, 0 skipped/);
});

test("installs only named skills", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skills-named-"));
  const result = run(["init-agentkit"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(cwd, ".claude", "skills", "init-agentkit", "SKILL.md")));
  assert.ok(!existsSync(join(cwd, ".claude", "skills", "intent-factory")));
});

test("keeps an existing skill unless --force", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skills-force-"));
  const skillDir = join(cwd, ".claude", "skills", "init-agentkit");
  run(["init-agentkit"], cwd);
  writeFileSync(join(skillDir, "SKILL.md"), "local edit\n");
  const kept = run(["init-agentkit"], cwd);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /skipped init-agentkit/);
  assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), "local edit\n");
  const forced = run(["init-agentkit", "--force"], cwd);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf8"), /^---\nname: init-agentkit/);
});

test("list prints skill names without bucket markers", () => {
  const result = run(["list"], tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /intent-factory/);
  assert.match(result.stdout, /init-agentkit/);
  assert.doesNotMatch(result.stdout, /mine|curated|community|⭐|💎/);
});

test("rejects unknown skills and unknown flags", () => {
  const unknown = run(["does-not-exist"], tmpdir());
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no skill named "does-not-exist"/);
  const flag = run(["--bogus"], tmpdir());
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /unknown flag/);
  const category = run(["--category", "mine"], tmpdir());
  assert.equal(category.status, 2);
  assert.match(category.stderr, /unknown flag --category/);
});

test("keeps help and version available", () => {
  const help = run(["--help"], tmpdir());
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage:/);
  assert.doesNotMatch(help.stdout, /category|curated|community/);
  const version = run(["--version"], tmpdir());
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("--global installs into the home skills directory", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-home-"));
  const result = run(["init-agentkit", "--global"], tmpdir(), { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(home, ".claude", "skills", "init-agentkit", "SKILL.md")));
});
