import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommand, hookSettings } from "../../src/host/tool-policy-hook.mjs";
import { bashReadDecision, readThresholdDecision, writeScopeDecision } from "../../src/host/tool-policy-decisions.mjs";
import { harnessCapabilities, providerCommand } from "../../src/harnesses/index.mjs";

/** @param {number} lines @returns {string} */
const fileWithLines = (lines) => `${Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n")}\n`;

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

test("tool policy write scope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-write-"));
  mkdirSync(join(workspace, "src", "pkg"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.mjs"), "// a\n");
  writeFileSync(join(workspace, "src", "b.mjs"), "// b\n");
  writeFileSync(join(workspace, "src", "b.ipynb"), "{}");
  writeFileSync(join(workspace, "src", "pkg", "nested.mjs"), "// nested\n");
  writeFileSync(join(workspace, "anywhere.mjs"), "// anywhere\n");
  const policy = { workspace, writeFiles: ["src/a.mjs"], writeRoots: ["src/pkg"] };
  assert.equal(writeScopeDecision(policy, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/a.mjs") } }), null, "a declared write file passes");
  assert.equal(writeScopeDecision(policy, { tool_name: "Edit", tool_input: { file_path: join(workspace, "src/pkg/nested.mjs") } }), null, "a path under a declared write root passes");
  const denial = writeScopeDecision(policy, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/b.mjs") } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /outside the declared write scope/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /src\/a\.mjs/u, "the reason cites the declared paths");
  assert.equal(writeScopeDecision(policy, { tool_name: "NotebookEdit", tool_input: { notebook_path: join(workspace, "src/b.ipynb") } })?.hookSpecificOutput.permissionDecision, "deny", "NotebookEdit reads notebook_path");
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: [], writeRoots: [] }, { tool_name: "Write", tool_input: { file_path: join(workspace, "anywhere.mjs") } }),
    null,
    "an empty declared scope is the absence of a scope, not a closed one",
  );
});

test("tool policy read threshold", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-read-"));
  const large = join(workspace, "large.txt");
  writeFileSync(large, fileWithLines(2000));
  const policy = { maxReadLines: 1500 };
  const denial = readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: large } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /2000 lines/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /1500-line/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /offset and limit/u);
});

test("tool policy targeted read", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-targeted-"));
  const large = join(workspace, "large.txt");
  writeFileSync(large, fileWithLines(2000));
  const policy = { maxReadLines: 1500 };
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: large, offset: 1 } }), null, "an explicit offset passes without measuring");
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: large, limit: 200 } }), null, "an explicit limit passes without measuring");
});

test("tool policy small file", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-small-"));
  const small = join(workspace, "small.txt");
  writeFileSync(small, fileWithLines(10));
  const policy = { maxReadLines: 1500 };
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: small } }), null, "a file below the threshold passes");
  assert.equal(bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${small}` } }), null, "a small file read through bash passes");
});

test("tool policy bash passthrough", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-bash-"));
  const large = join(workspace, "large.txt");
  writeFileSync(large, fileWithLines(2000));
  const policy = { maxReadLines: 1500 };
  const denial = bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large}` } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny", "a single cat over a large file is denied");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /2000 lines/u);
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `head -n 50 ${large}` } }),
    null,
    "head with an explicit -n limit passes",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `tail -50 ${large}` } }),
    null,
    "tail with a bare numeric limit passes",
  );
  assert.notEqual(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `head ${large}` } }),
    null,
    "head with no limit at all is denied like cat",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large} | grep line` } }),
    null,
    "a pipeline passes without analysis",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large} > /tmp/copy.txt` } }),
    null,
    "a redirection passes without analysis",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large} && echo done` } }),
    null,
    "a chain passes without analysis",
  );
});

test("tool policy missing path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-missing-"));
  const newFile = join(workspace, "ghost.mjs");
  const outOfScope = join(workspace, "other.mjs");
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: ["ghost.mjs"], writeRoots: [] }, { tool_name: "Write", tool_input: { file_path: newFile } }),
    null,
    "a write to a declared but not-yet-created file passes: write scope is judged on the path alone, not on existence",
  );
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: ["ghost.mjs"], writeRoots: [] }, { tool_name: "Write", tool_input: { file_path: outOfScope } })
      ?.hookSpecificOutput.permissionDecision,
    "deny",
    "creating a new file outside the scope is denied: scope membership is a fact about the path, and this is the ordinary violation",
  );
  assert.equal(readThresholdDecision({ maxReadLines: 1500 }, { tool_name: "Read", tool_input: { file_path: newFile } }), null, "a nonexistent read target is never denied: it cannot be measured");
  assert.equal(bashReadDecision({ maxReadLines: 1500 }, { tool_name: "Bash", tool_input: { command: `cat ${newFile}` } }), null, "a nonexistent bash read target is never denied: it cannot be measured");
});
