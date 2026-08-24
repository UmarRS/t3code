import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { issueNeedsAttention, type IssueStatus, type OrchestrationIssue } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, ListChecksIcon, SearchIcon, StarIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { sidebarProjectPrefKey, useSidebarProjectPrefsStore } from "~/sidebarProjectPrefsStore";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useAllEnvironmentIssues, type EnvironmentIssue } from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AllWorkBoard } from "./AllWorkBoard";
import { AutonomousRunControl } from "./AutonomousRunControl";
import {
  describeAutonomousRunStatus,
  resolveAutonomousRunState,
  summarizeAutonomousProgress,
} from "./autonomousRun.logic";
import { ISSUE_STATUS_COLUMNS } from "./IssuesBoard.logic";
import { PROJECT_ACCENT_CLASSES, PROJECT_ACCENT_LABELS, RUN_TONE_CLASS } from "./issueStyles";
import {
  projectAccent,
  projectMatchesOverviewQuery,
  sortOverviewProjects,
  type ProjectAccent,
} from "./IssuesOverviewPage.logic";

/**
 * Which view the page opens on. Remembered because it is a standing
 * preference — a user who runs several projects at once lives on the overall
 * board, and re-picking it after every visit would be the whole point lost.
 */
const OVERVIEW_VIEW_KEY = "t3code:issues-overview:view";
const OverviewView = Schema.Literals(["projects", "work"]);
type OverviewView = typeof OverviewView.Type;

/**
 * The table's one column definition, shared by the header and every row so the
 * two cannot drift apart. Sized rather than fluid: the count columns are a
 * fixed grid the eye scans straight down, and the table scrolls sideways
 * before any of them collapses.
 */
const OVERVIEW_GRID_CLASS =
  "grid items-center gap-3 grid-cols-[minmax(200px,2.2fr)_repeat(5,44px)_minmax(112px,1.1fr)_minmax(170px,1.3fr)_minmax(220px,auto)]";

/** The status columns the table counts, in board order. Archived is history. */
const COUNTED_STATUS_COLUMNS = ISSUE_STATUS_COLUMNS.filter(
  (column) => column.status !== "archived",
);

/** Column heads at table density. The full label rides along as a tooltip. */
const STATUS_SHORT_LABEL: Partial<Record<IssueStatus, string>> = {
  backlog: "Bkg",
  in_progress: "Prog",
  in_review: "Rev",
  done: "Done",
  canceled: "Cncl",
};

const NO_ISSUES: ReadonlyArray<EnvironmentIssue> = [];

export function IssuesOverviewPage() {
  const projects = useProjects();
  const allIssues = useAllEnvironmentIssues();
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  const [view, setView] = useLocalStorage(
    OVERVIEW_VIEW_KEY,
    "projects" as OverviewView,
    OverviewView,
  );
  const favoriteProjectKeys = useSidebarProjectPrefsStore((state) => state.favoriteProjectKeys);
  const favoriteKeySet = useMemo(() => new Set(favoriteProjectKeys), [favoriteProjectKeys]);
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      sortOverviewProjects(projects, (project) =>
        favoriteKeySet.has(
          sidebarProjectPrefKey({
            environmentId: project.environmentId,
            projectId: project.id,
          }),
        ),
      ),
    [favoriteKeySet, projects],
  );
  const visibleProjects = useMemo(
    () =>
      orderedProjects.filter((project) =>
        projectMatchesOverviewQuery(
          project,
          environmentLabelById.get(project.environmentId),
          query,
        ),
      ),
    [environmentLabelById, orderedProjects, query],
  );
  // Grouped once for the whole table rather than filtered per row: every row
  // needs both its own issues and its environment's, and scanning the whole
  // portfolio twice per project is what makes a 20-project overview crawl.
  const { issuesByProjectKey, issuesByEnvironment } = useMemo(() => {
    const byProject = new Map<string, EnvironmentIssue[]>();
    const byEnvironment = new Map<string, EnvironmentIssue[]>();
    for (const issue of allIssues) {
      const projectKey = sidebarProjectPrefKey({
        environmentId: issue.environmentId,
        projectId: issue.projectId,
      });
      const projectBucket = byProject.get(projectKey);
      if (projectBucket === undefined) byProject.set(projectKey, [issue]);
      else projectBucket.push(issue);
      const environmentBucket = byEnvironment.get(issue.environmentId);
      if (environmentBucket === undefined) byEnvironment.set(issue.environmentId, [issue]);
      else environmentBucket.push(issue);
    }
    return { issuesByProjectKey: byProject, issuesByEnvironment: byEnvironment };
  }, [allIssues]);
  const portfolio = useMemo(() => {
    const visibleIssues = allIssues.filter((issue) => issue.status !== "archived");
    return {
      visible: visibleIssues.length,
      running: visibleIssues.filter(
        (issue) => issue.status === "in_progress" || issue.status === "in_review",
      ).length,
      needsAttention: visibleIssues.filter(issueNeedsAttention).length,
    };
  }, [allIssues]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron ? (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <h1 className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Issues · All projects
            </h1>
          </div>
        ) : (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <h1 className="text-sm font-medium text-foreground">Issues · All projects</h1>
          </header>
        )}

        <div className="shrink-0 px-5 pt-6 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-4 lg:flex-row">
            <div className="min-w-0">
              <h2 className="text-[1.75rem] leading-tight font-medium tracking-[-0.028em] text-foreground">
                {view === "projects" ? "Project work" : "Overall board"}
              </h2>
              <p className="mt-1.5 max-w-[52ch] text-sm text-pretty text-muted-foreground">
                {view === "projects"
                  ? "Scan every board, start autonomous work, and keep important projects first."
                  : "Every project's issues in one pipeline, most urgent first, with live work marked."}
              </p>
            </div>
            <label className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[10px] border border-border bg-muted/40 px-3 text-[13px] focus-within:border-ring focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/20 lg:w-64">
              <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="sr-only">
                {view === "projects" ? "Search projects" : "Search issues"}
              </span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={view === "projects" ? "Search projects" : "Search issues"}
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="flex gap-0.5 rounded-[10px] bg-muted/60 p-[3px]">
              <OverviewViewTab
                active={view === "projects"}
                label="Projects"
                onSelect={() => setView("projects")}
              />
              <OverviewViewTab
                active={view === "work"}
                label="Overall board"
                onSelect={() => setView("work")}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <OverviewStatChip
                dotClass="bg-muted-foreground/40"
                label={`${projects.length} project${projects.length === 1 ? "" : "s"}`}
              />
              <OverviewStatChip dotClass="bg-info" label={`${portfolio.visible} visible issues`} />
              <OverviewStatChip dotClass="bg-success" label={`${portfolio.running} moving`} />
              {portfolio.needsAttention > 0 ? (
                <OverviewStatChip
                  dotClass="bg-warning"
                  className="text-warning"
                  label={`${portfolio.needsAttention} need${portfolio.needsAttention === 1 ? "s" : ""} you`}
                />
              ) : null}
            </div>
          </div>
          <div aria-hidden className="mt-4 h-px bg-border" />
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {projects.length === 0 ? (
            <Empty className="min-h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListChecksIcon />
                </EmptyMedia>
                <EmptyTitle>No project boards yet</EmptyTitle>
                <EmptyDescription>Create a project to start tracking issues.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : view === "work" ? (
            <AllWorkBoard query={query} />
          ) : visibleProjects.length === 0 ? (
            <Empty className="min-h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>No matching projects</EmptyTitle>
                <EmptyDescription>
                  Try a project name, environment, or workspace path.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="px-5 py-3.5 pb-10 sm:px-8">
              <div className="w-max min-w-full overflow-hidden rounded-xl border border-border bg-card/20">
                <div
                  className={cn(
                    OVERVIEW_GRID_CLASS,
                    "border-b border-border bg-muted/40 px-3.5 py-2 text-[10.5px] font-medium tracking-[0.05em] text-muted-foreground/80 uppercase",
                  )}
                >
                  <span>Project</span>
                  {COUNTED_STATUS_COLUMNS.map((column) => (
                    <span key={column.status} className="text-center" title={column.label}>
                      {STATUS_SHORT_LABEL[column.status]}
                    </span>
                  ))}
                  <span>Completion</span>
                  <span>Agent</span>
                  <span className="text-right">Actions</span>
                </div>
                {visibleProjects.map((project) => {
                  const key = sidebarProjectPrefKey({
                    environmentId: project.environmentId,
                    projectId: project.id,
                  });
                  return (
                    <OverviewProjectRow
                      key={key}
                      projectKey={key}
                      project={project}
                      issues={issuesByProjectKey.get(key) ?? NO_ISSUES}
                      environmentIssues={
                        issuesByEnvironment.get(project.environmentId) ?? NO_ISSUES
                      }
                      environmentLabel={environmentLabelById.get(project.environmentId) ?? null}
                      isFavorite={favoriteKeySet.has(key)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function OverviewViewTab(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onSelect}
      className={cn(
        "flex h-7 cursor-pointer items-center rounded-lg px-3.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        props.active
          ? "bg-background font-medium text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

function OverviewStatChip(props: {
  readonly dotClass: string;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground",
        props.className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", props.dotClass)} />
      {props.label}
    </span>
  );
}

/**
 * One project as a row: what it holds per column, how much of it is finished,
 * what its agent is doing, and the three ways in — review, the run switch, and
 * the board itself.
 */
const OverviewProjectRow = memo(function OverviewProjectRow(props: {
  readonly projectKey: string;
  readonly project: EnvironmentProject;
  readonly issues: ReadonlyArray<OrchestrationIssue>;
  /** A dependency may sit on another board, so the run reads the environment. */
  readonly environmentIssues: ReadonlyArray<OrchestrationIssue>;
  readonly environmentLabel: string | null;
  readonly isFavorite: boolean;
}) {
  const { environmentIssues, isFavorite, issues, project, projectKey } = props;
  const navigate = useNavigate();
  const accentByProjectKey = useSidebarProjectPrefsStore((state) => state.accentByProjectKey);
  const toggleFavorite = useSidebarProjectPrefsStore((state) => state.toggleFavorite);
  const setAccent = useSidebarProjectPrefsStore((state) => state.setAccent);
  const generatedAccent = projectAccent(projectKey);
  const selectedAccent = accentByProjectKey[projectKey];
  const accent = PROJECT_ACCENT_CLASSES[selectedAccent ?? generatedAccent];

  const runState = useMemo(() => resolveAutonomousRunState(project), [project]);
  const runStatus = useMemo(
    () =>
      describeAutonomousRunStatus({
        progress: summarizeAutonomousProgress(environmentIssues, { projectId: project.id }),
        state: runState,
      }),
    [environmentIssues, project.id, runState],
  );
  const counts = useMemo(() => {
    const byStatus = new Map<IssueStatus, number>();
    for (const issue of issues) {
      byStatus.set(issue.status, (byStatus.get(issue.status) ?? 0) + 1);
    }
    return {
      byStatus,
      done: byStatus.get("done") ?? 0,
      inReview: byStatus.get("in_review") ?? 0,
      tracked: COUNTED_STATUS_COLUMNS.reduce(
        (total, column) => total + (byStatus.get(column.status) ?? 0),
        0,
      ),
      needsAttention: issues.filter(issueNeedsAttention).length,
    };
  }, [issues]);
  const completion = counts.tracked === 0 ? 0 : Math.round((counts.done / counts.tracked) * 100);
  const runLabel = runStatus.detail ? `${runStatus.label} · ${runStatus.detail}` : runStatus.label;

  const openBoard = () =>
    void navigate({
      to: "/issues/$environmentId/$projectId",
      params: { environmentId: project.environmentId, projectId: project.id },
    });
  const openReview = () =>
    void navigate({
      to: "/issues/$environmentId/$projectId/review",
      params: { environmentId: project.environmentId, projectId: project.id },
    });
  // Review earns its place when there is a verdict to read: work waiting on a
  // reviewer, work flagged for a person, or a run that has finished doing both.
  const showReview =
    counts.inReview > 0 || counts.needsAttention > 0 || runState.kind === "finished";

  return (
    <div
      className={cn(
        OVERVIEW_GRID_CLASS,
        "border-b border-border/60 px-3.5 py-2 transition-colors last:border-b-0 hover:bg-muted/30",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Choose color for ${project.title}`}
                title="Choose project color"
                className={cn(
                  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  accent.icon,
                )}
              />
            }
          >
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.workspaceRoot}
              faviconPath={project.faviconPath}
              className="size-3.5 text-current"
            />
          </MenuTrigger>
          <MenuPopup align="start" className="w-44">
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Project color
            </div>
            <MenuRadioGroup
              value={selectedAccent ?? "automatic"}
              onValueChange={(value) =>
                setAccent(projectKey, value === "automatic" ? null : (value as ProjectAccent))
              }
            >
              <MenuRadioItem value="automatic" closeOnClick>
                <span
                  aria-hidden
                  className={cn("size-3 rounded-full", PROJECT_ACCENT_CLASSES[generatedAccent].bar)}
                />
                Automatic
              </MenuRadioItem>
              {(Object.keys(PROJECT_ACCENT_LABELS) as ProjectAccent[]).map((value) => (
                <MenuRadioItem key={value} value={value} closeOnClick>
                  <span
                    aria-hidden
                    className={cn("size-3 rounded-full", PROJECT_ACCENT_CLASSES[value].bar)}
                  />
                  {PROJECT_ACCENT_LABELS[value]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <button
          type="button"
          title={`Open the ${project.title} board — ${props.environmentLabel ?? "Environment"} · ${project.workspaceRoot}`}
          onClick={openBoard}
          className="min-w-0 shrink cursor-pointer truncate text-[13px] font-medium tracking-[-0.012em] text-foreground outline-none hover:underline focus-visible:underline"
        >
          {project.title}
        </button>
        <button
          type="button"
          aria-label={
            isFavorite
              ? `Remove ${project.title} from favorites`
              : `Move ${project.title} to the top`
          }
          aria-pressed={isFavorite}
          title={isFavorite ? "Remove from favorites" : "Move project to top"}
          onClick={() => toggleFavorite(projectKey)}
          className={cn(
            "shrink-0 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isFavorite ? "text-warning" : "text-muted-foreground/40 hover:text-foreground",
          )}
        >
          <StarIcon aria-hidden className={cn("size-3.5", isFavorite && "fill-current")} />
        </button>
      </div>

      {COUNTED_STATUS_COLUMNS.map((column) => {
        const count = counts.byStatus.get(column.status) ?? 0;
        return (
          <button
            type="button"
            key={column.status}
            title={`Open ${project.title} · ${column.label}`}
            onClick={openBoard}
            className={cn(
              "cursor-pointer rounded-md py-1 text-center text-[13px] tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              count === 0
                ? "text-muted-foreground/40"
                : column.status === "done"
                  ? "text-success"
                  : "text-foreground",
            )}
          >
            {count}
          </button>
        );
      })}

      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full",
              counts.done === 0 ? "bg-muted-foreground/25" : "bg-success",
            )}
            style={{ width: `${completion}%` }}
          />
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {counts.done}/{counts.tracked}
        </span>
      </div>

      <div className="flex min-w-0 items-center">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-autonomous-state={runState.kind}
                className={cn(
                  "inline-flex h-5.5 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[11px]",
                  RUN_TONE_CLASS[runStatus.tone].pill,
                )}
              />
            }
          >
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", RUN_TONE_CLASS[runStatus.tone].dot)}
            />
            <span className="truncate">{runLabel}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">{runLabel}</TooltipPopup>
        </Tooltip>
      </div>

      <div className="flex items-center justify-end gap-1.5">
        {showReview ? (
          <Button size="sm" variant="ghost" onClick={openReview}>
            Review
            {counts.inReview > 0 ? (
              <span className="tabular-nums text-muted-foreground">{counts.inReview}</span>
            ) : null}
          </Button>
        ) : null}
        <AutonomousRunControl
          compact
          environmentId={project.environmentId}
          projectId={project.id}
          issues={environmentIssues}
          runState={runState}
          onOpenReview={openReview}
          listenForExternalPrompt={false}
        />
        <Button size="sm" variant="outline" onClick={openBoard}>
          Board
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
