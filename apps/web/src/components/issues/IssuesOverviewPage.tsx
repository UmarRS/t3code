import { issueNeedsAttention, type IssueStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronRightIcon,
  ListChecksIcon,
  PaletteIcon,
  SearchIcon,
  StarIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { sidebarProjectPrefKey, useSidebarProjectPrefsStore } from "~/sidebarProjectPrefsStore";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useAllEnvironmentIssues } from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { AutonomousRunControl } from "./AutonomousRunControl";
import { resolveAutonomousRunState } from "./autonomousRun.logic";
import { ISSUE_STATUS_COLUMNS } from "./IssuesBoard.logic";
import {
  issuesForEnvironment,
  issuesForProject,
  projectAccent,
  projectMatchesOverviewQuery,
  sortOverviewProjects,
  type ProjectAccent,
} from "./IssuesOverviewPage.logic";

const PROJECT_ACCENT_CLASSES: Record<
  ProjectAccent,
  { readonly bar: string; readonly icon: string; readonly badge: string }
> = {
  blue: {
    bar: "bg-blue-500",
    icon: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
    badge: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  teal: {
    bar: "bg-teal-500",
    icon: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
    badge: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
  purple: {
    bar: "bg-purple-500",
    icon: "bg-purple-500/12 text-purple-700 dark:text-purple-300",
    badge: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  },
  orange: {
    bar: "bg-orange-500",
    icon: "bg-orange-500/12 text-orange-700 dark:text-orange-300",
    badge: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  pink: {
    bar: "bg-pink-500",
    icon: "bg-pink-500/12 text-pink-700 dark:text-pink-300",
    badge: "bg-pink-500/10 text-pink-700 dark:text-pink-300",
  },
  green: {
    bar: "bg-green-500",
    icon: "bg-green-500/12 text-green-700 dark:text-green-300",
    badge: "bg-green-500/10 text-green-700 dark:text-green-300",
  },
};

const PROJECT_ACCENT_LABELS: Record<ProjectAccent, string> = {
  blue: "Blue",
  teal: "Teal",
  purple: "Purple",
  orange: "Orange",
  pink: "Pink",
  green: "Green",
};

const STATUS_CLASSES: Record<IssueStatus, string> = {
  backlog: "bg-muted/65 text-muted-foreground",
  in_progress: "bg-info/10 text-info-foreground",
  in_review: "bg-update/10 text-update-foreground",
  done: "bg-success/10 text-success",
  canceled: "bg-destructive/7 text-muted-foreground",
  archived: "bg-muted/45 text-muted-foreground/70",
};

const OVERVIEW_STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  in_review: "Review",
  done: "Done",
  canceled: "Canceled",
  archived: "Archived",
};

export function IssuesOverviewPage() {
  const projects = useProjects();
  const allIssues = useAllEnvironmentIssues();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const favoriteProjectKeys = useSidebarProjectPrefsStore((state) => state.favoriteProjectKeys);
  const accentByProjectKey = useSidebarProjectPrefsStore((state) => state.accentByProjectKey);
  const toggleFavorite = useSidebarProjectPrefsStore((state) => state.toggleFavorite);
  const setAccent = useSidebarProjectPrefsStore((state) => state.setAccent);
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

        <div className="border-b border-border px-4 py-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">
            <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Project work</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Scan every board, start autonomous work, and keep important projects first.
                </p>
              </div>
              <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 lg:w-72">
                <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="sr-only">Search projects</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search projects"
                  className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-muted px-2.5 py-1 font-medium text-foreground">
                {projects.length} project{projects.length === 1 ? "" : "s"}
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                {portfolio.visible} visible issues
              </span>
              <span className="rounded-full bg-info/10 px-2.5 py-1 font-medium text-info-foreground">
                {portfolio.running} moving
              </span>
              {portfolio.needsAttention > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning-surface px-2.5 py-1 font-medium text-warning">
                  <TriangleAlertIcon aria-hidden className="size-3" />
                  {portfolio.needsAttention} need{portfolio.needsAttention === 1 ? "s" : ""} you
                </span>
              ) : null}
            </div>
          </div>
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
            <div className="mx-auto grid w-full max-w-[1500px] grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-2 2xl:grid-cols-3">
              {visibleProjects.map((project) => {
                const key = sidebarProjectPrefKey({
                  environmentId: project.environmentId,
                  projectId: project.id,
                });
                const isFavorite = favoriteKeySet.has(key);
                const generatedAccent = projectAccent(key);
                const selectedAccent = accentByProjectKey[key];
                const accent = PROJECT_ACCENT_CLASSES[selectedAccent ?? generatedAccent];
                const issues = issuesForProject(allIssues, project);
                // The run readout reaches past this board: a story here may be
                // waiting on one another board is working.
                const environmentIssues = issuesForEnvironment(allIssues, project.environmentId);
                const runState = resolveAutonomousRunState(project);
                const activeIssues = issues.filter((issue) => issue.status !== "archived");
                const needsAttention = issues.filter(issueNeedsAttention).length;
                const reviewCount = issues.filter((issue) => issue.status === "in_review").length;
                const openBoard = () =>
                  navigate({
                    to: "/issues/$environmentId/$projectId",
                    params: { environmentId: project.environmentId, projectId: project.id },
                  });
                const openReview = () =>
                  navigate({
                    to: "/issues/$environmentId/$projectId/review",
                    params: { environmentId: project.environmentId, projectId: project.id },
                  });

                return (
                  <section
                    key={key}
                    className="group/project-card relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/35 shadow-xs transition-[border-color,box-shadow] hover:border-border hover:shadow-sm"
                  >
                    <div aria-hidden className={cn("h-1 w-full", accent.bar)} />
                    <header className="flex min-w-0 items-start gap-3 p-4 pb-3">
                      <div
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-lg",
                          accent.icon,
                        )}
                      >
                        <ProjectFavicon
                          environmentId={project.environmentId}
                          cwd={project.workspaceRoot}
                          faviconPath={project.faviconPath}
                          className="size-5 text-current"
                        />
                      </div>
                      <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void openBoard()}
                      >
                        <h2 className="truncate text-sm font-semibold text-foreground">
                          {project.title}
                        </h2>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {project.workspaceRoot}
                        </p>
                      </button>
                      <Menu>
                        <MenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`Choose color for ${project.title}`}
                              title="Choose project color"
                              className={cn(
                                "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                                accent.icon,
                              )}
                            />
                          }
                        >
                          <PaletteIcon aria-hidden className="size-4" />
                        </MenuTrigger>
                        <MenuPopup align="end" className="w-44">
                          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                            Project color
                          </div>
                          <MenuRadioGroup
                            value={selectedAccent ?? "automatic"}
                            onValueChange={(value) =>
                              setAccent(
                                key,
                                value === "automatic" ? null : (value as ProjectAccent),
                              )
                            }
                          >
                            <MenuRadioItem value="automatic" closeOnClick>
                              <span
                                aria-hidden
                                className={cn(
                                  "size-3 rounded-full",
                                  PROJECT_ACCENT_CLASSES[generatedAccent].bar,
                                )}
                              />
                              Automatic
                            </MenuRadioItem>
                            {(Object.keys(PROJECT_ACCENT_LABELS) as ProjectAccent[]).map(
                              (value) => (
                                <MenuRadioItem key={value} value={value} closeOnClick>
                                  <span
                                    aria-hidden
                                    className={cn(
                                      "size-3 rounded-full",
                                      PROJECT_ACCENT_CLASSES[value].bar,
                                    )}
                                  />
                                  {PROJECT_ACCENT_LABELS[value]}
                                </MenuRadioItem>
                              ),
                            )}
                          </MenuRadioGroup>
                        </MenuPopup>
                      </Menu>
                      <button
                        type="button"
                        aria-label={
                          isFavorite
                            ? `Remove ${project.title} from favorites`
                            : `Move ${project.title} to the top`
                        }
                        aria-pressed={isFavorite}
                        title={isFavorite ? "Remove from favorites" : "Move project to top"}
                        onClick={() => toggleFavorite(key)}
                        className={cn(
                          "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                          isFavorite
                            ? "text-warning"
                            : "text-muted-foreground/55 hover:text-foreground",
                        )}
                      >
                        <StarIcon
                          aria-hidden
                          className={cn("size-4", isFavorite && "fill-current")}
                        />
                      </button>
                    </header>

                    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px]", accent.badge)}>
                        {environmentLabelById.get(project.environmentId) ?? "Environment"}
                      </span>
                      {needsAttention > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-warning-surface px-2 py-0.5 text-[11px] font-medium text-warning">
                          <TriangleAlertIcon aria-hidden className="size-3" />
                          {needsAttention} need{needsAttention === 1 ? "s" : ""} you
                        </span>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-5 gap-1.5 border-y border-border/55 bg-background/35 p-3">
                      {ISSUE_STATUS_COLUMNS.filter((column) => column.status !== "archived").map(
                        (column) => {
                          const count = issues.filter(
                            (issue) => issue.status === column.status,
                          ).length;
                          return (
                            <button
                              type="button"
                              key={column.status}
                              title={`Open ${project.title} · ${column.label}`}
                              onClick={() => void openBoard()}
                              className={cn(
                                "min-w-0 cursor-pointer rounded-lg px-1.5 py-2 text-center outline-none transition-[filter,transform] hover:brightness-95 active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring",
                                STATUS_CLASSES[column.status],
                              )}
                            >
                              <span className="block text-base font-semibold leading-none tabular-nums">
                                {count}
                              </span>
                              <span className="mt-1 block truncate text-[10px] leading-tight">
                                {OVERVIEW_STATUS_LABEL[column.status]}
                              </span>
                            </button>
                          );
                        },
                      )}
                    </div>

                    <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <BotIcon aria-hidden className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {activeIssues.length} visible issue{activeIssues.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {reviewCount > 0 ? (
                          <Button size="sm" variant="ghost" onClick={() => void openReview()}>
                            Review {reviewCount}
                          </Button>
                        ) : null}
                        <AutonomousRunControl
                          environmentId={project.environmentId}
                          projectId={project.id}
                          issues={environmentIssues}
                          runState={runState}
                          onOpenReview={() => void openReview()}
                          listenForExternalPrompt={false}
                        />
                        <Button size="sm" variant="ghost" onClick={() => void openBoard()}>
                          Board
                          <ChevronRightIcon aria-hidden className="size-3.5" />
                        </Button>
                      </div>
                    </footer>
                  </section>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
