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
} from "../../src/harnesses/index.mjs";
import {
  EXEC_JSONL_PROTOCOL,
  TOOL_OUTPUT_LIMIT_BYTES,
  liveInputTokens,
  liveSessionMetrics,
  liveUsage,
  normalizeExecJsonlResult,
  truncateToolOutput,
} from "../../src/harnesses/exec-jsonl/index.mjs";
import { ensureZcodeAvailable } from "../../src/harnesses/zcode/index.mjs";
import { normalizeCodexResult, parseVersion } from "../../src/harnesses/protocol.mjs";
import { FOREGROUND_ONLY_DENIAL, HOOK_PATH } from "../../src/host/tool-policy-hook.mjs";
import { DEFAULT_CLAUDE_TOOLS } from "../../src/harnesses/claude/index.mjs";
import { CODEX_PREAMBLE_OVERRIDES } from "../../src/harnesses/codex/index.mjs";
import { JUDGE_SCHEMA } from "../../src/engine/prompts.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { fixture, packet, withEmptyPath, writeContract } from "../helpers.mjs";
import { routeRuntime } from "../../src/contract/runtime.mjs";

// Adapters: capabilities, transport, commands, continuation, preflight.
// Their normalizers and live metering are in normalize.test.mjs.

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
