import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceIdentity } from "../scripts/contract.mjs";

test("run creation source identity includes resolved cwd and task-packet hashes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-source-"));
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
