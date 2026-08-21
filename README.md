# skills

Personal catalog of reusable agent skills, organized by provenance and
installable into any repository with a single command.

## Layout

| Bucket | Meaning |
|--------|---------|
| [`skills/mine/`](skills/mine/) | Skills authored from scratch in this repository. ⭐ |
| [`skills/curated/`](skills/curated/) | Community skills adapted to a personal workflow. 💎 |
| [`skills/community/`](skills/community/) | Skills copied verbatim from the community. |

Each skill is one folder with a `SKILL.md`; scripts, references, and templates
live inside the skill so it stays a single copyable unit.

## Install

```bash
npx github:feliperun/skills             # every `mine` skill → .claude/skills/ of the current repo
npx github:feliperun/skills plan-runner # one named skill
npx github:feliperun/skills list        # show the catalog
npx github:feliperun/skills --global    # install into ~/.claude/skills/ instead
npx github:feliperun/skills --force     # replace skills that already exist
```

`npx` needs the repository to be reachable (public, or private with git
credentials). Without npx, copy or symlink a skill folder into
`~/.claude/skills/` or `.claude/skills/`:

```bash
cp -r skills/mine/plan-runner ~/.claude/skills/plan-runner
ln -s "$(pwd)/skills/mine/init-agentkit" ~/.claude/skills/init-agentkit
```

## Skills

### plan-runner

Executes large implementation plans as observable multi-model DAGs outside the
orchestrator's context: declarative routing (Claude or Codex workers, including
DeepSeek through Codex custom providers), closed task packets, structured
cross-model quality gates, bounded revisions, campaign journaling with
`HANDOFF.md`, and a built-in `supervise` watchdog that keeps resuming a dead
controller until the run is terminal — from any host scheduler (launchd, cron,
CI, or another agent), with no dependency on the orchestrator's runtime.

Quickstart, in the repository that will receive the implementation:

```bash
PLAN_RUNNER=/path/to/skills/skills/mine/plan-runner/scripts/runner.mjs
TARGET=/path/to/target-repository

rg -qxF '.runs/' "$TARGET/.gitignore" || printf '\n.runs/\n' >> "$TARGET/.gitignore"
node "$PLAN_RUNNER" campaign init feature-42 --cwd "$TARGET" --goal "Deliver feature 42"
node "$PLAN_RUNNER" campaign attach feature-42 --cwd "$TARGET" --tool codex --session-id <session-id> --no-transcript
```

Inspect the target once, write the contract and its task packets, then:

```bash
node "$PLAN_RUNNER" validate contract.json
node "$PLAN_RUNNER" preflight contract.json
node "$PLAN_RUNNER" run --detach contract.json
node "$PLAN_RUNNER" supervise --detach "$TARGET/.runs/<run-id>"   # unattended resume
```

| Goal | Command |
| --- | --- |
| Find the active campaign | `campaign list --cwd <repo>` |
| Validate a contract | `validate <contract.json>` |
| Check credentials, models, binaries | `preflight <contract.json>` / `doctor [--cwd <dir>]` |
| Start without blocking the session | `run --detach <contract.json>` |
| Read current state | `status <run-dir>` / `status --json <run-dir>` |
| View attempts and tokens | `report <run-dir>` |
| Prepare a repair after gate exhaustion | `findings <run-dir>` |
| Stop a run and terminate its providers | `cancel <run-dir>` |
| Resume an interrupted run | `resume --detach <run-dir>` |
| Keep a dead controller alive | `supervise --detach <run-dir> [--interval 30]` |

Operational detail: [SKILL.md](skills/mine/plan-runner/SKILL.md) and the
[contract reference](skills/mine/plan-runner/references/contract.md).

### init-agentkit

Bootstraps the agent kit into a repository: canonical `AGENTS.md` with
`CLAUDE.md`/`GEMINI.md`/`CURSOR.md`/`AGENT.md` symlinks, base docs (VISION,
ARCHITECTURE, ABSTRACTIONS, GETTING-STARTED), ADRs with template and index, the
Sentrux structural quality gate, a `create-adr` slash command, and githooks.
Always ask which compatibility rule applies before running it — see
[SKILL.md](skills/mine/init-agentkit/SKILL.md).

### session-memory

Keeps long sessions cheap across usage-limit resets: save a curated handoff to
`.claude/session-handoff.md` while the session is warm (input cached, so the
save costs little), then continue in a fresh session that reads only the
handoff — instead of re-reading the whole conversation without cache. This
repository wires the [SessionStart hook](.claude/hooks/session-start.mjs) that
injects a fresh handoff automatically. See
[SKILL.md](skills/mine/session-memory/SKILL.md).

## Development

- Node.js 22 or newer; the runtime is plain ESM `.mjs` with no runtime
  dependencies. TypeScript is a development-only check (`checkJs`/`noEmit`).
- `npm run check` — syntax; `npm run typecheck` — static types; `npm test` — the suite.
- The skills of this repository stay active inside it through symlinks in
  `.claude/skills/`.
- [AGENTS.md](AGENTS.md) is the canonical guidance; the other agent files are
  symlinks to it — never edit them.

## Inspiration

The memory-layer split (session handoff / campaign handoff / standing memory)
draws on [ai-memory](https://github.com/akitaonrails/ai-memory) by Akita on
Rails. Most other patterns here — compile-not-retrieve summaries,
start-of-session handoff injection, cross-harness workstreams — converged
independently.

## License

[MIT](LICENSE).
