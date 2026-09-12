import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  harnessCapabilities,
  missingCapabilities,
  normalizeProviderAvailability,
  normalizeProviderResult,
  probeRuntime,
  providerCommand,
  resolvePermissionExecution,
} from "../src/harnesses/index.mjs";
import {
  EXEC_JSONL_PROTOCOL,
  TOOL_OUTPUT_LIMIT_BYTES,
  liveInputTokens,
  liveSessionMetrics,
  liveUsage,
  normalizeExecJsonlResult,
  truncateToolOutput,
} from "../src/harnesses/exec-jsonl/index.mjs";
import { ensureZcodeAvailable } from "../src/harnesses/zcode/index.mjs";
import { normalizeCodexResult, parseVersion } from "../src/harnesses/protocol.mjs";
import { FOREGROUND_ONLY_DENIAL, HOOK_PATH } from "../src/host/tool-policy-hook.mjs";
import { DEFAULT_CLAUDE_TOOLS } from "../src/harnesses/claude/index.mjs";
import { CODEX_PREAMBLE_OVERRIDES } from "../src/harnesses/codex/index.mjs";
import { JUDGE_SCHEMA, routeRuntime } from "../src/engine/prompts.mjs";
import { validateContract } from "../src/contract/index.mjs";
import { fixture, packet, withEmptyPath, writeContract } from "./helpers.mjs";

test("all provider adapters report explicit capabilities and transport", () => {
  const runtimes = [
    { harness: "codex", model: "m" },
    { harness: "claude", model: "m" },
    { harness: "agy", model: "m" },
    { harness: "zcode", model: "m" },
    { harness: "dsh", model: "m", executable: "dsh", config: { provider: "deepseek-official" } },
    { harness: "exec-jsonl", model: "m", executable: "wrapper" },
  ];
  const expected = [
    {
      structuredOutput: true,
      promptTransport: "stdin",
      sandbox: true,
      permissions: false,
      continuation: true,
      tokenBudget: true,
      costBudget: false,
      usage: true,
      cost: false,
      toolPolicy: false,
      streamsOutput: true,
    },
    {
      structuredOutput: true,
      promptTransport: "stdin",
      sandbox: false,
      permissions: true,
      continuation: true,
      tokenBudget: false,
      costBudget: true,
      usage: true,
      cost: true,
      toolPolicy: true,
      streamsOutput: true,
    },
    {
      structuredOutput: true,
      promptTransport: "argv",
      maxArgvPromptBytes: 128 * 1024,
      sandbox: false,
      permissions: false,
      continuation: true,
      tokenBudget: false,
      costBudget: false,
      usage: true,
      cost: false,
      toolPolicy: false,
      streamsOutput: true,
    },
    {
      structuredOutput: false,
      promptTransport: "argv",
      maxArgvPromptBytes: 128 * 1024,
      sandbox: false,
      permissions: false,
      continuation: true,
      tokenBudget: false,
      costBudget: false,
      usage: true,
      cost: false,
      toolPolicy: false,
      streamsOutput: false,
    },
    {
      structuredOutput: true,
      promptTransport: "stdin",
      sandbox: true,
      permissions: false,
      continuation: false,
      tokenBudget: false,
      costBudget: false,
      usage: true,
      cost: false,
      toolPolicy: false,
      streamsOutput: true,
    },
    {
      structuredOutput: true,
      promptTransport: "stdin",
      sandbox: false,
      permissions: false,
      continuation: true,
      tokenBudget: true,
      costBudget: false,
      usage: true,
      cost: true,
      toolPolicy: false,
      streamsOutput: false,
    },
  ];
  for (let index = 0; index < runtimes.length; index += 1) {
    const capabilities = harnessCapabilities(runtimes[index]);
    assert.deepEqual(capabilities, expected[index]);
    assert.ok(Object.keys(capabilities).includes("tokenBudget"));
    assert.ok(Object.keys(capabilities).includes("costBudget"));
    assert.deepEqual(JSON.parse(JSON.stringify(capabilities)), expected[index]);
  }
});

test("provider adapters declare the permission modes that execute commands and their defaults", () => {
  assert.deepEqual(resolvePermissionExecution({ harness: "claude" }), {
    executes: false,
    field: "permissionMode",
    mode: "acceptEdits",
    executingModes: ["bypassPermissions"],
  });
  assert.equal(resolvePermissionExecution({ harness: "claude", permissionMode: "bypassPermissions" }).executes, true);
  assert.deepEqual(resolvePermissionExecution({ harness: "zcode" }), {
    executes: true,
    field: "permissionMode",
    mode: "yolo",
    executingModes: ["yolo"],
  });
  assert.equal(resolvePermissionExecution({ harness: "zcode", permissionMode: "edit" }).executes, false);
  // Measured 2026-09-11 by running a dsh worker at the harness default: it
  // executed `printf ... > exec-probe.txt` through the shell and the file
  // reached the integrated commit. Declaring only danger-full-access rejected
  // the very contract that attested the harness.
  assert.deepEqual(resolvePermissionExecution({ harness: "dsh" }), {
    executes: true,
    field: "sandbox",
    mode: "workspace-write",
    executingModes: ["workspace-write", "danger-full-access"],
  });
  assert.equal(resolvePermissionExecution({ harness: "dsh", sandbox: "danger-full-access" }).executes, true);
  assert.equal(resolvePermissionExecution({ harness: "dsh", sandbox: "read-only" }).executes, false);
  assert.deepEqual(resolvePermissionExecution({ harness: "codex" }), {
    executes: true,
    field: "sandbox",
    mode: "workspace-write",
    executingModes: ["read-only", "workspace-write", "danger-full-access"],
  });
  for (const harness of ["agy", "exec-jsonl", "replay"]) {
    assert.deepEqual(resolvePermissionExecution({ harness }), {
      executes: true,
      field: null,
      mode: null,
      executingModes: [],
    });
  }
});

test("stdin adapters keep prompts out of argv and argv adapters enforce byte limits", () => {
  const prompt = "prompt with spaces";
  for (const runtime of [
    { harness: "codex", model: "m" },
    { harness: "claude", model: "m" },
    { harness: "exec-jsonl", model: "m", executable: "wrapper" },
  ]) {
    const command = providerCommand(runtime, prompt);
    assert.equal(command.promptTransport, "stdin");
    assert.equal(command.input?.includes(prompt) ?? false, true);
    assert.equal(command.args.includes(prompt), false);
  }
  const argv = providerCommand({ harness: "agy", model: "m", maxArgvPromptBytes: 4 }, "é");
  assert.equal(argv.promptTransport, "argv");
  assert.throws(
    () => providerCommand({ harness: "agy", model: "m", maxArgvPromptBytes: 1 }, "é"),
    /argv limit/u,
  );
});

test("Codex continuation uses exec resume with the session id and prompt", () => {
  const command = providerCommand({ harness: "codex", model: "m", sandbox: "read-only" }, "continue this", { continuationId: "thread-1" });
  assert.equal(command.promptTransport, "argv");
  assert.equal(command.input, null);
  assert.deepEqual(command.args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.equal(command.args.includes("--sandbox"), false, "resume inherits the sandbox from its original session");
  assert.deepEqual(command.args.slice(-2), ["thread-1", "continue this"]);
  assert.equal(command.args.at(-1), "continue this");
});

test("Claude continuation resumes the explicit session", () => {
  const command = providerCommand({ harness: "claude", model: "m" }, "continue this", {
    continuationId: "session-1",
  });
  assert.equal(command.promptTransport, "stdin");
  assert.equal(command.input, "continue this");
  assert.equal(command.args.includes("continue this"), false);
  assert.deepEqual(command.args.slice(0, 4), ["-p", "--resume", "session-1", "--model"]);
  assert.equal(command.args.includes("--continue"), false);
  assert.equal(command.args.includes("--max-budget-usd"), false);
});

test("agy continuation uses the explicit conversation and preserves equals-form argv transport", () => {
  const command = providerCommand({ harness: "agy", model: "m" }, "continue this", {
    continuationId: "conversation-1",
  });
  assert.equal(command.promptTransport, "argv");
  assert.ok(command.args.includes("--conversation=conversation-1"));
  assert.ok(command.args.includes("--print=continue this"));
  assert.equal(command.args.some((arg) => arg === "--conversation" || arg === "--continue"), false);
});

test("generic exec-jsonl emits the documented normalized request", () => {
  const command = providerCommand({ harness: "exec-jsonl", model: "pi", executable: "pi-wrapper" }, "hello", {
    schema: { type: "object" },
  });
  assert.ok(command.input, "stdin transport provides input");
  const request = JSON.parse(command.input);
  assert.deepEqual(EXEC_JSONL_PROTOCOL, {
    schemaVersion: 1,
    requestType: "run.request",
    completedType: "run.completed",
    failedType: "run.failed",
  });
  assert.deepEqual(request, {
    schemaVersion: 1,
    type: "run.request",
    model: "pi",
    prompt: "hello",
    structuredOutput: true,
    outputSchema: { type: "object" },
    continuationId: null,
  });
});

test("Codex rollout-budget exhaustion is a provider exhaustion event", () => {
  const result = normalizeProviderResult("codex", [
    { type: "thread.started", thread_id: "bounded-thread" },
    { type: "turn.failed", error: { message: "shared rollout token budget exhausted" } },
  ].map((event) => JSON.stringify(event)).join("\n"), 1, null);
  assert.equal(result.status, "exhausted");
  assert.equal(result.continuationId, "bounded-thread");
});

test("quota exhaustion routes through the declared failover edge (normalizer)", () => {
  // N05: the Z.ai weekly limit refusal. The incident was recorded on a
  // Claude-compatible CLI pinned to Z.ai; the wording is the vendor's own and
  // reaches the ZCode harness the same way, before any result object. The
  // envelope must be exhausted so the declared failover edge fires.
  const zcodeQuota = normalizeProviderResult("zcode", "", 1, null, {
    stderr: "API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-04 21:44:15][Request was not sent]\n",
  });
  assert.equal(zcodeQuota.status, "exhausted");
  assert.equal(zcodeQuota.error?.code, "quota_exhausted");
  assert.match(zcodeQuota.error?.message ?? "", /2026-09-04 21:44:15/u);

  // N05's codex equivalent: a turn.failed carrying the usage-limit text.
  const codexQuota = normalizeProviderResult("codex", [
    { type: "thread.started", thread_id: "quota-thread" },
    { type: "turn.failed", error: { message: "You've hit your usage limit. Please try again at 12:58 PM" } },
  ].map((event) => JSON.stringify(event)).join("\n"), 1, null);
  assert.equal(codexQuota.status, "exhausted");
  assert.equal(codexQuota.error?.code, "quota_exhausted");
  assert.match(codexQuota.error?.message ?? "", /usage limit/u);
  assert.equal(codexQuota.continuationId, "quota-thread");

  // Unrelated provider failures stay ordinary provider errors.
  const unrelated = normalizeProviderResult("codex", [
    { type: "thread.started", thread_id: "unrelated-thread" },
    { type: "turn.failed", error: { message: "connection reset by peer" } },
  ].map((event) => JSON.stringify(event)).join("\n"), 1, null);
  assert.equal(unrelated.status, "failed");
  assert.equal(unrelated.error?.code, "provider_error");
  assert.equal(unrelated.continuationId, "unrelated-thread");
});

test("DeepSeek's 402 insufficient-balance stop is its own availability reason, distinct from quota and auth", () => {
  const codexBalance = normalizeProviderResult("codex", [
    { type: "thread.started", thread_id: "balance-thread" },
    { type: "turn.failed", error: { message: "402 Insufficient Balance" } },
  ].map((event) => JSON.stringify(event)).join("\n"), 1, null);
  assert.equal(codexBalance.status, "failed", "no reset instant makes this an ordinary failure, not exhaustion");
  const availability = normalizeProviderAvailability("codex", codexBalance);
  assert.deepEqual(availability, { available: false, exhaustedUntil: null, reason: "insufficient_balance" });
  assert.notEqual(availability.reason, "quota_exhausted");
  assert.notEqual(availability.reason, "authentication_failed");

  // Wording alone, without the numeric code, still classifies correctly.
  const wordingOnly = normalizeProviderAvailability("codex", {
    status: "failed",
    error: { code: "provider_error", message: "Insufficient Balance" },
  });
  assert.deepEqual(wordingOnly, { available: false, exhaustedUntil: null, reason: "insufficient_balance" });
});

test("Anthropic's soft session-limit stop is exhausted with a reset, distinct from a hard resetless stop", () => {
  // Field defect #13: a phase-4 take hit an Anthropic session limit whose
  // error text reads exactly like a hard quota stop; only the reset instant
  // it carries proves it is retryable-after-reset rather than terminal.
  const anthropicSoftLimit = [
    {
      type: "assistant",
      is_api_error_message: true,
      message: { content: [{ type: "text", text: "Claude AI usage limit reached. Your limit will reset at 2026-09-08 20:30:00" }] },
    },
    {
      type: "result",
      result: "Claude AI usage limit reached. Your limit will reset at 2026-09-08 20:30:00",
      is_error: true,
      terminal_reason: "api_error",
      session_id: "soft-limit-session",
      usage: { input_tokens: 4, output_tokens: 1 },
    },
  ].map((event) => JSON.stringify(event)).join("\n");
  const envelope = normalizeProviderResult("claude", anthropicSoftLimit, 1, null);
  assert.equal(envelope.status, "exhausted", "a soft session limit is exhaustion, not a terminal failure");
  assert.equal(envelope.error?.code, "quota_exhausted");
  assert.match(envelope.error?.message ?? "", /2026-09-08 20:30:00/u);
  assert.equal(envelope.continuationId, "soft-limit-session");

  const softLimit = normalizeProviderAvailability("claude", envelope);
  assert.equal(softLimit.available, false);
  assert.equal(softLimit.reason, "quota_exhausted");
  assert.equal(softLimit.exhaustedUntil, "2026-09-08T20:30:00.000Z", "the reset instant is parsed from the error text, proving this is retryable-after-reset");

  // The prior node's DeepSeek fixture is the hard, resetless counterpart: both
  // are unavailable, but only the soft limit reports a reset to wait out.
  const hardStop = normalizeProviderAvailability("codex", {
    status: "failed",
    error: { code: "provider_error", message: "402 Insufficient Balance" },
  });
  assert.equal(hardStop.reason, "insufficient_balance");
  assert.equal(hardStop.exhaustedUntil, null, "a hard balance stop has no reset instant to report");
  assert.notEqual(softLimit.exhaustedUntil, hardStop.exhaustedUntil);
});

test("codex normalizer tolerates a bounded tail starting inside an event line", () => {
  const partial = `rted","command":"/bin/zsh -lc 'cat file'"}`;
  const events = [
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
  ];
  const stream = `${partial}\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const result = normalizeProviderResult("codex", stream, 0, null);
  assert.equal(result.status, "done");
  assert.equal(result.result, "ok");
  const invalid = normalizeProviderResult("codex", `${partial}\nnot json at all\n`, 0, null);
  assert.equal(invalid.status, "failed");
});

test("Codex keeps a started thread id on provider failure and cancellation", () => {
  const failed = normalizeProviderResult("codex", [
    { type: "thread.started", thread_id: "failed-thread" },
    { type: "turn.failed", error: { message: "quota" } },
  ].map((event) => JSON.stringify(event)).join("\n"), 1, null);
  assert.equal(failed.continuationId, "failed-thread");
  const canceled = normalizeProviderResult("codex", JSON.stringify({ type: "thread.started", thread_id: "canceled-thread" }), null, "SIGTERM");
  assert.equal(canceled.continuationId, "canceled-thread");
});

test("all adapter normalizers return the common envelope", () => {
  const streams = {
    codex: [
      { type: "item.completed", item: { type: "agent_message", text: "codex" } },
      { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
    ],
    claude: [{ type: "result", result: "claude", session_id: "c", usage: { input_tokens: 2 } }],
    agy: [{ event: "result", result: { status: "SUCCESS", response: "agy", conversation_id: "a", usage: {} } }],
    "exec-jsonl": [{ schemaVersion: 1, type: "run.completed", result: { answer: 1 }, continuationId: "e", usage: { inputTokens: 3 } }],
  };
  for (const [harness, events] of Object.entries(streams)) {
    const result = normalizeProviderResult(harness, events.map((event) => JSON.stringify(event)).join("\n"), 0, null);
    assert.equal(result.status, "done");
    assert.equal(typeof result.result, "string");
    assert.ok(result.usage);
  }
  assert.equal(normalizeProviderResult("exec-jsonl", JSON.stringify({ schemaVersion: 99, type: "run.completed", result: "x" }), 0, null).status, "failed");
});

test("preflight reports executable, model, version, and no credential values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-harness-version-"));
  const executable = join(directory, "versioned-wrapper.mjs");
  writeFileSync(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('wrapper 2.4.1');\n");
  chmodSync(executable, 0o755);
  const check = await probeRuntime({
    id: "wrapper-runtime",
    harness: "exec-jsonl",
    model: "pi-model",
    executable,
  }, { cwd: directory, requiredCapabilities: { promptTransport: "stdin" } });
  assert.equal(check.ok, true, check.detail ?? undefined);
  assert.equal(check.executable, executable);
  assert.equal(check.model, "pi-model");
  assert.equal(check.version, "wrapper 2.4.1");
  assert.equal(check.requiredCapabilities.promptTransport, "stdin");
});

test("preflight still probes and reports version when an environment variable is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-harness-missing-env-"));
  const executable = join(directory, "versioned-wrapper.mjs");
  writeFileSync(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('wrapper 3.1.4');\n");
  chmodSync(executable, 0o755);
  const envName = "INTENT_FACTORY_TEST_REQUIRED_ENV_4F8D";
  const previous = process.env[envName];
  delete process.env[envName];
  try {
    const check = await probeRuntime({
      id: "wrapper-runtime",
      harness: "exec-jsonl",
      model: "pi-model",
      executable,
      config: { "provider.env_key": envName },
    }, { cwd: directory });
    assert.equal(check.ok, false);
    assert.equal(check.harness, "exec-jsonl");
    assert.equal(check.executable, executable);
    assert.equal(check.model, "pi-model");
    assert.equal(check.version, "wrapper 3.1.4");
    assert.match(check.detail ?? "", /missing environment variable INTENT_FACTORY_TEST_REQUIRED_ENV_4F8D/u);
    assert.doesNotMatch(check.detail ?? "", /secret-value/u);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("preflight classifies a non-zero exit by its stderr text: balance, quota with reset, and a missing binary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-harness-availability-"));

  const balanceExecutable = join(directory, "balance-wrapper.mjs");
  writeFileSync(balanceExecutable, "#!/usr/bin/env node\nprocess.stderr.write('Error: Insufficient Balance\\n');\nprocess.exit(1);\n");
  chmodSync(balanceExecutable, 0o755);
  const balance = await probeRuntime({ id: "balance-runtime", harness: "exec-jsonl", model: "m", executable: balanceExecutable }, { cwd: directory });
  assert.equal(balance.ok, false);
  assert.deepEqual(balance.availability, { available: false, exhaustedUntil: null, reason: "insufficient_balance" });

  const quotaExecutable = join(directory, "quota-wrapper.mjs");
  writeFileSync(quotaExecutable, "#!/usr/bin/env node\nprocess.stderr.write('Error: rate limit exceeded. Your limit will reset at 2026-01-01 00:00:00\\n');\nprocess.exit(1);\n");
  chmodSync(quotaExecutable, 0o755);
  const quota = await probeRuntime({ id: "quota-runtime", harness: "exec-jsonl", model: "m", executable: quotaExecutable }, { cwd: directory });
  assert.equal(quota.ok, false);
  assert.deepEqual(quota.availability, { available: false, exhaustedUntil: "2026-01-01T00:00:00.000Z", reason: "quota_exhausted" });

  const missing = await probeRuntime({ id: "missing-runtime", harness: "exec-jsonl", model: "m", executable: join(directory, "does-not-exist") }, { cwd: directory });
  assert.equal(missing.ok, false);
  assert.equal(missing.availability?.reason, "not_found");
  assert.equal(missing.availability?.exhaustedUntil, null);
});

test("generic exec-jsonl rejects unknown fields, bad ordering, and multiple terminals", () => {
  const valid = { schemaVersion: 1, type: "run.completed", result: "ok" };
  /** @type {[unknown, RegExp][]} */
  const cases = [
    [{ schemaVersion: 1, type: "unknown" }, /unknown/u],
    [{ ...valid, typo: true }, /unexpected field typo/u],
    [
      [{ schemaVersion: 1, type: "run.completed", result: "ok" }, { schemaVersion: 1, type: "message", text: "late" }],
      /terminal event must be last/u,
    ],
    [
      [{ schemaVersion: 1, type: "run.completed", result: "ok" }, { schemaVersion: 1, type: "run.failed", error: { code: "x", message: "bad" } }],
      /multiple terminal/u,
    ],
    [{ schemaVersion: 1, type: "run.completed" }, /result is required/u],
  ];
  for (const [events, expected] of cases) {
    const stream = Array.isArray(events) ? events : [events];
    const result = normalizeExecJsonlResult(stream.map((event) => JSON.stringify(event)).join("\n"), 0, null);
    assert.equal(result.status, "failed");
    assert.ok(result.error, "protocol error recorded");
    assert.equal(result.error.code, "invalid_protocol");
    assert.match(result.error.message, expected);
  }
  const failed = normalizeExecJsonlResult(JSON.stringify({
    schemaVersion: 1,
    type: "run.failed",
    error: { code: "provider_error", message: "nope" },
  }), 0, null);
  assert.ok(failed.error, "provider error recorded");
  assert.equal(failed.error.code, "provider_error");
});

test("version probing requires a semantic version token", () => {
  assert.equal(parseVersion("READY"), null);
  assert.equal(parseVersion('{"version":"1.2.3"}'), null);
  assert.equal(parseVersion("wrapper 2.4.1"), "wrapper 2.4.1");
});
test("routes explicit, matching, and default runtimes", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-route-"));
  const path = writeContract(directory, fixture());
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(routeRuntime(contract, { id: "a", type: "frontend", gate: {} }).id, "luna");
  assert.equal(routeRuntime(contract, { id: "b", type: "mechanic", gate: {} }).id, "luna");
  assert.equal(routeRuntime(contract, { id: "c", type: "backend", gate: {} }).id, "luna");
  assert.equal(routeRuntime(contract, { id: "d", type: "backend", runtime: "opus", gate: {} }).id, "opus");
});

test("builds custom provider config as command-line overrides", () => {
  /** @type {Record<string, unknown>} */
  const flash = /** @type {Record<string, Record<string, unknown>>} */ (fixture().runtimes).flash;
  const command = providerCommand({ ...flash, harness: "codex", model: "deepseek-v4-flash", sandbox: "danger-full-access" }, "task");
  assert.equal(command.executable, "codex");
  assert.deepEqual(command.args.slice(0, 4), ["exec", "--json", "--sandbox", "danger-full-access"]);
  assert.ok(command.args.includes("model_provider=\"deepseek\""));
  assert.ok(command.args.includes("model=\"deepseek-v4-flash\""));
  assert.ok(command.args.includes("model_providers.deepseek.env_key=\"DEEPSEEK_API_KEY\""));
  assert.ok(!command.args.includes("--profile"));
});

test("builds agy commands with unambiguous equals-form flags", () => {
  const command = providerCommand(
    { harness: "agy", model: "gemini-3.7-flash-low", reasoning: "xhigh", printTimeout: "30m" },
    "task with spaces",
    { schema: JUDGE_SCHEMA },
  );
  assert.equal(command.executable, "agy");
  assert.ok(command.args.includes("--model=gemini-3.7-flash-low"));
  assert.ok(command.args.includes("--effort=high"));
  assert.ok(command.args.includes("--print-timeout=30m"));
  assert.ok(command.args.includes(`--json-schema=${JSON.stringify(JUDGE_SCHEMA)}`));
  assert.ok(command.args.includes("--print=task with spaces"));
});

test("accepts a zcode runtime in contracts and routes nodes to it", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-zcode-contract-"));
  const value = fixture();
  /** @type {Record<string, Record<string, unknown>>} */
  const runtimes = /** @type {Record<string, Record<string, unknown>>} */ (value.runtimes);
  // guard-exempt: schema-only — validation and routing only, no spawn.
  runtimes["zcode-glm"] = { harness: "zcode", model: "glm-5.3[1m]", config: { "auth_token.env_key": "ZAI_API_KEY" } };
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes["zcode-glm"].harness, "zcode");
  assert.equal(routeRuntime(contract, { id: "g", type: "backend", runtime: "zcode-glm", gate: {} }).id, "zcode-glm");
});

test("uses provider-compatible explicit types in the judge schema", () => {
  assert.equal(JUDGE_SCHEMA.properties.verdict.type, "string");
  assert.equal(JUDGE_SCHEMA.properties.maxSeverity.type, "string");
  assert.equal(JUDGE_SCHEMA.properties.findings.items.properties.severity.type, "string");
});

test("rejects an invalid Codex sandbox", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-sandbox-"));
  const value = fixture();
  /** @type {Record<string, Record<string, unknown>>} */
  const runtimes = /** @type {Record<string, Record<string, unknown>>} */ (value.runtimes);
  runtimes.flash.sandbox = "unrestricted";
  const path = writeContract(directory, value);
  assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /sandbox is invalid/u);
});

test("normalizes Codex, streaming Claude, and agy results", () => {
  const codex = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(normalizeProviderResult("codex", codex, 0, null).status, "done");

  const claude = [
    { type: "system", subtype: "init" },
    { type: "result", result: "ok", is_error: false, session_id: "session", usage: { input_tokens: 3 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(normalizeProviderResult("claude", claude, 0, null).continuationId, "session");

  const agy = [
    { event: "init", conversation_id: "conversation" },
    {
      event: "result",
      result: {
        conversation_id: "conversation",
        status: "SUCCESS",
        response: "ok",
        usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 3 },
      },
    },
  ].map((event) => JSON.stringify(event)).join("\n");
  const normalizedAgy = normalizeProviderResult("agy", agy, 0, null);
  assert.equal(normalizedAgy.status, "done");
  assert.equal(normalizedAgy.result, "ok");
  assert.equal(normalizedAgy.continuationId, "conversation");
  assert.equal(normalizedAgy.usage.cacheReadInputTokens, 3);
});

test("a completed Codex turn with a final message is done regardless of the exit code", () => {
  const finished = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "error", message: "benign under-development warning" } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "worker complete" }) } },
    { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1, cached_input_tokens: 3 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const done = normalizeProviderResult("codex", finished, 1, null);
  assert.equal(done.status, "done", "the turn completed with a final message; the exit code is about the harness");
  assert.equal(done.continuationId, "thread");
  assert.equal(done.usage.inputTokens, 1);
  assert.equal(done.usage.cacheReadInputTokens, 3);
  assert.equal(done.error, null);
  const emptyMessage = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "" } },
    { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1, cached_input_tokens: 3 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const noOp = normalizeProviderResult("codex", emptyMessage, 1, null);
  assert.equal(noOp.status, "no-op", "an empty final message on a completed turn normalizes to no-op, not provider_error");
  assert.equal(noOp.error, null);

  const failedTurn = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "partial work" } },
    { type: "turn.failed", error: { message: "deliberate failure" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const failed = normalizeProviderResult("codex", failedTurn, 1, null);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "provider_error");
  assert.match(failed.error?.message ?? "", /deliberate failure/u);

  const noTerminal = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "still working" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const incomplete = normalizeProviderResult("codex", noTerminal, 1, null);
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.error?.code, "incomplete_stream");
  assert.match(incomplete.error?.message ?? "", /no turn.completed/u);

  const exitedWithoutMessage = [
    { type: "thread.started", thread_id: "thread" },
    { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const harnessDeath = normalizeProviderResult("codex", exitedWithoutMessage, 1, null);
  assert.equal(harnessDeath.status, "failed");
  assert.equal(harnessDeath.error?.code, "provider_error");
  assert.match(harnessDeath.error?.message ?? "", /Codex exited with code 1/u, "a non-zero exit without any final message still reports the harness failure");
});

test("codex tool host failure is a provider failure, never a result", () => {
  const stream = [
    { type: "thread.started", thread_id: "tool-host-thread" },
    { type: "item.completed", item: { id: "item_tool_host", type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "fabricated", findings: [] }) } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "fail", maxSeverity: "major", summary: "could not be inspected", findings: [] }) } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const envelope = normalizeProviderResult("codex", stream, 0, null, { preferStructured: true });
  assert.equal(envelope.status, "failed", "a disabled code-mode host fails closed even when the turn completed");
  assert.equal(envelope.result, null);
  assert.equal(envelope.error?.code, "tool_host_unavailable");
  assert.match(envelope.error?.message ?? "", /code-mode host is disabled/u);
  assert.equal(envelope.continuationId, "tool-host-thread");
  assert.deepEqual(envelope.usage, { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3 });

  const benign = [
    { type: "thread.started", thread_id: "benign-thread" },
    { type: "item.completed", item: { type: "error", message: "Under-development features enabled: rollout_budget" } },
    { type: "item.completed", item: { type: "error", message: "Model metadata for `deepseek-v4-flash` not found" } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "worker complete" }) } },
    { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const untouched = normalizeProviderResult("codex", benign, 0, null);
  assert.equal(untouched.status, "done", "rollout_budget and model-metadata error items stay ignored");
});

test("codex tool host failure is classified before a termination signal, never as canceled", () => {
  const stream = [
    { type: "thread.started", thread_id: "tool-host-thread" },
    { type: "item.completed", item: { id: "item_tool_host", type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "fabricated", findings: [] }) } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const envelope = normalizeProviderResult("codex", stream, null, "SIGTERM", { preferStructured: true });
  assert.equal(envelope.status, "failed", "the tool-host failure wins over the termination signal and stays a provider failure");
  assert.equal(envelope.result, null);
  assert.equal(envelope.error?.code, "tool_host_unavailable");
  assert.equal(envelope.continuationId, "tool-host-thread");
  assert.deepEqual(envelope.usage, { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3 });

  const plainKill = normalizeProviderResult("codex", JSON.stringify({ type: "thread.started", thread_id: "canceled-thread" }), null, "SIGTERM");
  assert.equal(plainKill.status, "canceled", "a signal without a tool-host error still cancels");
  assert.equal(plainKill.error?.code, "canceled");
});

test("bounded codex diagnostics never exceed 512 UTF-8 bytes", () => {
  const filler = "診".repeat(400);
  const hostDisabled = [
    { type: "thread.started", thread_id: "utf8-tool-host-thread" },
    { type: "item.completed", item: { type: "error", message: `${filler} Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed.` } },
    { type: "item.completed", item: { type: "agent_message", text: "fabricated" } },
    { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const toolHost = normalizeProviderResult("codex", hostDisabled, 0, null);
  assert.equal(toolHost.error?.code, "tool_host_unavailable");
  assert.ok(Buffer.byteLength(toolHost.error?.message ?? "", "utf8") <= 512, `tool-host message is ${Buffer.byteLength(toolHost.error?.message ?? "", "utf8")} UTF-8 bytes`);
  assert.ok(!/[\uFFFD]/u.test(toolHost.error?.message ?? ""), "the truncation never leaves a dangling multibyte sequence");

  const quota = [
    { type: "thread.started", thread_id: "utf8-quota-thread" },
    { type: "turn.failed", error: { message: `${filler} quota exceeded for this billing cycle` } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const quotaEnvelope = normalizeProviderResult("codex", quota, 1, null);
  assert.equal(quotaEnvelope.error?.code, "quota_exhausted");
  assert.ok(Buffer.byteLength(quotaEnvelope.error?.message ?? "", "utf8") <= 512, `quota message is ${Buffer.byteLength(quotaEnvelope.error?.message ?? "", "utf8")} UTF-8 bytes`);
  assert.ok(!/[\uFFFD]/u.test(quotaEnvelope.error?.message ?? ""), "the truncation never leaves a dangling multibyte sequence");
});

test("codex preamble diet keeps the code-mode host enabled", () => {
  assert.ok(!CODEX_PREAMBLE_OVERRIDES.some((override) => override.includes("code_mode_host")), "the code-mode host override was removed");
  for (const override of ["features.browser_use=false", "features.multi_agent=false", "mcp_servers={}", "plugins={}"]) {
    assert.ok(CODEX_PREAMBLE_OVERRIDES.includes(override), `${override} is still part of the diet`);
  }
});

test("codex preamble measurement comment pins the four code-mode-host outcomes", () => {
  const source = readFileSync(new URL("../src/harnesses/codex/index.mjs", import.meta.url), "utf8");
  const declaration = "export const CODEX_PREAMBLE_OVERRIDES";
  const symbolIndex = source.indexOf(declaration);
  assert.ok(symbolIndex !== -1, "codex.mjs must keep exporting CODEX_PREAMBLE_OVERRIDES");
  const head = source.slice(0, symbolIndex);
  const blockStart = head.lastIndexOf("/**") + 3;
  const blockEnd = head.indexOf("*/", blockStart);
  const comment = head
    .slice(blockStart, blockEnd)
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, "").trim())
    .filter(Boolean)
    .join(" ");
  for (const outcome of [
    "gpt-5.6-sol with the host disabled used 35,130 input tokens and fabricated its verdict",
    "versus 35,199 with the host enabled and a correct tool-backed verdict",
    "deepseek-v4-flash used 25,795 with the host disabled and 25,783 with the host enabled, both correct",
  ]) {
    assert.ok(comment.includes(outcome), `the CODEX_PREAMBLE_OVERRIDES measurement comment must record: ${outcome}`);
  }
});

test("surfaces agy result errors", () => {
  const stream = JSON.stringify({
    event: "result",
    result: { status: "ERROR", response: "", error: "model unavailable", usage: {} },
  });
  const result = normalizeProviderResult("agy", stream, 0, null);
  assert.equal(result.status, "failed");
  assert.ok(result.error, "agy error recorded");
  assert.equal(result.error.message, "model unavailable");
});

test("selects structured JSON from an agy response with progress prose", () => {
  const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
  const stream = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation",
      status: "SUCCESS",
      response: `Waiting for checks...\n${verdict}\n`,
      usage: {},
    },
  });
  assert.equal(
    normalizeProviderResult("agy", stream, 0, null, { preferStructured: true }).result,
    verdict,
  );
});

test("selects the last valid JSON block for a Codex judge", () => {
  const verdict = JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "advisory", findings: [
    { severity: "minor", description: "cleanup", evidence: "line 1" },
  ] });
  const stream = [
    { type: "item.completed", item: { type: "agent_message", text: `Review complete.\n\n\`\`\`json\n${verdict}\n\`\`\`` } },
    { type: "item.completed", item: { type: "agent_message", text: "Temporary files are harmless." } },
    { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(normalizeProviderResult("codex", stream, 0, null).result, "Temporary files are harmless.");
  const envelope = normalizeProviderResult("codex", stream, 0, null, { preferStructured: true });
  assert.equal(envelope.result, verdict);
  assert.equal(envelope.judgeCandidates, 1, "prose around one verdict leaves the candidate count at one");
});

test("counts verdict-shaped codex agent messages at the provider boundary", () => {
  /** @param {string} summary */
  const verdict = (summary) => JSON.stringify({ verdict: "pass", maxSeverity: "none", summary, findings: [] });
  const two = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: verdict("first verdict") } },
    { type: "item.completed", item: { type: "agent_message", text: "Let me reconsider." } },
    { type: "item.completed", item: { type: "agent_message", text: verdict("second verdict") } },
    { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const twoEnvelope = normalizeProviderResult("codex", two, 0, null, { preferStructured: true });
  assert.equal(twoEnvelope.judgeCandidates, 2, "two agent messages each carrying a verdict are two candidates");
  assert.equal(twoEnvelope.status, "done", "multiplicity is a review-protocol defect, not a provider failure");
  assert.ok(typeof twoEnvelope.result === "string");
  assert.equal(JSON.parse(twoEnvelope.result).summary, "second verdict", "the last candidate is still the selected one");

  const single = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: "Notes on the diff." } },
    { type: "item.completed", item: { type: "agent_message", text: verdict("clean") } },
    { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const singleEnvelope = normalizeProviderResult("codex", single, 0, null, { preferStructured: true });
  assert.equal(singleEnvelope.judgeCandidates, 1, "prose messages are not verdict candidates");

  const nearMiss = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "PASS", summary: "shouty" }) } },
    { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const nearMissEnvelope = normalizeProviderResult("codex", nearMiss, 0, null, { preferStructured: true });
  assert.equal(nearMissEnvelope.judgeCandidates, 0, "an object without a pass-or-fail verdict is not a candidate");
  assert.equal(nearMissEnvelope.status, "done", "the turn finished; the candidate count is what the review protocol reads");

  const worker = [
    { type: "thread.started", thread_id: "thread" },
    { type: "item.completed", item: { type: "agent_message", text: verdict("clean") } },
    { type: "item.completed", item: { type: "agent_message", text: verdict("again") } },
    { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(normalizeProviderResult("codex", worker, 0, null).judgeCandidates, undefined, "only judge rounds are counted");
});

test("normalizes Codex cached token naming", () => {
  const stream = [
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 8, cached_input_tokens: 5, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const usage = normalizeProviderResult("codex", stream, 0, null).usage;
  assert.equal(usage.inputTokens, 3, "Codex input_tokens already includes cached input");
  assert.equal(usage.cacheReadInputTokens, 5);
});

test("normalizes separate Claude cache reads and cache writes without overlap", () => {
  const stream = JSON.stringify({
    type: "result",
    result: "ok",
    session_id: "session",
    usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 1 },
  });
  assert.deepEqual(normalizeProviderResult("claude", stream, 0, null).usage, {
    inputTokens: 5,
    outputTokens: 1,
    cacheReadInputTokens: 5,
  });
});

test("live metering reads cumulative Codex usage from a growing transcript", () => {
  const stream = [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.completed", usage: { input_tokens: 400, output_tokens: 10 } },
    { type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 30 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(liveInputTokens("codex", stream), 1200);
  assert.equal(liveInputTokens("codex", `${stream}\n{"type":"turn.compl`), 1200, "partial trailing line is ignored");
  assert.equal(liveInputTokens("codex", "not json at all"), 0);
});

test("live metering separates and weights cached reads like the campaign ledger", () => {
  const stream = [
    { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1800, output_tokens: 10 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(liveUsage("codex", stream), { inputTokens: 200, cacheReadInputTokens: 1800 }, "uncached and cached components");
  assert.equal(liveInputTokens("codex", stream, 0.1), 380, "cached reads count at the weighted rate");
  assert.equal(liveInputTokens("codex", stream), 2000, "default weight meters the raw total");
  const allCache = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1800, cached_input_tokens: 1800 } });
  assert.equal(liveInputTokens("codex", allCache, 0.1), 180, "fully cached input meters at the weighted rate");
});

test("live metering sums per-request Claude usage and prefers the terminal total", () => {
  const partial = [
    { type: "assistant", message: { usage: { input_tokens: 100 } } },
    { type: "assistant", message: { usage: { input_tokens: 250 } } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(liveInputTokens("claude", partial), 350, "mid-run sum of per-request usage");
  const terminal = `${partial}\n${JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 320 } })}`;
  assert.equal(liveInputTokens("claude", terminal), 320, "terminal session total wins");
  assert.equal(liveInputTokens("exec-jsonl", partial), 0, "completion-only harnesses meter as zero mid-run");
});

test("live session metrics expose only what each harness's events prove", () => {
  const codexEvents = [
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 300 } },
    { type: "item.completed", item: { type: "tool_call" } },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 700 } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "done" }) } },
    { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 900 } },
  ];
  const codex = codexEvents.map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("codex", codex),
    { turns: 3, cacheReadInputTokens: 900, toolCalls: 2, completed: true },
    "Codex turn completions, cumulative cache-read maximum, tool items, and the terminal turn that ends with the result message",
  );
  const midSession = codexEvents.slice(0, 6).map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("codex", midSession),
    { turns: 2, cacheReadInputTokens: 700, toolCalls: 2, completed: false },
    "a turn.completed that does not end with the result-carrying message is not a completed invocation",
  );
  assert.deepEqual(
    liveSessionMetrics("codex", `${codex}\n{"type":"turn.compl`),
    { turns: 3, cacheReadInputTokens: 900, toolCalls: 2, completed: true },
    "a partial trailing line is ignored",
  );
  const claude = [
    { type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 40 }, content: [{ type: "tool_use" }, { type: "tool_use" }, { type: "text", text: "working" }] } },
    { type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20 }, content: [] } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("claude", claude),
    { turns: 2, cacheReadInputTokens: 60, toolCalls: 2, completed: false },
    "assistant turns, summed per-request cache reads, and tool_use blocks",
  );
  const terminal = `${claude}\n${JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 15, cache_read_input_tokens: 90 } })}`;
  assert.deepEqual(
    liveSessionMetrics("claude", terminal),
    { turns: 2, cacheReadInputTokens: 90, toolCalls: 2, completed: true },
    "the terminal session total wins over the mid-run sum and the result record folds completion",
  );
  const execJsonl = JSON.stringify({ schemaVersion: 1, type: "run.completed", result: "ok", continuationId: null, usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 7 }, costUsd: null });
  assert.deepEqual(
    liveSessionMetrics("exec-jsonl", execJsonl),
    { turns: 1, cacheReadInputTokens: 7, toolCalls: 0, completed: true },
    "the protocol carries no tool events, so only a completed run proves a turn",
  );
  assert.deepEqual(liveSessionMetrics("codex", "not json at all"), { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false }, "malformed input meters as zero");
  assert.deepEqual(liveSessionMetrics("agy", codex), { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false }, "unsupported harnesses meter as zero");
});

test("the codex harness bounds the harness preamble before the runtime's own config overrides", () => {
  const args = providerCommand({ harness: "codex", model: "m", config: { "features.apps": true } }, "work").args;
  const pairs = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === "-c") pairs.push(args[index + 1]);
  for (const override of CODEX_PREAMBLE_OVERRIDES) assert.ok(pairs.includes(override), `${override} is emitted`);
  assert.ok(pairs.indexOf("features.apps=false") < pairs.indexOf("features.apps=true"), "runtime config comes later and therefore wins");
  const resumed = providerCommand({ harness: "codex", model: "m" }, "work", { continuationId: "thread-1" }).args;
  assert.ok(resumed.includes("features.multi_agent=false"), "resumed sessions are bounded the same way");
});

test("claude-compatible harnesses bound the harness preamble and accept a tools override", () => {
  for (const runtime of [{ harness: "claude", model: "m" }]) {
    const args = providerCommand(runtime, "work").args;
    const sources = args.indexOf("--setting-sources");
    assert.ok(args.includes("--disable-slash-commands"), `${runtime.harness} loads no skills`);
    assert.ok(args.includes("--strict-mcp-config"), `${runtime.harness} loads no MCP servers`);
    assert.equal(args[sources + 1], "", `${runtime.harness} loads no settings files`);
    assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", DEFAULT_CLAUDE_TOOLS.join(",")]);
    assert.equal(args.includes("--bare"), false, "--bare would disable the hook surface that enforces the tool policy");
    const custom = providerCommand({ ...runtime, tools: ["Read", "Bash"] }, "work").args;
    assert.deepEqual(custom.slice(custom.indexOf("--tools"), custom.indexOf("--tools") + 2), ["--tools", "Read,Bash"]);
    // The preamble flags precede the explicit hook settings, which still apply.
    const policed = providerCommand(runtime, "work", { toolPolicy: { foregroundOnly: true, maxToolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES } }).args;
    assert.ok(policed.indexOf("--setting-sources") < policed.indexOf("--settings"));
  }
});

test("toolPolicy travels only the Claude-compatible hook settings boundary", () => {
  const policy = { foregroundOnly: true, maxToolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES };
  // Claude-compatible adapters prove enforcement by installing hook settings.
  for (const runtime of [{ harness: "claude", model: "m" }]) {
    const command = providerCommand(runtime, "work", { toolPolicy: policy });
    const settingsIndex = command.args.indexOf("--settings");
    assert.ok(settingsIndex >= 0, `${runtime.harness} installs the hook settings`);
    const settings = JSON.parse(command.args[settingsIndex + 1]);
    assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "PreToolUse"]);
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash|TaskOutput|BashOutput|Monitor");
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(HOOK_PATH), "the repository hook executable is wired");
    assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes(HOOK_PATH));
  }
  // No offered policy means no fabricated settings.
  assert.equal(providerCommand({ harness: "claude", model: "m" }, "work").args.includes("--settings"), false);
  // An adapter that cannot prove enforcement receives no policy to pretend with.
  const request = JSON.parse(String(providerCommand({ harness: "exec-jsonl", model: "pi", executable: "pi-wrapper" }, "work", {
    toolPolicy: policy,
  }).input));
  assert.equal("toolPolicy" in request, false, "the exec-jsonl request carries no tool policy");
  assert.equal(providerCommand({ harness: "codex", model: "m" }, "work", { toolPolicy: policy }).args.includes("--settings"), false);
  assert.deepEqual(
    missingCapabilities(harnessCapabilities({ harness: "claude" }), { toolPolicy: true }),
    [],
    "the claude hook surface satisfies the requirement",
  );
  assert.deepEqual(
    missingCapabilities(harnessCapabilities({ harness: "exec-jsonl" }), { toolPolicy: true }),
    ["toolPolicy=true (harness provides toolPolicy=false)"],
    "capability requirements expose the missing toolPolicy honestly",
  );
});

test("truncateToolOutput bounds tool output to 8192 UTF-8 bytes keeping head and tail", () => {
  const tiny = "ls src\n";
  assert.equal(truncateToolOutput(tiny), tiny, "output within the bound is untouched");
  const ascii = `head-marker\n${"a".repeat(40_000)}\ntail-marker\n`;
  const boundedAscii = truncateToolOutput(ascii);
  assert.ok(Buffer.byteLength(boundedAscii, "utf8") <= TOOL_OUTPUT_LIMIT_BYTES, "bounded result never exceeds 8192 bytes");
  assert.match(boundedAscii, /^head-marker\n/u, "the head survives");
  assert.match(boundedAscii, /tail-marker\n$/u, "the tail survives");
  const omitted = /(\d+) bytes truncated/u.exec(boundedAscii);
  assert.ok(omitted, "the omission is quantified");
  assert.ok(Number(omitted[1]) > 0, "oversized input is actually truncated");
  // Multibyte output: a cut may never split a UTF-8 sequence.
  const greek = `γ-head\n${"α".repeat(6_000)}\nω-tail`;
  const boundedGreek = truncateToolOutput(greek);
  assert.ok(Buffer.byteLength(boundedGreek, "utf8") <= TOOL_OUTPUT_LIMIT_BYTES);
  assert.ok(!boundedGreek.includes("�"), "no replacement character from a split sequence");
  assert.match(boundedGreek, /^γ-head\n/u);
  assert.match(boundedGreek, /ω-tail$/u);
  // A 4-byte codepoint straddling the head cut lands whole on one side.
  const straddling = `${"b".repeat(4_088)}\u{1F680}${"c".repeat(9_000)}`;
  const boundedStraddle = truncateToolOutput(straddling);
  assert.ok(Buffer.byteLength(boundedStraddle, "utf8") <= TOOL_OUTPUT_LIMIT_BYTES);
  assert.ok(!boundedStraddle.includes("�"), "the astral codepoint is never split mid-sequence");
  assert.match(boundedStraddle, /ccc$/u, "the tail is preserved");
  assert.equal(Buffer.byteLength(truncateToolOutput("é", 1), "utf8") <= 1, true, "a tiny explicit limit still yields valid UTF-8");
});

test("the repository hook behind the providerCommand settings mechanically rejects background tools and bounds output", async () => {
  const policy = { foregroundOnly: true, maxToolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES };
  const command = providerCommand({ harness: "claude", model: "m" }, "work", { toolPolicy: policy });
  const settings = JSON.parse(command.args[command.args.indexOf("--settings") + 1]);
  const registered = [...settings.hooks.PreToolUse[0].hooks, ...settings.hooks.PostToolUse[0].hooks];
  assert.deepEqual(registered.map((hook) => hook.type), ["command", "command"]);
  const hookCommand = registered[0].command;
  assert.ok(hookCommand.includes(HOOK_PATH), "the exact repository hook executable is registered");
  assert.ok(hookCommand.includes("--foreground-only") && hookCommand.includes(`'${TOOL_OUTPUT_LIMIT_BYTES}'`), "the command carries the policy it enforces");

  // Run the registered command exactly as the provider would: one JSON payload
  // per invocation, one JSON decision (or silence) on stdout.
  /** @param {Record<string, unknown>} payload @returns {Promise<Record<string, any>|null>} */
  const runHook = (payload) => new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", hookCommand], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`hook exited with code ${code}`));
      else resolve(out.trim() ? JSON.parse(out) : null);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });

  assert.deepEqual(
    await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 1", run_in_background: true } }),
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: FOREGROUND_ONLY_DENIAL } },
    "a background Bash invocation is denied with the foreground retry reason",
  );
  assert.equal(
    await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi", run_in_background: false } }),
    null,
    "a foreground invocation passes through untouched",
  );
  assert.equal(
    (await runHook({ hook_event_name: "PreToolUse", tool_name: "BashOutput", tool_input: {} }))?.hookSpecificOutput?.permissionDecision,
    "deny",
    "a background-output tool is denied too",
  );
  assert.equal(
    await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: "not an object" }),
    null,
    "an unparsable invocation shape must never break the provider",
  );
  const bounded = await runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: `${"A".repeat(6_000)}${"é".repeat(2_048)}${"B".repeat(6_000)}`,
  });
  const output = String(bounded?.hookSpecificOutput?.updatedToolOutput ?? "");
  assert.equal(bounded?.hookSpecificOutput?.hookEventName, "PostToolUse");
  assert.ok(Buffer.byteLength(output, "utf8") <= TOOL_OUTPUT_LIMIT_BYTES, "the bounded result never exceeds 8192 bytes");
  assert.ok(!output.includes("�"), "the multibyte middle never splits a UTF-8 sequence");
  assert.match(output, /^A+/u, "the head survives");
  assert.match(output, /B+$/u, "the tail survives");
  assert.match(output, /bytes truncated/u, "the omission is quantified for the model");
  assert.equal(
    await runHook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "small" }),
    null,
    "a result within the bound is emitted unchanged",
  );
});

test("a stream with no completion event reports the process's own startup error", () => {
  // Exactly the shape a codex custom provider takes when its config is
  // rejected: it dies before emitting any event and explains itself on stderr.
  const configError = 'Error loading config.toml: model_providers.deepseek: provider name must not be empty';
  const withStderr = normalizeCodexResult("", 1, null, { stderr: `${configError}\n` });
  assert.equal(withStderr.status, "failed");
  assert.equal(withStderr.error?.code, "incomplete_stream");
  assert.match(
    withStderr.error?.message ?? "",
    /provider name must not be empty/u,
    "the diagnosis travels instead of only 'no turn.completed event'",
  );

  const withoutStderr = normalizeCodexResult("", 1, null, {});
  assert.equal(withoutStderr.error?.message, "Codex emitted no turn.completed event");
});

test("builds zcode commands pinned to the Z.ai endpoint", () => {
  const previous = {
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    INTENT_FACTORY_ZCODE_BIN: process.env.INTENT_FACTORY_ZCODE_BIN,
    INTENT_FACTORY_TEST_ZCODE_TOKEN: process.env.INTENT_FACTORY_TEST_ZCODE_TOKEN,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  // Resolving the default executable repairs the host when the CLI is off
  // PATH: with a real PATH and HOME this test would install a shim into the
  // developer's own install dir as a side effect of running the suite.
  const sandbox = mkdtempSync(join(tmpdir(), "runner-zcode-default-"));
  process.env.ZAI_API_KEY = "test-zai-token";
  process.env.PATH = sandbox;
  process.env.HOME = sandbox;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.INTENT_FACTORY_ZCODE_BIN;
  delete process.env.INTENT_FACTORY_TEST_ZCODE_TOKEN;
  try {
    const command = providerCommand({ harness: "zcode", model: "glm-5.3[1m]" }, "task");
    assert.equal(command.executable, "zcode");
    assert.equal(command.promptTransport, "argv");
    assert.equal(command.input, null);
    assert.deepEqual(command.args, ["--json", "--no-color", "--mode", "yolo", "--prompt", "task"]);
    assert.equal(command.env?.ZCODE_MODEL, "glm/glm-5.3", "the [1m] suffix is a claude-CLI tier marker the provider does not know");
    assert.equal(command.env?.ZCODE_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(command.env?.GLM_API_KEY, "test-zai-token");
    assert.equal(command.env?.ANTHROPIC_API_KEY, null, "ambient Anthropic key must be removed: the CLI checks it first");

    const judge = providerCommand({ harness: "zcode", model: "glm-5.3", permissionMode: "plan" }, "review");
    assert.deepEqual(judge.args.slice(0, 4), ["--json", "--no-color", "--mode", "plan"]);

    const custom = providerCommand({
      harness: "zcode",
      model: "glm-5.3",
      config: {
        provider: "zai",
        base_url: "https://custom.example/api",
        "auth_token.env_key": "INTENT_FACTORY_TEST_ZCODE_TOKEN",
      },
    }, "task");
    assert.equal(custom.env?.ZCODE_MODEL, "zai/glm-5.3");
    assert.equal(custom.env?.ZCODE_BASE_URL, "https://custom.example/api");
    assert.equal("ZAI_API_KEY" in (custom.env ?? {}), false, "an unresolved token is omitted, not blanked");

    process.env.INTENT_FACTORY_TEST_ZCODE_TOKEN = "custom-token";
    const resolved = providerCommand({
      harness: "zcode",
      model: "glm-5.3",
      config: { provider: "zai", "auth_token.env_key": "INTENT_FACTORY_TEST_ZCODE_TOKEN" },
    }, "task");
    assert.equal(resolved.env?.ZAI_API_KEY, "custom-token");

    // The CLI folds non-alphanumerics in the provider id into `_` before
    // appending `_API_KEY`, so a dashed id must name the variable it reads.
    const dashed = providerCommand({
      harness: "zcode",
      model: "glm-5.3",
      config: { provider: "z-ai", "auth_token.env_key": "INTENT_FACTORY_TEST_ZCODE_TOKEN" },
    }, "task");
    assert.equal(dashed.env?.ZCODE_MODEL, "z-ai/glm-5.3");
    assert.equal(dashed.env?.Z_AI_API_KEY, "custom-token");
    assert.equal("Z-AI_API_KEY" in (dashed.env ?? {}), false, "the unfolded spelling is not a variable the CLI reads");

    const continued = providerCommand({ harness: "zcode", model: "glm-5.3" }, "next task", {
      continuationId: "sess_zcode-1",
    });
    assert.deepEqual(continued.args.slice(0, 5), ["--json", "--no-color", "--mode", "yolo", "--resume"]);
    assert.ok(continued.args.includes("sess_zcode-1"));
    assert.deepEqual(continued.args.slice(-2), ["--prompt", "next task"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("zcode tool policy is refused honestly and the judge schema travels in the prompt", () => {
  const policy = { foregroundOnly: true, maxToolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES };
  // A named executable keeps this test off the real PATH: an unnamed zcode
  // runtime resolves the host's CLI and may install a shim while doing it.
  const runtime = { harness: "zcode", model: "glm-5.3", executable: "/nonexistent/zcode" };
  const command = providerCommand(runtime, "work", {
    toolPolicy: policy,
    schema: JUDGE_SCHEMA,
  });
  assert.equal(command.args.includes("--settings"), false, "the harness sends no tool policy, so no settings payload is passed");
  assert.deepEqual(
    missingCapabilities(harnessCapabilities({ harness: "zcode" }), { toolPolicy: true }),
    ["toolPolicy=true (harness provides toolPolicy=false)"],
  );
  assert.deepEqual(
    missingCapabilities(harnessCapabilities({ harness: "zcode" }), { structuredOutput: true }),
    ["structuredOutput=true (harness provides structuredOutput=false)"],
  );
  const bare = providerCommand(runtime, "work");
  assert.equal(bare.args.at(-2), "--prompt");
  assert.equal(bare.args.at(-1), "work", "no offered schema leaves the prompt untouched");
  const prompt = command.args.at(-1) ?? "";
  assert.deepEqual(command.args.slice(-2), ["--prompt", prompt]);
  assert.match(prompt, /^work/u, "the prompt stays the prefix");
  assert.ok(prompt.includes(JSON.stringify(JUDGE_SCHEMA)), "the schema text rides inside the prompt");
});

test("the zcode adapter installs its CLI onto the PATH when the app is bundled", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-zcode-host-"));
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const bundle = { electron: join(root, "ZCode"), cli: join(root, "zcode.cjs") };
  writeFileSync(bundle.electron, "electron");
  writeFileSync(bundle.cli, "cli");
  const pathDirs = [bin, "/usr/bin"];
  const shim = join(bin, "zcode");

  ensureZcodeAvailable({ pathDirs, home, bundle });

  assert.equal(statSync(shim).mode & 0o777, 0o755, "a shim nothing can execute is not on the PATH in any useful sense");
  const body = readFileSync(shim, "utf8");
  assert.match(body, /^#!\/usr\/bin\/env bash\n/u);
  assert.ok(body.includes(`ELECTRON_RUN_AS_NODE=1 exec ${bundle.electron}`), "the app's own Electron runs the bundle");
  assert.ok(body.includes(bundle.cli), "the bundled CLI is the script Electron is handed");

  // A second pass over identical content must not replace the file. The inode
  // is the proof: every install lands through a rename.
  const inode = statSync(shim).ino;
  ensureZcodeAvailable({ pathDirs, home, bundle });
  assert.equal(statSync(shim).ino, inode, "an installed shim is left in place");

  // An install dir off the PATH would fix the harness and not the user, which is
  // the half of the request that matters.
  ensureZcodeAvailable({ pathDirs: ["/usr/bin"], home, bundle });
  assert.equal(existsSync(join(home, "bin", "zcode")), false, "nothing is installed outside the PATH");

  // No bundle is not a host to repair.
  const bare = join(root, "bare");
  mkdirSync(bare, { recursive: true });
  ensureZcodeAvailable({ pathDirs: [bare], home, bundle: { electron: join(root, "absent"), cli: join(root, "absent") } });
  assert.equal(existsSync(join(bare, "zcode")), false);

  // A PATH entry that does not exist is an ordinary host — this machine has
  // two — and the install lands in one of them, where the write fails. Callers
  // with no error path around `executable()` (the models report, the doctor,
  // runtime discovery) must never see that failure.
  const ghostHome = join(root, "ghost");
  mkdirSync(ghostHome, { recursive: true });
  const ghostBin = join(ghostHome, ".local", "bin");
  assert.doesNotThrow(
    () => ensureZcodeAvailable({ pathDirs: [ghostBin], home: ghostHome, bundle }),
    "a host that cannot be repaired degrades to not-found, it does not abort the caller",
  );
  assert.equal(existsSync(ghostBin), false, "and it does not invent install dirs");
});

test("the zcode adapter leaves the user's own zcode alone and keeps naming the command", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-zcode-existing-"));
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const bundle = { electron: join(root, "ZCode"), cli: join(root, "zcode.cjs") };
  writeFileSync(bundle.electron, "electron");
  writeFileSync(bundle.cli, "cli");

  // A runnable command of that name is the answer already: not a host to repair.
  const mine = join(bin, "zcode");
  writeFileSync(mine, "#!/bin/sh\n# hand written\n");
  chmodSync(mine, 0o755);
  ensureZcodeAvailable({ pathDirs: [bin], home, bundle });
  assert.equal(readFileSync(mine, "utf8"), "#!/bin/sh\n# hand written\n", "an existing command is not overwritten");

  // A stale shim — the app moved — is dangling, so nothing resolves and the
  // installer runs. Writing the path would follow the link onto its target.
  const stale = join(root, "gone");
  rmSync(mine);
  symlinkSync(stale, mine);
  ensureZcodeAvailable({ pathDirs: [bin], home, bundle });
  assert.ok(lstatSync(mine).isSymbolicLink(), "the stale link survives");
  assert.equal(existsSync(stale), false, "and nothing was written through it");

  // The resolved name is what the runtime fingerprint hashes, so it must not
  // depend on where this host happens to keep the CLI.
  await withEmptyPath(() => {
    assert.equal(
      providerCommand({ harness: "zcode", model: "glm-5.3" }, "task").executable,
      "zcode",
      "the adapter names the command, it does not point at a path",
    );
  });
});

test("normalizes the ZCode result object with cache-aware usage", () => {
  // Shape recorded from a live zcode 0.16.5 headless run on 2026-09-10.
  const result = JSON.stringify({
    sessionId: "sess_bf4de980",
    traceId: "7ceb9c1a",
    turnId: "turn_aa9444ba",
    response: "pong",
    usage: { source: "provider", inputTokens: 15506, outputTokens: 109, totalTokens: 15615, cacheReadTokens: 9024, cacheWriteTokens: 0, reasoningTokens: 0 },
    eventCount: 118,
    projection: { status: "idle", turnCount: 1, totalTokenCount: 15615, contextUsed: 15615, contextWindow: 1000000 },
  });
  const envelope = normalizeProviderResult("zcode", result, 0, null);
  assert.equal(envelope.status, "done");
  assert.equal(envelope.result, "pong");
  assert.equal(envelope.continuationId, "sess_bf4de980");
  assert.equal(envelope.error, null);
  assert.deepEqual(envelope.usage, { inputTokens: 6482, outputTokens: 109, cacheReadInputTokens: 9024 },
    "inputTokens already include the cached reads, so the cache component is subtracted");

  // A turn that also wrote cache: the write is already inside inputTokens, so
  // only the read portion may be subtracted — adding the write would inflate
  // usage.jsonl and every cost-per-checkpoint derived from it.
  const wroteCache = JSON.stringify({
    sessionId: "sess_cache",
    response: "pong",
    usage: { inputTokens: 10000, outputTokens: 50, totalTokens: 10050, cacheReadTokens: 3000, cacheWriteTokens: 1000 },
  });
  assert.deepEqual(
    normalizeProviderResult("zcode", wroteCache, 0, null).usage,
    { inputTokens: 7000, outputTokens: 50, cacheReadInputTokens: 3000 },
    "10000 - 3000 cache reads leaves 6000 uncached + 1000 written",
  );

  const empty = JSON.stringify({ sessionId: "sess_x", response: "", usage: {} });
  assert.equal(normalizeProviderResult("zcode", empty, 0, null).status, "no-op");
});

test("selects structured JSON from a ZCode judge response", () => {
  const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
  const result = JSON.stringify({
    sessionId: "sess_judge",
    response: `Review complete.\n\n\`\`\`json\n${verdict}\n\`\`\``,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
  });
  const envelope = normalizeProviderResult("zcode", result, 0, null, { preferStructured: true });
  assert.equal(envelope.result, verdict);
  assert.equal(envelope.status, "done");
});

test("zcode startup failures carry the process's own stderr", () => {
  // A missing provider API key dies before any output and explains itself on
  // stderr; the envelope must classify as an auth failure, not an outage.
  const authFailure = normalizeProviderResult("zcode", "", 1, null, {
    stderr: "Error: Turn execution failed (traceId: t1)\nCause: AiSdkModelAdapterError: Model provider is missing an API key: zai\n",
  });
  assert.equal(authFailure.status, "failed");
  assert.equal(authFailure.error?.code, "incomplete_stream");
  assert.match(authFailure.error?.message ?? "", /missing an API key/u);
  assert.deepEqual(
    normalizeProviderAvailability("zcode", authFailure),
    { available: false, exhaustedUntil: null, reason: "authentication_failed" },
  );

  const quotaText = normalizeProviderResult("zcode", "", 1, null, {
    stderr: "Error: 429 too many requests; usage limit exhausted, resets 2026-09-11 02:00:00\n",
  });
  assert.equal(quotaText.error?.code, "quota_exhausted");
  assert.equal(
    normalizeProviderAvailability("zcode", quotaText).exhaustedUntil,
    "2026-09-11T02:00:00.000Z",
  );

  const plain = normalizeProviderResult("zcode", "", 1, null, {});
  assert.equal(plain.error?.code, "incomplete_stream");
  assert.match(plain.error?.message ?? "", /ZCode emitted no result object/u);

  const invalid = normalizeProviderResult("zcode", "not json at all", 1, null, {});
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.error?.code, "incomplete_stream");

  const exitedWithResponse = normalizeProviderResult("zcode", JSON.stringify({ sessionId: "s", response: "partial", usage: {} }), 1, null, {});
  assert.equal(exitedWithResponse.status, "failed", "a non-zero exit is a provider failure even with a response");
  assert.equal(exitedWithResponse.error?.message, "partial");

  const killed = normalizeProviderResult("zcode", "", null, "SIGTERM", {});
  assert.equal(killed.status, "canceled");
});

test("accepts a zcode runtime in contracts and keeps the zhipu vendor", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-zcode-contract-"));
  const value = fixture();
  /** @type {Record<string, Record<string, unknown>>} */
  const runtimes = /** @type {Record<string, Record<string, unknown>>} */ (value.runtimes);
  runtimes.zcodeFlash = { harness: "zcode", model: "glm-5.3-flash", permissionMode: "edit" };
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes.zcodeFlash.harness, "zcode");
  assert.equal(contract.runtimes.zcodeFlash.vendor, "zhipu", "the harness default names the vendor");
  assert.equal(routeRuntime(contract, { id: "z", type: "backend", runtime: "zcodeFlash", gate: {} }).id, "zcodeFlash");
});

test("live metering has no zcode transcript: usage settles from the terminal envelope", () => {
  assert.deepEqual(
    liveSessionMetrics("zcode", JSON.stringify({ sessionId: "s", response: "ok", usage: { inputTokens: 5 } })),
    { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false },
    "the single-JSON output is only parseable at process end, so mid-run metering reads zero",
  );
});
