import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fakeCodex, fixture, writeContract } from "./helpers.mjs";

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
