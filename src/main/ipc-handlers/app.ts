import { app, type IpcMainInvokeEvent } from "electron";
import { asEventId, asMeetUrl } from "../../domain/entities/brand.js";
import { IPC_CHANNELS, type IpcRequest, type IpcResponse } from "../../shared/ipc-channels.js";
import { err } from "../../domain/entities/result.js";
import type { AppGraph } from "../composition/app-graph.js";
import { typedHandle, validateSender } from "./shared.js";
import { isLiveWindowSender } from "../windows/alert-presentation.js";

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
      const raw = payload?.id;
      if (typeof raw !== "string") return err("Invalid event id");
      const branded = asEventId(raw);
      if (!branded.ok) return err(branded.error);
      return graph.join.byId(branded.value);
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
