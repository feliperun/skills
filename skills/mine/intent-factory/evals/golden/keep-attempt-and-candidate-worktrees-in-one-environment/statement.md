fix(intent-factory): keep attempt and candidate worktrees in one environment

Both worktree creators now go through prepareWorktreeEnvironment, the single
named place that decides what a worktree needs to run repository tooling, so
the two cannot drift apart again. The previous fix linked node_modules into
the candidate at a second, independent call site and shipped without a test.

When the candidate does fail a command the attempt passed, the finding now
says so instead of blaming the node: the verdict was built from the attempt's
own passing verification, so it fell through to "verification controller
failed to execute a command" and read as a defect in correct work. That
misdirection cost intent-factory-suite-speed-20260909 four attempts.
