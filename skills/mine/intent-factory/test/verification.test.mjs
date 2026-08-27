import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateContract } from "../scripts/contract.mjs";
import { parseJudge, retryPrompt } from "../scripts/lib.mjs";
import { captureWorkspaceSnapshot, compareWorkspaceSnapshot, runVerification, validateVerificationCommands } from "../scripts/verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "../scripts/worker-result.mjs";

/** @param {string} directory */
function initializeGit(directory) {
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "-c", "commit.gpgSign=false", "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "fixture"]);
}

test("worker result accepts done and blocked_context without prose", () => {
  assert.equal(parseWorkerResult(JSON.stringify({
    status: "done", summary: "complete", changedFiles: [], verification: [], artifacts: [], missingContext: [],
  })).status, "done");
  assert.equal(parseWorkerResult(JSON.stringify({
    status: "blocked_context", summary: "missing input", changedFiles: [], verification: [], artifacts: [], missingContext: ["missing.txt"],
  })).status, "blocked_context");
  // Unknown provider-added fields are dropped; the normalized pick keeps only
  // the canonical protocol fields.
  assert.deepEqual(parseWorkerResult(JSON.stringify({
    status: "done", summary: "complete", changedFiles: [], verification: [], artifacts: [], missingContext: [], confidence: 0.9,
  })), {
    status: "done", summary: "complete", changedFiles: [], verification: [], artifacts: [], missingContext: [],
  });
  assert.throws(() => parseWorkerResult("worker complete"), /invalid JSON/u);
});

test("verification repeats commands and captures bounded evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-repeat-"));
  const logDir = join(cwd, "logs");
  const result = await runVerification([{ argv: [process.execPath, "-e", "console.log('ok')"], repeat: 2 }], cwd, { logDir });
  assert.equal(result.passed, true);
  assert.equal(result.commands[0].attempts.length, 2);
  assert.equal(result.commands[0].attempts[0].exitCode, 0);
  const logged = JSON.parse(readFileSync(join(logDir, "verification-1.json"), "utf8"));
  assert.equal(logged.passed, true);
  assert.equal(logged.commands.length, 1);
  assert.equal(logged.commands[0].attempts.length, 2);
  assert.equal(logged.commands[0].attempts[0].exitCode, 0);
});

test("verification reports timeout and nonzero exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-timeout-"));
  const result = await runVerification([
    { argv: [process.execPath, "-e", "process.exit(3)"], repeat: 2 },
    { argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], timeoutSec: 0.05 },
  ], cwd);
  assert.equal(result.passed, false);
  assert.equal(result.commands[0].attempts.length, 2);
  assert.equal(result.commands[0].attempts[0].exitCode, 3);
  assert.equal(result.commands[1].attempts[0].timedOut, true);
});

test("verification rejects legacy shell strings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-contract-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  const contract = {
    schemaVersion: 1, contractVersion: "0.1.0", id: "strict-verification", campaignId: "strict",
    goal: "verify", cwd: ".", usagePolicy: false, runtimeDefaults: { worker: "luna", judge: "luna" },
    runtimes: { luna: { driver: "codex", model: "test" } },
    nodes: [{ id: "build", type: "backend", phase: "verification", taskPacket: {
      mode: "execution", objective: "verify", instructions: ["verify"], readFiles: ["README.md"], writeFiles: ["README.md"],
      symbols: [], decisions: [], nonGoals: [], verification: ["node --check README.md"],
    }, gate: false }],
  };
  const path = join(cwd, "contract.json");
  writeFileSync(path, JSON.stringify(contract));
  assert.throws(() => validateContract(contract, path), /argv command object/u);
});

test("discovery and verification aggregate prompt limits fail before spawn", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-oversized-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  const base = {
    schemaVersion: 1, contractVersion: "0.1.0", id: "oversized", campaignId: "oversized-campaign", goal: "test", cwd: ".",
    usagePolicy: false, runtimeDefaults: { worker: "worker", judge: "worker" }, runtimes: { worker: { driver: "codex", model: "test" } }, runtimeRules: [],
  };
  assert.throws(() => validateContract({
    ...base,
    nodes: [{ id: "discover", type: "backend", phase: "discovery", taskPacket: {
      mode: "discovery", objective: "x".repeat(70 * 1024), instructions: ["inspect"], readFiles: [], writeFiles: [], symbols: [], decisions: [], nonGoals: [], verification: [],
    } }],
  }, join(cwd, "contract.json")), /prompt exceeds 65536 bytes/u);
  assert.throws(() => validateVerificationCommands([{ argv: Array.from({ length: 32 }, () => "x".repeat(1100)) }]), /aggregate byte limit/u);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], env: Array.from({ length: 2000 }, (_, index) => `ENV_${index}`) }]), /aggregate byte limit/u);
  const retry = retryPrompt({ prompt: "# closed\n" }, {
    summary: "s".repeat(4096),
    findings: [{ severity: "critical", description: "d".repeat(4096), evidence: "e".repeat(512 * 1024) }],
  });
  assert.ok(Buffer.byteLength(retry, "utf8") <= 64 * 1024);
  assert.ok(!retry.includes("e".repeat(10000)));
});

test("worker result and verification output stay within hard caps", async () => {
  const oversized = JSON.stringify({
    status: "done", summary: "x".repeat(4097), changedFiles: [], verification: [], artifacts: [], missingContext: [],
  });
  assert.throws(() => parseWorkerResult(oversized), /summary exceeds/u);
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-cap-"));
  const result = await runVerification([{ argv: [process.execPath, "-e", "console.log('x'.repeat(100000))"] }], cwd);
  assert.equal(result.passed, true);
  assert.ok(Buffer.byteLength(result.commands[0].attempts[0].stdout, "utf8") <= 16 * 1024);
});

test("judge results are bounded, consistent, and require concrete evidence", () => {
  assert.equal(parseJudge(JSON.stringify({
    verdict: "pass", maxSeverity: "none", summary: "ok", findings: [],
  })).verdict, "pass");
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s".repeat(4097), findings: [],
  })), /judge result exceeds limits/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e".repeat(4097) }],
  })), /judge finding exceeds limits/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "minor", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e" }],
  })), /maxSeverity does not match/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "none", summary: "s", findings: [],
  })), /verdict and maxSeverity are inconsistent/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: Array.from({ length: 33 }, () => ({ severity: "minor", description: "d", evidence: "e" })),
  })), /judge result exceeds limits/u);
  // Unknown provider-added fields (toolAction, confidence, …) are dropped at
  // the LLM boundary instead of failing the node; the verdict stays canonical.
  assert.deepEqual(parseJudge(JSON.stringify({
    verdict: "pass", maxSeverity: "none", summary: "ok", findings: [], toolAction: { type: "none" },
  })), { verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] });
  assert.deepEqual(parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e", confidence: 0.9 }],
  })).findings, [{ severity: "critical", description: "d", evidence: "e" }]);
  assert.throws(() => parseJudge(JSON.stringify(["pass", "none", "ok", []])), /judge result must be an object/u);
});

test("verification passes only the declared controller environment names", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-env-"));
  const previous = process.env.PLAN_RUNNER_TEST_ALLOWED;
  const secret = process.env.PLAN_RUNNER_TEST_FORBIDDEN;
  process.env.PLAN_RUNNER_TEST_ALLOWED = "controller-value";
  process.env.PLAN_RUNNER_TEST_FORBIDDEN = "must-not-leak";
  try {
    const result = await runVerification([{
      argv: [process.execPath, "-e", "process.exit(process.env.PLAN_RUNNER_TEST_ALLOWED === 'controller-value' && !process.env.PLAN_RUNNER_TEST_FORBIDDEN ? 0 : 1)"],
      env: ["PLAN_RUNNER_TEST_ALLOWED"],
    }], cwd);
    assert.equal(result.passed, true);
  } finally {
    if (previous === undefined) delete process.env.PLAN_RUNNER_TEST_ALLOWED;
    else process.env.PLAN_RUNNER_TEST_ALLOWED = previous;
    if (secret === undefined) delete process.env.PLAN_RUNNER_TEST_FORBIDDEN;
    else process.env.PLAN_RUNNER_TEST_FORBIDDEN = secret;
  }
});

test("verification attempt identity is published before release and completes exactly once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-identity-"));
  /** @type {Array<{phase: string} & Record<string, unknown>>} */
  const events = [];
  const result = await runVerification([{ argv: [process.execPath, "-e", "process.exit(0)"], repeat: 1 }], cwd, {
    onAttemptStart: (attempt) => events.push({ phase: "start", ...attempt }),
    onAttemptSpawn: (attempt) => events.push({ phase: "spawn", ...attempt }),
    onAttemptComplete: (attempt) => events.push({ phase: "complete", ...attempt }),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(events.map((event) => event.phase), ["start", "spawn", "complete"]);
  assert.equal(events[0].invocationId, events[1].invocationId);
  assert.equal(events[1].invocationId, events[2].invocationId);
  assert.ok(Number.isInteger(events[1].pid));
  assert.equal(events[1].processGroupId, events[1].pid);
  assert.equal(typeof events[1].deadlineAt, "string");
  assert.equal(events[2].status, "closed");
});

test("verification rejects parent traversal and runtime cwd symlink escape", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-cwd-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-verification-outside-"));
  symlinkSync(outside, join(cwd, "escape"));
  await assert.rejects(() => runVerification([{ argv: [process.execPath, "-e", "process.exit(0)"], cwd: "../" }], cwd), /relative path without \.\./u);
  await assert.rejects(() => runVerification([{ argv: [process.execPath, "-e", "process.exit(0)"], cwd: "escape" }], cwd), /escapes workspace/u);
});

test("workspace snapshots fail closed and hash the complete file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-snapshot-"));
  const large = join(cwd, "large.bin");
  writeFileSync(large, Buffer.alloc(192 * 1024, "a"));
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  const changed = Buffer.alloc(1, "b");
  writeFileSync(large, Buffer.concat([Buffer.alloc(96 * 1024, "a"), changed, Buffer.alloc(96 * 1024 - 1, "a")]));
  const comparison = compareWorkspaceSnapshot(before, cwd, { files: ["large.bin"], roots: [] });
  assert.deepEqual(comparison.unexpectedPaths, []);
  assert.deepEqual(comparison.changedPaths, ["large.bin"]);

  const escape = mkdtempSync(join(tmpdir(), "runner-verification-symlink-"));
  symlinkSync(outsidePath(), join(escape, "outward"));
  initializeGit(escape);
  assert.throws(() => captureWorkspaceSnapshot(escape), /symlink escapes workspace/u);

  const many = mkdtempSync(join(tmpdir(), "runner-verification-many-"));
  for (let index = 0; index < 4097; index += 1) writeFileSync(join(many, `f-${index}`), "x");
  initializeGit(many);
  assert.throws(() => captureWorkspaceSnapshot(many), /exceeds 4096 entries/u);
});

test("workspace snapshots follow Git visibility and retain tracked runtime files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-runtime-scratch-"));
  writeFileSync(join(cwd, ".gitignore"), ".claude/\n.codex/\nnode_modules/\n.runs/\n");
  writeFileSync(join(cwd, "src.txt"), "before");
  initializeGit(cwd);
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "scratch.lock"), "runtime debris");
  writeFileSync(join(cwd, ".claude", "tracked.txt"), "tracked before");
  execFileSync("git", ["-C", cwd, "add", "-f", ".claude/tracked.txt"]);
  const before = captureWorkspaceSnapshot(cwd);
  for (const directory of [".codex", ".runs", "node_modules"]) {
    mkdirSync(join(cwd, directory));
    writeFileSync(join(cwd, directory, "scratch.lock"), "runtime debris");
  }
  writeFileSync(join(cwd, ".claude", "tracked.txt"), "tracked after");
  const comparison = compareWorkspaceSnapshot(before, cwd, { files: [".claude/tracked.txt"], roots: [] });
  assert.deepEqual(comparison.changedPaths, [".claude/tracked.txt"]);
  assert.deepEqual(comparison.unexpectedPaths, []);
});

test("workspace snapshots use nested ignore rules, negation, and tracked ignored files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-gitignore-"));
  writeFileSync(join(cwd, ".gitignore"), "ignored/*\n!ignored/keep.txt\ntracked.log\n");
  mkdirSync(join(cwd, "ignored"));
  writeFileSync(join(cwd, "ignored", "drop.txt"), "ignored");
  writeFileSync(join(cwd, "ignored", "keep.txt"), "kept");
  mkdirSync(join(cwd, "nested"));
  writeFileSync(join(cwd, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
  writeFileSync(join(cwd, "nested", "drop.tmp"), "ignored");
  writeFileSync(join(cwd, "nested", "keep.tmp"), "kept");
  writeFileSync(join(cwd, "tracked.log"), "tracked despite ignore");
  initializeGit(cwd);
  execFileSync("git", ["-C", cwd, "add", "-f", "tracked.log"]);

  const paths = captureWorkspaceSnapshot(cwd).entries.map((entry) => entry.path);
  assert.ok(paths.includes("ignored/keep.txt"));
  assert.ok(paths.includes("nested/keep.tmp"));
  assert.ok(paths.includes("tracked.log"));
  assert.ok(!paths.includes("ignored/drop.txt"));
  assert.ok(!paths.includes("nested/drop.tmp"));
});

test("workspace snapshots apply optional .planrunnerignore rules", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-planrunnerignore-"));
  writeFileSync(join(cwd, "README.md"), "read");
  initializeGit(cwd);
  writeFileSync(join(cwd, ".planrunnerignore"), "generated/*\n!generated/keep.txt\n");
  mkdirSync(join(cwd, "generated"));
  writeFileSync(join(cwd, "generated", "drop.txt"), "ignored");
  writeFileSync(join(cwd, "generated", "keep.txt"), "kept");

  const paths = captureWorkspaceSnapshot(cwd).entries.map((entry) => entry.path);
  assert.ok(paths.includes(".planrunnerignore"));
  assert.ok(paths.includes("generated/keep.txt"));
  assert.ok(!paths.includes("generated/drop.txt"));
});

test("scope roots resolve contained symlink aliases to Git paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-scope-symlink-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "file.txt"), "before");
  symlinkSync("src", join(cwd, "alias"));
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, "src", "file.txt"), "after");

  const comparison = compareWorkspaceSnapshot(before, cwd, { files: [], roots: ["alias"] });
  assert.deepEqual(comparison.changedPaths, ["src/file.txt"]);
  assert.deepEqual(comparison.unexpectedPaths, []);
});

test("ignore-source changes fail closed before mutable rules can hide files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-ignore-source-change-"));
  writeFileSync(join(cwd, "README.md"), "read");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, ".planrunnerignore"), "*\n");
  writeFileSync(join(cwd, "undeclared.txt"), "hidden");

  assert.throws(
    () => compareWorkspaceSnapshot(before, cwd, { files: [".planrunnerignore"], roots: [] }),
    /ignore sources changed/u,
  );
});

test("linked-worktree Git identity changes fail closed", () => {
  const parent = mkdtempSync(join(tmpdir(), "runner-verification-linked-worktree-"));
  const repository = join(parent, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "read");
  initializeGit(repository);
  const first = join(parent, "first");
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", "--detach", first]);

  const before = captureWorkspaceSnapshot(first);
  assert.ok(before.ignoreSources.some((entry) => entry.path === ".git"));
  writeFileSync(join(first, ".git"), "gitdir: /missing/worktree/identity\n");

  assert.throws(
    () => compareWorkspaceSnapshot(before, first, { files: [".git"], roots: [] }),
    /ignore sources changed/u,
  );
});

test("POSIX Git paths retain legal backslashes", (t) => {
  if (process.platform === "win32") {
    t.skip("backslash is a path separator on Windows");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-backslash-path-"));
  const path = "literal\\name.txt";
  writeFileSync(join(cwd, path), "before");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, path), "after");

  const comparison = compareWorkspaceSnapshot(before, cwd, { files: [path], roots: [] });
  assert.deepEqual(comparison.changedPaths, [path]);
  assert.deepEqual(comparison.unexpectedPaths, []);
});

test("ignored directories do not consume the relevant snapshot entry cap", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-ignored-many-"));
  writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
  writeFileSync(join(cwd, "README.md"), "read");
  initializeGit(cwd);
  mkdirSync(join(cwd, "ignored"));
  for (let index = 0; index < 5000; index += 1) writeFileSync(join(cwd, "ignored", `f-${index}`), "ignored");
  const snapshot = captureWorkspaceSnapshot(cwd);
  assert.ok(snapshot.entries.every((entry) => !entry.path.startsWith("ignored/")));
});

test("scope exact files and roots respect prefix boundaries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-scope-boundary-"));
  mkdirSync(join(cwd, "src", "foo"), { recursive: true });
  mkdirSync(join(cwd, "src", "foobar"), { recursive: true });
  writeFileSync(join(cwd, "src", "foo", "file.txt"), "before");
  writeFileSync(join(cwd, "src", "foobar", "file.txt"), "before");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, "src", "foo", "file.txt"), "after");
  writeFileSync(join(cwd, "src", "foobar", "file.txt"), "after");

  const exact = compareWorkspaceSnapshot(before, cwd, { files: ["src/foo/file.txt"], roots: [] });
  assert.deepEqual(exact.unexpectedPaths, ["src/foobar/file.txt"]);
  const root = compareWorkspaceSnapshot(before, cwd, { files: [], roots: ["src/foo"] });
  assert.deepEqual(root.unexpectedPaths, ["src/foobar/file.txt"]);
});

test("workspace snapshots reject paths over the hard byte limit", (t) => {
  if (process.platform === "darwin") {
    t.skip("macOS PATH_MAX prevents constructing a >1024-byte relative path");
    return;
  }
  const long = mkdtempSync(join(tmpdir(), "runner-verification-long-"));
  let current = long;
  for (let index = 0; index < 5; index += 1) {
    current = join(current, `segment-${index}-${"x".repeat(230)}`);
    mkdirSync(current);
  }
  writeFileSync(join(current, "file"), "x");
  initializeGit(long);
  assert.throws(() => captureWorkspaceSnapshot(long), /exceeds 1024 bytes/u);
});

test("scope comparison computes forbidden paths beyond the evidence window", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-scope-cap-"));
  const allowed = [];
  for (let index = 0; index < 70; index += 1) {
    const path = `allowed-${index}.txt`;
    allowed.push(path);
    writeFileSync(join(cwd, path), "before");
  }
  writeFileSync(join(cwd, "forbidden.txt"), "before");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  for (const path of [...allowed, "forbidden.txt"]) writeFileSync(join(cwd, path), "after");
  const comparison = compareWorkspaceSnapshot(before, cwd, { files: allowed, roots: [] });
  assert.equal(comparison.unexpectedPaths.length, 1);
  assert.deepEqual(comparison.unexpectedPaths, ["forbidden.txt"]);
});

test("only the complete runner-managed AGENTS.md signal block is scope-neutral", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-agent-signal-"));
  const agents = join(cwd, "AGENTS.md");
  const managedStart = "<!-- intent-factory-active:start (managed by intent-factory — read, never edit) -->";
  const managedEnd = "<!-- intent-factory-active:end -->";
  writeFileSync(agents, `# Guidance\nHuman guidance stays protected.\n\n${managedStart}\n- intent-factory run \`old-run\`: active\n${managedEnd}\n`);
  writeFileSync(join(cwd, "README.md"), "read\n");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);

  // The runner rewriting only the managed block (new active run lines) is not
  // worker scope drift and must not trip unexpected-write protection.
  writeFileSync(agents, `# Guidance\nHuman guidance stays protected.\n\n${managedStart}\n- intent-factory run \`new-run\`: active\n- intent-factory campaign \`other-campaign\`: active\n${managedEnd}\n`);
  const managedOnly = compareWorkspaceSnapshot(before, cwd, { files: [], roots: [] });
  assert.deepEqual(managedOnly.changedPaths, []);
  assert.deepEqual(managedOnly.unexpectedPaths, []);

  // Human-authored guidance outside the block still changes the identity and
  // is protected as an unexpected write.
  writeFileSync(agents, `# Guidance\nHuman edit outside the managed block.\n\n${managedStart}\n- intent-factory run \`new-run\`: active\n${managedEnd}\n`);
  const humanEdit = compareWorkspaceSnapshot(before, cwd, { files: [], roots: [] });
  assert.deepEqual(humanEdit.changedPaths, ["AGENTS.md"]);
  assert.deepEqual(humanEdit.unexpectedPaths, ["AGENTS.md"]);

  // A partial or malformed block is not runner-owned: it stays part of source
  // identity and must still trigger protection.
  writeFileSync(agents, `# Guidance\nHuman guidance stays protected.\n\n${managedStart}\n- intent-factory run \`partial\`: active\n`);
  const partialBlock = compareWorkspaceSnapshot(before, cwd, { files: [], roots: [] });
  assert.deepEqual(partialBlock.changedPaths, ["AGENTS.md"]);
  assert.deepEqual(partialBlock.unexpectedPaths, ["AGENTS.md"]);
});

test("verification timeout and cancellation terminate process groups", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-descendants-"));
  const pidPath = join(cwd, "child.pid");
  const script = "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); fs.writeFileSync(process.argv[1],String(c.pid)); setInterval(()=>{},1000);";
  // 2s leaves the child time to boot and write child.pid before the timeout
  // kills it, even under full-suite load; the assertion only needs a timeout.
  const timed = await runVerification([{ argv: [process.execPath, "-e", script, pidPath], timeoutSec: 2 }], cwd);
  assert.equal(timed.passed, false);
  assert.equal(timed.commands[0].attempts[0].timedOut, true);
  const childPid = Number(readFileSync(pidPath, "utf8"));
  await waitForDeath(childPid);
  const controller = new AbortController();
  const pending = runVerification([{ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutSec: 5 }], cwd, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const canceled = await pending;
  assert.equal(canceled.passed, false);
});

test("discovery result parses exactly one strict execution task packet artifact", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-discovery-result-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  const packet = {
    mode: "execution", objective: "build", instructions: ["build"], readFiles: ["README.md"], writeFiles: ["out.txt"],
    symbols: [], decisions: [], nonGoals: [], verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
  };
  const result = parseDiscoveryResult({
    status: "done", summary: "discovered", changedFiles: [], verification: [], artifacts: [JSON.stringify(packet)], missingContext: [],
  }, cwd);
  assert.equal(result.discoveryPacket.mode, "execution");
  assert.throws(() => parseDiscoveryResult({ ...result, artifacts: [] }, cwd), /exactly one task packet/u);
});

function outsidePath() {
  return mkdtempSync(join(tmpdir(), "runner-verification-outward-target-"));
}

/**
 * @param {number} pid
 * @returns {Promise<void>}
 */
async function waitForDeath(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      const cause = /** @type {{code?: string}} */ (error);
      if (cause.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  assert.fail(`process ${pid} survived process-group termination`);
}
