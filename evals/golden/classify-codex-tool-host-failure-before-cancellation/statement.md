fix(intent-factory): classify codex tool-host failure before cancellation

normalizeCodexResult now classifies a code-mode-host-disabled item error
before the termination signal and before any later turn.completed or
agent_message verdict, so a harness that dies after the host error is a
provider failure (retryable) instead of a cancellation, and a judge
verdict grounded in no inspection is rejected. boundedMessage cuts
before the character starting at the 512-byte ceiling instead of
backing up onto a dangling lead byte, so truncated multibyte
diagnostics re-encode to <= 512 UTF-8 bytes with no U+FFFD.

The preamble comment now records all four measured host outcomes
(gpt-5.6-sol 35130 fabricated vs 35199 correct tool-backed;
deepseek-v4-flash 25795 vs 25783, both correct) and regression tests
pin the precedence, the byte bound, and the measurements.
