/**
 * `contract prune`: turn a partially finished run into the contract for what
 * is left of it.
 *
 * A long phase rarely ends with every node settled — the budget runs out, a
 * runtime goes down, one node fails after its siblings passed. Hand-editing a
 * continuation contract re-authors objectives that were already agreed and
 * throws away everything the unfinished nodes learned. Pruning is mechanical
 * instead: drop the settled nodes, keep the rest with their dependencies
 * rewritten to the survivors, and seed every survivor with the portable
 * capsule its last attempt left behind.
 *
 * A pruned contract with one node left is by definition a targeted fix, so it
 * is written only with `--targeted-fix` and is stamped `targetedFix: true`.
 * `validate` refuses any other single-node contract: rule 11 (never authorise
 * a serial micro-contract) is otherwise easy to break by accident, and the
 * batched multi-node DAG is what keeps a plan step cheap.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseCapsule } from "./capsule.mjs";
import { validateContract } from "./contract.mjs";
import { writeJsonAtomic } from "./store.mjs";

/** @typedef {import("./capsule.mjs").Capsule} Capsule */
/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./task-packet.mjs").TaskPacket} TaskPacket */

/**
 * Statuses whose objective needs no further work. `no-op` joins `done`
 * because a node that decided there was nothing to do would only decide it
 * again, at the price of another worker invocation.
 */
const SETTLED_STATUSES = new Set(["done", "no-op"]);

/** Every seed line is prefixed so a worker can tell the seed from its packet. */
const SEED_PREFIX = "continuation seed";

/** Flags are scoped to the operation that declares them; all others are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  prune: { out: { type: "string" }, id: { type: "string" }, "targeted-fix": { type: "boolean" } },
  validate: {},
};

/**
 * @param {string[]} args
 * @returns {void}
 */
export function contractCli(args) {
  const operation = args[0];
  if (!operation || !Object.hasOwn(OPERATION_OPTIONS, operation)) return usage();
  let parsed;
  try {
    parsed = parseArgs({
      args: args.slice(1),
      options: OPERATION_OPTIONS[operation],
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return usage();
  }
  const [target, ...extra] = parsed.positionals;
  if (!target || extra.length) return usage();
  if (operation === "validate") {
    validateContractFile(resolve(target));
    return;
  }
  const out = parsed.values.out;
  if (typeof out !== "string" || !out) throw new TypeError("contract prune requires --out <file>");
  const pruned = pruneRun(resolve(target), {
    out: resolve(out),
    targetedFix: parsed.values["targeted-fix"] === true,
    id: typeof parsed.values.id === "string" ? parsed.values.id : undefined,
  });
  process.stdout.write(
    `[prune] ${pruned.contract.id} · kept ${pruned.kept.length} · dropped ${pruned.dropped.length}`
    + ` · seeded ${pruned.seeded.length} · ${pruned.out}\n`,
  );
}

/**
 * Validate an authored contract and print the same report the `validate`
 * command has always printed, with the single-node rule as a hard error.
 *
 * @param {string} path
 * @returns {ValidatedContract}
 */
export function validateContractFile(path) {
  const contract = assertTargetedFix(validateContract(JSON.parse(readFileSync(path, "utf8")), path));
  const count = contract.warnings.length;
  process.stdout.write(`valid${count ? ` (${count} warning${count === 1 ? "" : "s"})` : ""}\n`);
  for (const warning of contract.warnings) process.stdout.write(`[warn] ${warning}\n`);
  return contract;
}

/**
 * A single-node contract is a targeted fix or it is a serial micro-contract,
 * and the second one is never authorised.
 *
 * @param {ValidatedContract} contract
 * @returns {ValidatedContract}
 */
export function assertTargetedFix(contract) {
  const [only] = contract.nodes;
  if (contract.nodes.length !== 1 || only.targetedFix === true) return contract;
  throw new TypeError(
    `contract ${contract.id} has the single node ${only.id} without targetedFix: true; a plan step arrives as one`
    + " batched multi-node DAG with dependsOn, and a genuine targeted fix comes from contract prune --targeted-fix",
  );
}

/**
 * Read a run, drop its settled nodes, and write the continuation contract.
 *
 * @param {string} runDir
 * @param {{out: string, targetedFix?: boolean, id?: string}} options
 * @returns {{contract: ValidatedContract, out: string, kept: string[], dropped: string[], seeded: string[]}}
 */
export function pruneRun(runDir, options) {
  const contractPath = join(runDir, "contract.json");
  if (!existsSync(contractPath)) throw new Error(`not a run directory: ${runDir}`);
  const source = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath, { persisted: true });
  const dropped = source.nodes.filter((node) => settled(runDir, node.id)).map((node) => node.id);
  const kept = source.nodes.filter((node) => !dropped.includes(node.id));
  if (!kept.length) throw new Error(`every node of run ${source.id} is settled; there is nothing to continue`);
  if (kept.length === 1 && options.targetedFix !== true) {
    throw new Error(
      `pruning run ${source.id} leaves the single node ${kept[0].id}; a single-node contract is a targeted fix`
      + " and is only written with --targeted-fix",
    );
  }
  const keptIds = new Set(kept.map((node) => node.id));
  const seeds = new Map(kept.map((node) => [node.id, latestCapsule(runDir, node.id)]));
  const id = options.id ?? nextContinuationId(source.id);
  const targetedFix = kept.length === 1 && options.targetedFix === true;
  const contract = {
    ...omit(source, ["nodes", "warnings", "sourceIdentity"]),
    id,
    sourceIdentity: { kind: "contract", id, campaignId: source.campaignId },
    nodes: kept.map((node) => prunedNode(node, keptIds, seeds.get(node.id) ?? null, targetedFix)),
  };
  // Validate as authored, not as persisted: this file is a new contract, and
  // the continuation must fail here rather than at the start of the next run.
  const validated = assertTargetedFix(validateContract(contract, options.out));
  if (existsSync(options.out)) throw new Error(`refusing to overwrite ${options.out}; pass a different --out`);
  writeJsonAtomic(options.out, contract);
  return {
    contract: validated,
    out: options.out,
    kept: [...keptIds],
    dropped,
    seeded: kept.filter((node) => seeds.get(node.id)).map((node) => node.id),
  };
}

/**
 * Rebuild one surviving node as an authored node: dependencies on dropped
 * nodes are already satisfied, the resolved packet replaces any
 * `taskPacketFile`, and the stale packet hash and node identity are recomputed
 * by the next validation rather than carried over.
 *
 * @param {ValidatedNode} node
 * @param {Set<string>} keptIds
 * @param {Capsule|null} capsule
 * @param {boolean} targetedFix
 * @returns {Record<string, unknown>}
 */
function prunedNode(node, keptIds, capsule, targetedFix) {
  return {
    ...omit(node, ["prompt", "taskPacketFile", "packetHash", "sourceIdentity"]),
    dependsOn: node.dependsOn.filter((dependency) => keptIds.has(dependency)),
    taskPacket: capsule === null ? node.taskPacket : seedPacket(node.taskPacket, capsule),
    ...(targetedFix ? { targetedFix: true } : {}),
  };
}

/**
 * Fold a capsule into the packet's decisions: they are what the prompt renders
 * as "Decisions already made", which is exactly what the previous attempt
 * settled. The capsule is already bounded and redacted by `buildCapsule`.
 *
 * @param {TaskPacket} packet
 * @param {Capsule} capsule
 * @returns {TaskPacket}
 */
function seedPacket(packet, capsule) {
  const seed = [`${SEED_PREFIX} from attempt ${capsule.attemptId} of run ${capsule.runId} (capsule ${capsule.digest ?? "undigested"})`];
  if (capsule.nextAction) seed.push(`${SEED_PREFIX} next action: ${capsule.nextAction}`);
  for (const decision of capsule.decisions) seed.push(`${SEED_PREFIX} decided: ${decision}`);
  if (capsule.changedFiles.length) seed.push(`${SEED_PREFIX} already changed: ${capsule.changedFiles.join(", ")}`);
  for (const verification of capsule.verifications) {
    seed.push(`${SEED_PREFIX} ${verification.pass ? "passed" : "failed"}: ${verification.argv}`);
  }
  for (const blocker of capsule.blockers) seed.push(`${SEED_PREFIX} blocker: ${blocker}`);
  return { ...packet, decisions: [...seed, ...packet.decisions] };
}

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {boolean}
 */
function settled(runDir, nodeId) {
  const state = readJsonIfPresent(join(runDir, "nodes", `${nodeId}.json`));
  const status = state === null ? null : state.status;
  return typeof status === "string" && SETTLED_STATUSES.has(status);
}

/**
 * The newest capsule a node left behind, across all of its attempts.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {Capsule|null}
 */
function latestCapsule(runDir, nodeId) {
  const directory = join(runDir, "capsules");
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  let newest = null;
  let newestAttempt = -1;
  for (const entry of entries) {
    const attempt = capsuleAttempt(entry, nodeId);
    if (attempt === null || attempt <= newestAttempt) continue;
    newestAttempt = attempt;
    newest = entry;
  }
  if (newest === null) return null;
  try {
    return parseCapsule(readFileSync(join(directory, newest), "utf8"));
  } catch (error) {
    throw new Error(`capsule ${newest} cannot seed node ${nodeId}: ${errorMessage(error)}`);
  }
}

/**
 * Capsules are stored as `<nodeId>.<attempt>.json`; node ids may contain dots,
 * so the attempt is the last dotted segment before the extension.
 *
 * @param {string} entry
 * @param {string} nodeId
 * @returns {number|null}
 */
function capsuleAttempt(entry, nodeId) {
  if (!entry.endsWith(".json")) return null;
  const stem = entry.slice(0, -".json".length);
  const separator = stem.lastIndexOf(".");
  if (separator <= 0 || stem.slice(0, separator) !== nodeId) return null;
  const attempt = stem.slice(separator + 1);
  return /^\d+$/u.test(attempt) ? Number(attempt) : null;
}

/**
 * A pruned run is a new run, never a resumption of the frozen one, so the
 * contract id always moves on.
 *
 * @param {string} id
 * @returns {string}
 */
function nextContinuationId(id) {
  const match = /^(.+)-continuation(?:-(\d+))?$/u.exec(id);
  if (!match) return `${id}-continuation`;
  return `${match[1]}-continuation-${match[2] === undefined ? 2 : Number(match[2]) + 1}`;
}

/**
 * @template {object} T
 * @param {T} value
 * @param {string[]} fields
 * @returns {Record<string, unknown>}
 */
function omit(value, fields) {
  const copy = /** @type {Record<string, unknown>} */ ({ ...value });
  for (const field of fields) delete copy[field];
  return copy;
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>|null}
 */
function readJsonIfPresent(path) {
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** @param {unknown} error @returns {string} */
function errorCode(error) {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @returns {void} */
function usage() {
  process.stderr.write(
    "usage: runner.mjs contract prune <run-dir> --out <file> [--id <contract-id>] [--targeted-fix] | "
    + "contract validate <contract.json>\n",
  );
  process.exitCode = 2;
}
