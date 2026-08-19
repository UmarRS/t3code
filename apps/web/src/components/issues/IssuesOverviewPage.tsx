import { issueNeedsAttention } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, ListChecksIcon } from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useAllEnvironmentIssues } from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { AutonomousRunControl } from "./AutonomousRunControl";
import { resolveAutonomousRunState } from "./autonomousRun.logic";
import { ISSUE_STATUS_COLUMNS } from "./IssuesBoard.logic";
import { issuesForProject } from "./IssuesOverviewPage.logic";

export function IssuesOverviewPage() {
  const projects = useProjects();
  const allIssues = useAllEnvironmentIssues();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );

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

        <div className="border-b border-border px-5 py-3">
          <p className="text-sm text-muted-foreground">
            Start autonomous work independently and open any project for its full board.
          </p>
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
          ) : (
            <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-2 2xl:grid-cols-3">
              {projects.map((project) => {
                const issues = issuesForProject(allIssues, project);
                const runState = resolveAutonomousRunState(project);
                const activeIssues = issues.filter((issue) => issue.status !== "archived");
                const needsAttention = issues.filter(issueNeedsAttention).length;
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
                    key={`${project.environmentId}:${project.id}`}
                    className="flex min-w-0 flex-col rounded-xl border border-border/70 bg-card/30"
                  >
                    <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border/60 p-4">
                      <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void openBoard()}
                      >
                        <h2 className="truncate text-sm font-medium text-foreground">
                          {project.title}
                        </h2>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {environmentLabelById.get(project.environmentId) ?? project.workspaceRoot}
                        </p>
                      </button>
                      <Button size="sm" variant="ghost" onClick={() => void openBoard()}>
                        Open board
                        <ChevronRightIcon className="size-3.5" />
                      </Button>
                    </header>

                    <div className="grid grid-cols-3 gap-px bg-border/60">
                      {ISSUE_STATUS_COLUMNS.filter((column) => column.status !== "archived").map(
                        (column) => (
                          <div key={column.status} className="bg-background/80 px-3 py-2.5">
                            <div className="text-base font-medium tabular-nums">
                              {issues.filter((issue) => issue.status === column.status).length}
                            </div>
                            <div className="truncate text-[.6875rem] text-muted-foreground">
                              {column.label}
                            </div>
                          </div>
                        ),
                      )}
                    </div>

                    <footer className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <BotIcon className="size-3.5" />
                        <span>
                          {activeIssues.length} visible issue{activeIssues.length === 1 ? "" : "s"}
                          {needsAttention > 0 ? ` · ${needsAttention} needs you` : ""}
                        </span>
                      </div>
                      <AutonomousRunControl
                        environmentId={project.environmentId}
                        projectId={project.id}
                        issues={issues}
                        runState={runState}
                        onOpenReview={() => void openReview()}
                        listenForExternalPrompt={false}
                      />
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
