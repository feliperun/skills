# POC results — multi-model loop harness

Runs: `poc-001` + DeepSeek follow-up `poc-002-flash` · 2026-08-10

## Verdict

Build the harness. Five of six hypotheses survived. The one that did not
(H6, as specified) failed for a reason that does not threaten the design.

## Cost

| Node | Runtime | Output tokens | Cost |
| --- | --- | ---: | ---: |
| A / emitter | claude / opus-5 | 52,105 | $3.72 |
| B / dispatcher | codex / gpt-5.6-luna : xhigh | 27,872 | ~$0.06 |
| C / parser | codex / gpt-5.6-luna : low | 13,479 | ~$0.03 |
| D / gate | codex / gpt-5.6-sol : xhigh | 24,127 | not reported by Codex |
| C2 / parser rerun | codex / deepseek-v4-flash | 42,096 | not reported by Codex |

Estimate in the plan was under $2. Real spend was ~$3.81 plus the gate.
**The estimate was wrong by roughly 2x**, entirely because of node A.

Opus through `claude -p` cost **60x** the Luna node for comparable output
volume, driven by 3.1M cache-read tokens across 44 turns. The economics only
work when the node is large. Short, frequent Opus calls through `-p` are the
worst case: each process pays cache creation from scratch.

## Hypotheses

| | Hypothesis | Result |
| --- | --- | --- |
| H1 | Uniform dispatch | **Survived** |
| H2 | Declarative routing | **Survived** |
| H3 | Cross-model gate | **Survived, with a caveat** |
| H4 | Stall detection | **Survived** |
| H5 | Orchestrator context stays flat | **Survived** |
| H6 | Session as control plane | **Not measured cleanly** |

### H1 — uniform dispatch

Verified by calling node B's adapter without knowing the provider:
`dispatch` returned in 83 ms, `poll` reported `running`, `collect` returned a
canonical envelope. No provider-specific branching was needed by the caller.

Codex supplies no wall-clock duration, no USD cost, and no cache-read count.
These are explicit `null` in the envelope, and the adapter computes its own
`durationMs` for both. Explicit nulls beat a fake unified number.

### H2 — declarative routing

A runtime table maps node metadata onto driver, provider, model, and reasoning.
Three destinations resolved with no imperative routing logic. Provider-specific
command construction stays inside the adapter; routing remains a lookup.

### H3 — cross-model gate

GPT-5.6 Sol reviewed all three nodes and **failed all three**. Every finding was
independently verified as real:

- **C accepts malformed YAML.** `a: value: more` parses as `{a:"value: more"}`;
  a reference YAML parser rejects it. Confirmed against Ruby's YAML.
- **C rejects valid YAML.** `a: hello}` throws `flow maps are not supported`;
  the reference parser returns `{"a":"hello}"}`. Confirmed.
- **A's push policy has a hole.** `shouldPush("running","pending")` returns
  silence. A node regressing out of `running` raises no alarm. Confirmed.
- **A truncates by character count, not display width.** CJK node names produce
  122 display columns against a 100-column budget. Technically correct.
- **B has a terminal-state race.** A forced interleaving left node JSON at
  `running` while the terminal lock already existed, so `collect` returned null
  permanently. Not independently reproduced here.

Zero hallucinated findings. The gate also caught what the operator got wrong:
a manual width check using `awk` measured **bytes** and reported a false
violation at 108 columns; the gate measured display width correctly and
confirmed the happy path at exactly 100.

**Caveat: severity calibration runs hot.** All five findings were graded
`major`. The CJK case and the `running → pending` hole are real but unlikely to
matter in practice. In an automatic `major → fail → retry` loop this would
cause needless rework. Ship the gate with severity thresholds under operator
control, and treat `major` as advisory until calibrated.

### H4 — stall detection

Node B's adapter watches **mtime on both stdout and stderr** rather than output
growth, which works for both wire formats. A real dispatch with a 1 ms silence
window returned `stalled`, distinct from `running` and `failed`.

This corrected a flaw in the operator's own design, found mid-run:
`claude -p --output-format json` writes **nothing** until it finishes. Its log
sits at 0 bytes for the whole run, so a growth-based watchdog cannot tell a
healthy 11-minute Opus call from a hang. The naive watcher used for this run
never left `pending` for node A and would have stayed **silent through a real
hang** — the exact "silence looks like success" failure mode.

Use `--output-format stream-json` for Claude workers, or watch mtime.

### H5 — orchestrator context

Survived. Worker logs never entered the session: envelopes carry a `logPath`
and the raw output stays on disk. The largest single read was a deliberate
quality inspection, not part of the loop.

### H6 — session as control plane

**Not measured cleanly.** The mechanism worked: the Monitor emitted 8 lines
across the epic and the session stayed responsive throughout. But the session
also read `DECISIONS.md`, `NOTES.md`, and rendered fixtures in full, because a
POC under evaluation is not a POC in steady state. The <5k target was blown by
inspection, not by orchestration.

The mechanism is sound; the measurement needs a second run where the operator
consumes only verdicts.

## Design changes this forced

1. **Claude workers must stream.** `--output-format stream-json`, or watch mtime.
2. **Push on regression out of `running`,** not only on terminal states.
3. **Truncate by display width,** not character count.
4. **The terminal-state claim needs a real lock,** not a marker file with a
   read-then-write gap.
5. **Route to Opus by node size, not only node type.** A `frontend` label is not
   enough; a small frontend node should not pay $3.72.
6. **Build Codex provider settings as `-c` overrides.** Do not trust profiles or
   config files to select a custom provider, and verify the resulting stream.

## DeepSeek — validated, with a caveat

DeepSeek V4-Flash **works** through Codex. Proven by a negative control: without
the key the run ends in `turn.failed / Missing environment variable`, and with
it the model answers, reporting 61,619 input tokens at zero cache — a usage
signature completely unlike the OpenAI path (19k input / 11k cached). The
model-discovery call also returned DeepSeek's own catalog
(`deepseek-v4-flash`, `deepseek-v4-pro`).

Three findings the harness must account for:

1. **`[model_providers.X]` in `config.toml` is not read** by codex-cli 0.147.0.
   Neither the base config nor a profile file works. The provider must be
   supplied as `-c` overrides on the command line. This is the single reason
   the first `flash` attempt silently ran on OpenAI.
2. **`--profile <name>` fails silently for an unknown name** — no error, no
   warning, it just uses the base config. Any routing bug that mistypes a
   profile is invisible. The adapter must verify the resolved runtime rather
   than trust the flag.
3. **Model discovery is incompatible.** DeepSeek returns `{"object":"list",
   "data":[...]}` where Codex expects `{"models":[...]}`, so Codex logs a
   refresh error and falls back to default model metadata. Non-fatal, but it
   warns that performance may degrade.

Consequence: the provider adapter builds the `-c` flags for the dispatch
command. It does not rely on profiles or on config files for provider
selection.

The existing key is now exported from `~/.zshrc`. Its value was never copied
into the repository or run artifacts.

### Flash rerun

The same parser task was rerun as `poc-002-flash` after the main POC. Evidence
that it used DeepSeek rather than an OpenAI fallback:

- Removing `DEEPSEEK_API_KEY` produced `turn.failed` with a missing-variable error.
- Model discovery returned `deepseek-v4-flash` and `deepseek-v4-pro`.
- The completed turn reported 1,471,349 input tokens, 1,457,024 cached input
  tokens, and 42,096 output tokens.

The rerun produced 18 passing tests and fixed both parser failures discovered by
the Sol gate: malformed `a: value: more` is rejected, while valid `a: hello}` is
accepted. This closes the DeepSeek validation gap; model discovery remains noisy
because DeepSeek returns `data` where this Codex version expects `models`.

## What node C proved anyway

A correct frontmatter parser with 11 passing tests, produced at `low` reasoning
effort for ~$0.03. Mechanical work with a tight spec does not need an expensive
model — which is the economic premise the whole harness rests on.
