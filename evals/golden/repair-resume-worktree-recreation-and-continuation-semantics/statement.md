fix(intent-factory): repair resume worktree recreation and continuation semantics

Two runner.test.mjs fixtures rewrote node.json without recreating the
attempt worktree ensureAttemptWorktree produces, so resume operated on
a removed worktree and failed instead of adopting the work. And the
capped-continuation test still expected pre-worktree behaviour (a
timed-out invocation's session resumed across attempts); attempt
isolation (TECH-SPEC F23) ties continuation identity to the attempt's
own worktree, so resume re-dispatches it as a fresh attempt instead —
the test and its fixture now assert that.
