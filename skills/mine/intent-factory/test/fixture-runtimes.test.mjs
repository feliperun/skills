import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runtimesMissingExecutable } from "./fixture-runtime-guard.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));

// helpers.mjs is the one file-wide exemption: its default fixture() runtimes
// (luna, sol, opus, agy, flash) are given a fake binary at test time by the
// withFakeCodex/withFakeAgy wrappers, which inject INTENT_FACTORY_CODEX_BIN
// and INTENT_FACTORY_AGY_BIN, and those fakes live in a per-test temp
// directory — there is no static path to declare as `executable` here.
const FILE_EXEMPT = new Set(["helpers.mjs", "fixture-runtime-guard.mjs"]);

test("fixtures stub every runtime", () => {
  const findings = [];
  for (const name of readdirSync(testDir)) {
    if (!name.endsWith(".mjs") || FILE_EXEMPT.has(name)) continue;
    const source = readFileSync(join(testDir, name), "utf8");
    findings.push(...runtimesMissingExecutable(source, name));
  }
  assert.deepEqual(
    findings,
    [],
    `runtime fixtures missing executable:\n${findings.map((f) => `${f.fileName}: ${f.runtimeId} (${f.driver})`).join("\n")}`,
  );
});

test("fixture runtime guard catches a runtime without executable", () => {
  const source = `
    const contract = {
      runtimes: {
        stubbed: { driver: "codex", model: "test", executable: "/nonexistent/codex" },
        bare: { driver: "codex", model: "test" },
      },
    };
  `;
  assert.deepEqual(runtimesMissingExecutable(source, "synthetic.mjs"), [
    { fileName: "synthetic.mjs", runtimeId: "bare", driver: "codex" },
  ]);

  const exempted = `
    const contract = {
      runtimes: {
        // guard-exempt: schema-only
        bare: { driver: "codex", model: "test" },
      },
    };
  `;
  assert.deepEqual(runtimesMissingExecutable(exempted, "synthetic.mjs"), []);
});
