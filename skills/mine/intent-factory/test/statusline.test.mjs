import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(new URL("../statusline/claude-code.sh", import.meta.url));

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function makePointer(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-a",
    campaignId: "hb",
    state: "running",
    checkpoints: { done: 3, total: 7 },
    activeNode: "node-a",
    runtime: "codex",
    attention: null,
    generatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/**
 * Write the canonical pointer (key-sorted, compact, trailing newline) exactly
 * like the bounded writer does.
 *
 * @param {string} directory
 * @param {Record<string, unknown>} [overrides]
 * @returns {string}
 */
function writePointer(directory, overrides = {}) {
  const runsDir = join(directory, ".runs");
  mkdirSync(runsDir, { recursive: true });
  const path = join(runsDir, "status.json");
  writeFileSync(path, `${JSON.stringify(sortKeys(makePointer(overrides)))}\n`);
  return path;
}

/** @param {unknown} value @returns {unknown} */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const sorted = {};
  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
    sorted[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return sorted;
}

/**
 * Build the restricted PATH fixture: only sh, sed and awk, no jq and no date.
 *
 * @returns {{ binDir: string, env: NodeJS.ProcessEnv }}
 */
function restrictedEnv() {
  const binDir = mkdtempSync(join(tmpdir(), "if-statusline-bin-"));
  /** @type {[string, string[]][]} */
  const candidates = [
    ["sh", ["/bin/sh"]],
    ["sed", ["/usr/bin/sed", "/bin/sed"]],
    ["awk", ["/usr/bin/awk", "/bin/awk"]],
  ];
  for (const [name, sources] of candidates) {
    const source = sources.find((path) => existsSync(path));
    assert.ok(source !== undefined, `no ${name} binary found`);
    symlinkSync(source, join(binDir, name));
  }
  return { binDir, env: { PATH: binDir } };
}

/**
 * Run the status-line script with a fixture session JSON for `directory`.
 *
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} stdout
 */
function render(directory, env) {
  const result = spawnSync(scriptPath, [], {
    input: JSON.stringify({ cwd: directory, workspace: { current_dir: directory } }),
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** @param {string} stdout @returns {string} */
function singleLine(stdout) {
  assert.equal(stdout.endsWith("\n"), true, "exactly one line plus newline");
  const line = stdout.slice(0, -1);
  assert.equal(line.includes("\n"), false, "no embedded newline");
  return line;
}

test("statusline renders pointer fields with age when jq is present", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-render-"));
  const generatedAt = Math.floor(Date.now() / 1000) - 130;
  writePointer(directory, { generatedAt, attention: null });

  const expectedBefore = Math.floor((Date.now() / 1000 - generatedAt) / 60);
  const stdout = render(directory);
  const expectedAfter = Math.floor((Date.now() / 1000 - generatedAt) / 60);
  const line = singleLine(stdout);

  assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
  const age = /(\d+)m ago$/.exec(line);
  assert.ok(age !== null, line);
  const ageMinutes = Number(age[1]);
  assert.ok(ageMinutes === expectedBefore || ageMinutes === expectedAfter, `age ${ageMinutes} not in [${expectedBefore}, ${expectedAfter}]`);
});

test("statusline renders pointer attention text", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-attention-"));
  writePointer(directory, { attention: "waiting on the gate" });
  const line = singleLine(render(directory));
  assert.ok(line.startsWith("if hb running 3/7 node-a codex "), line);
  assert.ok(line.includes("· attention: waiting on the gate"), line);
});

test("statusline degrades to empty lines without jq, and omits age (no live clock)", () => {
  const { binDir, env } = restrictedEnv();
  assert.equal(existsSync(join(binDir, "jq")), false, "jq must be absent from the degrade PATH");
  assert.equal(existsSync(join(binDir, "date")), false, "date must be absent from the degrade PATH");

  const directory = mkdtempSync(join(tmpdir(), "if-statusline-degrade-"));
  writePointer(directory, { attention: "waiting on the gate" });
  const line = singleLine(render(directory, env));
  assert.equal(line, "if hb running 3/7 node-a codex · attention: waiting on the gate");

  const withoutRuns = mkdtempSync(join(tmpdir(), "if-statusline-none-"));
  assert.equal(render(withoutRuns, env), "\n");

  const brokenDir = mkdtempSync(join(tmpdir(), "if-statusline-broken-"));
  mkdirSync(join(brokenDir, ".runs"), { recursive: true });
  writeFileSync(join(brokenDir, ".runs", "status.json"), "not json at all\n");
  assert.equal(render(brokenDir, env), "\n");
});

test("statusline renders quoted or newline attention without corrupting state", () => {
  // A valid bounded attention may carry escapes such as \n and \"; the
  // renderer must show it faithfully on one line and never let it forge a
  // second state record.
  const attention = 'wait\nstate=done "quoted"';

  for (const mode of ["jq", "fallback"]) {
    const directory = mkdtempSync(join(tmpdir(), `if-statusline-attn-${mode}-`));
    writePointer(directory, { attention });
    const line = singleLine(render(directory, mode === "fallback" ? restrictedEnv().env : undefined));
    assert.ok(line.startsWith("if hb running 3/7 node-a codex"), line);
    assert.ok(line.includes('· attention: wait\\nstate=done \\"quoted\\"'), line);
  }
});

test("statusline degrades silently on a pointer larger than the read window", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-oversize-"));
  const path = writePointer(directory, { attention: null });

  // Valid JSON prefix followed by whitespace, pushed past the 1 KiB cap: the
  // size check and the read cap come from the same bounded mechanism, so the
  // renderer prints an empty line with exit 0.
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}${" ".repeat(2048)}`);
  assert.equal(render(directory), "\n");
});

test("statusline bounded output stays within 160 characters", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-bound-"));
  writePointer(directory, {
    campaignId: "c".repeat(128),
    runId: "r".repeat(128),
    activeNode: "n".repeat(128),
    runtime: "t".repeat(128),
    attention: "A".repeat(80),
  });
  const line = singleLine(render(directory));
  assert.ok(line.length <= 160, `rendered ${line.length} characters: ${line}`);
});

test("statusline truncates attention within the 160-character bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-attn-bound-"));
  writePointer(directory, {
    campaignId: "c".repeat(64),
    attention: "A".repeat(80),
  });
  const line = singleLine(render(directory));
  assert.ok(line.length <= 160, `rendered ${line.length} characters: ${line}`);
  assert.ok(line.includes("· attention: A"), "attention must appear on the rendered line");
  assert.equal(line.includes("A".repeat(80)), false, "attention must be truncated to fit the bound");
});

test("statusline renders with no external tool on PATH", () => {
  // The process budget is builtins plus jq plus one bounded-read process:
  // with an empty PATH none of them exists, and the builtin reader still
  // renders the line.
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-builtin-"));
  writePointer(directory, { attention: "waiting on the gate" });
  const line = singleLine(render(directory, { PATH: "" }));
  assert.equal(line, "if hb running 3/7 node-a codex · attention: waiting on the gate");
});

test("statusline degrades on an oversized pointer without jq", () => {
  const { env } = restrictedEnv();
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-oversize-nojq-"));
  const path = writePointer(directory, { attention: null });

  // Bytes beyond the single bounded line: the read window ends at that line,
  // so the file is not the bounded artifact and degrades.
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}${" ".repeat(2048)}`);
  assert.equal(render(directory, env), "\n");

  // One line already past the 1 KiB cap degrades with and without jq.
  writeFileSync(path, `${JSON.stringify(sortKeys(makePointer({ attention: "A".repeat(1200) })))}\n`);
  assert.equal(render(directory, env), "\n");
  assert.equal(render(directory), "\n");
});
