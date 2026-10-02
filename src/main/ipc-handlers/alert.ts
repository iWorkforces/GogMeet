import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  captureAlertPresentation,
  handleAlertDismissal,
  isAlertSender,
} from "../windows/alert-window.js";
import { isAlertEpoch } from "../windows/alert-presentation.js";
import { asEventId } from "../../domain/entities/brand.js";
import type { AppGraph } from "../composition/app-graph.js";
import { validateOnSender } from "./shared.js";

/**
 * Register IPC handlers for alert-related fire-and-forget channels.
 *
 * `alert:dismissed` — sent by the renderer when the user dismisses the
 * full-screen meeting alert. Cancels any pending browser auto-open timer
 * for the event and marks it as fired so refresh polls do not re-arm it.
 */
export function registerAlertHandlers(graph: AppGraph): void {
  ipcMain.on(IPC_CHANNELS.ALERT_DISMISSED, (event, payload: unknown) => {
    if (!validateOnSender(event)) return;
    if (!isAlertSender(event.sender)) return;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    if (!("id" in payload) || !("epoch" in payload) || !("phase" in payload)) return;
    const rawId = payload.id;
    if (typeof rawId !== "string") return;
    if (!isAlertEpoch(payload.epoch) || (payload.phase !== "begin" && payload.phase !== "finish"))
      return;
    const result = asEventId(rawId);
    if (!result.ok) return;
    const origin = captureAlertPresentation(event.sender, {
      id: result.value,
      epoch: payload.epoch,
    });
    if (origin)
      handleAlertDismissal(origin, payload.phase, (id) =>
        graph.scheduler.cancelPendingBrowserOpen(id),
      );
  });
}
