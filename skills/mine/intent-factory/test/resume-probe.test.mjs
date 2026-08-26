import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, orphan, withFakeCodex, writeContract } from "./helpers.mjs";
import { resumeRun, runContract } from "../scripts/runner.mjs";

/** @param {import("../scripts/runner.mjs").RunOutcome} result @param {string} [id] @returns {import("../scripts/contract.mjs").NodeSnapshot} */
function nodeState(result, id = "build") {
  const state = result.states.get(id);
  if (!state) throw new Error(`missing node state for ${id}`);
  return state;
}

/**
 * A fake codex whose --version fails the first `failures` probe calls and then
 * reports a stable version. Any non-version invocation exits silently; the
 * adoption path never needs to spawn a turn.
 *
 * @param {{failures: number, version?: string}} options
 * @returns {string}
 */
function fakeCodexProbe(options) {
  const counterPath = join(mkdtempSync(join(tmpdir(), "runner-probe-counter-")), "probe-count");
  writeFileSync(counterPath, "0");
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-codex-")), "fake-codex-probe.mjs");
  writeFileSync(path, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const failFirst = ${JSON.stringify(options.failures)};
const version = ${JSON.stringify(options.version ?? "fake-codex 1.0.0")};
if (process.argv.includes("--version")) {
  let count = 0;
  try { count = Number(readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  writeFileSync(counterPath, String(count));
  if (count <= failFirst) {
    console.error("transient probe failure");
    process.exitCode = 1;
  } else {
    console.log(version);
  }
}
`);
  chmodSync(path, 0o755);
  return path;
}

test("resume retries a transient driver probe failure instead of refusing as drift", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-probe-transient-"));
  const path = writeContract(directory, fixture({ id: "probe-transient-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const flaky = fakeCodexProbe({ failures: 1 });
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = flaky;
  try {
    const resumed = await resumeRun(runDir);
    assert.equal(resumed.ok, true);
    assert.equal(nodeState(resumed).status, "done");
    assert.equal(nodeState(resumed).attempt, 1);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});

test("resume refuses with probe unavailability when the driver version stays unknown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-probe-unavailable-"));
  const path = writeContract(directory, fixture({ id: "probe-unavailable-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  await assert.rejects(
    () => withFakeCodex(directory, "version-fail", () => resumeRun(runDir)),
    /driver probe unavailable for luna; resume refused/u,
  );
});

test("resume still refuses concrete driver version changes as drift", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-probe-drift-"));
  const path = writeContract(directory, fixture({ id: "probe-drift-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const upgraded = fakeCodexProbe({ failures: 0, version: "fake-codex 9.9.9" });
  const previous = process.env.PLAN_RUNNER_CODEX_BIN;
  process.env.PLAN_RUNNER_CODEX_BIN = upgraded;
  try {
    await assert.rejects(
      () => resumeRun(runDir),
      /source drift detected in driverVersions/u,
    );
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_CODEX_BIN;
    else process.env.PLAN_RUNNER_CODEX_BIN = previous;
  }
});
