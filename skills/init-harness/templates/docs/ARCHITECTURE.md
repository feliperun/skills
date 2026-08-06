# Architecture

> Current-state summary. ADRs in [adr/](adr/README.md) hold the history and the
> *why*; this file reflects only **active** decisions. Update it in the same
> commit as any structural change.

## High-level flow

TODO — diagram or prose of the main request/data path.

## Components

TODO — the major modules and their responsibilities.

## Runtime & hosting

TODO — where it runs, how it's deployed.

## Observability & quality

- Type checks + tests run on every push (see [Getting Started](GETTING-STARTED.md)).
- Structural health gated by [Sentrux](sentrux.md).
- Errors/telemetry: TODO.

## Security model

TODO — authn/authz, secret handling, data sensitivity.

## Related docs

- [Vision](VISION.md) · [Abstractions](ABSTRACTIONS.md) · [ADRs](adr/README.md) · [Sentrux](sentrux.md)
