import test from "node:test";
import assert from "node:assert/strict";
import { hookCommand, hookSettings } from "../../src/host/tool-policy-hook.mjs";
import { harnessCapabilities, providerCommand } from "../../src/harnesses/index.mjs";

test("tool policy is pure", () => {
  const policy = {
    foregroundOnly: true,
    maxToolOutputBytes: 8192,
    workspace: "/tmp/attempt-workspace",
    writeFiles: ["src/a.mjs", "src/b.mjs"],
    writeRoots: ["src/pkg"],
    maxReadLines: 1500,
  };
  const command1 = hookCommand(policy);
  const command2 = hookCommand(policy);
  assert.equal(command1, command2, "same policy in, same command string out");
  const settings1 = hookSettings(policy);
  const settings2 = hookSettings(policy);
  assert.deepEqual(settings1, settings2, "same policy in, same settings out");
  assert.equal(hookCommand.toString().includes("process.env"), false, "hookCommand never reads process.env");
  assert.equal(hookSettings.toString().includes("process.env"), false, "hookSettings never reads process.env");
  assert.equal(hookCommand.toString().includes("writeFileSync") || hookCommand.toString().includes("Sync("), false, "hookCommand performs no disk writes");
  assert.equal(hookSettings.toString().includes("writeFileSync") || hookSettings.toString().includes("Sync("), false, "hookSettings performs no disk writes");
});

test("tool policy optional capability", () => {
  const runtime = { harness: "exec-jsonl", model: "pi", executable: "pi-wrapper" };
  assert.equal(harnessCapabilities(runtime).toolPolicy, false, "this runtime's surface cannot prove enforcement");
  const policy = {
    foregroundOnly: true,
    maxToolOutputBytes: 8192,
    workspace: "/tmp/attempt-workspace",
    writeFiles: [],
    writeRoots: [],
    maxReadLines: 1500,
  };
  assert.doesNotThrow(() => {
    const command = providerCommand(runtime, "work", { toolPolicy: policy });
    assert.equal(command.args.includes("--settings"), false, "no --settings flag is emitted for an unsupported runtime");
  });
});
