import { ArrowLeftIcon, ChartNoAxesColumnIcon, ListChecksIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { APP_DISPLAY_NAME, APP_VERSION } from "../../branding";
import { useProjects } from "../../state/entities";
import { resolveAutonomousRunState } from "../issues/autonomousRun.logic";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

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
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
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
          "-translate-y-px truncate text-sm font-medium tracking-tight",
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
  const canGoBack = useCanGoBack();
  const currentFooterPage = useLocation({
    select: (location) => (location.pathname === "/usage" ? "usage" : null),
  });
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/usage" });
  }, [closeMobileSidebar, navigate]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  const projects = useProjects();
  const openIssues = useCallback(
    (
      environmentId: (typeof projects)[number]["environmentId"],
      projectId: (typeof projects)[number]["id"],
    ) => {
      closeMobileSidebar();
      void navigate({
        to: "/issues/$environmentId/$projectId",
        params: { environmentId, projectId },
      });
    },
    [closeMobileSidebar, navigate, projects],
  );
  // A static dot, never a pulse: this sits in the chrome for the whole run.
  const autonomousRunning = projects.some(
    (project) => resolveAutonomousRunState(project).kind === "running",
  );

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarMenu className="flex-row items-center">
        {currentFooterPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarMenuItem className="shrink-0">
              <Menu>
                <MenuTrigger
                  render={
                    <SidebarMenuButton
                      aria-label="Issues"
                      disabled={projects.length === 0}
                      size="icon"
                    />
                  }
                >
                  <ListChecksIcon />
                  {autonomousRunning ? (
                    <span
                      aria-label="Autonomous mode is running"
                      className="absolute top-1 right-1 size-1.5 shrink-0 rounded-full bg-info"
                      title="Autonomous mode is running"
                    />
                  ) : null}
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
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label="Settings"
                      onClick={handleSettingsClick}
                      size="icon"
                    >
                      <SettingsIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Settings</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton aria-label="Usage" onClick={handleUsageClick} size="icon">
                      <ChartNoAxesColumnIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Usage</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
          </>
        )}
        <SidebarVersionLabel />
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});

/**
 * The running version, parked in the chrome so "which build am I on?" is a
 * glance rather than a trip into Settings. Kept outside the footer's page
 * branch so it survives navigation, and named from the resolved branding
 * rather than a literal, since forks rename the app and nightly and latest
 * share version numbers. Settings keeps the authoritative About row — with
 * the desktop updater attached — so this stays a plain label.
 */
function SidebarVersionLabel() {
  return (
    <SidebarMenuItem className="min-w-0 shrink">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="block truncate px-1 text-[11px] text-sidebar-muted-foreground/70 tabular-nums">
              v{APP_VERSION}
            </span>
          }
        />
        <TooltipPopup side="top">
          {APP_DISPLAY_NAME} {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
