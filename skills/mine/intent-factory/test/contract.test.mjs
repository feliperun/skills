import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PLAN_RUNNER_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  captureSourceIdentity,
  hashPacket,
  routeRuntime,
  validateContract,
  validateNodeSnapshot,
} from "../scripts/contract.mjs";
import { SIGNAL_END, SIGNAL_START } from "../scripts/signal-block.mjs";
import { judgePrompt } from "../scripts/lib.mjs";
import { runContract } from "../scripts/runner.mjs";
import { driverCapabilities } from "../scripts/drivers/index.mjs";
import * as helpers from "./helpers.mjs";

/** @param {string} directory */
function initializeGit(directory) {
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "-c", "commit.gpgSign=false", "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "fixture"]);
}

function packet(overrides = {}) {
  return {
    mode: "execution",
    objective: "Implement it",
    instructions: ["Implement the behavior"],
    readFiles: ["README.md"],
    writeFiles: ["output.txt"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: [{ argv: ["node", "--check", "output.txt"] }],
    ...overrides,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function fixture(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: PLAN_RUNNER_VERSION,
    id: "contract-test",
    campaignId: "campaign-test",
    goal: "validate protocol",
    cwd: ".",
    usagePolicy: false,
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { driver: "codex", model: "test-model" } },
    runtimeRules: [],
    ...overrides,
    nodes: /** @type {Record<string, unknown>[]} */ (overrides.nodes ?? [{ id: "build", type: "backend", taskPacket: packet(), gate: false }]).map((node, index) => ({
      phase: `fixture-phase-${index}`,
      ...node,
    })),
  };
}

function writeFixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "runner-contract-"));
  writeFileSync(join(directory, "README.md"), "read me\n");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture(overrides), null, 2)}\n`);
  return { directory, path };
}

test("validation stores version metadata, source identity, and packet hash", () => {
  const { path } = writeFixture();
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.schemaVersion, PROTOCOL_SCHEMA_VERSION);
  assert.equal(contract.contractVersion, PLAN_RUNNER_VERSION);
  assert.deepEqual(contract.sourceIdentity, { kind: "contract", id: "contract-test", campaignId: "campaign-test" });
  assert.equal(contract.nodes[0].packetHash, hashPacket(contract.nodes[0].taskPacket));
  assert.deepEqual(contract.nodes[0].sourceIdentity, { kind: "node", contractId: "contract-test", nodeId: "build" });
});

test("source identity ignores only the managed AGENTS signal block", () => {
  const { directory, path } = writeFixture();
  writeFileSync(join(directory, "AGENTS.md"), `Human guidance\n\n${SIGNAL_START}\nold state\n${SIGNAL_END}\n`);
  initializeGit(directory);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const initial = captureSourceIdentity(contract);

  writeFileSync(join(directory, "AGENTS.md"), `Human guidance\n\n${SIGNAL_START}\nnew run state\n${SIGNAL_END}\n`);
  assert.equal(captureSourceIdentity(contract).dirtyTreeFingerprint, initial.dirtyTreeFingerprint);

  writeFileSync(join(directory, "AGENTS.md"), `Changed human guidance\n\n${SIGNAL_START}\nnew run state\n${SIGNAL_END}\n`);
  assert.notEqual(captureSourceIdentity(contract).dirtyTreeFingerprint, initial.dirtyTreeFingerprint);
});

test("validation requires an explicit usage policy and node phase", () => {
  const missingPolicy = helpers.fixture();
  delete missingPolicy.usagePolicy;
  const policyPath = helpers.writeContract(mkdtempSync(join(tmpdir(), "runner-missing-policy-")), missingPolicy);
  assert.throws(() => validateContract(JSON.parse(readFileSync(policyPath, "utf8")), policyPath), /usagePolicy is required/u);

  const missingPhase = helpers.fixture();
  const missingPhaseNodes = /** @type {Record<string, unknown>[]} */ (missingPhase.nodes);
  const { phase: _phase, ...missingPhaseNode } = missingPhaseNodes[0];
  missingPhaseNodes[0] = missingPhaseNode;
  const phasePath = helpers.writeContract(mkdtempSync(join(tmpdir(), "runner-missing-phase-")), missingPhase);
  assert.throws(() => validateContract(JSON.parse(readFileSync(phasePath, "utf8")), phasePath), /nodes\[0\]\.phase/u);
});

test("same-phase nodes must have a dependency order", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-order-"));
  const ambiguous = helpers.writeContract(directory, helpers.fixture({
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: helpers.packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", taskPacket: helpers.packet(), gate: false },
    ],
  }));
  assert.throws(() => validateContract(JSON.parse(readFileSync(ambiguous, "utf8")), ambiguous), /share phase implementation but are not sequentially ordered/u);

  const ordered = helpers.writeContract(directory, helpers.fixture({
    id: "ordered-phase-run",
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: helpers.packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: helpers.packet(), gate: false },
    ],
  }));
  assert.equal(validateContract(JSON.parse(readFileSync(ordered, "utf8")), ordered).nodes.length, 2);
});

test("usage policy validates its reserve and soft phase boundary", () => {
  const { path } = writeFixture({ usagePolicy: { epoch: "epoch-1", maxInputTokens: 100, judgeReserveInputTokens: 20, maxPhaseInputTokens: 40, maxInvocationTokens: 30, cacheReadWeight: 0.1 } });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.usagePolicy, { epoch: "epoch-1", maxInputTokens: 100, judgeReserveInputTokens: 20, maxPhaseInputTokens: 40, maxInvocationTokens: 30, cacheReadWeight: 0.1 });
  for (const usagePolicy of [
    { epoch: "epoch-1", maxInputTokens: 0, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1, maxInvocationTokens: 1, cacheReadWeight: 0.1 },
    { epoch: "epoch-1", maxInputTokens: 10, judgeReserveInputTokens: 11, maxPhaseInputTokens: 1, maxInvocationTokens: 1, cacheReadWeight: 0.1 },
    { epoch: "epoch-1", maxInputTokens: 10, judgeReserveInputTokens: 0, maxPhaseInputTokens: 0, maxInvocationTokens: 1, cacheReadWeight: 0.1 },
    { epoch: "epoch-1", maxInputTokens: 10, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1, maxInvocationTokens: 0, cacheReadWeight: 0.1 },
    { epoch: "epoch-1", maxInputTokens: 10, judgeReserveInputTokens: 0, maxPhaseInputTokens: 1, maxInvocationTokens: 1, cacheReadWeight: 2 },
  ]) {
    const invalid = writeFixture({ usagePolicy });
    assert.throws(() => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path), /usagePolicy/u);
  }
});

test("validation rejects unknown fields at every protocol layer", () => {
  const cases = [
    [{ typo: true }, /contract has unexpected field typo/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, typo: true }] }, /nodes\[0\] has unexpected field typo/u],
    [{ runtimes: { worker: { driver: "codex", model: "m", typo: true } } }, /runtime worker has unexpected field typo/u],
    [{ runtimeRules: [{ match: { type: "backend" }, runtime: "worker", typo: true }] }, /runtimeRules\[0\] has unexpected field typo/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { typo: true } }] }, /nodes\[0\]\.gate has unexpected field typo/u],
  ];
  for (const [override, expected] of cases) {
    const { path } = writeFixture(override);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), expected);
  }
});

test("validation rejects unsupported protocol versions and stale packet hashes", () => {
  const versioned = writeFixture({ schemaVersion: 99 });
  assert.throws(() => validateContract(JSON.parse(readFileSync(versioned.path, "utf8")), versioned.path), /schemaVersion must be 1/u);
  const stale = writeFixture({ nodes: [{ id: "build", type: "backend", taskPacket: packet(), packetHash: "0".repeat(64), gate: false }] });
  assert.throws(() => validateContract(JSON.parse(readFileSync(stale.path, "utf8")), stale.path), /packetHash does not match/u);
});

function snapshot(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: PLAN_RUNNER_VERSION,
    id: "build",
    type: "backend",
    sourceIdentity: { kind: "node", contractId: "contract-test", nodeId: "build" },
    packetHash: "a".repeat(64),
    status: "pending",
    phase: "waiting",
    attempt: 0,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    result: null,
    gate: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

test("node snapshots reject misspelled enums and invalid nested shapes", () => {
  const cases = [
    [{ status: "pendng" }, /node snapshot\.status is invalid/u],
    [{ phase: "waitng" }, /node snapshot\.phase is invalid/u],
    [{ attempt: -1 }, /node snapshot\.attempt/u],
    [{ revisions: -1 }, /node snapshot\.revisions/u],
    [{ runtime: { id: "worker" } }, /node snapshot\.runtime\.driver/u],
    [{ blockedBy: [7] }, /blockedBy item/u],
    [{ startedAt: "not-a-timestamp" }, /startedAt/u],
    [{ result: {} }, /worker result/u],
    [{ gate: { verdict: "pass", maxSeverity: "none", summary: "ok", findings: [{}] } }, /findings\[0\]/u],
    [{ error: { code: "bad" } }, /node snapshot\.error\.message/u],
    [{ usage: { inputTokens: "10", outputTokens: 0, cacheReadInputTokens: 0 } }, /usage\.inputTokens/u],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => validateNodeSnapshot(snapshot(override)), expected);
  }
});

test("node snapshots must match the validated contract node identity and hash", () => {
  const { path } = writeFixture();
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const node = contract.nodes[0];
  const valid = snapshot({
    packetHash: node.packetHash,
    sourceIdentity: node.sourceIdentity,
  });
  validateNodeSnapshot(valid, node);
  /** @type {[string, unknown, RegExp][]} */
  const identityCases = [
    ["id", "other", /node snapshot\.id does not match/u],
    ["type", "frontend", /node snapshot\.type does not match/u],
    ["packetHash", "b".repeat(64), /node snapshot\.packetHash does not match/u],
    ["sourceIdentity", { ...node.sourceIdentity, nodeId: "other" }, /node snapshot\.sourceIdentity does not match/u],
  ];
  for (const [field, value, expected] of identityCases) {
    assert.throws(() => validateNodeSnapshot({ ...valid, [field]: value }, node), expected);
  }
});

test("node snapshot capability budgets survive JSON serialization and validation", () => {
  const runtime = {
    id: "worker",
    driver: "codex",
    model: "test-model",
    capabilities: driverCapabilities({ driver: "codex" }),
  };
  const persisted = JSON.parse(JSON.stringify(snapshot({ runtime })));
  validateNodeSnapshot(persisted);
  assert.equal(persisted.runtime.capabilities.tokenBudget, true);
  assert.equal(persisted.runtime.capabilities.costBudget, false);
  assert.ok(Object.keys(persisted.runtime.capabilities).includes("tokenBudget"));
  assert.ok(Object.keys(persisted.runtime.capabilities).includes("costBudget"));
});

test("validation rejects invalid runtime field types and routing match values", () => {
  /** @type {[string, unknown][]} */
  const runtimeCases = [
    ["reasoning", 1],
    ["permissionMode", false],
    ["printTimeout", 30],
    ["executable", 7],
    ["args", "--json"],
    ["versionArgs", ["--version", 1]],
    ["maxArgvPromptBytes", "4096"],
    ["requiredCapabilities", []],
  ];
  for (const [field, value] of runtimeCases) {
    const { path } = writeFixture({ runtimes: { worker: { driver: "codex", model: "test-model", [field]: value } } });
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), new RegExp(`runtime worker\\.${field}`));
  }

  for (const [field, value] of /** @type {[string, unknown][]} */ ([["id", ""], ["type", false], ["runtime", 4]])) {
    const { path } = writeFixture({ runtimeRules: [{ match: { [field]: value }, runtime: "worker" }] });
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), new RegExp(`runtimeRules\\[0\\]\\.match\\.${field}`));
  }

  const unknownRuntime = writeFixture({ runtimeRules: [{ match: { runtime: "missing" }, runtime: "worker" }] });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(unknownRuntime.path, "utf8")), unknownRuntime.path),
    /runtimeRules\[0\]\.match\.runtime.*unknown runtime/u,
  );
});

test("rejects dependency cycles", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cycle-"));
  const path = helpers.writeContract(directory, helpers.fixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: helpers.packet({ objective: "a" }), dependsOn: ["b"] },
      { id: "b", type: "backend", taskPacket: helpers.packet({ objective: "b" }), dependsOn: ["a"] },
    ],
  }));
  assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /dependency cycle/u);
});
test("validate warns when a task packet verification command is absent from the Definition of Done", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cmd-warn-"));
  const value = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const nodes = /** @type {Array<Record<string, unknown>>} */ (value.nodes);
  nodes[0].taskPacket = helpers.packet({ verification: [{ argv: ["pnpm", "exec", "vitest", "run", "tests/fixtures/x.test.ts"] }] });
  nodes[0].definitionOfDone = ["It works"];
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.ok(contract.warnings.some((warning) => warning.includes("tests/fixtures/x.test.ts")));
  const clean = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const cleanNodes = /** @type {Array<Record<string, unknown>>} */ (clean.nodes);
  cleanNodes[0].taskPacket = helpers.packet({ verification: [{ argv: ["pnpm", "exec", "vitest", "run", "tests/fixtures/y.test.ts"] }] });
  cleanNodes[0].definitionOfDone = ["tests/fixtures/y.test.ts passes"];
  const cleanPath = helpers.writeContract(directory, clean);
  const cleanWarnings = validateContract(JSON.parse(readFileSync(cleanPath, "utf8")), cleanPath).warnings;
  assert.equal(cleanWarnings.length, 1, "only the single-node warning remains; no command-target warning");
  assert.match(cleanWarnings[0], /^single-node contract/u);
});

test("validate warns on a single-node contract and not on a batched DAG", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-single-node-warn-"));
  const singlePath = helpers.writeContract(directory, helpers.fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet(), gate: false }],
  }));
  const single = validateContract(JSON.parse(readFileSync(singlePath, "utf8")), singlePath);
  assert.ok(single.warnings.some((warning) => warning.startsWith("single-node contract")));

  const batchedPath = helpers.writeContract(directory, helpers.fixture({
    id: "batched-run",
    nodes: [
      { id: "first", type: "backend", taskPacket: helpers.packet({ objective: "a" }), gate: false },
      { id: "second", type: "backend", taskPacket: helpers.packet({ objective: "b" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const batched = validateContract(JSON.parse(readFileSync(batchedPath, "utf8")), batchedPath);
  assert.ok(!batched.warnings.some((warning) => warning.startsWith("single-node contract")));
});

test("validate warns when writeFiles land outside the workspace snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-unsnapshotted-warn-"));
  writeFileSync(join(directory, ".gitignore"), ".runs/\n.claude/\n");
  const path = helpers.writeContract(directory, helpers.fixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: helpers.packet({ writeFiles: [".claude/settings.json", ".claude/hooks/pre.mjs", "src/app.ts"] }),
      gate: false,
    }],
  }));
  initializeGit(directory);
  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  const unsnapshotted = warnings.filter((warning) => warning.includes("outside the workspace snapshot"));
  assert.equal(unsnapshotted.length, 1, "one warning per excluded root, not per file");
  assert.match(unsnapshotted[0], /nodes\[0\] \(build\): writeFiles under \.claude\//u);

  const clean = helpers.writeContract(directory, helpers.fixture({
    id: "clean-writes-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["src/app.ts"] }), gate: false }],
  }));
  const cleanWarnings = validateContract(JSON.parse(readFileSync(clean, "utf8")), clean).warnings;
  assert.ok(!cleanWarnings.some((warning) => warning.includes("outside the workspace snapshot")));

  const trackedDirectory = mkdtempSync(join(tmpdir(), "runner-tracked-ignored-write-"));
  writeFileSync(join(trackedDirectory, ".gitignore"), ".runs/\n.claude/\n");
  writeFileSync(join(trackedDirectory, "README.md"), "read\n");
  mkdirSync(join(trackedDirectory, ".claude"));
  writeFileSync(join(trackedDirectory, ".claude", "settings.json"), "tracked\n");
  initializeGit(trackedDirectory);
  execFileSync("git", ["-C", trackedDirectory, "add", "-f", ".claude/settings.json"]);
  const trackedPath = helpers.writeContract(trackedDirectory, helpers.fixture({
    id: "tracked-ignored-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: [".claude/settings.json"] }), gate: false }],
  }));
  const trackedWarnings = validateContract(JSON.parse(readFileSync(trackedPath, "utf8")), trackedPath).warnings;
  assert.ok(!trackedWarnings.some((warning) => warning.includes("outside the workspace snapshot")));
});

test("validate warns for paths hidden by optional .planrunnerignore", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-planrunnerignore-warn-"));
  writeFileSync(join(directory, "README.md"), "read\n");
  initializeGit(directory);
  writeFileSync(join(directory, ".planrunnerignore"), "generated.txt\n");
  writeFileSync(join(directory, "generated.txt"), "hidden\n");
  const path = helpers.writeContract(directory, helpers.fixture({
    id: "planrunnerignore-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["generated.txt"] }), gate: false }],
  }));
  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  assert.ok(warnings.some((warning) => warning.includes("writeFiles generated.txt") && warning.includes("outside the workspace snapshot")));

  const hiddenDirectory = mkdtempSync(join(tmpdir(), "runner-planrunnerignore-directory-warn-"));
  writeFileSync(join(hiddenDirectory, "README.md"), "read\n");
  initializeGit(hiddenDirectory);
  writeFileSync(join(hiddenDirectory, ".planrunnerignore"), "generated/\n");
  mkdirSync(join(hiddenDirectory, "generated"));
  const missingPath = helpers.writeContract(hiddenDirectory, helpers.fixture({
    id: "planrunnerignore-missing-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["generated/future.txt"] }), gate: false }],
  }));
  const missingWarnings = validateContract(JSON.parse(readFileSync(missingPath, "utf8")), missingPath).warnings;
  assert.ok(missingWarnings.some((warning) => warning.includes("writeFiles under generated/") && warning.includes("outside the workspace snapshot")));

  const rootPath = helpers.writeContract(hiddenDirectory, helpers.fixture({
    id: "planrunnerignore-root-write-run",
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "write hidden output",
        instructions: ["write output"],
        readFiles: [],
        writeRoots: ["generated"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  }));
  const rootWarnings = validateContract(JSON.parse(readFileSync(rootPath, "utf8")), rootPath).warnings;
  assert.ok(rootWarnings.some((warning) => warning.includes("writeRoots generated") && warning.includes("outside the workspace snapshot")));
});

test("validate shares combined Git ignore semantics with workspace snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-combined-ignore-warn-"));
  writeFileSync(join(directory, "README.md"), "read\n");
  initializeGit(directory);
  writeFileSync(join(directory, ".git", "info", "exclude"), "generated.txt\n");
  writeFileSync(join(directory, ".planrunnerignore"), "!generated.txt\n");
  writeFileSync(join(directory, "generated.txt"), "visible\n");
  const path = helpers.writeContract(directory, helpers.fixture({
    id: "combined-ignore-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["generated.txt"] }), gate: false }],
  }));

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  assert.ok(!warnings.some((warning) => warning.includes("writeFiles generated.txt") && warning.includes("outside the workspace snapshot")));

  const missingDirectory = mkdtempSync(join(tmpdir(), "runner-combined-ignore-missing-warn-"));
  writeFileSync(join(missingDirectory, "README.md"), "read\n");
  initializeGit(missingDirectory);
  writeFileSync(join(missingDirectory, ".git", "info", "exclude"), "future.txt\n");
  writeFileSync(join(missingDirectory, ".planrunnerignore"), "!future.txt\n");
  const missingPath = helpers.writeContract(missingDirectory, helpers.fixture({
    id: "combined-ignore-missing-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["future.txt"] }), gate: false }],
  }));

  const missingWarnings = validateContract(JSON.parse(readFileSync(missingPath, "utf8")), missingPath).warnings;
  assert.ok(!missingWarnings.some((warning) => warning.includes("writeFiles future.txt") && warning.includes("outside the workspace snapshot")));

  const gitignoreDirectory = mkdtempSync(join(tmpdir(), "runner-combined-ignore-gitignore-warn-"));
  writeFileSync(join(gitignoreDirectory, "README.md"), "read\n");
  writeFileSync(join(gitignoreDirectory, ".gitignore"), "nested/future.txt\n");
  initializeGit(gitignoreDirectory);
  writeFileSync(join(gitignoreDirectory, ".planrunnerignore"), "!nested/future.txt\n");
  const gitignorePath = helpers.writeContract(gitignoreDirectory, helpers.fixture({
    id: "combined-ignore-gitignore-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["nested/future.txt"] }), gate: false }],
  }));

  const gitignoreWarnings = validateContract(JSON.parse(readFileSync(gitignorePath, "utf8")), gitignorePath).warnings;
  assert.ok(!gitignoreWarnings.some((warning) => warning.includes("writeFiles under nested/") && warning.includes("outside the workspace snapshot")));

  const customIgnoreDirectory = mkdtempSync(join(tmpdir(), "runner-combined-ignore-custom-warn-"));
  writeFileSync(join(customIgnoreDirectory, "README.md"), "read\n");
  writeFileSync(join(customIgnoreDirectory, ".gitignore"), "!nested/future.txt\n");
  initializeGit(customIgnoreDirectory);
  writeFileSync(join(customIgnoreDirectory, ".planrunnerignore"), "nested/future.txt\n");
  const customIgnorePath = helpers.writeContract(customIgnoreDirectory, helpers.fixture({
    id: "combined-ignore-custom-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["nested/future.txt"] }), gate: false }],
  }));

  const customIgnoreWarnings = validateContract(JSON.parse(readFileSync(customIgnorePath, "utf8")), customIgnorePath).warnings;
  assert.ok(customIgnoreWarnings.some((warning) => warning.includes("writeFiles under nested/") && warning.includes("outside the workspace snapshot")));

  const noMatchDirectory = mkdtempSync(join(tmpdir(), "runner-combined-ignore-no-match-warn-"));
  writeFileSync(join(noMatchDirectory, "README.md"), "read\n");
  writeFileSync(join(noMatchDirectory, ".gitignore"), "nested/future.txt\n");
  initializeGit(noMatchDirectory);
  writeFileSync(join(noMatchDirectory, ".planrunnerignore"), "other.txt\n");
  const noMatchPath = helpers.writeContract(noMatchDirectory, helpers.fixture({
    id: "combined-ignore-no-match-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["nested/future.txt"] }), gate: false }],
  }));

  const noMatchWarnings = validateContract(JSON.parse(readFileSync(noMatchPath, "utf8")), noMatchPath).warnings;
  assert.ok(noMatchWarnings.some((warning) => warning.includes("writeFiles under nested/") && warning.includes("outside the workspace snapshot")));
});

test("validate requires a campaignId", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-id-"));
  const value = helpers.fixture();
  delete value.campaignId;
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /campaignId/u);

  for (const campaignId of [".", ".."]) {
    const invalid = helpers.fixture({ campaignId });
    writeFileSync(path, `${JSON.stringify(invalid, null, 2)}\n`);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /campaignId/u);
  }
});

test("validate rejects legacy prompt and promptFile fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-legacy-prompt-"));
  const value = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const legacyNodes = /** @type {Array<Record<string, unknown>>} */ (value.nodes);
  legacyNodes[0].prompt = "legacy prompt";
  const promptPath = helpers.writeContract(directory, value);
  assert.throws(() => validateContract(JSON.parse(readFileSync(promptPath, "utf8")), promptPath), /must not use prompt or promptFile/u);

  const fileValue = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const fileNodes = /** @type {Array<Record<string, unknown>>} */ (fileValue.nodes);
  fileNodes[0].promptFile = "legacy.md";
  const filePath = helpers.writeContract(directory, fileValue);
  assert.throws(() => validateContract(JSON.parse(readFileSync(filePath, "utf8")), filePath), /must not use prompt or promptFile/u);
});

test("validate loads taskPacketFile and renders a closed execution prompt", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-file-"));
  writeFileSync(join(directory, "packet.json"), `${JSON.stringify(helpers.packet())}\n`);
  const value = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const packetFileNodes = /** @type {Array<Record<string, unknown>>} */ (value.nodes);
  packetFileNodes[0] = { id: "build", type: "backend", phase: "fixture-phase-0", taskPacketFile: "packet.json", gate: false };
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes[0].taskPacket.mode, "execution");
  assert.match(contract.nodes[0].prompt, /Closed context/u);
  assert.match(contract.nodes[0].prompt, /exactly one JSON object/u);
  assert.doesNotMatch(contract.nodes[0].prompt, /BLOCKED_CONTEXT/u);
});

test("validate rejects malformed, escaping, and missing-read-file task packets", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-invalid-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-task-packet-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(directory, "outside-link"));
  const cases = [
    [helpers.packet({ readFiles: ["../outside"] }), /escapes cwd/u],
    [helpers.packet({ writeFiles: ["../outside"] }), /escapes cwd/u],
    [helpers.packet({ readFiles: ["outside-link"] }), /escapes cwd/u],
    [helpers.packet({ writeFiles: ["outside-link"] }), /escapes cwd/u],
    [helpers.packet({ writeFiles: ["."] }), /must name a file/u],
    [helpers.packet({ readFiles: ["missing.txt"] }), /does not exist/u],
    [helpers.packet({ mode: "discovery", writeFiles: ["README.md"] }), /must be empty for a discovery packet/u],
    [helpers.packet({ mode: "execution", readFiles: [] }), /readFiles must not be empty/u],
    [helpers.packet({ mode: "execution", writeFiles: [] }), /writeFiles must not be empty/u],
  ];
  for (const [taskPacket, expected] of cases) {
    const value = helpers.fixture({ nodes: [{ id: "build", type: "backend", taskPacket, gate: false }] });
    const path = helpers.writeContract(directory, value);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), expected);
  }
});

test("validate rejects new write paths beneath an outward symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-target-"));
  symlinkSync(outside, join(directory, "outside-dir"));
  const value = helpers.fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["outside-dir/new.txt"] }), gate: false }],
  });
  const path = helpers.writeContract(directory, value);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /escapes cwd/u,
  );
});

test("validate rejects a symlink followed by dotdot escaping cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-dotdot-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-dotdot-target-"));
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(directory, "secret.txt"), "inside secret");
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(join(outside, "sub"), join(directory, "link"));
  const value = helpers.fixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: helpers.packet({ readFiles: ["link/../secret.txt"] }),
      gate: false,
    }],
  });
  const path = helpers.writeContract(directory, value);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /escapes cwd/u,
  );
});

test("judge prompt exposes only the write-file evidence boundary", () => {
  const node = {
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../scripts/contract.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: ["It works"],
  };
  const prompt = judgePrompt(node, "worker complete");
  assert.match(prompt, /Write files:\n- README\.md/u);
  assert.doesNotMatch(prompt, /Read files/u);
  assert.doesNotMatch(prompt, /contract\.json/u);
});

test("discovery packets render as read-only discovery work", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-discovery-packet-"));
  const value = helpers.fixture({
    nodes: [{
      id: "discover",
      type: "backend",
      taskPacket: helpers.packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Find the entrypoint" }),
      gate: false,
    }],
  });
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.match(contract.nodes[0].prompt, /read-only/u);
  assert.match(contract.nodes[0].prompt, /worker-result JSON object/u);
  assert.doesNotMatch(contract.nodes[0].prompt, /BLOCKED_CONTEXT/u);
});

test("stored contract inlines the task packet and drops the generated prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-stored-packet-"));
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const path = helpers.writeContract(directory, helpers.fixture({ id: "stored-packet-run", pollIntervalMs: 10 }));
  initializeGit(directory);
  const result = await helpers.withFakeCodex(directory, "pass", () => runContract(path));
  const stored = JSON.parse(readFileSync(join(result.runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].taskPacket.mode, "execution");
  assert.equal(stored.nodes[0].prompt, undefined);
  assert.equal(stored.nodes[0].taskPacketFile, undefined);
  const revalidated = validateContract(stored, join(result.runDir, "contract.json"));
  assert.match(revalidated.nodes[0].prompt, /Closed context/u);
});

test("autonomous packets use bounded write roots and render a read-only inspection boundary", () => {
  const { directory, path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["src"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  mkdirSync(join(directory, "src"));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[0].taskPacket.writeRoots, ["src"]);
  assert.match(contract.nodes[0].prompt, /write roots/u);
  assert.match(contract.nodes[0].prompt, /read-only/u);
  assert.doesNotMatch(contract.nodes[0].prompt, /Write files/u);

  for (const invalid of [
    { writeFiles: [] },
    { writeRoots: ["."] },
    { writeRoots: ["../outside"] },
  ]) {
    const invalidPath = writeFixture({
      nodes: [{
        id: "build",
        type: "backend",
        taskPacket: {
          mode: "autonomous",
          objective: "Implement it",
          instructions: ["Inspect as needed and make the change"],
          readFiles: [],
          writeRoots: ["src"],
          symbols: [],
          decisions: [],
          nonGoals: [],
          verification: [],
          ...invalid,
        },
        gate: false,
      }],
    });
    mkdirSync(join(invalidPath.directory, "src"));
    assert.throws(() => validateContract(JSON.parse(readFileSync(invalidPath.path, "utf8")), invalidPath.path), /autonomous|writeRoots|escapes cwd/u);
  }
});

test("autonomous write roots reject symlinks resolving to cwd but allow nested symlinks", () => {
  const root = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["alias"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  symlinkSync(".", join(root.directory, "alias"));
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(root.path, "utf8")), root.path),
    /escapes cwd/u,
  );

  const nested = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["alias"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  mkdirSync(join(nested.directory, "src"));
  symlinkSync("src", join(nested.directory, "alias"));
  const contract = validateContract(JSON.parse(readFileSync(nested.path, "utf8")), nested.path);
  assert.deepEqual(contract.nodes[0].taskPacket.writeRoots, ["alias"]);
});

test("validates node budgets and bounded progress policy", () => {
  const { path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      maxInputTokens: 100,
      maxCostUsd: 2.5,
      progressPolicy: { graceSec: 5, intervalSec: 10, maxDryHeartbeats: 3 },
      taskPacket: packet(),
      gate: false,
    }],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes[0].maxInputTokens, 100);
  assert.equal(contract.nodes[0].maxCostUsd, 2.5);
  assert.deepEqual(contract.nodes[0].progressPolicy, { graceSec: 5, intervalSec: 10, maxDryHeartbeats: 3 });

  for (const [field, value] of /** @type {[string, unknown][]} */ ([
    ["maxInputTokens", 0],
    ["maxCostUsd", Infinity],
    ["progressPolicy", { graceSec: -1, intervalSec: 10, maxDryHeartbeats: 3 }],
    ["progressPolicy", { graceSec: 5, intervalSec: 0, maxDryHeartbeats: 3 }],
    ["progressPolicy", { graceSec: 5, intervalSec: 10, maxDryHeartbeats: 1.5 }],
  ])) {
    const invalid = writeFixture({
      nodes: [{ id: "build", type: "backend", [field]: value, taskPacket: packet(), gate: false }],
    });
    assert.throws(() => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path), /maxInputTokens|maxCostUsd|progressPolicy/u);
  }
});

test("replayPolicy defaults to safe and accepts only its enumerated values", () => {
  const defaulted = writeFixture();
  const contract = validateContract(JSON.parse(readFileSync(defaulted.path, "utf8")), defaulted.path);
  assert.equal(contract.nodes[0].replayPolicy, "safe");

  for (const policy of ["safe", "reconcile", "never"]) {
    const accepted = writeFixture({
      nodes: [{ id: "build", type: "backend", replayPolicy: policy, taskPacket: packet(), gate: false }],
    });
    const validated = validateContract(JSON.parse(readFileSync(accepted.path, "utf8")), accepted.path);
    assert.equal(validated.nodes[0].replayPolicy, policy);
  }

  for (const invalid of [true, "retry", "SAFE", 1]) {
    const rejected = writeFixture({
      nodes: [{ id: "build", type: "backend", replayPolicy: invalid, taskPacket: packet(), gate: false }],
    });
    assert.throws(
      () => validateContract(JSON.parse(readFileSync(rejected.path, "utf8")), rejected.path),
      /replayPolicy must be one of safe, reconcile, never/u,
    );
  }
});

test("autonomous workers receive durable progress defaults", () => {
  const autonomousPacket = packet({ mode: "autonomous", writeRoots: ["src"] });
  const { writeFiles: _writeFiles, ...autonomousPacketWithoutFiles } = autonomousPacket;
  const { path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: autonomousPacketWithoutFiles,
      gate: false,
    }],
  });
  mkdirSync(join(dirname(path), "src"));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[0].progressPolicy, { graceSec: 300, intervalSec: 120, maxDryHeartbeats: 3 });
});

test("routes runtime failover rules from event state and rejects self-loops", () => {
  const { path } = writeFixture({
    runtimes: {
      worker: { driver: "codex", model: "worker" },
      fallback: { driver: "codex", model: "fallback" },
    },
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimeRules: [{
      match: { role: "worker", status: "failed", errorCode: "timeout", currentRuntime: "worker" },
      runtime: "fallback",
      backoffSec: 2,
    }],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const routed = routeRuntime(contract, contract.nodes[0], "worker", {
    status: "failed",
    errorCode: "timeout",
    currentRuntime: "worker",
  });
  assert.equal(routed.id, "fallback");
  assert.equal(routed.backoffSec, 2);
  assert.equal(routeRuntime(contract, contract.nodes[0], "worker").id, "worker");

  const invalid = writeFixture({
    runtimes: {
      worker: { driver: "codex", model: "worker" },
    },
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimeRules: [{ match: { currentRuntime: "worker" }, runtime: "worker" }],
  });
  assert.throws(() => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path), /self-loop|currentRuntime/u);
});

test("validates bounded cost, routing, progress, and worktree snapshot state", () => {
  const valid = snapshot({
    costUsd: 1.25,
    routing: {
      history: [{
        at: "2026-01-01T00:00:00.000Z",
        role: "worker",
        runtime: "worker",
        status: "failed",
        errorCode: "timeout",
        backoffSec: 1,
      }],
      currentOverride: {
        at: "2026-01-01T00:00:01.000Z",
        role: "worker",
        runtime: "worker",
        reason: "retry",
      },
    },
    progress: {
      revision: 0,
      heartbeatCount: 1,
      dryHeartbeatCount: 0,
      progressSignature: "digest",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      nextCheckAt: "2026-01-01T00:00:10.000Z",
    },
    worktree: { status: "unassigned", path: null, branch: null, commit: null },
  });
  validateNodeSnapshot(valid);

  for (const override of [
    { costUsd: -1 },
    { progress: { heartbeatCount: -1, dryHeartbeatCount: 0, lastHeartbeatAt: null, lastProgressAt: null } },
    { worktree: { status: "unknown", path: null, branch: null, commit: null } },
  ]) {
    assert.throws(() => validateNodeSnapshot({ ...snapshot(), ...override }), /costUsd|progress|worktree/u);
  }
});
