import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJsonl,
  acquireControllerLease,
  acquireSupervisorLease,
  captureLeaseSlot,
  LeaseBusyError,
  LeaseLostError,
  readJson,
  readLease,
  readSupervisorLease,
  writeJsonAtomic,
} from "../scripts/store.mjs";
import { captureEntry, claimGenerationFence, generationFencePath, holderLiveness, leaseAdoption, restoreEntry } from "../scripts/lease-liveness.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract, validateNodeSnapshot } from "../scripts/contract.mjs";
import { detectStalls, invocationAlive, monitorInvocation, processStartToken, startProcess, terminateInvocation } from "../scripts/supervisor.mjs";
import { fixture, writeContract } from "./helpers.mjs";

// A pid the kernel will not hand out while the test runs: its holder is dead.
const DEAD_PID = 2_147_483_647;

/**
 * Everything a losing contender must leave untouched: the run metadata and the
 * node snapshots, but not the lease and lock files the race is fought over.
 * @param {string} runDir
 * @returns {[string, string][]}
 */
function runStateFingerprint(runDir) {
  return ["run.json", join("nodes", "build.json")].map((name) => [name, readFileSync(join(runDir, name), "utf8")]);
}

/**
 * A run left behind by a controller that died holding its lease.
 * @param {string} runDir
 * @returns {string}
 */
function expiredRun(runDir) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeJsonAtomic(join(runDir, "run.json"), { leaseGeneration: 7 });
  writeJsonAtomic(join(runDir, "nodes", "build.json"), { id: "build", status: "running" });
  writeJsonAtomic(join(runDir, "controller-lease.json"), {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "dead-controller",
    generation: 7,
    pid: DEAD_PID,
    processStartToken: null,
    acquiredAt: new Date(0).toISOString(),
    renewedAt: new Date(0).toISOString(),
    expiresAt: new Date(1).toISOString(),
  });
  return runDir;
}

/**
 * @param {string} holderId
 * @param {number} generation
 * @returns {import("../scripts/store.mjs").LeaseRecord}
 */
function leaseRecord(holderId, generation) {
  return {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId,
    generation,
    pid: DEAD_PID,
    processStartToken: null,
    acquiredAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const CONTENDER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const gate = new Int32Array(workerData.gate);
import(workerData.storeUrl).then((store) => {
  parentPort.postMessage({ ready: true });
  Atomics.wait(gate, 0, 0, 10_000);
  try {
    const lease = store.acquireControllerLease(workerData.runDir, { contractVersion: "0.1.0", ttlMs: 60_000 });
    parentPort.postMessage({ won: true, holderId: lease.holderId });
  } catch (error) {
    parentPort.postMessage({ won: false, name: error.name, message: error.message });
  }
}).catch((error) => parentPort.postMessage({ won: false, name: "ImportError", message: String(error && error.message) }));
`;

/**
 * Start `count` real contenders that all reach acquireControllerLease before any
 * of them is allowed to run: worker threads, not long-running children.
 * @param {string} runDir
 * @param {number} count
 * @returns {Promise<{won: boolean, holderId?: string, name?: string, message?: string}[]>}
 */
async function raceForLease(runDir, count) {
  const gate = new SharedArrayBuffer(4);
  const open = new Int32Array(gate);
  const storeUrl = new URL("../scripts/store.mjs", import.meta.url).href;
  const workers = Array.from({ length: count }, () => new Worker(CONTENDER_SOURCE, {
    eval: true,
    workerData: { runDir, storeUrl, gate },
  }));
  /** @type {{won: boolean, holderId?: string, name?: string, message?: string}[]} */
  const outcomes = [];
  let ready = 0;
  try {
    await new Promise((settle, fail) => {
      for (const worker of workers) {
        worker.on("error", fail);
        worker.on("message", (message) => {
          if (message.ready) {
            ready += 1;
            if (ready === count) {
              Atomics.store(open, 0, 1);
              Atomics.notify(open, 0);
            }
            return;
          }
          outcomes.push(message);
          if (outcomes.length === count) settle(undefined);
        });
      }
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return outcomes;
}

/**
 * @param {string} runDir
 * @returns {{contract: import("../scripts/contract.mjs").ValidatedContract, node: import("../scripts/contract.mjs").ValidatedNode}}
 */
function validatedRun(runDir) {
  const contractPath = writeContract(runDir, fixture({ pollIntervalMs: 10 }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  if (!node) throw new Error("fixture has no build node");
  return { contract, node };
}

/**
 * @param {import("../scripts/contract.mjs").ValidatedNode} node
 * @param {unknown[]} executionOverrides
 * @returns {import("../scripts/contract.mjs").NodeSnapshot}
 */
function nodeSnapshot(node, executionOverrides) {
  const now = new Date().toISOString();
  return validateNodeSnapshot({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    id: node.id,
    type: node.type,
    sourceIdentity: node.sourceIdentity,
    packetHash: node.packetHash,
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: now,
    updatedAt: now,
    result: null,
    gate: null,
    error: null,
    invocations: [],
    executionOverrides,
    verification: null,
    scope: {
      boundary: {
        schemaVersion: 1,
        files: [...(node.taskPacket.writeFiles ?? [])],
        roots: [...(node.taskPacket.writeRoots ?? [])],
        fileOrigins: [...(node.taskPacket.writeFiles ?? [])].map((literal) => ({ literal, paths: [literal] })),
        rootOrigins: [...(node.taskPacket.writeRoots ?? [])].map((literal) => ({ literal, paths: [literal] })),
      },
      changedPaths: [],
      unexpectedPaths: [],
      changedPathCount: 0,
      unexpectedPathCount: 0,
      truncated: false,
    },
  }, node);
}

test("simultaneous controllers have one exclusive lease and stale takeover increments generation", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-lease-"));
  const first = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_000, pid: DEAD_PID });
  assert.throws(
    () => acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_010 }),
    (error) => error instanceof LeaseBusyError,
  );
  const second = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_100 });
  assert.equal(second.generation, first.generation + 1);
  assert.notEqual(second.holderId, first.holderId);
  second.release();
});

test("a delayed heartbeat renews its own expired lease instead of declaring it lost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-heartbeat-delay-"));
  const lease = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100 });
  let lost = false;
  lease.startHeartbeat(() => { lost = true; });
  try {
    // Simulate a heartbeat delayed past the TTL: the lease on disk is ours but expired.
    writeJsonAtomic(join(runDir, "controller-lease.json"), {
      ...lease.current,
      renewedAt: new Date(Date.now() - 10_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(lost, false);
    const actual = /** @type {{expiresAt: string, holderId: string}} */ (readJson(join(runDir, "controller-lease.json")));
    assert.ok(Date.parse(actual.expiresAt) > Date.now());
    assert.equal(actual.holderId, lease.current.holderId);
    lease.assert();
  } finally {
    lease.release();
  }
});

test("an expired lease whose controller pid is alive is never adopted", () => {
  // Run intent-factory-efficiency-p05-governance-resume-20260903 forked into
  // four controllers because a late heartbeat looked like an abandoned run.
  // Expiry alone no longer authorizes a takeover.
  const runDir = mkdtempSync(join(tmpdir(), "runner-heartbeat-"));
  const first = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100, now: 1_000 });
  const expired = {
    ...first.current,
    renewedAt: new Date(500).toISOString(),
    expiresAt: new Date(900).toISOString(),
  };
  writeJsonAtomic(join(runDir, "controller-lease.json"), expired);
  assert.equal(invocationAlive({ pid: process.pid, processStartToken: processStartToken(process.pid) }), true);
  assert.throws(
    () => acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100, now: 1_000 }),
    (error) => error instanceof LeaseBusyError && /is alive/u.test(error.message),
  );
  // The refused contender left the live holder's lease exactly as it found it.
  assert.deepEqual(readJson(join(runDir, "controller-lease.json")), expired);
  first.release();
});

test("lease adoption reads the holder's process start token, not just its expiry", () => {
  const expired = {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "holder",
    generation: 1,
    pid: 4_242,
    processStartToken: "111",
    acquiredAt: new Date(0).toISOString(),
    renewedAt: new Date(0).toISOString(),
    expiresAt: new Date(900).toISOString(),
  };
  const alive = { kill: () => true, startToken: () => "111" };
  const recycled = { kill: () => true, startToken: () => "999" };
  const gone = { kill: () => false, startToken: () => null };
  assert.deepEqual(holderLiveness(expired, alive), { alive: true, reason: "token_alive" });
  assert.deepEqual(holderLiveness(expired, recycled), { alive: false, reason: "pid_recycled" });
  assert.deepEqual(holderLiveness(expired, gone), { alive: false, reason: "pid_gone" });
  // A token the platform cannot resolve leaves the pid probe in charge, so an
  // unknown holder is treated as alive rather than assumed dead.
  assert.deepEqual(holderLiveness({ ...expired, processStartToken: null }, alive), { alive: true, reason: "pid_alive" });
  assert.equal(leaseAdoption(expired, { now: 1_000, probes: alive }).reason, "holder_alive");
  assert.equal(leaseAdoption(expired, { now: 1_000, probes: recycled }).adopt, true);
  assert.equal(leaseAdoption(expired, { now: 1_000, probes: gone }).adopt, true);
  // Before expiry the holder's state is irrelevant: the lease is simply held.
  assert.deepEqual(leaseAdoption(expired, { now: 500, probes: gone }), { adopt: false, reason: "healthy" });
  assert.deepEqual(leaseAdoption(null), { adopt: true, reason: "absent" });
});

test("exactly one of four concurrent contenders wins an expired lease", async () => {
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-race-")));
  const before = runStateFingerprint(runDir);
  // Real concurrency: four worker threads leave the starting gate together and
  // contend for one expired lease, the way four resumed controllers did in run
  // intent-factory-efficiency-p05-governance-resume-20260903.
  const outcomes = await raceForLease(runDir, 4);
  const winners = outcomes.filter((outcome) => outcome.won);
  assert.equal(winners.length, 1, `an expired lease must have exactly one winner: ${JSON.stringify(outcomes)}`);
  for (const loser of outcomes.filter((outcome) => !outcome.won)) {
    assert.equal(loser.name, "LeaseBusyError", `a loser must fail as lease_busy, got ${loser.name}: ${loser.message}`);
  }
  const held = readLease(runDir);
  assert.ok(held && !("invalid" in held));
  assert.equal(held.holderId, winners[0]?.holderId, "the lease on disk must belong to the single winner");
  assert.deepEqual(runStateFingerprint(runDir), before, "a losing contender must not touch run state");
});

test("a contender descheduled past the lock TTL never deletes the winner's lease", async () => {
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-steal-")));
  const before = runStateFingerprint(runDir);
  const lockPath = join(runDir, "controller-lease.json.lock");
  /** @type {Record<string, unknown>} */
  const winner = {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "winner",
    generation: 9,
    pid: DEAD_PID,
    processStartToken: null,
    acquiredAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let interleaved = false;
  const probes = {
    /** @param {number} pid */
    kill: (pid) => {
      if (!interleaved) {
        interleaved = true;
        // The slow contender is descheduled here, exactly between reading the
        // expired lease and replacing it. Its lock TTL lapses, a second
        // contender reclaims the lock, completes the takeover and releases.
        writeFileSync(lockPath, `${JSON.stringify({
          pid: process.pid,
          holderId: "lock-thief",
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        })}\n`);
        writeJsonAtomic(join(runDir, "controller-lease.json"), winner);
        unlinkSync(lockPath);
      }
      return pid !== DEAD_PID;
    },
  };
  assert.throws(
    () => acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 60_000, livenessProbes: probes }),
    (error) => error instanceof LeaseBusyError,
    "the descheduled contender must lose to the controller that took the lock",
  );
  assert.ok(interleaved, "the interleaving probe must have run inside the takeover");
  assert.deepEqual(readJson(join(runDir, "controller-lease.json")), winner, "the winner's lease must survive untouched");
  assert.deepEqual(runStateFingerprint(runDir), before, "the losing contender must not touch run state");
});

test("a contender descheduled between its last check and its write installs no second lease", () => {
  // The window the earlier fix left open: a contender that has already read the
  // lease, proved its holder dead and passed every check, and is only then
  // descheduled. It wakes holding nothing but a decision. These two calls are
  // the two halves of that decision in acquireLease — the ruling on what the
  // takeover captured, and the write it authorizes — with the winner installed
  // between them, after the generation was read and before anything is written.
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-fence-")));
  const before = runStateFingerprint(runDir);
  const path = join(runDir, "controller-lease.json");
  const slot = captureLeaseSlot(path, 8, runDir);
  assert.equal(slot.authorized, true, "generation 8 may replace the expired generation 7");
  assert.equal(/** @type {{generation: number}} */ (slot.occupant).generation, 7);

  // --- the contender is off the CPU from here ---
  const winner = leaseRecord("winner", 9);
  writeJsonAtomic(path, winner);
  // --- and resumes here, its ruling now stale ---

  assert.equal(slot.install(leaseRecord("slow", 8)), false, "the write must fail rather than replace the winner");
  assert.deepEqual(readJson(path), winner, "the newer lease must survive the stale writer untouched");
  assert.deepEqual(runStateFingerprint(runDir), before, "the losing contender must not touch run state");
});

test("capturing a lease is non-destructive, so a newer holder is handed back", () => {
  // The other side of the same window: the winner arrives before the ruling.
  // The capture takes the file out of the way in one step and only then looks
  // at it, so there is no moment at which a decision about generation 7 is
  // applied to the generation 9 that replaced it.
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-capture-")));
  const before = runStateFingerprint(runDir);
  const path = join(runDir, "controller-lease.json");
  const winner = leaseRecord("winner", 9);
  writeJsonAtomic(path, winner);
  const slot = captureLeaseSlot(path, 8, runDir);
  assert.equal(slot.authorized, false, "a lease at or beyond the intended generation fences the contender out");
  assert.deepEqual(readJson(path), winner, "the capture must put back what it was not allowed to take");
  assert.equal(slot.install(leaseRecord("slow", 8)), false);
  assert.deepEqual(readJson(path), winner);
  assert.deepEqual(runStateFingerprint(runDir), before, "the losing contender must not touch run state");
});

test("a lease capture holds the very file it removed, not a copy of it", () => {
  // What makes the capture safe is that removing the name and obtaining the
  // contents are the same step. A capture that read the bytes and then unlinked
  // would hand back a record that need not describe the file it deleted.
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-atomic-")));
  const path = join(runDir, "controller-lease.json");
  const inode = statSync(path).ino;
  const aside = captureEntry(path);
  assert.ok(aside, "capturing an occupied name yields a private handle");
  assert.equal(existsSync(path), false, "the name is free the moment the capture returns");
  assert.equal(statSync(aside).ino, inode, "the capture is the same file, so it cannot describe some other one");
  assert.equal(restoreEntry(aside, path), true);
  assert.equal(statSync(path).ino, inode, "a restored capture is the original file, back under its name");
  assert.equal(existsSync(aside), false, "the private handle does not outlive the restore");
  assert.equal(captureEntry(join(runDir, "no-such-lease.json")), null);
});

test("restoring a lease capture yields to whoever took the name meanwhile", () => {
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-restore-")));
  const path = join(runDir, "controller-lease.json");
  const aside = /** @type {string} */ (captureEntry(path));
  const winner = leaseRecord("winner", 9);
  writeJsonAtomic(path, winner);
  assert.equal(restoreEntry(aside, path), false, "a restore never forces a capture back over a newer occupant");
  assert.deepEqual(readJson(path), winner);
  assert.equal(existsSync(aside), false);
});

test("a live generation claim on a lease keeps every rival out of the takeover", () => {
  // The claim is what keeps rivals from racing at all, so the window above is
  // reached by one contender at a time in the first place.
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-claimed-")));
  const before = runStateFingerprint(runDir);
  const path = join(runDir, "controller-lease.json");
  const held = readJson(path);
  const slow = claimGenerationFence(path, { holderId: "slow", pid: process.pid, processStartToken: null }, 8);
  assert.equal(slow.claimed, true);
  assert.equal(slow.owned(), true);
  assert.equal(
    claimGenerationFence(path, { holderId: "rival", pid: process.pid, processStartToken: null }, 8).claimed,
    false,
    "one generation admits one writer",
  );
  assert.throws(
    () => acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 60_000 }),
    (error) => error instanceof LeaseBusyError && /fenced/u.test(error.message),
    "a rival must lose the takeover rather than race the claim holder",
  );
  assert.deepEqual(readJson(path), held, "the expired lease stays exactly as the rival found it");
  assert.deepEqual(runStateFingerprint(runDir), before, "the losing contender must not touch run state");
  slow.release();
  const adopted = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 60_000 });
  assert.equal(adopted.generation, 8, "a released claim frees the generation for the next controller");
  adopted.release();
});

test("a lease claim abandoned by a dead contender is reclaimed instead of wedging the run", () => {
  // A contender that dies holding a claim must not fence the run forever, and
  // the proof that frees the claim is the same one adoption demands.
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-orphan-")));
  const path = join(runDir, "controller-lease.json");
  writeJsonAtomic(generationFencePath(path, 8), { holderId: "crashed", pid: DEAD_PID, processStartToken: null, generation: 8 });
  const lease = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 60_000 });
  assert.equal(lease.generation, 8);
  const held = readLease(runDir);
  assert.ok(held && !("invalid" in held));
  assert.equal(held.holderId, lease.holderId);
  lease.release();
  assert.equal(existsSync(generationFencePath(path, 8)), false, "a settled takeover leaves no claim behind");
});

test("reclaiming a dead lease claim never removes the live claim that replaced it", () => {
  // A reclaimer proves a claim dead and is then descheduled. While it sleeps,
  // a controller legitimately takes the same generation. The reclaimer must not
  // wake up and delete that live claim, so the proof is made about a claim it
  // has already captured rather than about whatever currently holds the name.
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-reclaim-")));
  const path = join(runDir, "controller-lease.json");
  const fencePath = generationFencePath(path, 8);
  writeJsonAtomic(fencePath, { holderId: "crashed", pid: DEAD_PID, processStartToken: null, generation: 8 });
  const replacement = { holderId: "live", pid: process.pid, processStartToken: null, generation: 8 };
  let interleaved = false;
  const probes = {
    /** @param {number} pid */
    kill: (pid) => {
      if (!interleaved) {
        interleaved = true;
        writeJsonAtomic(fencePath, replacement);
      }
      return pid !== DEAD_PID;
    },
  };
  const claim = claimGenerationFence(path, { holderId: "slow", pid: process.pid, processStartToken: null }, 8, { probes });
  assert.ok(interleaved, "the interleaving probe must have run inside the reclaim");
  assert.equal(claim.claimed, false, "the reclaimer must lose to the claim installed while it slept");
  assert.equal(claim.owned(), false);
  assert.deepEqual(readJson(fencePath), replacement, "the live claim must survive the reclaimer");
});

test("a lease claim held by a live contender is handed back, not stolen", () => {
  const runDir = expiredRun(mkdtempSync(join(tmpdir(), "runner-lease-livefence-")));
  const path = join(runDir, "controller-lease.json");
  const fencePath = generationFencePath(path, 8);
  const alive = { holderId: "running", pid: process.pid, processStartToken: null, generation: 8 };
  writeJsonAtomic(fencePath, alive);
  const claim = claimGenerationFence(path, { holderId: "rival", pid: process.pid, processStartToken: null }, 8);
  assert.equal(claim.claimed, false);
  assert.deepEqual(readJson(fencePath), alive, "a capture that may not be kept is put back exactly as it was");
});

test("a controller whose lease was replaced fails loudly instead of overwriting the new holder", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-lease-lost-"));
  const lease = acquireControllerLease(runDir, { contractVersion: "0.1.0", ttlMs: 100 });
  /** @type {Error[]} */
  const lost = [];
  lease.startHeartbeat((error) => lost.push(error));
  const successor = {
    schemaVersion: 1,
    contractVersion: "0.1.0",
    holderId: "successor",
    generation: lease.generation + 1,
    pid: DEAD_PID,
    processStartToken: null,
    acquiredAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  try {
    writeJsonAtomic(join(runDir, "controller-lease.json"), successor);
    assert.equal(lease.renew(), false, "renewal must fail once another holder owns the lease");
    assert.deepEqual(readJson(join(runDir, "controller-lease.json")), successor, "a lost lease must never be overwritten");
    assert.throws(() => lease.assert(), (error) => error instanceof LeaseLostError);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.ok(lost.length > 0, "the heartbeat must report the loss");
    assert.ok(lost.every((error) => error instanceof LeaseLostError), "loss must surface as LeaseLostError");
  } finally {
    lease.release();
  }
  assert.deepEqual(readJson(join(runDir, "controller-lease.json")), successor, "releasing a lost lease must not remove the new holder");
});

test("supervisor lease takeover reclaims stale ownership without a permanent lock", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-supervisor-lease-"));
  const first = acquireSupervisorLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_000 });
  const second = acquireSupervisorLease(runDir, { contractVersion: "0.1.0", ttlMs: 50, now: 1_100 });
  assert.equal(second.generation, first.generation + 1);
  first.release();
  const current = readSupervisorLease(runDir);
  assert.ok(current && !("invalid" in current));
  assert.equal(current.holderId, second.holderId);
  second.release();
  assert.equal(readSupervisorLease(runDir), null);
});

test("atomic JSON and JSONL recovery never leaves a partial authoritative record", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-store-"));
  const jsonPath = join(runDir, "run.json");
  const jsonlPath = join(runDir, "events.jsonl");
  writeJsonAtomic(jsonPath, { generation: 1, state: "ready" });
  writeJsonAtomic(jsonPath, { generation: 2, state: "done" });
  appendJsonl(jsonlPath, { to: "running" });
  appendJsonl(jsonlPath, { to: "done" });
  assert.deepEqual(readJson(jsonPath), { generation: 2, state: "done" });
  assert.deepEqual(readFileSync(jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [{ to: "running" }, { to: "done" }]);
});

test("JSONL append recovers a truncated final record before appending", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-jsonl-recovery-"));
  const jsonlPath = join(runDir, "events.jsonl");
  writeFileSync(jsonlPath, `${JSON.stringify({ to: "running" })}\n{"to":"partial`);
  appendJsonl(jsonlPath, { to: "done" });
  assert.deepEqual(readFileSync(jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [{ to: "running" }, { to: "done" }]);
});

test("termination escalates from SIGTERM to SIGKILL for a provider that ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("child pid unavailable");
  const invocation = {
    id: "ignored-term",
    pid,
    processGroupId: process.platform === "win32" ? null : pid,
    processStartToken: processStartToken(pid),
  };
  try {
    await terminateInvocation(invocation, { graceMs: 25, killGraceMs: 500 });
    assert.equal(invocationAlive(invocation), false);
  } finally {
    try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {}
  }
});

test("portable PID reuse defense rejects a mismatched Linux process start token", { skip: process.platform !== "linux" }, () => {
  assert.equal(invocationAlive({ pid: process.pid, processStartToken: "definitely-not-this-process" }), false);
});

test("monitorInvocation reads bounded live evidence and never throws", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-monitor-invocation-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  writeFileSync(stdout, [
    { type: "thread.started", thread_id: "live-thread" },
    { type: "item.completed", item: { type: "tool_call" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const job = /** @type {import("../scripts/supervisor.mjs").Job} */ ({
    runtime: { driver: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.deepEqual(monitorInvocation(job), { continuationId: "live-thread", turns: 1, cacheReadInputTokens: 80, toolCalls: 1, completed: false });
  assert.deepEqual(
    monitorInvocation({ ...job, paths: { ...job.paths, stdout: join(logs, "missing.jsonl") } }),
    { continuationId: null, turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false },
    "a missing transcript meters as zero without throwing",
  );
});

test("monitorInvocation keeps counting codex turns after the transcript outgrows any fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-monitor-fat-codex-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const fatItem = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(4096) } });
  const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 150_000 } });
  const first = [];
  for (let index = 0; index < 40; index += 1) first.push(fatItem, turn);
  writeFileSync(stdout, `${first.join("\n")}\n`);
  const job = /** @type {import("../scripts/supervisor.mjs").Job} */ ({
    runtime: { driver: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.equal(monitorInvocation(job).turns, 40, "the first observation consumes the padded prefix");
  const second = [];
  for (let index = 0; index < 40; index += 1) second.push(turn);
  appendFileSync(stdout, `${second.join("\n")}\n`);
  assert.ok(statSync(stdout).size > 128 * 1024, "the transcript outgrew the old fixed live window");
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 80, "the rotation turn threshold stays observable on a fat transcript");
  assert.equal(observed.cacheReadInputTokens, 150_000, "cumulative codex cache-read counters compose as a max, not a sum");
});

test("monitorInvocation observes claude turns and the session total beyond a fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-monitor-fat-claude-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const lines = [];
  for (let index = 0; index < 90; index += 1) {
    // Fat content pushes the threshold-crossing turns past 128 KiB of log.
    const text = index < 40 ? "z".repeat(4096) : "done";
    lines.push(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }], usage: { input_tokens: 1, cache_read_input_tokens: 1_000 } },
    }));
  }
  lines.push(JSON.stringify({ type: "result", session_id: "fat-session", usage: { input_tokens: 9, cache_read_input_tokens: 123_456 } }));
  writeFileSync(stdout, `${lines.join("\n")}\n`);
  assert.ok(statSync(stdout).size > 128 * 1024, "the transcript outgrew the old fixed live window");
  const job = /** @type {import("../scripts/supervisor.mjs").Job} */ ({
    runtime: { driver: "claude" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 90, "assistant turns past the old window still count");
  assert.equal(observed.cacheReadInputTokens, 123_456, "the terminal result total replaces the per-turn sum");
});

test("stall supervision uses the latest persisted timeout override", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-timeout-override-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.INTENT_FACTORY_MARKER, \"started\"); process.stdin.resume(); setTimeout(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  const previousMarker = process.env.INTENT_FACTORY_MARKER;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, [
    { kind: "timeout", timeoutSec: 5, at: new Date().toISOString(), reason: "old" },
    { kind: "timeout", timeoutSec: 0.05, at: new Date().toISOString(), reason: "latest" },
  ]);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", driver: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => assert.equal(existsSync(marker), false, "provider must not start before invocation persistence"),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    /** @type {{currentJob: import("../scripts/supervisor.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
  let timeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      timeout = { currentJob, status, error };
    });
    assert.ok(timeout, "stall supervisor reported a timeout");
    assert.equal(timeout.status, "exhausted");
    assert.match(timeout.error.message, /0\.05s/u);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.INTENT_FACTORY_MARKER;
    else process.env.INTENT_FACTORY_MARKER = previousMarker;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a glm worker runs with the driver's endpoint env overlay applied", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-glm-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-env.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
const marker = process.env.INTENT_FACTORY_MARKER;
const temporary = \`${"${marker}"}.${"${process.pid}"}.tmp\`;
writeFileSync(temporary, JSON.stringify({
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  model: process.env.ANTHROPIC_MODEL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
renameSync(temporary, marker);
process.stdin.resume();
`);
  chmodSync(provider, 0o755);
  const previous = {
    INTENT_FACTORY_GLM_BIN: process.env.INTENT_FACTORY_GLM_BIN,
    INTENT_FACTORY_MARKER: process.env.INTENT_FACTORY_MARKER,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.INTENT_FACTORY_GLM_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  process.env.ZAI_API_KEY = "glm-test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
  process.env.ANTHROPIC_BASE_URL = "https://ambient.example/api";
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "glm", driver: "glm", model: "glm-5.3[1m]" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.baseUrl, "https://api.z.ai/api/anthropic", "endpoint overlay replaces the ambient base URL");
    assert.equal(observed.model, "glm-5.3[1m]");
    assert.equal(observed.token, "glm-test-token");
    assert.equal(observed.apiKey, null, "ambient Anthropic key is removed, not inherited");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("worker providers never receive the controller-only notification transport", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-notify-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-env.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
const marker = process.env.INTENT_FACTORY_MARKER;
const temporary = \`${"${marker}"}.${"${process.pid}"}.tmp\`;
writeFileSync(temporary, JSON.stringify({
  notify: process.env.INTENT_FACTORY_NOTIFY_BIN ?? null,
  ambient: process.env.INTENT_FACTORY_AMBIENT ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  model: process.env.ANTHROPIC_MODEL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
renameSync(temporary, marker);
process.stdin.resume();
`);
  chmodSync(provider, 0o755);
  const previous = {
    INTENT_FACTORY_GLM_BIN: process.env.INTENT_FACTORY_GLM_BIN,
    INTENT_FACTORY_MARKER: process.env.INTENT_FACTORY_MARKER,
    INTENT_FACTORY_AMBIENT: process.env.INTENT_FACTORY_AMBIENT,
    INTENT_FACTORY_NOTIFY_BIN: process.env.INTENT_FACTORY_NOTIFY_BIN,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.INTENT_FACTORY_GLM_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  process.env.INTENT_FACTORY_AMBIENT = "ambient-value";
  process.env.INTENT_FACTORY_NOTIFY_BIN = provider;
  process.env.ZAI_API_KEY = "glm-notify-test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "glm", driver: "glm", model: "glm-5.3[1m]" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.notify, null, "INTENT_FACTORY_NOTIFY_BIN must not reach the worker provider");
    assert.equal(observed.ambient, "ambient-value", "ambient runtime variables must survive");
    assert.equal(observed.baseUrl, "https://api.z.ai/api/anthropic", "driver env overlay must still apply");
    assert.equal(observed.model, "glm-5.3[1m]");
    assert.equal(observed.token, "glm-notify-test-token");
    assert.equal(observed.apiKey, null, "ambient Anthropic key is removed, not inherited");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a persistence failure leaves the gated provider unstarted and terminates its wrapper", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "runner-persistence-barrier-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.INTENT_FACTORY_MARKER, \"started\"); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.INTENT_FACTORY_CODEX_BIN;
  const previousMarker = process.env.INTENT_FACTORY_MARKER;
  process.env.INTENT_FACTORY_CODEX_BIN = provider;
  process.env.INTENT_FACTORY_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  let persistedInvocation;
  try {
    assert.throws(() => startProcess({
      contract,
      node,
      state,
      runtime: { id: "luna", driver: "codex", model: "test" },
      prompt: "task",
      paths: {
        prompt: join(logs, "worker.prompt"),
        stdout: join(logs, "worker.jsonl"),
        stderr: join(logs, "worker.err"),
      },
      phase: "worker",
      onInvocation: (invocation) => {
        persistedInvocation = invocation;
        throw new Error("persistence failed");
      },
    }), /persistence failed/u);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(marker), false);
    assert.equal(invocationAlive(persistedInvocation), false);
  } finally {
    if (previous === undefined) delete process.env.INTENT_FACTORY_CODEX_BIN;
    else process.env.INTENT_FACTORY_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.INTENT_FACTORY_MARKER;
    else process.env.INTENT_FACTORY_MARKER = previousMarker;
  }
});

