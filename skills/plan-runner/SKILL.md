---
name: plan-runner
description: Execute large implementation plans as observable multi-model DAGs with declarative routing, Claude or Codex workers, structured cross-model quality gates, bounded revisions, stall detection, and file-backed status. Use when the user asks to run a plan, epic, graph, or loop autonomously; route task types to different models; keep worker context out of the main session; or inspect an active runner run through /btw.
---

# Plan Runner

Run a plan outside the main context while keeping the current session as the control plane. Store raw worker output under `.runs/`; bring only status and actionable verdicts into the session.

## Workflow

1. Read [references/contract.md](references/contract.md).
2. Establish the durable campaign before inspecting or launching work. Discover
   the active campaign; when more than one exists, stop instead of guessing.
   Initialize a new one only for a new objective, read its `HANDOFF.md`, and
   immediately attach the current orchestrator session with tool, session ID,
   transcript path and format, or explicit `--no-transcript`. Record every
   material user intent, decision, constraint, outcome, next action, and open
   question as a concise campaign event. This is mandatory handoff state, not
   optional documentation. `campaign list --cwd <repo>` finds the active
   campaign; `campaign resolve <campaign> --cwd <repo> --session-id <id>
   --question-id <id> --text <answer>` closes an open question once it is
   answered. `campaign close <campaign> --cwd <repo>` marks the campaign
   terminal after the objective ships; a closed campaign rejects further
   attach/note/resolve writes but remains inspectable via `show` and `list`.
3. Inspect the target repository exactly once, then turn the approved plan into one JSON contract. Author one closed task packet per node instead of leaving workers to discover the repository themselves. Workers do not own repository discovery; the orchestrator owns it once and amortizes that inspection across workers, judges, and retries. Use an explicit `mode: "discovery"` node only when you genuinely cannot produce an execution packet yet.
4. Ensure the target repository ignores `.runs/`; add that single entry to its `.gitignore` if needed.
5. Run with `maxParallel: 1`. The runner rejects `maxParallel` above 1 until
   worktree or equivalent filesystem isolation exists; prompt-only disjoint
   paths are not sufficient.
6. Preflight before spending model tokens. Give package-installing or networked nodes an explicit `sandbox`; do not rely on the caller's ambient permissions.

   ```bash
   node <skill-dir>/scripts/runner.mjs preflight <contract.json>
   ```

   This probes every routed worker and judge runtime with one read-only call and
   creates no run state. Probe the exact model each node will use: a valid
   credential does not imply the provider serves that model, and a provider can
   reject one model of a family while serving another.

   Before spending model tokens, also run the mutation-free environment doctor
   against the target repository:

   ```bash
   node <skill-dir>/scripts/runner.mjs doctor [<contract.json>] [--cwd <target-repo>]
   ```

   `doctor` checks that the target is a git work tree, that `.runs/` is
   ignored, that `node`/`npm` are available, and — when a contract is given —
   that every routed driver binary exists and its runtime probes cleanly. It
   never writes run state. Exit code 0 means all checks passed; use `--json`
   for a machine-readable report.
7. Keep one independently testable checkpoint per node. Split research, implementation, and quality work at real gate boundaries; a phase-sized prompt can accumulate an expensive context before the first judge runs.
   Keep execution packets closed: list exact `readFiles`, `writeFiles`, and
   `verification` commands. Workers and judges must inspect only those paths and
   must return the structured `blocked_context` worker result instead of
   performing fresh repository exploration. Repeated permission denials waste
   context and do not strengthen the verdict. A discovery node with an empty
   `readFiles` list is the only exception: it is read-only and may inspect the
   repository only to produce an execution packet.
8. Validate the contract:

   ```bash
   node <skill-dir>/scripts/runner.mjs validate <contract.json>
   ```

   Validation also emits warnings: a concrete command in a task packet
   verification list that no
   Definition of Done item mentions (the most common gate rejection in
   practice), so add every command to the DoD.

9. Start `run` detached so the controller survives this session and keeps the session responsive. `--detach` forks the controller into its own process group, prints its pid and run directory, and exits:

   ```bash
   node <skill-dir>/scripts/runner.mjs run --detach <contract.json>
   ```

   `run` warns when a node id is already `done` in another run of the same
   repository — copying a whole graph that re-runs finished work is a real
   mistake; generate follow-up contracts by pruning done nodes.

   For unattended guarantees, arm the watchdog alongside the run:

   ```bash
   node <skill-dir>/scripts/runner.mjs watch --detach <run-dir> [--interval 30]
   ```

   The watcher polls the run directory and, whenever the controller process is
   gone while the run is not terminal, spawns `resume --detach` itself. It
   exits when every node is terminal. One watcher per run; a short lock
   prevents two watchers from double-resuming.

   Without `--detach`, the controller is a child of the invoking session and dies with it, stranding any running node as an orphan until a later `resume`. Use `resume --detach <run-dir>` to restart an interrupted run the same way.
10. Report the run directory immediately. Do not read worker logs during normal orchestration.
11. When the user asks for status, including through `/btw`, render and read the snapshot:

   ```bash
   node <skill-dir>/scripts/runner.mjs status <target-repo>/.runs/<run-id>
   ```

   For streaming monitors, `status --json <run-dir>` emits a stable
   `schemaVersion: 1` payload (node statuses, phase, runtime, attempt,
   revisions, and note) and `report --json <run-dir>` adds per-node usage
   totals. Prefer these over parsing the rendered table; `events.jsonl` is the
   append-only transition stream.

   To stop a run and terminate every recorded provider and verification
   process, use `cancel <run-dir>`. It signals the controller, waits for
   confirmation of its death, takes over a stale lease if needed, and marks the
   run terminal. `cancel` cannot act on a lease held by the same process that
   invokes it.

12. When a run finishes (or at any point) and cost or effort matters, aggregate per-node attempts, revisions, runtimes, and tokens:

   ```bash
   node <skill-dir>/scripts/runner.mjs report <target-repo>/.runs/<run-id>
   ```

   Each node's totals include its worker and judge invocations; a node ends
   carrying its last runtime. The NOTE column surfaces each worker's own
   closing summary (or the judge's gate summary) — workers already report to
   the judge; the report is where the orchestrator sees it. The controller
   prints the same report when the run ends. `events.jsonl` records every
   transition with attempt, runtime, error code, and gate verdict/summary for
   streaming monitors — consume it instead of poll-scraping `STATUS.md`.

   When a gated node exhausts its revision budget, print the judge's findings
   ready for a targeted fix node:

   ```bash
   node <skill-dir>/scripts/runner.mjs findings <target-repo>/.runs/<run-id>
   ```

   After two gate rejections or any gate exhaustion, do not keep retrying and
   do not copy the whole graph. Create one follow-up fix node with the finding
   verbatim, its design constraint, and its exact paths; prune already-done
   nodes from the follow-up contract.

   A node that exhausts on `wall_clock_timeout` was killed mid-work, not
   judged insufficient: `resume` doubles its wall-clock budget and persists
   the adjustment. Set `maxInputTokens` on the contract to stop the controller
   from scheduling new nodes once the cumulative input-token budget is spent.

13. Interrupt the user only for `blocked`, `failed`, `exhausted`, or `stalled`, or when the whole run finishes. Use the node error and gate summary; keep raw logs on disk.
14. If the run process dies, resume it instead of starting a new one:

   ```bash
   node <skill-dir>/scripts/runner.mjs resume --detach <target-repo>/.runs/<run-id>
   ```

   A node whose state says `running` while no runner process exists is an
   orphan, not live work. Resume adopts a worker log that proves its own turn
   completed, re-judges instead of re-implementing, and restarts only what has
   no usable output. Start a new run id only when the routing or the graph
   itself must change.

Worker prompts must run build servers, watchers, and other child commands in the foreground. Shell background jobs can outlive a tool call, lose their parent, retain ports, or race later commands; the runner process itself is the only process that should be detached by the control plane.

## Routing

Express model choice only in `runtimes`, `runtimeDefaults`, `runtimeRules`, or an explicit node override. Do not add model-specific branches to the orchestration instructions.

- Route presentation-heavy frontend work to an Opus runtime when its size justifies the process startup and cache cost.
- Route bounded implementation work to Luna or Terra through Codex.
- Route mechanical, tightly specified work to DeepSeek Flash through Codex.
- Route independent review to Sol through Codex.
- Route to `exec-jsonl` when the runtime is an existing executable that speaks
  the generic JSONL protocol: one `run.request` line on stdin and
  `run.started`/`message`/`run.completed`/`run.failed` events on stdout. Point
  at it with `executable` (or `PLAN_RUNNER_EXEC_JSONL_BIN`) and set `versionArgs`
  when it does not accept `--version`.

The Codex adapter passes custom provider configuration with `-c`. Never rely on a profile name to select DeepSeek: Codex 0.147.0 silently accepts unknown profiles and does not reliably load provider tables from config files.

## Gates

Enable a gate per node. Keep executor and judge runtimes different when possible. Default `failOn` to `critical`; add `major` only when the project accepts the extra retry rate. The POC found Sol's findings accurate but its severity calibration aggressive.

Set `maxRevisions` explicitly. A failing gate retries the worker in place with structured findings; reaching the cap produces `exhausted`. The cap counts gate rejections, not worker starts — attempts burned by resumed crashes do not consume a contracted revision.

Put deterministic checks before an LLM judge. The controller runs each
declared argv command itself, captures bounded stdout/stderr, duration, and
exit code, and repeats evidence-producing commands (default twice) before any
judge. A controller interrupted mid-verification re-runs the phase on resume;
only a real command failure or timeout is a deterministic failure. A judge must
return `pass` only with no findings and `maxSeverity: none`; findings below
`failOn` are advisory but still require a `fail` verdict in the structured
report. The Codex adapter selects the last parseable JSON agent message for
judge output so trailing prose cannot replace the verdict.

Make deterministic checks safe under the test runner's actual concurrency.
Concurrent checks must use unique temporary/output paths; otherwise serialize
them explicitly. Run evidence-producing checks twice before accepting a gate so
shared-artifact races and non-idempotent verifiers surface early.

If a product gate has a falsification or STOP condition, require a durable
machine-readable stop artifact and make the product verifier fail closed when
that artifact is present. Do not schedule descendants. v0 has no first-class
`stopped` state, so record the domain verdict in the artifact and explain the
runner terminal state separately.

`timeoutSec` bounds one provider invocation, so a worker that consumes most of
its budget still leaves the judge a full one. Use the 40-minute default for
small/medium nodes and set 80 minutes explicitly for profile-wide or
browser-heavy work. Both limits ignore time the host spends suspended.

Choose `stallTimeoutSec` for the runtime and phase, not from one global habit.
Long-form reasoning and final document composition may emit no provider event
for several minutes even when healthy; keep the stall limit below the hard
wall-clock timeout, but give review/writing nodes enough completion grace. A
bounded, self-contained retry is preferable to repeating upstream research.

## Safety

- Requires Node.js 22 or newer on `PATH`; TypeScript is a development-only
  dependency for `npm run typecheck`, never a runtime requirement.
- Keep secrets in environment variables. Put only environment variable names in contracts.
- The runner does not isolate its workers in git worktrees, so concurrent
  execution is rejected: `maxParallel` is fixed at 1. Run one worker at a time
  and stage explicit paths.
- Use Claude's `bypassPermissions` only in a repository-scoped, recoverable environment with no production write access. Otherwise keep `acceptEdits` and let denied operations become `blocked`.
- Refuse to overwrite an existing run directory. Choose a new run id instead.
- One controller lease per run directory and one watcher lease per watcher:
  a second controller or watcher is rejected while a healthy lease is held, so
  simultaneous `resume` calls cannot double-run a node.
- Treat `STATUS.md` and node JSON as state; treat logs as diagnostic artifacts.
- Stop and ask before destructive production, data, merge, deployment, or credential operations even if a worker proposes them.

## Limitations

v0 does not isolate concurrent nodes in git worktrees, negotiate provider
schema capabilities, represent a domain-level STOP as its own state, or send
its own UI notifications. Resume
recovers a completed worker phase but never a partial one: a provider killed
mid-turn is re-run from the start of the node. Stall detection is
byte-activity based and
cannot distinguish a silent provider cold start or long final composition from
a deadlock. The background task completion signal plus `/btw` status is the
control surface.
