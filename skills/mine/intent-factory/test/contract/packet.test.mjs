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
  hashPacket,
  validateContract,
} from "../../src/contract/index.mjs";
import { SIGNAL_END, SIGNAL_START } from "../../src/repo/signal-block.mjs";
import { judgePrompt } from "../../src/engine/prompts.mjs";
import { JUDGE_LIMITS } from "../../src/contract/judge-envelope.mjs";
import { runContract } from "../../src/cli.mjs";
import { harnessCapabilities } from "../../src/harnesses/index.mjs";
import * as helpers from "../helpers.mjs";
import { routeRuntime } from "../../src/contract/runtime.mjs";
import { validateEvent, validateNodeSnapshot, validateRunMetadata } from "../../src/contract/snapshot.mjs";
import { captureSourceIdentity } from "../../src/contract/source-identity.mjs";

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

// The other half of contract.test.mjs: task packets, the prompts rendered from
// them, and the write boundaries they declare.

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

// Task packets and the prompts rendered from them.
// Runtime declaration, fallback edges and vendor rules are in runtime.test.mjs.

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
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const prompt = judgePrompt(node, "worker complete");
  assert.match(prompt, /Write files:\n- README\.md/u);
  assert.match(prompt, /\[works\] It works/u);
  assert.doesNotMatch(prompt, /Read files/u);
  assert.doesNotMatch(prompt, /contract\.json/u);
});

test("judge prompt advertises the envelope the parser enforces", () => {
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
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
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
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
