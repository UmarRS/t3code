import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
  SettingsIcon,
  StarIcon,
} from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { useRouter } from "@tanstack/react-router";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjectIssues } from "../../state/issues";
import { sidebarProjectPrefKey, useSidebarProjectPrefsStore } from "../../sidebarProjectPrefsStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { useSidebar } from "../ui/sidebar";
import {
  resolveProjectExpanded,
  selectSidebarProjectIssues,
  sortProjectsWithFavoritesFirst,
} from "./SidebarProjects.logic";

// Matches the settled/snoozed shelves' storage convention so all three
// section-collapse preferences live under one namespace.
const PROJECTS_SECTION_EXPANDED_KEY = "t3code:sidebar-v2:projects-expanded";

/**
 * The Projects section: every project the user has, as a row that opens its
 * issues board, with its live and recently finished issues nested underneath.
 *
 * Rows are logical project *groups*, the same units the project filter and
 * settled history already use, so a repo mirrored across environments reads
 * as one project here too. The issues under a row come from the group's
 * representative project ref — deliberately the exact ref the row navigates
 * to, so the sub-rows are always a preview of the board the row opens rather
 * than a merged view of boards the click can't reach.
 */
export const SidebarProjectsSection = memo(function SidebarProjectsSection(props: {
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
}) {
  const [sectionExpanded, setSectionExpanded] = useLocalStorage(
    PROJECTS_SECTION_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const toggleSection = useCallback(
    () => setSectionExpanded((value) => !value),
    [setSectionExpanded],
  );
  const favoriteProjectKeys = useSidebarProjectPrefsStore((state) => state.favoriteProjectKeys);
  const favoriteKeySet = useMemo(() => new Set(favoriteProjectKeys), [favoriteProjectKeys]);
  const orderedProjectGroups = useMemo(
    () =>
      sortProjectsWithFavoritesFirst(props.projectGroups, (group) =>
        favoriteKeySet.has(
          sidebarProjectPrefKey({ environmentId: group.environmentId, projectId: group.id }),
        ),
      ),
    [favoriteKeySet, props.projectGroups],
  );

  if (props.projectGroups.length === 0) return null;

  return (
    <div className="pb-1">
      <button
        type="button"
        onClick={toggleSection}
        aria-expanded={sectionExpanded}
        data-testid="sidebar-projects-section-toggle"
        className="mb-1 mt-2 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
      >
        <span className="text-xs font-medium text-muted-foreground/50">
          {sectionExpanded ? "Projects" : `Projects (${props.projectGroups.length})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 text-muted-foreground/50 transition-transform",
            sectionExpanded && "rotate-180",
          )}
        />
      </button>
      {sectionExpanded ? (
        <ul role="list" className="flex flex-col gap-px" data-testid="sidebar-projects-list">
          {orderedProjectGroups.map((group) => (
            <SidebarProjectRow
              key={group.projectKey}
              group={group}
              isFavorite={favoriteKeySet.has(
                sidebarProjectPrefKey({ environmentId: group.environmentId, projectId: group.id }),
              )}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
});

const SidebarProjectRow = memo(function SidebarProjectRow(props: {
  readonly group: SidebarProjectSnapshot;
  readonly isFavorite: boolean;
}) {
  const { group, isFavorite } = props;
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const prefKey = sidebarProjectPrefKey({
    environmentId: group.environmentId,
    projectId: group.id,
  });
  const explicitExpanded = useSidebarProjectPrefsStore(
    (state) => state.expandedByProjectKey[prefKey],
  );
  const setExpanded = useSidebarProjectPrefsStore((state) => state.setExpanded);
  const toggleFavorite = useSidebarProjectPrefsStore((state) => state.toggleFavorite);
  const expanded = resolveProjectExpanded({ explicit: explicitExpanded, isFavorite });

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const openBoard = useCallback(() => {
    closeMobileSidebar();
    void router.navigate({
      to: "/issues/$environmentId/$projectId",
      params: { environmentId: group.environmentId, projectId: group.id },
    });
  }, [closeMobileSidebar, group.environmentId, group.id, router]);

  const openThread = useCallback(
    (threadId: ThreadId) => {
      closeMobileSidebar();
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(group.environmentId, threadId)),
      });
    },
    [closeMobileSidebar, group.environmentId, router],
  );

  const openSettings = useCallback(() => {
    closeMobileSidebar();
    void router.navigate({
      to: "/projects/$projectKey",
      params: { projectKey: group.projectKey },
    });
  }, [closeMobileSidebar, group.projectKey, router]);

  return (
    <li className="list-none" data-thread-selection-safe>
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-project-row"
        onClick={openBoard}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openBoard();
          }
        }}
        className="group/sidebar-row relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover"
      >
        <button
          type="button"
          aria-label={expanded ? `Collapse ${group.displayName}` : `Expand ${group.displayName}`}
          aria-expanded={expanded}
          className="-ml-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground/70 outline-none hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(prefKey, !expanded);
          }}
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </button>
        <ProjectFavicon
          environmentId={group.environmentId}
          cwd={group.workspaceRoot}
          faviconPath={group.faviconPath}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.displayName}</span>
        {/* Hover-revealed actions, the same affordance model the thread rows
          use: a favorited star stays visible so the state is readable at
          rest, everything else appears on hover or keyboard focus. */}
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={
              isFavorite ? `Unfavorite ${group.displayName}` : `Favorite ${group.displayName}`
            }
            aria-pressed={isFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            className={cn(
              "inline-flex size-5 cursor-pointer items-center justify-center rounded-sm outline-none transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100",
              isFavorite
                ? "text-warning opacity-100"
                : "text-sidebar-muted-foreground opacity-0 group-hover/sidebar-row:opacity-100",
            )}
            onClick={(event) => {
              event.stopPropagation();
              toggleFavorite(prefKey);
            }}
          >
            <StarIcon aria-hidden className={cn("size-3.5", isFavorite && "fill-current")} />
          </button>
          <button
            type="button"
            aria-label={`Project settings for ${group.displayName}`}
            title={`Project settings for ${group.displayName}`}
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground opacity-0 outline-none transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/sidebar-row:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              openSettings();
            }}
          >
            <SettingsIcon aria-hidden className="size-3.5" />
          </button>
        </span>
      </div>
      {expanded ? (
        <SidebarProjectIssueList group={group} onOpenBoard={openBoard} onOpenThread={openThread} />
      ) : null}
    </li>
  );
});

const SidebarProjectIssueList = memo(function SidebarProjectIssueList(props: {
  readonly group: SidebarProjectSnapshot;
  readonly onOpenBoard: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { group, onOpenBoard, onOpenThread } = props;
  const projectRef = useMemo(
    () => scopeProjectRef(group.environmentId, group.id),
    [group.environmentId, group.id],
  );
  const issues = useProjectIssues(projectRef);
  const { entries, hiddenCount } = useMemo(() => selectSidebarProjectIssues(issues), [issues]);

  if (entries.length === 0) {
    return <p className="py-1 ps-9 pe-2.5 text-xs text-muted-foreground/50">No active issues</p>;
  }

  return (
    <ul role="list" className="flex flex-col gap-px">
      {entries.map(({ issue, kind, needsAttention }) => (
        <li key={issue.id} className="list-none">
          <button
            type="button"
            data-testid="sidebar-project-issue-row"
            title={issue.title}
            onClick={() => (issue.threadId === null ? onOpenBoard() : onOpenThread(issue.threadId))}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-9 pe-2.5 text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover",
              needsAttention
                ? "text-warning hover:text-warning"
                : "text-sidebar-muted-foreground/80 hover:text-sidebar-foreground",
            )}
          >
            <SidebarIssueStatusGlyph kind={kind} needsAttention={needsAttention} />
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          </button>
        </li>
      ))}
      {hiddenCount > 0 ? (
        <li className="list-none">
          <button
            type="button"
            data-testid="sidebar-project-issue-more"
            onClick={onOpenBoard}
            className="flex h-7 w-full cursor-pointer items-center rounded-md ps-9 pe-2.5 text-left text-xs text-sidebar-muted-foreground/55 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:bg-sidebar-row-hover"
          >
            +{hiddenCount} more
          </button>
        </li>
      ) : null}
    </ul>
  );
});

/** Running spins, finished checks, flagged warns — the sidebar's own glyph set. */
function SidebarIssueStatusGlyph(props: {
  readonly kind: "running" | "settled";
  readonly needsAttention: boolean;
}) {
  if (props.needsAttention) {
    return <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />;
  }
  if (props.kind === "settled") {
    return <CircleCheckIcon aria-hidden className="size-3 shrink-0" />;
  }
  return (
    <LoaderCircleIcon
      aria-hidden
      className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
    />
  );
}
