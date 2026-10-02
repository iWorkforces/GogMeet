import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerAppHandlers } from "../../src/main/ipc-handlers/app.js";
import { registerAlertHandlers } from "../../src/main/ipc-handlers/alert.js";
import { ipcMain, app, BrowserWindow } from "electron";
import { showAlert, destroyAlertWindow } from "../../src/main/windows/alert-window.js";
import { createMockEvent } from "../helpers/test-utils.js";
import { authorizedInvokeEvent, authorizedOnEvent } from "../helpers/ipc-sender.js";
import { testAppGraph } from "../helpers/app-graph.js";

const mockOpenMeetingUrl = vi.fn();
const mockJoinMeetingById = vi.fn();
const cancel = vi.fn();

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
let win: BrowserWindow;
const onDismiss = vi.fn();

function alertRequest(epoch = win.__alertGeneration) {
  return { id: "evt-1", alert: { epoch } };
}

function alertEvent() {
  return { ...authorizedInvokeEvent("alert"), sender: win.webContents }.As<
    import("electron").IpcMainInvokeEvent
  >();
}

function finishAlert(request = alertRequest(), phase: "begin" | "finish" = "finish") {
  const handler = mockIpcMain.on.mock.calls.find((call) => call[0] === "alert:dismissed")?.[1];
  if (!handler) throw new TypeError("Alert handler was not registered");
  handler(
    { ...authorizedOnEvent("alert"), sender: win.webContents }.As<
      import("electron").IpcMainEvent
    >(),
    { id: request.id, epoch: request.alert.epoch, phase },
  );
}

function appGraphForTest() {
  return testAppGraph({
    opener: { open: mockOpenMeetingUrl },
    join: { byId: mockJoinMeetingById },
    scheduler: { cancelPendingBrowserOpen: cancel },
  });
}

describe("registerAppHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.getVersion.mockReturnValue("1.0.0");
    mockOpenMeetingUrl.mockResolvedValue({ ok: true, value: undefined });
    mockJoinMeetingById.mockReset().mockResolvedValue({ ok: true, value: undefined });
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
    BrowserWindow.fromWebContents = vi.fn((sender) => (sender === win.webContents ? win : null));
    vi.mocked(BrowserWindow)
      .mockReset()
      .mockImplementation(function () {
        return win;
      });
    authorizedEvent = { ...authorizedInvokeEvent("index"), sender: win.webContents }.As<
      import("electron").IpcMainInvokeEvent
    >();
    onDismiss.mockClear();
  });
  afterEach(() => destroyAlertWindow());

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

    it("waits for animation finish after join success without explicit dismissal effects", async () => {
      // Given a current alert and its registered main handlers.
      showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
      registerAppHandlers(appGraphForTest());
      registerAlertHandlers(appGraphForTest());
      const request = alertRequest();
      // When the join succeeds, the animation still owns the visible presentation.
      await getRegisteredHandler("app:join-meeting")(alertEvent(), request);
      expect(win.hide).not.toHaveBeenCalled();
      finishAlert(request);
      finishAlert(request);
      // Then only the authorized finish hides, once, without dismissing.
      expect(win.hide).toHaveBeenCalledOnce();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it.each(["explicit", "joined"] as const)(
      "preserves %s ownership when join and dismiss overlap",
      async (first) => {
        // Given an alert with a pending join.
        const completion = Promise.withResolvers<{ ok: true; value: undefined }>();
        mockJoinMeetingById.mockReturnValueOnce(completion.promise);
        showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
        registerAppHandlers(appGraphForTest());
        registerAlertHandlers(appGraphForTest());
        const request = alertRequest();
        const pending = getRegisteredHandler("app:join-meeting")(alertEvent(), request);
        // When both completion reasons arrive in the chosen order.
        if (first === "explicit") finishAlert(request, "begin");
        completion.resolve({ ok: true, value: undefined });
        await pending;
        finishAlert(request, "begin");
        expect(win.hide).not.toHaveBeenCalled();
        finishAlert(request);
        finishAlert(request);
        // Then the first accepted reason retains its effects.
        expect(win.hide).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledTimes(first === "explicit" ? 1 : 0);
        expect(onDismiss).toHaveBeenCalledTimes(first === "explicit" ? 1 : 0);
      },
    );

    it.each([true, false])(
      "does not close a same-ID replacement when an earlier join settles ok=%s",
      async (success) => {
        let settle: (
          value: { ok: true; value: undefined } | { ok: false; error: string },
        ) => void = () => undefined;
        mockJoinMeetingById.mockReturnValueOnce(
          new Promise((resolve) => {
            settle = resolve;
          }),
        );
        showAlert(
          createMockEvent({ id: "evt-1", startDate: "2026-05-11T10:00:00Z" }),
          onDismiss,
          undefined,
          () => true,
        );
        registerAppHandlers(appGraphForTest());
        registerAlertHandlers(appGraphForTest());
        const oldRequest = alertRequest();
        const pending = getRegisteredHandler("app:join-meeting")(alertEvent(), alertRequest());
        showAlert(
          createMockEvent({ id: "evt-1", startDate: "2026-05-11T11:00:00Z" }),
          onDismiss,
          undefined,
          () => true,
        );
        settle(success ? { ok: true, value: undefined } : { ok: false, error: "open failed" });
        await pending;
        finishAlert(oldRequest);
        finishAlert();
        expect(win.hide).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(mockJoinMeetingById).toHaveBeenCalledWith("evt-1");
      },
    );

    it.each(["replacement", "destruction"] as const)(
      "clears joined completion authorization after %s",
      async (reset) => {
        // Given a successfully joined origin awaiting its animation finish.
        showAlert(
          createMockEvent({ id: "evt-1", startDate: "2026-05-11T10:00:00Z" }),
          onDismiss,
          undefined,
          () => true,
        );
        registerAppHandlers(appGraphForTest());
        registerAlertHandlers(appGraphForTest());
        const oldRequest = alertRequest();
        await getRegisteredHandler("app:join-meeting")(alertEvent(), oldRequest);
        // When a fresh same-ID origin replaces the authorized one.
        if (reset === "destruction") destroyAlertWindow();
        showAlert(
          createMockEvent({ id: "evt-1", startDate: "2026-05-11T11:00:00Z" }),
          onDismiss,
          undefined,
          () => true,
        );
        finishAlert(oldRequest);
        finishAlert();
        // Then neither stale nor unsolicited current finish closes the replacement.
        expect(win.hide).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
      },
    );

    it("invalidates joined completion before hide can reenter finish", async () => {
      // Given an authorized joined origin and a reentrant hide effect.
      showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
      registerAppHandlers(appGraphForTest());
      registerAlertHandlers(appGraphForTest());
      const request = alertRequest();
      await getRegisteredHandler("app:join-meeting")(alertEvent(), request);
      vi.mocked(win.hide).mockImplementationOnce(() => finishAlert(request));
      // When animation completion hides the presentation.
      finishAlert(request);
      // Then reentrant completion is inert and dismissal effects stay absent.
      expect(win.hide).toHaveBeenCalledOnce();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it("runs ID join for a stale epoch delivered in the replacement pre-payload gap", async () => {
      showAlert(
        createMockEvent({ id: "evt-1", startDate: "2026-05-11T10:00:00Z" }),
        onDismiss,
        undefined,
        () => true,
      );
      const stale = alertRequest();
      vi.mocked(win.webContents.executeJavaScript).mockReturnValueOnce(
        new Promise(() => undefined),
      );
      showAlert(
        createMockEvent({ id: "evt-1", startDate: "2026-05-11T11:00:00Z" }),
        onDismiss,
        undefined,
        () => true,
      );
      registerAppHandlers(appGraphForTest());
      registerAlertHandlers(appGraphForTest());
      expect(await getRegisteredHandler("app:join-meeting")(alertEvent(), stale)).toMatchObject({
        ok: true,
      });
      finishAlert(stale);
      finishAlert();
      expect(mockJoinMeetingById).toHaveBeenCalledWith("evt-1");
      expect(win.hide).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it.each([
      undefined,
      null,
      {},
      { epoch: 0 },
      { epoch: 1.5 },
      { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { epoch: "1" },
    ])("rejects missing or malformed metadata from the cached alert sender: %j", async (alert) => {
      showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
      registerAppHandlers(appGraphForTest());
      expect(
        await getRegisteredHandler("app:join-meeting")(alertEvent(), { id: "evt-1", alert }),
      ).toMatchObject({ ok: false });
      expect(mockJoinMeetingById).not.toHaveBeenCalled();
    });

    it("rejects a destroyed owning sender", async () => {
      showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
      vi.mocked(win.webContents.isDestroyed).mockReturnValue(true);
      registerAppHandlers(appGraphForTest());
      expect(
        await getRegisteredHandler("app:join-meeting")(alertEvent(), alertRequest()),
      ).toMatchObject({ ok: false });
      expect(mockJoinMeetingById).not.toHaveBeenCalled();
    });

    it("does not close on current-origin join failure", async () => {
      showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
      mockJoinMeetingById.mockResolvedValueOnce({ ok: false, error: "open failed" });
      registerAppHandlers(appGraphForTest());
      registerAlertHandlers(appGraphForTest());
      expect(await getRegisteredHandler("app:join-meeting")(alertEvent(), alertRequest())).toEqual({
        ok: false,
        error: "open failed",
      });
      finishAlert();
      expect(win.hide).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("rejects metadata from a different live owning window", async () => {
      registerAppHandlers(appGraphForTest());
      expect(
        await getRegisteredHandler("app:join-meeting")(authorizedEvent, alertRequest(1)),
      ).toMatchObject({ ok: false });
      expect(mockJoinMeetingById).not.toHaveBeenCalled();
    });

    it("does not close or dismiss after destruction while a join is pending", async () => {
      let settle: (value: { ok: true; value: undefined }) => void = () => undefined;
      mockJoinMeetingById.mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      showAlert(createMockEvent({ id: "evt-1" }), onDismiss, undefined, () => true);
      registerAppHandlers(appGraphForTest());
      registerAlertHandlers(appGraphForTest());
      const request = alertRequest();
      const pending = getRegisteredHandler("app:join-meeting")(alertEvent(), alertRequest());
      destroyAlertWindow();
      settle({ ok: true, value: undefined });
      await pending;
      finishAlert(request);
      expect(win.hide).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
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
