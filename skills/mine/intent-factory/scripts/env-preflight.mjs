/**
 * Environment preflight: the host facts a run depends on, checked before the
 * first dispatch and again by `doctor` on demand.
 *
 * Four checks gate a dispatch — free disk, a functional git, the worktree
 * state, and every routed runtime binary present and versioned. A gate that
 * fails leaves the run materialized and resumable: the controller records the
 * report as run evidence and stops, so the operator fixes the host and
 * resumes instead of starting over and paying for the finished nodes twice.
 *
 * A check may be advisory, meaning it reports a fact without blocking: a
 * merely dirty worktree is normal in this repository (the run captures a
 * dirtyTreeFingerprint for it), while unmerged paths or an interrupted git
 * operation are not, because a worker's scope diff cannot be read against
 * them. Set INTENT_FACTORY_REQUIRE_CLEAN_WORKTREE=1 to make any dirt fatal.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, getDriver, probeRuntime } from "./drivers/index.mjs";
import { addRuntimeRequirement, failoverTargets } from "./failover.mjs";
import { routeRuntime, validateContract } from "./contract.mjs";

/** @typedef {import("./contract.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("./drivers/index.mjs").CapabilityRequirements} CapabilityRequirements */
/** @typedef {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: CapabilityRequirements[]}>} ReachableRuntimes */
/** @typedef {{name: string, ok: boolean, advisory: boolean, detail: string}} EnvCheck */
/** @typedef {{schemaVersion: number, ok: boolean, checks: EnvCheck[]}} EnvReport */

export const ENV_PREFLIGHT_SCHEMA_VERSION = 1;

/** Free space below this leaves no room for logs, capsules, and snapshots. */
export const DEFAULT_MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;

/** Worktree states in which a scope diff is not readable. */
const GIT_IN_PROGRESS = Object.freeze({
  MERGE_HEAD: "merge",
  CHERRY_PICK_HEAD: "cherry-pick",
  REVERT_HEAD: "revert",
  BISECT_LOG: "bisect",
});

/** @param {string} name @param {string} detail @returns {EnvCheck} */
const pass = (name, detail) => ({ name, ok: true, advisory: false, detail });

/** @param {string} name @param {string} detail @param {boolean} [advisory] @returns {EnvCheck} */
const fail = (name, detail, advisory = false) => ({ name, ok: false, advisory, detail });

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string}}
 */
function git(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: result.error ? null : result.status, stdout: String(result.stdout ?? "") };
}

/** @param {NodeJS.ProcessEnv} env @returns {number} */
function minFreeDiskBytes(env) {
  const raw = env.INTENT_FACTORY_MIN_FREE_DISK_BYTES;
  if (raw === undefined) return DEFAULT_MIN_FREE_DISK_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError("INTENT_FACTORY_MIN_FREE_DISK_BYTES must be a non-negative number of bytes");
  return parsed;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Free space on the filesystem holding the run. A filesystem that cannot
 * report statfs is advisory: an unknown figure must not block a dispatch.
 *
 * @param {string} cwd
 * @param {number} minFreeBytes
 * @returns {EnvCheck}
 */
export function checkDisk(cwd, minFreeBytes) {
  let free;
  try {
    const stats = statfsSync(cwd);
    free = Number(stats.bsize) * Number(stats.bavail);
  } catch (error) {
    return fail("disk", `free space unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const detail = `${formatBytes(free)} free · threshold ${formatBytes(minFreeBytes)}`;
  return free >= minFreeBytes ? pass("disk", detail) : fail("disk", `${detail} · free at least ${formatBytes(minFreeBytes - free)} more`);
}

/**
 * A functional git, not merely a git on PATH: the run reads HEAD and diffs
 * the worktree through it, so a git that cannot execute is fatal.
 *
 * @param {string} cwd
 * @returns {EnvCheck}
 */
export function checkGit(cwd) {
  const version = spawnSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (version.error || version.status !== 0) return fail("git", `git is not executable: ${version.error ? version.error.message : `exit ${version.status}`}`);
  const label = String(version.stdout ?? "").trim() || "git";
  if (!existsSync(cwd)) return fail("git", `${label} · cwd does not exist: ${cwd}`);
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return fail("git", `${label} · execution requires a git work tree with at least one commit`);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head.status !== 0) return fail("git", `${label} · repository must have at least one commit before an isolated execution can start`);
  return pass("git", `${label} · HEAD ${head.stdout.trim().slice(0, 12)}`);
}

/**
 * @param {string} cwd
 * @param {boolean} requireClean
 * @returns {EnvCheck}
 */
export function checkWorktree(cwd, requireClean) {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return pass("worktree", `${cwd} is not a git work tree; nothing to compare`);
  const gitDir = git(cwd, ["rev-parse", "--git-dir"]);
  const root = gitDir.status === 0 ? resolve(cwd, gitDir.stdout.trim()) : null;
  if (root) {
    if (existsSync(join(root, "rebase-merge")) || existsSync(join(root, "rebase-apply"))) return fail("worktree", "a rebase is in progress; finish or abort it before dispatching");
    for (const [file, operation] of Object.entries(GIT_IN_PROGRESS)) {
      if (existsSync(join(root, file))) return fail("worktree", `a ${operation} is in progress; finish or abort it before dispatching`);
    }
  }
  const status = git(cwd, ["status", "--porcelain"]);
  if (status.status !== 0) return fail("worktree", "git status failed; the worktree state is unknown");
  const lines = status.stdout.split("\n").filter((line) => line.trim());
  const conflicted = lines.filter((line) => /^(DD|AU|UD|UA|DU|AA|UU)/u.test(line));
  if (conflicted.length) return fail("worktree", `${conflicted.length} unmerged path${conflicted.length === 1 ? "" : "s"}; resolve the conflict before dispatching`);
  if (!lines.length) return pass("worktree", "clean");
  const detail = `${lines.length} dirty path${lines.length === 1 ? "" : "s"}`;
  return requireClean
    ? fail("worktree", `${detail}; INTENT_FACTORY_REQUIRE_CLEAN_WORKTREE demands a clean tree`)
    : fail("worktree", `${detail}; recorded in the run's dirtyTreeFingerprint`, true);
}

/**
 * Every runtime the run can route to — initial and failover — must resolve to
 * a binary that exists and reports a version. A version-less runtime is fatal
 * up front because a resume refuses a runtime whose probe came back null.
 *
 * @param {ReachableRuntimes} runtimes
 * @param {Record<string, string|null>} driverVersions
 * @param {string} [cwd] the run cwd a relative executable is resolved against
 * @returns {EnvCheck}
 */
export function checkRuntimeBinaries(runtimes, driverVersions, cwd = ".") {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const resolved = [];
  for (const [id, { runtime }] of runtimes) {
    // The driver owns the resolution: a per-runtime executable, an
    // INTENT_FACTORY_*_BIN override, and each driver's default binary all
    // land here, and a relative path belongs to the run cwd, not to ours.
    const executable = getDriver(runtime.driver).executable(runtime);
    const found = findExecutable(executable.includes("/") || executable.includes("\\") ? resolve(cwd, executable) : executable);
    const version = driverVersions[id] ?? null;
    if (found === null) problems.push(`${id}: ${executable} not found on PATH`);
    else if (version === null) problems.push(`${id}: ${executable} reported no version`);
    else resolved.push(`${id} ${version}`);
  }
  if (problems.length) return fail("runtime binaries", problems.join(" · "));
  return pass("runtime binaries", resolved.length ? resolved.join(" · ") : "no routed runtime");
}

/**
 * @param {{cwd: string, runtimes: ReachableRuntimes, driverVersions?: Record<string, string|null>, env?: NodeJS.ProcessEnv}} options
 * @returns {EnvReport}
 */
export function environmentPreflight(options) {
  const env = options.env ?? process.env;
  const cwd = options.cwd;
  const checks = [
    checkDisk(cwd, minFreeDiskBytes(env)),
    checkGit(cwd),
    checkWorktree(cwd, env.INTENT_FACTORY_REQUIRE_CLEAN_WORKTREE === "1"),
    checkRuntimeBinaries(options.runtimes, options.driverVersions ?? {}, cwd),
  ];
  return { schemaVersion: ENV_PREFLIGHT_SCHEMA_VERSION, ok: checks.every((check) => check.ok || check.advisory), checks };
}

/** @param {EnvReport} report @returns {EnvCheck[]} the checks that block a dispatch */
export function blockingChecks(report) {
  return report.checks.filter((check) => !check.ok && !check.advisory);
}


/**
 * Collect initial worker/judge runtimes and every runtime reachable through
 * the one declared fallback hop, preserving each capability requirement so a
 * runtime a run might fall over to is checked before it runs.
 *
 * The enumeration is exactly the reachable-state set the run can actually
 * occupy: a node's role starts on its assigned runtime, and — if that
 * runtime declares a `fallback` — may take exactly one hop to it. It never
 * re-derives `failoverTargets` from the hop target itself, so a chain like
 * A.fallback=B, B.fallback=C never probes C for a node assigned A: that node
 * can take only one hop, and its reachable set stops at B.
 *
 * @param {ValidatedContract} contract
 * @returns {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>}
 */
export function reachableRuntimes(contract) {
  /** @type {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: import("./drivers/index.mjs").CapabilityRequirements[]}>} */
  const runtimes = new Map();
  for (const node of contract.nodes) {
    for (const role of /** @type {("worker"|"judge")[]} */ (["worker", ...(node.gate.enabled ? ["judge"] : [])])) {
      const runtime = routeRuntime(contract, node, role);
      const required = role === "judge"
        ? [runtime.requiredCapabilities, node.gate.requiredCapabilities, { structuredOutput: true }]
        : [runtime.requiredCapabilities, node.requiredCapabilities];
      const requiredCapabilitySets = required.filter((item) => item !== undefined);
      addRuntimeRequirement(runtimes, runtime, requiredCapabilitySets);
      const current = { node, role, runtimeId: runtime.id };
      for (const fallbackRuntime of failoverTargets(contract, current)) {
        addRuntimeRequirement(runtimes, fallbackRuntime, requiredCapabilitySets);
      }
    }
  }
  return runtimes;
}

const DRIVER_BIN_OVERRIDES = Object.freeze({
  codex: "INTENT_FACTORY_CODEX_BIN",
  claude: "INTENT_FACTORY_CLAUDE_BIN",
  agy: "INTENT_FACTORY_AGY_BIN",
  glm: "INTENT_FACTORY_GLM_BIN",
  "exec-jsonl": "INTENT_FACTORY_EXEC_JSONL_BIN",
});

/**
 * Mutation-free environment doctor: repository prerequisites, ignored .runs,
 * required binaries, the dispatch environment gate, and (when a contract is
 * given) schema and driver versions.
 *
 * @param {string|undefined} contractPath
 * @param {{cwd?: string, json?: boolean}} values
 * @returns {Promise<boolean>}
 */
export async function doctorCommand(contractPath, values) {
  const repoDir = resolve(values.cwd ?? ".");
  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const gitRepo = isGitWorkTree(repoDir);
  checks.push({ name: "git repository", ok: gitRepo, detail: gitRepo ? repoDir : "not inside a git work tree" });
  const runsIgnored = isRunsIgnored(repoDir);
  checks.push({
    name: ".runs ignored",
    ok: runsIgnored,
    detail: runsIgnored ? ".runs/ is git-ignored" : ".runs/ is not git-ignored; add .runs/ to .gitignore",
  });
  for (const binary of ["node", "npm"]) {
    const found = findExecutable(binary);
    checks.push({ name: `binary ${binary}`, ok: found !== null, detail: found ?? "not found on PATH" });
  }
  checks.push({ name: "runner schema", ok: true, detail: `protocol ${PROTOCOL_SCHEMA_VERSION} · runner ${INTENT_FACTORY_VERSION}` });
  /** @type {Set<string>} */
  let usedDrivers = new Set();
  /** @type {Set<string>} */
  const overriddenDrivers = new Set();
  /** @type {ReachableRuntimes} */
  let routedRuntimes = new Map();
  /** @type {Record<string, string|null>} */
  const driverVersions = {};
  let dispatchCwd = repoDir;
  if (contractPath) {
    const absolute = resolve(contractPath);
    try {
      const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
      checks.push({ name: "contract", ok: true, detail: `${contract.id} · ${contract.nodes.length} node${contract.nodes.length === 1 ? "" : "s"}` });
      const runtimes = reachableRuntimes(contract);
      routedRuntimes = runtimes;
      dispatchCwd = contract.cwd;
      if (contract.maxCostUsd !== undefined || contract.nodes.some((node) => node.maxCostUsd !== undefined)) {
        for (const entry of runtimes.values()) entry.requiredCapabilitySets.push({ cost: true });
      }
      usedDrivers = new Set([...runtimes.values()].map(({ runtime }) => runtime.driver));
      for (const runtime of Object.values(contract.runtimes)) {
        if (typeof runtime.executable === "string") overriddenDrivers.add(runtime.driver);
      }
      for (const [id, { runtime, requiredCapabilitySets }] of runtimes) {
        const probe = await probeRuntime(runtime, { cwd: contract.cwd, requiredCapabilitySets });
        driverVersions[id] = probe.version;
        checks.push({ name: `driver ${probe.id ?? runtime.driver}`, ok: probe.ok, detail: probe.detail ?? (probe.ok ? "ok" : "probe failed") });
      }
    } catch (error) {
      checks.push({ name: "contract", ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({ name: "contract", ok: true, detail: "no contract.json provided; skipping runtime probes" });
  }
  // A PATH-only check must not fail a runtime whose binary is supplied through
  // an explicit executable or a INTENT_FACTORY_*_BIN override; the driver probe above
  // already validated whatever the runtime actually resolves to.
  for (const binary of ["codex", "claude", "agy", "glm", "exec-jsonl"]) {
    const overrideName = /** @type {Record<string, string>} */ (DRIVER_BIN_OVERRIDES)[binary];
    const overridden = overriddenDrivers.has(binary) || Boolean(process.env[overrideName]);
    // The glm driver drives a Claude-Code-compatible CLI; its default binary is `claude`.
    const found = findExecutable(binary === "glm" && !overridden ? "claude" : binary);
    const required = usedDrivers.has(binary) && !overridden;
    checks.push({
      name: `binary ${binary}`,
      ok: !required || found !== null,
      detail: overridden && !found ? "resolved via executable or env override" : required ? (found ?? "required by contract but not found on PATH") : (found ? "present" : "not on PATH (not required by this contract)"),
    });
  }
  for (const check of environmentPreflight({ cwd: dispatchCwd, runtimes: routedRuntimes, driverVersions }).checks) {
    checks.push({ name: check.name, ok: check.ok || check.advisory, detail: check.ok ? check.detail : `${check.detail} (advisory)` });
  }
  const ok = checks.every((check) => check.ok);
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, repo: repoDir, ok, checks }, null, 2)}\n`);
  } else {
    for (const check of checks) process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.name} · ${check.detail}\n`);
  }
  return ok;
}

/**
 * @param {string} repoDir
 * @returns {boolean}
 */
function isGitWorkTree(repoDir) {
  if (existsSync(join(repoDir, ".git"))) return true;
  try {
    const result = spawnSync("git", ["-C", repoDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * @param {string} repoDir
 * @returns {boolean}
 */
function isRunsIgnored(repoDir) {
  try {
    const result = spawnSync("git", ["-C", repoDir, "check-ignore", "-q", ".runs"], { stdio: ["ignore", "ignore", "ignore"] });
    if (result.status === 0) return true;
  } catch {}
  try {
    const gitignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
    return gitignore.split(/\r?\n/u).some((line) => /^\.runs\/?$/u.test(line.trim()));
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function findExecutable(name) {
  if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
