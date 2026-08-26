import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPSULE_VERSION, buildCapsule, capsuleDigest, parseCapsule, redactCapsuleString } from "../scripts/capsule.mjs";

/** @returns {Partial<import("../scripts/capsule.mjs").Capsule>} */
function sampleInput() {
  return {
    runId: "run-1",
    nodeId: "build",
    attemptId: "build.1",
    objective: "Implement the parser",
    constraints: ["inspect only the closed task packet"],
    decisions: ["use recursive descent"],
    nonGoals: ["no error recovery"],
    changedFiles: ["src/parser.mjs"],
    worktreeIdentity: { gitHead: "abc123", dirty: true },
    receipts: [{ kind: "verification", ref: "node --test", settledAt: "2026-08-25T00:00:00Z" }],
    verifications: [{ argv: "node --test test/parser.test.mjs", pass: true }],
    artifacts: [{ handle: ".runs/run-1/artifacts/diff.txt", sha256: "deadbeef", bytes: 120, preview: "+ line" }],
    blockers: [],
    nextAction: "run the gate",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 },
    costUsd: 0.01,
    budgetRemaining: 4.99,
    continuationHint: "continue with the second rule",
  };
}

test("capsules round-trip through serialization and parsing", () => {
  const capsule = buildCapsule(sampleInput());
  assert.equal(capsule.capsuleVersion, CAPSULE_VERSION);
  const parsed = parseCapsule(JSON.stringify(capsule));
  assert.equal(parsed.objective, "Implement the parser");
  assert.deepEqual(parsed.constraints, ["inspect only the closed task packet"]);
  assert.deepEqual(parsed.usage, { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 });
  assert.equal(parsed.artifacts[0]?.preview, "+ line");
});

test("digests are stable across key order and exclude the digest field", () => {
  const capsule = buildCapsule(sampleInput());
  const reordered = parseCapsule(JSON.stringify(capsule));
  const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
  assert.equal(capsuleDigest(/** @type {import("../scripts/capsule.mjs").Capsule} */ (shuffled)), capsule.digest);
  assert.equal(typeof capsule.digest, "string");
  assert.match(capsule.digest, /^[0-9a-f]{64}$/u);
});

test("secret-shaped values are redacted deterministically", () => {
  assert.equal(redactCapsuleString("API_KEY=sk-abcdef123456"), "API_KEY=[redacted]");
  assert.equal(redactCapsuleString("Authorization: Bearer abc123def456"), "Authorization: Bearer [redacted]");
  const token = "a1".repeat(24);
  assert.equal(redactCapsuleString(`token ${token}`), "token [redacted]");
  // Ordinary technical strings survive untouched.
  assert.equal(redactCapsuleString("src/parser.mjs"), "src/parser.mjs");
  assert.equal(redactCapsuleString("/Users/dev/project/file-with-a-long-name.mjs"), "/Users/dev/project/file-with-a-long-name.mjs");
});

test("oversize capsules drop previews then truncate lists with explicit flags", () => {
  const input = sampleInput();
  input.artifacts = Array.from({ length: 32 }, (unused, index) => ({
    handle: `.runs/run-1/artifacts/item-${index}.txt`,
    sha256: `hash-${index}`,
    bytes: 1024,
    preview: "p".repeat(256),
  }));
  input.decisions = Array.from({ length: 64 }, (unused, index) => `decision ${index} with a reasonable amount of text`);
  const tight = buildCapsule(input, { maxBytes: 2048 });
  const serialized = JSON.stringify(tight);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 2048, "capsule must respect the bound");
  const firstArtifact = /** @type {{previewTruncated?: boolean}|undefined} */ (tight.artifacts[0]);
  if (tight.artifacts.length > 0) assert.equal(firstArtifact?.previewTruncated, true);
  else assert.equal(tight.artifactsTruncated, true);
  if (tight.decisions.length < 64) assert.equal(tight.decisionsTruncated, true);

  const parsed = parseCapsule(serialized);
  assert.equal(parsed.capsuleVersion, CAPSULE_VERSION);
});

test("scalar optional content is shortened to fit a small valid bound", () => {
  const input = sampleInput();
  input.continuationHint = "continue ".repeat(300);

  const capsule = buildCapsule(input, { maxBytes: 1024 });
  const serialized = JSON.stringify(capsule);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 1024, "capsule must respect the bound");
  assert.match(capsule.continuationHint ?? "", /…\[truncated\]/u);
  assert.equal(parseCapsule(serialized).digest, capsule.digest);
});

test("list truncation does not replace a smaller list with a larger flagged list", () => {
  const input = sampleInput();
  input.constraints = [""];
  input.continuationHint = "continue ".repeat(300);

  const capsule = buildCapsule(input, { maxBytes: 1024 });
  assert.deepEqual(capsule.constraints, [""]);
  assert.equal(capsule.constraintsTruncated, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(capsule), "utf8") <= 1024);
});

test("a single reducible string-list item is marker-shortened to fit an otherwise-impossible bound", () => {
  const input = sampleInput();
  const identity = "a1".repeat(500);
  input.runId = identity;
  input.nodeId = identity;
  input.attemptId = identity;
  input.objective = "x";
  input.constraints = ["x".repeat(20)];
  input.decisions = [];
  input.nonGoals = [];
  input.changedFiles = [];
  input.blockers = [];
  input.receipts = [];
  input.verifications = [];
  input.artifacts = [];
  input.worktreeIdentity = { gitHead: null, dirty: false };
  input.nextAction = null;
  input.usage = { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
  input.costUsd = null;
  input.budgetRemaining = null;
  input.continuationHint = null;

  const full = buildCapsule(input);
  const savings = Buffer.byteLength(JSON.stringify(full.constraints[0]), "utf8")
    - Buffer.byteLength(JSON.stringify("…[truncated]"), "utf8");
  const maxBytes = Buffer.byteLength(JSON.stringify(full), "utf8") - savings;
  // The flagged empty list is larger than the original, so only the
  // item-level marker replacement can fit this bound.
  const emptied = { ...full, constraints: [], constraintsTruncated: true };
  assert.ok(Buffer.byteLength(JSON.stringify(emptied), "utf8") > maxBytes);

  const capsule = buildCapsule(input, { maxBytes });
  const serialized = JSON.stringify(capsule);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= maxBytes, "capsule must respect the bound");
  assert.deepEqual(capsule.constraints, ["…[truncated]"]);
  assert.equal(capsule.runId, identity);
  assert.equal(capsule.nodeId, identity);
  assert.equal(capsule.attemptId, identity);

  const parsed = parseCapsule(serialized);
  assert.equal(parsed.digest, capsule.digest);
  assert.deepEqual(parsed.constraints, ["…[truncated]"]);
});

test("input list caps are explicit and stable", () => {
  const input = sampleInput();
  input.receipts = Array.from({ length: 65 }, (unused, index) => ({ kind: "check", ref: `receipt-${index}` }));
  input.verifications = Array.from({ length: 65 }, (unused, index) => ({ argv: `check-${index}`, pass: true }));
  input.artifacts = Array.from({ length: 33 }, (unused, index) => ({
    handle: `artifact-${index}`,
    sha256: `hash-${index}`,
    bytes: index,
    preview: null,
  }));

  const capsule = buildCapsule(input);
  assert.equal(capsule.receipts.length, 64);
  assert.equal(capsule.verifications.length, 64);
  assert.equal(capsule.artifacts.length, 32);
  assert.equal(capsule.receiptsTruncated, true);
  assert.equal(capsule.verificationsTruncated, true);
  assert.equal(capsule.artifactsTruncated, true);
  assert.equal(parseCapsule(JSON.stringify(capsule)).digest, capsule.digest);
});

test("identity hashes remain usable while secret-shaped text is redacted", () => {
  const input = sampleInput();
  const gitHead = "a1".repeat(20);
  const sha256 = "b2".repeat(32);
  input.worktreeIdentity = { gitHead, dirty: false };
  input.artifacts = [{ handle: "artifact", sha256, bytes: 1, preview: "API_KEY=sk-abcdef123456" }];

  const capsule = buildCapsule(input);
  assert.equal(capsule.worktreeIdentity.gitHead, gitHead);
  assert.equal(capsule.artifacts[0]?.sha256, sha256);
  assert.equal(capsule.artifacts[0]?.preview, "API_KEY=[redacted]");
});

test("high-entropy run identities round-trip without redaction", () => {
  const input = sampleInput();
  const runId = `run-${"a1".repeat(400)}`;
  input.runId = runId;

  const capsule = buildCapsule(input);
  assert.equal(capsule.runId, runId);
  assert.equal(parseCapsule(JSON.stringify(capsule)).runId, runId);
});

test("redaction happens before free-text bounding", () => {
  const input = sampleInput();
  const token = "a1".repeat(24);
  const markerBytes = Buffer.byteLength("…[truncated]", "utf8");
  input.objective = `${" ".repeat(4096 - markerBytes - 31)}${token}`;

  const capsule = buildCapsule(input);
  assert.doesNotMatch(capsule.objective, /a1a1a1/u);
  assert.match(capsule.objective, /\[redacted\]/u);
});

test("nullable scalar reductions compose with identity removal and objective shortening", () => {
  const input = sampleInput();
  input.objective = "objective ".repeat(500);
  input.worktreeIdentity = { gitHead: "f".repeat(128), dirty: false };
  input.usage = { inputTokens: 100000, outputTokens: 200000, cacheReadInputTokens: 300000 };
  input.costUsd = 123456789;
  input.budgetRemaining = 987654321;

  const capsule = buildCapsule(input, { maxBytes: 1024 });
  assert.equal(capsule.worktreeIdentity.gitHead, null);
  assert.match(capsule.objective, /…\[truncated\]/u);
  assert.deepEqual(capsule.usage, { inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
  assert.equal(capsule.costUsd, null);
  assert.equal(capsule.budgetRemaining, null);
  assert.ok(Buffer.byteLength(JSON.stringify(capsule), "utf8") <= 1024);
});

test("parseCapsule rejects malformed and unknown-field capsules", () => {
  assert.throws(() => parseCapsule("not json"), SyntaxError);
  assert.throws(() => parseCapsule(JSON.stringify({ capsuleVersion: 99 })), /unsupported capsuleVersion/u);
  const withoutDigest = buildCapsule(sampleInput());
  const { digest, ...rest } = /** @type {Record<string, unknown>} */ ({ ...withoutDigest });
  void digest;
  rest.surprise = true;
  assert.throws(() => parseCapsule(JSON.stringify(rest)), /unknown capsule field surprise/u);
  delete rest.surprise;
  delete rest.runId;
  assert.throws(() => parseCapsule(JSON.stringify(rest)), /capsule\.runId/u);

  const missingConstraints = { ...withoutDigest };
  delete missingConstraints.constraints;
  assert.throws(() => parseCapsule(JSON.stringify(missingConstraints)), /capsule\.constraints/u);

  const wrongDigest = { ...withoutDigest, objective: "changed" };
  assert.throws(() => parseCapsule(JSON.stringify(wrongDigest)), /digest does not match/u);
});
