import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_RUNNER_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  hashPacket,
  validateContract,
  validateNodeSnapshot,
} from "../scripts/contract.mjs";
import { judgePrompt } from "../scripts/lib.mjs";
import { runContract } from "../scripts/runner.mjs";
import * as helpers from "./helpers.mjs";

function packet() {
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
  };
}

function fixture(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: PLAN_RUNNER_VERSION,
    id: "contract-test",
    campaignId: "campaign-test",
    goal: "validate protocol",
    cwd: ".",
    runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { driver: "codex", model: "test-model" } },
    runtimeRules: [],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    ...overrides,
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
  const path = helpers.writeContract(directory, helpers.fixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: helpers.packet({ writeFiles: [".claude/settings.json", ".claude/hooks/pre.mjs", "src/app.ts"] }),
      gate: false,
    }],
  }));
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
  packetFileNodes[0] = { id: "build", type: "backend", taskPacketFile: "packet.json", gate: false };
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
  const path = helpers.writeContract(directory, helpers.fixture({ id: "stored-packet-run", pollIntervalMs: 10 }));
  const result = await helpers.withFakeCodex(directory, "pass", () => runContract(path));
  const stored = JSON.parse(readFileSync(join(result.runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].taskPacket.mode, "execution");
  assert.equal(stored.nodes[0].prompt, undefined);
  assert.equal(stored.nodes[0].taskPacketFile, undefined);
  const revalidated = validateContract(stored, join(result.runDir, "contract.json"));
  assert.match(revalidated.nodes[0].prompt, /Closed context/u);
});

    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), new RegExp(`runtimeRules\\[0\\]\\.match\\.${field}`));
  }
});
