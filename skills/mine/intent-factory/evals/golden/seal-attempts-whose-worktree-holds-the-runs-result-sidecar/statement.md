fix(intent-factory): seal attempts whose worktree holds the .runs result sidecar

sealAttempt named the attempt-local .runs sidecar through an exclude pathspec, and git add exits 1
with advice.addIgnoredFile as soon as that ignored directory exists, which is exactly when a real
worker has finished; no non-empty attempt could ever be sealed or integrated. Stage the worktree,
then unstage .runs, so the sidecar never enters an attempt commit whether or not the repository
ignores it. Regression test on the replay fixtures.
