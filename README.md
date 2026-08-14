# harness

My agent harness: canonical instructions, skills, subagents, hooks, and tools.
Single source for the assistants I use, and a versioned backup.

## Layout

| Path | Contents |
| --- | --- |
| `AGENTS.md` | Canonical instructions for **this** repo. Every other instruction file is a symlink to it. |
| `skills/` | Skills (Claude Code / agent skills). |
| `agents/` | Subagent definitions. |
| `hooks/` | Session and tool-use hooks. |
| `tools/` | Helper CLIs and scripts. |

## Skills

### `init-harness`

Bootstraps engineering governance in a repository: a canonical `AGENTS.md` with
symlinks, `docs/` (VISION, ARCHITECTURE, ABSTRACTIONS, GETTING-STARTED), ADRs with
a template and an index, the [Sentrux](https://github.com/sentrux/sentrux)
structural gate, CI, a `/create-adr` slash command, and githooks (secrets scan +
Conventional Commits).

```bash
skills/init-harness/scripts/install-harness.sh --dry-run   # preview
skills/init-harness/scripts/install-harness.sh <repo>      # install
```

The playbook in `skills/init-harness/templates/AGENTS.md` consolidates what is in
use in [phai](https://github.com/feliperun/phai) and
[cueme](https://github.com/feliperun/cueme).

### `run-harness`

Executes an implementation plan as a file-backed DAG while the current agent
session stays responsive. Routes node types to Claude or Codex runtimes, supports
custom providers such as DeepSeek through Codex, detects stalled workers, and
runs bounded structured quality gates. Progress is read from `.runs/<id>/STATUS.md`;
worker logs stay out of the main context.

Every node now receives a closed task packet (`taskPacket`/`taskPacketFile`), so
the orchestrator performs repository discovery once and workers/judges inspect
only the listed paths. Runs also join a durable campaign with an append-only
journal and a bounded `HANDOFF.md`, keeping handoff state across runs, crashes,
and resumes.

`preflight` probes every routed runtime with a real read-only call before any
state exists, because a valid credential does not mean the provider serves that
model. `run --detach` forks the controller into its own process group so it
survives the invoking session. `resume` continues an interrupted run from its
own directory: a worker is detached and can outlive its controller, so a log
that proves its own turn completed is adopted rather than paid for twice.

See the [usage manual](docs/HARNESS.md) for setup, contracts, model routing,
`/btw` status, gates, troubleshooting, and v0 limitations.

## Canonical instructions

`AGENTS.md` is the only editable file. These point to it:

```
CLAUDE.md
GEMINI.md
CURSOR.md
AGENT.md
.github/copilot-instructions.md
```

To add another assistant: `ln -sf AGENTS.md NEW.md`.

## License

[MIT](LICENSE).
