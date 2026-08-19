# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

Each chat also shows its token count at the bottom right of the composer. The visible count is the
total processed by that chat when the provider reports it; otherwise it shows the current context
window usage. Open the counter for the context-window percentage, capacity, and compaction details.

Atlas cannot set or predict subscription-plan quotas. Those limits remain controlled by Codex or
Claude Code and may vary by plan and demand. When a provider reports that its limit has been reached,
Atlas pauses the thread and resumes it at the reported reset time; see **When a model runs out of
capacity** for the recovery behavior.
