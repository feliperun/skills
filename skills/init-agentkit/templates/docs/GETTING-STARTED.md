# Getting Started

## Prerequisites

- TODO — runtime/toolchain versions.
- [Sentrux CLI](sentrux.md#install) for the structural quality gate.

## Quick start

```bash
# TODO: install deps
# TODO: configure secrets (.env from .env.example)
# TODO: run locally
```

## Daily commands

```bash
{{CHECK_SUITE}}            # types + tests
sentrux check .           # architectural rules
sentrux gate .            # no structural regression
```

## Worktree workflow

```bash
# Create a worktree for a task (keeps main clean):
git worktree add ../{{PROJECT}}-<task> -b <dev>/<issue>-<slug>
```

## Documentation map

- [Vision](VISION.md) — why this exists
- [Architecture](ARCHITECTURE.md) — current-state structure
- [Abstractions](ABSTRACTIONS.md) — the vocabulary
- [ADRs](adr/README.md) — decision history
- [Sentrux](sentrux.md) — the quality gate
- [AGENTS.md](../AGENTS.md) — the contributor/agent playbook

## First contribution checklist

- [ ] Read [AGENTS.md](../AGENTS.md).
- [ ] Run the check suite locally and confirm it's green.
- [ ] `sentrux gate --save .` before touching existing files.
