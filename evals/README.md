# intent-factory evals

`run.mjs` discovers deterministic eval cases and runs them with zero model
invocations: every runtime in every case uses the `replay` driver
(`skills/mine/intent-factory/scripts/drivers/replay.mjs`), consuming a
recorded envelope instead of calling a real provider CLI.

## Usage

```
node evals/run.mjs --class deterministic [--case <id>] [--assert-no-model] [--json]
```

- `--class deterministic` runs every case under `evals/deterministic/`.
- `--case <id>` narrows to one case (combine with `--class deterministic`).
- `--assert-no-model` additionally fails if any case's contract declares a
  runtime whose driver is not `replay`, and runs with
  `INTENT_FACTORY_CODEX_BIN`, `INTENT_FACTORY_CLAUDE_BIN`,
  `INTENT_FACTORY_AGY_BIN`, and `INTENT_FACTORY_GLM_BIN` unset, so any code
  path that actually needed one of those to resolve a provider CLI fails
  loudly instead of silently reaching a real local install.
- `--json` prints the report as JSON instead of a human-readable summary.
- An unknown flag exits 2.

Exit code is 1 if any case fails, 0 otherwise.

## Case format

Each case lives in its own directory under `evals/deterministic/<case-id>/`
and has:

- `case.json` — the scenario.
- `expected.json` — the facts the run must show at the end.
- one recording file per runtime the contract declares (referenced from
  `case.json`'s `recordings`), each a `.jsonl` file consumed in order by the
  `replay` driver (see `skills/mine/intent-factory/scripts/drivers/replay.mjs`
  and `replay-bin.mjs` for the exact envelope schema).

### `case.json`

```jsonc
{
  "id": "D01",
  "title": "one line",
  "proves": "one sentence: what this case proves",
  "contract": { /* a complete, valid schemaVersion 3 contract */ },
  "recordings": { "<runtimeId>": "<recording-file>.jsonl" },
  "setup": [ /* optional, see below */ ]
}
```

`contract` is a full intent-factory contract (schemaVersion 3). Every
`runtimes` entry the contract declares must use `"driver": "replay"`; the
harness injects `config["replay.recording"]` itself, pointed at a fresh copy
of the recording named in `recordings` for that runtime id — do not set
`replay.recording` by hand in `case.json`. Omit `cwd`: the harness always
materializes the contract at the root of a fresh temporary git repository and
runs it there.

`setup` is an ordered list of steps executed before the run's final state is
compared to `expected.json`. When omitted (or empty), the harness runs
exactly one step: `{"type": "run"}`. A case whose scenario needs more than a
single clean run — a crash and its resume, a rejected concurrent resume,
deterministic filesystem preparation the `replay` driver cannot express on its
own — declares the full ordered sequence here, including the final step whose
resulting run directory is what gets compared to `expected.json`.

Step types:

| type | fields | effect |
|---|---|---|
| `run` | `env?`, `expectError?` | calls `runContract(contractPath)` |
| `resume` | `options?`, `env?`, `expectError?` | calls `resumeRun(runDir, options)` |
| `holdControllerLock` | — | acquires the run's `controller.lock` for this process, synthesizing a concurrent holder |
| `mkdirp` | `path` | `mkdirSync(path, {recursive: true})`, relative to the case workspace root |
| `writeFile` | `path`, `content` | writes a file, relative to the case workspace root |

`env` overlays environment variables for the duration of that one step only
(restored immediately after). `expectError` is a regular expression (string,
case-insensitive); when present, the step's call must reject with a message
matching it, or the case fails — this is how a case pins a crash without
needing a second field in `expected.json` to describe the rejection.

### `expected.json`

```jsonc
{
  "nodes": {
    "<node-id>": {
      "status": "done",
      "errorCode": null,
      "revisions": 0,
      "runtimeIds": ["replay-worker"],
      "routingHistoryLength": 0
    }
  }
}
```

Every field is optional; only what a case declares is checked. Fields read
directly off the node's persisted snapshot
(`.runs/<contractId>/nodes/<node-id>.json`) after every `setup` step has run:

- `status` — the node's terminal status.
- `errorCode` — `error.code`, or `null` when the node has no error.
- `revisions` — the revision counter.
- `runtimeIds` — `invocations[].runtimeId`, in order (worker and judge
  invocations together, in the order they actually ran).
- `routingHistoryLength` — the length of `routing.history` (fallback/backoff
  hops; a gate-triggered revision retry is not a hop and does not add to it).

## Adding a case

1. Pick the next case id and create `evals/deterministic/<id>/`.
2. Write `case.json` with a minimal contract that proves exactly one thing.
   Prefer the simplest scenario that reaches the code path under test — most
   cases need only a single `run` step with no `setup` at all.
3. Write one recording file per runtime (envelopes must carry every field the
   schema requires: `status`, `result`, `continuationId`, `usage`, `costUsd`,
   `error`; add `files` for the envelope to also write into the workspace).
4. Write `expected.json` with only the fields the case actually needs to
   prove its point.
5. Run `node evals/run.mjs --class deterministic --case <id> --json` and
   confirm it passes; then run the whole class to confirm you have not
   broken anything else.
6. If the scenario is expressible only partly through `replay` (it needs real
   filesystem or git state `replay` cannot produce), use `setup` for the rest
   and say exactly what is synthesized in `proves` — never invent a fake
   model response to stand in for a scenario `replay` cannot express.
