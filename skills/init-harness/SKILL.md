---
name: init-harness
description: Installs the docs + agent harness scheme into a repository - canonical AGENTS.md with CLAUDE.md/GEMINI.md/CURSOR.md symlinks, docs/ (VISION, ARCHITECTURE, ABSTRACTIONS, GETTING-STARTED), ADRs with template and index, Sentrux structural quality gate (.sentrux/rules.toml + baseline), CI, a create-adr slash command, and githooks. Use when the user says "install harness", "init-harness", "set up docs/ADR/sentrux", or wants to bootstrap engineering governance in a new repo.
---

# init-harness

Bootstraps the **docs + agent harness scheme** in a repository. Structural gate by
[Sentrux](https://github.com/sentrux/sentrux). The playbook consolidates what is in
use in [phai](https://github.com/feliperun/phai) and
[cueme](https://github.com/feliperun/cueme).

## What it installs

| Artifact | Role |
|----------|------|
| `AGENTS.md` | Canonical playbook (guardrails, workflow, TDD, E2E, gates, ADRs, checklist) |
| `CLAUDE.md` `GEMINI.md` `CURSOR.md` `AGENT.md` | **symlinks** → `AGENTS.md` (single source) |
| `docs/VISION.md` `ARCHITECTURE.md` `ABSTRACTIONS.md` `GETTING-STARTED.md` | base docs |
| `docs/adr/` | ADRs with `README.md` (template + index + status lifecycle) |
| `docs/adr/0001..0003` | meta-ADRs documenting the harness itself |
| `docs/sentrux.md` | structural quality gate reference |
| `.sentrux/rules.toml` | absolute limits (`sentrux check`) |
| `.sentrux/baseline.json` | anti-regression reference (`sentrux gate`) |
| `.claude/commands/create-adr.md` | slash command that creates a numbered ADR and updates the index |
| `.github/workflows/quality.yml` | CI: typecheck + test + sentrux |
| `githooks/pre-commit` | local hook: secrets scan + sentrux check/gate |
| `githooks/commit-msg` | validates Conventional Commits |

## Usage

```bash
# from the target repo directory (or pass the path):
~/.agents/skills/init-harness/scripts/install-harness.sh [target-dir]

# preview without writing:
install-harness.sh --dry-run

# overwrite existing files (default: never overwrites, only warns):
install-harness.sh --force

# skip git hook installation:
install-harness.sh --no-hooks
```

The installer:

1. Detects the **project name** (repo basename) and the **stack**
   (`package.json`→node, `Cargo.toml`→rust, `pyproject.toml`→python) to fill in
   the check commands in `AGENTS.md` and CI.
2. Copies the templates **without overwriting** existing files (use `--force`).
3. Creates the `CLAUDE.md`/`GEMINI.md`/`CURSOR.md`/`AGENT.md` symlinks → `AGENTS.md`.
4. If the `sentrux` CLI is installed, runs `sentrux gate --save .` to generate the
   real `baseline.json`; otherwise leaves a placeholder with instructions.
5. Installs the hooks via `core.hooksPath` (never touches `.git/hooks` directly).
6. Is **idempotent** — running it again only fills in what is missing.

## After installing

1. Fill in the `TODO`s in `docs/VISION.md` and `docs/ARCHITECTURE.md` (the rest is
   generic structure that fits any repo).
2. Install the Sentrux CLI and run `sentrux gate --save .` if no baseline was
   generated yet (see `docs/sentrux.md`).
3. Fill in the **gotchas** section of `AGENTS.md` as failures surface — it is the
   highest-value part of the file.
4. Commit everything as a single `chore: bootstrap docs/harness (init-harness)`.
5. Enable the gate in CI (the workflow ships ready; adjust the Sentrux version).

## Conventions

- **`AGENTS.md` is the single source** of guidance; never edit the symlinks.
- **ADRs are immutable**: one decision per file, `NNNN-title.md`, monotonic
  numbering; an active ADR is never edited — supersede it.
- **Sentrux is a ratchet**: thresholds only tighten; loosening requires a
  superseding ADR. Boy Scout Rule — every file you touch leaves with an
  equal-or-better score.
- **E2E is mandatory** for key features or user-visible changes; unit tests do not
  replace it.
- **Never `--no-verify`**; never silence a rule to pass the gate.
- **Destructive actions** (merge, force-push, schema drop) require explicit human
  sign-off in the moment — the agent hands off to the user instead of routing
  around it.

## References

- Gate: [Sentrux](https://github.com/sentrux/sentrux)
- Applied in: [phai](https://github.com/feliperun/phai),
  [cueme](https://github.com/feliperun/cueme)
