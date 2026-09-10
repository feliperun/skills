fix(intent-factory): restore the TypeScript gate after the resilience work

The node --test suite never ran tsc, so the meter, deadline, repair
contract, and capsule changes landed with 57 type errors across eight
files. Add the missing casts and null guards without behavior changes,
and cover the live-preflight notify stripping and the supervise
stale-lease race that lost to a concurrently healthy controller.
