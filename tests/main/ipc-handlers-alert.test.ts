import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCancelPendingBrowserOpen = vi.fn();

import { registerAlertHandlers } from "../../src/main/ipc-handlers/alert.js";
import { ipcMain, BrowserWindow } from "electron";
import { asTestEventId, createMockEvent } from "../helpers/test-utils.js";
import { showAlert, destroyAlertWindow } from "../../src/main/windows/alert-window.js";
import { authorizedOnEvent } from "../helpers/ipc-sender.js";
import { testAppGraph } from "../helpers/app-graph.js";

const mockIpcMain = vi.mocked(ipcMain);

function alertGraph() {
  return testAppGraph({
    scheduler: { cancelPendingBrowserOpen: mockCancelPendingBrowserOpen },
  });
}

function getRegisteredHandler(channel: string) {
  const call = mockIpcMain.on.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

const unauthorizedHttpsEvent = {
  senderFrame: { url: "https://evil.com/" },
}.As<import("electron").IpcMainEvent>();

const unauthorizedHttpEvent = {
  senderFrame: { url: "http://malicious.example/" },
}.As<import("electron").IpcMainEvent>();

let authorizedEvent: import("electron").IpcMainEvent;
let win: BrowserWindow;
const onDismiss = vi.fn();

function dismissal(phase: "begin" | "finish" = "begin") {
  return { id: asTestEventId("evt-1"), epoch: win.__alertGeneration, phase };
}

describe("registerAlertHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    win = {
      webContents: {
        send: vi.fn(),
        isDestroyed: vi.fn(() => false),
        executeJavaScript: vi.fn().mockResolvedValue(300),
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      hide: vi.fn(),
      show: vi.fn(),
      destroy: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      setSize: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
    }.As<BrowserWindow>();
    vi.mocked(BrowserWindow)
      .mockReset()
      .mockImplementation(function () {
        return win;
      });
    authorizedEvent = { ...authorizedOnEvent("alert"), sender: win.webContents }.As<
      import("electron").IpcMainEvent
    >();
    showAlert(
      createMockEvent({ id: "evt-1", startDate: "2026-05-11T10:00:00Z" }),
      onDismiss,
      undefined,
      () => true,
    );
  });
  afterEach(() => destroyAlertWindow());

  it("registers exactly 1 fire-and-forget handler via ipcMain.on", () => {
    registerAlertHandlers(alertGraph());
    expect(mockIpcMain.on).toHaveBeenCalledTimes(1);
  });

  it("registers handler under the alert:dismissed channel", () => {
    registerAlertHandlers(alertGraph());
    expect(mockIpcMain.on).toHaveBeenCalledWith("alert:dismissed", expect.any(Function));
  });

  it("does not register via ipcMain.handle (fire-and-forget, not invoke)", () => {
    registerAlertHandlers(alertGraph());
    expect(mockIpcMain.handle).not.toHaveBeenCalled();
  });

  describe("alert:dismissed handler", () => {
    it("rejects an authorized URL without the owning webContents", () => {
      registerAlertHandlers(alertGraph());
      getRegisteredHandler("alert:dismissed")?.(authorizedOnEvent("alert"), {
        id: asTestEventId("evt-1"),
        epoch: 1,
        phase: "begin",
      });
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });
    it("calls cancelPendingBrowserOpen with the payload id when sender authorized", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");
      expect(handler).toBeDefined();

      const id = asTestEventId("evt-1");
      handler!(authorizedEvent, dismissal());

      expect(mockCancelPendingBrowserOpen).toHaveBeenCalledTimes(1);
      expect(mockCancelPendingBrowserOpen).toHaveBeenCalledWith(id);
    });

    it("cancels on begin once and consumes on finish once", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");
      const begin = dismissal();
      const finish = dismissal("finish");
      handler?.(authorizedEvent, begin);
      handler?.(authorizedEvent, begin);
      expect(mockCancelPendingBrowserOpen).toHaveBeenCalledOnce();
      expect(win.hide).not.toHaveBeenCalled();
      handler?.(authorizedEvent, finish);
      handler?.(authorizedEvent, finish);
      expect(win.hide).toHaveBeenCalledOnce();
      expect(onDismiss).toHaveBeenCalledOnce();
    });

    it("rejects stale begin and finish during a same-ID replacement DOM gap", () => {
      const old = dismissal();
      registerAlertHandlers(alertGraph());
      vi.mocked(win.webContents.executeJavaScript).mockReturnValueOnce(
        new Promise(() => undefined),
      );
      showAlert(
        createMockEvent({ id: "evt-1", startDate: "2026-05-11T11:00:00Z" }),
        onDismiss,
        undefined,
        () => true,
      );
      const handler = getRegisteredHandler("alert:dismissed");
      handler?.(authorizedEvent, old);
      handler?.(authorizedEvent, { ...old, phase: "finish" });
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      expect(win.hide).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it.each([
      { epoch: 0 },
      { epoch: -1 },
      { epoch: 1.5 },
      { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { epoch: "1" },
      { phase: "unknown" },
      { id: "another-event" },
    ])("rejects malformed or mismatched correlation %j", (override) => {
      registerAlertHandlers(alertGraph());
      getRegisteredHandler("alert:dismissed")?.(authorizedEvent, { ...dismissal(), ...override });
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      expect(win.hide).not.toHaveBeenCalled();
    });

    it("rejects finish without correlated begin", () => {
      registerAlertHandlers(alertGraph());
      getRegisteredHandler("alert:dismissed")?.(authorizedEvent, dismissal("finish"));
      expect(win.hide).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("rejects a mismatched webContents with an authorized frame", () => {
      registerAlertHandlers(alertGraph());
      const sender = { isDestroyed: vi.fn(() => false) };
      getRegisteredHandler("alert:dismissed")?.({ ...authorizedEvent, sender }, dismissal());
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    it("rejects a destroyed owning window", () => {
      registerAlertHandlers(alertGraph());
      vi.mocked(win.isDestroyed).mockReturnValue(true);
      getRegisteredHandler("alert:dismissed")?.(authorizedEvent, dismissal());
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    it("invalidates a begun dismissal on destruction without callback", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");
      const finish = dismissal("finish");
      handler?.(authorizedEvent, dismissal());
      destroyAlertWindow();
      handler?.(authorizedEvent, finish);
      expect(mockCancelPendingBrowserOpen).toHaveBeenCalledOnce();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(win.hide).not.toHaveBeenCalled();
    });

    it("rejects unauthorized https:// sender — cancel not invoked", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");

      const id = asTestEventId("evt-1");
      handler!(unauthorizedHttpsEvent, { id });

      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    it("rejects unauthorized http:// sender — cancel not invoked", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");

      const id = asTestEventId("evt-1");
      handler!(unauthorizedHttpEvent, { id });

      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    it("rejects file:// from outside lib/renderer/", () => {
      const badFileEvent = {
        senderFrame: { url: "file:///etc/passwd" },
      }.As<import("electron").IpcMainEvent>();

      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");

      handler!(badFileEvent, { id: asTestEventId("evt-1") });
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    describe("malformed payload (runtime validation at IPC boundary)", () => {
      it("ignores undefined payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, undefined)).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores null payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, null)).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores empty object payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, {})).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores payload with numeric id — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, { id: 123 })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores payload with empty-string id — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, { id: "" })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores payload with whitespace-only id — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, { id: "   " })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores unauthorized sender with malformed payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(unauthorizedHttpsEvent, undefined)).not.toThrow();
        expect(() => handler!(unauthorizedHttpsEvent, { id: 123 })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });
    });
  });
});
