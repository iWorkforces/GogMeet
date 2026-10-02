import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserWindow } from "electron";

const {
  mockGetSettings,
  mockUpdateSettings,
  mockRestartScheduler,
  mockForcePoll,
  mockSyncAutoLaunch,
  mockForceTrayMenuRefresh,
  mockGetSettingsWindow,
} = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
  mockRestartScheduler: vi.fn(),
  mockForcePoll: vi.fn(),
  mockSyncAutoLaunch: vi.fn(),
  mockForceTrayMenuRefresh: vi.fn(),
  mockGetSettingsWindow: vi.fn(),
}));

vi.mock("../../src/main/system/auto-launch.js", () => ({
  syncAutoLaunch: mockSyncAutoLaunch,
}));
vi.mock("../../src/main/tray.js", () => ({
  forceTrayMenuRefresh: mockForceTrayMenuRefresh,
}));
vi.mock("../../src/main/windows/settings-window.js", () => ({
  getSettingsWindow: (...args: unknown[]) => mockGetSettingsWindow(...args),
  destroySettingsWindow: vi.fn(),
  createSettingsWindow: vi.fn(),
}));

import { registerSettingsHandlers } from "../../src/main/ipc-handlers/settings.js";
import { app, ipcMain } from "electron";
import { authorizedInvokeEvent } from "../helpers/ipc-sender.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import { testAppGraph } from "../helpers/app-graph.js";
import { createJsonSettingsStore } from "../../src/main/infrastructure/settings/json-settings-store.js";

const mockIpcMain = vi.mocked(ipcMain);

function liveWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
  };
}

function setHandler(win: ReturnType<typeof liveWindow>, graph = settingsGraph()) {
  registerSettingsHandlers(win.As<BrowserWindow>(), graph);
  const handler = getRegisteredHandler("settings:set");
  if (!handler) throw new Error("SETTINGS_SET was not registered");
  return handler;
}

function settingsGraph() {
  return testAppGraph({
    settings: {
      get: mockGetSettings,
      update: mockUpdateSettings,
    },
    scheduler: {
      restart: mockRestartScheduler,
      forcePoll: mockForcePoll,
    },
  });
}

function getRegisteredHandler(channel: string) {
  const call = mockIpcMain.handle.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

const authorizedEvent = authorizedInvokeEvent("index").As<import("electron").IpcMainInvokeEvent>();

describe("registerSettingsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReset();
    mockUpdateSettings.mockReset();
    mockRestartScheduler.mockReset();
    mockForcePoll.mockReset();
    mockForcePoll.mockResolvedValue(undefined);
    mockSyncAutoLaunch.mockReset();
    mockForceTrayMenuRefresh.mockReset();
    mockGetSettingsWindow.mockReturnValue(null);
    mockGetSettings.mockReturnValue(DEFAULT_SETTINGS);
    mockUpdateSettings.mockResolvedValue(DEFAULT_SETTINGS);
  });

  afterEach(() => vi.restoreAllMocks());

  it("registers 2 handlers", () => {
    const mockWin = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
    }.As<import("electron").BrowserWindow>();

    registerSettingsHandlers(mockWin, settingsGraph());
    expect(mockIpcMain.handle).toHaveBeenCalledTimes(2);
  });

  describe("settings:get", () => {
    it("returns current settings for authorized sender", async () => {
      registerSettingsHandlers({}.As<import("electron").BrowserWindow>(), settingsGraph());
      const handler = getRegisteredHandler("settings:get");

      const result = await handler!(authorizedEvent);
      expect(result).toEqual(DEFAULT_SETTINGS);
    });

    it("returns fresh DEFAULT_SETTINGS without calling getSettings for unauthorized sender", async () => {
      registerSettingsHandlers({}.As<import("electron").BrowserWindow>(), settingsGraph());
      const handler = getRegisteredHandler("settings:get");

      const result = await handler!(
        {
          senderFrame: { url: "https://evil.com/" },
        }.As<import("electron").IpcMainInvokeEvent>(),
      );
      expect(mockGetSettings).not.toHaveBeenCalled();
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(result).not.toBe(DEFAULT_SETTINGS);
    });
  });

  describe("settings:set", () => {
    it("updates settings and restarts scheduler", async () => {
      const updated = { ...DEFAULT_SETTINGS, openBeforeMinutes: 3 };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(authorizedEvent, { openBeforeMinutes: 3 });
      expect(mockUpdateSettings).toHaveBeenCalledWith({ openBeforeMinutes: 3 });
      expect(mockRestartScheduler).toHaveBeenCalledOnce();
      expect(result).toEqual(updated);
    });

    it("syncs auto-launch when launchAtLogin changes", async () => {
      const updated = { ...DEFAULT_SETTINGS, launchAtLogin: true };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { launchAtLogin: true });
      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
    });

    it("does not sync auto-launch when launchAtLogin not changed", async () => {
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { openBeforeMinutes: 2 });
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
    });

    it("sends settings:changed via webContents for display-affecting changes", async () => {
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      const updated = { ...DEFAULT_SETTINGS, showTomorrowMeetings: false };
      mockUpdateSettings.mockResolvedValue(updated);

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { showTomorrowMeetings: false });
      expect(mockWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
    });

    it("fans out settings:changed to a distinct hide-cached Settings window", async () => {
      const popoverWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      const settingsWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      };
      mockGetSettingsWindow.mockReturnValue(settingsWin);
      const updated = { ...DEFAULT_SETTINGS, openBeforeMinutes: 5 };
      mockUpdateSettings.mockResolvedValue(updated);

      registerSettingsHandlers(popoverWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");
      await handler!(authorizedEvent, { openBeforeMinutes: 5 });

      expect(popoverWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
      expect(settingsWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
    });

    it("skips settings fan-out when settings webContents is destroyed", async () => {
      const popoverWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      mockGetSettingsWindow.mockReturnValue({
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => true) },
      });
      mockUpdateSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
      registerSettingsHandlers(popoverWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");
      await handler!(authorizedEvent, { openBeforeMinutes: 1 });
      expect(popoverWin.webContents.send).toHaveBeenCalled();
    });

    it("returns fresh DEFAULT_SETTINGS and performs no side effects for unauthorized sender", async () => {
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(
        {
          senderFrame: { url: "https://evil.com/" },
        }.As<import("electron").IpcMainInvokeEvent>(),
        { openBeforeMinutes: 2 },
      );
      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(mockGetSettings).not.toHaveBeenCalled();
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(result).not.toBe(DEFAULT_SETTINGS);
    });

    it("does not restart scheduler when only launchAtLogin changes", async () => {
      const updated = { ...DEFAULT_SETTINGS, launchAtLogin: true };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { launchAtLogin: true });
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
      expect(mockWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
    });

    it("force-polls (no restart) when only showTomorrowMeetings changes", async () => {
      const updated = { ...DEFAULT_SETTINGS, showTomorrowMeetings: false };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { showTomorrowMeetings: false });
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockForcePoll).toHaveBeenCalledOnce();
    });

    it("persists and broadcasts showCompletedTodayMeetings without scheduler work", async () => {
      const updated = { ...DEFAULT_SETTINGS, showCompletedTodayMeetings: true };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(authorizedEvent, { showCompletedTodayMeetings: true });
      expect(mockUpdateSettings).toHaveBeenCalledWith({ showCompletedTodayMeetings: true });
      expect(result).toEqual(updated);
      expect(mockWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
      expect(mockWin.webContents.send).toHaveBeenCalledTimes(1);
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockForcePoll).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
      // Tray is the primary meeting list UI — rebuild immediately so history appears.
      expect(mockForceTrayMenuRefresh).toHaveBeenCalledOnce();
    });

    it("rejects when update throws without effects or pushes", async () => {
      mockUpdateSettings.mockRejectedValue(new Error("disk full"));
      mockGetSettings.mockReturnValue(DEFAULT_SETTINGS);
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await expect(
        handler!(authorizedEvent, {
          openBeforeMinutes: 3,
          showTomorrowMeetings: false,
          showCompletedTodayMeetings: true,
          launchAtLogin: true,
        }),
      ).rejects.toThrow("disk full");
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(mockForceTrayMenuRefresh).not.toHaveBeenCalled();
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockForcePoll).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
      expect(mockGetSettingsWindow).not.toHaveBeenCalled();
      expect(mockGetSettings).not.toHaveBeenCalled();
    });

    it("rejects real obstructed writes with unchanged cache and recovers after obstruction removal", async () => {
      // Given actual isolated disk I/O; never use the real userData directory.
      const dir = await mkdtemp(join(tmpdir(), "gogmeet-ipc-settings-"));
      const originalGetPath = app.getPath.bind(app);
      vi.spyOn(app, "getPath").mockImplementation((name) =>
        name === "userData" ? dir : originalGetPath(name),
      );
      try {
        const store = createJsonSettingsStore();
        await store.load();
        const committed = await store.update({ openBeforeMinutes: 4 });
        const path = join(dir, "settings.json");
        await rm(path);
        await mkdir(path);
        const popover = liveWindow();
        const settings = liveWindow();
        mockGetSettingsWindow.mockReturnValue(settings);
        const handler = setHandler(
          popover,
          testAppGraph({
            settings: store,
            scheduler: { restart: mockRestartScheduler, forcePoll: mockForcePoll },
          }),
        );

        // When the actual handler attempts the blocked save.
        await expect(
          handler(authorizedEvent, {
            openBeforeMinutes: 7,
            launchAtLogin: true,
            showTomorrowMeetings: false,
            showCompletedTodayMeetings: true,
          }),
        ).rejects.toThrow();

        // Then no effect runs and the next save recovers from the committed cache.
        expect(store.get()).toEqual(committed);
        expect(mockRestartScheduler).not.toHaveBeenCalled();
        expect(mockForcePoll).not.toHaveBeenCalled();
        expect(mockForceTrayMenuRefresh).not.toHaveBeenCalled();
        expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
        expect(popover.webContents.send).not.toHaveBeenCalled();
        expect(settings.webContents.send).not.toHaveBeenCalled();
        await rm(path, { recursive: true });
        const recovered = await handler(authorizedEvent, { showCompletedTodayMeetings: true });
        expect(recovered).toEqual({ ...committed, showCompletedTodayMeetings: true });
        expect(await createJsonSettingsStore().load()).toEqual({ ok: true, value: recovered });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it.each(["restart", "forcePoll", "tray", "login", "popoverPush", "settingsPush"])(
      "returns the committed result and continues independent deliveries when %s throws",
      async (effect) => {
        // Given a committed result and a failing post-commit effect.
        const updated = { ...DEFAULT_SETTINGS, launchAtLogin: true, openBeforeMinutes: 5 };
        mockUpdateSettings.mockResolvedValue(updated);
        const popover = liveWindow();
        const settings = liveWindow();
        mockGetSettingsWindow.mockReturnValue(settings);
        const error = new Error("effect failed");
        const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const effects = {
          restart: mockRestartScheduler,
          forcePoll: mockForcePoll,
          tray: mockForceTrayMenuRefresh,
          login: mockSyncAutoLaunch,
          popoverPush: popover.webContents.send,
          settingsPush: settings.webContents.send,
        };
        const failing = effects[effect];
        if (!failing) throw new Error("Unknown effect fixture");
        failing.mockImplementation(() => {
          throw error;
        });
        const partial =
          effect === "tray"
            ? { showCompletedTodayMeetings: true, launchAtLogin: true }
            : effect === "forcePoll"
              ? { showTomorrowMeetings: false, launchAtLogin: true }
              : { openBeforeMinutes: 5, launchAtLogin: true };

        // When the handler runs the effects after persistence.
        const result = await setHandler(popover)(authorizedEvent, partial);

        // Then acknowledgement and the remaining independent deliveries survive.
        expect(result).toEqual(updated);
        expect(report).toHaveBeenCalledWith(expect.stringContaining("SETTINGS_SET"), error);
        expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
        expect(popover.webContents.send).toHaveBeenCalledOnce();
        expect(settings.webContents.send).toHaveBeenCalledOnce();
        expect(mockGetSettings).not.toHaveBeenCalled();
      },
    );

    it("reports rejected forcePoll without rejecting the committed acknowledgement", async () => {
      // Given an asynchronous refresh failure.
      const error = new Error("refresh failed");
      mockForcePoll.mockRejectedValue(error);
      const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const popover = liveWindow();
      const settings = liveWindow();
      mockGetSettingsWindow.mockReturnValue(settings);
      const updated = { ...DEFAULT_SETTINGS, showTomorrowMeetings: false, launchAtLogin: true };
      mockUpdateSettings.mockResolvedValue(updated);

      // When the committed update starts its refresh.
      const result = await setHandler(popover)(authorizedEvent, {
        showTomorrowMeetings: false,
        launchAtLogin: true,
      });

      // Then the rejection is handled and independent deliveries still run.
      expect(result).toEqual(updated);
      expect(report).toHaveBeenCalledWith(expect.stringContaining("SETTINGS_SET"), error);
      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
      expect(popover.webContents.send).toHaveBeenCalledOnce();
      expect(settings.webContents.send).toHaveBeenCalledOnce();
    });

    it.each(["restart", "tomorrow"])(
      "preserves %s precedence over lower-priority effects",
      async (priority) => {
        // Given overlapping effect keys.
        const partial = {
          showTomorrowMeetings: false,
          showCompletedTodayMeetings: true,
          launchAtLogin: true,
          ...(priority === "restart" ? { openBeforeMinutes: 5 } : {}),
        };
        // When one save commits.
        await setHandler(liveWindow())(authorizedEvent, partial);
        // Then only the highest-priority scheduler/display effect runs, plus login sync.
        expect(mockRestartScheduler).toHaveBeenCalledTimes(priority === "restart" ? 1 : 0);
        expect(mockForcePoll).toHaveBeenCalledTimes(priority === "tomorrow" ? 1 : 0);
        if (priority === "tomorrow") expect(mockForcePoll).toHaveBeenCalledWith({ reason: "user" });
        expect(mockForceTrayMenuRefresh).not.toHaveBeenCalled();
        expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
      },
    );

    it.each([
      "sameWindow",
      "sameContents",
      "destroyedPopover",
      "destroyedPopoverContents",
      "destroyedSettings",
      "destroyedSettingsContents",
    ])("pushes at most once per distinct live target when %s", async (target) => {
      // Given cached targets with identity/liveness variations.
      const popover = liveWindow();
      const settings = target === "sameWindow" ? popover : liveWindow();
      if (target === "sameContents") settings.webContents = popover.webContents;
      if (target === "destroyedPopover") popover.isDestroyed.mockReturnValue(true);
      if (target === "destroyedPopoverContents")
        popover.webContents.isDestroyed.mockReturnValue(true);
      if (target === "destroyedSettings") settings.isDestroyed.mockReturnValue(true);
      if (target === "destroyedSettingsContents")
        settings.webContents.isDestroyed.mockReturnValue(true);
      mockGetSettingsWindow.mockReturnValue(settings);
      // When a save commits.
      const result = await setHandler(popover)(authorizedEvent, { launchAtLogin: true });
      // Then only distinct live targets receive the committed push.
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(popover.webContents.send).toHaveBeenCalledTimes(
        target.startsWith("destroyedPopover") ? 0 : 1,
      );
      expect(settings.webContents.send).toHaveBeenCalledTimes(
        target.startsWith("destroyedSettings") ? 0 : 1,
      );
    });

    it("restarts scheduler for quiet hours and auto-open timing keys", async () => {
      const mockWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      mockUpdateSettings.mockResolvedValue(DEFAULT_SETTINGS);
      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { quietHoursEnabled: true });
      expect(mockRestartScheduler).toHaveBeenCalledOnce();
      mockRestartScheduler.mockClear();

      await handler!(authorizedEvent, { autoOpenEnabled: false });
      expect(mockRestartScheduler).toHaveBeenCalledOnce();
    });
  });
});
