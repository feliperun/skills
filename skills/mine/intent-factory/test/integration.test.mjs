import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceIdentity } from "../scripts/contract.mjs";
import { sealAttempt } from "../scripts/worktree.mjs";

test("run creation source identity includes resolved cwd and task-packet hashes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-source-"));
  const contract = {
    id: "source-run",
    campaignId: "source-campaign",
    cwd,
    nodes: [
      { id: "first", packetHash: "a".repeat(64) },
      { id: "second", packetHash: "b".repeat(64) },
    ],
  };
  const identity = captureSourceIdentity(contract, { luna: "test-driver 1" });
  assert.equal(identity.cwd, cwd);
  assert.deepEqual(identity.packetHashes, { first: "a".repeat(64), second: "b".repeat(64) });
  assert.ok(identity.driverVersions, "driver versions recorded");
  assert.equal(identity.driverVersions.luna, "test-driver 1");
});

test("re-sealing an attempt whose only entry is the node_modules link is a no-op", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-seal-"));
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.runs/\n");
  writeFileSync(join(repo, "source.txt"), "work\n");
  git("add", "-A");
  git("-c", "commit.gpgSign=false", "commit", "-qm", "sealed attempt");
  const sealed = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // The link `.gitignore`'s `node_modules/` cannot match, plus the ignored
  // result sidecar every real worker leaves behind.
  mkdirSync(join(repo, "installed"));
  symlinkSync(join(repo, "installed"), join(repo, "node_modules"));
  mkdirSync(join(repo, ".runs"), { recursive: true });
  writeFileSync(join(repo, ".runs", "result.json"), "{}\n");

  const result = sealAttempt({ repo, path: repo, baseSha: sealed, runId: "run", nodeId: "node", attempt: 2 });
  assert.equal(result.sha, sealed, "a clean attempt keeps its existing seal instead of failing to commit nothing");
  assert.equal(result.empty, true, "no diff against the base it was sealed at");
});
