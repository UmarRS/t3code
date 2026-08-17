import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId, type DesktopAttentionAlert } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronNotification from "../electron/ElectronNotification.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { ATTENTION_ACTIVATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAttention from "./DesktopAttention.ts";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");

const targetedAlert: DesktopAttentionAlert = {
  title: "Approval needed",
  body: "Fix the flaky test",
  target: { environmentId, threadId },
};

const boardAlert: DesktopAttentionAlert = {
  title: "Issue needs you",
  body: "Ship the importer",
  target: { environmentId, projectId: ProjectId.make("project-1"), view: "review" },
};

const rollupAlert: DesktopAttentionAlert = {
  title: "4 threads need you",
  body: "One · Two · Three",
  target: null,
};

function makeHarness(options: { readonly notificationsSupported?: boolean } = {}) {
  const badgeCounts: number[] = [];
  const shown: ElectronNotification.ElectronNotificationInput[] = [];
  const revealedWindowIds: number[] = [];
  const sent: { readonly channel: string; readonly args: readonly unknown[] }[] = [];
  const mainWindow = { id: 7 } as Electron.BrowserWindow;

  const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
    setBadgeCount: (count: number) =>
      Effect.sync(() => {
        badgeCounts.push(count);
      }),
  } as ElectronApp.ElectronApp["Service"]);

  const notificationLayer = Layer.succeed(
    ElectronNotification.ElectronNotification,
    ElectronNotification.ElectronNotification.of({
      isSupported: Effect.succeed(options.notificationsSupported ?? true),
      show: (input) =>
        Effect.sync(() => {
          shown.push(input);
        }),
    }),
  );

  const windowLayer = Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("unexpected BrowserWindow creation"),
      main: Effect.succeed(Option.some(mainWindow)),
      currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      focusedMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: (window) =>
        Effect.sync(() => {
          revealedWindowIds.push(window.id);
        }),
      sendAll: (channel, ...args) =>
        Effect.sync(() => {
          sent.push({ channel, args });
        }),
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    }),
  );

  return {
    badgeCounts,
    shown,
    revealedWindowIds,
    sent,
    layer: DesktopAttention.layer.pipe(
      Layer.provide(Layer.mergeAll(electronAppLayer, notificationLayer, windowLayer)),
    ),
  };
}

describe("DesktopAttention", () => {
  it.effect("sets the dock badge and shows one notification per alert", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const attention = yield* DesktopAttention.DesktopAttention;
      yield* attention.publish({ badgeCount: 2, alerts: [targetedAlert, rollupAlert] });

      assert.deepEqual(harness.badgeCounts, [2]);
      assert.deepEqual(
        harness.shown.map((input) => input.title),
        ["Approval needed", "4 threads need you"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears the badge without notifying when nothing changed", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const attention = yield* DesktopAttention.DesktopAttention;
      yield* attention.publish({ badgeCount: 0, alerts: [] });

      assert.deepEqual(harness.badgeCounts, [0]);
      assert.equal(harness.shown.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("still badges when the platform cannot show notifications", () => {
    const harness = makeHarness({ notificationsSupported: false });

    return Effect.gen(function* () {
      const attention = yield* DesktopAttention.DesktopAttention;
      yield* attention.publish({ badgeCount: 1, alerts: [targetedAlert] });

      assert.deepEqual(harness.badgeCounts, [1]);
      assert.equal(harness.shown.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reveals the window and routes the renderer when an alert is clicked", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const attention = yield* DesktopAttention.DesktopAttention;
      yield* attention.publish({ badgeCount: 1, alerts: [targetedAlert] });

      harness.shown[0]?.onClick();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepEqual(harness.revealedWindowIds, [7]);
      assert.deepEqual(harness.sent, [
        { channel: ATTENTION_ACTIVATE_CHANNEL, args: [{ environmentId, threadId }] },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("forwards a board target verbatim, main staying a dumb presenter", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const attention = yield* DesktopAttention.DesktopAttention;
      yield* attention.publish({ badgeCount: 1, alerts: [boardAlert] });

      harness.shown[0]?.onClick();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepEqual(harness.sent, [
        { channel: ATTENTION_ACTIVATE_CHANNEL, args: [boardAlert.target] },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("only brings the window forward for a rollup alert", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const attention = yield* DesktopAttention.DesktopAttention;
      yield* attention.publish({ badgeCount: 4, alerts: [rollupAlert] });

      harness.shown[0]?.onClick();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepEqual(harness.revealedWindowIds, [7]);
      assert.deepEqual(harness.sent, []);
    }).pipe(Effect.provide(harness.layer));
  });
});
