fix(intent-factory): close phase 1 with a green suite

Phase 1 (worktrees, integration transaction, maxParallel, runtimes[].fallback, vendor identity,
runtime discovery) was pushed at 85d53c9 with 60 failing tests. Three suite-fix takes repaired them
at the root: fixtures moved onto the attempt-worktree model, unborn fixture repositories given a
commit, resume adoption and worktree recreation repaired, a failover hop no longer framed as a gate
rejection, the paused_quota test rewritten against livenessState, two phase-1 empty catches given
real bodies, and the suite no longer spawns desktop notifications. Full suite: 622 tests, 620 pass,
0 fail, 2 skipped.
