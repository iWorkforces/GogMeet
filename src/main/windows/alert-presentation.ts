import { BrowserWindow, type WebContents } from "electron";
import type { EventId } from "../../domain/entities/brand.js";

/** Main-installed identity; never inferred from the latest renderer delivery. */
export interface AlertPresentationOrigin {
  readonly window: BrowserWindow;
  readonly webContents: WebContents;
  readonly epoch: number;
  readonly id: EventId;
  readonly onDismiss: () => void;
}

export function isLiveWindowSender(sender: WebContents | undefined): sender is WebContents {
  if (!sender || sender.isDestroyed()) return false;
  const owner = BrowserWindow.fromWebContents(sender);
  return owner !== null && !owner.isDestroyed() && owner.webContents === sender;
}

export function isAlertEpoch(epoch: unknown): epoch is number {
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0;
}
