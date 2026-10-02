import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC_CHANNELS, type IpcRequest, type IpcResponse } from "../../shared/ipc-channels.js";
import type { AppGraph } from "../composition/app-graph.js";
import { syncAutoLaunch } from "../system/auto-launch.js";
import { DEFAULT_SETTINGS, type AppSettings } from "../../domain/entities/settings.js";
import { forceTrayMenuRefresh } from "../tray.js";
import { getSettingsWindow } from "../windows/settings-window.js";
import { validateSender, typedHandle, typedSend } from "./shared.js";

/** Keys that require restartScheduler() to reschedule timers / re-evaluate gates */
const TIMING_KEYS = new Set<keyof AppSettings>([
  "openBeforeMinutes",
  "windowAlert",
  "autoOpenEnabled",
  "alertLeadSeconds",
  "lateJoinGraceMinutes",
  "quietHoursEnabled",
  "quietHoursStart",
  "quietHoursEnd",
  "nativeNotifications",
]);

function settingsRequireSchedulerRestart(partial: Partial<AppSettings>): boolean {
  return (Object.keys(partial) as (keyof AppSettings)[]).some((k) => TIMING_KEYS.has(k));
}

function runCommittedEffect(effect: () => void): void {
  try {
    effect();
  } catch (err) {
    console.error(
      "[ipc] SETTINGS_SET post-commit effect error:",
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

export function registerSettingsHandlers(win: BrowserWindow, graph: AppGraph): void {
  typedHandle(
    IPC_CHANNELS.SETTINGS_GET,
    (event: IpcMainInvokeEvent): IpcResponse<typeof IPC_CHANNELS.SETTINGS_GET> => {
      if (!validateSender(event)) return { ...DEFAULT_SETTINGS };
      return graph.settings.get();
    },
  );

  typedHandle(
    IPC_CHANNELS.SETTINGS_SET,
    async (
      event: IpcMainInvokeEvent,
      partial: IpcRequest<typeof IPC_CHANNELS.SETTINGS_SET>,
    ): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_SET>> => {
      if (!validateSender(event)) return { ...DEFAULT_SETTINGS };
      const updated = await graph.settings.update(partial);

      runCommittedEffect(() => {
        if (settingsRequireSchedulerRestart(partial)) {
          graph.scheduler.restart();
        } else if (typeof partial.showTomorrowMeetings === "boolean") {
          void graph.scheduler.forcePoll({ reason: "user" }).catch((err: unknown) => {
            console.error(
              "[ipc] SETTINGS_SET force-poll error:",
              err instanceof Error ? err : new Error(String(err)),
            );
          });
        } else if (typeof partial.showCompletedTodayMeetings === "boolean") {
          // Display-only: rebuild tray immediately so completed history appears without a poll.
          forceTrayMenuRefresh();
        }
      });

      const launchAtLogin = partial.launchAtLogin;
      if (typeof launchAtLogin === "boolean") {
        runCommittedEffect(() => {
          syncAutoLaunch(launchAtLogin);
        });
      }

      const sent = new Set<WebContents>();
      for (const target of new Set([win, getSettingsWindow()])) {
        runCommittedEffect(() => {
          if (!target || target.isDestroyed()) return;
          const contents = target.webContents;
          if (contents.isDestroyed() || sent.has(contents)) return;
          sent.add(contents);
          typedSend(contents, IPC_CHANNELS.SETTINGS_CHANGED, updated);
        });
      }
      return updated;
    },
  );
}
