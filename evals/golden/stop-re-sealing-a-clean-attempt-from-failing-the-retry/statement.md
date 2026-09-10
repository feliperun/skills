fix(intent-factory): stop re-sealing a clean attempt from failing the retry

sealAttempt probed for dirtiness with only .runs excluded, but the staging
step also unstages node_modules — a symlink that node_modules/ in .gitignore
never matches. An already-sealed attempt whose sole entry was that link read
as dirty, staged it, unstaged it, and then committed an empty change set,
which exits 1 and surfaced as worktree_create_failed. Every retry and resume
of a sealed node died there: it killed both nodes of
intent-factory-gaps-20260909-run1 and blocked the resume of
intent-factory-suite-speed-20260909-run2. The probe now excludes exactly what
the staging step unstages.
