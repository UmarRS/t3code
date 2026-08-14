# Scope a thread to a folder

A project rooted at a large repository often holds several unrelated areas — a backend, a frontend,
a mobile app. An agent working on the checkout button has no reason to read the mobile app, and
every folder it wanders into costs context.

Use the folder control in the composer, next to the workspace and branch controls, to pick the
folder a thread works in.

## Choose the folder the agent runs in

1. Select the folder control in the composer.
2. Search for a folder and select it.

The agent now starts in that folder. Its searches, its relative paths, and the agent instruction
files it reads all narrow with it: a thread scoped to `apps/web` reads the instruction file at the
repository root and the one in `apps/web`, and never the ones belonging to other areas.

Select **Whole project** to run at the project root again.

## Link the folders it also needs

Some work spans areas. Wiring a checkout button to its API needs the frontend and a look at the
backend that serves it.

In the same menu, select **Link** on any other folder. Linked folders stay readable and editable
even though the agent runs elsewhere. Link only what the thread needs — the point of scoping is
what you leave out.

You can link a folder mid-thread. The agent's session restarts with the new folder available and
keeps the conversation so far.

## Read scope at a glance

A scoped thread shows a colored chip in the sidebar with its folder name, plus `+1`, `+2`, and so
on for linked folders. Hover the chip for the full list.

To recolor a folder, open the folder control, select the folder the thread runs in, and choose a
color from the swatches beside it. The color applies wherever that folder name appears, so an area
reads the same across every project that has one.

## What scope does not change

Scope narrows the agent, not your history. Worktrees, checkpoints, and the diff panel keep covering
the whole repository, so reverting a turn and reviewing changes work the same on a scoped thread as
on any other. If the agent needs to run a command from the repository root — a workspace-wide test
run, for example — it can still do so.
