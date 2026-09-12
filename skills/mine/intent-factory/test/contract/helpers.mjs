/**
 * Fixtures shared by the contract tests. They were one copy per file until
 * `contract.test.mjs` was split three ways for the 800-line ceiling and the
 * copies came with it.
 *
 * These are deliberately not `test/helpers.mjs`: that one builds contracts for
 * running, and these build the malformed and edge-case shapes validation is
 * supposed to refuse.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";

/** @param {Record<string, unknown>} [overrides] */
export function fixture(overrides = {}) {
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

export function packet(overrides = {}) {
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

export function writeFixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "runner-contract-"));
  writeFileSync(join(directory, "README.md"), "read me\n");
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(fixture(overrides), null, 2)}\n`);
  return { directory, path };
}

/** @param {string} directory */
export function initializeGit(directory) {
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { stdio: "ignore" });
    return;
  } catch {}
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "-c", "commit.gpgSign=false", "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "fixture"]);
}

export function snapshot(overrides = {}) {
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
