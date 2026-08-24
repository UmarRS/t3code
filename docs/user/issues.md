# Plan work with issues

A project's issues are the work you have not started yet. Each one holds a title, a markdown
description, a priority, and the other issues it waits on. Starting an issue opens a thread in its
own worktree with the first turn already written from the issue text, so planning and doing stay
one step apart instead of one copy-paste apart.

Open **Issues** in the sidebar for an overview of every project board. It has two views, and the one
you pick is remembered.

**Projects** is a row per project: how many issues sit in each column, which machine the project is
on, how much of its work is finished, and what its agent is doing right now. Each row ends with the
three ways in — **Review** when there is a verdict to read, the autonomous run switch, and
**Board**. Select the project's icon to give it a color, its star to keep it at the top of this
overview and the sidebar, any count to open that board, or search by name, environment, or workspace
path.

**Overall board** pools every project's issues into one board, so you can see what is moving without
opening each project in turn. Cards carry the project they belong to, the branch and pull request
the work is on, and — once an issue has started — what its thread is doing right now: working,
awaiting input, rate limited. Select a card to jump into that thread, or its project chip to open
the board that owns it. Search filters by issue title and project name. Archived work is left out;
this view is about what is going on now.

The command palette can open either the overview or the current project's board. A full board has
five columns: Backlog, In Progress, In Review, Done, and Canceled. Done and Canceled are dimmed —
finished work is history, not a queue.

## Create an issue

Select **New issue**. Give it a title, and a description if the work needs more than a line. The
description is markdown, and it is what the agent reads when the work starts, so acceptance
criteria and "do not break this" notes belong there.

Priority is optional. When it is set, the board sorts a column by priority first and by age second,
so the top card in Backlog is always the next thing to pick up.

**Worker model** is optional too. Choose a configured provider and model when this story needs a
particular agent; otherwise it inherits the project's default. You can change the choice at any
time from the issue editor, and both manual starts and autonomous mode honor it.

Select any card to edit it again. The card menu moves an issue to another column, opens its thread,
and deletes it.

## Say what work waits on other work

An issue can depend on other issues — on its own board, and on the boards of the projects it is
linked to. In the issue editor, use **Depends on** to pick them; anything from another board is
listed with that board's name. The picker only offers issues that keep the graph acyclic, so you
cannot build a set of issues that all wait on each other.

An issue with an unfinished dependency shows a **Blocked** badge; hover it to see what it is waiting
on, and which board that work is tracked on. Only **Done** clears a dependency — canceling a blocker
does not unblock the work that needed it. If a blocker turns out to be unnecessary, either mark it
done or delete it; deleting removes the dependency from everything that pointed at it, on every
board.

## Start work

Cards in Backlog carry a **Start** button. Starting an issue:

1. Creates a git worktree for the project on a branch of its own.
2. Opens a thread there and runs the project's setup script.
3. Sends the first turn: the issue title, its description, and the titles of the work it depended
   on, so the agent knows what it is building on.
4. Moves the issue to In Progress and links it to the thread.

You land in the new thread when it is ready. Worktree creation is retried a few times over a few
seconds first, so a passing git hiccup does not cost you a start. If the worktree still cannot be
cut, or the first turn cannot be set up, the issue returns to where it was and can be started
again.

If an agent asks a question, the issue card shows **Awaiting answer** and the global question icon
lights up. Open the linked thread to answer it; the run resumes from there.

Use **Stop issue** from a linked issue's menu to interrupt its current turn, stop the provider
session, unlink it, and move it to Canceled. The old thread and worktree stay available for
inspection. Move the issue back to Backlog when you want to start it again; the next start opens a
clean thread and worktree.

**Start** is unavailable while an issue is blocked, and the button explains which issues are in the
way. It is also unavailable once an issue already has a thread — an issue does one piece of work at
a time.

## Have an agent write the stories

Select **Generate stories** to open a new Claude Fable 5 planning thread with a planning prompt
already in the composer.
Replace the placeholder line with the feature you want broken down, then send it.

The same action is available in any project chat composer. It keeps that chat's current model and
inserts the editable planning prompt; if you already typed a feature description, Atlas keeps it
and adds the story instructions underneath. Every linked project is available to that planning
turn, so you can ask for a feature spanning the frontend and backend without first opening either
board.

The agent thinks through the work and ends its answer with a list of stories, each with a title, a
description, a priority, a worker model, and the stories it depends on. When the feature spans
repositories, a story can name a linked project and is created on that project's board — and it can
depend on a story from another board, so a frontend story that genuinely needs the backend change
first waits for it. A valid plan has an **Add to board** button beneath it. Ask for changes in the
same chat until the plan is right, then select that button to create the issues. The action is safe
to retry and will not duplicate stories from the same response. Nothing is created until you select
it, and malformed output does not offer the button.

Once the stories are on their boards, **Autonomous mode** appears next to the button and starts a
run on every board the plan touched, after one confirmation. Each board runs its own backlog; the
dependencies you can now draw between them are what keeps the boards in step.

Review what arrives before starting anything. The agent proposes the plan; you own it.

## Reviewing and finishing

Open a pull request from a thread the usual way — the source control control in the composer — and
the issue behind that thread moves itself to **In Review** and remembers the pull request. An issue
that is already Done or Canceled stays where it is; a finished issue is never dragged backwards.

Merging is not detected for you. When the work is really finished, move the issue to **Done** from
its card menu. **Canceled** is where work goes when it is not going to happen — there is no separate
archive.

## Autonomous mode

Autonomous mode works the whole backlog for you. Select **Autonomous mode** on a project card in the
all-projects overview or in that board's header, confirm, and Atlas takes over only that project's
issues until there is nothing left it can advance. Other projects can run independently at the
same time.

While a run is on, the header shows what it is doing — how much is in progress, in review, done, and
waiting for you — and the Issues entry in the sidebar carries a dot. Cards the run is driving are
marked **Auto**, so it is always clear what you are looking at.

### What a run actually does

- **It starts every unblocked issue at once**, each in its own worktree and its own thread, and
  tells each agent which siblings are working alongside it so they stay out of each other's way.
- **It opens the pull request** when a worker finishes, and moves that issue to In Review. You do
  not have to open pull requests for autonomous work.
- **It recovers work that already shipped.** Before opening a pull request, Atlas refreshes the
  remote base and looks for an existing pull request from the issue branch. A merged one becomes
  the delivery record and completes the issue instead of producing an empty-PR error.
- **It reviews and merges one issue at a time.** A reviewer reads the change, fixes what it finds,
  rebases onto the latest main, and merges. Because merges are serial, each review sees the work
  that landed before it.
- **It waits on the other boards in the plan.** A story whose dependency is tracked on another
  board stays queued until that story is merged, and the run stays on while it waits rather than
  reporting itself finished. When the blocker lands, the story starts on its own.
- **It parks anything it cannot finish** and keeps going with the rest.
- **It turns itself off** when nothing is left to start and nothing is still moving.

After an issue is recorded as merged, Atlas removes its checkout in the background as soon as it
can do so safely. The branch and thread history remain. A dirty, unpushed, locked, pinned,
still-busy, or cross-project worktree stays in place; the periodic cleanup checks settled
worktrees every six hours and normally removes eligible checkouts after 24 hours. Advanced users
can override `worktreeSweepInterval` and `worktreeSweepMinAge` in the server settings file.

The threads a run opens have their permissions auto-approved: nobody is watching to answer a
prompt, so those agents edit files and run commands without asking. That is what you are agreeing to
when you turn the run on. Reviews need a Claude provider; without one, work is left for you instead
of merged, and the confirmation says so before you start.

### Issues that need you

When a worker fails, a pull request cannot be opened, or a review finishes without a confirmed
merge, the issue is flagged and set aside. So is a story waiting on work nothing is going to
finish — a blocker that is itself flagged, or one sitting on a board with no run — and the reason
names the story and the board it is stuck behind. That is the run's dead end: it flags what it
cannot reach and finishes, rather than staying on forever. Flagged issues keep whatever status they had reached —
they are not moved backwards, so you can see how far the work got — and they carry a **Needs you**
badge on the board with the reason. If a later reviewer turn reports a valid merged verdict, Atlas
replaces that provisional flag and completes the issue.

The **Review** tab collects them, newest first, alongside everything the run merged. Each entry links
to its pull request, its worker thread, and its reviewer thread, and expands to show the reviewer's
notes.

Two ways out, from the card menu or the Review tab:

- **Clear flag** removes the flag and leaves everything else alone. Use it when you have taken over
  the thread yourself.
- **Retry pull request** appears when the worker already finished and pushed its branch. It keeps
  the completed worker thread and commit, retries the pull request step, and starts review as soon
  as the pull request is linked — even if autonomous mode is paused.
- **Clear & retry** also unlinks the thread and returns the issue to the backlog, so it is fresh
  work again. A live run picks it up on its next pass; if the run already finished, start it again.

### Runs on a schedule

A project can start its own runs. In **Settings → Projects**, the **Scheduled runs** section takes a
list of times: add a time, pick the days it applies to (no days selected means every day), and leave
the switch on. At each of those times Atlas starts a run on that project exactly as the header
button does.

Times are read on the clock of the machine running the server, not the device you are looking at.
Three rules keep a schedule from surprising you:

- **A missed time is skipped, never caught up.** If the server was off or asleep at 09:00, opening it
  at 14:00 does not start the 09:00 run; the schedule waits for its next time.
- **A live run is left alone.** If yesterday's run is still working when today's time comes round,
  nothing happens — the schedule never restarts work that is already going.
- **A scheduled run is an ordinary run.** It starts, reviews, merges and turns itself off exactly as
  one you started by hand, and **Stop** ends it the same way.

The switch on each entry keeps a time you have configured without firing it, which is easier than
deleting and re-adding one. Schedules belong to the project, so a grouped project applies them to
every checkout in the group.

### Stopping

**Stop** stops the run from starting anything new and from running any more reviews. It does not
interrupt threads that are already working — killing an agent mid-edit loses its work — so those
finish on their own, and the header tells you how many are still going. End them individually from
their threads if you really want them stopped.

Starting the run again picks up wherever the backlog is now.
