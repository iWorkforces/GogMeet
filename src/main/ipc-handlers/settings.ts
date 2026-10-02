import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
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
      try {
        if (settingsRequireSchedulerRestart(partial)) {
          graph.scheduler.restart();
        } else if (typeof partial.showTomorrowMeetings === "boolean") {
          void graph.scheduler.forcePoll({ reason: "user" });
        } else if (typeof partial.showCompletedTodayMeetings === "boolean") {
          // Display-only: rebuild tray immediately so completed history appears without a poll.
          forceTrayMenuRefresh();
        }

        if (typeof partial.launchAtLogin === "boolean") {
          syncAutoLaunch(partial.launchAtLogin);
        }

        // Fan-out to popover and hide-cached Settings window when distinct.
        typedSend(win.webContents, IPC_CHANNELS.SETTINGS_CHANGED, updated);
        const settingsWin = getSettingsWindow();
        if (
          settingsWin &&
          !settingsWin.isDestroyed() &&
          settingsWin.webContents !== win.webContents &&
          !settingsWin.webContents.isDestroyed()
        ) {
          typedSend(settingsWin.webContents, IPC_CHANNELS.SETTINGS_CHANGED, updated);
        }
        return updated;
      } catch (err) {
        console.error("[ipc] SETTINGS_SET error:", err);
        return graph.settings.get();
      }
    },
  );
}
