# intent-factory evals

`run.mjs` discovers deterministic eval cases and runs them with zero model
invocations: every runtime in every case uses the `replay` driver
(`skills/mine/intent-factory/scripts/drivers/replay.mjs`), consuming a
recorded envelope instead of calling a real provider CLI.

## Usage

```
node evals/run.mjs --class deterministic [--case <id>] [--assert-no-model] [--verify-discriminating] [--json]
```

- `--class deterministic` runs every case under `evals/deterministic/`.
- `--case <id>` narrows to one case (combine with `--class deterministic`).
- `--assert-no-model` additionally fails if any case's contract declares a
  runtime whose driver is not `replay`, and runs with
  `INTENT_FACTORY_CODEX_BIN`, `INTENT_FACTORY_CLAUDE_BIN`,
  `INTENT_FACTORY_AGY_BIN`, and `INTENT_FACTORY_GLM_BIN` unset, so any code
  path that actually needed one of those to resolve a provider CLI fails
  loudly instead of silently reaching a real local install.
- `--verify-discriminating` does not check any case against its
  `expected.json`. Instead, for each case it applies the case's declared
  `discriminator` mutation (see below) to a fresh copy of its `setup` steps
  and requires the mutated run to fail. A case that still passes with its
  discriminator applied does not prove what it claims and is reported as a
  failure naming the case; a case with no `discriminator` block is also a
  failure. Combine with `--case <id>` to check one case.
- `--json` prints the report as JSON instead of a human-readable summary.
- An unknown flag exits 2.

## Indicator projection and comparison

```
node evals/run.mjs --project <runDir>... [--campaign <id>] [--note <text>] [--json]
node evals/run.mjs --compare <before.json> <after.json> [--json]
```

`--project` reads one or more orchestrator run directories' own
`events.jsonl` and `usage.jsonl` (never a node snapshot or a hand-written
number — see `evals/metrics.mjs`'s `projectEvalIndicators`) and prints the
indicator report: `costPerClosedCheckpoint`, `firstPassGateRate` (grouped by
node id), `judgeInvocationRate`, `revisionsPerDone`, `blockedContextRate`,
`wallClockPerClosedCheckpoint`, `providerFailoverRate`, and
`protocolFailureRate`. An indicator with no supporting record is `null`,
never `0`. More than one `<runDir>` concatenates their records first — a
campaign built from several sequential orchestrator runs has no single
directory holding every record. The printed report carries a `provenance`
block (`campaign`, `runIds`, `runDirs`, `generatedAt`, `note`) so it can be
regenerated and checked against the run directories it claims to measure;
`evals/baseline.json` and `evals/fixtures/{a,b}.json` are this command's own
output, not written by hand.

`--compare` reads two such reports (either the bare indicator map or the
`--project`-shaped `{provenance, indicators}` wrapper) and prints, per
indicator, each side's value and sample count, the delta, and the direction
that counts as improvement. Comparing a `null` indicator against a measured
number never produces a numeric delta — it reports "sem base de
comparacao" (`comparable: false`) instead of a delta that would silently
read as zero.

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

A recorded envelope's `error.resetAt` and top-level `exhaustedUntil` are both
optional, and both may carry a relative placeholder — the string
`"+<milliseconds>"` — instead of an absolute timestamp. The harness resolves
it to a real ISO timestamp, measured from the moment the case is
materialized, before the recording is copied into the workspace; the
`replay` driver itself never sees the placeholder, only the resolved literal
string, exactly the shape a real driver would produce. Use this for a case
whose scenario turns on a reset landing inside a window measured from
whenever the suite happens to run (see D04's `primary.jsonl`); an absolute
timestamp works too when the exact instant does not matter to the case.

A recording only stands in for a prompt invocation — the live version probe
(`probeRuntime`, run once per declared runtime whenever a contract leaves a
role's runtime to be composed) never touches it. A case whose scenario turns
on that probe's own classification (e.g. distinguishing an insufficient-
balance stop from a quota stop from a missing CLI) instead sets a runtime's
`config["replay.probe"]` to `{"exitCode": <int>, "stderr": "<text>"}`
directly in `case.json`; the replay driver carries it to `replay-bin.mjs` as
a `--replay-probe` argument for the `--version` invocation only, so it never
touches or consumes a recording (see D06).

### `case.json`

```jsonc
{
  "id": "D01",
  "title": "one line",
  "proves": "one sentence: what this case proves",
  "contract": { /* a complete, valid schemaVersion 3 contract */ },
  "recordings": { "<runtimeId>": "<recording-file>.jsonl" },
  "setup": [ /* optional, see below */ ],
  "discriminator": { /* required, see below */ }
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
| `writeLock` | `processStartToken?` | writes `controller.lock` directly (bypassing `acquire()`'s own exclusivity checks) for this process's own pid; `processStartToken` defaults to this process's real token (a genuinely live-looking lock) and may be overridden with any other string to plant a lock whose recorded token no longer matches the live process holding that pid — standing in for a controller pid later reused by an unrelated process |
| `rewindNodeToRunning` | `node` | rewrites `nodes/<node>.json` back to `status: "running"`, `phase: "worker"`, `result: null`, `gate: null`, keeping everything else (in particular `invocations`) — the same rewind `test/helpers.mjs`'s `orphan()` does, standing in for a controller that died with this node's invocation already finished on disk but never processed |
| `recreateAttemptWorktree` | `node` | when `nodes/<node>.json`'s `worktree.status` is `"removed"`, recreates that attempt's worktree on the existing attempt branch and updates the node's `worktree` to `"ready"` at the recreated path — the same recreation `test/helpers.mjs`'s `ensureAttemptWorktree()` does, needed before recovering an orphaned node whose prior integration already sealed and removed its worktree; a no-op otherwise |
| `preflight` | — | calls `preflightContract(contractPath, {static: true})` — the same static, no-model probe the `preflight` CLI command runs, one `probeRuntime` call per reachable runtime, including every candidate of a role a contract leaves for the factory to compose — and writes the returned array to `preflight.json` in the case workspace root. Unlike `run`/`resume`, this never throws when a reachable runtime cannot be probed; a case whose point is exactly that a bad runtime is classified, not that it blocks a run, uses this instead (see D06) |

`env` overlays environment variables for the duration of that one step only
(restored immediately after). `expectError` is a regular expression (string,
case-insensitive); when present, the step's call must reject with a message
matching it, or the case fails — this is how a case pins a crash without
needing a second field in `expected.json` to describe the rejection.

### `discriminator`

Every case must declare a `discriminator`: one mutation that must make the
case fail. A case whose expected outcome does not actually depend on
whatever the mutation touches proves nothing — `--verify-discriminating`
catches that by requiring the mutated run to fail.

Every mutation is applied only in memory — to the normalized step list, to a
fresh in-memory clone of the contract, or to a recording only after it has
been copied into the case's temporary workspace — and never touches a file on
disk, versioned or otherwise.

| type | fields | effect |
|---|---|---|
| `removeSetupStep` | `indices` (non-empty array of step indices) | drops those steps before running the case |
| `patchContractField` | `path` (non-empty array of object keys / array indices), and either `value` or `remove: true` | sets, or deletes, one field of the materialized contract before the run |
| `patchRecordingErrorCode` | `runtime` (a key in the case's `recordings`), `code`, `index` (optional, defaults to `0`) | rewrites `envelope.error.code` on one line of that runtime's recording before it is copied into the workspace |
| `patchRecordingEnvelopeField` | `runtime` (a key in the case's `recordings`), `path` (non-empty array of keys relative to that line's `envelope`), `index` (optional, defaults to `0`), and either `value` or `remove: true` | sets, or deletes, one field of one recorded envelope (e.g. `["error", "resetAt"]`) before it is copied into the workspace |

Pick a mutation that, once applied, necessarily changes the run's outcome —
not merely one that happens to touch something that exists. If a declared
discriminator does not make its case fail, the case's `setup`, `contract`, or
`expected.json` is wrong and needs fixing; the discriminator requirement
itself does not bend.

`removeSetupStep` is rejected as invalid — not merely a failing mutation —
when it would remove every `run`/`resume` step from the case's setup. A case
with no step left to execute fails because nothing ran at all, not because of
whatever the case claims to prove, which would let `--verify-discriminating`
pass on a case that proves nothing. A case whose `setup` is a single `run`
step (the default for an omitted `setup`) can never use `removeSetupStep` for
this reason; reach for `patchContractField`, `patchRecordingErrorCode`, or
`patchRecordingEnvelopeField` instead, varying exactly the one value the
case's `proves` claim turns on.

### `expected.json`

```jsonc
{
  "nodes": {
    "<node-id>": {
      "status": "done",
      "errorCode": null,
      "revisions": 0,
      "runtimeIds": ["replay-worker"],
      "routingHistoryLength": 0,
      "integratedHead": true
    }
  },
  "integration": {
    "runRefMatchesIntegratedHead": ["<node-id>"],
    "acceptedRecords": [{ "node": "<node-id>", "attempt": 1 }],
    "worktreesAbsent": {
      "attempts": [{ "node": "<node-id>", "attempt": 1 }],
      "candidate": true
    }
  },
  "preflight": {
    "<runtime-id>": { "available": false, "exhaustedUntil": null, "reason": "insufficient_balance" }
  }
}
```

Every field is optional; only what a case declares is checked. `nodes` fields
read directly off the node's persisted snapshot
(`.runs/<contractId>/nodes/<node-id>.json`) after every `setup` step has run:

- `status` — the node's terminal status.
- `errorCode` — `error.code`, or `null` when the node has no error.
- `revisions` — the revision counter.
- `runtimeIds` — `invocations[].runtimeId`, in order (worker and judge
  invocations together, in the order they actually ran).
- `routingHistoryLength` — the length of `routing.history` (fallback/backoff
  hops; a gate-triggered revision retry is not a hop and does not add to it).
- `integratedHead` — `true` requires a published sha (a non-null string),
  `false` requires `null`, and a string requires that exact sha.

`integration` checks facts that live outside any one node's snapshot — the
actual publication a resume or recovery claims to finish, not just the node's
own after-the-fact bookkeeping:

- `runRefMatchesIntegratedHead` — an array of node ids; for each, the run's
  git ref (`refs/intent-factory/<runId>/run`) must exist and equal that
  node's `integratedHead`.
- `acceptedRecords` — an array of `{node, attempt}`; each must have an
  `"accepted"` record in `integration.jsonl`.
- `worktreesAbsent.attempts` — an array of `{node, attempt}`; each attempt
  worktree must no longer exist on disk.
- `worktreesAbsent.candidate` — when `true`, the run's `.candidate` worktree
  must no longer exist on disk.

`preflight` checks a map from runtime id to that runtime's exact `availability`
entry (`{available, exhaustedUntil, reason}`) in the `preflight.json` a
`preflight` setup step wrote; only the named runtime ids are checked. A case
using this needs a `preflight` step in its `setup` — this section, not a
`nodes` entry, is how a case pins the live probe's own classification for a
runtime no `run`/`resume` step ever dispatches.

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
5. Write a `discriminator` (see above) and confirm with
   `node evals/run.mjs --class deterministic --case <id> --verify-discriminating`
   that the mutation it names actually makes the case fail. If it does not,
   `expected.json` is not checking what the case claims to prove — fix the
   case, not the discriminator.
6. Run `node evals/run.mjs --class deterministic --case <id> --json` and
   confirm it passes; then run the whole class to confirm you have not
   broken anything else.
7. If the scenario is expressible only partly through `replay` (it needs real
   filesystem or git state `replay` cannot produce), use `setup` for the rest
   and say exactly what is synthesized in `proves` — never invent a fake
   model response to stand in for a scenario `replay` cannot express.

## Golden set

```
node evals/build-golden.mjs
node evals/run.mjs --validate-golden --min <n> [--json]
node evals/run.mjs --verify-fixtures [--json]
```

`evals/golden/<task-id>/` holds one task per real commit in this
repository's own history — never a hand-written scenario. `build-golden.mjs`
(re)builds the whole directory from git plumbing: a curated list of commits
the intent-factory itself integrated into `main` (see
`docs/intent-factory/TECH-SPEC-2026-09-09.md` §C1.3), plus every `fix`
commit whose own diff touches both
`skills/mine/intent-factory/scripts/` and `skills/mine/intent-factory/test/`
in the same commit — a correction landed together with the test that pins
it, discovered by walking `main`, not picked by hand.

Each task directory has:

- `statement.md` — the node's original `taskPacket`, read verbatim from
  `.runs/<runId>/contract.json` when that run directory still exists, or
  (almost always, since old runs get pruned) the commit's own message,
  untouched. Never rewritten: a later paraphrase of what the task asked for
  would contaminate any measurement run against it.
- `verify.json` — `{source, commands}`. `source: "taskPacket"` when the
  node's own declared `verification` survived in `contract.json`;
  otherwise `source: "diff"` and `commands` is derived mechanically from the
  commit's own diff — `node --check <file>` for every non-test `.mjs` file
  it touches, `node --test <file>` for every `*.test.mjs` file it touches.
  Every command is the same `{argv, ...}` shape
  `validateVerificationCommands` (`skills/mine/intent-factory/scripts/verification.mjs`)
  already enforces on a real contract.
- `meta.json` — `commitSha`, `parentSha`, `parentTreeSha` (the parent
  commit's git tree id, what `--verify-fixtures` checks the bundle against),
  and, when a run directory survived to report them, `runtimeOriginal`,
  `costUsdOriginal`, `wallClockSecOriginal` — `null`, never `0`, when
  unknown.

Every task's parent commit lives in the single shared
`evals/golden/fixtures.bundle` instead of a `fixture.bundle` per task: the
parent commits share most of their ancestry, so one bundle covering all of
them packs to roughly a twenty-fifth the size of one shallow bundle per
task repeated.

- `--validate-golden --min <n>` fails if there are fewer than `n` task
  directories, if any is missing `statement.md`/`verify.json`/`meta.json`,
  or if `verify.json`'s commands do not validate as a real verification-command
  list.
- `--verify-fixtures` fetches each task's `parentSha` from the bundle into a
  throwaway bare repository and compares the restored tree id against
  `meta.json`'s `parentTreeSha`, failing loudly if any task does not
  restore or the tree does not match.
