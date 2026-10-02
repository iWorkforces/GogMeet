import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { AlertPayload } from "../../shared/alert.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import { BrowserWindow, type WebContents } from "electron";
import type { AlertPresentationOrigin } from "./alert-presentation.js";
import {
  SECURE_WEB_PREFERENCES,
  getPreloadPath,
  loadWindowContent,
} from "../utils/browser-window.js";
import { applyAlertAlwaysOnTop, platformWindowChrome } from "../utils/window-chrome.js";

import { typedSend } from "../ipc-handlers/shared.js";
import type { EventId, IsoUtc } from "../../domain/entities/brand.js";

interface AlertPresentation {
  event: MeetingEvent;
  onDismiss: () => void;
  autoOpenAt?: IsoUtc;
  canShow: () => boolean;
}

function toAlertPayload(event: MeetingEvent, autoOpenAt?: IsoUtc): AlertPayload {
  const payload: AlertPayload = {
    id: event.id,
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    calendarName: event.calendarName,
    isAllDay: event.isAllDay,
    hasMeetUrl: !!event.meetUrl,
  };
  if (event.description !== undefined) {
    payload.description = event.description;
  }
  if (autoOpenAt !== undefined) {
    payload.autoOpenAt = autoOpenAt;
  }
  return payload;
}

let alertWindow: BrowserWindow | null = null;
let isAlertShowing = false;
let activePresentation: AlertPresentation | null = null;
let activeOrigin: AlertPresentationOrigin | null = null;
let completionReason: "explicit" | "joined" | null = null;
let alertReady = false;
/** FIFO queue preserves optional autoOpenAt for stacked presentations. */
const pendingAlerts: AlertPresentation[] = [];
/** Prefer hide/show reuse when the prior window is still alive (same security prefs). */
let reuseGeneration = 0;
/** At most one reserved dequeue → present handoff (module-owned). */
let queuedImmediate: ReturnType<typeof setImmediate> | null = null;

/**
 * Reserve the presentation slot, then shift+present on the next tick.
 * Destroy clears `queuedImmediate` and bumps generation so stale callbacks no-op.
 */
function processNextAlert(): void {
  if (queuedImmediate !== null) return;
  if (isAlertShowing || pendingAlerts.length === 0) return;

  // Reserve before scheduling so concurrent showAlert queues behind this owner.
  isAlertShowing = true;
  const reservedGeneration = reuseGeneration;
  queuedImmediate = setImmediate(() => {
    queuedImmediate = null;
    if (reservedGeneration !== reuseGeneration) {
      // Generation advanced via destroy or in-place reschedule while we waited.
      // Do NOT clear isAlertShowing: a live reschedule already owns the slot, and
      // destroy already cleared flags/queue. Only re-drive if nobody is presenting.
      if (!isAlertShowing && pendingAlerts.length > 0) {
        processNextAlert();
      }
      return;
    }
    const next = pendingAlerts.shift();
    if (!next) {
      isAlertShowing = false;
      return;
    }
    if (!next.canShow()) {
      isAlertShowing = false;
      processNextAlert();
      return;
    }
    showAlertInternal(next);
  });
}

function isCurrentPresentation(win: BrowserWindow, generation: number): boolean {
  return (
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    alertWindow === win &&
    generation === reuseGeneration
  );
}

export function isAlertSender(sender: WebContents | undefined): sender is WebContents {
  return (
    !!sender &&
    alertWindow !== null &&
    !alertWindow.isDestroyed() &&
    !sender.isDestroyed() &&
    alertWindow.webContents === sender
  );
}

export function captureAlertPresentation(
  sender: WebContents,
  identity: { readonly id: EventId; readonly epoch: number },
): AlertPresentationOrigin | null {
  const origin = activeOrigin;
  return origin &&
    isAlertSender(sender) &&
    origin.webContents === sender &&
    origin.id === identity.id &&
    origin.epoch === identity.epoch &&
    isCurrentPresentation(origin.window, origin.epoch)
    ? origin
    : null;
}

export function closeAlertPresentation(origin: AlertPresentationOrigin): boolean {
  if (activeOrigin !== origin || !isCurrentPresentation(origin.window, origin.epoch)) return false;
  // Invalidate before hide or user callbacks can reenter the state machine.
  activeOrigin = null;
  completionReason = null;
  reuseGeneration += 1;
  activePresentation = null;
  isAlertShowing = false;
  origin.window.hide();
  processNextAlert();
  return true;
}

export function authorizeAlertJoinCompletion(origin: AlertPresentationOrigin): void {
  if (activeOrigin !== origin || !isCurrentPresentation(origin.window, origin.epoch)) return;
  completionReason ??= "joined";
}

export function handleAlertDismissal(
  origin: AlertPresentationOrigin,
  phase: "begin" | "finish",
  cancel: (id: EventId) => void,
): void {
  if (activeOrigin !== origin || !isCurrentPresentation(origin.window, origin.epoch)) return;
  switch (phase) {
    case "begin":
      if (completionReason !== null) return;
      completionReason = "explicit";
      cancel(origin.id);
      return;
    case "finish": {
      const reason = completionReason;
      if (reason !== null && closeAlertPresentation(origin) && reason === "explicit")
        origin.onDismiss();
      return;
    }
  }
}

function installOrigin(
  win: BrowserWindow,
  generation: number,
  presentation: AlertPresentation,
): void {
  activeOrigin = Object.freeze({
    window: win,
    webContents: win.webContents,
    epoch: generation,
    id: presentation.event.id,
    onDismiss: presentation.onDismiss,
  });
  completionReason = null;
}

export function showAlert(
  event: MeetingEvent,
  onDismiss: () => void,
  autoOpenAt: IsoUtc | undefined,
  canShow: () => boolean,
): void {
  const startMs = new Date(event.startDate).getTime();
  // If same uid but different startMs, the meeting was rescheduled — replace in-place.
  if (
    isAlertShowing &&
    alertWindow &&
    !alertWindow.isDestroyed() &&
    alertWindow.__alertUid === event.id
  ) {
    const sameStart = alertWindow.__alertStartMs === startMs;
    if (sameStart) {
      if (activePresentation?.canShow()) return;
    }
    if (!canShow()) {
      if (sameStart && !alertWindow.isVisible()) {
        consumePresentation(alertWindow, alertWindow.__alertGeneration ?? -1);
      }
      return;
    }
    // Rescheduling replaces presentation ownership without canceling the ID-based pending open.
    const presentation: AlertPresentation = { event, onDismiss, canShow };
    if (autoOpenAt !== undefined) presentation.autoOpenAt = autoOpenAt;
    showAlertInternal(presentation, sameStart && !alertReady);
    return;
  }
  const queuedIndex = pendingAlerts.findIndex((entry) => entry.event.id === event.id);
  if (queuedIndex !== -1) {
    const existing = pendingAlerts[queuedIndex];
    if (existing && new Date(existing.event.startDate).getTime() === startMs) {
      if (existing.canShow()) {
        if (autoOpenAt !== undefined) {
          existing.autoOpenAt = autoOpenAt;
        }
        return;
      }
    }
    // Replace queued entry in-place to preserve order (keep autoOpenAt).
    const next: AlertPresentation = { event, onDismiss, canShow };
    if (autoOpenAt !== undefined) next.autoOpenAt = autoOpenAt;
    pendingAlerts[queuedIndex] = next;
    return;
  }

  if (isAlertShowing) {
    const entry: AlertPresentation = { event, onDismiss, canShow };
    if (autoOpenAt !== undefined) entry.autoOpenAt = autoOpenAt;
    pendingAlerts.push(entry);
    return;
  }

  isAlertShowing = true;
  const presentation: AlertPresentation = { event, onDismiss, canShow };
  if (autoOpenAt !== undefined) presentation.autoOpenAt = autoOpenAt;
  showAlertInternal(presentation);
}

function presentAlertPayload(
  win: BrowserWindow,
  presentation: AlertPresentation,
  generation: number,
): void {
  if (!isCurrentPresentation(win, generation)) return;
  if (!presentation.canShow()) {
    consumePresentation(win, generation);
    return;
  }
  typedSend(win.webContents, IPC_CHANNELS.ALERT_SHOW, {
    epoch: generation,
    payload: toAlertPayload(presentation.event, presentation.autoOpenAt),
  });
  win.webContents
    .executeJavaScript(
      `(() => {
          const app = document.getElementById("app");
          const card = document.querySelector(".alert-card");
          if (!app || !card) return 0;
          const appStyles = window.getComputedStyle(app);
          const paddingTop = Number.parseFloat(appStyles.paddingTop) || 0;
          const paddingBottom = Number.parseFloat(appStyles.paddingBottom) || 0;
          return Math.ceil(card.getBoundingClientRect().height + paddingTop + paddingBottom);
        })()`,
    )
    .then((contentHeight: number) => {
      if (!isCurrentPresentation(win, generation)) return;
      if (!presentation.canShow()) {
        consumePresentation(win, generation);
        return;
      }
      if (typeof contentHeight === "number" && contentHeight > 0) {
        const MIN_HEIGHT = 280;
        const MAX_HEIGHT = 480;
        const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(contentHeight)));
        win.setSize(500, clamped, false);
      }
      win.show();
    })
    .catch(() => {
      if (!isCurrentPresentation(win, generation)) return;
      if (!presentation.canShow()) {
        consumePresentation(win, generation);
        return;
      }
      win.show();
    });
}

function consumePresentation(win: BrowserWindow, generation: number): void {
  if (!isCurrentPresentation(win, generation)) return;
  reuseGeneration += 1;
  activeOrigin = null;
  completionReason = null;
  delete win.__alertUid;
  activePresentation = null;
  isAlertShowing = false;
  processNextAlert();
}

function showAlertInternal(presentation: AlertPresentation, waitForReady = false): void {
  const { event } = presentation;
  const startMs = new Date(event.startDate).getTime();
  reuseGeneration += 1;
  const generation = reuseGeneration;
  activePresentation = presentation;

  // Prefer reusing a hidden-but-alive window (same SECURE_WEB_PREFERENCES, no recreate).
  if (alertWindow && !alertWindow.isDestroyed()) {
    const win = alertWindow;
    win.__alertUid = event.id;
    win.__alertStartMs = startMs;
    win.__alertGeneration = generation;
    installOrigin(win, generation, presentation);
    applyAlertAlwaysOnTop(win);
    if (waitForReady) {
      win.once("ready-to-show", () => {
        if (!isCurrentPresentation(win, generation)) return;
        alertReady = true;
        presentAlertPayload(win, presentation, generation);
      });
      return;
    }
    if (win.isVisible()) {
      win.hide();
    }
    // Clear prior DOM then push the new synthetic generation's payload.
    void win.webContents
      .executeJavaScript(
        `(() => { const app = document.getElementById("app"); if (app) app.innerHTML = ""; return true; })()`,
      )
      .catch(() => undefined)
      .then(() => {
        if (!isCurrentPresentation(win, generation)) return;
        presentAlertPayload(win, presentation, generation);
      });
    return;
  }

  const chrome = platformWindowChrome("alert");
  const win = new BrowserWindow({
    width: 500,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    ...chrome,
    webPreferences: {
      preload: getPreloadPath(),
      ...SECURE_WEB_PREFERENCES,
    },
  });
  alertWindow = win;
  alertReady = false;
  win.__alertUid = event.id;
  win.__alertStartMs = startMs;
  win.__alertGeneration = generation;
  installOrigin(win, generation, presentation);
  applyAlertAlwaysOnTop(win);

  loadWindowContent(win, "alert");

  win.once("ready-to-show", () => {
    if (!isCurrentPresentation(win, generation)) return;
    alertReady = true;
    presentAlertPayload(win, presentation, generation);
  });

  // Prefer hide over destroy so the next alert can reuse this window (same webPreferences).
  win.on("close", (closeEvent) => {
    if (win.__forceDestroy) return;
    closeEvent.preventDefault();
    // An anonymous native close cannot prove which presentation requested it.
  });

  win.on("closed", () => {
    // Only the current window ref may clear shared module state.
    if (alertWindow !== win) return;
    reuseGeneration += 1;
    activeOrigin = null;
    completionReason = null;
    if (queuedImmediate !== null) clearImmediate(queuedImmediate);
    queuedImmediate = null;
    pendingAlerts.length = 0;
    activePresentation = null;
    alertReady = false;
    alertWindow = null;
    isAlertShowing = false;
  });
}

/** Force-destroy any alert window (shutdown / tests). Does not cancel pending browser-open. */
export function destroyAlertWindow(): void {
  if (queuedImmediate !== null) {
    clearImmediate(queuedImmediate);
    queuedImmediate = null;
  }
  reuseGeneration += 1;
  const win = alertWindow;
  alertWindow = null;
  activeOrigin = null;
  completionReason = null;
  activePresentation = null;
  alertReady = false;
  isAlertShowing = false;
  pendingAlerts.length = 0;
  if (win && !win.isDestroyed()) {
    win.__forceDestroy = true;
    win.destroy();
  }
}

declare module "electron" {
  interface BrowserWindow {
    __alertUid?: EventId;
    __alertStartMs?: number;
    __alertGeneration?: number;
    __forceDestroy?: boolean;
  }
}
