import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const TERMINAL = new Set([
  "done",
  "no-op",
  "blocked",
  "failed",
  "exhausted",
  "stalled",
  "canceled",
]);

const MARK = {
  pending: "[ ]",
  running: "[>]",
  done: "[+]",
  "no-op": "[.]",
  blocked: "[!]",
  failed: "[x]",
  exhausted: "[$]",
  stalled: "[~]",
  canceled: "[/]",
};

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

export function validateContract(raw, contractPath) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("contract must be a JSON object");
  }
  requireId(raw.id, "contract.id");
  requireString(raw.goal, "contract.goal");

  const contractDir = dirname(resolve(contractPath));
  const cwd = resolve(contractDir, raw.cwd ?? ".");
  if (!statSync(cwd).isDirectory()) throw new TypeError("contract.cwd must be a directory");

  const runtimes = raw.runtimes;
  if (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes)) {
    throw new TypeError("contract.runtimes must be an object");
  }
  for (const [id, runtime] of Object.entries(runtimes)) validateRuntime(id, runtime);

  const defaults = raw.runtimeDefaults;
  if (!defaults || typeof defaults !== "object") {
    throw new TypeError("contract.runtimeDefaults is required");
  }
  requireRuntime(runtimes, defaults.worker, "runtimeDefaults.worker");
  requireRuntime(runtimes, defaults.judge, "runtimeDefaults.judge");

  const rules = raw.runtimeRules ?? [];
  if (!Array.isArray(rules)) throw new TypeError("contract.runtimeRules must be an array");
  for (const [index, rule] of rules.entries()) {
    if (!rule?.match || typeof rule.match !== "object" || Array.isArray(rule.match)) {
      throw new TypeError(`runtimeRules[${index}].match must be an object`);
    }
    if (!Object.keys(rule.match).length) {
      throw new TypeError(`runtimeRules[${index}].match cannot be empty`);
    }
    requireRuntime(runtimes, rule.runtime, `runtimeRules[${index}].runtime`);
  }

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new TypeError("contract.nodes must be a non-empty array");
  }
  const ids = new Set();
  const nodes = raw.nodes.map((node, index) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new TypeError(`nodes[${index}] must be an object`);
    }
    requireId(node.id, `nodes[${index}].id`);
    if (ids.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    requireString(node.type, `nodes[${index}].type`);
    if (node.runtime !== undefined) requireRuntime(runtimes, node.runtime, `nodes[${index}].runtime`);
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      throw new TypeError(`nodes[${index}].dependsOn must be an array of ids`);
    }
    const prompt = loadPrompt(node, contractDir, index);
    const definitionOfDone = node.definitionOfDone ?? [];
    if (!Array.isArray(definitionOfDone) || definitionOfDone.some((item) => typeof item !== "string")) {
      throw new TypeError(`nodes[${index}].definitionOfDone must be an array of strings`);
    }
    const gate = validateGate(node.gate, runtimes, index);
    const timeoutSec = node.timeoutSec === undefined
      ? undefined
      : positiveNumber(node.timeoutSec, `nodes[${index}].timeoutSec`);
    return { ...node, dependsOn, definitionOfDone, prompt, gate, timeoutSec };
  });

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new TypeError(`${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new TypeError(`${node.id} cannot depend on itself`);
    }
  }
  assertAcyclic(nodes);

  return {
    ...raw,
    cwd,
    runtimes,
    runtimeDefaults: defaults,
    runtimeRules: rules,
    nodes,
    maxParallel: positiveInteger(raw.maxParallel ?? 1, "contract.maxParallel"),
    pollIntervalMs: positiveInteger(raw.pollIntervalMs ?? 1_000, "contract.pollIntervalMs"),
    stallTimeoutSec: positiveNumber(raw.stallTimeoutSec ?? 300, "contract.stallTimeoutSec"),
    timeoutSec: positiveNumber(raw.timeoutSec ?? 1_800, "contract.timeoutSec"),
  };
}

export function routeRuntime(contract, node, role = "worker") {
  let runtimeId;
  if (role === "judge") {
    runtimeId = node.gate.runtime ?? contract.runtimeDefaults.judge;
  } else if (node.runtime) {
    runtimeId = node.runtime;
  } else {
    runtimeId = contract.runtimeRules.find((rule) =>
      Object.entries(rule.match).every(([key, value]) => node[key] === value),
    )?.runtime ?? contract.runtimeDefaults.worker;
  }
  return { id: runtimeId, ...contract.runtimes[runtimeId] };
}

export function providerCommand(runtime, prompt, options = {}) {
  if (runtime.driver === "claude") {
    const args = [
      "-p",
      "--model",
      runtime.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      runtime.permissionMode ?? "acceptEdits",
    ];
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    args.push(prompt);
    return { executable: process.env.HARNESS_CLAUDE_BIN ?? "claude", args };
  }

  const args = ["exec", "--json", "--sandbox", runtime.sandbox ?? "workspace-write"];
  for (const [key, value] of Object.entries(runtime.config ?? {})) {
    args.push("-c", `${key}=${toml(value)}`);
  }
  args.push("-c", `model=${toml(runtime.model)}`);
  if (runtime.reasoning) args.push("-c", `model_reasoning_effort=${toml(runtime.reasoning)}`);
  if (options.schemaPath) args.push("--output-schema", options.schemaPath);
  args.push(prompt);
  return { executable: process.env.HARNESS_CODEX_BIN ?? "codex", args };
}

export function normalizeProviderResult(driver, stdout, exitCode, signal, options = {}) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  const events = parseJsonLines(stdout, driver);
  if (driver === "claude") return normalizeClaude(events, exitCode);
  return normalizeCodex(events, exitCode, options.preferStructured ?? false);
}

export function parseJudge(result) {
  let verdict;
  try {
    verdict = JSON.parse(result);
  } catch (error) {
    throw new Error(`judge returned invalid JSON: ${error.message}`);
  }
  if (!JUDGE_SCHEMA.properties.verdict.enum.includes(verdict.verdict)) {
    throw new Error("judge verdict must be pass or fail");
  }
  if (!JUDGE_SCHEMA.properties.maxSeverity.enum.includes(verdict.maxSeverity)) {
    throw new Error("judge maxSeverity is invalid");
  }
  if (typeof verdict.summary !== "string" || !Array.isArray(verdict.findings)) {
    throw new Error("judge result is missing summary or findings");
  }
  const severityRank = { none: 0, minor: 1, major: 2, critical: 3 };
  const findingSeverities = verdict.findings.map((finding) => {
    if (
      !finding ||
      !["minor", "major", "critical"].includes(finding.severity) ||
      typeof finding.description !== "string" ||
      typeof finding.evidence !== "string"
    ) {
      throw new Error("judge finding is invalid");
    }
    return finding.severity;
  });
  const actualMax = findingSeverities.reduce(
    (highest, severity) => severityRank[severity] > severityRank[highest] ? severity : highest,
    "none",
  );
  if (actualMax !== verdict.maxSeverity) throw new Error("judge maxSeverity does not match findings");
  if ((verdict.verdict === "pass") !== (verdict.maxSeverity === "none")) {
    throw new Error("judge verdict and maxSeverity are inconsistent");
  }
  return verdict;
}

export function judgePrompt(node, workerResult) {
  const criteria = node.definitionOfDone.length
    ? node.definitionOfDone.map((item) => `- ${item}`).join("\n")
    : "- The requested work is complete, correct, tested, and limited to scope.";
  return `Review node ${node.id} independently. Inspect the working tree and run relevant tests.\n\n` +
    `Original task:\n${node.prompt}\n\nDefinition of Done:\n${criteria}\n\n` +
    `Worker report:\n${workerResult || "(empty)"}\n\n` +
    "Return only the JSON object required by the output schema. Evidence must be concrete. " +
    "Use verdict pass only when findings is empty and maxSeverity is none. " +
    "Use verdict fail whenever findings is non-empty, including advisory findings below failOn. " +
    "Use pass only when every Definition of Done item is satisfied.";
}

export function retryPrompt(node, verdict) {
  const findings = verdict.findings
    .map((finding) => `- [${finding.severity}] ${finding.description} Evidence: ${finding.evidence}`)
    .join("\n");
  return `${node.prompt}\n\nA quality gate rejected the previous attempt. Fix the current working tree in place.\n` +
    `Gate summary: ${verdict.summary}\n${findings}`;
}

export function renderStatus(runDir) {
  const contract = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  const nodeDir = join(runDir, "nodes");
  const nodes = readdirSync(nodeDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(nodeDir, name), "utf8")));
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  const widths = [3, 24, 9, 28, 7, 24];
  const row = (cells) => cells.map((cell, i) => fit(String(cell ?? ""), widths[i])).join(" ");
  const lines = [
    `# run ${basename(runDir)}`,
    "",
    contract.goal,
    "",
    `${nodes.length} nodes · ${summary}`,
    "",
    "```",
    row(["", "NODE", "STATE", "RUNTIME", "TRY", "NOTE"]),
    row(widths.map((width) => "-".repeat(width))),
  ];
  for (const node of nodes) {
    const runtime = node.runtime ? `${node.runtime.driver}/${node.runtime.model}` : "-";
    const note = node.gate?.summary ?? node.error?.message ?? node.blockedBy?.join(", ") ?? node.phase ?? "-";
    lines.push(row([MARK[node.status] ?? "[?]", node.id, node.status, runtime, node.attempt ?? 0, note]));
  }
  lines.push("```", "");
  const attention = nodes.filter((node) => !["pending", "running", "done"].includes(node.status));
  const orphans = runProcessAlive(runDir) === false
    ? nodes.filter((node) => node.status === "running").map((node) => node.id)
    : [];
  lines.push("## Needs you", "");
  if (!attention.length && !orphans.length) lines.push("Nothing needs you right now.");
  if (orphans.length) {
    lines.push(
      `- [>] the run process is gone while ${orphans.join(", ")} still claims to be running. ` +
      "Those nodes are orphans, not live work. Resume the run directory to adopt whatever their workers finished.",
    );
  }
  for (const node of attention) lines.push(`- ${MARK[node.status] ?? "[?]"} ${node.id}: ${node.gate?.summary ?? node.error?.message ?? node.status}`);
  return `${lines.join("\n")}\n`;
}

/** Returns null when the run predates process tracking, otherwise whether its controller is alive. */
export function runProcessAlive(runDir) {
  let pid;
  try {
    ({ pid } = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function lastOutputAt(paths, fallback) {
  let latest = Date.parse(fallback);
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return latest;
}

function validateRuntime(id, runtime) {
  requireId(id, `runtime ${id}`);
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError(`runtime ${id} must be an object`);
  }
  if (!new Set(["claude", "codex"]).has(runtime.driver)) {
    throw new TypeError(`runtime ${id}.driver must be claude or codex`);
  }
  requireString(runtime.model, `runtime ${id}.model`);
  if (
    runtime.sandbox !== undefined &&
    !new Set(["read-only", "workspace-write", "danger-full-access"]).has(runtime.sandbox)
  ) {
    throw new TypeError(`runtime ${id}.sandbox is invalid`);
  }
  if (runtime.config !== undefined && (!runtime.config || typeof runtime.config !== "object" || Array.isArray(runtime.config))) {
    throw new TypeError(`runtime ${id}.config must be an object`);
  }
}

function validateGate(gate, runtimes, index) {
  // `enabled: false` is the internal shape of a disabled gate as stored in a
  // run directory; accepting it lets the stored contract round-trip through
  // validateContract on resume without silently re-enabling the gate.
  if (gate === false || gate === undefined || gate?.enabled === false) return { enabled: false };
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    throw new TypeError(`nodes[${index}].gate must be false or an object`);
  }
  if (gate.runtime !== undefined) requireRuntime(runtimes, gate.runtime, `nodes[${index}].gate.runtime`);
  const failOn = gate.failOn ?? ["critical"];
  if (!Array.isArray(failOn) || failOn.some((value) => !["minor", "major", "critical"].includes(value))) {
    throw new TypeError(`nodes[${index}].gate.failOn contains an invalid severity`);
  }
  return {
    enabled: true,
    runtime: gate.runtime,
    failOn,
    maxRevisions: nonNegativeInteger(gate.maxRevisions ?? 1, `nodes[${index}].gate.maxRevisions`),
  };
}

function loadPrompt(node, contractDir, index) {
  const hasPrompt = typeof node.prompt === "string" && Boolean(node.prompt);
  const hasPromptFile = typeof node.promptFile === "string" && Boolean(node.promptFile);
  if (hasPrompt === hasPromptFile) {
    throw new TypeError(`nodes[${index}] needs exactly one of prompt or promptFile`);
  }
  if (hasPrompt) return node.prompt;
  if (hasPromptFile) {
    return readFileSync(resolve(contractDir, node.promptFile), "utf8");
  }
  throw new TypeError(`nodes[${index}] needs exactly one of prompt or promptFile`);
}

function assertAcyclic(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new TypeError(`dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function normalizeClaude(events, exitCode) {
  const resultEvent = events.findLast((event) => event.type === "result");
  if (!resultEvent) return failed("incomplete_stream", "Claude emitted no result event");
  const result = typeof resultEvent.result === "string" ? resultEvent.result : null;
  if (resultEvent.is_error || exitCode !== 0) {
    return failed("provider_error", result ?? `Claude exited with code ${exitCode}`);
  }
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId: resultEvent.session_id ?? null,
    usage: canonicalUsage(resultEvent.usage),
    costUsd: finite(resultEvent.total_cost_usd),
    error: null,
  };
}

function normalizeCodex(events, exitCode, preferStructured) {
  const completed = events.findLast((event) => event.type === "turn.completed");
  const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
  const message = preferStructured
    ? messages.findLast((event) => extractJson(event.item.text) !== null) ?? messages.at(-1)
    : messages.at(-1);
  const failure = events.findLast((event) => event.type === "turn.failed" || event.type === "error");
  if (failure || exitCode !== 0) {
    return failed("provider_error", failure?.error?.message ?? failure?.message ?? `Codex exited with code ${exitCode}`);
  }
  if (!completed) return failed("incomplete_stream", "Codex emitted no turn.completed event");
  const result = preferStructured ? extractJson(message?.item?.text) ?? message?.item?.text ?? null : message?.item?.text ?? null;
  const thread = events.find((event) => event.type === "thread.started");
  return {
    status: result?.trim() ? "done" : "no-op",
    result,
    continuationId: thread?.thread_id ?? null,
    usage: canonicalUsage(completed.usage),
    costUsd: null,
    error: null,
  };
}

function extractJson(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}
  const blocks = [...value.matchAll(/```json\s*([\s\S]*?)```/giu)];
  for (const block of blocks.reverse()) {
    const candidate = block[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

function failed(code, message, status = classifyFailure(message)) {
  return {
    status,
    result: null,
    continuationId: null,
    usage: canonicalUsage(),
    costUsd: null,
    error: { code, message: String(message) },
  };
}

function classifyFailure(message) {
  const text = String(message);
  if (/cancel(?:ed|led)|aborted/iu.test(text)) return "canceled";
  if (/permission|approval|sandbox/iu.test(text)) return "blocked";
  if (/budget|token.*limit|context.*limit|max.*turn/iu.test(text)) return "exhausted";
  return "failed";
}

function parseJsonLines(stdout, driver) {
  const events = [];
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${driver} emitted invalid JSON on line ${index + 1}: ${error.message}`);
    }
  }
  return events;
}

function canonicalUsage(usage = {}) {
  return {
    inputTokens: finite(usage?.input_tokens),
    outputTokens: finite(usage?.output_tokens),
    cacheReadInputTokens: finite(usage?.cache_read_input_tokens ?? usage?.cached_input_tokens),
  };
}

function toml(value) {
  return JSON.stringify(value);
}

function requireRuntime(runtimes, id, label) {
  if (typeof id !== "string" || !runtimes[id]) throw new TypeError(`${label} names an unknown runtime`);
}

function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return value;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    if (/\p{Mark}/u.test(char)) continue;
    const code = char.codePointAt(0);
    width += code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    ) ? 2 : 1;
  }
  return width;
}

function fit(value, width) {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (displayWidth(clean) <= width) return clean + " ".repeat(width - displayWidth(clean));
  let output = "";
  for (const char of clean) {
    if (displayWidth(`${output}${char}..`) > width) break;
    output += char;
  }
  const truncated = `${output}..`;
  return truncated + " ".repeat(Math.max(0, width - displayWidth(truncated)));
}
