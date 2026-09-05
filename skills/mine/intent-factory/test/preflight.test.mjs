import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fakeCodex, fixture, writeContract } from "./helpers.mjs";
import {
  blockingChecks,
  checkDisk,
  checkGit,
  checkRuntimeBinaries,
  checkWorktree,
  environmentPreflight,
} from "../scripts/env-preflight.mjs";

const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));

const EXPECTED_CHECK_KEYS = ["costUsd", "detail", "driver", "executable", "id", "live", "liveStatus", "model", "ok", "usage", "version"];

/**
 * @param {string} directory
 * @param {string[]} extraArgs
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function preflightCli(directory, extraArgs) {
  const contractPath = writeContract(directory, fixture());
  const result = spawnSync(process.execPath, [runner, "preflight", ...extraArgs, contractPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      INTENT_FACTORY_CODEX_BIN: fakeCodex(directory),
      INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC: "120",
    },
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("preflight --static --json reports every check with live false", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-static-json-"));
  const result = preflightCli(directory, ["--static", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{schemaVersion: number, contractId: string, ok: boolean, checks: Record<string, unknown>[]}} */ (JSON.parse(result.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.contractId, "test-run");
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.length > 0, "expected at least one routed runtime check");
  for (const check of payload.checks) {
    assert.deepEqual(Object.keys(check).sort(), EXPECTED_CHECK_KEYS);
    assert.equal(check.live, false);
    assert.equal(check.liveStatus, null);
    assert.equal(check.usage, null);
    assert.equal(check.costUsd, null);
  }
});

test("preflight --json runs the live probe and reports usage per check", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-preflight-live-json-"));
  const result = preflightCli(directory, ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{schemaVersion: number, contractId: string, ok: boolean, checks: Record<string, unknown>[]}} */ (JSON.parse(result.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.contractId, "test-run");
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.length > 0, "expected at least one routed runtime check");
  for (const check of payload.checks) {
    assert.deepEqual(Object.keys(check).sort(), EXPECTED_CHECK_KEYS);
    assert.equal(check.live, true);
    assert.equal(check.liveStatus, "done");
    const usage = /** @type {{inputTokens: number}} */ (check.usage);
    assert.equal(typeof usage.inputTokens, "number");
  }
});

/**
 * @param {string} prefix
 * @param {string[][]} commands
 * @returns {string}
 */
function gitRepo(prefix, commands = []) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["-C", directory, "init", "-q"], { encoding: "utf8" });
  for (const args of commands) spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return directory;
}

/**
 * @param {string} executable
 * @returns {Map<string, {runtime: import("../scripts/contract.mjs").RuntimeSnapshot, requiredCapabilitySets: []}>}
 */
function routedRuntimes(executable) {
  const runtime = /** @type {import("../scripts/contract.mjs").RuntimeSnapshot} */ ({
    id: "luna",
    driver: "codex",
    executable,
    model: "gpt-5.6-luna",
  });
  return new Map([["luna", { runtime, requiredCapabilitySets: /** @type {[]} */ ([]) }]]);
}

test("preflight disk check fails below the configured free-space threshold", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-disk-"));
  const plenty = checkDisk(directory, 0);
  assert.equal(plenty.ok, true, plenty.detail);
  assert.equal(plenty.advisory, false);
  const starved = checkDisk(directory, Number.MAX_SAFE_INTEGER);
  assert.equal(starved.ok, false);
  assert.equal(starved.advisory, false, "a disk shortfall blocks a dispatch");
  assert.match(starved.detail, /free at least/u);
});

test("preflight git check accepts an unborn HEAD and rejects a missing cwd", () => {
  const directory = gitRepo("env-preflight-git-");
  const fresh = checkGit(directory);
  assert.equal(fresh.ok, true, fresh.detail);
  assert.match(fresh.detail, /no commit yet/u);
  const missing = checkGit(join(directory, "absent"));
  assert.equal(missing.ok, false);
  assert.equal(missing.advisory, false);
});

test("preflight worktree check is advisory when dirty and blocking mid-merge", () => {
  const directory = gitRepo("env-preflight-worktree-");
  assert.equal(checkWorktree(directory, false).ok, true, "a fresh repository is clean");
  writeFileSync(join(directory, "note.txt"), "dirt\n");
  const dirty = checkWorktree(directory, false);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.advisory, true, "a merely dirty tree never blocks a dispatch");
  const strict = checkWorktree(directory, true);
  assert.equal(strict.ok, false);
  assert.equal(strict.advisory, false, "INTENT_FACTORY_REQUIRE_CLEAN_WORKTREE makes dirt fatal");
  writeFileSync(join(directory, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
  const merging = checkWorktree(directory, false);
  assert.equal(merging.ok, false);
  assert.equal(merging.advisory, false);
  assert.match(merging.detail, /merge is in progress/u);
});

test("preflight runtime binary check requires a resolvable binary and a version", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-binary-"));
  const executable = fakeCodex(directory);
  const versioned = checkRuntimeBinaries(routedRuntimes(executable), { luna: "1.0.0" });
  assert.equal(versioned.ok, true, versioned.detail);
  assert.match(versioned.detail, /luna 1\.0\.0/u);
  const unversioned = checkRuntimeBinaries(routedRuntimes(executable), { luna: null });
  assert.equal(unversioned.ok, false);
  assert.equal(unversioned.advisory, false);
  assert.match(unversioned.detail, /reported no version/u);
  const absent = checkRuntimeBinaries(routedRuntimes(join(directory, "absent-bin")), { luna: "1.0.0" });
  assert.equal(absent.ok, false);
  assert.match(absent.detail, /not found on PATH/u);
});

test("preflight environment report blocks only on non-advisory failures", () => {
  const directory = gitRepo("env-preflight-report-");
  writeFileSync(join(directory, "note.txt"), "dirt\n");
  const runtimes = routedRuntimes(fakeCodex(directory));
  const ready = environmentPreflight({ cwd: directory, runtimes, driverVersions: { luna: "1.0.0" }, env: {} });
  assert.deepEqual(ready.checks.map((check) => check.name), ["disk", "git", "worktree", "runtime binaries"]);
  assert.equal(ready.ok, true, "a dirty worktree alone stays dispatchable");
  assert.deepEqual(blockingChecks(ready), []);
  const starved = environmentPreflight({
    cwd: directory,
    runtimes,
    driverVersions: { luna: null },
    env: { INTENT_FACTORY_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) },
  });
  assert.equal(starved.ok, false);
  assert.deepEqual(blockingChecks(starved).map((check) => check.name), ["disk", "runtime binaries"]);
});

test("preflight failure keeps the run materialized, evidenced, and resumable", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-resumable-"));
  const contractPath = writeContract(directory, fixture());
  const env = { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory) };
  const blocked = spawnSync(process.execPath, [runner, "run", contractPath], {
    encoding: "utf8",
    env: { ...env, INTENT_FACTORY_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) },
  });
  assert.equal(blocked.status, 1, blocked.stdout);
  assert.match(String(blocked.stderr), /env_preflight_failed/u);
  const runDir = join(directory, ".runs", "test-run");
  assert.ok(existsSync(join(runDir, "contract.json")), "the run stays materialized for a resume");
  const evidence = JSON.parse(readFileSync(join(runDir, "env-preflight.json"), "utf8"));
  assert.equal(evidence.ok, false);
  assert.deepEqual(evidence.checks.filter((/** @type {{ok: boolean, advisory: boolean}} */ check) => !check.ok && !check.advisory).map((/** @type {{name: string}} */ check) => check.name), ["disk"]);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "run.env-preflight-failed"), "the failure is durable run evidence");
  const persisted = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  for (const node of persisted.nodes) {
    assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8")).status, "pending", `node ${node.id} was dispatched`);
  }
  const resumed = spawnSync(process.execPath, [runner, "resume", runDir], { encoding: "utf8", env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(readFileSync(join(runDir, "env-preflight.json"), "utf8")).ok, true, "the resume re-checks the environment");
});

test("doctor reports the four environment checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-preflight-doctor-"));
  const contractPath = writeContract(directory, fixture());
  const result = spawnSync(process.execPath, [runner, "doctor", "--json", "--cwd", directory, contractPath], {
    encoding: "utf8",
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory) },
  });
  const payload = /** @type {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(result.stdout));
  const names = payload.checks.map((check) => check.name);
  for (const name of ["disk", "git", "worktree", "runtime binaries"]) {
    assert.ok(names.includes(name), `doctor is missing the ${name} check`);
  }
  const worktree = payload.checks.find((check) => check.name === "worktree");
  assert.equal(worktree?.ok, true, "an advisory worktree finding never fails doctor");
});
