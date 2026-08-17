import { ChartNoAxesColumnIcon, MessageSquareIcon, PlugZapIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadShells } from "../state/entities";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Small, always-present summary of agent services that need global visibility. */
export function GlobalAgentStatus() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const activeMcpSessions = threads.filter(
    (thread) => thread.session?.status === "starting" || thread.session?.status === "running",
  );
  const awaitingInput = threads.filter((thread) => thread.hasPendingUserInput);

  return (
    <div className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-3 z-50 flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]">
      {awaitingInput.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="pointer-events-auto relative grid size-8 cursor-pointer place-items-center rounded-md text-warning-foreground hover:bg-muted"
                aria-label={`${awaitingInput.length} agent question${awaitingInput.length === 1 ? "" : "s"} awaiting an answer`}
                onClick={() => {
                  const thread = awaitingInput[0];
                  if (!thread) return;
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: thread.environmentId, threadId: thread.id },
                  });
                }}
              />
            }
          >
            <MessageSquareIcon className="size-4" />
            <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {awaitingInput.length} agent question{awaitingInput.length === 1 ? "" : "s"} awaiting an
            answer
          </TooltipPopup>
        </Tooltip>
      ) : null}

      {/*
        A Menu trigger and a hover Tooltip on the same element both want the
        pointer, and stacking them (as PreviewMoreMenu does) works here too:
        the tooltip still opens on hover and gets out of the way once the menu
        opens. aria-label carries the same "N active sessions" summary either
        way, so nothing is lost if that combination ever needs to be dropped.
      */}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="pointer-events-auto relative grid size-8 cursor-pointer place-items-center rounded-md text-icon-muted hover:bg-muted hover:text-foreground"
                    aria-label={`Atlas MCP · ${activeMcpSessions.length} active agent session${activeMcpSessions.length === 1 ? "" : "s"}`}
                  />
                }
              />
            }
          >
            <PlugZapIcon className="size-4" />
            {activeMcpSessions.length > 0 ? (
              <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-success" />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Atlas MCP · {activeMcpSessions.length} active agent session
            {activeMcpSessions.length === 1 ? "" : "s"}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" sideOffset={6} className="min-w-56">
          {activeMcpSessions.length === 0 ? (
            <MenuItem disabled>No active agent sessions</MenuItem>
          ) : (
            activeMcpSessions.map((thread) => (
              <MenuItem
                key={thread.id}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: thread.environmentId, threadId: thread.id },
                  })
                }
              >
                <span className="truncate">{thread.title}</span>
              </MenuItem>
            ))
          )}
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/connections" })}>
            Connection settings
          </MenuItem>
        </MenuPopup>
      </Menu>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="pointer-events-auto grid size-8 cursor-pointer place-items-center rounded-md text-icon-muted hover:bg-muted hover:text-foreground"
              aria-label="Open usage"
              onClick={() => void navigate({ to: "/usage" })}
            />
          }
        >
          <ChartNoAxesColumnIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Usage history and API-equivalent cost</TooltipPopup>
      </Tooltip>
    </div>
  );
}
