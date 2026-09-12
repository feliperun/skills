/**
 * The identity a run is pinned to: the git head it started from, a fingerprint
 * of the dirty tree, the hash of every task packet, the agent-guidance files in
 * force, and the harness versions observed.
 *
 * This is what makes a resume honest. A run that resumes against a different
 * head, a changed packet or an edited `AGENTS.md` is not the run that was
 * approved, and `validateCompleteSourceIdentity` is where that is refused.
 */
import { Buffer } from "node:buffer";
import { assertObject, rejectUnknown, requireId, requirePacketHash, requireString } from "../contract/assert.mjs";
import { createHash } from "node:crypto";
import { errorCode } from "../util.mjs";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeManagedSignalBlock } from "./signal-block.mjs";

/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").SourceIdentity} SourceIdentity */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {JsonObject|null} expected
 */
export function validateSourceIdentity(value, label, expected = null) {
  assertObject(value, label);
  const allowed = new Set([
    "kind", "id", "campaignId", "contractId", "nodeId", "cwd", "gitHead",
    "dirtyTreeFingerprint", "packetHashes", "harnessVersions",
  ]);
  rejectUnknown(value, allowed, label);
  requireString(value.kind, `${label}.kind`);
  for (const key of ["id", "campaignId", "contractId", "nodeId"]) {
    if (value[key] !== undefined) requireId(value[key], `${label}.${key}`);
  }
  if (value.cwd !== undefined) requireString(value.cwd, `${label}.cwd`);
  for (const key of ["gitHead", "dirtyTreeFingerprint"]) {
    if (value[key] !== undefined && value[key] !== null) requireString(value[key], `${label}.${key}`);
  }
  if (value.packetHashes !== undefined) validateHashMap(value.packetHashes, `${label}.packetHashes`);
  if (value.harnessVersions !== undefined) {
    assertObject(value.harnessVersions, `${label}.harnessVersions`);
    for (const [key, version] of Object.entries(value.harnessVersions)) {
      requireId(key, `${label}.harnessVersions key`);
      if (version !== null) requireString(version, `${label}.harnessVersions.${key}`);
    }
  }
  if (expected) {
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) throw new TypeError(`${label}.${key} does not match its source`);
    }
  }
  return /** @type {SourceIdentity} */ ({ ...value });
}
/**
 * @param {{id: string, campaignId: string, cwd: string, nodes: {id: string, packetHash: string}[]}} contract
 * @param {Record<string, string|null>} harnessVersions
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 */
export function captureSourceIdentity(contract, harnessVersions = {}, options = {}) {
  const git = gitIdentity(contract.cwd, options);
  return validateSourceIdentity({
    kind: "run",
    contractId: contract.id,
    campaignId: contract.campaignId,
    cwd: contract.cwd,
    gitHead: git.gitHead,
    dirtyTreeFingerprint: git.dirtyTreeFingerprint,
    packetHashes: Object.fromEntries(contract.nodes.map((node) => [node.id, node.packetHash])),
    harnessVersions,
  }, "run source identity", { kind: "run", contractId: contract.id, campaignId: contract.campaignId });
}
/**
 * @param {JsonObject} value
 */
export function validateCompleteSourceIdentity(value) {
  for (const key of ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "harnessVersions"]) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`run metadata.sourceIdentity.${key} is required for resume`);
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateHashMap(value, label) {
  assertObject(value, label);
  for (const [key, hash] of Object.entries(value)) {
    requireId(key, `${label} key`);
    requirePacketHash(hash, `${label}.${key}`);
  }
}
/**
 * @param {string} cwd
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 * @returns {{gitHead: string|null, dirtyTreeFingerprint: string|null}}
 */
function gitIdentity(cwd, options = {}) {
  try {
    const pathspec = [
      ".",
      ":(exclude).runs",
      ":(exclude)AGENTS.md",
      ...(options.ignorePaths ?? []).map((path) => `:(exclude)${path}`),
      ...(options.ignoreRoots ?? []).map((path) => `:(exclude)${path}`),
    ];
    let gitHead = null;
    const headPath = resolve(cwd, ".git", "HEAD");
    let headText = null;
    try { headText = readFileSync(headPath, "utf8").trim(); } catch {
      // A missing or unreadable .git/HEAD leaves headText null; rev-parse below still decides gitHead.
    }
    let unbornHead = false;
    if (headText?.startsWith("ref: ") === true) {
      try { lstatSync(resolve(cwd, ".git", headText.slice(5))); }
      catch (error) { if (errorCode(error) === "ENOENT") unbornHead = true; else throw error; }
    }
    if (!unbornHead) {
      try {
        gitHead = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
      } catch {
        // Any rev-parse failure (no repo, unborn HEAD, git absent) leaves gitHead null.
      }
    }
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...pathspec], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const statusText = status.toString("utf8");
    const diff = !gitHead || status.length === 0
      ? Buffer.alloc(0)
      : execFileSync("git", ["-C", cwd, "diff", "--binary", "HEAD", "--", ...pathspec], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const untrackedFiles = statusText.split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3));
    const contents = createHash("sha256");
    for (const relativePath of untrackedFiles) {
      const absolutePath = resolve(cwd, relativePath);
      const metadata = lstatSync(absolutePath);
      contents.update(`${relativePath}\0${metadata.mode}\0`);
      if (metadata.isSymbolicLink()) contents.update(readlinkSync(absolutePath));
      else if (metadata.isFile()) contents.update(readFileSync(absolutePath));
      contents.update("\0");
    }
    return {
      gitHead,
      dirtyTreeFingerprint: createHash("sha256")
        .update(status)
        .update(diff)
        .update(contents.digest())
        .update(agentGuidanceIdentity(cwd))
        .digest("hex"),
    };
  } catch {
    return { gitHead: null, dirtyTreeFingerprint: null };
  }
}
/**
 * Hash AGENTS.md separately so its machine-managed signal may change without
 * hiding edits to human-authored repository guidance.
 *
 * @param {string} cwd
 * @returns {Buffer}
 */
function agentGuidanceIdentity(cwd) {
  const path = resolve(cwd, "AGENTS.md");
  const identity = createHash("sha256").update("AGENTS.md\0");
  try {
    const metadata = lstatSync(path);
    identity.update(`${metadata.mode}\0`);
    if (metadata.isSymbolicLink()) identity.update(`symlink\0${readlinkSync(path)}`);
    else if (metadata.isFile()) identity.update(`file\0${normalizeManagedSignalBlock(readFileSync(path, "utf8"))}`);
    else identity.update("unsupported");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    identity.update("missing");
  }
  return identity.digest();
}
