#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JUDGE_SCHEMA,
  TERMINAL,
  judgePrompt,
  lastOutputAt,
  normalizeProviderResult,
  parseJudge,
  providerCommand,
  renderStatus,
  retryPrompt,
  routeRuntime,
  validateContract,
} from "./lib.mjs";

export async function runContract(contractPath) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContract(
    JSON.parse(readFileSync(absoluteContractPath, "utf8")),
    absoluteContractPath,
  );
  const runDir = join(contract.cwd, ".runs", contract.id);
  if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);

  mkdirSync(join(runDir, "nodes"), { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });
  writeJsonAtomic(join(runDir, "contract.json"), serializableContract(contract));
  writeJsonAtomic(join(runDir, "judge.schema.json"), JUDGE_SCHEMA);

  const states = new Map();
  for (const node of contract.nodes) {
    const state = {
      id: node.id,
      type: node.type,
      status: "pending",
      phase: "waiting",
      attempt: 0,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      gate: null,
      error: null,
    };
    states.set(node.id, state);
    writeNode(runDir, state);
  }
  return driveRun(contract, runDir, states);
}

export async function resumeRun(runDirPath) {
  const runDir = resolve(runDirPath);
  const contractPath = join(runDir, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);

  const states = new Map();
  for (const node of contract.nodes) {
    const state = JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8"));
    // Runs written before the revision budget was tracked have no field; a
    // fresh read must not be able to exhaust a node by defaulting to a cap.
    if (typeof state.revisions !== "number") state.revisions = 0;
    states.set(node.id, state);
  }
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (state.status === "done") continue;
    const adopted = adoptOrphanResult(runDir, state, routeRuntime(contract, node, "worker").driver);
    if (adopted) {
      state.result = adopted.result;
      state.usage = addUsage(state.usage, adopted.usage);
      process.stdout.write(`[resume] ${state.id} adopted an orphaned worker result\n`);
      if (node.gate.enabled) {
        transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] });
      } else {
        transition(runDir, state, "done", { phase: "complete", error: null, blockedBy: [] });
      }
      continue;
    }
    transition(runDir, state, "pending", { phase: "waiting", error: null, blockedBy: [] });
  }
  return driveRun(contract, runDir, states);
}

async function driveRun(contract, runDir, states) {
  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  render(runDir);

  const running = new Map();
  let canceled = false;
  const cancel = () => {
    canceled = true;
    for (const job of running.values()) stopProcess(job.child);
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  while ([...states.values()].some((state) => !TERMINAL.has(state.status))) {
    if (canceled) {
      for (const state of states.values()) {
        if (!TERMINAL.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled" });
      }
      break;
    }

    finalizeClosedJobs(contract, runDir, states, running);
    detectStalls(contract, runDir, running);
    blockDependents(contract, runDir, states);

    const slots = contract.maxParallel - running.size;
    if (slots > 0) {
      const ready = contract.nodes.filter((node) => {
        const state = states.get(node.id);
        return state.status === "pending" && node.dependsOn.every((id) => states.get(id).status === "done");
      });
      for (const node of ready.slice(0, slots)) {
        const state = states.get(node.id);
        if (state.phase === "judge" && state.result) {
          startJudge(contract, node, state, runDir, running, state.result);
          continue;
        }
        state.attempt += 1;
        const prompt = state.gate?.verdict === "fail" ? retryPrompt(node, state.gate) : node.prompt;
        startWorker(contract, node, state, runDir, running, prompt);
      }
    }

    render(runDir);
    if ([...states.values()].some((state) => !TERMINAL.has(state.status))) {
      await delay(contract.pollIntervalMs);
    }
  }

  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  render(runDir);
  const failed = [...states.values()].filter((state) => state.status !== "done");
  process.stdout.write(`[run] ${contract.id} ${failed.length ? "failed" : "done"} · ${runDir}\n`);
  return { runDir, states, ok: failed.length === 0 };
}

function startWorker(contract, node, state, runDir, running, prompt) {
  const runtime = routeRuntime(contract, node, "worker");
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  transition(runDir, state, "running", {
    phase: "worker",
    runtime,
    startedAt: state.startedAt ?? new Date().toISOString(),
    error: null,
  });
  try {
    running.set(node.id, startProcess(contract, node, state, runtime, prompt, paths, "worker"));
  } catch (error) {
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: "spawn_error", message: error.message },
    });
  }
}

function startJudge(contract, node, state, runDir, running, workerResult) {
  const runtime = routeRuntime(contract, node, "judge");
  const paths = logPaths(runDir, node.id, "judge", state.attempt);
  transition(runDir, state, "running", { phase: "judge", runtime });
  try {
    running.set(
      node.id,
      startProcess(contract, node, state, runtime, judgePrompt(node, workerResult), paths, "judge", {
        schema: JUDGE_SCHEMA,
        schemaPath: join(runDir, "judge.schema.json"),
      }),
    );
  } catch (error) {
    transition(runDir, state, "failed", {
      phase: "judge",
      error: { code: "spawn_error", message: error.message },
    });
  }
}

function startProcess(contract, node, state, runtime, prompt, paths, phase, commandOptions = {}) {
  const command = providerCommand(runtime, prompt, commandOptions);
  const stdoutFd = openSync(paths.stdout, "wx");
  const stderrFd = openSync(paths.stderr, "wx");
  let child;
  try {
    child = spawn(command.executable, command.args, {
      cwd: contract.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const job = {
    child,
    node,
    state,
    runtime,
    paths,
    phase,
    startedAt: new Date().toISOString(),
    startedTicks: process.hrtime.bigint(),
    progressTicks: process.hrtime.bigint(),
    lastOutputAt: 0,
    closed: false,
    exitCode: null,
    signal: null,
    spawnError: null,
  };
  child.once("error", (error) => {
    job.spawnError = error;
    job.closed = true;
  });
  child.once("close", (exitCode, signal) => {
    job.exitCode = exitCode;
    job.signal = signal;
    job.closed = true;
  });
  process.stdout.write(`[node] ${node.id} running · ${phase} · ${runtime.id}\n`);
  return job;
}

function finalizeClosedJobs(contract, runDir, states, running) {
  for (const [nodeId, job] of running) {
    if (!job.closed) continue;
    running.delete(nodeId);
    const state = states.get(nodeId);
    if (TERMINAL.has(state.status)) continue;
    if (job.spawnError) {
      transition(runDir, state, "failed", {
        phase: job.phase,
        error: { code: "spawn_error", message: job.spawnError.message },
      });
      continue;
    }

    let envelope;
    try {
      envelope = normalizeProviderResult(
        job.runtime.driver,
        readFileSync(job.paths.stdout, "utf8"),
        job.exitCode,
        job.signal,
        { preferStructured: job.phase === "judge" },
      );
    } catch (error) {
      envelope = { status: "failed", result: null, error: { code: "invalid_output", message: error.message } };
    }

    if (envelope.status !== "done") {
      transition(runDir, state, envelope.status, {
        phase: job.phase,
        result: job.phase === "worker" ? envelope.result : state.result,
        error: envelope.error,
        usage: addUsage(state.usage, envelope.usage),
      });
      continue;
    }

    if (job.phase === "worker") {
      state.result = envelope.result;
      state.usage = addUsage(state.usage, envelope.usage);
      if (job.node.gate.enabled) startJudge(contract, job.node, state, runDir, running, envelope.result);
      else transition(runDir, state, "done", { phase: "complete", result: envelope.result });
      continue;
    }

    state.usage = addUsage(state.usage, envelope.usage);
    let verdict;
    try {
      verdict = parseJudge(envelope.result);
    } catch (error) {
      transition(runDir, state, "failed", {
        phase: "judge",
        error: { code: "invalid_judge_output", message: error.message },
      });
      continue;
    }
    state.gate = verdict;
    const shouldFail = verdict.verdict === "fail" && job.node.gate.failOn.includes(verdict.maxSeverity);
    // The revision budget counts gate rejections, not worker starts. Attempts
    // burned by orphan restarts or resumed crashes must not consume it, or a
    // node could exhaust without ever receiving the one revision it was
    // contracted for.
    if (!shouldFail) {
      transition(runDir, state, "done", { phase: "complete", gate: verdict });
    } else if (state.revisions < job.node.gate.maxRevisions) {
      process.stdout.write(`[gate] ${nodeId} retry · ${verdict.maxSeverity} · ${verdict.summary}\n`);
      state.revisions += 1;
      state.attempt += 1;
      startWorker(contract, job.node, state, runDir, running, retryPrompt(job.node, verdict));
    } else {
      transition(runDir, state, "exhausted", {
        phase: "judge",
        gate: verdict,
        error: { code: "revision_cap", message: verdict.summary },
      });
    }
  }
}

// Budgets are spent per provider invocation and measured on a monotonic clock,
// which does not advance while the host is suspended. Wall-clock arithmetic
// charges a closed laptop lid to whichever node happened to be running.
function detectStalls(contract, runDir, running) {
  const now = process.hrtime.bigint();
  for (const [nodeId, job] of running) {
    const budgetSec = job.node.timeoutSec ?? contract.timeoutSec;
    if (elapsedSeconds(job.startedTicks, now) >= budgetSec) {
      stopProcess(job.child);
      running.delete(nodeId);
      transition(runDir, job.state, "exhausted", {
        phase: job.phase,
        error: { code: "wall_clock_timeout", message: `${job.phase} ran longer than ${budgetSec}s` },
      });
      continue;
    }
    const observed = lastOutputAt([job.paths.stdout, job.paths.stderr], job.startedAt);
    if (observed > job.lastOutputAt) {
      job.lastOutputAt = observed;
      job.progressTicks = now;
    }
    if (elapsedSeconds(job.progressTicks, now) < contract.stallTimeoutSec) continue;
    stopProcess(job.child);
    running.delete(nodeId);
    transition(runDir, job.state, "stalled", {
      phase: job.phase,
      error: { code: "stall_timeout", message: `no provider output for ${contract.stallTimeoutSec}s` },
    });
  }
}

function elapsedSeconds(fromTicks, toTicks) {
  return Number(toTicks - fromTicks) / 1e9;
}

function blockDependents(contract, runDir, states) {
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (state.status !== "pending") continue;
    const blockedBy = node.dependsOn.filter((id) => TERMINAL.has(states.get(id).status) && states.get(id).status !== "done");
    if (blockedBy.length) {
      transition(runDir, state, "blocked", {
        phase: "dependency",
        blockedBy,
        error: { code: "dependency_failed", message: `blocked by ${blockedBy.join(", ")}` },
      });
    }
  }
}

function transition(runDir, state, status, patch = {}) {
  const from = state.status;
  Object.assign(state, patch, { status, updatedAt: new Date().toISOString() });
  writeNode(runDir, state);
  appendFileSync(
    join(runDir, "events.jsonl"),
    `${JSON.stringify({ at: state.updatedAt, node: state.id, from, to: status, phase: state.phase })}\n`,
  );
  if (TERMINAL.has(status)) process.stdout.write(`[node] ${state.id} ${status}${state.error ? ` · ${state.error.message}` : ""}\n`);
}

function writeNode(runDir, state) {
  writeJsonAtomic(join(runDir, "nodes", `${state.id}.json`), state);
}

function render(runDir) {
  writeFileSync(join(runDir, "STATUS.md"), renderStatus(runDir));
}

function logPaths(runDir, nodeId, phase, attempt) {
  const base = `${nodeId}.${attempt}.${phase}`;
  let stem = base;
  for (let generation = 2; existsSync(join(runDir, "logs", `${stem}.jsonl`)); generation += 1) {
    stem = `${base}.r${generation}`;
  }
  return {
    stdout: join(runDir, "logs", `${stem}.jsonl`),
    stderr: join(runDir, "logs", `${stem}.err`),
  };
}

// The worker runtime comes from routing, not from node state: a judge that
// started before the interruption has already overwritten `state.runtime`.
function adoptOrphanResult(runDir, state, driver) {
  if (!state.attempt) return null;
  const logDir = join(runDir, "logs");
  const prefix = `${state.id}.${state.attempt}.worker`;
  const path = readdirSync(logDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .map((name) => join(logDir, name))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)
    .at(-1);
  if (!path) return null;
  try {
    const envelope = normalizeProviderResult(driver, readFileSync(path, "utf8"), 0, null);
    return envelope.status === "done" ? envelope : null;
  } catch {
    return null;
  }
}

export async function preflightContract(contractPath) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContract(
    JSON.parse(readFileSync(absoluteContractPath, "utf8")),
    absoluteContractPath,
  );
  const runtimes = new Map();
  for (const node of contract.nodes) {
    const worker = routeRuntime(contract, node, "worker");
    runtimes.set(worker.id, worker);
    if (node.gate.enabled) {
      const judge = routeRuntime(contract, node, "judge");
      runtimes.set(judge.id, judge);
    }
  }
  const checks = [];
  for (const runtime of runtimes.values()) checks.push(await probeRuntime(contract, runtime));
  return checks;
}

function probeRuntime(contract, runtime) {
  const missing = Object.entries(runtime.config ?? {})
    .filter(([key]) => key.endsWith(".env_key"))
    .map(([, name]) => name)
    .filter((name) => !process.env[name]);
  if (missing.length) {
    return Promise.resolve({
      id: runtime.id,
      model: runtime.model,
      ok: false,
      detail: `missing environment variable ${missing.join(", ")}`,
    });
  }
  const command = providerCommand(
    { ...runtime, sandbox: "read-only" },
    "Reply with the single word READY. Do not read files, edit files, or run commands.",
  );
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd: contract.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ id: runtime.id, model: runtime.model, ok: false, detail: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({ id: runtime.id, model: runtime.model, ok: false, detail: `no response within ${PROBE_TIMEOUT_SEC}s` });
    }, PROBE_TIMEOUT_SEC * 1_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      settle({ id: runtime.id, model: runtime.model, ok: false, detail: error.message });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      let envelope;
      try {
        envelope = normalizeProviderResult(runtime.driver, stdout, exitCode, signal);
      } catch (error) {
        settle({ id: runtime.id, model: runtime.model, ok: false, detail: error.message });
        return;
      }
      settle({
        id: runtime.id,
        model: runtime.model,
        ok: envelope.status === "done",
        detail: envelope.status === "done"
          ? `${runtime.driver}/${runtime.model} answered`
          : envelope.error?.message ?? lastLine(stderr) ?? envelope.status,
      });
    });
  });
}

function lastLine(text) {
  return text.trim().split(/\r?\n/u).at(-1) || null;
}

const PROBE_TIMEOUT_SEC = 120;

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

function serializableContract(contract) {
  const copy = structuredClone(contract);
  for (const node of copy.nodes) delete node.promptFile;
  return copy;
}

function stopProcess(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function addUsage(left = {}, right = {}) {
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    cacheReadInputTokens: (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0),
  };
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function detachSelf(command, target) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), command, target], {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function main(argv) {
  const detached = argv.includes("--detach");
  const positional = argv.filter((argument) => argument !== "--detach");
  const [command, target] = positional;
  if (command === "run" && target) {
    if (detached) {
      const absolute = resolve(target);
      const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
      const runDir = join(contract.cwd, ".runs", contract.id);
      if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
      const child = detachSelf("run", target);
      process.stdout.write(`[run] ${contract.id} detached · pid ${child.pid} · ${runDir}\n`);
      return;
    }
    const result = await runContract(target);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "resume" && target) {
    if (detached) {
      const runDir = resolve(target);
      if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
      const child = detachSelf("resume", target);
      process.stdout.write(`[resume] detached · pid ${child.pid} · ${runDir}\n`);
      return;
    }
    const result = await resumeRun(target);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "preflight" && target) {
    const checks = await preflightContract(target);
    for (const check of checks) {
      process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.id} · ${check.detail}\n`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  if (command === "status" && target) {
    const runDir = resolve(target);
    const status = renderStatus(runDir);
    writeFileSync(join(runDir, "STATUS.md"), status);
    process.stdout.write(status);
    return;
  }
  if (command === "validate" && target) {
    const path = resolve(target);
    validateContract(JSON.parse(readFileSync(path, "utf8")), path);
    process.stdout.write("valid\n");
    return;
  }
  process.stderr.write(
    "usage: harness.mjs <run|validate|preflight> <contract.json> | <status|resume> <run-dir> | run|resume --detach <target>\n",
  );
  process.exitCode = 2;
}

const isMain = process.argv[1] && sameFile(process.argv[1], import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

function sameFile(left, right) {
  try {
    return realpathSync(resolve(left)) === realpathSync(new URL(right));
  } catch {
    return false;
  }
}
