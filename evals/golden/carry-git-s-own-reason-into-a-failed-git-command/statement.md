fix(intent-factory): carry git's own reason into a failed git command

Node's execFileSync error says only "Command failed: git -C … commit -qm …"
and drops stderr, so an empty-change-set commit exiting 1 surfaced with no
reason and was misdiagnosed twice across two campaigns. Every git call in
worktree.mjs now runs through one helper that appends git's stderr.
