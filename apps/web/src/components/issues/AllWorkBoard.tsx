import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { issueNeedsAttention } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import {
  sidebarProjectPrefKey,
  useSidebarProjectPrefsStore,
  type ProjectAccent,
} from "~/sidebarProjectPrefsStore";
import { useProjects, useThreadShells } from "~/state/entities";
import { useAllEnvironmentIssues, type EnvironmentIssue } from "~/state/issues";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import type { Project } from "~/types";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  allWorkColumnsAreEmpty,
  allWorkIssueMatchesQuery,
  allWorkIssueReference,
  buildAllWorkColumns,
  ALL_WORK_COLUMN_INITIAL_COUNT,
  ALL_WORK_COLUMN_PAGE_COUNT,
} from "./AllWorkBoard.logic";
import { ISSUE_PRIORITY_LABEL, type IssueBoardColumn } from "./IssuesBoard.logic";
import { projectAccent } from "./IssuesOverviewPage.logic";
import {
  ISSUE_COLUMN_ACCENT_CLASS,
  PRIORITY_DOT_CLASS,
  PROJECT_ACCENT_CLASSES,
} from "./issueStyles";

/** An issue with everything its card paints resolved once, up front. */
interface AllWorkEntry extends EnvironmentIssue {
  readonly projectKey: string;
  /** Null once the project is gone; the card still reads as history. */
  readonly project: Project | null;
  /** The thread doing the work, when the issue has started. */
  readonly thread: EnvironmentThreadShell | null;
  readonly accent: ProjectAccent;
}

/**
 * Every project's pipeline in one board.
 *
 * The per-project boards stay where issues are edited, started and stopped;
 * this one answers "what is going on right now" across all of them, so a card
 * is a read with two ways out — into the thread doing the work, or onto the
 * board that owns the issue.
 */
export function AllWorkBoard({ query }: { readonly query: string }) {
  const allIssues = useAllEnvironmentIssues();
  const projects = useProjects();
  const threads = useThreadShells();
  const accentByProjectKey = useSidebarProjectPrefsStore((state) => state.accentByProjectKey);
  // Cards age in place on a board nobody is touching, so the elapsed labels
  // come off the shared minute clock rather than whatever the last render saw.
  const nowMinute = useNowMinute();
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const projectByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          sidebarProjectPrefKey({ environmentId: project.environmentId, projectId: project.id }),
          project,
        ]),
      ),
    [projects],
  );
  // Thread ids are only unique within an environment, and the board pools
  // every environment — so the index is keyed by both, and built once per
  // shell change rather than scanned per card.
  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );

  const entries = useMemo(() => {
    const resolved: AllWorkEntry[] = [];
    for (const issue of allIssues) {
      const projectKey = sidebarProjectPrefKey({
        environmentId: issue.environmentId,
        projectId: issue.projectId,
      });
      const project = projectByKey.get(projectKey) ?? null;
      const matches = allWorkIssueMatchesQuery(
        { title: issue.title, projectTitle: project?.title ?? null },
        query,
      );
      if (!matches) continue;
      resolved.push({
        ...issue,
        projectKey,
        project,
        thread:
          issue.threadId === null
            ? null
            : (threadByKey.get(`${issue.environmentId}:${issue.threadId}`) ?? null),
        accent: accentByProjectKey[projectKey] ?? projectAccent(projectKey),
      });
    }
    return resolved;
  }, [accentByProjectKey, allIssues, projectByKey, query, threadByKey]);

  const columns = useMemo(() => buildAllWorkColumns(entries), [entries]);
  const searching = query.trim().length > 0;

  if (allWorkColumnsAreEmpty(columns)) {
    return (
      <Empty className="min-h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">{searching ? <SearchIcon /> : <ListChecksIcon />}</EmptyMedia>
          <EmptyTitle>{searching ? "No matching work" : "Nothing on any board"}</EmptyTitle>
          <EmptyDescription>
            {searching
              ? "Try an issue title or a project name."
              : "Issues from every project land here as soon as they exist."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(5,minmax(250px,1fr))] items-start gap-3.5 px-5 py-5 pb-10 sm:px-8">
      {columns.map((column) => (
        <AllWorkColumn key={column.status} column={column} nowMs={nowMs} />
      ))}
    </div>
  );
}

const AllWorkColumn = memo(function AllWorkColumn(props: {
  readonly column: IssueBoardColumn<AllWorkEntry>;
  readonly nowMs: number;
}) {
  const { column } = props;
  // Every column here pools several boards, so any of them can run long. The
  // cap is uniform rather than reserved for the finished columns.
  const [visibleCount, setVisibleCount] = useState(ALL_WORK_COLUMN_INITIAL_COUNT);
  const visibleIssues = column.issues.slice(0, visibleCount);
  const hiddenCount = column.issues.length - visibleIssues.length;

  return (
    <section
      aria-label={column.label}
      className={cn("flex min-w-0 flex-col gap-2.5", column.muted && "opacity-80")}
    >
      <header className="flex items-center gap-2 px-0.5">
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", ISSUE_COLUMN_ACCENT_CLASS[column.accent])}
        />
        <span className="text-[12.5px] font-medium text-foreground">{column.label}</span>
        <span className="font-mono text-[11.5px] text-muted-foreground/70 tabular-nums">
          {column.issues.length}
        </span>
        {column.attentionCount > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="ml-auto flex items-center gap-1 rounded-full bg-warning-surface px-1.5 py-0.5 text-[10.5px] font-medium text-warning tabular-nums">
                  <TriangleAlertIcon aria-hidden="true" className="size-3" />
                  {column.attentionCount}
                </span>
              }
            />
            <TooltipPopup>
              {column.attentionCount === 1
                ? "1 issue needs you"
                : `${column.attentionCount} issues need you`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </header>
      <div className="flex min-h-24 flex-col gap-2 rounded-2xl border border-border/60 bg-muted/25 p-2">
        {column.issues.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground/60">Nothing here</p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {visibleIssues.map((entry) => (
                <li key={`${entry.environmentId}:${entry.id}`}>
                  <AllWorkCard entry={entry} nowMs={props.nowMs} />
                </li>
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + ALL_WORK_COLUMN_PAGE_COUNT)}
                className="flex h-8 cursor-pointer items-center justify-center rounded-[9px] border border-dashed border-border text-xs text-muted-foreground/70 outline-none hover:border-muted-foreground/40 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show {Math.min(hiddenCount, ALL_WORK_COLUMN_PAGE_COUNT)} more
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
});

function AllWorkCard({ entry, nowMs }: { readonly entry: AllWorkEntry; readonly nowMs: number }) {
  const navigate = useNavigate();
  const { project, thread } = entry;
  const needsAttention = issueNeedsAttention(entry);
  const statusPill = thread === null ? null : resolveThreadStatusPill({ thread });
  const reference = allWorkIssueReference({
    branch: thread?.branch,
    pullRequestUrl: entry.pullRequestUrl,
  });

  const openBoard = () =>
    void navigate({
      to: "/issues/$environmentId/$projectId",
      params: { environmentId: entry.environmentId, projectId: entry.projectId },
    });
  // The thread is what the user came for when there is one. Without it the
  // issue has not started, and its own board is the only place to act on it.
  const openIssue = () =>
    entry.threadId === null
      ? openBoard()
      : void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(entry.environmentId, entry.threadId)),
        });

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3 transition-colors",
        needsAttention ? "border-warning/40" : "border-border hover:border-muted-foreground/25",
      )}
    >
      <button
        type="button"
        title={
          entry.threadId === null
            ? `Open the ${project?.title ?? "issue's"} board`
            : "Open the thread doing this work"
        }
        className="cursor-pointer text-left text-[13px] leading-[1.35] tracking-[-0.008em] text-pretty text-foreground outline-none focus-visible:underline"
        onClick={openIssue}
      >
        <span className="line-clamp-3">{entry.title}</span>
      </button>

      {reference === null ? null : (
        <span className="truncate font-mono text-[11px] text-muted-foreground/60" title={reference}>
          {reference}
        </span>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          title={
            project === null
              ? "This project is no longer available"
              : `Open the ${project.title} board`
          }
          disabled={project === null}
          onClick={openBoard}
          className={cn(
            "inline-flex h-5 max-w-full items-center gap-1.5 rounded-md bg-muted px-1.5 text-[10.5px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
            project === null ? "opacity-70" : "cursor-pointer hover:text-foreground",
          )}
        >
          {/* The project's chosen colour, not its favicon: at chip size the dot
              is what tells two projects apart down a column of cards. */}
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              project === null
                ? "bg-muted-foreground/40"
                : PROJECT_ACCENT_CLASSES[entry.accent].bar,
            )}
          />
          <span className="truncate">{project?.title ?? "Unknown project"}</span>
        </button>

        {statusPill === null ? null : (
          <span
            className={cn("inline-flex items-center gap-1 text-[10.5px]", statusPill.colorClass)}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                statusPill.dotClass,
                statusPill.pulse && "animate-status-pulse",
              )}
            />
            {statusPill.label}
          </span>
        )}

        {needsAttention ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex items-center gap-1 rounded-md bg-warning-surface px-1.5 py-0.5 text-[10.5px] font-medium text-warning">
                  <TriangleAlertIcon aria-hidden className="size-3" />
                  Needs you
                </span>
              }
            />
            <TooltipPopup side="bottom">
              {entry.needsAttentionReason ?? "This issue is waiting on a person."}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {entry.priority === null ? null : (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", PRIORITY_DOT_CLASS[entry.priority])}
            />
            {ISSUE_PRIORITY_LABEL[entry.priority]}
          </span>
        )}

        <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/70">
          {formatElapsedDurationLabel(entry.updatedAt, nowMs)}
        </span>
      </div>
    </div>
  );
}
