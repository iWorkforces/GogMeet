import { app, type IpcMainInvokeEvent } from "electron";
import { asEventId, asMeetUrl } from "../../domain/entities/brand.js";
import { IPC_CHANNELS, type IpcRequest, type IpcResponse } from "../../shared/ipc-channels.js";
import { err } from "../../domain/entities/result.js";
import type { AppGraph } from "../composition/app-graph.js";
import { typedHandle, validateSender } from "./shared.js";
import {
  captureAlertPresentation,
  authorizeAlertJoinCompletion,
  isAlertSender,
} from "../windows/alert-window.js";
import { isAlertEpoch, isLiveWindowSender } from "../windows/alert-presentation.js";

export function registerAppHandlers(graph: AppGraph): void {
  typedHandle(
    IPC_CHANNELS.APP_OPEN_EXTERNAL,
    async (
      event: IpcMainInvokeEvent,
      payload: IpcRequest<typeof IPC_CHANNELS.APP_OPEN_EXTERNAL>,
    ): Promise<IpcResponse<typeof IPC_CHANNELS.APP_OPEN_EXTERNAL>> => {
      if (!validateSender(event)) return err("Unauthorized");
      const raw = payload?.url;
      if (typeof raw !== "string") return err("Invalid URL payload");
      const branded = asMeetUrl(raw);
      if (!branded.ok) return err(branded.error);
      return graph.opener.open(branded.value);
    },
  );

  typedHandle(
    IPC_CHANNELS.APP_JOIN_MEETING,
    async (
      event: IpcMainInvokeEvent,
      payload: IpcRequest<typeof IPC_CHANNELS.APP_JOIN_MEETING>,
    ): Promise<IpcResponse<typeof IPC_CHANNELS.APP_JOIN_MEETING>> => {
      if (!validateSender(event)) return err("Unauthorized");
      if (!isLiveWindowSender(event.sender)) return err("Unauthorized");
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return err("Invalid event id");
      const raw = payload?.id;
      if (typeof raw !== "string") return err("Invalid event id");
      const branded = asEventId(raw);
      if (!branded.ok) return err(branded.error);
      const alertSender = isAlertSender(event.sender);
      const metadata = payload.alert;
      if (
        metadata !== undefined &&
        (!metadata ||
          typeof metadata !== "object" ||
          Array.isArray(metadata) ||
          !isAlertEpoch(metadata.epoch))
      )
        return err("Invalid alert metadata");
      if (alertSender && metadata === undefined) return err("Invalid alert metadata");
      if (!alertSender && metadata !== undefined) return err("Unauthorized");
      const origin =
        alertSender && metadata
          ? captureAlertPresentation(event.sender, { id: branded.value, epoch: metadata.epoch })
          : null;
      const result = await graph.join.byId(branded.value);
      if (result.ok && origin) authorizeAlertJoinCompletion(origin);
      return result;
    },
  );

  typedHandle(
    IPC_CHANNELS.APP_GET_VERSION,
    (event: IpcMainInvokeEvent): IpcResponse<typeof IPC_CHANNELS.APP_GET_VERSION> => {
      if (!validateSender(event)) return "";
      try {
        return app.getVersion();
      } catch (e) {
        console.error("[ipc] APP_GET_VERSION error:", e);
        return "";
      }
    },
  );
}
