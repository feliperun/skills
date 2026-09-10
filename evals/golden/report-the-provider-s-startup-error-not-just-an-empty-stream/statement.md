fix(intent-factory): report the provider's startup error, not just an empty stream

A codex custom provider declared without `name` dies at config load and emits
no events, which normalized to a bare "Codex emitted no turn.completed event"
— it reads as a provider outage and cost two preflight rounds before anyone
ran codex by hand to see "provider name must not be empty". The claude, codex
and agy normalizers now append the process's stderr when the stream ends with
no completion event. In the invocation path the stderr tail was already being
read into a variable nothing used.
