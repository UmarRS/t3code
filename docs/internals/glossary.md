# Glossary

> For maintainers. Using Atlas? See [docs/user](../user/).

This is a living glossary for Atlas. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Issues](#issues)
- [Autonomous mode](#autonomous-mode)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

#### Scope

The narrowing of a thread to part of its workspace, so an agent in a large repository does not carry areas it has no business reading. A thread's `focusPath` is the workspace-relative folder the provider process runs in, and `linkedPaths` are the neighbors it may still read and edit. Both are defined in `packages/contracts/src/threadScope.ts` and resolved to absolute paths by `apps/server/src/orchestration/threadScopeResolution.ts`.

Scope moves the agent's cwd only. `resolveThreadWorkspaceCwd` stays at the workspace root, so worktrees, checkpoints, and diffs keep covering the whole repository — restore and review must not narrow with the agent. Changing either half restarts the provider session on its resume cursor, since both adapters fix their directory grants at session start.

#### Project link

A link from one project to an absolute folder elsewhere on the same environment — the backend a frontend calls, the frontends a backend serves. Distinct from scope, which narrows a thread _inside_ one workspace: project links point outward, at other repositories, and belong to the project rather than any thread. Shapes live in `packages/contracts/src/projectLink.ts`; a link is `{ id, path, description, createdAt }` and the description is required because it is what an agent reads to learn what the folder is.

The target folder need not be a registered project. When it is, the link is bidirectional — but only one edge is stored, on the project that created it. The other project's mirror is derived on read by `deriveProjectLinkViews` in `packages/shared/src/projectLinks.ts`, which also resolves each link path against the known project roots (`targetProjectId`, null for a context-only folder). One stored edge means removing the link from either side removes it for both: `project.link.remove` resolves a mirror back to its owner before emitting `project.link-removed`. The server exposes the resolved view as `ProjectionSnapshotQuery.getProjectLinksById`.

### Issues

#### Issue

A unit of planned work inside a project, event-sourced as its own aggregate
alongside `project` and `thread`. An issue has a title, a markdown description,
a status, an optional priority, a list of issues it depends on, and — once
started — the thread doing the work. Shapes live in
`packages/contracts/src/issues.ts`; the aggregate is decided in [decider.ts][8]
and projected by [projector.ts][4] and [ProjectionPipeline.ts][11].

Issue summaries ride the shell snapshot next to projects and threads. The
markdown description is the one unbounded field and is deliberately left out of
list payloads; `orchestration.getIssue` fetches it for a single issue, the same
summary/detail split threads use for their messages.

#### Issue status

One of `backlog`, `in_progress`, `in_review`, `done`, `canceled`. It is a label
the user owns, not a ratchet: every transition is legal in both directions, and
`done` going back to `backlog` is a normal correction. Only two moves are
automatic — `in_progress` when an issue is started, and `in_review` when a pull
request is linked to the started thread. Merge detection is out of scope; `done`
is always manual.

#### Dependency

An edge from one issue to another, on its own board or on another project's:
a plan that spans repositories orders itself across boards. Dependencies are
validated in [commandInvariants.ts][9] over the whole environment: the target
must be a live issue, an issue may not depend on itself, and the edge set must
leave the graph acyclic (`findIssueDependencyCycle` in the contracts). Which
boards a _client_ offers as candidates is narrower — the project's own and the
ones it is linked to — and deliberately not re-decided server-side, so removing
a link never strands an existing edge. They are also the **start gate**:
`issue.start` is rejected while any dependency is not `done`, so an agent never
gets a worktree for work whose groundwork is missing.

#### Starting an issue

`issue.start` opens a thread for the issue's project in an isolated worktree,
seeds its first turn with a prompt built from the issue title, description, and
the titles of its finished dependencies, links thread to issue, and moves the
issue to `in_progress`. The composite lives in one service,
`apps/server/src/orchestration/Layers/IssueStartCoordinator.ts`, shared by the
client's `issue.start` dispatch in [ws.ts][ws] and by autonomous mode; if the
bootstrap fails after the issue is already marked in progress,
`issue.start-failed` rewinds it.

#### Story decomposition

Asking an agent to break a feature into stories. The agent ends its final
message with one fenced ` ```t3-issues ` block of JSON, and when the turn
completes [ProviderRuntimeIngestion.ts][5] parses it and creates the issues on
the thread's project. The parser is pure and lives in
`apps/server/src/orchestration/issueDecomposition.ts`; a block it cannot read
becomes an error activity on the thread rather than a failed turn. The
instruction that tells an agent how to emit the block is exported from the
contracts as `ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS` so the format lives in
exactly one place.

A block may also revise the board it was planned against: an entry's `updates`
names an existing issue to rewrite and `supersedes` names ones to cancel. Only
work nobody has started qualifies (`isIssueOpenToRevision`), and an entry naming
anything else makes the whole block invalid, exactly as a dependency cycle does.
The web import derives what applying the block would do —
`planIssueDecompositionImport` in
`apps/web/src/components/issues/issueDecompositionImport.logic.ts` — and applying
stays a user action, because a revised plan must never silently rewrite a board.

### Autonomous mode

#### Autonomous mode

A per-project run in which the server works the backlog with no human in the
loop: it starts every startable issue, opens each one's pull request when its
worker finishes, and reviews and merges them one at a time. Turned on with
`project.autonomous.enable` and off with `project.autonomous.disable`; a live
run is a non-null `autonomousStartedAt` on the project. Disabling stops future
starts and reviews but deliberately leaves in-flight threads alone — killing an
agent mid-edit is worse than letting it finish. The loop lives in
`apps/server/src/orchestration/Layers/AutonomousRunReactor.ts`.

Everything it spawns is forced to `runtimeMode: "full-access"` and
`interactionMode: "default"`: a run with nobody watching cannot answer an
approval prompt, so an interactive mode would simply hang.

#### Scheduled run

A per-project list of wall-clock times at which the server enables autonomous
mode by itself: `{ time: "HH:MM", daysOfWeek, enabled }` entries on the project
(`autonomousSchedule`), set with `project.autonomous.schedule.set` and edited in
Settings → Projects. `AutonomousScheduleReactor` wakes on every minute boundary,
reads the server's own timezone, and dispatches the same
`project.autonomous.enable` the UI sends. It only ever looks at the minute it
woke into — a slot the server slept through is skipped rather than caught up —
it skips a project whose run is already live, and the enable it dispatches
carries a command id derived from project, date and entry, so the persisted
command receipt makes a repeat inside the same minute a no-op. Matching lives in
`packages/contracts/src/autonomousSchedule.ts` so the ticker and the settings UI
cannot disagree.

#### Startable

An issue autonomous mode may pick up right now: status `backlog`, not flagged
needs-attention, no thread yet, and every dependency `done` — including
dependencies on issues another project's board tracks, which is why the loop
reads `listIssues` (the environment) rather than one board. Defined by
`startableAutonomousIssues` in `packages/contracts/src/issues.ts`, scoped to the
board being evaluated, so the server and any UI progress indicator agree. Everything the loop decides is derived from
projected state rather than memory, which is what makes it restart-safe: an
issue that already has a thread is not startable, so a replayed event cannot
double-start it.

#### Run complete

Nothing startable, nothing in `in_progress` or `in_review`, and nothing
_waiting_ — the three answers `evaluateAutonomousRun` returns. The server then
auto-disables the run with reason `completed`, as opposed to `disabled` for a
user stop, so a client can tell a finished run from a stopped one. Because
flagged issues count as none of the three, a backlog of nothing but parked work
terminates instead of spinning.

**Waiting** is what cross-board dependencies added: a board whose remaining work
is blocked by a story another board is still working has nothing to do this tick
but is not finished, and turning its run off would strand that work the moment
the blocker landed. It stays live, and the event fan-out in
`AutonomousRunReactor` re-evaluates it when an issue it depends on moves —
`projectsForEvent` returns the moved issue's board plus every board holding a
dependent.

**Stalled** is the opposite: the blocker is flagged, canceled, or sitting in a
backlog no run is working, so waiting cannot release it. When a run would
otherwise complete, each stalled issue is flagged needs-attention with the
blocker and its board named, and then the run finishes. A board never waits
forever on work nothing is advancing.

#### Merge queue

The serialized half of a run. Starts fan out — independent issues have no reason
to wait for each other — but reviews funnel through one `DrainableWorker`, so
each reviewer rebases onto a base branch that already contains the siblings that
landed before it. The queue holds on a reviewer until its verdict is recorded.

#### Reviewer

A thread the merge queue opens inside the worker's own worktree, on a model
sized to the work: a cheap classifier pass (`ReviewComplexityClassifier`) tiers
the review as trivial (Haiku-class), standard (Sonnet-class), or complex (the
strongest Opus the Claude adapter exposes). A missing model class falls upward
to the next stronger one, never downward, and any classification failure is the
complex tier (`reviewerModelSelection.ts` reads the adapter's catalog order
rather than hard-coding slugs). Its brief is
fix-then-merge: read the diff, run the touched tests, fix what it finds, rebase,
and merge the pull request. It closes with a fenced ` ```t3-review ` block
carrying `{ verdict, notes }`, parsed by
`apps/server/src/orchestration/issueReview.ts` at the same turn-completion seam
story decomposition uses. A missing or malformed block _becomes_ a
`needs_attention` verdict — a reviewer that cannot say whether it merged has not
established that the work is safe, and silence must never stall the queue.

#### Needs attention

A flag on an issue, not a sixth status: the issue keeps whatever status it
reached and is simply excluded from autonomous work. Raised by the server when a
worker session errors, a pull request cannot be opened, or a reviewer refuses to
merge. Cleared by the user with `issue.attention.clear`, which makes a backlog
issue startable again — the way out of every automatic park.

#### Review notes

The reviewer's markdown record of what it checked, fixed, and decided, carried
on `issue.review-recorded` and stored on the issue. Like descriptions, notes are
unbounded and therefore ride the detail read (`orchestration.getIssue`) rather
than the shell snapshot; the summary carries only `reviewVerdict`,
`reviewerThreadId`, and `reviewedAt`.

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is `project`, `thread`, or `issue`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Five drivers ship built in: Codex, Claude, Cursor, Grok, and OpenCode. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[ws]: ../../apps/server/src/ws.ts
