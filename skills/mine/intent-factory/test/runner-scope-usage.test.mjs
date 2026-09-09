import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport, renderStatus, validateContract } from "../scripts/lib.mjs";
import { MAX_NOTE_LENGTH, renderReportJson, renderStatusJson } from "../scripts/render.mjs";
import { runContract, resumeRun } from "../scripts/runner.mjs";
import { runRefName } from "../scripts/worktree.mjs";
import { ensureAttemptWorktree, fakeCodex, fakeExecJsonl, fixture, initializeGit, packet, withFakeCodex, writeContract } from "./helpers.mjs";
import { nodeState, showRefFile, advisoryGateCodex } from "./runner-helpers.mjs";



test("an unexpected write on green verification is an advisory finding, not a terminal failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-"));
  writeFileSync(join(directory, "preexisting.txt"), "keep me\n");
  const path = writeContract(directory, fixture({
    id: "scope-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.error, null, "an advisory scope finding records no terminal error");
  assert.ok(state.scope, "scope snapshot persisted");
  assert.ok(state.scope.unexpectedPaths.includes("unexpected.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["unexpected.txt"]);
  assert.equal(readFileSync(join(directory, "preexisting.txt"), "utf8"), "keep me\n", "pre-existing dirt is preserved");
  assert.equal(existsSync(join(result.runDir, "findings.json")), false, "a done run leaves no findings artifact");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const finding = events.find((event) => event.type === "scope.finding");
  assert.ok(finding, "a scope.finding event is appended");
  assert.deepEqual(finding.unexpectedPaths, ["unexpected.txt"]);
  assert.equal(finding.unexpectedPathCount, 1);

  const cleanDirectory = mkdtempSync(join(tmpdir(), "runner-scope-clean-"));
  writeFileSync(join(cleanDirectory, "preexisting.txt"), "keep me\n");
  const cleanPath = writeContract(cleanDirectory, fixture({
    id: "scope-clean-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const clean = await withFakeCodex(cleanDirectory, "pass", () => runContract(cleanPath));
  assert.equal(nodeState(clean).status, "done");
  assert.equal(nodeState(clean).scopeFindings, undefined, "a clean attempt records no scope finding");

  // The same advisory outcome reaches a gated node: the judge is told about
  // the unexpected paths and the finding stays visible in status, where the
  // gate summary would otherwise be the whole node note.
  const gatedDirectory = mkdtempSync(join(tmpdir(), "runner-scope-gated-"));
  const gatedPath = writeContract(gatedDirectory, fixture({
    id: "scope-gated-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const gated = await withFakeCodex(gatedDirectory, "write-unexpected-judge-prompt", () => runContract(gatedPath));
  const gatedState = nodeState(gated);
  assert.equal(gatedState.status, "done", gatedState.error?.message);
  assert.deepEqual(gatedState.scopeFindings?.unexpectedPaths, ["unexpected.txt"], "a gated done node keeps its advisory finding");
  assert.equal(gatedState.gate?.verdict, "fail", "the advisory gate verdict is recorded");
  assert.equal(gatedState.gate?.summary, "minor advisory");
  const seenByJudge = readFileSync(join(gatedDirectory, ".runs", "judge-prompt.txt"), "utf8");
  assert.match(seenByJudge, /Scope findings/u);
  assert.match(seenByJudge, /- unexpected\.txt/u);

  // One stable format for a node that carries both: the scope note, then the
  // review note, then the gate summary it would otherwise hide.
  const note = /scope: 1 unexpected path · advisory: 1 finding · minor advisory/u;
  const status = renderStatus(gated.runDir);
  assert.match(status, note);
  const payload = /** @type {{nodes: {id: string, note: string, scopeFindings: string[]|null}[]}} */ (JSON.parse(renderStatusJson(gated.runDir)));
  assert.equal(payload.nodes[0].note, "scope: 1 unexpected path · advisory: 1 finding · minor advisory");
  assert.deepEqual(payload.nodes[0].scopeFindings, ["unexpected.txt"]);
  // STATUS.md is the artifact the campaign reads: it shows the same note.
  const statusArtifact = readFileSync(join(gated.runDir, "STATUS.md"), "utf8");
  assert.match(statusArtifact, note);
  assert.match(renderReport(gated.runDir), /scope: 1 unexpected path · advisory: 1 finding/u);

  // A gate summary longer than the note budget cannot make the surfaces
  // disagree: the summary is the part the bound cuts, and the JSON carries the
  // very string the tables render.
  const longDirectory = mkdtempSync(join(tmpdir(), "runner-scope-gated-long-"));
  const longPath = writeContract(longDirectory, fixture({
    id: "scope-gated-long-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const long = await withFakeCodex(longDirectory, "write-unexpected-long-review", () => runContract(longPath));
  assert.equal(nodeState(long).status, "done", nodeState(long).error?.message);
  const longNote = /** @type {string} */ (JSON.parse(renderStatusJson(long.runDir)).nodes[0].note);
  assert.equal(longNote.length, MAX_NOTE_LENGTH, "the note is bounded to the width every surface shows");
  assert.match(longNote, /^scope: 1 unexpected path · advisory: 1 finding · /u, "the advisory markers survive a cut summary");
  assert.ok(longNote.endsWith("…"), "a cut summary is marked as cut");
  for (const [surface, text] of [
    ["the status table", renderStatus(long.runDir)],
    ["STATUS.md", readFileSync(join(long.runDir, "STATUS.md"), "utf8")],
    ["the report", renderReport(long.runDir)],
  ]) {
    assert.ok(text.includes(longNote), `${surface} shows the same bounded note`);
  }
});


test("an incomplete worker that writes outside scope still fails with unexpected_write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-incomplete-"));
  const path = writeContract(directory, fixture({
    id: "scope-incomplete-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-failed", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write", "the provider failure must not displace the scope verdict");
  assert.match(state.error?.message ?? "", /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "only a completed attempt earns an advisory finding");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));
});


test("a scope violation on failed verification keeps the failure and appends the unexpected paths to the message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-red-"));
  const path = writeContract(directory, fixture({
    id: "scope-red-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(1)"] }] }),
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.match(state.error.message, /unexpected paths changed/u);
  assert.match(state.error.message, /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "a failed attempt never gets an advisory finding");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));
});


test("a done envelope whose worker result is not done still fails with unexpected_write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-blocked-result-"));
  const path = writeContract(directory, fixture({
    id: "scope-blocked-result-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-blocked-context", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write", "a blocked_context result is not completed work and cannot defer the scope verdict");
  assert.match(state.error?.message ?? "", /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "only an accepted worker result earns an advisory finding");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));

  // An unparseable result behind a done envelope is the same verdict: the
  // envelope alone never earns the deferred scope decision, so the paths stay
  // terminal instead of vanishing into an invalid-result repair.
  const invalidDirectory = mkdtempSync(join(tmpdir(), "runner-scope-invalid-result-"));
  const invalidPath = writeContract(invalidDirectory, fixture({
    id: "scope-invalid-result-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const invalid = await withFakeCodex(invalidDirectory, "write-unexpected-invalid-result", () => runContract(invalidPath));
  const invalidState = nodeState(invalid);
  assert.equal(invalidState.status, "failed");
  assert.equal(invalidState.error?.code, "unexpected_write");
  assert.equal(invalidState.scopeFindings, undefined);
});


test("a done envelope without the canonical result file keeps the terminal unexpected_write", async () => {
  // The final message alone is not accepted work: the controller materializes
  // the canonical file from it only after the scope gate, so an attempt that
  // also wrote outside its scope never reaches verification or a finding.
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-message-only-"));
  const path = writeContract(directory, fixture({
    id: "scope-message-only-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-message-only", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write", "a done envelope without the canonical file cannot defer the scope verdict");
  assert.match(state.error?.message ?? "", /unexpected\.txt/u);
  assert.equal(state.scopeFindings, undefined, "no advisory finding without an accepted worker result");
  assert.equal(existsSync(join(result.runDir, "results", "build.json")), false, "the envelope result was never materialized");
  assert.ok(state.scope?.unexpectedPaths.includes("unexpected.txt"));
});


test("a scope violation on a gated red attempt reaches the retry prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-red-revision-"));
  const path = writeContract(directory, fixture({
    id: "scope-red-revision-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(1)"] }] }),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected-revision", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.attempt, 2, "the gate spent its revision before stopping");
  assert.equal(state.status, "exhausted", state.error?.message);
  assert.equal(state.error?.code, "verification_failed");
  assert.match(state.error?.message ?? "", /unexpected paths changed/u);
  assert.match(state.error?.message ?? "", /unexpected-2\.txt/u);
  assert.equal(state.scopeFindings, undefined, "a failed attempt never gets an advisory finding");
  // The next attempt is dispatched before the terminal branch, so the paths
  // have to travel inside the verdict: the node state that carried them is
  // cleared by the time the revision starts.
  const retryPrompt = readFileSync(join(directory, ".runs", "scope-retry-prompt.txt"), "utf8");
  assert.match(retryPrompt, /quality gate rejected/u);
  assert.match(retryPrompt, /unexpected paths changed/u);
  assert.match(retryPrompt, /unexpected-1\.txt/u);
});


test("a worker-created symlink cannot authorize its target, but is advisory on green verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-new-symlink-"));
  writeFileSync(join(directory, "outside.txt"), "baseline\n");
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-new-symlink-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "new-symlink-escape", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt"]);
  assert.equal(showRefFile(directory, runRefName("scope-new-symlink-run"), "outside.txt"), "unauthorized target\n");
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["outside.txt"]);
});


test("retargeting a contained alias cannot authorize the new target, but is advisory on green verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-retargeted-symlink-"));
  writeFileSync(join(directory, "src.txt"), "source\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  symlinkSync("src.txt", join(directory, "alias.txt"));
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-retargeted-symlink-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "retargeted-symlink-escape", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.ok(state.scope?.unexpectedPaths.includes("outside.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["outside.txt"]);
});


test("a pre-existing contained alias remains an authorized write path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-contained-alias-"));
  writeFileSync(join(directory, "src.txt"), "source\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  symlinkSync("src.txt", join(directory, "alias.txt"));
  initializeGit(directory);
  const path = writeContract(directory, fixture({
    id: "scope-contained-alias-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ writeFiles: ["alias.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "contained-alias", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.files, ["alias.txt", "src.txt"]);
  assert.equal(showRefFile(directory, runRefName("scope-contained-alias-run"), "src.txt"), "authorized target\n");
});


test("a file write root matches exactly that path in the scope gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-file-root-"));
  writeFileSync(join(directory, "notes.md"), "before\n");
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["notes.md"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-file-root-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-file-root", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.roots, ["notes.md"]);
  assert.equal(state.scope?.unexpectedPaths.length, 0);
  assert.equal(state.scopeFindings, undefined);
  assert.equal(showRefFile(directory, runRefName("scope-file-root-run"), "notes.md"), "in the file root\n");
});


test("a file write root does not authorize a sibling file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-file-root-sibling-"));
  writeFileSync(join(directory, "notes.md"), "before\n");
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["notes.md"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-file-root-sibling-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-outside-file-root", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.ok(state.scope?.unexpectedPaths.includes("sibling.md"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["sibling.md"]);
});


test("a file write root does not authorize a path beneath a same-named directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-file-root-nested-"));
  writeFileSync(join(directory, "notes.md"), "before\n");
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["notes.md"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "scope-file-root-nested-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-under-file-root", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scope?.boundary?.fileRoots, ["notes.md"], "the boundary records the root that named a file");
  assert.ok(state.scope?.unexpectedPaths.includes("notes.md/nested.txt"));
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["notes.md/nested.txt"]);
});


test("accepts parallel execution now that attempt worktrees provide isolation", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-max-parallel-"));
  const path = writeContract(directory, fixture({ maxParallel: 2 }));
  assert.equal(validateContract(JSON.parse(readFileSync(path, "utf8")), path).maxParallel, 2);
});


test("provider exhaustion follows the declared one-hop fallback without consuming revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-one-hop-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-one-hop-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.nextRuntime), ["second"]);
  assert.deepEqual((state.routing?.history ?? []).map((entry) => entry.hop), [1]);
});


test("a second exhaustion after the one declared hop blocks at the hop cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-hop-cap-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "exhausted");
  const third = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-hop-cap-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second, fallback: "third" },
      third: { driver: "codex", model: "third", executable: third },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "provider_failover_hop_cap");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
});


test("provider exhaustion without a rule is terminal and cycles do not reuse a runtime", async () => {
  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-failover-no-rule-"));
  const exhausted = fakeCodex(terminalDirectory, "exhausted");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "failover-no-rule-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: { first: { driver: "codex", model: "first", executable: exhausted } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const terminal = nodeState(await runContract(terminalPath));
  assert.equal(terminal.status, "exhausted");
  assert.equal(terminal.routing?.history?.length ?? 0, 0);

  const cycleDirectory = mkdtempSync(join(tmpdir(), "runner-failover-cycle-"));
  const cycleFirst = fakeCodex(cycleDirectory, "exhausted");
  const cycleSecond = fakeCodex(cycleDirectory, "exhausted");
  const cyclePath = writeContract(cycleDirectory, fixture({
    id: "failover-cycle-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: cycleFirst, fallback: "second" },
      second: { driver: "codex", model: "second", executable: cycleSecond, fallback: "first" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const cycle = nodeState(await runContract(cyclePath));
  assert.equal(cycle.status, "exhausted");
  assert.equal(cycle.error?.code, "provider_failover_cycle");
  assert.deepEqual((cycle.invocations ?? []).map((invocation) => invocation.runtimeId), ["first", "second"]);
});


test("a declared fallback reschedules immediately with no backoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-backoff-"));
  const first = fakeCodex(directory, "exhausted");
  const second = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-backoff-run",
    runtimeDefaults: { worker: "first", judge: "first" },
    runtimes: {
      first: { driver: "codex", model: "first", executable: first, fallback: "second" },
      second: { driver: "codex", model: "second", executable: second },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.routing?.history?.[0]?.backoffSec, 0);
  assert.ok(Date.parse(state.routing?.history?.[0]?.backoffUntil ?? "") <= Date.now());
});


test("recovered provider exhaustion does not charge persisted usage or cost twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-no-double-charge-"));
  const executable = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "failover-no-double-charge-run",
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { driver: "codex", model: "worker", executable } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = (await runContract(path)).runDir;
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations[0];
  const usage = { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 };
  const costUsd = 0.01;
  writeFileSync(invocation.stdoutPath, `${JSON.stringify({ type: "turn.failed", error: { code: "budget_exceeded", message: "budget_exceeded" } })}\n`);
  const recovered = {
    ...state,
    status: "running",
    phase: "worker",
    result: null,
    gate: null,
    error: null,
    usage,
    costUsd,
    invocations: [{ ...invocation, status: "closed", usage, costUsd, closedAt: new Date().toISOString(), exitCode: 0, signal: null }],
  };
  writeFileSync(nodePath, JSON.stringify(recovered, null, 2));
  const final = nodeState(await resumeRun(runDir));
  assert.equal(final.status, "exhausted");
  assert.deepEqual(final.usage, usage);
  assert.equal(final.costUsd, costUsd);
});


test("ordinary provider failure usage is counted from its invocation once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failure-usage-once-"));
  const path = writeContract(directory, fixture({
    id: "failure-usage-once-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "failure-with-usage", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.deepEqual(state.usage, { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 });
  assert.deepEqual(state.invocations?.map((invocation) => invocation.usage), [{ inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 }]);
});


test("judge provider failover preserves the completed worker result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-failover-judge-"));
  const worker = fakeCodex(directory, "pass");
  const judgeFirst = fakeCodex(directory, "exhausted");
  const judgeSecond = advisoryGateCodex(directory);
  const path = writeContract(directory, fixture({
    id: "failover-judge-run",
    runtimeDefaults: { worker: "worker", judge: "judge-first" },
    runtimes: {
      worker: { driver: "codex", model: "worker", executable: worker },
      "judge-first": { driver: "codex", model: "judge-first", executable: judgeFirst, vendor: "openai-judge", fallback: "judge-second" },
      "judge-second": { driver: "codex", model: "judge-second", executable: judgeSecond, vendor: "openai-judge" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: {} }],
  }));
  const state = nodeState(await runContract(path));
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(/** @type {{status?: string}|null} */ (state.result)?.status, "done");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["worker", "judge-first", "judge-second"]);
  assert.equal(state.routing?.history?.[0]?.role, "judge");
});


test("persists and recovers cost exactly once and reports totals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cost-recovery-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const executable = fakeExecJsonl(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "cost-recovery-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable },
      "jsonl-judge": { driver: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: {} }],
  }));
  const runDir = (await runContract(path)).runDir;
  const first = nodeState(await resumeRun(runDir));
  assert.equal(first.costUsd, 0.02);
  assert.deepEqual((first.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
  const usageRecords = readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(usageRecords.map((record) => record.costUsd), [0.01, 0.01]);
  assert.equal(JSON.parse(renderReportJson(runDir)).totals.costUsd, 0.02);
  assert.match(renderReport(runDir), /cost \$0\.020000/u);
  const nodePath = join(runDir, "nodes", "build.json");
  const crashed = JSON.parse(readFileSync(nodePath, "utf8"));
  const worker = /** @type {Record<string, unknown>[]} */ (crashed.invocations).find((invocation) => invocation.phase === "worker");
  crashed.status = "running";
  crashed.phase = "worker";
  crashed.result = null;
  crashed.gate = null;
  crashed.costUsd = undefined;
  crashed.usage = undefined;
  crashed.worktree = ensureAttemptWorktree(runDir, crashed);
  crashed.invocations = [{ ...worker, status: "closed", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null }, costUsd: null }];
  writeFileSync(nodePath, JSON.stringify(crashed, null, 2));
  const recovered = nodeState(await resumeRun(runDir));
  assert.equal(recovered.costUsd, 0.02);
  assert.deepEqual((recovered.invocations ?? []).map((invocation) => invocation.costUsd), [0.01, 0.01]);
});


test("a scope finding still persists the usage its invocation spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scope-usage-"));
  const path = writeContract(directory, fixture({
    id: "scope-usage-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["unexpected.txt"]);
  assert.equal(state.usage?.inputTokens, 10, "transcript usage survives the scope finding");
  const invocation = state.invocations?.at(-1);
  assert.equal(invocation?.usage?.inputTokens, 10, "invocation record carries the same usage");
});


test("a wall-clock kill persists usage backfilled from the transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-usage-"));
  const path = writeContract(directory, fixture({
    id: "timeout-usage-run",
    pollIntervalMs: 10,
    timeoutSec: 1,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ objective: "Flood tokens" }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "token-flood-timeout", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "wall_clock_timeout");
  assert.ok((state.usage?.inputTokens ?? 0) > 0, "killed worker reports its observed input tokens");
});
