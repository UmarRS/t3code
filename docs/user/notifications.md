# Notifications and the dock badge

Agents work for minutes at a time, so Atlas tells you when one needs you instead of expecting you
to watch the window. The desktop app carries a dock badge and posts a macOS notification the moment
a thread starts waiting.

The web client keeps only its in-app indicators — the sidebar row status and the question icon in
the top bar.

## What counts as waiting

Three things, in the order Atlas prefers them when a thread qualifies for more than one:

1. **Approval needed** — the agent is asking to run something you have not permitted yet.
2. **Agent has a question** — the run has stopped on an unanswered question.
3. **Turn complete** — the agent finished and you have not opened the thread since.

A thread that is still working is never counted. Neither is a completed thread you have already
read: the badge is the same unread model as the sidebar's **Completed** pill, so opening a thread
clears it.

The badge is the standing total across every connected environment. Clicking a notification brings
Atlas forward and opens the thread it came from.

## When Atlas stays quiet

- **The thread is already on screen.** If the window has focus and you are looking at that thread,
  it is counted in the badge but not announced.
- **Several threads land at once.** Past three simultaneous transitions you get one rollup banner
  rather than a stack of them — an autonomous run finishing a batch of issues should not bury the
  notification center.
- **An environment reconnects.** Refilling threads after a dropped connection is not news, so the
  badge updates without announcing work you already knew about.
- **macOS is not showing notifications.** Do Not Disturb or a denied permission suppresses the
  banner; the dock badge still updates. Grant permission under System Settings → Notifications →
  Atlas.
