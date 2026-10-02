import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock electron before importing alert-window — must use function keyword for constructor
vi.mock("electron", () => {
  const mockSend = vi.fn();
  const mockLoadURL = vi.fn().mockResolvedValue(undefined);
  const mockLoadFile = vi.fn().mockResolvedValue(undefined);
  const mockSetSize = vi.fn();
  const mockShow = vi.fn();
  const mockHide = vi.fn();
  const mockClose = vi.fn();
  const mockDestroy = vi.fn();
  const mockIsDestroyed = vi.fn(() => false);
  const mockIsVisible = vi.fn(() => true);
  const mockSetAlwaysOnTop = vi.fn();

  function MockBrowserWindow(this: Record<string, unknown>) {
    this.loadURL = mockLoadURL;
    this.loadFile = mockLoadFile;
    this.show = mockShow;
    this.hide = mockHide;
    this.close = mockClose;
    this.destroy = mockDestroy;
    this.setSize = mockSetSize;
    this.setAlwaysOnTop = mockSetAlwaysOnTop;
    this.setVisibleOnAllWorkspaces = vi.fn();
    this.isDestroyed = mockIsDestroyed;
    this.isVisible = mockIsVisible;
    this.webContents = {
      send: mockSend,
      executeJavaScript: vi.fn().mockResolvedValue(300),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    // Capture handlers without invoking — allows deferred firing for race condition tests
    this._onceHandlers = new Map<string, (...args: unknown[]) => void>();
    this._onHandlers = new Map<string, (...args: unknown[]) => void>();
    this.once = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      this._onceHandlers.set(event, cb);
    });
    this.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      this._onHandlers.set(event, cb);
    });
  }

  return {
    BrowserWindow: vi.fn(MockBrowserWindow),
    app: { isPackaged: false, getAppPath: vi.fn().mockReturnValue("/app") },
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: vi.fn() },
      },
    },
  };
});

let showAlertPresentation: typeof import("../../src/main/windows/alert-window.js").showAlert;
let destroyAlertWindow: typeof import("../../src/main/windows/alert-window.js").destroyAlertWindow;
let captureAlertPresentation: typeof import("../../src/main/windows/alert-window.js").captureAlertPresentation;
let handleAlertDismissal: typeof import("../../src/main/windows/alert-window.js").handleAlertDismissal;
import { BrowserWindow, app } from "electron";
import type { IsoUtc } from "../../src/domain/entities/brand.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import { createMockEvent } from "../helpers/test-utils.js";

function makeEvent(overrides: Partial<MeetingEvent> = {}): MeetingEvent {
  return createMockEvent({ id: "test-1", ...overrides });
}

function alertWireMatches(payload: object): unknown {
  return expect.objectContaining({
    epoch: expect.any(Number),
    payload: expect.objectContaining(payload),
  });
}

function showAlert(event: MeetingEvent, autoOpenAt?: IsoUtc): void {
  showAlertPresentation(
    event,
    () => undefined,
    autoOpenAt,
    () => true,
  );
}

/** Get the nth BrowserWindow instance created (1-indexed) */
function getWindow(n: number): Record<string, unknown> {
  return vi.mocked(BrowserWindow).mock.results[n - 1].value as Record<string, unknown>;
}

/** Fire a captured event handler on a mock window instance */
function fireEvent(win: Record<string, unknown>, eventName: string): void {
  if (eventName === "anonymous-close") {
    fireEvent(win, "close");
    return;
  }
  if (eventName === "dismiss") {
    const origin = captureAlertPresentation(win.webContents.As<import("electron").WebContents>(), {
      id: win.__alertUid.As<import("../../src/domain/entities/brand.js").EventId>(),
      epoch: win.__alertGeneration.As<number>(),
    });
    if (!origin) throw new Error("No current presentation to dismiss");
    handleAlertDismissal(origin, "begin", () => undefined);
    handleAlertDismissal(origin, "finish", () => undefined);
    return;
  }
  const onceHandlers = win._onceHandlers.As<Map<string, (...args: unknown[]) => void>>();
  const handler = onceHandlers.get(eventName);
  if (handler) {
    handler();
    onceHandlers.delete(eventName);
    return;
  }
  const onHandlers = win._onHandlers.As<Map<string, (...args: unknown[]) => void>>();
  const onHandler = onHandlers.get(eventName);
  if (onHandler) {
    if (eventName === "close") {
      onHandler({ preventDefault: vi.fn() });
    } else {
      onHandler();
    }
  }
}

describe("alert-window", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    delete process.env.VITE_DEV_SERVER_URL;
    const alertWindow = await import("../../src/main/windows/alert-window.js");
    showAlertPresentation = alertWindow.showAlert;
    destroyAlertWindow = alertWindow.destroyAlertWindow;
    captureAlertPresentation = alertWindow.captureAlertPresentation;
    handleAlertDismissal = alertWindow.handleAlertDismissal;
  });

  afterEach(() => {
    destroyAlertWindow();
    vi.useRealTimers();
  });

  describe("singleton behavior", () => {
    it("does not consume a presentation on anonymous native close", () => {
      const dismiss = vi.fn();
      showAlertPresentation(makeEvent(), dismiss, undefined, () => true);
      const win = getWindow(1);
      fireEvent(win, "anonymous-close");
      expect(dismiss).not.toHaveBeenCalled();
      expect(win.hide).not.toHaveBeenCalled();
    });

    it("creates a new BrowserWindow on first call", () => {
      showAlert(makeEvent());
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
    });

    it("force-destroys the window via destroyAlertWindow", () => {
      showAlert(makeEvent({ id: "force-destroy" }));
      const win = getWindow(1);
      destroyAlertWindow();
      expect(win.__forceDestroy).toBe(true);
      expect(win.destroy).toHaveBeenCalled();
      // Safe to call again when nothing is showing
      expect(() => destroyAlertWindow()).not.toThrow();
    });

    it("passes correct BrowserWindow options", () => {
      showAlert(makeEvent());

      const options = vi.mocked(BrowserWindow).mock.calls[0][0]!;
      expect(options.width).toBe(500);
      expect(options.height).toBe(480);
      expect(options.resizable).toBe(false);
      expect(options.alwaysOnTop).toBe(true);
      expect(options.show).toBe(false);
      expect(options.webPreferences!.sandbox).toBe(true);
      expect(options.webPreferences!.contextIsolation).toBe(true);
      expect(options.webPreferences!.nodeIntegration).toBe(false);
    });

    it("queues subsequent alerts instead of creating a new window immediately", () => {
      showAlert(makeEvent({ id: "first" }));
      showAlert(makeEvent({ id: "second" }));

      // New behavior: second alert is queued, only one window created until first closes
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
    });

    it("reuses the hidden window for the next alert after dismiss", async () => {
      showAlert(makeEvent({ id: "first" }));
      const win1 = getWindow(1);

      showAlert(makeEvent({ id: "second" }));
      // Second is queued, no new window yet
      expect(BrowserWindow).toHaveBeenCalledTimes(1);

      // User dismiss: close is prevented → hide → processNextAlert reuses win1
      fireEvent(win1, "dismiss");
      await vi.runAllTimersAsync();

      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(win1.hide).toHaveBeenCalled();
    });
  });

  describe("dev vs production loading", () => {
    it("loads from dev server URL when VITE_DEV_SERVER_URL is set", () => {
      process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";

      showAlert(makeEvent());

      const mockWin = getWindow(1);
      expect(mockWin.loadURL).toHaveBeenCalledWith(expect.stringContaining("/alert.html"));
    });

    it("loads from file in production (no env var)", () => {
      app.As<Record<string, unknown>>().isPackaged = true;
      showAlert(makeEvent());
      app.As<Record<string, unknown>>().isPackaged = false;

      const mockWin = getWindow(1);
      expect(mockWin.loadFile).toHaveBeenCalledWith(expect.stringContaining("alert.html"));
    });
  });

  describe("security", () => {
    it("always enables sandbox and context isolation", () => {
      showAlert(makeEvent());

      const options = vi.mocked(BrowserWindow).mock.calls[0][0]!;
      expect(options.webPreferences!.sandbox).toBe(true);
      expect(options.webPreferences!.contextIsolation).toBe(true);
      expect(options.webPreferences!.nodeIntegration).toBe(false);
    });
  });

  describe("race condition guards", () => {
    it("sends ALERT_SHOW via webContents when ready-to-show fires", () => {
      const mockSend = vi.fn();

      showAlert({ ...makeEvent(), id: "rc-1" });
      const win = getWindow(1);
      (win.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;

      fireEvent(win, "ready-to-show");

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "rc-1" }));
    });

    it("sends correct AlertPayload for event without meetUrl", () => {
      const mockSend = vi.fn();

      showAlert(makeEvent({ id: "no-url-event", meetUrl: undefined }));
      const win = getWindow(1);
      (win.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;

      fireEvent(win, "ready-to-show");

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "no-url-event" }));
      // Verify the payload does NOT include meetUrl (AlertPayload intentionally excludes it)
      const callArg = mockSend.mock.calls[0][1].payload;
      expect(callArg).not.toHaveProperty("meetUrl");
    });

    it("does not crash when ready-to-show fires after window is destroyed", () => {
      const mockIsDestroyed = vi.fn(() => false);

      showAlert(makeEvent({ id: "destroyed-test" }));
      const win = getWindow(1);
      win.isDestroyed = mockIsDestroyed;

      // Window gets destroyed between registration and ready-to-show firing
      mockIsDestroyed.mockReturnValue(true);
      fireEvent(win, "ready-to-show");

      // webContents.send should NOT be called — guard bailed out
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    });

    it("processes the queued alert by reusing the window after dismiss", async () => {
      const mockSend = vi.fn();

      // First alert — creates window A
      showAlert(makeEvent({ id: "race-a" }));
      const winA = getWindow(1);
      (winA.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;

      // Second alert — queued (no second BrowserWindow)
      showAlert(makeEvent({ id: "race-b" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(1);

      // Dismiss A — hide + reuse for B
      fireEvent(winA, "dismiss");
      await vi.runAllTimersAsync();

      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "race-b" }));
    });

    it("does not execute JavaScript when window is destroyed before ready-to-show fires", () => {
      const mockExecuteJS = vi.fn().mockResolvedValue(300);

      showAlert(makeEvent({ id: "destroyed-before-ready" }));
      const win = getWindow(1);
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        mockExecuteJS;

      // Window gets destroyed before ready-to-show fires
      win.isDestroyed = vi.fn(() => true);
      fireEvent(win, "ready-to-show");

      // executeJavaScript should NOT be called — guard bailed out
      expect(mockExecuteJS).not.toHaveBeenCalled();
    });

    it("shows window after successful height measurement", async () => {
      const mockShow = vi.fn();
      const mockSetSize = vi.fn();
      const mockExecuteJS = vi.fn().mockResolvedValue(350);

      showAlert(makeEvent({ id: "height-test" }));
      const win = getWindow(1);
      win.show = mockShow;
      win.setSize = mockSetSize;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        mockExecuteJS;

      fireEvent(win, "ready-to-show");

      // Advance past the 150ms setTimeout
      vi.advanceTimersByTime(150);

      // Flush the executeJavaScript promise
      await vi.runAllTimersAsync();

      // Height 350 should be clamped as-is (between 280 and 480)
      expect(mockSetSize).toHaveBeenCalledWith(500, 350, false);
      expect(mockShow).toHaveBeenCalled();
    });

    it("clamps height to MIN_HEIGHT when content is too small", async () => {
      const mockSetSize = vi.fn();
      const mockExecuteJS = vi.fn().mockResolvedValue(100);

      showAlert(makeEvent({ id: "min-height" }));
      const win = getWindow(1);
      win.setSize = mockSetSize;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        mockExecuteJS;

      fireEvent(win, "ready-to-show");
      vi.advanceTimersByTime(150);
      await vi.runAllTimersAsync();

      // 100 < 280 -> clamped to 280
      expect(mockSetSize).toHaveBeenCalledWith(500, 280, false);
    });

    it("clamps height to MAX_HEIGHT when content is too tall", async () => {
      const mockSetSize = vi.fn();
      const mockExecuteJS = vi.fn().mockResolvedValue(600);

      showAlert(makeEvent({ id: "max-height" }));
      const win = getWindow(1);
      win.setSize = mockSetSize;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        mockExecuteJS;

      fireEvent(win, "ready-to-show");
      vi.advanceTimersByTime(150);
      await vi.runAllTimersAsync();

      // 600 > 480 -> clamped to 480
      expect(mockSetSize).toHaveBeenCalledWith(500, 480, false);
    });

    it("shows window in catch when executeJavaScript rejects", async () => {
      const mockShow = vi.fn();
      const mockExecuteJS = vi.fn().mockRejectedValue(new Error("JS error"));

      showAlert(makeEvent({ id: "js-error" }));
      const win = getWindow(1);
      win.show = mockShow;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        mockExecuteJS;

      fireEvent(win, "ready-to-show");
      vi.advanceTimersByTime(150);
      await vi.runAllTimersAsync();

      expect(mockShow).toHaveBeenCalled();
    });

    it("does not show window in catch when window is destroyed", async () => {
      const mockShow = vi.fn();
      const mockExecuteJS = vi.fn().mockRejectedValue(new Error("JS error"));

      showAlert(makeEvent({ id: "catch-destroyed" }));
      const win = getWindow(1);
      win.show = mockShow;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        mockExecuteJS;

      fireEvent(win, "ready-to-show");
      vi.advanceTimersByTime(150);

      // Destroy before promise settles
      win.isDestroyed = vi.fn(() => true);
      await vi.runAllTimersAsync();

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("nulls alertWindow when current window fires closed (true destroy)", () => {
      showAlert(makeEvent({ id: "close-current" }));
      const win = getWindow(1);

      // Real destroy path (e.g. force-destroy) — closed fires and nulls the ref
      fireEvent(win, "closed");

      // Create another alert — should create a new window (not reuse the nulled one)
      showAlert(makeEvent({ id: "after-close" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
    });
  });

  describe("reschedule handling", () => {
    it("reuses the same window when same UID has different startMs", async () => {
      const oldStart = "2026-05-11T10:00:00Z";
      showAlert(makeEvent({ id: "resched", startDate: oldStart }));
      const win1 = getWindow(1);
      win1.__alertStartMs = new Date(oldStart).getTime();
      const mockSend = vi.fn();
      (win1.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;
      const newStart = "2026-05-11T14:00:00Z";
      showAlert(makeEvent({ id: "resched", startDate: newStart }));
      // In-place reuse — no second BrowserWindow, no close/destroy
      expect(win1.close).not.toHaveBeenCalled();
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      expect(mockSend).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "resched", startDate: newStart }),
      );
    });
    it("replaces queued entry when same UID with different startMs arrives", async () => {
      showAlert(makeEvent({ id: "blocker" }));
      showAlert(makeEvent({ id: "queued", startDate: "2026-05-11T10:00:00Z" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      showAlert(makeEvent({ id: "queued", startDate: "2026-05-11T14:00:00Z" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      const win1 = getWindow(1);
      const mockSend = vi.fn();
      (win1.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;
      fireEvent(win1, "dismiss");
      await vi.runAllTimersAsync();
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "queued", startDate: "2026-05-11T14:00:00Z" }),
      );
    });
    it("still coalesces when same UID and same startMs are already showing", () => {
      const event = makeEvent({ id: "same", startDate: "2026-05-11T09:00:00Z" });
      showAlert(event);
      const win1 = getWindow(1);
      win1.__alertStartMs = new Date("2026-05-11T09:00:00Z").getTime();
      showAlert(event);
      expect(win1.close).not.toHaveBeenCalled();
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
    });
    it("does not crash when old window is already destroyed on reschedule", () => {
      showAlert(makeEvent({ id: "dstr", startDate: "2026-05-11T10:00:00Z" }));
      const win1 = getWindow(1);
      win1.__alertStartMs = new Date("2026-05-11T10:00:00Z").getTime();
      win1.isDestroyed = vi.fn(() => true);
      expect(() =>
        showAlert(makeEvent({ id: "dstr", startDate: "2026-05-11T14:00:00Z" })),
      ).not.toThrow();
    });

    describe("close-handler cancels pending browser-open", () => {
      it("cancels pending browser-open when user dismisses alert", () => {
        const onDismiss = vi.fn();
        showAlertPresentation(makeEvent({ id: "dismiss-me" }), onDismiss, undefined, () => true);
        const win = getWindow(1);
        fireEvent(win, "dismiss");
        expect(onDismiss).toHaveBeenCalledTimes(1);
      });

      it("does NOT cancel browser-open when reschedule reuses the window", () => {
        const firstDismiss = vi.fn();
        const rescheduledDismiss = vi.fn();
        showAlertPresentation(
          makeEvent({ id: "resched", startDate: "2026-05-11T10:00:00Z" }),
          firstDismiss,
          undefined,
          () => true,
        );
        const win1 = getWindow(1);
        win1.__alertStartMs = new Date("2026-05-11T10:00:00Z").getTime();
        showAlertPresentation(
          makeEvent({ id: "resched", startDate: "2026-05-11T14:00:00Z" }),
          rescheduledDismiss,
          undefined,
          () => true,
        );
        // No close path — reuse only
        expect(firstDismiss).not.toHaveBeenCalled();
        expect(rescheduledDismiss).not.toHaveBeenCalled();
        expect(win1.close).not.toHaveBeenCalled();
      });

      it("does NOT cancel browser-open on force destroy", () => {
        const onDismiss = vi.fn();
        showAlertPresentation(
          makeEvent({ id: "force-no-cancel" }),
          onDismiss,
          undefined,
          () => true,
        );
        destroyAlertWindow();
        expect(onDismiss).not.toHaveBeenCalled();
      });

      it("keeps the owning dismiss handler for each queued presentation", async () => {
        const firstDismiss = vi.fn();
        const secondDismiss = vi.fn();
        showAlertPresentation(
          makeEvent({ id: "owner-first" }),
          firstDismiss,
          undefined,
          () => true,
        );
        const win = getWindow(1);
        showAlertPresentation(
          makeEvent({ id: "owner-second" }),
          secondDismiss,
          undefined,
          () => true,
        );

        fireEvent(win, "dismiss");
        expect(firstDismiss).toHaveBeenCalledTimes(1);
        expect(secondDismiss).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();
        fireEvent(win, "dismiss");
        expect(firstDismiss).toHaveBeenCalledTimes(1);
        expect(secondDismiss).toHaveBeenCalledTimes(1);
      });

      it("uses the replacement presentation handler after reschedule", () => {
        const firstDismiss = vi.fn();
        const replacementDismiss = vi.fn();
        const firstStart = "2026-05-11T10:00:00Z";
        showAlertPresentation(
          makeEvent({ id: "replacement-owner", startDate: firstStart }),
          firstDismiss,
          undefined,
          () => true,
        );
        const win = getWindow(1);
        win.__alertStartMs = new Date(firstStart).getTime();

        showAlertPresentation(
          makeEvent({ id: "replacement-owner", startDate: "2026-05-11T14:00:00Z" }),
          replacementDismiss,
          undefined,
          () => true,
        );
        fireEvent(win, "dismiss");

        expect(firstDismiss).not.toHaveBeenCalled();
        expect(replacementDismiss).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("generation-safe queue handoff", () => {
    it("installs a frozen replacement origin before its DOM promise settles", () => {
      const first = makeEvent({ id: "repeat", startDate: "2026-05-11T10:00:00Z" });
      const oldDismiss = vi.fn();
      const newDismiss = vi.fn();
      const cancel = vi.fn();
      showAlertPresentation(first, oldDismiss, undefined, () => true);
      const win = getWindow(1);
      const sender = win.webContents.As<import("electron").WebContents>();
      const old = captureAlertPresentation(sender, {
        id: first.id,
        epoch: win.__alertGeneration.As<number>(),
      });
      if (!old) throw new Error("Missing origin");
      handleAlertDismissal(old, "begin", cancel);
      sender.executeJavaScript = vi.fn(() => new Promise(() => undefined));
      showAlertPresentation(
        makeEvent({ id: "repeat", startDate: "2026-05-11T11:00:00Z" }),
        newDismiss,
        undefined,
        () => true,
      );
      const current = captureAlertPresentation(sender, {
        id: first.id,
        epoch: win.__alertGeneration.As<number>(),
      });
      expect(Object.isFrozen(current)).toBe(true);
      expect(current?.epoch).toBeGreaterThan(old.epoch);
      handleAlertDismissal(old, "finish", cancel);
      expect(oldDismiss).not.toHaveBeenCalled();
      expect(newDismiss).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(captureAlertPresentation(sender, { id: first.id, epoch: old.epoch })).toBeNull();
    });

    it("invalidates the finished origin before its dismissal callback reenters", () => {
      const first = makeEvent({ id: "reenter" });
      const next = makeEvent({ id: "reentered" });
      const callback = vi.fn(() => showAlert(next));
      showAlertPresentation(first, callback, undefined, () => true);
      const win = getWindow(1);
      const sender = win.webContents.As<import("electron").WebContents>();
      const origin = captureAlertPresentation(sender, {
        id: first.id,
        epoch: win.__alertGeneration.As<number>(),
      });
      if (!origin) throw new Error("Missing origin");
      const cancel = vi.fn();
      handleAlertDismissal(origin, "begin", cancel);
      handleAlertDismissal(origin, "finish", cancel);
      handleAlertDismissal(origin, "finish", cancel);
      expect(callback).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        captureAlertPresentation(sender, {
          id: next.id,
          epoch: win.__alertGeneration.As<number>(),
        }),
      ).not.toBeNull();
    });

    it("does not create a window when destroy runs before the queued immediate", async () => {
      showAlert(makeEvent({ id: "gen-a" }));
      showAlert(makeEvent({ id: "gen-b" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(1);

      const winA = getWindow(1);
      fireEvent(winA, "dismiss");
      // Slot reserved for B; destroy before setImmediate runs.
      destroyAlertWindow();
      await vi.runAllTimersAsync();

      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      // Starting fresh after destroy is allowed.
      showAlert(makeEvent({ id: "gen-c-after" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
    });

    it("keeps exactly one reserved queued owner when C arrives while B is pending", async () => {
      showAlert(makeEvent({ id: "own-a" }));
      const win = getWindow(1);
      const mockSend = vi.fn();
      (win.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;

      showAlert(makeEvent({ id: "own-b" }));
      fireEvent(win, "dismiss");
      // B reserved via immediate; C queues behind without creating a window.
      showAlert(makeEvent({ id: "own-c" }));
      expect(BrowserWindow).toHaveBeenCalledTimes(1);

      await vi.runAllTimersAsync();
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "own-b" }));

      // Dismiss B → C
      mockSend.mockClear();
      fireEvent(win, "dismiss");
      await vi.runAllTimersAsync();
      expect(mockSend).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "own-c" }));
    });

    it("ignores stale height resolution after a newer generation owns the window", async () => {
      let resolveHeightA: (v: number) => void = () => undefined;
      const heightA = new Promise<number>((resolve) => {
        resolveHeightA = resolve;
      });

      const startA = "2026-05-11T10:00:00Z";
      showAlert(makeEvent({ id: "stale-gen", startDate: startA }));
      const win = getWindow(1);
      win.__alertStartMs = new Date(startA).getTime();
      const mockShow = vi.fn();
      const mockSetSize = vi.fn();
      const mockSend = vi.fn();
      win.show = mockShow;
      win.setSize = mockSetSize;
      (win.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;

      let call = 0;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        vi.fn(() => {
          call += 1;
          // First present (A): deferred height. Clear-DOM / B height resolve immediately.
          if (call === 1) return heightA;
          return Promise.resolve(320);
        });

      fireEvent(win, "ready-to-show");
      // A is measuring; same-uid reschedule replaces in-place (new generation).
      showAlert(makeEvent({ id: "stale-gen", startDate: "2026-05-11T14:00:00Z" }));
      await vi.runAllTimersAsync();

      mockShow.mockClear();
      mockSetSize.mockClear();
      // Stale A height must not resize/show after B owns the generation.
      resolveHeightA(350);
      await vi.runAllTimersAsync();
      expect(mockSetSize).not.toHaveBeenCalledWith(500, 350, false);
    });

    it("ignores stale rejection fallback after generation advances", async () => {
      let rejectHeight: (e: Error) => void = () => undefined;
      const heightP = new Promise<number>((_resolve, reject) => {
        rejectHeight = reject;
      });

      showAlert(makeEvent({ id: "rej-a" }));
      const win = getWindow(1);
      const mockShow = vi.fn();
      win.show = mockShow;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript =
        vi.fn(() => heightP);

      fireEvent(win, "ready-to-show");
      destroyAlertWindow();
      rejectHeight(new Error("stale"));
      await vi.runAllTimersAsync();

      expect(mockShow).not.toHaveBeenCalled();
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
    });

    it("reschedule during reserved immediate does not clear isAlertShowing or drop queue", async () => {
      const startA = "2026-05-11T10:00:00Z";
      const startA2 = "2026-05-11T11:00:00Z";
      showAlert(makeEvent({ id: "race-a", startDate: startA }));
      const win = getWindow(1);
      win.__alertStartMs = new Date(startA).getTime();
      win.__alertUid = "race-a";
      const mockSend = vi.fn();
      (win.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;

      showAlert(makeEvent({ id: "race-b", startDate: "2026-05-11T12:00:00Z" }));
      // Dismiss A → reserve immediate for B.
      fireEvent(win, "dismiss");
      // Concurrent same-uid reschedule while B is reserved (bumps generation).
      showAlert(makeEvent({ id: "race-a", startDate: startA2 }));
      await vi.runAllTimersAsync();

      // Reschedule presentation must still be considered showing (no false free slot).
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
      // B remains queued; dismiss rescheduled A to drain B.
      mockSend.mockClear();
      fireEvent(win, "dismiss");
      await vi.runAllTimersAsync();
      expect(mockSend).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "race-b" }));
    });

    it("preserves autoOpenAt for queued alerts", async () => {
      const { asTestIsoUtc } = await import("../helpers/test-utils.js");
      const autoOpenAt = asTestIsoUtc("2026-05-11T10:05:00.000Z");
      showAlert(makeEvent({ id: "first" }));
      showAlert(makeEvent({ id: "second" }), autoOpenAt);
      const win = getWindow(1);
      const mockSend = vi.fn();
      (win.webContents as { send: ReturnType<typeof vi.fn> }).send = mockSend;
      fireEvent(win, "dismiss");
      await vi.runAllTimersAsync();
      expect(mockSend).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "second", autoOpenAt }),
      );
    });

    it("ignores stale close/closed after a newer window is current", async () => {
      const dismissA = vi.fn();
      const dismissB = vi.fn();
      showAlertPresentation(makeEvent({ id: "close-a" }), dismissA, undefined, () => true);
      const winA = getWindow(1);
      // True destroy path leaves A without being the current ref.
      fireEvent(winA, "closed");

      showAlertPresentation(makeEvent({ id: "close-b" }), dismissB, undefined, () => true);
      const winB = getWindow(2);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);

      // Stale A close must not cancel browser-open for B.
      fireEvent(winA, "close");
      expect(dismissA).not.toHaveBeenCalled();
      expect(dismissB).not.toHaveBeenCalled();

      // Current B dismiss still cancels once.
      fireEvent(winB, "dismiss");
      expect(dismissB).toHaveBeenCalledTimes(1);
    });
  });

  describe("presentation eligibility", () => {
    it("does not treat an obsolete ready callback as readiness for a later same-start owner", async () => {
      let firstEligible = true;
      let secondEligible = true;
      const event = makeEvent({ id: "same-ready-chain", startDate: "2026-05-11T10:00:00Z" });
      showAlertPresentation({ ...event, title: "first" }, vi.fn(), undefined, () => firstEligible);
      const win = getWindow(1);
      const readyHandlers = win._onceHandlers.As<Map<string, () => void>>();
      const firstReady = readyHandlers.get("ready-to-show")!;
      firstEligible = false;
      showAlertPresentation(
        { ...event, title: "second" },
        vi.fn(),
        undefined,
        () => secondEligible,
      );
      firstReady();
      secondEligible = false;
      showAlertPresentation({ ...event, title: "third" }, vi.fn(), undefined, () => true);

      const send = (win.webContents as { send: ReturnType<typeof vi.fn> }).send;
      await vi.runAllTimersAsync();
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ title: "third" }));
      fireEvent(win, "ready-to-show");
      await vi.runAllTimersAsync();
      expect(send).toHaveBeenCalledWith("alert:show", alertWireMatches({ title: "third" }));
    });

    it("replaces a revoked same-start owner before ready without replaying its callback", async () => {
      let oldEligible = true;
      const oldDismiss = vi.fn();
      const newDismiss = vi.fn();
      const startDate = "2026-05-11T10:00:00Z";
      showAlertPresentation(
        makeEvent({ id: "same-ready", startDate, title: "old" }),
        oldDismiss,
        undefined,
        () => oldEligible,
      );
      const win = getWindow(1);
      const send = (win.webContents as { send: ReturnType<typeof vi.fn> }).send;
      oldEligible = false;
      showAlertPresentation(
        makeEvent({ id: "same-ready", startDate, title: "new" }),
        newDismiss,
        undefined,
        () => true,
      );

      fireEvent(win, "ready-to-show");
      await vi.runAllTimersAsync();

      expect(send).toHaveBeenCalledWith("alert:show", alertWireMatches({ title: "new" }));
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ title: "old" }));
      fireEvent(win, "dismiss");
      expect(oldDismiss).not.toHaveBeenCalled();
      expect(newDismiss).toHaveBeenCalledOnce();
    });

    it("keeps a same-start successor reserved while an obsolete height promise settles", async () => {
      let oldEligible = true;
      let finishOldHeight: (height: number) => void = () => undefined;
      let finishNewHeight: (height: number) => void = () => undefined;
      const oldHeight = new Promise<number>((resolve) => {
        finishOldHeight = resolve;
      });
      const newHeight = new Promise<number>((resolve) => {
        finishNewHeight = resolve;
      });
      const oldDismiss = vi.fn();
      const newDismiss = vi.fn();
      const startDate = "2026-05-11T10:00:00Z";
      showAlertPresentation(
        makeEvent({ id: "same-height", startDate, title: "old" }),
        oldDismiss,
        undefined,
        () => oldEligible,
      );
      const win = getWindow(1);
      const send = (win.webContents as { send: ReturnType<typeof vi.fn> }).send;
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript = vi
        .fn()
        .mockReturnValueOnce(oldHeight)
        .mockResolvedValueOnce(true)
        .mockReturnValueOnce(newHeight)
        .mockResolvedValue(320);
      fireEvent(win, "ready-to-show");
      oldEligible = false;
      showAlertPresentation(
        makeEvent({ id: "same-height", startDate, title: "new" }),
        newDismiss,
        undefined,
        () => true,
      );
      await Promise.resolve();
      await Promise.resolve();
      showAlert(makeEvent({ id: "behind" }));

      finishOldHeight(320);
      await Promise.resolve();
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "behind" }));
      finishNewHeight(320);
      await vi.runAllTimersAsync();

      expect(send).toHaveBeenCalledWith("alert:show", alertWireMatches({ title: "new" }));
      expect(win.show).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "behind" }));
      fireEvent(win, "dismiss");
      expect(oldDismiss).not.toHaveBeenCalled();
      expect(newDismiss).toHaveBeenCalledOnce();
    });

    it("replaces a revoked same-start queued owner without changing FIFO position", async () => {
      let oldEligible = true;
      const oldDismiss = vi.fn();
      const newDismiss = vi.fn();
      const startDate = "2026-05-11T10:00:00Z";
      const autoOpenAt = (await import("../helpers/test-utils.js")).asTestIsoUtc(
        "2026-05-11T10:05:00.000Z",
      );
      showAlert(makeEvent({ id: "first" }));
      const win = getWindow(1);
      const send = (win.webContents as { send: ReturnType<typeof vi.fn> }).send;
      showAlertPresentation(
        makeEvent({ id: "queued-same", startDate, title: "old" }),
        oldDismiss,
        undefined,
        () => oldEligible,
      );
      showAlert(makeEvent({ id: "third" }));
      oldEligible = false;
      showAlertPresentation(
        makeEvent({ id: "queued-same", startDate, title: "new" }),
        newDismiss,
        autoOpenAt,
        () => true,
      );

      fireEvent(win, "dismiss");
      await vi.runAllTimersAsync();

      expect(send).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ title: "new", autoOpenAt }),
      );
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "third" }));
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ title: "old" }));
      fireEvent(win, "dismiss");
      expect(oldDismiss).not.toHaveBeenCalled();
      expect(newDismiss).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      expect(send).toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "third" }));
    });

    it("does not hide a visible same-start predecessor for an ineligible replacement", async () => {
      const oldDismiss = vi.fn();
      const newDismiss = vi.fn();
      const event = makeEvent({ id: "visible-same", startDate: "2026-05-11T10:00:00Z" });
      showAlertPresentation(event, oldDismiss, undefined, () => true);
      const win = getWindow(1);
      fireEvent(win, "ready-to-show");
      await vi.runAllTimersAsync();
      showAlertPresentation({ ...event, title: "ineligible" }, newDismiss, undefined, () => false);

      expect(win.hide).not.toHaveBeenCalled();
      fireEvent(win, "dismiss");
      expect(oldDismiss).toHaveBeenCalledOnce();
      expect(newDismiss).not.toHaveBeenCalled();
    });

    it("drains a hidden revoked same-start owner when its replacement is also ineligible", async () => {
      let oldEligible = true;
      const oldDismiss = vi.fn();
      const newDismiss = vi.fn();
      const event = makeEvent({ id: "hidden-same", startDate: "2026-05-11T10:00:00Z" });
      showAlertPresentation(event, oldDismiss, undefined, () => oldEligible);
      const win = getWindow(1);
      win.isVisible = vi.fn(() => false);
      const send = (win.webContents as { send: ReturnType<typeof vi.fn> }).send;
      showAlert(makeEvent({ id: "next-after-hidden" }));
      oldEligible = false;
      showAlertPresentation({ ...event, title: "ineligible" }, newDismiss, undefined, () => false);

      await vi.runAllTimersAsync();

      expect(send).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "next-after-hidden" }),
      );
      expect(send).not.toHaveBeenCalledWith("alert:show", alertWireMatches({ id: "hidden-same" }));
      expect(oldDismiss).not.toHaveBeenCalled();
      expect(newDismiss).not.toHaveBeenCalled();
    });

    it("consumes an ineligible alert before initial ready without dismissing it", async () => {
      let eligible = true;
      const dismiss = vi.fn();
      showAlertPresentation(makeEvent({ id: "early" }), dismiss, undefined, () => eligible);
      const win = getWindow(1);
      showAlert(makeEvent({ id: "next" }));
      eligible = false;

      fireEvent(win, "ready-to-show");
      await vi.runAllTimersAsync();

      expect(win.show).toHaveBeenCalledTimes(1);
      expect(dismiss).not.toHaveBeenCalled();
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "early" }),
      );
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "next" }),
      );
    });

    it("checks eligibility after a queued immediate before reusing the window", async () => {
      let eligible = true;
      showAlert(makeEvent({ id: "first" }));
      const win = getWindow(1);
      const dismiss = vi.fn();
      showAlertPresentation(makeEvent({ id: "second" }), dismiss, undefined, () => eligible);
      showAlert(makeEvent({ id: "third" }));
      fireEvent(win, "dismiss");
      eligible = false;

      await vi.runAllTimersAsync();

      expect(dismiss).not.toHaveBeenCalled();
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "second" }),
      );
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "third" }),
      );
    });

    it("consumes a reused alert when eligibility changes during DOM clear", async () => {
      let eligible = true;
      let finishClear: (value: boolean) => void = () => undefined;
      const clear = new Promise<boolean>((resolve) => {
        finishClear = resolve;
      });
      showAlert(makeEvent({ id: "first" }));
      const win = getWindow(1);
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript = vi
        .fn()
        .mockReturnValueOnce(clear)
        .mockResolvedValue(320);
      const dismiss = vi.fn();
      showAlertPresentation(makeEvent({ id: "clearing" }), dismiss, undefined, () => eligible);
      showAlert(makeEvent({ id: "last" }));
      fireEvent(win, "dismiss");
      await vi.advanceTimersToNextTimerAsync();
      eligible = false;

      finishClear(true);
      await vi.runAllTimersAsync();

      expect(dismiss).not.toHaveBeenCalled();
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "clearing" }),
      );
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "last" }),
      );
    });

    it.each(["resolve", "reject"])(
      "consumes an alert when eligibility changes before height %s",
      async (settlement) => {
        let eligible = true;
        let resolveHeight: (height: number) => void = () => undefined;
        let rejectHeight: (error: Error) => void = () => undefined;
        const height = new Promise<number>((resolve, reject) => {
          resolveHeight = resolve;
          rejectHeight = reject;
        });
        const dismiss = vi.fn();
        showAlertPresentation(
          makeEvent({ id: "height-owner" }),
          dismiss,
          undefined,
          () => eligible,
        );
        const win = getWindow(1);
        (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript = vi
          .fn()
          .mockReturnValueOnce(height)
          .mockResolvedValue(320);
        fireEvent(win, "ready-to-show");
        showAlert(makeEvent({ id: "height-next" }));
        eligible = false;

        if (settlement === "resolve") resolveHeight(350);
        else rejectHeight(new Error("height failed"));
        await vi.runAllTimersAsync();

        expect(win.show).toHaveBeenCalledTimes(1);
        expect(dismiss).not.toHaveBeenCalled();
        expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
          "alert:show",
          alertWireMatches({ id: "height-next" }),
        );
      },
    );

    it("drains ineligible B to eligible C while visible A retains its dismiss", async () => {
      let eligible = true;
      const dismissA = vi.fn();
      const dismissB = vi.fn();
      showAlertPresentation(makeEvent({ id: "visible-a" }), dismissA, undefined, () => eligible);
      const win = getWindow(1);
      fireEvent(win, "ready-to-show");
      await vi.runAllTimersAsync();
      showAlertPresentation(makeEvent({ id: "skipped-b" }), dismissB, undefined, () => eligible);
      showAlert(makeEvent({ id: "visible-c" }));
      eligible = false;
      expect(win.hide).not.toHaveBeenCalled();

      fireEvent(win, "dismiss");
      await vi.runAllTimersAsync();

      expect(dismissA).toHaveBeenCalledOnce();
      expect(dismissB).not.toHaveBeenCalled();
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "skipped-b" }),
      );
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "visible-c" }),
      );
    });

    it("does not hide a visible predecessor for an ineligible reschedule", async () => {
      let eligible = true;
      const originalDismiss = vi.fn();
      const replacementDismiss = vi.fn();
      showAlertPresentation(
        makeEvent({ id: "same", startDate: "2026-05-11T10:00:00Z" }),
        originalDismiss,
        undefined,
        () => true,
      );
      const win = getWindow(1);
      fireEvent(win, "ready-to-show");
      await vi.runAllTimersAsync();
      eligible = false;
      showAlertPresentation(
        makeEvent({ id: "same", startDate: "2026-05-11T11:00:00Z" }),
        replacementDismiss,
        undefined,
        () => eligible,
      );

      await vi.runAllTimersAsync();
      fireEvent(win, "dismiss");

      expect(win.hide).toHaveBeenCalledTimes(1);
      expect(originalDismiss).toHaveBeenCalledOnce();
      expect(replacementDismiss).not.toHaveBeenCalled();
    });

    it("does not let an obsolete height completion release a successor slot", async () => {
      let eligible = true;
      let resolveOld: (height: number) => void = () => undefined;
      let resolveNew: (height: number) => void = () => undefined;
      const oldHeight = new Promise<number>((resolve) => {
        resolveOld = resolve;
      });
      const newHeight = new Promise<number>((resolve) => {
        resolveNew = resolve;
      });
      showAlertPresentation(
        makeEvent({ id: "race", startDate: "2026-05-11T10:00:00Z" }),
        vi.fn(),
        undefined,
        () => eligible,
      );
      const win = getWindow(1);
      (win.webContents as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript = vi
        .fn()
        .mockReturnValueOnce(oldHeight)
        .mockResolvedValueOnce(true)
        .mockReturnValueOnce(newHeight);
      fireEvent(win, "ready-to-show");
      showAlertPresentation(
        makeEvent({ id: "race", startDate: "2026-05-11T11:00:00Z" }),
        vi.fn(),
        undefined,
        () => true,
      );
      await Promise.resolve();
      await Promise.resolve();
      showAlert(makeEvent({ id: "behind" }));
      eligible = false;

      resolveOld(320);
      await Promise.resolve();
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "behind" }),
      );
      resolveNew(320);
      await vi.runAllTimersAsync();
      expect((win.webContents as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalledWith(
        "alert:show",
        alertWireMatches({ id: "behind" }),
      );
    });
  });
});
