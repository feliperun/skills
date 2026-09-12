fix(intent-factory): weight cached reads in the live token meter

The budget meter counted raw input tokens from the transcript, but the campaign ledger normalizes providers that report input with their cached portion included (Codex/DeepSeek meter ~99% cache). A worker that stayed far under the weighted 12M cap was killed at 14.2M raw, exhausting the run on a budget it had not spent.

liveUsage splits uncached and cached components like canonicalUsage; liveInputTokens applies the usagePolicy cacheReadWeight so live spend is comparable with persisted spend. enforceTokenBudget weights the persisted ledger the same way, and the kill/timeout backfill records the normalized components instead of a raw total.
