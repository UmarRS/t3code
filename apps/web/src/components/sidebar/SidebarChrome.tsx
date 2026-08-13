import {
  ChartNoAxesColumnIcon,
  ChevronRightIcon,
  ListChecksIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { useProjects } from "../../state/entities";
import { resolveAutonomousRunState } from "../issues/autonomousRun.logic";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { IssuesProjectMenuGroup } from "../issues/IssuesProjectMenuGroup";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <AtlasMark />
      <span
        className={cn(
          "truncate text-sm font-medium tracking-tight",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Atlas
      </span>
    </Link>
  );
}

// The full Atlas mark carries three dot rings; at header size only the centre
// ring and its eight inner dots resolve, so this is the simplified tier.
function AtlasMark() {
  return (
    <svg
      aria-label="Atlas"
      className="h-5 w-auto shrink-0"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="16" cy="16" fill="none" r="7.67" stroke="currentColor" strokeWidth="1.3" />
      {[
        [28.62, 16],
        [24.924, 24.924],
        [16, 28.62],
        [7.076, 24.924],
        [3.38, 16],
        [7.076, 7.076],
        [16, 3.38],
        [24.924, 7.076],
      ].map(([cx, cy]) => (
        <circle cx={cx} cy={cy} fill="currentColor" key={`${cx}-${cy}`} r="1.3" />
      ))}
    </svg>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const projects = useProjects();
  const openIssues = useCallback(
    (
      environmentId: (typeof projects)[number]["environmentId"],
      projectId: (typeof projects)[number]["id"],
    ) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/issues/$environmentId/$projectId",
        params: { environmentId, projectId },
      });
    },
    [isMobile, navigate, setOpenMobile],
  );
  // A static dot, never a pulse: this sits in the chrome for the whole run.
  const autonomousRunning = projects.some(
    (project) => resolveAutonomousRunState(project).kind === "running",
  );

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger render={<SidebarMenuButton disabled={projects.length === 0} />}>
              <ListChecksIcon />
              <span>Issues</span>
              {autonomousRunning ? (
                <span
                  aria-label="Autonomous mode is running"
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-info"
                  title="Autonomous mode is running"
                />
              ) : null}
              <ChevronRightIcon className={cn("size-4", !autonomousRunning && "ml-auto")} />
            </MenuTrigger>
            <MenuPopup align="end" side="right" className="w-72">
              <IssuesProjectMenuGroup
                label="Choose a project board"
                projects={projects}
                showBoardIcon
                onSelect={(project) => openIssues(project.environmentId, project.id)}
              />
            </MenuPopup>
          </Menu>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={handleUsageClick}>
            <ChartNoAxesColumnIcon />
            <span>Usage</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={handleSettingsClick}>
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
