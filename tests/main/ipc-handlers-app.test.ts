import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAppHandlers } from "../../src/main/ipc-handlers/app.js";
import { ipcMain, app, BrowserWindow } from "electron";
import { authorizedInvokeEvent } from "../helpers/ipc-sender.js";
import { testAppGraph } from "../helpers/app-graph.js";

const mockOpenMeetingUrl = vi.fn();
const mockJoinMeetingById = vi.fn();

const mockIpcMain = vi.mocked(ipcMain);
const mockApp = vi.mocked(app);

function getRegisteredHandler(channel: string) {
  const call = mockIpcMain.handle.mock.calls.find((c) => c[0] === channel);
  const handler = call?.[1];
  if (!handler) throw new TypeError(`IPC handler was not registered: ${channel}`);
  return handler;
}

const unauthorizedEvent = {
  senderFrame: { url: "https://evil.com/" },
}.As<import("electron").IpcMainInvokeEvent>();

let authorizedEvent: import("electron").IpcMainInvokeEvent;

function appGraphForTest() {
  return testAppGraph({
    opener: { open: mockOpenMeetingUrl },
    join: { byId: mockJoinMeetingById },
  });
}

describe("registerAppHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.getVersion.mockReturnValue("1.0.0");
    mockOpenMeetingUrl.mockResolvedValue({ ok: true, value: undefined });
    mockJoinMeetingById.mockResolvedValue({ ok: true, value: undefined });
    const win = {
      webContents: { isDestroyed: vi.fn(() => false) },
      isDestroyed: vi.fn(() => false),
    }.As<BrowserWindow>();
    BrowserWindow.fromWebContents = vi.fn((sender) => (sender === win.webContents ? win : null));
    authorizedEvent = { ...authorizedInvokeEvent("index"), sender: win.webContents }.As<
      import("electron").IpcMainInvokeEvent
    >();
  });

  it("registers 3 handlers", () => {
    registerAppHandlers(appGraphForTest());
    expect(mockIpcMain.handle).toHaveBeenCalledTimes(3);
  });

  describe("app:open-external", () => {
    it("delegates allowed URL to openMeetingUrl for authorized sender", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:open-external");

      const result = await handler(authorizedEvent, {
        url: "https://meet.google.com/abc-def-ghi",
      });
      expect(mockOpenMeetingUrl).toHaveBeenCalledWith("https://meet.google.com/abc-def-ghi");
      expect(result).toEqual({ ok: true, value: undefined });
    });

    it("returns err for invalid URL shape", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:open-external");

      const result = await handler(authorizedEvent, { url: "http://meet.google.com/abc" });
      expect(mockOpenMeetingUrl).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false });
    });

    it("returns err for non-string URL", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:open-external");

      const result = await handler(authorizedEvent, { url: 123 });
      expect(mockOpenMeetingUrl).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: "Invalid URL payload" });
    });

    it("returns Unauthorized for unauthorized sender", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:open-external");

      const result = await handler(unauthorizedEvent, {
        url: "https://meet.google.com/abc-def-ghi",
      });
      expect(mockOpenMeetingUrl).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: "Unauthorized" });
    });
  });

  describe("app:join-meeting", () => {
    it("rejects a forged sender even with an authorized frame URL", async () => {
      registerAppHandlers(appGraphForTest());
      const result = await getRegisteredHandler("app:join-meeting")(
        authorizedInvokeEvent("index"),
        { id: "evt-1", alert: { epoch: 1 } },
      );
      expect(result).toMatchObject({ ok: false });
      expect(mockJoinMeetingById).not.toHaveBeenCalled();
    });

    it("joins by event id for authorized sender", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:join-meeting");

      const result = await handler(authorizedEvent, { id: "evt-1" });
      expect(mockJoinMeetingById).toHaveBeenCalledWith("evt-1");
      expect(result).toEqual({ ok: true, value: undefined });
    });

    it("returns Unauthorized for unauthorized sender", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:join-meeting");

      const result = await handler(unauthorizedEvent, { id: "evt-1" });
      expect(mockJoinMeetingById).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: "Unauthorized" });
    });

    it("returns err for empty id", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:join-meeting");

      const result = await handler(authorizedEvent, { id: "  " });
      expect(mockJoinMeetingById).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false });
    });
  });

  describe("app:get-version", () => {
    it("returns version for authorized sender", async () => {
      mockApp.getVersion.mockReturnValue("1.6.1");
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:get-version");
      expect(await handler(authorizedEvent)).toBe("1.6.1");
    });

    it("returns empty string for unauthorized sender", async () => {
      registerAppHandlers(appGraphForTest());
      const handler = getRegisteredHandler("app:get-version");
      expect(await handler(unauthorizedEvent)).toBe("");
    });
  });
});
