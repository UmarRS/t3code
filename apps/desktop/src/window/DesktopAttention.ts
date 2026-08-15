import type { DesktopAttentionAlert, DesktopAttentionState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronNotification from "../electron/ElectronNotification.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { ATTENTION_ACTIVATE_CHANNEL } from "../ipc/channels.ts";

const { logWarning } = makeComponentLogger("desktop-attention");

type DesktopAttentionRuntimeServices =
  | ElectronApp.ElectronApp
  | ElectronNotification.ElectronNotification
  | ElectronWindow.ElectronWindow;

/**
 * The renderer's view of what is waiting on the user, projected onto the OS:
 * the dock badge carries the standing count, and each alert becomes one native
 * notification that reveals the window and routes the renderer to the thread.
 *
 * Everything here is best-effort. A refused notification (Do Not Disturb,
 * denied permission) must never surface as an error in the renderer, which is
 * only reporting state it already renders in-app.
 */
export class DesktopAttention extends Context.Service<
  DesktopAttention,
  {
    readonly publish: (state: DesktopAttentionState) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopAttention") {}

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronNotification = yield* ElectronNotification.ElectronNotification;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const context = yield* Effect.context<DesktopAttentionRuntimeServices>();
  const runFork = Effect.runForkWith(context);

  const activate = Effect.fn("desktop.attention.activate")(function* (
    alert: DesktopAttentionAlert,
  ) {
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window)) {
      return;
    }
    yield* electronWindow.reveal(window.value);
    if (alert.target === null) {
      return;
    }
    yield* electronWindow.sendAll(ATTENTION_ACTIVATE_CHANNEL, alert.target);
  });

  const showAlert = (alert: DesktopAttentionAlert) =>
    electronNotification
      .show({
        title: alert.title,
        body: alert.body,
        onClick: () => {
          runFork(activate(alert));
        },
      })
      .pipe(
        Effect.catchTag("ElectronNotificationShowError", (error) =>
          logWarning("failed to show an attention notification", { reason: error.message }),
        ),
      );

  return DesktopAttention.of({
    publish: Effect.fn("desktop.attention.publish")(function* (state) {
      yield* Effect.annotateCurrentSpan({
        badgeCount: state.badgeCount,
        alertCount: state.alerts.length,
      });
      yield* electronApp.setBadgeCount(state.badgeCount);
      if (state.alerts.length === 0) {
        return;
      }
      if (!(yield* electronNotification.isSupported)) {
        return;
      }
      yield* Effect.forEach(state.alerts, showAlert);
    }),
  });
});

export const layer = Layer.effect(DesktopAttention, make);
