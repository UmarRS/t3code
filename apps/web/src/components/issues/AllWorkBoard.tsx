import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { issueNeedsAttention } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  sidebarProjectPrefKey,
  useSidebarProjectPrefsStore,
  type ProjectAccent,
} from "~/sidebarProjectPrefsStore";
import { useProjects, useThreadShells } from "~/state/entities";
import { useAllEnvironmentIssues, type EnvironmentIssue } from "~/state/issues";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { Project } from "~/types";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  allWorkColumnsAreEmpty,
  allWorkIssueMatchesQuery,
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
    <div className="flex min-h-0 items-start gap-3 p-4 sm:p-5">
      {columns.map((column) => (
        <AllWorkColumn key={column.status} column={column} />
      ))}
    </div>
  );
}

const AllWorkColumn = memo(function AllWorkColumn(props: {
  readonly column: IssueBoardColumn<AllWorkEntry>;
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
      className={cn(
        "flex w-72 shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-border/55 bg-card/20 p-2",
        column.muted && "opacity-72",
      )}
    >
      <div
        aria-hidden="true"
        className={cn("-mx-2 -mt-2 h-0.5", ISSUE_COLUMN_ACCENT_CLASS[column.accent])}
      />
      <header className="flex items-center justify-between gap-2 px-1 py-0.5">
        <span className="text-xs font-medium text-foreground">{column.label}</span>
        <span className="flex items-center gap-1.5">
          {column.attentionCount > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="flex items-center gap-1 rounded-full bg-warning-surface px-1.5 py-0.5 font-medium text-[0.6875rem] text-warning tabular-nums">
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
          <span className="text-muted-foreground text-xs tabular-nums">{column.issues.length}</span>
        </span>
      </header>
      {column.issues.length === 0 ? (
        <p className="px-1 pb-1 text-muted-foreground/70 text-xs">Nothing here</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleIssues.map((entry) => (
            <li key={`${entry.environmentId}:${entry.id}`}>
              <AllWorkCard entry={entry} />
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + ALL_WORK_COLUMN_PAGE_COUNT)}
                className="w-full cursor-pointer rounded-lg border border-dashed border-border/70 px-2 py-1.5 text-muted-foreground text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show {Math.min(hiddenCount, ALL_WORK_COLUMN_PAGE_COUNT)} more
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
});

function AllWorkCard({ entry }: { readonly entry: AllWorkEntry }) {
  const navigate = useNavigate();
  const { project, thread } = entry;
  const needsAttention = issueNeedsAttention(entry);
  const statusPill = thread === null ? null : resolveThreadStatusPill({ thread });

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
        "rounded-lg border bg-background p-2.5 shadow-xs/5 transition-colors",
        needsAttention ? "border-warning/40" : "border-border/70 hover:border-border",
      )}
    >
      <button
        type="button"
        title={
          entry.threadId === null
            ? `Open the ${project?.title ?? "issue's"} board`
            : "Open the thread doing this work"
        }
        className="w-full cursor-pointer text-left text-sm text-foreground outline-none focus-visible:underline"
        onClick={openIssue}
      >
        <span className="line-clamp-3">{entry.title}</span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
            "inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            PROJECT_ACCENT_CLASSES[entry.accent].badge,
            project === null ? "opacity-70" : "cursor-pointer hover:brightness-95",
          )}
        >
          {project === null ? null : (
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.workspaceRoot}
              faviconPath={project.faviconPath}
              className="size-3 shrink-0 text-current"
            />
          )}
          <span className="truncate">{project?.title ?? "Unknown project"}</span>
        </button>

        {statusPill === null ? null : (
          <span className={cn("inline-flex items-center gap-1 text-xs", statusPill.colorClass)}>
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
                <Badge variant="warning" size="sm" className="gap-1">
                  <TriangleAlertIcon className="size-3" />
                  Needs you
                </Badge>
              }
            />
            <TooltipPopup side="bottom">
              {entry.needsAttentionReason ?? "This issue is waiting on a person."}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {entry.priority === null ? null : (
          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
            <span className={cn("size-2 rounded-full", PRIORITY_DOT_CLASS[entry.priority])} />
            {ISSUE_PRIORITY_LABEL[entry.priority]}
          </span>
        )}
      </div>
    </div>
  );
}
