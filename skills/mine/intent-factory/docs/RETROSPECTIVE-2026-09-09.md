# Retrospective — intent-factory-gaps-20260909

Closed 2026-09-09. Two runs against branch `work/fixes` (since merged to
`main` and deleted), 7 nodes dispatched, 4 integrated. This campaign closed
the three known gaps left open by
[RETROSPECTIVE-2026-09-08.md](RETROSPECTIVE-2026-09-08.md).

## What shipped

1. **The `lease-liveness.mjs` / `lock.mjs` boundary is resolved.** The known
   gap described `lease-liveness.mjs` as "not renamed or folded into
   `lock.mjs`". Inspection found the boundary was worse and simpler than
   that: `store.mjs`'s entire pre-lean lease/generation-fence subsystem —
   `acquireLease`, `leaseHealthy`, `captureLeaseSlot`, `installFencedLease`,
   `createLeaseHandle`, `acquireFileMutationLock`, `LeaseBusyError`,
   `LeaseLostError`, `DEFAULT_LEASE_TTL_MS` and their private helpers — had
   **no caller anywhere outside `store.mjs` itself**, in production or in
   test. Rule 5 had replaced it with `controller.lock` and left it standing.
   It is deleted (473 lines out of `store.mjs`), `lease-liveness.mjs` is
   deleted (323 lines), and only the four predicates `runner.mjs`'s
   detached-bootstrap handshake actually calls (`bootstrapMatchesChild`,
   `bootstrapFailureMatchesChild`, `sameProcessStartToken`,
   `validBootstrapNonce`) moved into `lock.mjs`, beside the single
   `processStartToken`/`pidAlive` implementation they had been duplicating.
2. **`processStartToken` has a real macOS implementation.** It returned
   `null` on anything but Linux, so the pid-reuse half of lock takeover had
   never been exercised on the owner's own machine. It now derives a stable
   per-pid fingerprint from the process start time on darwin, keeps the Linux
   `/proc/<pid>/stat` path byte-for-byte, and still returns `null` elsewhere
   as a documented, tested fallback. `lock.test.mjs` covers token stability
   and mismatch detection.
3. **DeepSeek's hard balance stop is normalized.** A 402 "Insufficient
   Balance" matched neither the quota pattern nor the auth pattern, so it
   fell into the generic `provider_unavailable` bucket — indistinguishable
   from a missing CLI. It now classifies as `{available: false,
   exhaustedUntil: null, reason: "insufficient_balance"}`, distinct from
   `quota_exhausted` (which carries a reset) and from a broken CLI. A second
   node added the fixture test the previous retrospective asked for: an
   Anthropic session-limit-with-reset response classifies as exhausted **with
   a non-null `exhaustedUntil`**, pinning the soft-vs-hard distinction rather
   than each case in isolation.

Full suite after integration: 498 tests, 496 pass, 0 fail, 2 skipped — six
new tests, no regressions.

## The field defect this campaign exposed

**A packet must never ask a worker to run the full test suite.** Run 1 lost
~49 minutes of wall clock and USD 4.38 across two nodes, and both failures
trace to one authoring mistake in the contract, not to worker quality:

- Every packet's instructions said to run `npm run check`, `npm run
  typecheck` **and the full suite** in the foreground, and each packet also
  declared `npm test` as its `verification` entry with `timeoutSec: 600`.
- `runner.test.mjs` alone measures **644.8 s** uncontended (165/165 pass —
  not a hang, just a suite full of real timers, backoffs and stall clocks).
  It has grown past the schema's hard 600 s per-verification-entry ceiling,
  so the controller's own verification could never pass.
- Worse, one worker resolved the impossible instruction by starting `npm
  test` **in the background** against an explicit prohibition, polling it
  with an `until … sleep 10` loop, and — when its turn ended — returning the
  prose "Waiting for the background test run to complete before proceeding
  further." instead of the required JSON. That is the exact
  `protocol_failure` shape recorded as field defect #8 on 2026-09-08,
  recurring because the packet made compliance impossible.
- Both attempts' actual diffs were **correct and complete** on inspection
  (`d3e9324`, `a0be509`). Only the gate was broken.

Run 2 fixed it by giving each node the one fast file it actually touches
(`lock.test.mjs` ≈ 7 s, `drivers.test.mjs` ≈ 2 s) as its verification, moving
the full-suite regression check to the orchestrator out of band, and
splitting the exhaustion node in two so a worker running out of turns cannot
produce one half-finished combined result. All four nodes then passed on
their first attempt, USD 2.48 total.

The rule is now in the skill itself rather than in one session's memory:
`SKILL.md`'s "Foreground children" rule and `references/contract.md`'s
verification paragraph both state it (`803ce27`).

## Problems this retrospective leaves open

1. **The test suite cannot gate itself.** `runner.test.mjs` at 644.8 s is
   past the 600 s ceiling *by itself*, and the whole suite takes ~11 min.
   No contract can mechanically prove "the full suite is green" through the
   runner's own verification; every campaign has to trust an out-of-band
   orchestrator run. The suite is slow because it waits on real time —
   stall timeouts, heartbeat intervals, retry backoffs — rather than on an
   injectable clock. This is the highest-value fix available: it is the
   direct cause of this campaign's only real loss.
2. **Production `.mjs` lines: 25,257 against a ≤10,000 target.** Remeasured
   at close (the 2026-09-08 retrospective left this indicator unmeasured).
   `node.mjs` alone is 3,923 lines. The lean campaign's split moved code
   between files without reducing the total; this campaign's deletions took
   ~800 lines out. The target is still roughly 15,000 lines away and needs a
   deliberate diet, not incidental cleanup.
3. **`runner.mjs`'s usage string advertises a command that no longer
   exists.** It prints `contract <prune|validate> ...` while
   `contract-cli.mjs` implements only `validate`; `runner.test.mjs` even
   asserts "contract prune is gone". A one-line stale string, but it is the
   CLI's own self-description.
