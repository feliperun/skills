import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driverCapabilities,
  normalizeProviderResult,
  probeRuntime,
  providerCommand,
} from "../scripts/drivers/index.mjs";
import { EXEC_JSONL_PROTOCOL, liveInputTokens, normalizeExecJsonlResult, parseVersion } from "../scripts/drivers/exec-jsonl.mjs";
import { JUDGE_SCHEMA, routeRuntime } from "../scripts/lib.mjs";
import { validateContract } from "../scripts/contract.mjs";
import { fixture, packet, writeContract } from "./helpers.mjs";

test("all provider adapters report explicit capabilities and transport", () => {
  const runtimes = [
    { driver: "codex", model: "m" },
    { driver: "claude", model: "m" },
    { driver: "agy", model: "m" },
    { driver: "glm", model: "m" },
    { driver: "exec-jsonl", model: "m", executable: "wrapper" },
  ];
  for (const runtime of runtimes) {
    const capabilities = driverCapabilities(runtime);
    assert.equal(typeof capabilities.structuredOutput, "boolean");
    assert.ok(["stdin", "argv"].includes(capabilities.promptTransport));
    assert.equal(typeof capabilities.sandbox, "boolean");
    assert.equal(typeof capabilities.permissions, "boolean");
    assert.equal(typeof capabilities.continuation, "boolean");
    assert.equal(typeof capabilities.usage, "boolean");
  }
  assert.equal(driverCapabilities(runtimes[0]).promptTransport, "stdin");
  assert.equal(driverCapabilities(runtimes[1]).promptTransport, "stdin");
  assert.equal(driverCapabilities(runtimes[2]).promptTransport, "argv");
  assert.equal(driverCapabilities(runtimes[3]).promptTransport, "stdin");
  assert.equal(driverCapabilities(runtimes[4]).promptTransport, "stdin");
  assert.deepEqual(driverCapabilities(runtimes[0]), {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: true,
    permissions: false,
    continuation: false,
    usage: true,
  });
  assert.equal(driverCapabilities(runtimes[1]).permissions, true);
  assert.equal(driverCapabilities(runtimes[1]).continuation, false);
  assert.equal(driverCapabilities(runtimes[2]).permissions, false);
  assert.equal(driverCapabilities(runtimes[2]).continuation, false);
  assert.equal(driverCapabilities(runtimes[3]).permissions, true);
  assert.equal(driverCapabilities(runtimes[3]).sandbox, false);
  assert.equal(driverCapabilities(runtimes[4]).continuation, true);
});

test("stdin adapters keep prompts out of argv and argv adapters enforce byte limits", () => {
  const prompt = "prompt with spaces";
  for (const runtime of [
    { driver: "codex", model: "m" },
    { driver: "claude", model: "m" },
    { driver: "glm", model: "m" },
    { driver: "exec-jsonl", model: "m", executable: "wrapper" },
  ]) {
    const command = providerCommand(runtime, prompt);
    assert.equal(command.promptTransport, "stdin");
    assert.equal(command.input?.includes(prompt) ?? false, true);
    assert.equal(command.args.includes(prompt), false);
  }
  const argv = providerCommand({ driver: "agy", model: "m", maxArgvPromptBytes: 4 }, "é");
  assert.equal(argv.promptTransport, "argv");
  assert.throws(
    () => providerCommand({ driver: "agy", model: "m", maxArgvPromptBytes: 1 }, "é"),
    /argv limit/u,
  );
});

test("generic exec-jsonl emits the documented normalized request", () => {
  const command = providerCommand({ driver: "exec-jsonl", model: "pi", executable: "pi-wrapper" }, "hello", {
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

test("all adapter normalizers return the common envelope", () => {
  const streams = {
    codex: [
      { type: "item.completed", item: { type: "agent_message", text: "codex" } },
      { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
    ],
    claude: [{ type: "result", result: "claude", session_id: "c", usage: { input_tokens: 2 } }],
    glm: [{ type: "result", result: "glm", session_id: "g", usage: { input_tokens: 5, output_tokens: 1 } }],
    agy: [{ event: "result", result: { status: "SUCCESS", response: "agy", conversation_id: "a", usage: {} } }],
    "exec-jsonl": [{ schemaVersion: 1, type: "run.completed", result: { answer: 1 }, continuationId: "e", usage: { inputTokens: 3 } }],
  };
  for (const [driver, events] of Object.entries(streams)) {
    const result = normalizeProviderResult(driver, events.map((event) => JSON.stringify(event)).join("\n"), 0, null);
    assert.equal(result.status, "done");
    assert.equal(typeof result.result, "string");
    assert.ok(result.usage);
  }
  assert.equal(normalizeProviderResult("exec-jsonl", JSON.stringify({ schemaVersion: 99, type: "run.completed", result: "x" }), 0, null).status, "failed");
});

test("preflight reports executable, model, version, and no credential values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-driver-version-"));
  const executable = join(directory, "versioned-wrapper.mjs");
  writeFileSync(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('wrapper 2.4.1');\n");
  chmodSync(executable, 0o755);
  const check = await probeRuntime({
    id: "wrapper-runtime",
    driver: "exec-jsonl",
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
  const directory = mkdtempSync(join(tmpdir(), "runner-driver-missing-env-"));
  const executable = join(directory, "versioned-wrapper.mjs");
  writeFileSync(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('wrapper 3.1.4');\n");
  chmodSync(executable, 0o755);
  const envName = "PLAN_RUNNER_TEST_REQUIRED_ENV_4F8D";
  const previous = process.env[envName];
  delete process.env[envName];
  try {
    const check = await probeRuntime({
      id: "wrapper-runtime",
      driver: "exec-jsonl",
      model: "pi-model",
      executable,
      config: { "provider.env_key": envName },
    }, { cwd: directory });
    assert.equal(check.ok, false);
    assert.equal(check.driver, "exec-jsonl");
    assert.equal(check.executable, executable);
    assert.equal(check.model, "pi-model");
    assert.equal(check.version, "wrapper 3.1.4");
    assert.match(check.detail ?? "", /missing environment variable PLAN_RUNNER_TEST_REQUIRED_ENV_4F8D/u);
    assert.doesNotMatch(check.detail ?? "", /secret-value/u);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
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
  assert.equal(routeRuntime(contract, { id: "a", type: "frontend", gate: {} }).id, "opus");
  assert.equal(routeRuntime(contract, { id: "b", type: "mechanic", gate: {} }).id, "flash");
  assert.equal(routeRuntime(contract, { id: "c", type: "backend", gate: {} }).id, "luna");
  assert.equal(routeRuntime(contract, { id: "d", type: "backend", runtime: "opus", gate: {} }).id, "opus");
});

test("builds custom provider config as command-line overrides", () => {
  /** @type {Record<string, unknown>} */
  const flash = /** @type {Record<string, Record<string, unknown>>} */ (fixture().runtimes).flash;
  const command = providerCommand({ ...flash, driver: "codex", model: "deepseek-v4-flash", sandbox: "danger-full-access" }, "task");
  assert.equal(command.executable, "codex");
  assert.deepEqual(command.args.slice(0, 4), ["exec", "--json", "--sandbox", "danger-full-access"]);
  assert.ok(command.args.includes("model_provider=\"deepseek\""));
  assert.ok(command.args.includes("model=\"deepseek-v4-flash\""));
  assert.ok(command.args.includes("model_providers.deepseek.env_key=\"DEEPSEEK_API_KEY\""));
  assert.ok(!command.args.includes("--profile"));
});

test("builds agy commands with unambiguous equals-form flags", () => {
  const command = providerCommand(
    { driver: "agy", model: "gemini-3.7-flash-low", reasoning: "xhigh", printTimeout: "30m" },
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

test("builds glm commands pinned to the Z.ai endpoint", () => {
  const previous = {
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    PLAN_RUNNER_GLM_BIN: process.env.PLAN_RUNNER_GLM_BIN,
    PLAN_RUNNER_TEST_GLM_TOKEN: process.env.PLAN_RUNNER_TEST_GLM_TOKEN,
  };
  process.env.ZAI_API_KEY = "test-zai-token";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.PLAN_RUNNER_GLM_BIN;
  delete process.env.PLAN_RUNNER_TEST_GLM_TOKEN;
  try {
    const command = providerCommand({ driver: "glm", model: "glm-5.3[1m]" }, "task", { schema: JUDGE_SCHEMA });
    assert.equal(command.executable, "claude");
    assert.deepEqual(command.args, [
      "-p",
      "--model",
      "glm-5.3[1m]",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--json-schema",
      JSON.stringify(JUDGE_SCHEMA),
    ]);
    assert.equal(command.promptTransport, "stdin");
    assert.equal(command.input, "task");
    assert.equal(command.env?.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(command.env?.ANTHROPIC_AUTH_TOKEN, "test-zai-token");
    assert.equal(command.env?.ANTHROPIC_MODEL, "glm-5.3[1m]");
    assert.equal(command.env?.ANTHROPIC_API_KEY, null, "ambient Anthropic key must be removed");

    const custom = providerCommand({
      driver: "glm",
      model: "glm-5.3",
      config: { base_url: "https://custom.example/api", "auth_token.env_key": "PLAN_RUNNER_TEST_GLM_TOKEN" },
    }, "task");
    assert.equal(custom.env?.ANTHROPIC_BASE_URL, "https://custom.example/api");
    assert.equal("ANTHROPIC_AUTH_TOKEN" in (custom.env ?? {}), false, "an unresolved token is omitted, not blanked");

    process.env.PLAN_RUNNER_TEST_GLM_TOKEN = "custom-token";
    const resolved = providerCommand({
      driver: "glm",
      model: "glm-5.3",
      config: { "auth_token.env_key": "PLAN_RUNNER_TEST_GLM_TOKEN" },
    }, "task");
    assert.equal(resolved.env?.ANTHROPIC_AUTH_TOKEN, "custom-token");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("accepts a glm runtime in contracts and routes nodes to it", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-glm-contract-"));
  const value = fixture();
  /** @type {Record<string, Record<string, unknown>>} */
  const runtimes = /** @type {Record<string, Record<string, unknown>>} */ (value.runtimes);
  runtimes.glm = { driver: "glm", model: "glm-5.3[1m]", config: { "auth_token.env_key": "ZAI_API_KEY" } };
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes.glm.driver, "glm");
  assert.equal(routeRuntime(contract, { id: "g", type: "backend", runtime: "glm", gate: {} }).id, "glm");
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
  assert.equal(normalizeProviderResult("codex", stream, 0, null, { preferStructured: true }).result, verdict);
});

test("normalizes Codex cached token naming", () => {
  const stream = [
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 8, cached_input_tokens: 5, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(normalizeProviderResult("codex", stream, 0, null).usage.cacheReadInputTokens, 5);
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

test("live metering sums per-request Claude usage and prefers the terminal total", () => {
  const partial = [
    { type: "assistant", message: { usage: { input_tokens: 100 } } },
    { type: "assistant", message: { usage: { input_tokens: 250 } } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(liveInputTokens("claude", partial), 350, "mid-run sum of per-request usage");
  const terminal = `${partial}\n${JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 320 } })}`;
  assert.equal(liveInputTokens("claude", terminal), 320, "terminal session total wins");
  assert.equal(liveInputTokens("exec-jsonl", partial), 0, "completion-only drivers meter as zero mid-run");
});
