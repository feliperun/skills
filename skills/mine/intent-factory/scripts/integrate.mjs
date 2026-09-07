import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "./store.mjs";
import {
  candidateRefName,
  cleanupCandidate,
  createCandidateWorktree,
  deleteRef,
  git,
  gitDiffEmpty,
  gitHead,
  removeWorktree,
  updateRefConditional,
  candidateWorktreePath,
  runRefName,
} from "./worktree.mjs";

const JOURNAL = "integration.jsonl";
const TERMINAL = new Set(["accepted", "failed", "conflict"]);

/** @typedef {"prepared"|"verified"|"accepted"|"failed"|"conflict"} IntegrationStatus */
/** @typedef {{schemaVersion: number, transactionId: string, runId: string, node: string, attempt: number, attemptSha: string, branch: string|null, empty: boolean, previousRunRefTip: string, candidateSha: string|null, conflictingPaths: string[], at: string, status?: IntegrationStatus, verificationEvidence?: unknown, acceptedAt?: string}} IntegrationRecord */
/** @typedef {{passed?: boolean, error?: string, [key: string]: unknown}} CandidateEvidence */
/** @typedef {(record: IntegrationRecord) => void|Promise<void>} AcceptedCallback */
/** @typedef {(record: IntegrationRecord & {candidateEvidence: CandidateEvidence}) => void|Promise<void>} VerificationFailureCallback */
/** @typedef {(record: IntegrationRecord & {currentRunRefTip: string|null, error?: unknown}) => void|Promise<void>} ConcurrentMoveCallback */
/** @typedef {(workspace: string, transaction: IntegrationRecord) => Promise<CandidateEvidence>} CandidateVerifier */
/** @typedef {{repo: string, runDir: string, runId: string, nodeId: string, attempt: number, attemptSha: string, branch?: string|null, verificationEvidence?: unknown, verifyCandidate: CandidateVerifier, onAccepted?: AcceptedCallback, onVerificationFailure?: VerificationFailureCallback, onConflict?: AcceptedCallback, onConcurrentMove?: ConcurrentMoveCallback, interrupt?: (stage: string) => void}} IntegrationArgs */
/** @typedef {{repo: string, runDir: string, runId: string, verifyCandidate: CandidateVerifier, onAccepted?: AcceptedCallback, onVerificationFailure?: VerificationFailureCallback, onConflict?: AcceptedCallback, onConcurrentMove?: ConcurrentMoveCallback}} RecoveryArgs */
/** @typedef {{status: string, candidateSha?: string|null, conflictingPaths?: string[], candidateEvidence?: CandidateEvidence}} IntegrationResult */

/** @param {string} runDir @returns {string} */
export function integrationJournalPath(runDir) {
  return join(runDir, JOURNAL);
}

/** @param {string} nodeId @param {number} attempt @returns {string} */
export function integrationKey(nodeId, attempt) {
  return `${nodeId}:${attempt}`;
}

/** @param {string} runDir @returns {IntegrationRecord[]} */
export function readIntegrationJournal(runDir) {
  const path = integrationJournalPath(runDir);
  let text;
  try {
    text = requireText(path);
  } catch (error) {
    if (error instanceof Error && /** @type {{code?: string}} */ (error).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter(Boolean).map((line, index) => {
    try {
      return /** @type {IntegrationRecord} */ (JSON.parse(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`integration journal line ${index + 1} is invalid: ${message}`);
    }
  });
}

/** @param {string} runDir @returns {IntegrationRecord[]} */
export function latestIntegrationTransactions(runDir) {
  /** @type {Map<string, IntegrationRecord>} */
  const latest = new Map();
  for (const record of readIntegrationJournal(runDir)) {
    if (!record || typeof record !== "object") continue;
    const key = integrationKey(record.node, record.attempt);
    latest.set(key, record);
  }
  return [...latest.values()];
}

/** @param {IntegrationArgs} args @returns {Promise<IntegrationResult|null>} */
export async function integrateAttempt({
  repo,
  runDir,
  runId,
  nodeId,
  attempt,
  attemptSha,
  branch,
  verificationEvidence,
  verifyCandidate,
  onAccepted,
  onVerificationFailure,
  onConflict,
  onConcurrentMove,
  interrupt,
}) {
  const existing = latestIntegrationTransactions(runDir).find((record) => (
    record.node === nodeId && record.attempt === attempt
  ));
  if (existing?.status === "accepted") {
    await finishAccepted(repo, runDir, runId, existing, onAccepted);
    return { status: "accepted", candidateSha: existing.candidateSha };
  }
  if (existing && !TERMINAL.has(existing.status ?? "")) {
    return recoverIntegrations({
      repo,
      runDir,
      runId,
      verifyCandidate,
      onAccepted,
      onVerificationFailure,
      onConflict,
      onConcurrentMove,
    });
  }
  const previousRunRefTip = gitHead(repo, runRefName(runId));
  if (!previousRunRefTip) throw new Error(`integration ref is unavailable for ${runId}`);
  const transaction = prepareTransaction({
    repo,
    runId,
    nodeId,
    attempt,
    attemptSha,
    branch,
    previousRunRefTip,
  });
  appendRecord(runDir, { ...transaction, status: "prepared", verificationEvidence: verificationEvidence ?? null });
  interruptStage(interrupt, "prepared");
  if (transaction.conflictingPaths.length) {
    appendRecord(runDir, { ...transaction, status: "conflict", conflictingPaths: transaction.conflictingPaths, verificationEvidence: verificationEvidence ?? null });
    await onConflict?.(transaction);
    cleanupCandidate(repo, runDir, runId);
    return { status: "conflict", conflictingPaths: transaction.conflictingPaths };
  }
  return verifyAndAdvance({
    repo,
    runDir,
    runId,
    transaction,
    verificationEvidence,
    verifyCandidate,
    onAccepted,
    onVerificationFailure,
    onConcurrentMove,
    interrupt,
  });
}

/** @param {RecoveryArgs} args @returns {Promise<IntegrationResult|null>} */
export async function recoverIntegrations({
  repo,
  runDir,
  runId,
  verifyCandidate,
  onAccepted,
  onVerificationFailure,
  onConflict,
  onConcurrentMove,
}) {
  for (const record of latestIntegrationTransactions(runDir)) {
    if (record.status === "accepted") {
      await finishAccepted(repo, runDir, runId, record, onAccepted);
      continue;
    }
    if (record.status === "failed" || record.status === "conflict") {
      cleanupCandidate(repo, runDir, runId);
      continue;
    }
    /** @type {IntegrationRecord} */
    const transaction = {
      ...record,
      conflictingPaths: Array.isArray(record.conflictingPaths) ? record.conflictingPaths : [],
    };
    if (!transaction.candidateSha) {
      cleanupCandidate(repo, runDir, runId);
      if (transaction.conflictingPaths.length) {
        const conflict = appendConflict(runDir, transaction);
        await onConflict?.(conflict);
      }
      continue;
    }
    const current = gitHead(repo, runRefName(runId));
    // A prepared record has no candidate verification evidence. Even if an
    // external actor moved the run ref to the candidate or beyond it, that
    // ancestry is not proof that this transaction passed verification.
    if (record.status === "prepared") {
      if (current && current !== transaction.previousRunRefTip) {
        cleanupCandidate(repo, runDir, runId);
        await onConcurrentMove?.({ ...transaction, currentRunRefTip: current });
        continue;
      }
      cleanupCandidate(repo, runDir, runId);
      const rebuilt = candidateObjectExists(repo, transaction.candidateSha)
        ? { ...transaction, conflictingPaths: [] }
        : prepareTransaction({
          repo,
          runId,
          nodeId: transaction.node,
          attempt: transaction.attempt,
          attemptSha: transaction.attemptSha,
          branch: transaction.branch,
          previousRunRefTip: transaction.previousRunRefTip,
        });
      if (rebuilt.candidateSha !== transaction.candidateSha || rebuilt.conflictingPaths.length) {
        const conflict = appendConflict(runDir, {
          ...transaction,
          conflictingPaths: rebuilt.conflictingPaths.length ? rebuilt.conflictingPaths : ["candidate object unavailable"],
        });
        await onConflict?.(conflict);
        continue;
      }
      return verifyAndAdvance({
        repo,
        runDir,
        runId,
        transaction: rebuilt,
        verificationEvidence: transaction.verificationEvidence,
        verifyCandidate,
        onAccepted,
        onVerificationFailure,
        onConcurrentMove,
      });
    }
    if (current === transaction.candidateSha && current !== transaction.previousRunRefTip) {
      const accepted = appendAccepted(runDir, transaction);
      await finishAccepted(repo, runDir, runId, accepted, onAccepted);
      continue;
    }
    if (current && current !== transaction.previousRunRefTip && isAncestor(repo, transaction.candidateSha, current)) {
      const accepted = appendAccepted(runDir, transaction);
      await finishAccepted(repo, runDir, runId, accepted, onAccepted);
      continue;
    }
    if (current && current !== transaction.previousRunRefTip) {
      cleanupCandidate(repo, runDir, runId);
      await onConcurrentMove?.({ ...transaction, currentRunRefTip: current });
      continue;
    }
    cleanupCandidate(repo, runDir, runId);
    return advanceVerified({
      repo,
      runDir,
      runId,
      transaction,
      onAccepted,
      onConcurrentMove,
    });
  }
  return null;
}

/** @param {{repo: string, runId: string, nodeId: string, attempt: number, attemptSha: string, branch?: string|null, previousRunRefTip: string}} args @returns {IntegrationRecord} */
function prepareTransaction({ repo, runId, nodeId, attempt, attemptSha, branch, previousRunRefTip }) {
  /** @type {IntegrationRecord} */
  const transaction = {
    schemaVersion: 1,
    transactionId: `${runId}:${nodeId}:${attempt}`,
    runId,
    node: nodeId,
    attempt,
    attemptSha,
    branch: branch ?? null,
    empty: false,
    previousRunRefTip,
    candidateSha: null,
    conflictingPaths: [],
    at: new Date().toISOString(),
  };
  transaction.empty = Boolean(gitDiffEmpty(repo, previousRunRefTip, attemptSha));
  if (transaction.empty) {
    transaction.candidateSha = previousRunRefTip;
    return transaction;
  }
  if (attemptSha === previousRunRefTip || isAncestor(repo, previousRunRefTip, attemptSha)) {
    transaction.candidateSha = attemptSha;
    return transaction;
  }
  const merge = spawnSync("git", ["-C", repo, "merge-tree", "--write-tree", previousRunRefTip, attemptSha], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (merge.status !== 0) {
    transaction.conflictingPaths = conflictPaths(repo, previousRunRefTip, attemptSha, `${merge.stdout ?? ""}\n${merge.stderr ?? ""}`);
    return transaction;
  }
  const tree = String(merge.stdout ?? "").split("\n")[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("git merge-tree did not return a candidate tree");
  transaction.candidateSha = gitCommitTree(repo, tree, previousRunRefTip, attemptSha, runId, nodeId, attempt);
  return transaction;
}

/** @param {{repo: string, runDir: string, runId: string, transaction: IntegrationRecord, verificationEvidence?: unknown, verifyCandidate: CandidateVerifier, onAccepted?: AcceptedCallback, onVerificationFailure?: VerificationFailureCallback, onConcurrentMove?: ConcurrentMoveCallback, interrupt?: (stage: string) => void}} args @returns {Promise<IntegrationResult>} */
async function verifyAndAdvance({
  repo,
  runDir,
  runId,
  transaction,
  verificationEvidence,
  verifyCandidate,
  onAccepted,
  onVerificationFailure,
  onConcurrentMove,
  interrupt,
}) {
  deleteRef(repo, candidateRefName(runId));
  deleteCandidateWorktree(repo, runDir, runId);
  gitSetRef(repo, candidateRefName(runId), transaction.candidateSha);
  const workspace = createCandidateWorktree({ repo, runDir, runId });
  /** @type {CandidateEvidence} */
  let candidateEvidence;
  try {
    candidateEvidence = await verifyCandidate(workspace, transaction);
  } catch (error) {
    candidateEvidence = { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!candidateEvidence?.passed) {
    appendRecord(runDir, { ...transaction, status: "failed", verificationEvidence: { attempt: verificationEvidence ?? null, candidate: candidateEvidence } });
    cleanupCandidate(repo, runDir, runId);
    await onVerificationFailure?.({ ...transaction, candidateEvidence });
    return { status: "verification_failed", candidateEvidence };
  }
  /** @type {IntegrationRecord} */
  const verified = { ...transaction, status: "verified", verificationEvidence: { attempt: verificationEvidence ?? null, candidate: candidateEvidence } };
  appendRecord(runDir, verified);
  interruptStage(interrupt, "before-ref");
  return advanceVerified({ repo, runDir, runId, transaction: verified, onAccepted, onConcurrentMove, interrupt });
}

/** @param {{repo: string, runDir: string, runId: string, transaction: IntegrationRecord, onAccepted?: AcceptedCallback, onConcurrentMove?: ConcurrentMoveCallback, interrupt?: (stage: string) => void}} args @returns {Promise<IntegrationResult>} */
async function advanceVerified({ repo, runDir, runId, transaction, onAccepted, onConcurrentMove, interrupt }) {
  const current = gitHead(repo, runRefName(runId));
  if (!current) throw new Error(`integration ref is unavailable for ${runId}`);
  if (current === transaction.candidateSha && current !== transaction.previousRunRefTip) {
    const accepted = appendAccepted(runDir, transaction);
    await finishAccepted(repo, runDir, runId, accepted, onAccepted);
    return { status: "accepted", candidateSha: transaction.candidateSha };
  }
  if (current !== transaction.previousRunRefTip && !(isAncestor(repo, transaction.candidateSha, current))) {
    cleanupCandidate(repo, runDir, runId);
    await onConcurrentMove?.({ ...transaction, currentRunRefTip: current });
    return { status: "concurrent_move" };
  }
  if (current !== transaction.previousRunRefTip && isAncestor(repo, transaction.candidateSha, current)) {
    const accepted = appendAccepted(runDir, transaction);
    await finishAccepted(repo, runDir, runId, accepted, onAccepted);
    return { status: "accepted", candidateSha: transaction.candidateSha };
  }
  if (!transaction.candidateSha) throw new Error(`verified integration transaction is missing a candidate for ${transaction.node}`);
  try {
    updateRefConditional(repo, runRefName(runId), transaction.candidateSha, transaction.previousRunRefTip);
  } catch (error) {
    const now = gitHead(repo, runRefName(runId));
    cleanupCandidate(repo, runDir, runId);
    await onConcurrentMove?.({ ...transaction, currentRunRefTip: now, error });
    return { status: "concurrent_move" };
  }
  interruptStage(interrupt, "after-ref");
  const accepted = appendAccepted(runDir, transaction);
  await onAccepted?.(accepted);
  interruptStage(interrupt, "after-state");
  cleanupCandidate(repo, runDir, runId);
  return { status: "accepted", candidateSha: transaction.candidateSha };
}

/** @param {string} repo @param {string} runDir @param {string} runId @param {IntegrationRecord} record @param {AcceptedCallback|undefined} onAccepted @returns {Promise<void>} */
async function finishAccepted(repo, runDir, runId, record, onAccepted) {
  await onAccepted?.(record);
  cleanupCandidate(repo, runDir, runId);
}

/** @param {string} runDir @param {IntegrationRecord} transaction @returns {IntegrationRecord} */
function appendAccepted(runDir, transaction) {
  /** @type {IntegrationRecord} */
  const accepted = { ...transaction, status: "accepted", acceptedAt: new Date().toISOString() };
  const existing = latestIntegrationTransactions(runDir).find((record) => (
    record.node === transaction.node && record.attempt === transaction.attempt && record.status === "accepted"
  ));
  if (existing) return existing;
  appendRecord(runDir, accepted);
  return accepted;
}

/** @param {string} runDir @param {IntegrationRecord} transaction @returns {IntegrationRecord} */
function appendConflict(runDir, transaction) {
  /** @type {IntegrationRecord} */
  const conflict = { ...transaction, status: "conflict" };
  const existing = latestIntegrationTransactions(runDir).find((record) => (
    record.node === transaction.node && record.attempt === transaction.attempt && record.status === "conflict"
  ));
  if (existing) return existing;
  appendRecord(runDir, conflict);
  return conflict;
}

/** @param {string} runDir @param {IntegrationRecord} record @returns {void} */
function appendRecord(runDir, record) {
  appendJsonl(integrationJournalPath(runDir), record);
}

/** @param {string} repo @param {string|null} ancestor @param {string|null} descendant @returns {boolean} */
function isAncestor(repo, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  try {
    git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} repo @param {string|null} sha @returns {boolean} */
function candidateObjectExists(repo, sha) {
  if (!sha) return false;
  try {
    git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} repo @param {string} ref @param {string|null} sha @returns {void} */
function gitSetRef(repo, ref, sha) {
  if (!sha) throw new Error(`cannot set ${ref} without a candidate sha`);
  git(repo, ["update-ref", ref, sha]);
}

/** @param {string} repo @param {string} tree @param {string} firstParent @param {string} secondParent @param {string} runId @param {string} nodeId @param {number} attempt @returns {string} */
function gitCommitTree(repo, tree, firstParent, secondParent, runId, nodeId, attempt) {
  const result = spawnSync("git", ["-C", repo, "commit-tree", tree, "-p", firstParent, "-p", secondParent, "-m", `intent-factory candidate ${runId} ${nodeId} attempt ${attempt}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "intent-factory",
      GIT_AUTHOR_EMAIL: "runner@example.test",
      GIT_COMMITTER_NAME: "intent-factory",
      GIT_COMMITTER_EMAIL: "runner@example.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`git commit-tree failed: ${String(result.stderr ?? "").trim()}`);
  return String(result.stdout).trim();
}

/** @param {string} repo @param {string} first @param {string} second @param {string} output @returns {string[]} */
function conflictPaths(repo, first, second, output) {
  const paths = new Set();
  for (const match of output.matchAll(/(?:CONFLICT[^\n]*|Merge conflict in)\s+([^\n]+)/gi)) paths.add(match[1].trim());
  try {
    const base = git(repo, ["merge-base", first, second]);
    const left = new Set(git(repo, ["diff", "--name-only", base, first]).split("\n").filter(Boolean));
    for (const path of git(repo, ["diff", "--name-only", base, second]).split("\n").filter(Boolean)) {
      if (left.has(path)) paths.add(path);
    }
  } catch {}
  return [...paths].sort();
}

/** @param {string} repo @param {string} runDir @param {string} runId @returns {void} */
function deleteCandidateWorktree(repo, runDir, runId) {
  const path = candidateWorktreePath(runDir, runId);
  removeWorktree(repo, path);
}

/** @param {((stage: string) => void)|undefined} interrupt @param {string} stage @returns {void} */
function interruptStage(interrupt, stage) {
  interrupt?.(stage);
  if (process.env.INTENT_FACTORY_INTEGRATION_INTERRUPT === stage) {
    throw new Error(`integration interrupted at ${stage}`);
  }
}

/** @param {string} path @returns {string} */
function requireText(path) {
  return readFileSync(path, "utf8");
}
