import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateContract } from "../scripts/contract.mjs";
import { renderReport, renderReportJson } from "../scripts/render.mjs";
import { fixture, packet, writeContract } from "./helpers.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

test("reports known provider cost at node and aggregate levels", () => {
  const { runDir } = makeRun([{
    id: "known",
    costUsd: 0.3,
    invocations: [invocation("known-1", 0.1), invocation("known-2", 0.2)],
  }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.nodes[0].costUsd, 0.3);
    assert.equal(report.nodes[0].costStatus, "known");
    assert.deepEqual(report.totals.inputTokens, 10);
    assert.deepEqual(report.totals.outputTokens, 5);
    assert.deepEqual(report.totals.cacheReadInputTokens, 0);
    assert.equal(report.totals.costUsd, 0.3);
    assert.equal(report.totals.costStatus, "known");
    const text = renderReport(runDir);
    assert.match(text, /\$0\.300000 \(known\)/u);
    assert.match(text, /totals .*cost \$0\.300000 \(known\)/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("reports a standalone persisted cost as estimated", () => {
  const { runDir } = makeRun([{ id: "estimated", costUsd: 0.4 }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.nodes[0].costUsd, 0.4);
    assert.equal(report.nodes[0].costStatus, "estimated");
    assert.equal(report.totals.inputTokens, 10);
    assert.equal(report.totals.outputTokens, 5);
    assert.equal(report.totals.cacheReadInputTokens, 0);
    assert.equal(report.totals.costUsd, 0.4);
    assert.equal(report.totals.costStatus, "estimated");
    assert.match(renderReport(runDir), /\$0\.400000 \(estimated\)/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("keeps conflicting and legacy no-cost entries ambiguous", () => {
  const { runDir } = makeRun([
    { id: "conflicting", costUsd: 0.9, invocations: [invocation("conflicting-1", 0.5)] },
    { id: "legacy" },
  ]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.deepEqual(report.nodes.map(({ id, costUsd, costStatus }) => ({ id, costUsd, costStatus })), [
      { id: "conflicting", costUsd: null, costStatus: "ambiguous" },
      { id: "legacy", costUsd: null, costStatus: "ambiguous" },
    ]);
    assert.equal(report.totals.costUsd, null);
    assert.equal(report.totals.costStatus, "ambiguous");
    const text = renderReport(runDir);
    assert.match(text, /- \(ambiguous\)/u);
    assert.doesNotMatch(text, /\$0\.000000/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

function makeRun(nodes) {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-report-cost-"));
  const contractPath = writeContract(directory, fixture({
    nodes: nodes.map(({ id }) => ({ id, type: "backend", taskPacket: packet(), gate: false })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(directory, ".runs", "report-cost");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), readFileSync(contractPath));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: "0.1.0",
    pid: process.pid,
    processStartToken: null,
    startedAt: NOW,
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  for (const node of nodes) {
    const planNode = contract.nodes.find((candidate) => candidate.id === node.id);
    writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify({
      schemaVersion: 1,
      contractVersion: "0.1.0",
      id: node.id,
      type: planNode.type,
      sourceIdentity: planNode.sourceIdentity,
      packetHash: planNode.packetHash,
      status: "done",
      phase: "complete",
      attempt: 1,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: NOW,
      updatedAt: NOW,
      result: null,
      gate: null,
      error: null,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
      ...node,
    }, null, 2)}\n`);
  }
  return { runDir };
}

function invocation(id, costUsd) {
  return {
    id,
    pid: process.pid,
    processGroupId: null,
    processStartToken: null,
    driver: "codex",
    phase: "worker",
    promptPath: null,
    stdoutPath: null,
    stderrPath: null,
    executable: "/usr/bin/true",
    startedAt: NOW,
    updatedAt: NOW,
    closedAt: NOW,
    deadlineAt: NOW,
    exitCode: 0,
    signal: null,
    status: "closed",
    costUsd,
    runId: "test-run",
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    runtimeFingerprint: "fixture",
    model: "gpt-5.6-luna",
    reasoning: null,
    sandbox: null,
    continuationId: null,
    continuationMode: "fresh",
  };
}
