import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderFindings, renderReport, renderStatus, validateContract } from "../scripts/lib.mjs";
import { INTENT_FACTORY_VERSION } from "../scripts/contract.mjs";
import { renderStatusJson } from "../scripts/render.mjs";
import { runContract, resumeRun } from "../scripts/runner.mjs";
import { invocationAlive } from "../scripts/node.mjs";
import { processStartToken } from "../scripts/lock.mjs";
import { bootstrapAckPath, bootstrapAttemptPath, bootstrapPath, cleanupBootstrapAttempts, writeJsonAtomic } from "../scripts/store.mjs";
import { delay, fakeCodex, fixture, orphan, packet, readStatus, waitForValue, withFakeCodex, writeContract } from "./helpers.mjs";
import { nodeState, notifications, withAdvisoryGateCodex, withBrokenGateCodex, RUNNER_CLI } from "./runner-helpers.mjs";



test("runs the CLI through an installed symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-symlink-"));
  const contractPath = writeContract(directory, fixture({
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["build"], gate: false },
    ],
  }));
  const link = join(directory, "runner-link.mjs");
  symlinkSync(fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, "validate", contractPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "valid\n");
});


test("doctor checks repository prerequisites without mutating anything", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  execFileSync("git", ["-C", directory, "add", ".gitignore"]);
  execFileSync("git", ["-C", directory, "-c", "user.email=doctor@example.test", "-c", "user.name=doctor", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  const cli = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  const payload = /** @type {{schemaVersion: number, ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  const names = payload.checks.map((check) => check.name);
  assert.ok(names.includes("git repository"));
  assert.ok(names.includes(".runs ignored"));
  const runsIgnored = payload.checks.find((check) => check.name === ".runs ignored");
  assert.ok(runsIgnored, ".runs ignored check present");
  assert.equal(runsIgnored.ok, true);
  assert.equal(payload.checks.some((check) => check.detail.includes("required by contract")), false, "no contract means no required harness");
  assert.equal(readdirSync(directory).sort().join(","), ".git,.gitignore", "doctor creates no run state");
});


test("doctor reports an unborn repository as a failing git check", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-unborn-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const cli = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory], { encoding: "utf8" });
  const payload = /** @type {{schemaVersion: number, ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.ok, false, "an unborn repository must not report doctor as healthy");
  const gitCheck = payload.checks.find((check) => check.name === "git");
  assert.ok(gitCheck, "git check present");
  assert.equal(gitCheck.ok, false);
  assert.match(gitCheck.detail, /at least one commit/u);
  assert.equal(readdirSync(directory).sort().join(","), ".git,.gitignore", "doctor creates no run state");
});


test("doctor does not fail a harness resolved through an explicit executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-doctor-override-"));
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  execFileSync("git", ["-C", directory, "add", ".gitignore"]);
  execFileSync("git", ["-C", directory, "-c", "user.email=doctor@example.test", "-c", "user.name=doctor", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  const cli = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const worker = join(directory, "my-worker.mjs");
  writeFileSync(worker, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('my-worker 1.0.0');\n");
  chmodSync(worker, 0o755);
  const contract = join(directory, "contract.json");
  writeFileSync(contract, `${JSON.stringify({
    schemaVersion: 3,
    contractVersion: INTENT_FACTORY_VERSION,
    id: "doctor-run",
    campaignId: "doctor-campaign",
    goal: "doctor",
    cwd: ".",
    runtimeDefaults: { worker: "wrapped", judge: "wrapped" },
    runtimes: { wrapped: { harness: "exec-jsonl", model: "m", vendor: "wrapped-vendor", executable: "./my-worker.mjs" } },
    nodes: [{ id: "build", type: "backend", phase: "doctor", dependsOn: [], taskPacket: packet(), gate: false }],
  })}\n`);
  const text = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", directory, contract], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const payload = /** @type {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(text.stdout));
  assert.equal(payload.ok, true);
  const binaryCheck = payload.checks.find((check) => check.name === "binary exec-jsonl");
  assert.ok(binaryCheck, "exec-jsonl binary check present");
  assert.equal(binaryCheck.ok, true);
  assert.match(binaryCheck.detail, /override/u);
});


test("status --json and report --json emit stable machine-readable output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-json-status-"));
  const path = writeContract(directory, fixture({
    id: "json-status-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const cli = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const status = spawnSync(process.execPath, [cli, "status", "--json", runDir], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.schemaVersion, 1);
  assert.equal(statusPayload.run, "json-status-run");
  assert.equal(statusPayload.controller.state, "none");
  assert.equal(statusPayload.nodes[0].status, "done");
  const report = spawnSync(process.execPath, [cli, "report", "--json", runDir], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  const reportPayload = JSON.parse(report.stdout);
  assert.equal(reportPayload.schemaVersion, 1);
  assert.equal(reportPayload.totals.inputTokens, 10);
  assert.equal(reportPayload.nodes[0].revisions, 0);
});


test("incident freeze rejects resume mutations while status and report remain readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-incident-freeze-"));
  const path = writeContract(directory, fixture({ id: "incident-freeze-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  writeFileSync(join(runDir, "incident-freeze.json"), "{}\n");
  await assert.rejects(
    () => resumeRun(runDir),
    (error) => error instanceof Error && /** @type {{code?: string}} */ (error).code === "incident_frozen",
  );
  const cli = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  for (const command of ["status", "report"]) {
    const result = spawnSync(process.execPath, [cli, command, "--json", runDir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
  }
});


test("cancel subcommand terminates a stale running node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-cli-"));
  const path = writeContract(directory, fixture({
    id: "cancel-cli-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const cli = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "cancel", runDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const node = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(node.status, "canceled");
  assert.equal(readFileSync(join(runDir, "cancel.request.json"), "utf8").length > 0, true);
});


test("run --detach leaves a controller that outlives the invoker and completes the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-detach-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "run", "--detach", contractPath], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/\[run\] ([a-z0-9-]+) detached · pid (\d+) · (.+)/u);
  assert.ok(match, result.stdout);
  assert.equal(match[1], contract.id);
  assert.equal(match[3], runDir);
  const pid = Number(match[2]);
  try {
    // The invoker is already gone; the controller must still be alive while the run is in flight.
    const alive = await waitForValue(() => {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch {
        return readStatus(nodePath) === "done" ? "done" : null;
      }
    }, 10_000);
    assert.ok(alive === "alive" || alive === "done", `detached controller died while the run was in flight: ${alive}`);
    assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
    assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).pid, pid);
  } finally {
    cleanupBootstrapAttempts(runDir);
    const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    if (invocationAlive({ pid, processStartToken: metadata.processStartToken })) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});


test("resume --detach restarts a failed node through a detached controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-detach-resume-"));
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(contract.cwd, ".runs", contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  await withFakeCodex(directory, "worker-fail", () => runContract(contractPath));
  assert.equal(readStatus(nodePath), "failed");
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[resume\] detached · pid \d+ · .*/u);
  assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000), "done");
});


test("status separates a live running node from an orphaned one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-"));
  const path = writeContract(directory, fixture({ id: "orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  assert.match(renderStatus(runDir), /build still claims to be running/u);

  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    schemaVersion: 3,
    contractVersion: INTENT_FACTORY_VERSION,
    pid: 2_147_483_647,
    startedAt: "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run", contractId: "orphan-run", campaignId: "test-campaign" },
  }));
  assert.match(renderStatus(runDir), /build still claims to be running/u);
});


test("status --json flags an orphaned running node with controller state none", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-orphan-json-"));
  const path = writeContract(directory, fixture({ id: "orphan-json-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const payload = /** @type {{controller: {state: string}, summary: string, nodes: {id: string, status: string}[]}} */ (JSON.parse(renderStatusJson(runDir)));
  assert.equal(payload.controller.state, "none", "a missing controller lock while a node claims running must be machine-readable");
  assert.equal(payload.nodes.find((node) => node.id === "build")?.status, "running");
});


test("status and resume reject unknown persisted protocol fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-validation-"));
  const path = writeContract(directory, fixture({ id: "persisted-validation-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({ ...node, typo: true }));
  assert.throws(() => renderStatus(runDir), /node snapshot has unexpected field typo/u);
  writeFileSync(nodePath, JSON.stringify(node));
  writeFileSync(nodePath, JSON.stringify({ ...node, id: "other" }));
  assert.throws(() => renderStatus(runDir), /node snapshot\.id does not match/u);
  assert.throws(() => renderReport(runDir), /node snapshot\.id does not match/u);
  assert.throws(() => renderFindings(runDir), /node snapshot\.id does not match/u);
  await assert.rejects(() => resumeRun(runDir), /node snapshot\.id does not match/u);
  writeFileSync(nodePath, JSON.stringify(node));

  const runPath = join(runDir, "run.json");
  const metadata = JSON.parse(readFileSync(runPath, "utf8"));
  writeFileSync(runPath, JSON.stringify({ ...metadata, typo: true }));
  assert.throws(() => renderStatus(runDir), /run metadata has unexpected field typo/u);
  await assert.rejects(() => resumeRun(runDir), /run metadata has unexpected field typo/u);
});


test("report aggregates per-node status, attempts, revisions, and tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-report-"));
  const path = writeContract(directory, fixture({
    id: "report-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  const report = renderReport(runDir);
  assert.match(report, /1 nodes · 1 done/u);
  // The node ends on its judge runtime, and tokens sum worker plus judge.
  assert.match(report, /build\s+done\s+1\s+0\s+codex\/gpt-5\.6-sol/u);
  assert.match(report, /totals · in 20 · out 4 · cache -/u);
});


test("events record attempt, runtime, and gate verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-events-"));
  const path = writeContract(directory, fixture({
    id: "events-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const started = events.find((event) => event.to === "running" && event.phase === "worker");
  assert.equal(started.attempt, 1);
  assert.equal(started.runtime, "luna");
  const rejected = events.find((event) => event.to === "exhausted");
  assert.equal(rejected.verdict, "fail");
  assert.equal(rejected.error, "revision_cap");
  assert.equal(rejected.phase, "judge");
});


test("runner notifies node.terminal and run.terminal only, never a running node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-progress-emission-"));
  const path = writeContract(directory, fixture({
    id: "progress-emission-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const notifier = join(directory, "notify-success.mjs");
  writeFileSync(notifier, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  chmodSync(notifier, 0o755);
  const previousNotify = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  let result;
  try {
    result = await withFakeCodex(directory, "pass", () => runContract(path));
  } finally {
    if (previousNotify === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previousNotify;
  }
  assert.equal(result.ok, true);
  const receipts = notifications(result.runDir);
  assert.deepEqual(receipts.map((event) => event.type), ["node.terminal", "run.terminal"]);
  assert.deepEqual(receipts.map((event) => event.status), ["delivered", "delivered"]);
  // The template renders counters and identifiers only, never a model note.
  assert.equal(receipts[0].summary, "node build done · run progress-emission-run · attempt 1");
  assert.equal(receipts[0].nodeId, "build");
  assert.equal(receipts[0].nodeStatus, "done");
  assert.equal(receipts[0].errorCode, null);
  assert.equal(receipts[1].summary, "run progress-emission-run done · 1/1 nodes");
  assert.deepEqual([receipts[1].done, receipts[1].total], [1, 1]);
});


test("idle polls emit no notification, and resume never re-notifies an already-terminal node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-progress-idle-"));
  const path = writeContract(directory, fixture({
    id: "progress-idle-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const started = join(directory, ".runs", "provider-started");
  const release = join(directory, ".runs", "provider-release");
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  process.env.INTENT_FACTORY_CODEX_BIN = fakeCodex(directory, "wait-for-release");
  try {
    const pending = runContract(path);
    await waitForValue(() => (existsSync(started) ? "started" : null));
    // Let several controller polls pass while the node stays running: idle
    // passes must not create any notify.jsonl entry.
    await delay(200);
    assert.equal(existsSync(join(directory, ".runs", "progress-idle-run", "notify.jsonl")), false, "a running node emits no notification");
    writeFileSync(release, "release");
    const runDir = (await pending).runDir;
    let receipts = notifications(runDir);
    assert.deepEqual(receipts.map((event) => event.type), ["node.terminal", "run.terminal"]);

    // Rewind the finished node to running and resume. The provider that would
    // fail any fresh worker proves the result is adopted, and the node's
    // terminal notification must not be sent a second time.
    orphan(runDir, "build");
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    assert.equal(resumed.ok, true);
    assert.equal(nodeState(resumed).status, "done");
    receipts = notifications(runDir);
    assert.equal(receipts.filter((event) => event.type === "node.terminal").length, 1, "resume must not duplicate the node's terminal notification");
    assert.equal(receipts.filter((event) => event.type === "run.terminal").length, 1, "resume must not duplicate the run's terminal notification");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
  }
});


test("a finished run prints the token report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-auto-report-"));
  const path = writeContract(directory, fixture({ pollIntervalMs: 10 }));
  const runner = fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url));
  const result = await withFakeCodex(directory, "pass", () => spawnSync(process.execPath, [runner, "run", path], { encoding: "utf8" }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /totals · in 10/u, "auto-report table");
  assert.match(result.stdout, /worker complete/u, "node note surfaces the worker summary");
});


test("ordinary runs deliver bounded node and run terminal notifications", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-run-notifications-"));
  const path = writeContract(directory, fixture({ id: "run-notifications", pollIntervalMs: 10 }));
  const delivered = join(directory, "delivered.jsonl");
  const notifier = join(directory, "notify.mjs");
  writeFileSync(notifier, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(delivered)}, input); });\n`);
  chmodSync(notifier, 0o755);
  const previous = process.env.INTENT_FACTORY_NOTIFY_BIN;
  process.env.INTENT_FACTORY_NOTIFY_BIN = notifier;
  try {
    const result = await withFakeCodex(directory, "pass", () => runContract(path));
    const events = readFileSync(delivered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "node.terminal" && event.nodeId === "build"));
    assert.ok(events.some((event) => event.type === "run.terminal" && event.runId === "run-notifications"));
    const receipts = notifications(result.runDir);
    assert.ok(receipts.every((receipt) => receipt.status === "delivered"), "every event this transport received is recorded delivered");
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_NOTIFY_BIN;
    else process.env.INTENT_FACTORY_NOTIFY_BIN = previous;
  }
});

test("run warns when a node id is already done in another run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-guard-"));
  const firstPath = writeContract(directory, fixture({ id: "first-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));

  const secondPath = writeContract(directory, fixture({ id: "second-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "run", secondPath], {
      encoding: "utf8",
    }),
  );
  assert.match(result.stdout, /\[warn\] node build is already done in run first-run/u);
});


test("run warnings ignore an unrelated historical run with an obsolete contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-obsolete-"));
  const currentPath = writeContract(directory, fixture({ id: "current-run", pollIntervalMs: 10 }));
  const obsoleteRun = join(directory, ".runs", "obsolete-run");
  mkdirSync(join(obsoleteRun, "nodes"), { recursive: true });
  writeFileSync(join(obsoleteRun, "contract.json"), "{ this is obsolete and invalid JSON\n");
  writeFileSync(join(obsoleteRun, "nodes", "old-node.json"), "{}\n");
  const result = await withFakeCodex(directory, "pass", () => spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "run", currentPath],
    { encoding: "utf8" },
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /obsolete-run/u);
});


test("run warnings ignore a historical snapshot from an older capability schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-rerun-old-snapshot-"));
  const firstPath = writeContract(directory, fixture({ id: "old-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(firstPath));
  const oldNodePath = join(directory, ".runs", "old-run", "nodes", "build.json");
  const oldNode = JSON.parse(readFileSync(oldNodePath, "utf8"));
  delete oldNode.runtime.capabilities.toolPolicy;
  writeFileSync(oldNodePath, `${JSON.stringify(oldNode)}\n`);

  const secondPath = writeContract(directory, fixture({ id: "current-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "run", secondPath],
    { encoding: "utf8" },
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /old-run/u);
});



test("detached resume surfaces bootstrap failure before reporting success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-failure-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-failure-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  metadata.sourceIdentity.cwd = "/unexpected-source";
  writeFileSync(join(runDir, "run.json"), JSON.stringify(metadata));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "resume", "--detach", runDir], {
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source drift detected in cwd/u);
  const bootstrapFailed = await waitForValue(
    () => {
      try { return readFileSync(join(runDir, "bootstrap.json"), "utf8").includes('"status": "failed"') ? "failed" : null; } catch { return null; }
    },
    15_000,
  );
  assert.equal(bootstrapFailed, "failed");
  assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith("bootstrap.json.")), [], "failed detached attempts are cleaned up");
});


test("bootstrap attempt cleanup leaves concurrent failure temp writes intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-cleanup-race-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-cleanup-race-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const temporary = join(runDir, `bootstrap.json.${process.pid}.7a6b4a44-77a7-47a7-97a7-7a7a7a7a7a7a.tmp`);
  const staleAttempt = bootstrapAttemptPath(runDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  writeFileSync(temporary, JSON.stringify({ status: "failed" }));
  writeFileSync(staleAttempt, "{}");
  cleanupBootstrapAttempts(runDir);
  assert.equal(existsSync(staleAttempt), false);
  assert.equal(existsSync(temporary), true);
  renameSync(temporary, bootstrapPath(runDir));
  assert.equal(JSON.parse(readFileSync(bootstrapPath(runDir), "utf8")).status, "failed");
});


test("detached ACK timeout and parse errors clean only their nonce attempt and ACK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-ack-cleanup-"));
  const path = writeContract(directory, fixture({ id: "bootstrap-ack-cleanup-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const errorNonce = "11111111-1111-4111-8111-111111111111";
  writeFileSync(bootstrapAckPath(runDir, errorNonce), "not json\n");
  const errorResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: errorNonce, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.notEqual(errorResult.status, 0);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${errorNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, errorNonce)), false);

  const timeoutNonce = "22222222-2222-4222-8222-222222222222";
  const timeoutResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/runner.mjs", import.meta.url)), "resume", runDir],
    { env: { ...process.env, INTENT_FACTORY_BOOTSTRAP_NONCE: timeoutNonce, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") }, encoding: "utf8" },
  );
  assert.equal(timeoutResult.status, 0, timeoutResult.stderr);
  assert.equal(existsSync(join(runDir, `bootstrap.json.${timeoutNonce}`)), false);
  assert.equal(existsSync(bootstrapAckPath(runDir, timeoutNonce)), false);
});


test("a single-node contract validates without warning and contract prune is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-single-node-"));
  const serial = writeContract(directory, fixture({ id: "single-node-run" }));

  for (const argv of [["validate", serial], ["contract", "validate", serial]]) {
    const result = spawnSync(process.execPath, [RUNNER_CLI, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "valid\n", "a single-node contract is simply valid");
  }

  const contractPath = join(directory, "targeted.json");
  writeJsonAtomic(contractPath, fixture({ id: "targeted-field-run", nodes: [{ id: "build", type: "backend", targetedFix: true, taskPacket: packet(), gate: false }] }));
  const rejected = spawnSync(process.execPath, [RUNNER_CLI, "validate", contractPath], { encoding: "utf8" });
  assert.equal(rejected.status, 1, rejected.stdout);
  assert.match(rejected.stderr, /nodes\[0\] has unexpected field targetedFix/u, "the targeted-fix node field is gone");

  const pruned = spawnSync(process.execPath, [RUNNER_CLI, "contract", "prune", join(directory, ".runs", "single-node-run"), "--out", join(directory, "out.json")], { encoding: "utf8" });
  assert.equal(pruned.status, 2, pruned.stdout);
  assert.match(pruned.stderr, /usage: runner.mjs contract validate/u, "contract prune is not a command any more");
  assert.equal(existsSync(join(directory, "out.json")), false, "no continuation contract is written");
});
