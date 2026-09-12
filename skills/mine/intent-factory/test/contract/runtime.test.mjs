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

// Runtime declaration in a contract: fields, harness names, the one-hop
// fallback edge, and the cross-vendor rule a gate depends on.

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
  const reference = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "references", "contract.md"), "utf8");
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
