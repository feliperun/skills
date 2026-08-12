---
name: run-harness
description: Execute large implementation plans as observable multi-model DAGs with declarative routing, Claude or Codex workers, structured cross-model quality gates, bounded revisions, stall detection, and file-backed status. Use when the user asks to run a plan, epic, graph, or loop autonomously; route task types to different models; keep worker context out of the main session; or inspect an active harness run through /btw.
---

# Run Harness

Run a plan outside the main context while keeping the current session as the control plane. Store raw worker output under `.runs/`; bring only status and actionable verdicts into the session.

## Workflow

1. Read [references/contract.md](references/contract.md).
2. Inspect the target repository and turn the approved plan into one JSON contract. Keep nodes independently verifiable and give each node an explicit Definition of Done.
3. Ensure the target repository ignores `.runs/`; add that single entry to its `.gitignore` if needed.
4. Default to `maxParallel: 1`. Raise it only when concurrent nodes write to disjoint paths; worktree isolation is not implemented in v0.
5. Preflight before spending model tokens. Give package-installing or networked nodes an explicit `sandbox`; do not rely on the caller's ambient permissions.

   ```bash
   node <skill-dir>/scripts/harness.mjs preflight <contract.json>
   ```

   This probes every routed worker and judge runtime with one read-only call and
   creates no run state. Probe the exact model each node will use: a valid
   credential does not imply the provider serves that model, and a provider can
   reject one model of a family while serving another.
6. Keep one independently testable checkpoint per node. Split research, implementation, and quality work at real gate boundaries; a phase-sized prompt can accumulate an expensive context before the first judge runs.
   For review nodes, provide a closed evidence set and explicitly forbid fresh
   external inspection when the task does not require it. Repeated permission
   denials waste context and do not strengthen the verdict.
7. Validate the contract:

   ```bash
   node <skill-dir>/scripts/harness.mjs validate <contract.json>
   ```

8. Start `run` detached so the controller survives this session and keeps the session responsive. `--detach` forks the controller into its own process group, prints its pid and run directory, and exits:

   ```bash
   node <skill-dir>/scripts/harness.mjs run --detach <contract.json>
   ```

   Without `--detach`, the controller is a child of the invoking session and dies with it, stranding any running node as an orphan until a later `resume`. Use `resume --detach <run-dir>` to restart an interrupted run the same way.
9. Report the run directory immediately. Do not read worker logs during normal orchestration.
10. When the user asks for status, including through `/btw`, render and read the snapshot:

   ```bash
   node <skill-dir>/scripts/harness.mjs status <target-repo>/.runs/<run-id>
   ```

11. Interrupt the user only for `blocked`, `failed`, `exhausted`, or `stalled`, or when the whole run finishes. Use the node error and gate summary; keep raw logs on disk.
12. If the run process dies, resume it instead of starting a new one:

   ```bash
   node <skill-dir>/scripts/harness.mjs resume --detach <target-repo>/.runs/<run-id>
   ```

   A node whose state says `running` while no harness process exists is an
   orphan, not live work. Resume adopts a worker log that proves its own turn
   completed, re-judges instead of re-implementing, and restarts only what has
   no usable output. Start a new run id only when the routing or the graph
   itself must change.

Worker prompts must run build servers, watchers, and other child commands in the foreground. Shell background jobs can outlive a tool call, lose their parent, retain ports, or race later commands; the harness process itself is the only process that should be detached by the control plane.

## Routing

Express model choice only in `runtimes`, `runtimeDefaults`, `runtimeRules`, or an explicit node override. Do not add model-specific branches to the orchestration instructions.

- Route presentation-heavy frontend work to an Opus runtime when its size justifies the process startup and cache cost.
- Route bounded implementation work to Luna or Terra through Codex.
- Route mechanical, tightly specified work to DeepSeek Flash through Codex.
- Route independent review to Sol through Codex.

The Codex adapter passes custom provider configuration with `-c`. Never rely on a profile name to select DeepSeek: Codex 0.147.0 silently accepts unknown profiles and does not reliably load provider tables from config files.

## Gates

Enable a gate per node. Keep executor and judge runtimes different when possible. Default `failOn` to `critical`; add `major` only when the project accepts the extra retry rate. The POC found Sol's findings accurate but its severity calibration aggressive.

Set `maxRevisions` explicitly. A failing gate retries the worker in place with structured findings; reaching the cap produces `exhausted`. The cap counts gate rejections, not worker starts — attempts burned by resumed crashes do not consume a contracted revision.

Put deterministic checks before an LLM judge. A judge must return `pass` only
with no findings and `maxSeverity: none`; findings below `failOn` are advisory
but still require a `fail` verdict in the structured report. The Codex adapter
selects the last parseable JSON agent message for judge output so trailing
prose cannot replace the verdict.

Make deterministic checks safe under the test runner's actual concurrency.
Concurrent checks must use unique temporary/output paths; otherwise serialize
them explicitly. Run evidence-producing checks twice before accepting a gate so
shared-artifact races and non-idempotent verifiers surface early.

If a product gate has a falsification or STOP condition, require a durable
machine-readable stop artifact and make the product verifier fail closed when
that artifact is present. Do not schedule descendants. v0 has no first-class
`stopped` state, so record the domain verdict in the artifact and explain the
harness terminal state separately.

`timeoutSec` bounds one provider invocation, so a worker that consumes most of
its budget still leaves the judge a full one. Both limits ignore time the host
spends suspended.

Choose `stallTimeoutSec` for the runtime and phase, not from one global habit.
Long-form reasoning and final document composition may emit no provider event
for several minutes even when healthy; keep the stall limit below the hard
wall-clock timeout, but give review/writing nodes enough completion grace. A
bounded, self-contained retry is preferable to repeating upstream research.

## Safety

- Keep secrets in environment variables. Put only environment variable names in contracts.
- Use Claude's `bypassPermissions` only in a repository-scoped, recoverable environment with no production write access. Otherwise keep `acceptEdits` and let denied operations become `blocked`.
- Refuse to overwrite an existing run directory. Choose a new run id instead.
- Treat `STATUS.md` and node JSON as state; treat logs as diagnostic artifacts.
- Stop and ask before destructive production, data, merge, deployment, or credential operations even if a worker proposes them.

## Limitations

v0 does not isolate concurrent nodes in git worktrees, enforce token or
log-size budgets, negotiate provider schema capabilities, represent a
domain-level STOP as its own state, or send its own UI notifications. Resume
recovers a completed worker phase but never a partial one: a provider killed
mid-turn is re-run from the start of the node. Stall detection is
byte-activity based and
cannot distinguish a silent provider cold start or long final composition from
a deadlock. The background task completion signal plus `/btw` status is the
control surface.
