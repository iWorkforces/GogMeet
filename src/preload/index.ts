import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type IpcRequest,
  type IpcResponse,
  type PushChannelMap,
} from "../shared/ipc-channels.js";
import type { AlertPayload } from "../shared/alert.js";
import type { AppSettings } from "../domain/entities/settings.js";
import type { CalendarPublication } from "../domain/entities/calendar-publication.js";
import {
  asEventId,
  asMeetUrl,
  clampWindowHeight,
  type EventId,
  type MeetUrl,
} from "../domain/entities/brand.js";
import { err } from "../domain/entities/result.js";
import { isAllowedMeetHostname } from "../domain/policies/meet-url-allowlist.js";
import { installMainWorldApi, type AlertSubscriber } from "./main-world-api.js";

function brandMeetUrl(raw: string): MeetUrl | null {
  const branded = asMeetUrl(raw);
  if (!branded.ok) return null;
  let parsed: URL;
  try {
    parsed = new URL(branded.value);
  } catch {
    return null;
  }
  if (!isAllowedMeetHostname(parsed.hostname)) return null;
  return branded.value;
}

function joinMeeting(
  rawId: string,
  epoch?: number,
): Promise<IpcResponse<typeof IPC_CHANNELS.APP_JOIN_MEETING>> {
  const id = asEventId(rawId);
  if (!id.ok) return Promise.resolve(err(id.error));
  const request: IpcRequest<typeof IPC_CHANNELS.APP_JOIN_MEETING> = { id: id.value };
  if (epoch !== undefined) request.alert = { epoch };
  return ipcRenderer.invoke(IPC_CHANNELS.APP_JOIN_MEETING, request);
}

const baseApi = {
  calendar: {
    getEvents: (): Promise<IpcResponse<typeof IPC_CHANNELS.CALENDAR_GET_EVENTS>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_GET_EVENTS),

    requestPermission: (): Promise<IpcResponse<typeof IPC_CHANNELS.CALENDAR_REQUEST_PERMISSION>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_REQUEST_PERMISSION),

    getPermissionStatus: (): Promise<IpcResponse<typeof IPC_CHANNELS.CALENDAR_PERMISSION_STATUS>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_PERMISSION_STATUS),

    disconnect: (): Promise<IpcResponse<typeof IPC_CHANNELS.CALENDAR_DISCONNECT>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_DISCONNECT),

    getUiState: (): Promise<IpcResponse<typeof IPC_CHANNELS.CALENDAR_UI_STATE>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_UI_STATE),

    onResultUpdated: (callback: (publication: CalendarPublication) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        publication: CalendarPublication,
      ): void => {
        callback(publication);
      };
      ipcRenderer.on(IPC_CHANNELS.CALENDAR_RESULT_UPDATED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CALENDAR_RESULT_UPDATED, handler);
      };
    },
  },

  window: {
    setHeight: (height: number): void => {
      const clampedHeight = clampWindowHeight(height);
      ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_HEIGHT, { height: clampedHeight });
    },
  },

  app: {
    openExternal: (url: string): Promise<IpcResponse<typeof IPC_CHANNELS.APP_OPEN_EXTERNAL>> => {
      const branded = brandMeetUrl(url);
      if (branded === null) {
        return Promise.resolve(err("Invalid or disallowed URL"));
      }
      return ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, { url: branded });
    },

    joinMeeting: (rawId: string): Promise<IpcResponse<typeof IPC_CHANNELS.APP_JOIN_MEETING>> =>
      joinMeeting(rawId),

    getVersion: (): Promise<IpcResponse<typeof IPC_CHANNELS.APP_GET_VERSION>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  },

  settings: {
    get: (): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_GET>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

    set: (
      partial: IpcRequest<typeof IPC_CHANNELS.SETTINGS_SET>,
    ): Promise<IpcResponse<typeof IPC_CHANNELS.SETTINGS_SET>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, partial),

    onChanged: (callback: (settings: AppSettings) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings): void => {
        callback(settings);
      };
      ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, handler);
      };
    },
  },
};

const subscribeAlert: AlertSubscriber = (callback) => {
  const handler = (
    _event: Electron.IpcRendererEvent,
    wire: PushChannelMap[typeof IPC_CHANNELS.ALERT_SHOW],
  ): void => {
    const { epoch, payload } = wire;
    const dismiss = (rawId: EventId, phase: "begin" | "finish"): void => {
      const id = asEventId(rawId);
      if (id.ok) ipcRenderer.send(IPC_CHANNELS.ALERT_DISMISSED, { id: id.value, epoch, phase });
    };
    callback(payload, {
      join: (rawId: string) => joinMeeting(rawId, epoch),
      begin: (id: EventId) => dismiss(id, "begin"),
      finish: (id: EventId) => dismiss(id, "finish"),
    });
  };
  ipcRenderer.on(IPC_CHANNELS.ALERT_SHOW, handler);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.ALERT_SHOW, handler);
};

contextBridge.executeInMainWorld({ func: installMainWorldApi, args: [baseApi, subscribeAlert] });

export type Api = typeof baseApi & {
  alert: {
    onShowAlert: (callback: (data: AlertPayload) => void) => () => void;
    notifyDismissed: (id: EventId) => void;
  };
};
