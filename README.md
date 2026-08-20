# harness

Reusable skills for agent work with a small control-plane context, recoverable
state, and independent review.

## Problems it solves

- Subagents repeatedly spending context rediscovering the same repository.
- A session crashing, changing harnesses, or running out of credits and losing decisions.
- Long runs without reliable status, budgets, recovery, or gate history.
- Workers and judges sharing a model and therefore repeating the same bias.

`run-harness` keeps the orchestrator as the control plane: it explores the
repository once, records that discovery in closed task packets, and delegates
only the context each node needs. State, logs, and status live in the target
repository under `.runs/`, never in the main conversation.

```text
orchestrator ──> campaign / HANDOFF.md ──> DAG contract + task packets
                                                │
                              workers ──> independent gate ──> .runs/<id>/STATUS.md
```

## Quickstart

In the repository that will receive the implementation, ignore `.runs/` and
choose a campaign ID for the objective, not for an individual session.

```bash
HARNESS=/path/to/harness/skills/run-harness/scripts/harness.mjs
TARGET=/path/to/target-repository

rg -qxF '.runs/' "$TARGET/.gitignore" || printf '\n.runs/\n' >> "$TARGET/.gitignore"
node "$HARNESS" campaign init feature-42 --cwd "$TARGET" --goal "Deliver feature 42"
node "$HARNESS" campaign attach feature-42 --cwd "$TARGET" \
  --tool codex --session-id <session-id> --no-transcript
```

Inspect the target once. Then create `.harness/feature-42.json` and the packets
it references. An execution packet has an explicit scope:

```json
{
  "mode": "execution",
  "objective": "Add idempotency validation",
  "instructions": ["Implement only the described behavior"],
  "readFiles": ["docs/SPEC.md", "src/idempotency.ts"],
  "writeFiles": ["src/idempotency.ts", "test/idempotency.test.ts"],
  "symbols": ["validateIdempotency"],
  "decisions": ["Do not change the public API"],
  "nonGoals": ["Commit, deploy, or additional discovery"],
  "verification": [{ "argv": ["node", "--test", "test/idempotency.test.ts"] }]
}
```

The contract defines the campaign, runtimes, graph, and Definition of Done. Its
complete reference is in [contract.md](skills/run-harness/references/contract.md).
Validate routing and run preflight before spending tokens:

```bash
node "$HARNESS" validate "$TARGET/.harness/feature-42.json"
node "$HARNESS" preflight "$TARGET/.harness/feature-42.json"
node "$HARNESS" run --detach "$TARGET/.harness/feature-42.json"
```

Every worker ends with one structured worker-result object —
`{status, summary, changedFiles, verification, artifacts, missingContext}` —
where `status` is `done` or `blocked_context` and `blocked_context` requires at
least one `missingContext` entry. Workers return `blocked_context` instead of
exploring the repository when a required file or fact is missing.

## Operating a run

| Goal | Command |
| --- | --- |
| Find the active campaign | `campaign list --cwd <repo>` |
| Start a new objective | `campaign init <campaign> --cwd <repo> --goal <goal>` |
| Read the handoff before resuming | `campaign show <campaign> --cwd <repo>` |
| Record a decision or outcome | `campaign note <campaign> --session-id <id> --kind <kind> --text <text>` |
| Attach a new session | `campaign attach <campaign> --tool <tool> --session-id <id> --transcript <path> --format <format>` |
| Answer an open question | `campaign resolve <campaign> --session-id <id> --question-id <id> --text <answer>` |
| Close a finished campaign | `campaign close <campaign> --cwd <repo>` |
| Validate a contract | `validate <contract.json>` |
| Check credentials and models | `preflight <contract.json>` |
| Check the repository and binaries | `doctor [<contract.json>] [--cwd <dir>]` |
| Start without blocking the session | `run --detach <contract.json>` |
| Read current state | `status <run-dir>` or `status --json <run-dir>` |
| View attempts and tokens | `report <run-dir>` or `report --json <run-dir>` |
| Prepare a repair after gate exhaustion | `findings <run-dir>` |
| Stop a run and terminate its providers | `cancel <run-dir>` |
| Resume an interrupted run | `resume --detach <run-dir>` |
| Watch and restart a dead controller | `watch --detach <run-dir>` |

Every command above is a subcommand of `node "$HARNESS"`. A campaign contains
`campaign.json`, an append-only `journal.jsonl`, and a `HANDOFF.md` limited to
16 KiB. When moving between Codex, Claude Code, Cursor, or a cloud harness,
read the handoff, attach the new session, and continue. Open the original
transcript only when you need detail that was not summarized.

`doctor` never mutates the repository: it checks that `cwd` is a git work tree,
that `.runs/` is ignored, that `node` and `npm` are on `PATH`, that the harness
protocol/schema versions are current, and — when a contract is given — that
every routed driver binary exists and its runtime probes cleanly. Without a
contract no driver is required. `status --json` and `report --json` emit stable
`schemaVersion: 1` payloads for streaming monitors; `events.jsonl` records every
node transition with attempt, runtime, error code, and gate verdict.

`cancel <run-dir>` terminates the controller and every recorded provider or
verification process, then marks the run terminal. A running controller gets
`SIGTERM` and then `SIGKILL` if it does not die within two seconds; a stale
controller lease is taken over directly. The run directory's
`controller-lease.json` (and `watcher-lease.json` for the watchdog) prevents two
controllers or watchers from acting on the same run at once.

## Agent roles

| Role | Responsibility |
| --- | --- |
| Orchestrator | Reads the handoff, explores the repository once, creates packets, chooses runtimes, and decides next steps. |
| Worker | Executes a node inside `readFiles`, `writeFiles`, and `verification`; returns the structured `blocked_context` worker result when context is missing. |
| Judge | Inspects only output files and declared verification; returns an independent JSON verdict. |
| Watcher | Detects a dead controller and invokes `resume --detach`; it does not replace the orchestrator. |

A worker does not own discovery. A read-only `mode: "discovery"` node is the
only exception and must produce an execution packet for the next node.

## Supported runtimes and models

The harness supports four drivers and routes everything declaratively through
the contract. The names below are tested configurations; a driver can also
receive another compatible model.

| Driver | Models/configuration | Recommended use |
| --- | --- | --- |
| `codex` | GPT-5.6 Luna, Terra, Sol | Bounded implementation, general tasks, and independent review. |
| `claude` | Opus | Frontend or presentation work when the benefit justifies startup and cache cost. |
| `codex` + custom provider | DeepSeek V4 Flash and V4 Pro | Flash for tightly specified mechanical work; Pro when a deeper worker or judge justifies the cost. |
| `agy` | Models accepted by the `agy` CLI, such as Gemini Flash | Runtimes already available through that driver. |
| `exec-jsonl` | Any executable that speaks the JSONL protocol | Generic wrapper driver: one `run.request` line on stdin, `run.started`/`message`/`run.completed`/`run.failed` events on stdout. |

For DeepSeek, declare the provider configuration in `runtimes[].config`; the
harness sends it as `-c` overrides. Do not use profiles. `preflight` is required
to confirm that the credential serves the selected model.

## Requirements

- Node.js 22 or newer; CI exercises the current LTS and current releases on
  Linux and macOS. TypeScript is a development-only dependency for
  `npm run typecheck` (`checkJs`/`noEmit`); the runtime is plain ESM `.mjs`
  with no runtime dependencies.
- Install with `npm ci` for the deterministic lockfile. The checks are
  `npm run check` (syntax), `npm run typecheck`, and `npm test`; CI runs the
  suite twice across Node 22, 24, and 26.

## Operating policy

- The default timeout is 40 minutes (`2400` seconds). Set `4800` seconds per
  node for profile-wide or browser-heavy work; never leave that choice implicit.
- After two gate rejections or an `exhausted` state, use `findings` and create a
  single-purpose fix node. Do not copy the whole graph or keep retrying blindly.
- Run `report` after every terminal run. Token and revision totals reveal cost
  patterns before they become habit.
- While a run is live, work only on disjoint paths and stage explicitly. The
  harness does not isolate concurrent worktrees.

## Limitations

- `maxParallel` is fixed at 1: workers share the repository and the harness does
  not isolate them in git worktrees.
- Resume recovers a completed worker phase but never a partial one; a provider
  killed mid-turn is re-run from the start of the node.
- Stall detection observes byte activity only and cannot distinguish a silent
  provider cold start or long final composition from a deadlock.
- The graph has no domain-level `stopped` state; model a STOP condition as a
  fail-closed artifact check and preserve the harness terminal state separately.
- Contract packets are hashed (`packetHash`) and validated on load: regenerate the contract
  when a scoped file changes.

## Other skills

`init-harness` bootstraps repository governance: canonical `AGENTS.md`, symlinks
for other harnesses, initial documentation, ADRs, Sentrux, CI, and hooks. Read
[SKILL.md](skills/init-harness/SKILL.md) before using it.

## Repository conventions

[AGENTS.md](AGENTS.md) is the canonical guidance. `CLAUDE.md`, `GEMINI.md`,
`CURSOR.md`, `AGENT.md`, and `.github/copilot-instructions.md` are symlinks and
must not be edited directly. Run state is local and ignored by Git.

## License

[MIT](LICENSE).
