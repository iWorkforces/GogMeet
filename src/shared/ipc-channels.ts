import type { CalendarPermission } from "../domain/entities/calendar-result.js";
import type { CalendarPublication } from "../domain/entities/calendar-publication.js";
import type { CalendarUiState } from "../domain/entities/calendar-ui-state.js";
import type { EventId, MeetUrl, WindowHeight } from "../domain/entities/brand.js";
import type { AppSettings } from "../domain/entities/settings.js";
import type { AlertPayload } from "./alert.js";
import type { Result } from "../domain/entities/result.js";

/** IPC channel names — single source of truth */
export const IPC_CHANNELS = {
  CALENDAR_GET_EVENTS: "calendar:get-events",
  CALENDAR_REQUEST_PERMISSION: "calendar:request-permission",
  CALENDAR_PERMISSION_STATUS: "calendar:permission-status",
  CALENDAR_DISCONNECT: "calendar:disconnect",
  CALENDAR_UI_STATE: "calendar:ui-state",
  WINDOW_SET_HEIGHT: "window:set-height",
  APP_OPEN_EXTERNAL: "app:open-external",
  APP_JOIN_MEETING: "app:join-meeting",
  APP_GET_VERSION: "app:get-version",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SETTINGS_CHANGED: "settings:changed",
  /** Main → renderer: full calendar publication (replaces events-only push). */
  CALENDAR_RESULT_UPDATED: "calendar:result-updated",
  ALERT_SHOW: "alert:show",
  ALERT_DISMISSED: "alert:dismissed",
} as const;

// ─── Type utilities for IPC ──────────────────────────────────────────────────

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * IPC invoke channel map — single source of truth for request/response types.
 * Each entry maps a channel string to its `{ request; response }` payload types.
 */
export interface IpcChannelMap {
  [IPC_CHANNELS.CALENDAR_GET_EVENTS]: { request: void; response: CalendarPublication };
  [IPC_CHANNELS.CALENDAR_REQUEST_PERMISSION]: { request: void; response: CalendarPermission };
  [IPC_CHANNELS.CALENDAR_PERMISSION_STATUS]: { request: void; response: CalendarPermission };
  [IPC_CHANNELS.CALENDAR_DISCONNECT]: { request: void; response: void };
  [IPC_CHANNELS.CALENDAR_UI_STATE]: { request: void; response: CalendarUiState };
  [IPC_CHANNELS.WINDOW_SET_HEIGHT]: { request: { height: WindowHeight }; response: void };
  [IPC_CHANNELS.APP_OPEN_EXTERNAL]: {
    request: { url: MeetUrl };
    response: Result<void, string>;
  };
  [IPC_CHANNELS.APP_JOIN_MEETING]: {
    request: { id: EventId; alert?: { epoch: number } };
    response: Result<void, string>;
  };
  [IPC_CHANNELS.APP_GET_VERSION]: { request: void; response: string };
  [IPC_CHANNELS.SETTINGS_GET]: { request: void; response: AppSettings };
  [IPC_CHANNELS.SETTINGS_SET]: { request: Partial<AppSettings>; response: AppSettings };
  [IPC_CHANNELS.ALERT_DISMISSED]: {
    request: { id: EventId; epoch: number; phase: "begin" | "finish" };
    response: void;
  };
}

/** Type-safe IPC request/response derived from the channel map */
export type IpcRequest<K extends keyof IpcChannelMap> = IpcChannelMap[K]["request"];
export type IpcResponse<K extends keyof IpcChannelMap> = IpcChannelMap[K]["response"];

// ─── Push channels: main → renderer (webContents.send) ──────────────────────

/** Push channel payload type map for type-safe webContents.send */
export interface PushChannelMap {
  [IPC_CHANNELS.ALERT_SHOW]: { epoch: number; payload: AlertPayload };
  [IPC_CHANNELS.SETTINGS_CHANGED]: AppSettings;
  [IPC_CHANNELS.CALENDAR_RESULT_UPDATED]: CalendarPublication;
}
