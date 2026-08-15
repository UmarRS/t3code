import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export interface ElectronNotificationInput {
  readonly title: string;
  readonly body: string;
  readonly onClick: () => void;
}

export class ElectronNotificationShowError extends Schema.TaggedErrorClass<ElectronNotificationShowError>()(
  "ElectronNotificationShowError",
  {
    title: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to show the notification "${this.title}".`;
  }
}

// Electron notifications are only reachable from the native banner, so an
// instance nothing references can be collected before the user gets around to
// clicking it. Holding it until the banner resolves keeps the click handler
// alive for as long as the click is possible.
const liveNotifications = new Set<Electron.Notification>();

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    readonly isSupported: Effect.Effect<boolean>;
    readonly show: (
      input: ElectronNotificationInput,
    ) => Effect.Effect<void, ElectronNotificationShowError>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

export const make = ElectronNotification.of({
  isSupported: Effect.sync(() => Electron.Notification.isSupported()),
  show: (input) =>
    Effect.try({
      try: () => {
        const notification = new Electron.Notification({ title: input.title, body: input.body });
        liveNotifications.add(notification);
        const release = () => {
          liveNotifications.delete(notification);
        };
        notification.on("click", () => {
          release();
          input.onClick();
        });
        notification.on("close", release);
        notification.on("failed", release);
        notification.show();
      },
      catch: (cause) => new ElectronNotificationShowError({ title: input.title, cause }),
    }),
});

export const layer = Layer.succeed(ElectronNotification, make);
