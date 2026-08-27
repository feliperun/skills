import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validateContract } from "./contract.mjs";
import { TERMINAL } from "./lib.mjs";
import {
  acquireLease,
  leaseHealthy,
  readJson,
  readLease,
  writeJsonAtomic,
} from "./store.mjs";
import {
  campaignDir,
  closeCampaign,
  initializeCampaign,
  readCampaign,
  registerRun,
} from "./campaign.mjs";

export { campaignDir, initializeCampaign, registerRun } from "./campaign.mjs";
export { acquireLease, writeJsonAtomic } from "./store.mjs";

export const CAMPAIGN_PLAN_FILE = "plan.json";
export const CAMPAIGN_STATE_FILE = "control-state.json";
export const CAMPAIGN_OUTBOX_FILE = "notification-outbox.json";
export const CAMPAIGN_LEASE_FILE = "campaign-controller-lease.json";
export const CAMPAIGN_SNAPSHOT_DIR = "controller-snapshots";
export const CAMPAIGN_BOOTSTRAP_FILE = "controller-bootstrap.json";
export const CAMPAIGN_PLAN_VERSION = "1.0.0";
export const CAMPAIGN_SCHEMA_VERSION = 1;
const MAX_OUTBOX_EVENTS = 100;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024;
const DEFAULT_INTERVAL_MS = 1_000;
const TERMINAL_CAMPAIGN_STATES = new Set(["attention", "completed"]);

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{argv: string[]}} AllowedVerification */
/** @typedef {{allowedRuntimes: string[], routes: {from: string, to: string}[]}} RuntimeFailover */
/** @typedef {{repairRoots: string[], allowedVerification: AllowedVerification[], retryLimit: number, repairLimit: number, runtimeFailover: RuntimeFailover, maxInputTokens: number, maxCostUsd: number|null, irreversibleActionsForbidden: true}} CampaignAuthority */
/** @typedef {{schemaVersion: 1, planVersion: string, campaignId: string, goal: string, initialRunContract: string, controller: {snapshotVersion: string, snapshotPath: string, contentHash: string}, authority: CampaignAuthority}} CampaignPlan */
/** @typedef {{id: string, kind: "initial"|"repair", contractPath: string, status: "planned"|"running"|"done"|"attention"}} CampaignRun */
/** @typedef {{id: string, kind: string, status: "pending"|"dispatched"|"failed", runId?: string, error?: string}} CampaignAction */
/** @typedef {{schemaVersion: 1, campaignId: string, status: "configured"|"running"|"attention"|"completed", initialRunId: string, runs: CampaignRun[], retries: Record<string, number>, repairs: Record<string, string>, actions: Record<string, CampaignAction>, attention: {code: string, message: string}|null, updatedAt: string}} CampaignControlState */
/** @typedef {{eventId: string, type: string, campaignId: string, at: string, summary: string, data?: JsonObject, deliveredAt?: string|null, attempts: number, lastError?: string|null}} NotificationEvent */

/**
 * Validate the durable campaign plan. The plan is intentionally independent
 * from the runner contract so authority cannot be enlarged by a repair
 * contract or by a finding.
 *
 * @param {unknown} value
 * @returns {CampaignPlan}
 */
export function validateCampaignPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("campaign plan must be an object");
  const plan = /** @type {JsonObject} */ (value);
  requireExact(plan, ["schemaVersion", "planVersion", "campaignId", "goal", "initialRunContract", "controller", "authority"], "campaign plan");
  if (plan.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) throw new TypeError(`campaign plan.schemaVersion must be ${CAMPAIGN_SCHEMA_VERSION}`);
  if (plan.planVersion !== CAMPAIGN_PLAN_VERSION) throw new TypeError(`campaign plan.planVersion must be ${CAMPAIGN_PLAN_VERSION}`);
  requireId(plan.campaignId, "campaign plan.campaignId");
  requireText(plan.goal, "campaign plan.goal");
  requireRelative(plan.initialRunContract, "campaign plan.initialRunContract");

  const controller = objectValue(plan.controller, "campaign plan.controller");
  requireExact(controller, ["snapshotVersion", "snapshotPath", "contentHash"], "campaign plan.controller");
  requireId(controller.snapshotVersion, "campaign plan.controller.snapshotVersion");
  requireRelative(controller.snapshotPath, "campaign plan.controller.snapshotPath");
  if (!/^[a-f0-9]{64}$/u.test(String(controller.contentHash))) throw new TypeError("campaign plan.controller.contentHash must be a sha256 hash");

  const rawAuthority = objectValue(plan.authority, "campaign plan.authority");
  requireExact(rawAuthority, [
    "repairRoots", "allowedVerification", "retryLimit", "repairLimit", "runtimeFailover",
    "maxInputTokens", "maxCostUsd", "irreversibleActionsForbidden",
  ], "campaign plan.authority");
  const repairRoots = stringArray(rawAuthority.repairRoots, "campaign plan.authority.repairRoots", true);
  for (const [index, root] of repairRoots.entries()) requireRelative(root, `campaign plan.authority.repairRoots[${index}]`);
  const allowedVerification = validateAllowedVerification(rawAuthority.allowedVerification);
  const retryLimit = boundedInteger(rawAuthority.retryLimit, "campaign plan.authority.retryLimit", 100);
  const repairLimit = boundedInteger(rawAuthority.repairLimit, "campaign plan.authority.repairLimit", 100);
  const failover = objectValue(rawAuthority.runtimeFailover, "campaign plan.authority.runtimeFailover");
  requireExact(failover, ["allowedRuntimes", "routes"], "campaign plan.authority.runtimeFailover");
  const allowedRuntimes = stringArray(failover.allowedRuntimes, "campaign plan.authority.runtimeFailover.allowedRuntimes", true);
  const routeIds = new Set(allowedRuntimes);
  const routes = [];
  if (!Array.isArray(failover.routes)) throw new TypeError("campaign plan.authority.runtimeFailover.routes must be an array");
  for (const [index, rawRoute] of failover.routes.entries()) {
    const route = objectValue(rawRoute, `campaign plan.authority.runtimeFailover.routes[${index}]`);
    requireExact(route, ["from", "to"], `campaign plan.authority.runtimeFailover.routes[${index}]`);
    requireId(route.from, `campaign plan.authority.runtimeFailover.routes[${index}].from`);
    requireId(route.to, `campaign plan.authority.runtimeFailover.routes[${index}].to`);
    const from = String(route.from);
    const to = String(route.to);
    if (!routeIds.has(from) || !routeIds.has(to)) throw new TypeError("campaign plan failover route uses an undeclared runtime");
    if (from === to) throw new TypeError("campaign plan failover route cannot self-loop");
    routes.push({ from, to });
  }
  const maxInputTokens = positiveInteger(rawAuthority.maxInputTokens, "campaign plan.authority.maxInputTokens");
  const maxCostUsd = rawAuthority.maxCostUsd === null ? null : nonNegativeNumber(rawAuthority.maxCostUsd, "campaign plan.authority.maxCostUsd");
  if (rawAuthority.irreversibleActionsForbidden !== true) {
    throw new TypeError("campaign plan.authority.irreversibleActionsForbidden must be true");
  }
  return /** @type {CampaignPlan} */ ({
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    planVersion: String(plan.planVersion),
    campaignId: String(plan.campaignId),
    goal: String(plan.goal),
    initialRunContract: String(plan.initialRunContract),
    controller: {
      snapshotVersion: String(controller.snapshotVersion),
      snapshotPath: String(controller.snapshotPath),
      contentHash: String(controller.contentHash),
    },
    authority: {
      repairRoots,
      allowedVerification,
      retryLimit,
      repairLimit,
      runtimeFailover: { allowedRuntimes, routes },
      maxInputTokens,
      maxCostUsd,
      irreversibleActionsForbidden: true,
    },
  });
}

/**
 * Read and validate a campaign plan from its durable location.
 *
 * @param {string} campaignPath
 * @returns {CampaignPlan}
 */
export function readCampaignPlan(campaignPath) {
  const plan = validateCampaignPlan(readJson(join(campaignPath, CAMPAIGN_PLAN_FILE)));
  verifyControllerSnapshot(campaignPath, plan);
  return plan;
}

/**
 * Copy the complete intent-factory tree into an immutable campaign-owned
 * version. Existing versions are never overwritten.
 *
 * @param {string} campaignPath
 * @param {{version?: string, sourceRoot?: string}} [options]
 * @returns {{version: string, path: string, contentHash: string}}
 */
export function createControllerSnapshot(campaignPath, options = {}) {
  const version = options.version ?? "v1";
  requireId(version, "controller snapshot version");
  const sourceRoot = resolve(options.sourceRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  if (!existsSync(sourceRoot) || !lstatSync(sourceRoot).isDirectory()) throw new Error(`controller source is not a directory: ${sourceRoot}`);
  const contentHash = hashTree(sourceRoot);
  const snapshotPath = join(campaignPath, CAMPAIGN_SNAPSHOT_DIR, version);
  if (existsSync(snapshotPath)) throw new Error(`controller snapshot already exists: ${snapshotPath}`);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  copyTree(sourceRoot, snapshotPath);
  const record = { schemaVersion: CAMPAIGN_SCHEMA_VERSION, version, contentHash };
  writeJsonAtomic(join(snapshotPath, "snapshot.json"), record);
  makeReadOnly(snapshotPath);
  if (hashTree(snapshotPath) !== contentHash) throw new Error(`controller snapshot hash mismatch: ${snapshotPath}`);
  return { version, path: snapshotPath, contentHash };
}

/** @param {string} campaignPath @param {CampaignPlan} plan */
export function writeCampaignPlan(campaignPath, plan) {
  const checked = validateCampaignPlan(plan);
  const path = join(campaignPath, CAMPAIGN_PLAN_FILE);
  if (existsSync(path)) throw new Error(`campaign plan already exists: ${path}`);
  mkdirSync(campaignPath, { recursive: true });
  writeJsonAtomic(path, checked);
  return checked;
}

/**
 * Configure an existing campaign. The initial contract is copied into the
 * campaign directory, which makes the plan self-contained before execution.
 *
 * @param {string} campaignPath
 * @param {{plan?: JsonObject, initialRunContract?: string, authority?: JsonObject, snapshotVersion?: string, sourceRoot?: string}} options
 * @returns {{path: string, plan: CampaignPlan, contractPath: string}}
 */
export function configureCampaign(campaignPath, options) {
  if (!options || typeof options !== "object") throw new TypeError("campaign configuration is required");
  const campaign = readCampaign(campaignPath);
  const input = options.plan ? objectValue(options.plan, "campaign configuration.plan") : {};
  const initialSource = options.initialRunContract ?? (typeof input.initialRunContract === "string" && isAbsolute(input.initialRunContract) ? input.initialRunContract : undefined);
  if (!initialSource) throw new TypeError("campaign configuration requires initialRunContract");
  const sourcePath = resolve(initialSource);
  const rawContract = JSON.parse(readFileSync(sourcePath, "utf8"));
  const validated = validateContract(rawContract, sourcePath);
  if (validated.campaignId !== campaign.id) throw new TypeError("initial contract campaignId must match campaign id");
  const contractPath = join(campaignPath, "contracts", `${validated.id}.json`);
  mkdirSync(dirname(contractPath), { recursive: true });
  const durableContract = JSON.parse(JSON.stringify(rawContract));
  durableContract.cwd = validated.cwd;
  copyTaskPacketFiles(rawContract, durableContract, sourcePath, contractPath);
  removeUndefined(durableContract);
  if (existsSync(contractPath)) {
    if (canonicalJson(JSON.parse(readFileSync(contractPath, "utf8"))) !== canonicalJson(durableContract)) {
      throw new Error(`initial contract already exists with different content: ${contractPath}`);
    }
  } else {
    writeJsonAtomic(contractPath, durableContract);
  }
  const snapshot = createControllerSnapshot(campaignPath, {
    version: options.snapshotVersion ?? (typeof input.controller === "object" && input.controller ? String(/** @type {JsonObject} */ (input.controller).snapshotVersion ?? "v1") : "v1"),
    sourceRoot: options.sourceRoot,
  });
  const authority = normalizeAuthority(options.authority ?? input.authority, /** @type {JsonObject} */ (validated));
  const plan = validateCampaignPlan({
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    planVersion: CAMPAIGN_PLAN_VERSION,
    campaignId: campaign.id,
    goal: campaign.goal,
    initialRunContract: relative(campaignPath, contractPath),
    controller: {
      snapshotVersion: snapshot.version,
      snapshotPath: relative(campaignPath, snapshot.path),
      contentHash: snapshot.contentHash,
    },
    authority,
  });
  writeCampaignPlan(campaignPath, plan);
  return { path: join(campaignPath, CAMPAIGN_PLAN_FILE), plan, contractPath };
}

/**
 * Start the initial run once. The action is persisted before the child is
 * launched, so a controller crash can inspect the run directory and avoid a
 * second launch.
 *
 * @param {string} campaignPath
 * @param {{executor?: (request: JsonObject) => Promise<unknown>|unknown}} [options]
 * @returns {Promise<{campaignPath: string, runId: string, actionId: string}>}
 */
export async function startCampaign(campaignPath, options = {}) {
  const plan = readCampaignPlan(campaignPath);
  const state = loadOrCreateState(campaignPath, plan);
  const record = state.runs[0];
  const actionId = `start:${record.id}`;
  state.status = "running";
  registerRun(campaignPath, record.id);
  persistState(campaignPath, state);
  await dispatchRun(campaignPath, plan, state, record, "run", actionId, options.executor ?? undefined);
  return { campaignPath, runId: record.id, actionId };
}

/**
 * Purely classify one observed run transition. No filesystem or process
 * access occurs here; callers can replay the same input after a crash.
 *
 * @param {JsonObject} input
 * @returns {{action: "wait"|"resume"|"repair"|"attention"|"complete", reason: string, retryable?: boolean, failoverTo?: string|null}}
 */
export function classifyTransition(input) {
  const plan = input.plan && typeof input.plan === "object" ? /** @type {CampaignPlan} */ (input.plan) : null;
  const authority = plan?.authority ?? /** @type {CampaignAuthority|undefined} */ (input.authority);
  const run = input.run && typeof input.run === "object" ? /** @type {JsonObject} */ (input.run) : input;
  const state = input.state && typeof input.state === "object" ? /** @type {JsonObject} */ (input.state) : {};
  const status = typeof run.status === "string" ? run.status : typeof input.status === "string" ? input.status : "invalid";
  const error = run.error && typeof run.error === "object" ? /** @type {JsonObject} */ (run.error) : {};
  const code = String(error.code ?? run.errorCode ?? input.errorCode ?? "").toLowerCase();
  const controllerAlive = run.controllerAlive === true;
  const retryCount = Number(state.retryCount ?? input.retryCount ?? run.retryCount ?? 0);
  const retryLimit = authority?.retryLimit ?? Number(input.retryLimit ?? 0);
  const allGreen = run.allGreen === true || (Array.isArray(run.nodes) && run.nodes.length > 0 && run.nodes.every((node) => {
    const nodeStatus = node && typeof node === "object" ? /** @type {JsonObject} */ (node).status : null;
    return nodeStatus === "done" || nodeStatus === "no-op";
  }));
  if (allGreen || status === "done" || status === "no-op") return { action: "complete", reason: "all_green", failoverTo: null };
  if (!controllerAlive && !TERMINAL.has(status)) {
    if (retryCount < retryLimit) return { action: "resume", reason: "controller_dead", retryable: true, failoverTo: null };
    return { action: "attention", reason: "retry_limit_exhausted", failoverTo: null };
  }
  if (isTimeoutOrStall(status, code)) {
    if (retryCount < retryLimit) return { action: "resume", reason: "retryable_timeout_or_stall", retryable: true, failoverTo: null };
    return { action: "attention", reason: "retry_limit_exhausted", failoverTo: null };
  }
  if (isProviderExhaustion(status, code)) {
    const currentRuntime = String(run.currentRuntime ?? input.currentRuntime ?? "");
    const next = (authority?.runtimeFailover?.routes ?? []).find((route) => route.from === currentRuntime)?.to ?? null;
    const used = Array.isArray(run.failoverHistory) && run.failoverHistory.includes(next);
    if (next && !used) return { action: "resume", reason: "declared_provider_failover", retryable: true, failoverTo: next };
    return { action: "attention", reason: "provider_exhausted_without_declared_failover", failoverTo: null };
  }
  if (isBudget(code, status)) return { action: "attention", reason: "budget_exhausted", failoverTo: null };
  if (isForbiddenAuthority(code, status)) return { action: "attention", reason: "forbidden_authority_or_irreversible_action", failoverTo: null };
  if (isInvalid(code, status)) return { action: "attention", reason: "invalid_state", failoverTo: null };
  if (isRepairable(code, status, run)) {
    const repairCount = Number(state.repairCount ?? input.repairCount ?? run.repairCount ?? 0);
    const repairLimit = authority?.repairLimit ?? Number(input.repairLimit ?? 0);
    if (repairCount < repairLimit) return { action: "repair", reason: "targeted_repair_allowed", failoverTo: null };
    return { action: "attention", reason: "repair_limit_exhausted", failoverTo: null };
  }
  if (controllerAlive && !TERMINAL.has(status)) return { action: "wait", reason: "controller_alive", failoverTo: null };
  return { action: "attention", reason: "unclassified_terminal_failure", failoverTo: null };
}

/**
 * Run one deterministic supervisor pass. `once` belongs to the caller; this
 * function performs no unbounded polling and is convenient for tests.
 *
 * @param {string} campaignPath
 * @param {{executor?: (request: JsonObject) => Promise<unknown>|unknown, now?: string}} [options]
 * @returns {Promise<JsonObject>}
 */
export async function superviseCampaignOnce(campaignPath, options = {}) {
  const plan = readCampaignPlan(campaignPath);
  const state = loadOrCreateState(campaignPath, plan);
  const now = options.now ?? new Date().toISOString();
  for (const record of state.runs) {
    const observed = inspectRun(campaignPath, record);
    if (observed.invalid) {
      setAttention(campaignPath, state, "invalid_state", String(observed.invalid));
      break;
    }
    const transition = classifyTransition({ plan, state: {
      retryCount: state.retries[record.id] ?? 0,
      repairCount: Object.keys(state.repairs).filter((id) => id.startsWith(`${record.id}:`)).length,
    }, run: observed });
    if (transition.action === "complete") {
      record.status = "done";
      persistState(campaignPath, state);
      continue;
    }
    if (transition.action === "wait") continue;
    if (transition.action === "attention") {
      record.status = "attention";
      setAttention(campaignPath, state, transition.reason, `${record.id}: ${transition.reason}`);
      break;
    }
    if (transition.action === "resume") {
      if (transition.failoverTo && !runAllowsFailover(/** @type {JsonObject} */ (observed.contract), observed.currentRuntime, transition.failoverTo)) {
        setAttention(campaignPath, state, "undeclared_provider_failover", `${record.id}: ${observed.currentRuntime} -> ${transition.failoverTo}`);
        break;
      }
      const actionId = `${transition.reason}:${record.id}:${state.retries[record.id] ?? 0}`;
      if (transition.retryable) state.retries[record.id] = (state.retries[record.id] ?? 0) + 1;
      state.status = "running";
      persistState(campaignPath, state);
      const command = /** @type {"run"|"resume"} */ (existsSync(join(String(observed.runDir), "contract.json")) ? "resume" : "run");
      await dispatchRun(campaignPath, plan, state, record, command, actionId, options.executor ?? undefined, transition.failoverTo);
      break;
    }
    if (transition.action === "repair") {
      const node = observed.failedNode;
      if (!node) {
        setAttention(campaignPath, state, "invalid_state", `${record.id}: repair has no failed node evidence`);
        break;
      }
      const created = createRepairContract(campaignPath, plan, state, record, /** @type {JsonObject} */ (node), observed);
      const repairRecord = state.runs.find((candidate) => candidate.id === created.repairId) ?? {
        id: created.repairId,
        kind: "repair",
        contractPath: created.contractPath,
        status: "planned",
      };
      if (!state.runs.includes(repairRecord)) state.runs.push(repairRecord);
      state.repairs[created.repairKey] = created.repairId;
      state.status = "running";
      registerRun(campaignPath, repairRecord.id);
      persistState(campaignPath, state);
      await dispatchRun(campaignPath, plan, state, repairRecord, "run", `repair:${created.repairId}`, options.executor ?? undefined);
      break;
    }
  }
  if (state.status !== "attention" && state.runs.length > 0 && state.runs.every((record) => record.status === "done")) {
    state.status = "completed";
    state.updatedAt = now;
    persistState(campaignPath, state);
    enqueueNotification(campaignPath, "campaign.completed", "campaign", "campaign completed", { runCount: state.runs.length });
    try {
      if (readCampaign(campaignPath).status === "active") closeCampaign(campaignPath, { at: now, eventId: stableId(`${plan.campaignId}:campaign.completed`) });
    } catch {
      // Campaign execution is authoritative; handoff rendering/closing is advisory.
    }
  } else if (state.status !== "attention" && state.status !== "completed") {
    state.status = "running";
    state.updatedAt = now;
    persistState(campaignPath, state);
  }
  try { await drainNotifications(campaignPath); } catch {}
  return campaignStatus(campaignPath);
}

/**
 * Campaign-level supervisor. A detached process calls this with the pinned
 * runner path and therefore never needs an interactive model session.
 *
 * @param {string} campaignPath
 * @param {{intervalMs?: number, once?: boolean, executor?: (request: JsonObject) => Promise<unknown>|unknown}} [options]
 * @returns {Promise<JsonObject>}
 */
export async function superviseCampaign(campaignPath, options = {}) {
  const lease = acquireLease(campaignPath, {
    fileName: CAMPAIGN_LEASE_FILE,
    contractVersion: CAMPAIGN_PLAN_VERSION,
  });
  lease.startHeartbeat();
  try {
    const plan = readCampaignPlan(campaignPath);
    const bootstrap = detachedBootstrap(campaignPath);
    if (bootstrap) writeBootstrap(campaignPath, bootstrap, "ready", null, lease);
    for (;;) {
      lease.assert();
      const status = await superviseCampaignOnce(campaignPath, options);
      if (TERMINAL_CAMPAIGN_STATES.has(String(status.status)) || options.once === true) return status;
      await delay(options.intervalMs ?? DEFAULT_INTERVAL_MS);
    }
  } catch (error) {
    const bootstrap = detachedBootstrap(campaignPath);
    if (bootstrap) writeBootstrap(campaignPath, bootstrap, "failed", errorMessage(error), null);
    throw error;
  } finally {
    lease.stopHeartbeat();
    lease.release();
  }
}

/** Campaign API alias used by callers that supervise a campaign run. */
export const superviseRun = superviseCampaign;

/** Campaign API alias; a dead controller is resumed by the next pass. */
/** @param {string} campaignPath @param {{executor?: (request: JsonObject) => Promise<unknown>|unknown, now?: string}} [options] */
export async function resumeRun(campaignPath, options = {}) {
  return superviseCampaignOnce(campaignPath, options);
}

/**
 * Generate a repair contract from immutable evidence and preauthorized policy.
 * It is safe to call repeatedly after a controller restart.
 *
 * @param {string} campaignPath
 * @param {CampaignPlan} plan
 * @param {CampaignControlState} state
 * @param {CampaignRun} failedRun
 * @param {JsonObject} failedNode
 * @param {JsonObject} observed
 * @returns {{repairId: string, repairKey: string, contractPath: string, contract: JsonObject}}
 */
export function createRepairContract(campaignPath, plan, state, failedRun, failedNode, observed = {}) {
  const repairKey = `${failedRun.id}:${String(failedNode.id ?? "unknown")}:${String(failedNode.attempt ?? 0)}:${stableId(canonicalJson(evidenceFor(failedRun, failedNode, observed)))}`;
  const existingId = state.repairs[repairKey];
  if (existingId) {
    const existing = state.runs.find((run) => run.id === existingId);
    if (existing) return { repairId: existing.id, repairKey, contractPath: existing.contractPath, contract: JSON.parse(readFileSync(existing.contractPath, "utf8")) };
  }
  const repairIndex = Object.keys(state.repairs).length;
  if (repairIndex >= plan.authority.repairLimit) throw new Error("repair limit exhausted");
  const sourceRecord = state.runs.find((run) => run.id === failedRun.id);
  if (!sourceRecord) throw new Error(`unknown failed run: ${failedRun.id}`);
  const sourcePath = resolve(sourceRecord.contractPath);
  const source = validateContract(JSON.parse(readFileSync(sourcePath, "utf8")), sourcePath);
  const allowed = plan.authority.runtimeFailover.allowedRuntimes;
  const runtimes = Object.fromEntries(allowed.map((id) => {
    if (!source.runtimes[id]) throw new Error(`repair runtime is not declared by source contract: ${id}`);
    return [id, source.runtimes[id]];
  }));
  const failedRuntime = failedNode.runtime && typeof failedNode.runtime === "object" ? String(/** @type {JsonObject} */ (failedNode.runtime).id ?? "") : String(failedNode.runtime ?? "");
  const workerRuntime = allowed.includes(failedRuntime)
    ? failedRuntime
    : allowed[0];
  const usagePolicy = boundedUsagePolicy(source.usagePolicy, plan.authority.maxInputTokens);
  const sourceNode = source.nodes.find((candidate) => candidate.id === failedNode.id);
  const repairInputTokens = Math.min(plan.authority.maxInputTokens, sourceNode?.maxInputTokens ?? plan.authority.maxInputTokens);
  const repairCostUsd = plan.authority.maxCostUsd === null
    ? sourceNode?.maxCostUsd ?? source.maxCostUsd
    : Math.min(plan.authority.maxCostUsd, sourceNode?.maxCostUsd ?? source.maxCostUsd ?? plan.authority.maxCostUsd);
  const repairId = `${plan.campaignId}-repair-${stableId(repairKey).slice(0, 20)}`;
  const evidence = boundedJson(evidenceFor(failedRun, failedNode, observed), MAX_EVIDENCE_BYTES);
  const taskPacket = {
    mode: "autonomous",
    objective: `Repair ${String(failedNode.id)} using the recorded run evidence`,
    instructions: [
      "Inspect the failed node evidence and make the smallest repair inside the declared write roots.",
      `Recorded evidence: ${JSON.stringify(evidence)}`,
      "Do not expand authority, run unlisted verification, merge, deploy, or perform irreversible actions.",
    ],
    readFiles: [],
    writeRoots: [...plan.authority.repairRoots],
    symbols: [],
    decisions: ["Repair authority is limited to the campaign plan."],
    nonGoals: ["authority expansion", "destructive or irreversible actions", "merge or deployment"],
    verification: plan.authority.allowedVerification.map((command) => ({ argv: [...command.argv] })),
  };
  const raw = /** @type {JsonObject} */ ({
    schemaVersion: 1,
    contractVersion: source.contractVersion,
    id: repairId,
    campaignId: plan.campaignId,
    goal: `${source.goal} · bounded repair ${String(failedNode.id)}`,
    cwd: source.cwd,
    usagePolicy,
    maxParallel: 1,
    pollIntervalMs: source.pollIntervalMs,
    stallTimeoutSec: source.stallTimeoutSec,
    timeoutSec: source.timeoutSec,
    maxInputTokens: repairInputTokens,
    maxCostUsd: repairCostUsd,
    runtimeDefaults: { worker: workerRuntime, judge: workerRuntime },
    runtimes,
    runtimeRules: [],
    nodes: [{
      id: `repair-${stableId(repairKey).slice(0, 16)}`,
      type: String(failedNode.type ?? "repair"),
      phase: "campaign-repair",
      runtime: workerRuntime,
      dependsOn: [],
      taskPacket,
      definitionOfDone: ["The recorded failure is repaired", "Only the preauthorized verification passes"],
      gate: { enabled: false },
      maxInputTokens: repairInputTokens,
      maxCostUsd: repairCostUsd,
    }],
    sourceIdentity: { kind: "contract", id: repairId, campaignId: plan.campaignId },
  });
  const contract = JSON.parse(JSON.stringify(raw));
  removeUndefined(contract);
  const contractPath = join(campaignPath, "contracts", `${repairId}.json`);
  mkdirSync(dirname(contractPath), { recursive: true });
  if (existsSync(contractPath)) {
    const existing = JSON.parse(readFileSync(contractPath, "utf8"));
    if (canonicalJson(existing) !== canonicalJson(contract)) throw new Error(`repair contract collision: ${repairId}`);
  } else {
    writeJsonAtomic(contractPath, contract);
  }
  // Validate before recording the action. This is the hard scope boundary.
  validateContract(contract, contractPath);
  return { repairId, repairKey, contractPath, contract };
}

/** @param {string} campaignPath @returns {JsonObject} */
export function campaignStatus(campaignPath) {
  const plan = readCampaignPlan(campaignPath);
  const state = loadOrCreateState(campaignPath, plan);
  const runs = state.runs.map((record) => ({ ...record, observed: inspectRun(campaignPath, record) }));
  return { schemaVersion: CAMPAIGN_SCHEMA_VERSION, campaignId: plan.campaignId, status: state.status, attention: state.attention, controller: plan.controller, runs, outbox: readNotificationOutbox(campaignPath).map((event) => ({ eventId: event.eventId, type: event.type, deliveredAt: event.deliveredAt ?? null, attempts: event.attempts })) };
}

/**
 * Deliver pending notification events. Delivery is at-least-once: an event
 * stays pending until the configured executable exits successfully.
 *
 * @param {string} campaignPath
 * @returns {Promise<{delivered: number, pending: number}>}
 */
export async function drainNotifications(campaignPath) {
  const outbox = readNotificationOutbox(campaignPath);
  const executable = process.env.PLAN_RUNNER_NOTIFY_BIN;
  if (!executable) return { delivered: 0, pending: outbox.filter((event) => !event.deliveredAt).length };
  let delivered = 0;
  for (const event of outbox) {
    if (event.deliveredAt) continue;
    event.attempts += 1;
    const result = await deliverNotification(executable, event);
    if (result.ok) {
      event.deliveredAt = new Date().toISOString();
      event.lastError = null;
      delivered += 1;
    } else {
      event.lastError = result.error;
    }
    writeOutbox(campaignPath, outbox);
  }
  return { delivered, pending: outbox.filter((event) => !event.deliveredAt).length };
}

/**
 * Detach a campaign supervisor using the pinned controller and wait for its
 * readiness record. This is intentionally separate from model/provider work.
 *
 * @param {string} campaignPath
 * @param {{intervalMs?: number}} [options]
 * @returns {Promise<{pid: number, campaignPath: string}>}
 */
export async function detachSelf(campaignPath, options = {}) {
  const plan = readCampaignPlan(campaignPath);
  const runnerPath = join(campaignPath, plan.controller.snapshotPath, "scripts", "runner.mjs");
  const cwd = resolve(campaignPath, "../../..");
  const campaignId = plan.campaignId;
  const nonce = randomUUID();
  const child = spawn(process.execPath, [runnerPath, "campaign", "supervise", campaignId, "--cwd", cwd, "--interval", String(options.intervalMs ?? DEFAULT_INTERVAL_MS)], {
    cwd,
    env: { ...process.env, PLAN_RUNNER_CAMPAIGN_BOOTSTRAP_NONCE: nonce },
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  child.unref();
  if (child.pid === undefined) throw new Error("detached campaign supervisor has no pid");
  await waitForBootstrap(campaignPath, nonce, child.pid);
  return { pid: child.pid, campaignPath };
}

/** @param {string} campaignPath @param {CampaignPlan} plan @returns {CampaignControlState} */
function loadOrCreateState(campaignPath, plan) {
  const path = join(campaignPath, CAMPAIGN_STATE_FILE);
  if (existsSync(path)) {
    const state = JSON.parse(readFileSync(path, "utf8"));
    validateState(state, plan.campaignId);
    return /** @type {CampaignControlState} */ (state);
  }
  const contractPath = join(campaignPath, plan.initialRunContract);
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const state = /** @type {CampaignControlState} */ ({
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: plan.campaignId,
    status: "configured",
    initialRunId: contract.id,
    runs: [{ id: contract.id, kind: "initial", contractPath, status: "planned" }],
    retries: {},
    repairs: {},
    actions: {},
    attention: null,
    updatedAt: new Date().toISOString(),
  });
  writeJsonAtomic(path, state);
  return state;
}

/** @param {unknown} value @param {string} campaignId */
function validateState(value, campaignId) {
  const state = objectValue(value, "campaign control state");
  requireExact(state, ["schemaVersion", "campaignId", "status", "initialRunId", "runs", "retries", "repairs", "actions", "attention", "updatedAt"], "campaign control state");
  if (state.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || state.campaignId !== campaignId) throw new TypeError("campaign control state identity is invalid");
  if (!["configured", "running", "attention", "completed"].includes(String(state.status))) throw new TypeError("campaign control state.status is invalid");
  requireId(state.initialRunId, "campaign control state.initialRunId");
  if (!Array.isArray(state.runs) || state.runs.length === 0) throw new TypeError("campaign control state.runs must not be empty");
  for (const [index, rawRun] of state.runs.entries()) {
    const run = objectValue(rawRun, `campaign control state.runs[${index}]`);
    requireExact(run, ["id", "kind", "contractPath", "status"], `campaign control state.runs[${index}]`);
    requireId(run.id, `campaign control state.runs[${index}].id`);
    if (run.kind !== "initial" && run.kind !== "repair") throw new TypeError("campaign control state run kind is invalid");
    requireText(run.contractPath, `campaign control state.runs[${index}].contractPath`);
    if (!["planned", "running", "done", "attention"].includes(String(run.status))) throw new TypeError("campaign control state run status is invalid");
  }
  if (!state.retries || typeof state.retries !== "object" || Array.isArray(state.retries)) throw new TypeError("campaign control state.retries must be an object");
  if (!state.repairs || typeof state.repairs !== "object" || Array.isArray(state.repairs)) throw new TypeError("campaign control state.repairs must be an object");
  if (!state.actions || typeof state.actions !== "object" || Array.isArray(state.actions)) throw new TypeError("campaign control state.actions must be an object");
  if (state.attention !== null && (!state.attention || typeof state.attention !== "object")) throw new TypeError("campaign control state.attention is invalid");
  requireText(state.updatedAt, "campaign control state.updatedAt");
}

/** @param {string} campaignPath @param {CampaignControlState} state */
function persistState(campaignPath, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(join(campaignPath, CAMPAIGN_STATE_FILE), state);
}

/**
 * @param {string} campaignPath
 * @param {CampaignPlan} plan
 * @param {CampaignControlState} state
 * @param {CampaignRun} record
 * @param {"run"|"resume"} command
 * @param {string} actionId
 * @param {((request: JsonObject) => Promise<unknown>|unknown)|undefined} executor
 * @param {string|null} [failoverTo]
 */
async function dispatchRun(campaignPath, plan, state, record, command, actionId, executor, failoverTo = null) {
  const existing = state.actions[actionId];
  if (existing?.status === "dispatched") return;
  state.actions[actionId] = { id: actionId, kind: command, status: "pending", runId: record.id };
  persistState(campaignPath, state);
  const runDir = inspectRun(campaignPath, record);
  if (runDir.controllerAlive) {
    state.actions[actionId].status = "dispatched";
    record.status = "running";
    persistState(campaignPath, state);
    return;
  }
  const request = {
    actionId,
    command,
    runId: record.id,
    contractPath: record.contractPath,
    runDir: runDir.runDir,
    runnerPath: join(campaignPath, plan.controller.snapshotPath, "scripts", "runner.mjs"),
    failoverTo,
  };
  try {
    if (executor) await executor(request);
    else await spawnPinnedRunner(request, campaignPath, plan);
    state.actions[actionId].status = "dispatched";
    record.status = "running";
    persistState(campaignPath, state);
  } catch (error) {
    state.actions[actionId].status = "failed";
    state.actions[actionId].error = errorMessage(error);
    record.status = "attention";
    setAttention(campaignPath, state, "controller_dispatch_failed", errorMessage(error));
  }
}

/** @param {JsonObject} request @param {string} campaignPath @param {CampaignPlan} plan */
async function spawnPinnedRunner(request, campaignPath, plan) {
  const runnerPath = String(request.runnerPath);
  const cwd = validateContract(JSON.parse(readFileSync(String(request.contractPath), "utf8")), String(request.contractPath)).cwd;
  const args = [runnerPath, String(request.command), String(request.command) === "run" ? String(request.contractPath) : String(request.runDir), "--detach"];
  await spawnAndWait(process.execPath, args, cwd);
  // The runner's own detached command performs a readiness handshake. Verify
  // that it left a durable run artifact before treating the action as sent.
  if (!existsSync(join(String(request.runDir), "contract.json"))) {
    throw new Error(`pinned runner did not create run state: ${request.runDir}`);
  }
  void campaignPath;
  void plan;
}

/** @param {string} campaignPath @param {CampaignRun} record @returns {JsonObject} */
function inspectRun(campaignPath, record) {
  const runDir = inferRunDir(record);
  if (!existsSync(runDir)) return { runDir, status: "pending", controllerAlive: false, allGreen: false, nodes: [] };
  let contract;
  try {
    const contractPath = join(runDir, "contract.json");
    contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  } catch (error) {
    return { runDir, invalid: `invalid run contract: ${errorMessage(error)}` };
  }
  const nodesPath = join(runDir, "nodes");
  if (!existsSync(nodesPath)) return { runDir, invalid: `run nodes directory missing: ${nodesPath}` };
  const nodes = [];
  for (const entry of readdirSync(nodesPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { nodes.push(JSON.parse(readFileSync(join(nodesPath, entry.name), "utf8"))); } catch (error) { return { runDir, invalid: `invalid node state: ${entry.name}: ${errorMessage(error)}` }; }
  }
  if (!nodes.length) return { runDir, invalid: `run has no node states: ${runDir}` };
  const lease = readLease(runDir);
  const controllerAlive = Boolean(lease && !lease.invalid && leaseHealthy(lease) && pidAlive(/** @type {unknown} */ (lease.pid)));
  const allGreen = nodes.every((node) => node.status === "done" || node.status === "no-op");
  const failedNode = nodes.find((node) => isFailureNode(node));
  const firstStatus = allGreen ? "done" : failedNode?.status ?? (controllerAlive ? "running" : "stalled");
  const error = failedNode?.error ?? (failedNode?.gate ? { code: "gate_failed", message: failedNode.gate.summary ?? "gate failed" } : null);
  const currentRuntime = failedNode?.runtime?.id ?? failedNode?.runtime ?? contract.runtimeDefaults.worker;
  const failoverHistory = failedNode?.routing?.history?.filter(/** @param {JsonObject} entry */ (entry) => entry.role === "worker").map(/** @param {JsonObject} entry */ (entry) => entry.runtime) ?? [];
  return { runDir, contractPath: join(runDir, "contract.json"), contract, nodes, failedNode, status: firstStatus, controllerAlive, allGreen, error, currentRuntime, failoverHistory };
}

/** @param {CampaignRun} record @returns {string} */
function inferRunDir(record) {
  try {
    const contractPath = resolve(record.contractPath);
    const raw = JSON.parse(readFileSync(contractPath, "utf8"));
    const contract = validateContract(raw, contractPath);
    return join(contract.cwd, ".runs", record.id);
  } catch {
    return join(dirname(dirname(resolve(record.contractPath))), record.id);
  }
}

/** @param {JsonObject|undefined} contract @param {unknown} current @param {string} next @returns {boolean} */
function runAllowsFailover(contract, current, next) {
  if (!contract || !Array.isArray(contract.runtimeRules)) return false;
  return contract.runtimeRules.some((rawRule) => {
    if (!rawRule || typeof rawRule !== "object") return false;
    const rule = /** @type {JsonObject} */ (rawRule);
    const match = rule.match && typeof rule.match === "object" ? /** @type {JsonObject} */ (rule.match) : {};
    return match.currentRuntime === current && rule.runtime === next;
  });
}

/** @param {string} campaignPath @param {CampaignControlState} state @param {string} code @param {string} message */
function setAttention(campaignPath, state, code, message) {
  state.status = "attention";
  state.attention = { code, message: boundedText(message, 2 * 1024) };
  persistState(campaignPath, state);
  enqueueNotification(campaignPath, "campaign.attention", `${code}:${message}`, message, { code });
}

/** @param {string} campaignPath @param {string} type @param {string} key @param {string} summary @param {JsonObject} [data] */
export function enqueueNotification(campaignPath, type, key, summary, data = {}) {
  const eventId = stableId(`${campaignPath}:${type}:${key}`);
  const outbox = readNotificationOutbox(campaignPath);
  if (outbox.some((event) => event.eventId === eventId)) return;
  const campaignId = (() => { try { return readCampaign(campaignPath).id; } catch { return basenameSafe(campaignPath); } })();
  const event = /** @type {NotificationEvent} */ ({
    eventId,
    type,
    campaignId,
    at: new Date().toISOString(),
    summary: boundedText(summary, 2 * 1024),
    data: boundedJson(data, 2 * 1024),
    deliveredAt: null,
    attempts: 0,
    lastError: null,
  });
  while (outbox.length >= MAX_OUTBOX_EVENTS) {
    const deliveredIndex = outbox.findIndex((candidate) => Boolean(candidate.deliveredAt));
    if (deliveredIndex < 0) return;
    outbox.splice(deliveredIndex, 1);
  }
  outbox.push(event);
  writeOutbox(campaignPath, outbox);
}

/** @param {string} campaignPath @returns {NotificationEvent[]} */
export function readNotificationOutbox(campaignPath) {
  const path = join(campaignPath, CAMPAIGN_OUTBOX_FILE);
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new TypeError("notification outbox must be an array");
  return /** @type {NotificationEvent[]} */ (value);
}

/** @param {string} campaignPath @param {NotificationEvent[]} outbox */
function writeOutbox(campaignPath, outbox) {
  const bounded = outbox.slice(-MAX_OUTBOX_EVENTS).filter((event) => Buffer.byteLength(JSON.stringify(event), "utf8") <= MAX_EVENT_BYTES);
  writeJsonAtomic(join(campaignPath, CAMPAIGN_OUTBOX_FILE), bounded);
}

/** @param {string} executable @param {NotificationEvent} event @returns {Promise<{ok: boolean, error?: string}>} */
function deliverNotification(executable, event) {
  return new Promise((resolveDelivery) => {
    let child;
    try {
      child = spawn(executable, [], { stdio: ["pipe", "ignore", "pipe"], env: process.env });
    } catch (error) {
      resolveDelivery({ ok: false, error: errorMessage(error) });
      return;
    }
    let settled = false;
    /** @param {{ok: boolean, error?: string}} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveDelivery(result);
    };
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = boundedText(`${stderr}${chunk}`, 1024); });
    child.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
    child.once("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr || `notification exited ${code}` }));
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ ok: false, error: "notification timed out after 5s" });
    }, 5_000);
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

/** @param {string} campaignPath @param {string} nonce @param {number} pid */
async function waitForBootstrap(campaignPath, nonce, pid) {
  const path = join(campaignPath, `${CAMPAIGN_BOOTSTRAP_FILE}.${nonce}.json`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const record = /** @type {JsonObject} */ (readJson(path));
      if (record.status === "ready" && record.pid === pid) return;
      throw new Error(`detached campaign supervisor failed: ${record.error ?? "unknown error"}`);
    }
    if (!pidAlive(pid)) throw new Error(`detached campaign supervisor exited before readiness: ${pid}`);
    await delay(50);
  }
  throw new Error(`detached campaign supervisor did not become ready: ${pid}`);
}

/** @param {string} campaignPath @returns {string|null} */
function detachedBootstrap(campaignPath) {
  const nonce = process.env.PLAN_RUNNER_CAMPAIGN_BOOTSTRAP_NONCE;
  return nonce ? join(campaignPath, `${CAMPAIGN_BOOTSTRAP_FILE}.${nonce}.json`) : null;
}

/** @param {string} campaignPath @param {string} bootstrapPath @param {"ready"|"failed"} status @param {string|null} error @param {object|null} lease */
function writeBootstrap(campaignPath, bootstrapPath, status, error, lease) {
  const record = {
    status,
    pid: process.pid,
    nonce: process.env.PLAN_RUNNER_CAMPAIGN_BOOTSTRAP_NONCE,
    holderId: lease && "holderId" in lease ? lease.holderId : null,
    generation: lease && "generation" in lease ? lease.generation : null,
    error,
    at: new Date().toISOString(),
  };
  writeJsonAtomic(bootstrapPath, record);
  void campaignPath;
}

/** @param {string} executable @param {string[]} args @param {string} cwd @returns {Promise<void>} */
function spawnAndWait(executable, args, cwd) {
  return new Promise((resolveChild, rejectChild) => {
    let child;
    try { child = spawn(executable, args, { cwd, stdio: "ignore" }); } catch (error) { rejectChild(error); return; }
    child.once("error", rejectChild);
    child.once("close", (code, signal) => {
      if (code === 0) resolveChild();
      else rejectChild(new Error(`pinned runner exited ${code ?? `signal ${signal}`}`));
    });
  });
}

/** @param {string} campaignPath @param {CampaignPlan} plan */
function verifyControllerSnapshot(campaignPath, plan) {
  const path = resolve(campaignPath, plan.controller.snapshotPath);
  if (!existsSync(path)) throw new Error(`controller snapshot missing: ${path}`);
  if (hashTree(path) !== plan.controller.contentHash) throw new Error(`controller snapshot changed: ${path}`);
}

/** @param {string} source @param {string} destination */
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`controller snapshot refuses symbolic link: ${from}`);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`unsupported controller snapshot entry: ${from}`);
  }
}

/** @param {string} root */
function makeReadOnly(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) makeReadOnly(path);
    chmodSync(path, entry.isDirectory() ? 0o555 : 0o444);
  }
  chmodSync(root, 0o555);
}

/** @param {string} root @returns {string} */
function hashTree(root) {
  const hash = createHash("sha256");
  /** @type {string[]} */
  const files = [];
  collectFiles(root, "", files);
  for (const relativePath of files.sort()) {
    if (relativePath === "snapshot.json") continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(join(root, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** @param {string} root @param {string} prefix @param {string[]} files */
function collectFiles(root, prefix, files) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`controller snapshot refuses symbolic link: ${join(root, relativePath)}`);
    if (entry.isDirectory()) collectFiles(root, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

/** @param {string} path */
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

/** @param {JsonObject} source @param {JsonObject} durable @param {string} sourcePath @param {string} contractPath */
function copyTaskPacketFiles(source, durable, sourcePath, contractPath) {
  if (!Array.isArray(source.nodes) || !Array.isArray(durable.nodes)) return;
  const sourceDir = dirname(sourcePath);
  for (let index = 0; index < source.nodes.length; index += 1) {
    const sourceNode = source.nodes[index];
    const durableNode = durable.nodes[index];
    if (!sourceNode || typeof sourceNode !== "object" || !durableNode || typeof durableNode !== "object") continue;
    const taskPacketFile = /** @type {JsonObject} */ (sourceNode).taskPacketFile;
    if (typeof taskPacketFile !== "string") continue;
    const packetSource = resolve(sourceDir, taskPacketFile);
    const packetRelative = join("packets", `${String(index)}-${basename(taskPacketFile)}`);
    const packetDestination = join(dirname(contractPath), packetRelative);
    mkdirSync(dirname(packetDestination), { recursive: true });
    copyFileSync(packetSource, packetDestination);
    /** @type {JsonObject} */ (durableNode).taskPacketFile = packetRelative;
  }
}

/** @param {unknown} source @param {JsonObject} defaults */
function normalizeAuthority(source, defaults) {
  const authority = source && typeof source === "object" ? /** @type {JsonObject} */ (source) : {};
  const usagePolicy = defaults.usagePolicy;
  const defaultInput = usagePolicy === false ? 1_000_000 : Number(/** @type {JsonObject} */ (usagePolicy).maxInputTokens);
  return {
    repairRoots: stringArray(authority.repairRoots ?? ["skills/mine/intent-factory"], "authority.repairRoots", true),
    allowedVerification: validateAllowedVerification(authority.allowedVerification ?? [{ argv: ["node", "--test", "skills/mine/intent-factory/test/campaign-autonomy.test.mjs"] }]),
    retryLimit: boundedInteger(authority.retryLimit ?? 1, "authority.retryLimit", 100),
    repairLimit: boundedInteger(authority.repairLimit ?? 1, "authority.repairLimit", 100),
    runtimeFailover: {
      allowedRuntimes: stringArray(/** @type {JsonObject} */ (authority.runtimeFailover ?? {}).allowedRuntimes ?? ["luna", "sol"], "authority.runtimeFailover.allowedRuntimes", true),
      routes: Array.isArray(/** @type {JsonObject} */ (authority.runtimeFailover ?? {}).routes) ? /** @type {unknown[]} */ (/** @type {JsonObject} */ (authority.runtimeFailover ?? {}).routes) : [],
    },
    maxInputTokens: positiveInteger(authority.maxInputTokens ?? defaultInput, "authority.maxInputTokens"),
    maxCostUsd: authority.maxCostUsd === undefined ? null : nonNegativeNumber(authority.maxCostUsd, "authority.maxCostUsd"),
    irreversibleActionsForbidden: true,
  };
}

/** @param {unknown} value @returns {AllowedVerification[]} */
function validateAllowedVerification(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("campaign plan.authority.allowedVerification must be a non-empty array");
  return value.map((raw, index) => {
    const command = objectValue(raw, `campaign plan.authority.allowedVerification[${index}]`);
    requireExact(command, ["argv"], `campaign plan.authority.allowedVerification[${index}]`);
    return { argv: stringArray(command.argv, `campaign plan.authority.allowedVerification[${index}].argv`, true) };
  });
}

/** @param {unknown} value @param {string} label @returns {JsonObject} */
function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return /** @type {JsonObject} */ (value);
}

/** @param {JsonObject} value @param {string[]} allowed @param {string} label */
function requireExact(value, allowed, label) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
}

/** @param {unknown} value @param {string} label */
function requireText(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); }
/** @param {unknown} value @param {string} label */
function requireId(value, label) { requireText(value, label); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(value))) throw new TypeError(`${label} is invalid`); }
/** @param {unknown} value @param {string} label */
function requireRelative(value, label) { requireText(value, label); if (isAbsolute(String(value)) || String(value).split(/[\\/]+/u).includes("..")) throw new TypeError(`${label} must be a relative non-parent path`); }
/** @param {unknown} value @param {string} label @param {boolean} nonEmpty @returns {string[]} */
function stringArray(value, label, nonEmpty = false) { if (!Array.isArray(value) || (nonEmpty && !value.length) || value.some((item) => typeof item !== "string" || !item.trim())) throw new TypeError(`${label} must be ${nonEmpty ? "a non-empty " : "an "}array of strings`); return [.../** @type {string[]} */ (value)]; }
/** @param {unknown} value @param {string} label @param {number} max @returns {number} */
function boundedInteger(value, label, max) { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new TypeError(`${label} must be an integer from 0 to ${max}`); return value; }
/** @param {unknown} value @param {string} label @returns {number} */
function positiveInteger(value, label) { if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`); return value; }
/** @param {unknown} value @param {string} label @returns {number} */
function nonNegativeNumber(value, label) { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number`); return value; }
/** @param {unknown} value @param {number} max @returns {unknown} */
function boundedJson(value, max) { const text = JSON.stringify(value); if (Buffer.byteLength(text, "utf8") <= max) return value; return { truncated: true, summary: boundedText(text, max - 32) }; }
/** @param {unknown} value @param {number} max @returns {string} */
function boundedText(value, max) { const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " "); return Buffer.byteLength(text, "utf8") <= max ? text : `${Buffer.from(text, "utf8").subarray(0, max - 1).toString("utf8")}…`; }
/** @param {unknown} value @returns {string} */
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {JsonObject} */ (value)[key])}`).join(",")}}`; return JSON.stringify(value); }
/** @param {string} value @returns {string} */
function stableId(value) { return createHash("sha256").update(value).digest("hex"); }
/** @param {unknown} value */
function removeUndefined(value) { if (!value || typeof value !== "object") return; if (Array.isArray(value)) { for (const item of value) removeUndefined(item); return; } for (const [key, child] of Object.entries(/** @type {JsonObject} */ (value))) { if (child === undefined) delete /** @type {JsonObject} */ (value)[key]; else removeUndefined(child); } }
/** @param {CampaignRun} run @param {JsonObject} node @param {JsonObject} observed @returns {JsonObject} */
function evidenceFor(run, node, observed) { const scope = node.scope && typeof node.scope === "object" ? /** @type {JsonObject} */ (node.scope) : {}; return /** @type {JsonObject} */ ({ runId: run.id, nodeId: node.id ?? null, status: node.status ?? null, attempt: node.attempt ?? 0, error: node.error ?? null, gate: node.gate ?? null, verification: node.verification ?? null, result: node.result ?? null, unexpectedPaths: scope.unexpectedPaths ?? [], currentRuntime: observed.currentRuntime ?? null }); }
/** @param {string} value @returns {string} */
function basenameSafe(value) { return value.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "campaign"; }
/** @param {unknown} value @returns {boolean} */
function pidAlive(value) { const pid = Number(value); if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM"; } }
/** @param {unknown} node @returns {boolean} */
function isFailureNode(node) { if (!node || typeof node !== "object") return false; const record = /** @type {JsonObject} */ (node); const result = record.result && typeof record.result === "object" ? /** @type {JsonObject} */ (record.result) : {}; return ["blocked", "failed", "exhausted", "stalled"].includes(String(record.status)) || result.status === "blocked_context"; }
/** @param {string} status @param {string} code @returns {boolean} */
function isTimeoutOrStall(status, code) { return status === "stalled" || ["timeout", "timed_out", "progress_stalled", "stall", "wall_clock_timeout"].some((item) => code.includes(item)); }
/** @param {string} status @param {string} code @returns {boolean} */
function isProviderExhaustion(status, code) { return ["provider_exhausted", "rate_limit", "quota_exhausted", "usage_limit"].some((item) => code.includes(item)) || (status === "exhausted" && code.includes("provider")); }
/** @param {string} code @param {string} status @returns {boolean} */
function isBudget(code, status) { return ["budget", "cost_budget", "token_budget", "budget_exceeded"].some((item) => code.includes(item)) || status === "budget"; }
/** @param {string} code @param {string} status @returns {boolean} */
function isForbiddenAuthority(code, status) { return ["authority", "scope", "expansion", "unauthorized", "destructive", "irreversible", "permission"].some((item) => code.includes(item)) || status === "canceled"; }
/** @param {string} code @param {string} status @returns {boolean} */
function isInvalid(code, status) { return ["invalid", "malformed", "corrupt"].some((item) => code.includes(item)) || status === "invalid"; }
/** @param {string} code @param {string} status @param {JsonObject} run @returns {boolean} */
function isRepairable(code, status, run) { const failedNode = run.failedNode && typeof run.failedNode === "object" ? /** @type {JsonObject} */ (run.failedNode) : {}; const result = failedNode.result && typeof failedNode.result === "object" ? /** @type {JsonObject} */ (failedNode.result) : {}; return code.includes("verification") || code.includes("gate") || code.includes("blocked_context") || code.includes("context_missing") || result.status === "blocked_context" || (status === "blocked" && !isBudget(code, status)); }
/** @param {unknown} policy @param {number} maxInputTokens */
function boundedUsagePolicy(policy, maxInputTokens) { if (policy === false) return { epoch: "campaign-repair", maxInputTokens, judgeReserveInputTokens: 0, maxPhaseInputTokens: maxInputTokens, maxInvocationTokens: maxInputTokens, cacheReadWeight: 0 }; const value = /** @type {JsonObject} */ (policy); const maximum = Math.min(maxInputTokens, Number(value.maxInputTokens)); return { epoch: String(value.epoch), maxInputTokens: maximum, judgeReserveInputTokens: Math.min(Number(value.judgeReserveInputTokens), maximum), maxPhaseInputTokens: Math.min(Number(value.maxPhaseInputTokens), maximum), maxInvocationTokens: Math.min(Number(value.maxInvocationTokens), maximum), cacheReadWeight: Number(value.cacheReadWeight) }; }
/** @param {unknown} error @returns {string} */
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
/** @param {number} milliseconds @returns {Promise<void>} */
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
