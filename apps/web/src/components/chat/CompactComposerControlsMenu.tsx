import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, RocketIcon, SparklesIcon } from "lucide-react";
import { Button } from "../ui/button";
import { composerAutoShipTooltip, type ComposerAutoShipState } from "./composerAutoShip";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  /** Null when the composer target has no resolvable project — disables the action. */
  generateStoriesProjectTitle: string | null;
  /** Null hides the auto-ship item entirely. See `ComposerAutoShipState`. */
  autoShip: ComposerAutoShipState | null;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onGenerateStories: () => void;
  onToggleAutoShip: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        <MenuItem
          disabled={props.generateStoriesProjectTitle === null}
          onClick={props.onGenerateStories}
        >
          <SparklesIcon aria-hidden="true" className="size-4" />
          Generate stories
        </MenuItem>
        {props.autoShip ? (
          <MenuItem
            disabled={props.autoShip.disabledReason !== null}
            title={composerAutoShipTooltip(props.autoShip)}
            onClick={props.onToggleAutoShip}
          >
            <RocketIcon aria-hidden="true" className="size-4" />
            {props.autoShip.enabled ? "Turn off auto-ship" : "Auto-ship"}
          </MenuItem>
        ) : null}
        <MenuDivider />
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          <MenuRadioItem value="auto">Auto</MenuRadioItem>
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
