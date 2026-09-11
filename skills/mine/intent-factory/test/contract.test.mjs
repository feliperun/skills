import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTENT_FACTORY_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  captureSourceIdentity,
  hashPacket,
  routeRuntime,
  validateContract,
  validateEvent,
  validateNodeSnapshot,
  validateRunMetadata,
} from "../scripts/contract.mjs";
import { SIGNAL_END, SIGNAL_START } from "../scripts/signal-block.mjs";
import { judgePrompt } from "../scripts/lib.mjs";
import { JUDGE_LIMITS } from "../scripts/judge-envelope.mjs";
import { runContract } from "../scripts/runner.mjs";
import { harnessCapabilities } from "../scripts/harnesses/index.mjs";
import * as helpers from "./helpers.mjs";

/** @param {string} directory */
function initializeGit(directory) {
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { stdio: "ignore" });
    return;
  } catch {}
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

function budgetProfile(overrides = {}) {
  return {
    estimatedWeightedInputTokens: 100,
    estimatedTurns: 2,
    contextWindowTokens: 1_000,
    safetyFraction: 0.75,
    minimumSegmentTokens: 25,
    growthIncrementTokens: 25,
    preambleBytes: 40,
    tokenizerEstimate: { bytes: 4, tokens: 1, source: "test measurement" },
    continuation: { enabled: true, maxSegments: 2, segmentReserveTokens: 25 },
    ...overrides,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function fixture(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    id: "contract-test",
    campaignId: "campaign-test",
    goal: "validate protocol",
    cwd: ".",
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { harness: "codex", model: "test-model", executable: "/nonexistent/codex" } },
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
  assert.equal(contract.contractVersion, INTENT_FACTORY_VERSION);
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

test("validation requires a node phase", () => {
  const missingPhase = helpers.fixture();
  const missingPhaseNodes = /** @type {Record<string, unknown>[]} */ (missingPhase.nodes);
  const { phase: _phase, ...missingPhaseNode } = missingPhaseNodes[0];
  missingPhaseNodes[0] = missingPhaseNode;
  const phasePath = helpers.writeContract(mkdtempSync(join(tmpdir(), "runner-missing-phase-")), missingPhase);
  assert.throws(() => validateContract(JSON.parse(readFileSync(phasePath, "utf8")), phasePath), /nodes\[0\]\.phase/u);
});

test("schema 2 rejects a schema-1 string Definition of Done item and an item without proof", () => {
  const stringItem = writeFixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: ["It works"], gate: false }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(stringItem.path, "utf8")), stringItem.path),
    /must be an object, not a schema-1 string item/u,
  );
  const unproven = writeFixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works" }], gate: false }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(unproven.path, "utf8")), unproven.path),
    /must declare proof or judgment: true/u,
  );
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

test("validation rejects unknown fields at every protocol layer", () => {
  const cases = [
    [{ typo: true }, /contract has unexpected field typo/u],
    [{ usagePolicy: false }, /contract has unexpected field usagePolicy/u],
    [{ maxInputTokens: 100 }, /contract has unexpected field maxInputTokens/u],
    [{ maxCostUsd: 1 }, /contract has unexpected field maxCostUsd/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, typo: true }] }, /nodes\[0\] has unexpected field typo/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, maxInputTokens: 100 }] }, /nodes\[0\] has unexpected field maxInputTokens/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, maxCostUsd: 1 }] }, /nodes\[0\] has unexpected field maxCostUsd/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, budgetProfile: budgetProfile() }] }, /nodes\[0\] has unexpected field budgetProfile/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false, progressPolicy: { graceSec: 0, intervalSec: 1, maxDryHeartbeats: 3 } }] }, /nodes\[0\] has unexpected field progressPolicy/u],
    [{ runtimes: { worker: { harness: "codex", model: "m", executable: "/nonexistent/codex", typo: true } } }, /runtime worker has unexpected field typo/u],
    [{ nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { typo: true } }] }, /nodes\[0\]\.gate has unexpected field typo/u],
  ];
  for (const [override, expected] of cases) {
    const { path } = writeFixture(override);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), expected);
  }
});

test("validation rejects unsupported protocol versions and stale packet hashes", () => {
  const versioned = writeFixture({ schemaVersion: 99 });
  assert.throws(() => validateContract(JSON.parse(readFileSync(versioned.path, "utf8")), versioned.path), new RegExp(`schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`, "u"));
  const schema2 = writeFixture({ schemaVersion: 2 });
  assert.throws(() => validateContract(JSON.parse(readFileSync(schema2.path, "utf8")), schema2.path), new RegExp(`schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`, "u"));
  const stale = writeFixture({ nodes: [{ id: "build", type: "backend", taskPacket: packet(), packetHash: "0".repeat(64), gate: false }] });
  assert.throws(() => validateContract(JSON.parse(readFileSync(stale.path, "utf8")), stale.path), /packetHash does not match/u);
});

// A gated node needs a judge on a different vendor than its worker; the base
// fixture's single "worker" runtime cannot serve both roles once the gate is
// enabled, so every gate-enabled fixture below adds a cross-vendor judge.
const gatedRuntimes = {
  runtimes: { worker: { harness: "codex", model: "test-model", executable: "/nonexistent/codex" }, judge: { harness: "claude", model: "judge-model", executable: "/nonexistent/claude" } },
  runtimeDefaults: { worker: "worker", judge: "judge" },
};

test("gate review defaults to advisory and accepts none, advisory, and blocking", () => {
  const omitted = writeFixture({
    ...gatedRuntimes,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  const omittedContract = validateContract(JSON.parse(readFileSync(omitted.path, "utf8")), omitted.path);
  assert.equal(omittedContract.nodes[0].gate.review, "advisory", "an omitted review mode reviews advisorially");
  for (const review of ["none", "advisory", "blocking"]) {
    const written = writeFixture({
      ...gatedRuntimes,
      nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { review, failOn: ["major", "critical"] } }],
    });
    const contract = validateContract(JSON.parse(readFileSync(written.path, "utf8")), written.path);
    assert.equal(contract.nodes[0].gate.review, review);
  }
  const invalid = writeFixture({
    ...gatedRuntimes,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { review: "optional" } }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path),
    /gate\.review must be none, advisory, or blocking/u,
  );
});

test("validation rejects blocking review without major and major without critical", () => {
  const cases = [
    [{ ...gatedRuntimes, nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { review: "blocking" } }] },
      /nodes\[0\] \(build\): gate\.review blocking requires major in gate\.failOn \(TECH-SPEC lean, rule 2\)/u],
    [{ ...gatedRuntimes, nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { review: "blocking", failOn: ["critical"] } }] },
      /nodes\[0\] \(build\): gate\.review blocking requires major in gate\.failOn/u],
    [{ ...gatedRuntimes, nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { review: "blocking", failOn: ["major"] } }] },
      /gate\.failOn lists major without critical/u],
    [{ ...gatedRuntimes, nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["minor", "major"] } }] },
      /gate\.failOn lists major without critical/u],
  ];
  for (const [override, expected] of cases) {
    const { path } = writeFixture(override);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), expected);
  }
  // Advisory review ignores failOn entirely, so only the set's own shape is checked.
  const advisory = writeFixture({
    ...gatedRuntimes,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["minor"] } }],
  });
  const advisoryContract = validateContract(JSON.parse(readFileSync(advisory.path, "utf8")), advisory.path);
  assert.deepEqual(advisoryContract.nodes[0].gate.failOn, ["minor"]);
});

test("a verification proof must name a declared verification command", () => {
  /** @param {{kind: "verification", ref: number|string}} proof */
  const node = (proof) => ({ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [
    { id: "verified", text: "the controller verification passed", proof },
  ], gate: false });
  const reused = writeFixture({ nodes: [node({ kind: "verification", ref: 0 })] });
  const reusedContract = validateContract(JSON.parse(readFileSync(reused.path, "utf8")), reused.path);
  assert.deepEqual(reusedContract.nodes[0].definitionOfDone[0].proof, { kind: "verification", ref: "0" });
  const asString = writeFixture({ nodes: [node({ kind: "verification", ref: "0" })] });
  const asStringContract = validateContract(JSON.parse(readFileSync(asString.path, "utf8")), asString.path);
  assert.deepEqual(asStringContract.nodes[0].definitionOfDone[0].proof, { kind: "verification", ref: "0" }, "a decimal string ref is the same reference");

  const cases = [
    [node({ kind: "verification", ref: 1 }), /proof\.ref 1 names no verification command: the packet declares 1/u],
    [node({ kind: "verification", ref: "zero" }), /proof\.ref must be the zero-based index of a verification command/u],
    [node({ kind: "verification", ref: -1 }), /proof\.ref must be the zero-based index/u],
  ];
  for (const [nodeOverride, expected] of cases) {
    const { path } = writeFixture({ nodes: [nodeOverride] });
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), expected);
  }
});

function snapshot(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
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
    [{ runtime: { id: "worker" } }, /node snapshot\.runtime\.harness/u],
    [{ blockedBy: [7] }, /blockedBy item/u],
    [{ startedAt: "not-a-timestamp" }, /startedAt/u],
    [{ result: {} }, /worker result/u],
    [{ gate: { verdict: "pass", maxSeverity: "none", summary: "ok", findings: [{}] } }, /findings\[0\]/u],
    [{ error: { code: "bad" } }, /node snapshot\.error\.message/u],
    [{ usage: { inputTokens: "10", outputTokens: 0, cacheReadInputTokens: 0 } }, /usage\.inputTokens/u],
    [{ scopeFindings: { unexpectedPaths: [7] } }, /scopeFindings\.unexpectedPaths/u],
    [{ scopeFindings: { unexpectedPaths: [], typo: true } }, /scopeFindings has unexpected field typo/u],
    [{ review: "optional" }, /node snapshot\.review is invalid/u],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => validateNodeSnapshot(snapshot(override)), expected);
  }
});

test("node snapshots accept the review mode and an invalid-judge-output gate record", () => {
  assert.doesNotThrow(() => validateNodeSnapshot(snapshot({ review: "advisory" })));
  for (const review of ["none", "blocking"]) {
    assert.doesNotThrow(() => validateNodeSnapshot(snapshot({ review })));
  }
  const invalidVerdict = validateNodeSnapshot(snapshot({
    review: "advisory",
    status: "done",
    gate: {
      verdict: "invalid_judge_output",
      maxSeverity: "none",
      summary: "judge produced no usable verdict: the judge returned 2 separate verdicts",
      findings: [],
    },
  }));
  assert.equal(invalidVerdict.gate?.verdict, "invalid_judge_output");
  assert.throws(
    () => validateNodeSnapshot(snapshot({
      gate: { verdict: "invalid_judge_output", maxSeverity: "major", summary: "carry findings", findings: [] },
    })),
    /invalid_judge_output records no findings/u,
  );
});

test("node snapshots accept an advisory scope finding bounded to 64 paths", () => {
  const withFinding = snapshot({ scopeFindings: { unexpectedPaths: ["a.txt", "b.txt"] } });
  assert.deepEqual(validateNodeSnapshot(withFinding).scopeFindings, { unexpectedPaths: ["a.txt", "b.txt"] });
  assert.throws(
    () => validateNodeSnapshot(snapshot({ scopeFindings: { unexpectedPaths: Array.from({ length: 65 }, (_, i) => `${i}.txt`) } })),
    /scopeFindings\.unexpectedPaths/u,
  );
});

test("persisted scope boundaries name the roots that authorized a regular file", () => {
  const boundary = {
    schemaVersion: 1,
    files: [],
    roots: ["docs/NOTES.md", "src"],
    fileRoots: ["docs/NOTES.md"],
    fileOrigins: [],
    rootOrigins: [
      { literal: "docs/NOTES.md", paths: ["docs/NOTES.md"] },
      { literal: "src", paths: ["src"] },
    ],
  };
  const scope = { changedPaths: [], unexpectedPaths: [], changedPathCount: 0, unexpectedPathCount: 0, truncated: false, boundary };
  assert.deepEqual(validateNodeSnapshot(snapshot({ scope })).scope?.boundary?.fileRoots, ["docs/NOTES.md"]);
  const cases = [
    { ...scope, boundary: { ...boundary, fileRoots: ["elsewhere.txt"] } },
    { ...scope, boundary: { ...boundary, fileRoots: "docs/NOTES.md" } },
    { ...scope, boundary: { ...boundary, typo: true } },
  ];
  for (const invalid of cases) {
    assert.throws(() => validateNodeSnapshot(snapshot({ scope: invalid })), /node snapshot\.scope\.boundary/u);
  }
});

/** @param {Record<string, unknown>} [overrides] */
function event(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    at: "2026-01-01T00:00:00.000Z",
    node: "build",
    to: "running",
    sourceIdentity: { kind: "node", contractId: "contract-test", nodeId: "build" },
    packetHash: "a".repeat(64),
    ...overrides,
  };
}

test("events accept an advisory scope.finding type alongside the bounded unexpected paths", () => {
  const finding = validateEvent(event({
    type: "scope.finding",
    from: "running",
    unexpectedPaths: ["a.txt"],
    unexpectedPathCount: 1,
  }));
  assert.equal(finding.type, "scope.finding");
  assert.throws(() => validateEvent(event({ type: 7 })), /event\.type/u);
  assert.throws(() => validateEvent(event({ typo: true })), /event has unexpected field typo/u);
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
    harness: "codex",
    model: "test-model",
    capabilities: harnessCapabilities({ harness: "codex" }),
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
    ["tools", "Read,Bash"],
    ["executable", 7],
    ["args", "--json"],
    ["versionArgs", ["--version", 1]],
    ["maxArgvPromptBytes", "4096"],
    ["requiredCapabilities", []],
  ];
  for (const [field, value] of runtimeCases) {
    const { path } = writeFixture({ runtimes: { worker: { harness: "codex", model: "test-model", executable: "/nonexistent/codex", [field]: value } } });
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), new RegExp(`runtime worker\\.${field}`));
  }

  const unknownFallback = writeFixture({ runtimes: { worker: { harness: "codex", model: "test-model", executable: "/nonexistent/codex", fallback: "missing" } } });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(unknownFallback.path, "utf8")), unknownFallback.path),
    /runtime worker\.fallback.*unknown runtime/u,
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
  nodes[0].definitionOfDone = [{ id: "works", text: "It works", judgment: true }];
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.ok(contract.warnings.some((warning) => warning.includes("tests/fixtures/x.test.ts")));
  const clean = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const cleanNodes = /** @type {Array<Record<string, unknown>>} */ (clean.nodes);
  cleanNodes[0].taskPacket = helpers.packet({ verification: [{ argv: ["pnpm", "exec", "vitest", "run", "tests/fixtures/y.test.ts"] }] });
  cleanNodes[0].definitionOfDone = [{ id: "y-test", text: "tests/fixtures/y.test.ts passes", proof: { kind: "command", ref: "pnpm exec vitest run tests/fixtures/y.test.ts" } }];
  const cleanPath = helpers.writeContract(directory, clean);
  const cleanWarnings = validateContract(JSON.parse(readFileSync(cleanPath, "utf8")), cleanPath).warnings;
  assert.deepEqual(cleanWarnings, [], "no command-target warning and no single-node warning");
});

test("validate rejects neither a single-node contract nor a batched DAG", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-single-node-warn-"));
  const singlePath = helpers.writeContract(directory, helpers.fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet(), gate: false }],
  }));
  const single = validateContract(JSON.parse(readFileSync(singlePath, "utf8")), singlePath);
  assert.deepEqual(single.warnings, [], "a single-node contract is simply valid");

  const batchedPath = helpers.writeContract(directory, helpers.fixture({
    id: "batched-run",
    nodes: [
      { id: "first", type: "backend", taskPacket: helpers.packet({ objective: "a" }), gate: false },
      { id: "second", type: "backend", taskPacket: helpers.packet({ objective: "b" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const batched = validateContract(JSON.parse(readFileSync(batchedPath, "utf8")), batchedPath);
  assert.deepEqual(batched.warnings, []);
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

test("validate warns for paths hidden by optional .intentfactoryignore", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-intentfactoryignore-warn-"));
  writeFileSync(join(directory, "README.md"), "read\n");
  initializeGit(directory);
  writeFileSync(join(directory, ".intentfactoryignore"), "generated.txt\n");
  writeFileSync(join(directory, "generated.txt"), "hidden\n");
  const path = helpers.writeContract(directory, helpers.fixture({
    id: "intentfactoryignore-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["generated.txt"] }), gate: false }],
  }));
  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  assert.ok(warnings.some((warning) => warning.includes("writeFiles generated.txt") && warning.includes("outside the workspace snapshot")));

  const hiddenDirectory = mkdtempSync(join(tmpdir(), "runner-intentfactoryignore-directory-warn-"));
  writeFileSync(join(hiddenDirectory, "README.md"), "read\n");
  initializeGit(hiddenDirectory);
  writeFileSync(join(hiddenDirectory, ".intentfactoryignore"), "generated/\n");
  mkdirSync(join(hiddenDirectory, "generated"));
  const missingPath = helpers.writeContract(hiddenDirectory, helpers.fixture({
    id: "intentfactoryignore-missing-write-run",
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["generated/future.txt"] }), gate: false }],
  }));
  const missingWarnings = validateContract(JSON.parse(readFileSync(missingPath, "utf8")), missingPath).warnings;
  assert.ok(missingWarnings.some((warning) => warning.includes("writeFiles under generated/") && warning.includes("outside the workspace snapshot")));

  const rootPath = helpers.writeContract(hiddenDirectory, helpers.fixture({
    id: "intentfactoryignore-root-write-run",
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
  writeFileSync(join(directory, ".intentfactoryignore"), "!generated.txt\n");
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
  writeFileSync(join(missingDirectory, ".intentfactoryignore"), "!future.txt\n");
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
  writeFileSync(join(gitignoreDirectory, ".intentfactoryignore"), "!nested/future.txt\n");
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
  writeFileSync(join(customIgnoreDirectory, ".intentfactoryignore"), "nested/future.txt\n");
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
  writeFileSync(join(noMatchDirectory, ".intentfactoryignore"), "other.txt\n");
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
  const node = /** @type {import("../scripts/lib.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../scripts/contract.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const prompt = judgePrompt(node, "worker complete");
  assert.match(prompt, /Write files:\n- README\.md/u);
  assert.match(prompt, /\[works\] It works/u);
  assert.doesNotMatch(prompt, /Read files/u);
  assert.doesNotMatch(prompt, /contract\.json/u);
});

test("judge prompt advertises the envelope the parser enforces", () => {
  const node = /** @type {import("../scripts/lib.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../scripts/contract.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const prompt = judgePrompt(node, "worker complete");
  // A verdict that overshoots is discarded unread, so the numbers the parser
  // enforces have to be the numbers the prompt states: a judge told nothing
  // about the limit can only be destroyed by it, and the re-ask repeats it.
  assert.match(prompt, new RegExp(`keep \`summary\` within ${JUDGE_LIMITS.summaryBytes} bytes`, "u"));
  assert.match(prompt, new RegExp(`at most ${JUDGE_LIMITS.findings} findings`, "u"));
  assert.match(prompt, new RegExp(`\`description\` within ${JUDGE_LIMITS.descriptionBytes} bytes`, "u"));
  assert.match(prompt, new RegExp(`\`evidence\` within ${JUDGE_LIMITS.evidenceBytes} bytes`, "u"));
  assert.match(prompt, /rejected unread/u);
});

test("judge prompt lists scope findings only when the node carries an advisory finding", () => {
  const node = /** @type {import("../scripts/lib.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../scripts/contract.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const clean = judgePrompt(node, "worker complete");
  assert.doesNotMatch(clean, /Scope findings/u);

  const flagged = judgePrompt(node, "worker complete", { scopeFindings: { unexpectedPaths: ["outside.txt"] } });
  assert.match(flagged, /Scope findings/u);
  assert.match(flagged, /- outside\.txt/u);
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

test("an autonomous write root may name an existing regular file", () => {
  const { directory, path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["docs/NOTES.md"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs", "NOTES.md"), "notes\n");
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[0].taskPacket.writeRoots, ["docs/NOTES.md"]);
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

test("runtime fallback is a declared one-hop edge and rejects self-loops", () => {
  const { path } = writeFixture({
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex", fallback: "backup" },
      backup: { harness: "codex", model: "backup", executable: "/nonexistent/codex" },
    },
    runtimeDefaults: { worker: "worker", judge: "worker" },
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes.worker.fallback, "backup");
  assert.equal(routeRuntime(contract, contract.nodes[0], "worker").id, "worker");
  assert.equal(routeRuntime(contract, contract.nodes[0], "worker", { currentRuntime: "backup" }).id, "backup");

  const invalid = writeFixture({
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex", fallback: "worker" },
    },
    runtimeDefaults: { worker: "worker", judge: "worker" },
  });
  assert.throws(() => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path), /fallback cannot name itself/u);
});

test("verification rejects a worker permission mode that cannot execute commands", () => {
  const allowed = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: {
      worker: {
        harness: "claude",
        model: "worker",
        executable: "/nonexistent/claude",
        permissionMode: "bypassPermissions",
      },
    },
  });
  assert.equal(validateContract(JSON.parse(readFileSync(allowed.path, "utf8")), allowed.path).nodes.length, 1);

  const denied = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: {
      worker: {
        harness: "claude",
        model: "worker",
        executable: "/nonexistent/claude",
        permissionMode: "acceptEdits",
      },
    },
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(denied.path, "utf8")), denied.path),
    /\(build\).*worker runtime worker uses permissionMode=acceptEdits; claude executes commands only in bypassPermissions/u,
  );

  const zcodeDefault = writeFixture({
    runtimeDefaults: { worker: "zcode", judge: "zcode" },
    runtimes: {
      zcode: { harness: "zcode", model: "worker", executable: "/nonexistent/zcode" },
    },
  });
  assert.equal(validateContract(JSON.parse(readFileSync(zcodeDefault.path, "utf8")), zcodeDefault.path).nodes.length, 1);
});

test("verification rejects a non-executing worker fallback and ignores the judge permission mode", () => {
  const deniedFallback = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: {
      worker: {
        harness: "replay",
        model: "worker",
        vendor: "recorded-worker",
        executable: "/nonexistent/replay",
        fallback: "backup",
      },
      backup: {
        harness: "zcode",
        model: "backup",
        executable: "/nonexistent/zcode",
        permissionMode: "edit",
      },
    },
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(deniedFallback.path, "utf8")), deniedFallback.path),
    /\(build\).*worker fallback runtime backup uses permissionMode=edit; zcode executes commands only in yolo/u,
  );

  const judgeDenied = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex" },
      judge: {
        harness: "claude",
        model: "judge",
        executable: "/nonexistent/claude",
        permissionMode: "acceptEdits",
      },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  assert.equal(validateContract(JSON.parse(readFileSync(judgeDenied.path, "utf8")), judgeDenied.path).nodes[0].gate.enabled, true);
});

test("a gate-enabled node whose worker and judge runtime share a vendor is rejected by name", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /worker runtime worker and judge runtime worker share vendor openai/u,
  );
});

test("a gate-enabled node whose worker and judge have distinct vendors, and whose worker fallback is also a distinct vendor, passes", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex", fallback: "worker-backup" },
      "worker-backup": { harness: "agy", model: "worker-backup", executable: "/nonexistent/agy" },
      judge: { harness: "claude", model: "judge", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes[0].gate.enabled, true);
});

test("a gate-enabled node whose worker fallback shares the judge's vendor is rejected", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex", fallback: "worker-backup" },
      "worker-backup": { harness: "claude", model: "worker-backup", executable: "/nonexistent/claude" },
      judge: { harness: "claude", model: "judge", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /worker runtime worker fallback runtime worker-backup and judge runtime judge share vendor anthropic/u,
  );
});

test("a gate-enabled node whose worker fallback's own fallback shares the judge's vendor is rejected", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex", fallback: "worker-backup" },
      "worker-backup": { harness: "agy", model: "worker-backup", executable: "/nonexistent/agy", fallback: "worker-backup-2" },
      "worker-backup-2": { harness: "claude", model: "worker-backup-2", executable: "/nonexistent/claude" },
      judge: { harness: "claude", model: "judge", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /worker runtime worker fallback runtime worker-backup-2 and judge runtime judge share vendor anthropic/u,
  );
});

test("a gate-enabled node whose worker fallback chain cycles is rejected", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "worker", executable: "/nonexistent/codex", fallback: "worker-backup" },
      "worker-backup": { harness: "agy", model: "worker-backup", executable: "/nonexistent/agy", fallback: "worker" },
      judge: { harness: "claude", model: "judge", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /worker runtime worker fallback chain cycles back to worker/u,
  );
});

test("a codex runtime with a custom model_provider resolves to that provider's vendor, not openai", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "deepseek-flash", judge: "opus" },
    runtimes: {
      "deepseek-flash": { harness: "codex", model: "deepseek-v4-flash", executable: "/nonexistent/codex", config: { model_provider: "deepseek" } },
      opus: { harness: "claude", model: "opus", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes["deepseek-flash"].vendor, "deepseek");
  assert.equal(contract.runtimes.opus.vendor, "anthropic");
});

test("two replay runtimes declare distinct vendors outright, since the harness has no default", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "replay-a", judge: "replay-b" },
    runtimes: {
      "replay-a": { harness: "replay", model: "a", vendor: "vendor-a", config: { "replay.recording": "a.jsonl" } },
      "replay-b": { harness: "replay", model: "b", vendor: "vendor-b", config: { "replay.recording": "b.jsonl" } },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes["replay-a"].vendor, "vendor-a");
  assert.equal(contract.runtimes["replay-b"].vendor, "vendor-b");
});

test("a replay runtime with no declared vendor is rejected: the harness names no default", () => {
  const { path } = writeFixture({
    runtimeDefaults: { worker: "replay-a", judge: "replay-a" },
    runtimes: {
      "replay-a": { harness: "replay", model: "a", config: { "replay.recording": "a.jsonl" } },
    },
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /runtime replay-a has no resolvable vendor/u,
  );
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

test("finalVerification accepts the verification-command schema and rejects unknown shapes", () => {
  const { path } = writeFixture({
    finalVerification: [
      { argv: ["npm", "test"], timeoutSec: 600 },
      { argv: ["node", "--test"], cwd: "sub", repeat: 2, env: ["CI"] },
    ],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.finalVerification?.length, 2);
  assert.deepEqual(contract.finalVerification?.[0], { argv: ["npm", "test"], timeoutSec: 600, repeat: 1, env: [] });
  assert.equal(contract.finalVerification?.[1].cwd, "sub");
  assert.equal(contract.finalVerification?.[1].repeat, 2);
  // Absent stays absent: phases predating the field still validate.
  const bare = writeFixture();
  assert.equal(validateContract(JSON.parse(readFileSync(bare.path, "utf8")), bare.path).finalVerification, undefined);

  for (const value of /** @type {unknown[]} */ ([
    { argv: ["npm", "test"] },
    [{ argv: [] }],
    [{ argv: ["npm", "test"], timeoutSec: 601 }],
    [{ argv: ["npm", "test"], timeoutSec: 0 }],
    [{ argv: ["npm", "test"], repeat: 0 }],
    [{ argv: ["npm", "test"], env: ["not a name"] }],
    [{ argv: ["npm", "test"], cwd: "/absolute" }],
    [{ argv: ["npm", "test"], retries: 2 }],
  ])) {
    const invalid = writeFixture({ finalVerification: value });
    assert.throws(
      () => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path),
      /contract\.finalVerification/u,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("a single-node contract validates without warning and targetedFix is not a node field", () => {
  const { path } = writeFixture({
    id: "single-node-contract",
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.warnings, [], "a single-node contract is simply valid");

  const invalid = writeFixture({
    id: "targeted-fix-field",
    nodes: [{ id: "build", type: "backend", targetedFix: true, taskPacket: packet(), gate: false }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(invalid.path, "utf8")), invalid.path),
    /nodes\[0\] has unexpected field targetedFix/u,
  );
});

test("a node snapshot accepts a bounded previousAttempt section and rejects an oversized one", () => {
  const accepted = validateNodeSnapshot(snapshot({
    previousAttempt: "## Previous attempt\n\nAttempt 1 failed; this is attempt 2.",
  }));
  assert.match(/** @type {string} */ (accepted.previousAttempt), /Attempt 1 failed/u);

  assert.throws(
    () => validateNodeSnapshot(snapshot({ previousAttempt: "x".repeat(9 * 1024) })),
    /previousAttempt exceeds 8192 bytes/u,
  );
  assert.throws(
    () => validateNodeSnapshot(snapshot({ previousAttempt: "   " })),
    /previousAttempt must be a non-empty string/u,
  );
});

test("run metadata records identity warnings and rejects a budget extension field", () => {
  const metadata = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sourceIdentity: { kind: "run", id: "run" },
  };
  const warned = validateRunMetadata({
    ...metadata,
    identityWarnings: ["source tree fingerprint changed since the run started"],
  });
  assert.deepEqual(warned.identityWarnings, ["source tree fingerprint changed since the run started"]);

  assert.throws(
    () => validateRunMetadata({ ...metadata, identityWarnings: [42] }),
    /identityWarnings\[0\] must be a string/u,
  );
  assert.throws(
    () => validateRunMetadata({ ...metadata, budgetExtension: { previous: 1000, maxInputTokens: 5000, at: new Date().toISOString() } }),
    /run metadata has unexpected field budgetExtension/u,
  );
});

test("the canonical contract example in the reference validates exactly as written", () => {
  // The example at the top of references/contract.md is what a contract author
  // copies first. It has drifted before: a stale contractVersion, and a judge
  // that shared its harness-default vendor with the worker, so every gate-enabled
  // node built from it was rejected. Guard the shape, not the prose.
  const reference = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "references", "contract.md"), "utf8");
  const block = /```json\n([\s\S]*?)\n```/u.exec(reference)?.[1];
  assert.ok(block, "the reference must carry the canonical JSON example");
  const value = JSON.parse(block);
  const directory = mkdtempSync(join(tmpdir(), "runner-doc-example-"));
  // Only the placeholder cwd changes: it names a sibling repository the example
  // cannot ship, and every path inside the contract resolves against it.
  value.cwd = ".";
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "feature-42.ts"), "");
  for (const node of value.nodes) {
    const target = join(directory, node.taskPacketFile ?? "packet.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(helpers.packet({ readFiles: ["src/feature-42.ts"], writeFiles: ["src/feature-42.ts"] })));
  }
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes[0].gate.enabled, true, "the example must keep proving the gated path");
  const worker = contract.runtimeDefaults?.worker;
  const judge = contract.runtimeDefaults?.judge;
  assert.ok(worker && judge, "the example must keep a worker and a judge default");
  assert.notEqual(
    contract.runtimes[worker].vendor,
    contract.runtimes[judge].vendor,
    "the example's worker and judge must not share a vendor",
  );
});
