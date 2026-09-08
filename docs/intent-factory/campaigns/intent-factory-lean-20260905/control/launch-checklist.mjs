#!/usr/bin/env node
/**
 * Pre-launch checklist for a campaign phase contract.
 *
 * Every check here exists because the campaign already paid for the defect it
 * catches. `validate` proves a contract is well formed and `preflight` proves
 * the providers answer; neither knows that inheriting the autonomous
 * progressPolicy default killed take 1, or that an empty runtimeRules array
 * re-enables failover synthesis. This is a control-plane artifact, not product
 * code: checks 3 and 4 become runner validation when phase 1 ships
 * `runtimes[].fallback`, and this file loses them then.
 *
 * usage: launch-checklist.mjs <contract.json> [--runner <runner.mjs>]
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const contractPath = process.argv[2];
if (!contractPath) { console.error("usage: launch-checklist.mjs <contract.json>"); process.exit(2); }
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const repo = contract.cwd ?? process.cwd();

/** @type {{level: "fail"|"warn", text: string}[]} */
const problems = [];
const fail = (text) => problems.push({ level: "fail", text });
const warn = (text) => problems.push({ level: "warn", text });

/** Vendor identity: the driver, unless the runtime configures another provider. */
function vendorOf(runtime) {
  const provider = runtime.config?.model_provider ?? runtime.config?.["model_provider"];
  if (typeof provider === "string") return `provider:${provider}`;
  switch (runtime.driver) {
    case "claude": return "anthropic";
    case "codex": return "openai";
    case "glm": return "zai";
    case "agy": return "google";
    case "replay": case "exec-jsonl": return runtime.vendor ? `declared:${runtime.vendor}` : null;
    default: return null;
  }
}

// 1. The file-progress watchdog must not be able to fire inside the work window.
//    An autonomous packet with no progressPolicy inherits {300, 120, 3}, which
//    killed take 1 of phase 0 while the worker was reading code.
for (const node of (contract.schemaVersion >= 3 ? [] : contract.nodes ?? [])) { // schema 3 deleted progressPolicy with the watchdog
  const policy = node.progressPolicy;
  if (!policy) { fail(`${node.id}: no progressPolicy; an autonomous packet inherits 300/120/3 and dies while the worker reads code`); continue; }
  const timeout = node.timeoutSec ?? contract.timeoutSec;
  if (policy.graceSec < timeout) {
    fail(`${node.id}: progressPolicy.graceSec ${policy.graceSec} is under the node timeout ${timeout}; the watchdog can kill healthy work`);
  }
}

// 2. Provider silence is not a dead worker. glm-5.3-flash went quiet for 971 s
//    on a long context while healthy; 900 s killed it twice.
if ((contract.stallTimeoutSec ?? 0) < 2400) {
  fail(`stallTimeoutSec ${contract.stallTimeoutSec} is under 2400; a long-context provider request in flight reads as a stall`);
}

// 3. An empty rule set re-enables failover synthesis over every declared runtime.
if (Object.hasOwn(contract, "runtimeRules") && (!Array.isArray(contract.runtimeRules) || contract.runtimeRules.length === 0)) {
  fail("runtimeRules is empty, which enables failover synthesis across every declared runtime; declare it to suppress synthesis");
}

// 4. A judge must never share the vendor of the worker it judges, on the
//    primary pair or on any hop the contract makes reachable for that role.
const runtimes = contract.runtimes ?? {};
const hops = (role, from) => Array.isArray(contract.runtimeRules)
  ? contract.runtimeRules
    .filter((r) => r.match?.currentRuntime === from && (!r.match?.role || r.match.role === role))
    .map((r) => r.runtime)
  : (contract.runtimes?.[from]?.fallback ? [contract.runtimes[from].fallback] : []);
for (const node of contract.nodes ?? []) {
  const workerId = node.runtime ?? contract.runtimeDefaults?.worker;
  const judgeId = node.gate?.runtime ?? contract.runtimeDefaults?.judge;
  if (!node.gate || node.gate.enabled === false) continue;
  const workerIds = [workerId, ...hops("worker", workerId)];
  const judgeIds = [judgeId, ...hops("judge", judgeId)];
  for (const w of workerIds) {
    for (const j of judgeIds) {
      const wv = vendorOf(runtimes[w] ?? {});
      const jv = vendorOf(runtimes[j] ?? {});
      if (!wv) { fail(`${node.id}: worker runtime ${w} has no resolvable vendor`); continue; }
      if (!jv) { fail(`${node.id}: judge runtime ${j} has no resolvable vendor`); continue; }
      if (wv === jv) fail(`${node.id}: reachable pair worker ${w} / judge ${j} share vendor ${wv}`);
    }
  }
}

// 5. A command proof the worker was never told to run is a revision spent on a
//    typecheck error. Phase 1 attempt 1 died exactly there.
for (const node of contract.nodes ?? []) {
  const proofs = (node.definitionOfDone ?? []).filter((d) => d.proof?.kind === "command").map((d) => d.proof.ref);
  if (!proofs.length) continue;
  const instructions = (node.taskPacket?.instructions ?? []).join("\n");
  const missing = proofs.filter((ref) => !instructions.includes(ref));
  if (missing.length) {
    fail(`${node.id}: command proofs ${missing.join(", ")} are gated but no instruction tells the worker to run them before finishing`);
  }
}

// 6. A packet that points at a file which no longer exists burns an attempt.
for (const node of contract.nodes ?? []) {
  for (const file of node.taskPacket?.readFiles ?? []) {
    if (!existsSync(join(repo, file))) fail(`${node.id}: readFiles entry ${file} does not exist`);
  }
  for (const command of node.taskPacket?.verification ?? []) {
    for (const arg of command.argv ?? []) {
      if (arg.includes("*")) continue; // node --test expands glob patterns itself
      if (arg.endsWith(".mjs") && !existsSync(join(repo, arg))) fail(`${node.id}: verification target ${arg} does not exist`);
    }
  }
}

// 7. Control artifacts are the campaign's own state; a worker must never write them.
for (const node of contract.nodes ?? []) {
  for (const root of node.taskPacket?.writeRoots ?? []) {
    const resolved = resolve(repo, root);
    if (resolved === repo || root.startsWith(".runs")) fail(`${node.id}: writeRoots entry ${root} exposes campaign control artifacts`);
  }
}

// 8. A phase must not launch against an exhausted provider. Phase 1 was authored
//    with glm declared while the Z.ai allowance was spent, and phase 1 itself died
//    of a budget ceiling. Require a fresh, green preflight next to the contract
//    rather than duplicating the live probe here.
const preflightPath = contractPath.replace(/\.contract\.json$/u, "").replace(/.*\//u, "");
const preflightFile = contractPath.replace(/[^/]+$/u, `preflight-${preflightPath.replace(/^phase-/u, "p")}.json`);
if (!existsSync(preflightFile)) {
  warn(`no preflight next to the contract (${preflightFile}); run preflight --json before launching`);
} else {
  const pf = JSON.parse(readFileSync(preflightFile, "utf8"));
  if (!pf.ok) fail(`preflight ${preflightFile} is not green; a declared runtime is unavailable or exhausted`);
  const ageMin = (Date.now() - statSync(preflightFile).mtimeMs) / 60000;
  if (Number.isFinite(ageMin) && ageMin > 120) warn(`preflight is ${Math.round(ageMin)} min old; an allowance can be spent since`);
}

const fails = problems.filter((p) => p.level === "fail");
for (const p of problems) console.log(`${p.level === "fail" ? "FAIL" : "warn"} ${p.text}`);
if (!problems.length) console.log(`checklist ok · ${(contract.nodes ?? []).length} nodes`);
process.exit(fails.length ? 1 : 0);
