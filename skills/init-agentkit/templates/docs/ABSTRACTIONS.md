# Abstractions

> The vocabulary of this codebase: the core types/modules and the contracts
> between them. Read this before adding a new module — reuse an abstraction
> before inventing one.

## Core layers

TODO — name each layer (e.g. transport / domain / lib) and its single responsibility.

## External systems

TODO — every system this repo talks to, and the boundary type that wraps it.

## Contracts & invariants

TODO — the rules that must always hold (validation points, error/UX contracts).

## Quality & governance

- Structural limits live in `.sentrux/rules.toml`; regression baseline in `.sentrux/baseline.json`.
- Architecture decisions are recorded as [ADRs](adr/README.md).

## Adding a new module — checklist

- [ ] Does an existing abstraction already cover this? Reuse it.
- [ ] Inputs/outputs validated at the boundary.
- [ ] Unit tests close to the change.
- [ ] `sentrux gate .` shows no degradation.
- [ ] ADR if it introduces a cross-cutting pattern or external dependency.
