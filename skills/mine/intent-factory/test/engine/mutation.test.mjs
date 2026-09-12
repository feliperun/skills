import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateVerificationCommands } from "../../src/contract/verification.mjs";
import { runVerification } from "../../src/engine/run-command.mjs";

test("mutation verification entry", () => {
  const [entry] = validateVerificationCommands([{ argv: [process.execPath, "-e", "process.exit(0)"], mutation: { threshold: 0.5 } }]);
  assert.equal(entry.mutation?.threshold, 0.5);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: {} }]), /verification\[0\]\.mutation\.threshold must be a number between 0 and 1/u);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: { threshold: 1.5 } }]), /verification\[0\]\.mutation\.threshold must be a number between 0 and 1/u);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: { threshold: "half" } }]), /verification\[0\]\.mutation\.threshold must be a number between 0 and 1/u);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: { threshold: 0.5, leftover: 1 } }]), /verification\[0\]\.mutation has unexpected field leftover/u);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: true }]), /verification\[0\]\.mutation must be an object/u);
});

test("mutation catches empty test", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-empty-"));
  writeFileSync(join(cwd, "module.mjs"), "export function same(a, b) {\n  return a === b;\n}\n");
  // A test that calls the code and asserts nothing: it exits zero whatever the
  // mutant does, which is exactly the suite this gate exists to reject.
  writeFileSync(join(cwd, "check.mjs"), "import { same } from './module.mjs';\nsame(1, 1);\n");
  const entry = { argv: [process.execPath, "check.mjs"], mutation: { threshold: 1 } };
  const empty = await runVerification([entry], cwd, { writeFiles: ["module.mjs"] });
  assert.equal(empty.passed, false, "a test that asserts nothing cannot kill the mutant");
  writeFileSync(join(cwd, "check.mjs"), "import assert from 'node:assert/strict';\nimport { same } from './module.mjs';\nassert.equal(same(1, 1), true);\nassert.equal(same(1, 2), false);\n");
  const asserting = await runVerification([entry], cwd, { writeFiles: ["module.mjs"] });
  assert.equal(asserting.passed, true, "an asserting test kills the mutant");
});

test("mutation scoped to node", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-scope-"));
  writeFileSync(join(cwd, "in-scope.mjs"), "export const value = 1 === 1;\n");
  writeFileSync(join(cwd, "out-of-scope.mjs"), "export const other = 2 === 2;\n");
  // `check.mjs` itself carries an operator, so an unscoped runner would sample
  // it and the out-of-scope module too; the run count proves it did not.
  writeFileSync(join(cwd, "check.mjs"), "import { appendFileSync } from 'node:fs';\nimport { value } from './in-scope.mjs';\nappendFileSync('runs.log', '1');\nif (value !== true) process.exit(1);\n");
  const result = await runVerification([{ argv: [process.execPath, "check.mjs"], mutation: { threshold: 1 } }], cwd, { writeFiles: ["in-scope.mjs"] });
  assert.equal(result.passed, true);
  // One baseline plus exactly one in-scope mutant; an out-of-scope sample would
  // have added a run.
  assert.equal(readFileSync(join(cwd, "runs.log"), "utf8").length, 2);
});

test("mutation duration budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-budget-"));
  const lines = [];
  for (let index = 0; index < 20; index += 1) lines.push(`export const value${index} = ${index} === ${index};`);
  writeFileSync(join(cwd, "typical.mjs"), `${lines.join("\n")}\n`);
  writeFileSync(join(cwd, "check.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('runs.log', '1');\n");
  const result = await runVerification([{ argv: [process.execPath, "check.mjs"], mutation: { threshold: 0 } }], cwd, { writeFiles: ["typical.mjs"] });
  assert.equal(result.passed, true);
  // The budget is proved by counting work, not by a clock: one baseline attempt
  // plus at most eight mutants, and every attempt ran the argv exactly once, so
  // the append count must equal the attempt count.
  const attempts = result.commands[0].attempts.length;
  assert.ok(attempts <= 1 + 8, `the runner ran ${attempts - 1} mutants; the budget is 8`);
  assert.equal(readFileSync(join(cwd, "runs.log"), "utf8").length, attempts, "each mutant ran the argv exactly once");
});
