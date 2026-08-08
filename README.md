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

### `humanize`

Rewrites authored prose to strip the structural fingerprints of LLM writing. It
attacks construction decisions — thematic determinacy, causal linearity, embodied
emotion, vague reference, low variance — rather than lexical surface, because
span-level surface rewriting only drops narrative-feature detection by 1.6 points.
Based on Russell et al., "StoryScope: Investigating idiosyncrasies in AI fiction"
(COLM 2026, arXiv:2604.03136). Not for regulated docs or specs, where thematic
unity and linearity are requirements.

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
