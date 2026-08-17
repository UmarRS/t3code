# When a model runs out of capacity

Subscription models stop accepting work when a usage window runs out — a five-hour session limit, a
weekly limit, spent credits. Atlas treats that as a pause, not a failure: the thread keeps its place
and picks the work back up on its own.

## Waiting it out

When the provider says when the limit lifts ("resets 12:10am"), the thread parks until then. You get
a banner on the thread:

```text
Paused until the model's limit resets. Resuming at 12:10 AM (in 2h 22m).   [Resume now] [Stop waiting]
```

At that time Atlas restarts the turn the limit cut off, on the same model and the same provider
session — so the agent continues with everything it had already read and done, rather than starting
the task over. In the sidebar the thread reads **Rate Limited** while it waits.

Two ways out before then:

- **Resume now** restarts the turn immediately. Useful if you topped up, switched accounts, or just
  want to find out whether the limit really is still in force.
- **Stop waiting** cancels the automatic restart and leaves the thread stopped. Send a new message
  whenever you want to pick it up yourself.

A parked thread survives quitting Atlas. If the limit lifted while your machine was asleep, the
thread resumes shortly after it wakes.

## Autonomous runs

Issues being worked by an autonomous run park the same way, and the run leaves them alone while they
wait — a rate-limited issue is not flagged as needing you, and it is not moved back to the backlog.
When the limit lifts, its worker picks the issue back up and the run carries on.

This is the difference from an ordinary failure: a worker that _errors_ parks its issue for you to
look at, while a worker that ran out of capacity just waits.

## Falling back to another model

Sometimes the provider gives no reset time — spent credits, an expired plan, a bare "too many
requests". There is nothing to wait for, so if the thread is on a Claude model and you have a Codex
provider configured, Atlas switches that thread to the matching Codex model and restarts the turn
there. The switch is recorded in the thread timeline.

That happens at most once per attempt. If the backup model fails too, the thread stops and the error
names both attempts, so you can see it was not one provider having a bad day.

With no Codex provider configured, the thread simply stops with the provider's error and waits for
you.
