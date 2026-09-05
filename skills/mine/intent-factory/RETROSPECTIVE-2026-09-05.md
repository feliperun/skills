# Retrospective: efficiency campaign, release 0.2.0

Campaign `intent-factory-efficiency-20260901`, closed 2026-09-05. Four phases
shipped release 1: ambient feedback, gate economy, deterministic resilience,
metrics.

## Measured

Projected by the `metrics` CLI this campaign built, over its own artifacts:

| Indicator | Value | Target |
|---|---|---|
| `weightedPerClosedCheckpoint` | 1.70 M | below 0.5 M |
| `takesPerClosedCheckpoint` | 2.04 | down |
| `firstPassGateRate` | sol-medium 0.5 | up |
| `blockedContextRate` | 0.089 | down |
| `lostTakeRate` | 0.230 | down |
| `sessionWakeCount` | 0 | below 3 |
| `sessionContextGrowth` | 0 | below 4 k |
| `silentStallRate` | 1 | zero |
| `ambientCoverage` | 0.046 | above 0.95 |

49 runs, 477 events, 20 indicators.

Two of those numbers are measurement defects rather than campaign defects, and
they are the first thing release 2 should fix. `ambientCoverage` and
`silentStallRate` both measure against wall-clock campaign span, but this
campaign ran over four days of human-paced work in which no run was active for
most of the hours. A heartbeat that is absent while nothing is running is not
a coverage failure, and a gap between two operator dispatches is not a silent
stall. Both should measure over active run time.

`weightedPerClosedCheckpoint` at 3.4x its target is real, and the reason is in
the takes.

## What cost the campaign

**Contract authoring, not worker capability.** Seven of the blocked nodes were
defects in packets I wrote, against five genuine findings from gates. The
pattern was identical every time: an instruction demanding something the scope
forbade. A module to extract into that was never in `writeFiles`; a fixture
directory the packet described and the scope did not allow; a read set missing
the two files that held the fact the node needed; and, worst, an extraction
target that was the very file under ratchet pressure, which left the node no
green path and forced it to raise a ceiling the rule forbids.

The lesson generalises past this campaign: **a closed packet is only closed if
its scope can satisfy every instruction in it.** Checking that is mechanical
and nobody was doing it.

**The judge was the weak link, not the workers.** In phase 4 the judge stalled
or emitted multiple terminal-shaped messages in three of five gate attempts
while every worker effect verified green. Three nodes closed by orchestrator
validation against mechanical evidence rather than a model verdict. That is
the designed fallback, and it worked, but a gate that cannot deliver a verdict
in half its attempts is not yet a gate.

**Workers refused to fudge, repeatedly.** A worker declined to write outside
its scope and named the missing file; another refused to tune
`takesPerClosedCheckpoint` to match a recorded number and said so, which
forced the definition to be settled in the open. That behaviour is worth more
than the nodes it cost.

## What changed the numbers

Switching workers from `deepseek-v4-flash` to `claude-opus-5` mid-campaign.
The conditional-judge node failed its gate twice on the flash worker across
two full phase buckets, then passed clean on the first Opus dispatch. Cost per
node rose; cost per *closed* node fell.

`finalVerification` earned its place on first use: `failover-synthesis` passed
its own gate and its own targeted suite, and the phase-terminal full suite
then caught that it had broken a test in another area. No per-node gate can
see a cross-node regression.

## Field report from another campaign

A peer session running a 16-node campaign in a different repository reported
seven defects against this runner. Four were confirmed here. The costly one
was ours, shipped in phase 2: a failing command proof whose output exceeded
4 KiB produced a finding the validator rejects, and the rejection killed the
controller. Root cause was an off-by-one in truncation. Fixed with a
regression test in the minimal shape the reporter isolated.

One of my two fixes was wrong. I extended the same reasoning to `parseJudge`
and broke a test that encodes deliberate behaviour: that throw is caught and
becomes `invalid_judge_output`. The reporter had explicitly said their
evidence did not cover that path. It was reverted.

## Carried to release 2

- Workers cannot read outside the worktree: no `--add-dir` and no contract
  field grants one. The most expensive defect in the field report.
- `writeRoots` accepts only directories, so a toolchain that rewrites a root
  lockfile kills a node that delivered.
- `resume` refuses a `gitHead` descendant, so it is unusable after a worker
  commits — which is the designed behaviour of a worker.
- Mechanical proof output is not persisted while controller verification is,
  so the crashing path is the one without diagnostic evidence.
- `validate` should warn when `failOn` omits `major`.
- `finalVerification` is capped at 600 s and this suite now exceeds it; the
  terminal node cannot prove itself and the orchestrator has to.
- `ambientCoverage` and `silentStallRate` must measure over active run time.
