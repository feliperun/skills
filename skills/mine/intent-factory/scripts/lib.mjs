import { validateContract, routeRuntime } from "./contract.mjs";
import { normalizeProviderResult, providerCommand } from "./drivers/index.mjs";
import { validateWorkerResult } from "./worker-result.mjs";
export { runProcessAlive } from "./supervisor.mjs";

export { validateContract, routeRuntime, normalizeProviderResult, providerCommand };
export { renderStatus, renderReport, renderFindings } from "./render.mjs";

/** @typedef {{id: string, definitionOfDone: string[], taskPacket: {mode?: "execution"|"discovery"|"autonomous", objective: string, instructions: string[], writeFiles?: string[], writeRoots?: string[], verification: {argv: string[]}[]}}} JudgeNode */
/** @typedef {{verdict: "pass"|"fail", maxSeverity: "none"|"minor"|"major"|"critical", summary: string, findings: {severity: "minor"|"major"|"critical", description: string, evidence: string}[]}} JudgeVerdict */

export const TERMINAL = new Set([
  "done",
  "no-op",
  "blocked",
  "failed",
  "exhausted",
  "stalled",
  "canceled",
]);

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    maxSeverity: { type: "string", enum: ["none", "minor", "major", "critical"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["minor", "major", "critical"] },
          description: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["severity", "description", "evidence"],
      },
    },
  },
  required: ["verdict", "maxSeverity", "summary", "findings"],
};

/**
 * @param {string} result
 * @returns {JudgeVerdict}
 */
export function parseJudge(result) {
  let parsed;
  try {
    parsed = /** @type {unknown} */ (JSON.parse(result));
  } catch (error) {
    throw new Error(`judge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verdict = /** @type {Record<string, unknown>} */ (parsed);
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) throw new Error("judge result must be an object");
  // Judge output is an external LLM boundary: models add fields beyond the
  // schema (toolAction, confidence, …). Unknown keys are dropped here; every
  // canonical field keeps strict value validation below.
  const judgeVerdict = verdict.verdict;
  const maxSeverity = verdict.maxSeverity;
  if (typeof judgeVerdict !== "string" || !JUDGE_SCHEMA.properties.verdict.enum.includes(judgeVerdict)) throw new Error("judge verdict must be pass or fail");
  if (typeof maxSeverity !== "string" || !JUDGE_SCHEMA.properties.maxSeverity.enum.includes(maxSeverity)) throw new Error("judge maxSeverity is invalid");
  if (typeof verdict.summary !== "string" || !Array.isArray(verdict.findings)) throw new Error("judge result is missing summary or findings");
  if (Buffer.byteLength(verdict.summary, "utf8") > 4 * 1024 || verdict.findings.length > 32) throw new Error("judge result exceeds limits");
  const severityRank = { none: 0, minor: 1, major: 2, critical: 3 };
  const rawFindings = /** @type {unknown[]} */ (verdict.findings);
  const findings = rawFindings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error("judge finding is invalid");
    const record = /** @type {Record<string, unknown>} */ (finding);
    const severity = record.severity;
    if (typeof severity !== "string" || !["minor", "major", "critical"].includes(severity) || typeof record.description !== "string" || typeof record.evidence !== "string") {
      throw new Error("judge finding is invalid");
    }
    if (Buffer.byteLength(record.description, "utf8") > 2 * 1024 || Buffer.byteLength(record.evidence, "utf8") > 4 * 1024) throw new Error("judge finding exceeds limits");
    return {
      severity: /** @type {"minor"|"major"|"critical"} */ (severity),
      description: record.description,
      evidence: record.evidence,
    };
  });
  const findingSeverities = findings.map((finding) => finding.severity);
  const actualMax = findingSeverities.reduce(
    (highest, severity) => severityRank[severity] > severityRank[highest] ? severity : highest,
    /** @type {"none"|"minor"|"major"|"critical"} */ ("none"),
  );
  if (actualMax !== maxSeverity) throw new Error("judge maxSeverity does not match findings");
  if ((judgeVerdict === "pass") !== (maxSeverity === "none")) throw new Error("judge verdict and maxSeverity are inconsistent");
  return {
    verdict: /** @type {"pass"|"fail"} */ (judgeVerdict),
    maxSeverity: /** @type {"none"|"minor"|"major"|"critical"} */ (maxSeverity),
    summary: verdict.summary,
    findings,
  };
}

/**
 * @param {JudgeNode} node
 * @param {unknown} workerResult
 * @param {{diff?: unknown[], verification?: unknown}} context
 * @returns {string}
 */
export function judgePrompt(node, workerResult, context = {}) {
  const criteria = node.definitionOfDone.length
    ? node.definitionOfDone.map((item) => `- ${item}`).join("\n")
    : "- The requested work is complete, correct, tested, and limited to scope.";
  const taskInstructions = node.taskPacket.instructions.length
    ? node.taskPacket.instructions.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "(none)";
  const writeBoundary = node.taskPacket.mode === "autonomous"
    ? node.taskPacket.writeRoots ?? []
    : node.taskPacket.writeFiles ?? [];
  const writeBoundaryLabel = node.taskPacket.mode === "autonomous" ? "Write roots" : "Write files";
  const writeFiles = writeBoundary.length
    ? writeBoundary.map((path) => `- ${path}`).join("\n")
    : "- (none)";
  const verification = node.taskPacket.verification.length
    ? node.taskPacket.verification.map((command) => `- ${command.argv.join(" ")}`).join("\n")
    : "- (none)";
  let structured = null;
  try { structured = typeof workerResult === "string" ? JSON.parse(workerResult) : workerResult; } catch {}
  if (structured) {
    try { structured = validateWorkerResult(structured); } catch { structured = null; }
  }
  const diff = Array.isArray(context.diff) ? /** @type {unknown[]} */ (context.diff).slice(0, 64) : [];
  const verificationResult = context.verification ?? { passed: false, commands: [] };
  return `Review node ${node.id} independently. The review context is closed: inspect only the ${node.taskPacket.mode === "autonomous" ? "write roots" : "write files"} below and do not perform repository-wide discovery. Do not re-run the verification commands — the controller already executed them and attached the results; re-running suites duplicates cost without adding evidence.\n\n` +
    `${writeBoundaryLabel}:\n${writeFiles}\n\nVerification commands (already executed by the controller):\n${verification}\n\n` +
    `Task brief:\n${node.taskPacket.objective}\n\nInstructions:\n${taskInstructions}\n\nDefinition of Done:\n${criteria}\n\n` +
    `Worker result (structured):\n${structured ? JSON.stringify(structured) : "(invalid worker result withheld)"}\n\n` +
    `Controller diff paths:\n${diff.length ? diff.map((path) => `- ${path}`).join("\n") : "- (none)"}\n\n` +
    `Controller verification:\n${JSON.stringify(verificationResult)}\n\n` +
    "Return only the JSON object required by the output schema. Evidence must be concrete. " +
    "Use verdict pass only when findings is empty and maxSeverity is none. " +
    "Use verdict fail whenever findings is non-empty, including advisory findings below failOn. " +
    "Use pass only when every Definition of Done item is satisfied.";
}

/**
 * @param {{prompt: string}} node
 * @param {{summary: string, findings: {severity: "minor"|"major"|"critical", description: string, evidence: string}[]}} verdict
 * @returns {string}
 */
export function retryPrompt(node, verdict) {
  const findings = verdict.findings
    .map((finding) => `- [${finding.severity}] ${boundedPromptText(finding.description, 2 * 1024)} Evidence: ${boundedPromptText(finding.evidence, 4 * 1024)}`)
    .join("\n");
  const prompt = `${node.prompt}\n\nA quality gate rejected the previous attempt. Fix the current working tree in place inside the closed context above.\n` +
    `Gate summary: ${boundedPromptText(verdict.summary, 4 * 1024)}\n${findings}`;
  return Buffer.byteLength(prompt, "utf8") > 64 * 1024
    ? `${node.prompt}\n\nA quality gate rejected the previous attempt. Review the bounded structured findings in the state snapshot and fix the working tree inside the closed context.`
    : prompt;
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedPromptText(value, maxBytes) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : `${bytes.subarray(0, maxBytes - 1).toString("utf8")}…`;
}

/**
 * @param {unknown} text
 * @returns {string|null}
 */
export function excerpt(text) {
  if (typeof text !== "string") return null;
  const clean = text.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return null;
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}
