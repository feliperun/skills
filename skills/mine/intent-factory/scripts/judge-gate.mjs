/**
 * Conditional judge gate for schema-2 Definition of Done items.
 *
 * Deterministic items carry a mechanical `proof` (a verification command, a
 * workspace path, or a `verification` entry reused by reference) and gate
 * first: the controller settles them and no judge invocation is spent until
 * they pass. The judge arbitrates only `judgment` items, and a gate-failing
 * rejection whose findings cite no judgment item id is a judge protocol
 * failure — one bounded re-ask, then blocked attention — that never consumes a
 * worker revision.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { reviewMode, UNCITED_REJECTION_REASON } from "./review-modes.mjs";

/** @typedef {import("./definition-of-done.mjs").DefinitionOfDoneItem} DefinitionOfDoneItem */
/** @typedef {import("./definition-of-done.mjs").DefinitionOfDoneProof} DefinitionOfDoneProof */
/** @typedef {import("./contract.mjs").ExecutionOverride} ExecutionOverride */
/** @typedef {import("./contract.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./contract.mjs").VerificationState} VerificationState */

const MAX_PROOF_OUTPUT_BYTES = 4 * 1024;

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedText(value, maxBytes = MAX_PROOF_OUTPUT_BYTES) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // The marker costs 3 bytes in UTF-8 and a byte-aligned cut can land inside a
  // multibyte character, whose replacement costs 3 more. Reserve the marker and
  // then shrink until the encoded result actually fits: a finding that exceeds
  // the validator's evidence ceiling is not truncated downstream, it throws, and
  // the throw kills the controller mid-gate.
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return "";
  let room = maxBytes - markerBytes;
  let out = `${bytes.subarray(0, room).toString("utf8")}${marker}`;
  while (room > 0 && Buffer.byteLength(out, "utf8") > maxBytes) {
    room -= 1;
    out = `${bytes.subarray(0, room).toString("utf8")}${marker}`;
  }
  return out;
}

/** @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node @returns {DefinitionOfDoneItem[]} */
function mechanicalItems(node) {
  return (node.definitionOfDone ?? []).filter((item) => item.proof !== undefined);
}

/** @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node @returns {DefinitionOfDoneItem[]} */
export function judgmentItems(node) {
  return (node.definitionOfDone ?? []).filter((item) => item.judgment === true);
}

/** A gated node runs the judge only when its review mode is not `none` and a Definition of Done item carries judgment:true; an empty, purely deterministic, or review-free checklist settles mechanically without spending a judge invocation. @param {{definitionOfDone?: DefinitionOfDoneItem[], gate?: {enabled?: boolean, review?: unknown}}} node @returns {boolean} */
export function judgeRequired(node) {
  return reviewMode(node.gate) !== "none"
    && (node.definitionOfDone ?? []).some((item) => item.judgment === true);
}

/**
 * @param {DefinitionOfDoneItem[]} items
 * @param {string} cwd
 * @param {{timeoutMs?: number, verification?: VerificationState|null}} [options]
 * @returns {Promise<Array<{id: string, kind: "command"|"path"|"verification", ref: string, pass: boolean, detail: string}>>}
 */
async function runMechanicalProofs(items, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const recorded = options.verification?.commands ?? [];
  const results = [];
  for (const item of items) {
    const proof = item.proof;
    if (proof === undefined) continue;
    results.push(proof.kind === "path"
      ? await provePath(item.id, proof, cwd)
      : proof.kind === "verification"
        ? proveVerification(item.id, proof, recorded)
        : await proveCommand(item.id, proof, cwd, timeoutMs));
  }
  return results;
}

/**
 * Reuse the recorded result of one controller verification entry: pass or fail
 * and its bounded output, with nothing executed. The reference is positional,
 * so the entry this attempt recorded is exactly the entry the packet named.
 *
 * @param {string} id
 * @param {DefinitionOfDoneProof} proof
 * @param {Array<{argv: string[], passed: boolean, attempts?: Array<{exitCode?: number|null, stdout?: string, stderr?: string}>}>} recorded
 * @returns {{id: string, kind: "verification", ref: string, pass: boolean, detail: string}}
 */
function proveVerification(id, proof, recorded) {
  const index = Number.parseInt(proof.ref, 10);
  const entry = Number.isInteger(index) ? recorded[index] : undefined;
  if (!entry) {
    return { id, kind: "verification", ref: proof.ref, pass: false, detail: `verification command ${proof.ref} has no recorded result for this attempt` };
  }
  const attempt = entry.attempts?.at(-1);
  const output = [attempt?.stderr, attempt?.stdout].find((text) => typeof text === "string" && text.trim()) ?? "";
  const detail = entry.passed
    ? `reused recorded verification result: ${entry.argv.join(" ")} passed`
    : boundedText(`reused recorded verification result: ${entry.argv.join(" ")} failed: ${output.trim()}`);
  return { id, kind: "verification", ref: proof.ref, pass: entry.passed === true, detail };
}

/**
 * @param {string} id
 * @param {DefinitionOfDoneProof} proof
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<{id: string, kind: "command"|"path", ref: string, pass: boolean, detail: string}>}
 */
async function proveCommand(id, proof, cwd, timeoutMs) {
  const ref = proof.ref;
  return new Promise((settle) => {
    const child = spawn(ref, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_PROOF_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_PROOF_OUTPUT_BYTES) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ id, kind: "command", ref, pass: false, detail: boundedText(error.message) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const detail = timedOut
        ? `timed out after ${timeoutMs}ms`
        : signal !== null ? `killed by ${signal}` : `exit ${code ?? "?"}`;
      const pass = !timedOut && code === 0 && signal === null;
      settle({ id, kind: "command", ref, pass, detail: pass ? detail : boundedText(`${detail}: ${(stderr || stdout).trim()}`) });
    });
  });
}

/**
 * @param {string} id
 * @param {DefinitionOfDoneProof} proof
 * @param {string} cwd
 * @returns {Promise<{id: string, kind: "command"|"path", ref: string, pass: boolean, detail: string}>}
 */
async function provePath(id, proof, cwd) {
  const ref = proof.ref;
  try {
    const target = isAbsolute(ref) ? ref : resolve(cwd, ref);
    const info = await stat(target);
    return { id, kind: "path", ref, pass: true, detail: `${info.isDirectory() ? "directory" : "file"} exists` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, kind: "path", ref, pass: false, detail: boundedText(message) };
  }
}

/**
 * Verdict a deterministic gate from its per-item mechanical results: pass only
 * when every proof passed.
 *
 * @param {Array<{id: string, kind: "command"|"path"|"verification", ref: string, pass: boolean, detail: string}>} results
 * @returns {import("./lib.mjs").JudgeVerdict}
 */
export function mechanicalVerdict(results) {
  const failed = results.filter((result) => !result.pass);
  if (!failed.length) {
    return {
      verdict: "pass",
      maxSeverity: "none",
      summary: "every deterministic Definition of Done item passed",
      findings: [],
    };
  }
  return {
    verdict: "fail",
    maxSeverity: "critical",
    summary: "deterministic Definition of Done item failed",
    findings: failed.map((result) => ({
      severity: "critical",
      description: `Definition of Done item [${result.id}] failed its ${result.kind} proof`,
      evidence: boundedText(`${result.ref}: ${result.detail}`),
    })),
  };
}

/**
 * The deterministic evidence a judge protocol re-ask must reuse: the round's
 * mechanical proofs already passed before the first ask, so the re-ask prompt
 * reports every deterministic item as proven without re-running any proof.
 *
 * @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node
 * @returns {Array<{id: string, kind: "command"|"path"|"verification", ref: string, pass: boolean, detail: string}>}
 */
function provenDeterministicResults(node) {
  return mechanicalItems(node).map((item) => {
    const proof = /** @type {DefinitionOfDoneProof} */ (item.proof);
    return { id: item.id, kind: proof.kind, ref: proof.ref, pass: true, detail: "" };
  });
}

/**
 * Deterministic evidence of one gate round plus its mechanical verdict. The
 * first ask settles every mechanical proof (a command proof executes; a
 * verification proof reuses its recorded result); a judge protocol re-ask
 * reuses the round's proven items and never re-runs a proof, so a flaky second
 * execution cannot consume a worker revision on the protocol failure path.
 *
 * @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node
 * @param {string} cwd
 * @param {boolean} reask
 * @param {number} timeoutMs
 * @param {VerificationState|null} [verification] this attempt's recorded verification results
 * @returns {Promise<{verdict: import("./lib.mjs").JudgeVerdict, results: Array<{id: string, pass: boolean, detail: string}>}>}
 */
export async function deterministicGate(node, cwd, reask, timeoutMs, verification = null) {
  const results = reask
    ? provenDeterministicResults(node)
    : await runMechanicalProofs(mechanicalItems(node), cwd, { timeoutMs, verification });
  return { verdict: mechanicalVerdict(results), results };
}

/**
 * The deterministic controller-verification failure verdict, kept next to the
 * Definition of Done gate so every deterministic failure settles identically.
 *
 * @param {{verification?: {commands?: Array<{argv: string[], passed?: boolean, attempts?: Array<{exitCode?: number|null, timedOut?: boolean}>}>, error?: unknown}|null}} state
 * @returns {import("./lib.mjs").JudgeVerdict}
 */
export function verificationFailureVerdict(state) {
  const failedCommands = (state.verification?.commands ?? []).filter((command) => !command.passed);
  const evidence = failedCommands.length
    ? failedCommands.map((command) => `${command.argv.join(" ")}: ${(command.attempts ?? []).map((attempt) => `exit=${attempt.exitCode ?? "-"}${attempt.timedOut ? " timeout" : ""}`).join(", ")}`).join("; ")
    : state.verification?.error ?? "verification controller failed to execute a command";
  return {
    verdict: "fail",
    maxSeverity: "critical",
    summary: "deterministic verification failed",
    findings: [{ severity: "critical", description: "deterministic verification failed", evidence: boundedText(evidence) }],
  };
}

/**
 * The commands the integration candidate failed that the attempt had passed.
 *
 * A non-empty list means the two worktrees disagree about the environment
 * rather than about the work: the same commit ran the same command twice with
 * different outcomes. Without naming that, the failure reads as a defect in
 * the node's own changes — which is how a missing `node_modules` link in the
 * candidate once cost a campaign four attempts on already-correct work.
 * Commands are matched by position, never by comparing joined argv, since a
 * joined argv loses argument boundaries.
 *
 * @param {unknown} attempt the attempt's recorded verification
 * @param {unknown} candidate the candidate's recorded verification
 * @returns {string[]}
 */
export function candidateOnlyFailures(attempt, candidate) {
  const attemptCommands = verificationCommands(attempt);
  return verificationCommands(candidate)
    .map((command, index) => ({ command, counterpart: attemptCommands[index] }))
    .filter((pair) => pair.command.passed === false && pair.counterpart?.passed === true)
    .map((pair) => (pair.command.argv ?? []).join(" "));
}

/** @param {unknown} evidence @returns {Array<{argv?: string[], passed?: boolean}>} */
function verificationCommands(evidence) {
  const commands = /** @type {{commands?: unknown}} */ (evidence ?? {}).commands;
  return Array.isArray(commands) ? commands : [];
}

/**
 * A gate-failing judge verdict on a node with judgment items is a protocol
 * failure when none of its findings cites any judgment item id.
 *
 * @param {{verdict: string, findings: Array<{description: string, evidence: string}>}} verdict
 * @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node
 * @returns {boolean}
 */
export function uncitedRejection(verdict, node) {
  const items = judgmentItems(node);
  if (verdict.verdict !== "fail" || items.length === 0) return false;
  const ids = new Set(items.map((item) => item.id));
  return !verdict.findings.some((finding) => citesItem(finding.description, ids) || citesItem(finding.evidence, ids));
}

/** @param {string} text @param {Set<string>} ids @returns {boolean} */
function citesItem(text, ids) {
  return text.split(/[^A-Za-z0-9._-]+/u).some((token) => ids.has(token));
}

/**
 * The execution-override kind that records a spent judge protocol re-ask. The
 * snapshot validator takes any override kind; only the kinds the recovery path
 * interprets are named in the contract's typedef, so this one is read and
 * written through the same record cast the recovery scan uses.
 */
const JUDGE_REASK_KIND = "judge-reask";

/** @param {ExecutionOverride} override @returns {boolean} */
function isJudgeReask(override) {
  return /** @type {Record<string, unknown>} */ (override).kind === JUDGE_REASK_KIND;
}

/** @param {NodeSnapshot} state @returns {Record<string, unknown>|null} */
function judgeReaskRecord(state) {
  const record = [...(state.executionOverrides ?? [])].reverse().find(isJudgeReask);
  return record ? /** @type {Record<string, unknown>} */ (record) : null;
}

/**
 * Spend the one bounded re-ask of the current judge round on the node state
 * itself. The record is only mutated in memory: the caller's transition — the
 * same atomic node write that persists the re-ask dispatch, the recovered
 * pending judge, or the blocked attention — carries it to disk. Bound and node
 * therefore move together, so no crash window can skip the permitted re-ask or
 * grant a second one.
 *
 * @param {NodeSnapshot} state
 * @param {string} [reason] what the re-ask answers, which selects its instruction
 */
export function markJudgeReask(state, reason = UNCITED_REJECTION_REASON) {
  if (judgeReaskOutstanding(state)) return;
  const record = /** @type {ExecutionOverride} */ (/** @type {unknown} */ ({
    kind: JUDGE_REASK_KIND,
    at: new Date().toISOString(),
    phase: "judge",
    reason,
  }));
  state.executionOverrides = [...(state.executionOverrides ?? []), record];
}

/** Whether the current judge round already spent its one bounded re-ask. @param {NodeSnapshot} state @returns {boolean} */
export function judgeReaskOutstanding(state) {
  return judgeReaskRecord(state) !== null;
}

/**
 * What the outstanding re-ask answers, so the re-dispatched prompt carries the
 * instruction the defect calls for.
 *
 * @param {NodeSnapshot} state
 * @returns {string|undefined}
 */
export function judgeReaskReason(state) {
  const reason = judgeReaskRecord(state)?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Release the bound when a judge round settles on a verdict that is not a protocol failure, so the next round is asked afresh. @param {NodeSnapshot} state */
export function clearJudgeReask(state) {
  if (!judgeReaskOutstanding(state)) return;
  state.executionOverrides = (state.executionOverrides ?? []).filter((item) => !isJudgeReask(item));
}

/**
 * Drop the routing override and progress snapshot so a fresh worker attempt
 * routes and meters from scratch.
 * @param {{routing?: {currentOverride?: unknown}|null, progress?: unknown}} state
 */
export function resetPhaseRouting(state) {
  if (state.routing) state.routing.currentOverride = null;
  state.progress = null;
}
