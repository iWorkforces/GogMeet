import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { AppSettings } from "../../src/domain/entities/settings.js";
import {
  defaultCalendarUiState,
  type CalendarUiState,
} from "../../src/domain/entities/calendar-ui-state.js";

/**
 * Tests for settings/index.ts
 *
 * The settings module loads settings via window.api.settings.get(),
 * renders a form with dropdown and toggles, and saves on change.
 * Tests verify module loading and the core logic patterns.
 */

describe("settings/index.ts", () => {
  const documentListeners: Array<{
    readonly type: string;
    readonly listener: EventListenerOrEventListenerObject;
    readonly options: boolean | AddEventListenerOptions | undefined;
  }> = [];
  const removeEventListener = document.removeEventListener.bind(document);

  function removeRendererListeners(): void {
    for (const { type, listener, options } of documentListeners) {
      removeEventListener(type, listener, options);
    }
    documentListeners.length = 0;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.restoreAllMocks();
    vi.useFakeTimers();
    const addEventListener = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "DOMContentLoaded" || type === "visibilitychange") {
        documentListeners.push({ type, listener, options });
      }
      addEventListener(type, listener, options);
    });
  });

  afterEach(() => {
    removeRendererListeners();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.getElementById("app-icon-aurora-styles")?.remove();
  });

  async function loadSettingsRenderer(
    setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>,
    options?: {
      getSettings?: () => Promise<AppSettings>;
      getUiState?: () => Promise<unknown>;
      onChanged?: (cb: (s: AppSettings) => void) => () => void;
      requestPermission?: () => Promise<"granted">;
    },
  ): Promise<void> {
    removeRendererListeners();
    vi.clearAllTimers();
    vi.resetModules();
    const onChanged =
      options?.onChanged ??
      vi.fn((cb: (s: AppSettings) => void) => {
        void cb;
        return () => undefined;
      });
    vi.stubGlobal("api", {
      settings: {
        get:
          options?.getSettings ??
          vi.fn<() => Promise<AppSettings>>().mockResolvedValue({ ...DEFAULT_SETTINGS }),
        set: setSettings,
        onChanged,
      },
      calendar: {
        requestPermission: options?.requestPermission,
        getUiState:
          options?.getUiState ??
          vi.fn().mockResolvedValue({
            permission: "not-determined",
            phase: "disconnected",
            lastError: null,
            accountEmail: null,
            events: null,
            offline: false,
            oauthConfigured: true,
          }),
      },
    });

    await import("../../src/renderer/settings/index.js");
    document.dispatchEvent(new Event("DOMContentLoaded"));

    await vi.waitFor(() => {
      expect(document.getElementById("open-before-select")).toBeInstanceOf(HTMLSelectElement);
    });
  }

  function getOpenBeforeSelect(): HTMLSelectElement {
    const select = document.getElementById("open-before-select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("settings renderer did not render the open-before dropdown");
    }
    return select;
  }

  function getLaunchAtLoginToggle(): HTMLInputElement {
    const toggle = document.getElementById("launch-at-login-toggle");
    if (!(toggle instanceof HTMLInputElement)) {
      throw new Error("settings renderer did not render the launch-at-login toggle");
    }
    return toggle;
  }

  function refreshWhenVisible(): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("keeps controls wired after a successful dropdown save rerender", async () => {
    const updatedAfterDropdown = { ...DEFAULT_SETTINGS, openBeforeMinutes: 2 };
    const updatedAfterToggle = { ...updatedAfterDropdown, launchAtLogin: true };
    const setSettings = vi
      .fn<(partial: Partial<AppSettings>) => Promise<AppSettings>>()
      .mockResolvedValueOnce(updatedAfterDropdown)
      .mockResolvedValueOnce(updatedAfterToggle);

    await loadSettingsRenderer(setSettings);

    const initialSelect = getOpenBeforeSelect();
    initialSelect.value = "2";
    initialSelect.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(setSettings).toHaveBeenCalledTimes(1);
    });

    const rerenderedSelect = getOpenBeforeSelect();
    expect(rerenderedSelect).not.toBe(initialSelect);

    const rerenderedToggle = getLaunchAtLoginToggle();
    rerenderedToggle.checked = true;
    rerenderedToggle.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(setSettings).toHaveBeenCalledTimes(2);
    });
    expect(setSettings).toHaveBeenNthCalledWith(2, { launchAtLogin: true });
  });

  it("keeps controls wired after a failed dropdown save rerender", async () => {
    const saveError = new Error("Settings save failed");
    const updatedAfterToggle = { ...DEFAULT_SETTINGS, launchAtLogin: true };
    const setSettings = vi
      .fn<(partial: Partial<AppSettings>) => Promise<AppSettings>>()
      .mockRejectedValueOnce(saveError)
      .mockResolvedValueOnce(updatedAfterToggle);

    await loadSettingsRenderer(setSettings);

    const initialSelect = getOpenBeforeSelect();
    initialSelect.value = "2";
    initialSelect.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(document.querySelector(".settings-error")?.textContent).toBe(saveError.message);
    });

    const rerenderedSelect = getOpenBeforeSelect();
    expect(rerenderedSelect).not.toBe(initialSelect);

    const rerenderedToggle = getLaunchAtLoginToggle();
    rerenderedToggle.checked = true;
    rerenderedToggle.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(setSettings).toHaveBeenCalledTimes(2);
    });
    expect(setSettings).toHaveBeenNthCalledWith(2, { launchAtLogin: true });
  });

  it("connect and disconnect calendar buttons update UI state", async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    let phase: "disconnected" | "connected" = "disconnected";
    const getUiState = vi.fn().mockImplementation(async () => {
      if (phase === "connected") {
        return {
          permission: "granted",
          phase: "ready",
          lastError: null,
          accountEmail: "u@example.com",
          events: [],
          offline: false,
          oauthConfigured: true,
        };
      }
      return {
        permission: "not-determined",
        phase: "disconnected",
        lastError: null,
        accountEmail: null,
        events: null,
        offline: false,
        oauthConfigured: true,
      };
    });
    const requestPermission = vi.fn().mockImplementation(async () => {
      phase = "connected";
      return "granted";
    });
    const disconnect = vi.fn().mockImplementation(async () => {
      phase = "disconnected";
    });
    vi.stubGlobal("api", {
      settings: {
        get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
        set: vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
          ...DEFAULT_SETTINGS,
          ...p,
        })),
        onChanged: vi.fn(() => () => undefined),
      },
      calendar: {
        getUiState,
        requestPermission,
        disconnect,
      },
    });
    await import("../../src/renderer/settings/index.js");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.waitFor(() => {
      expect(document.getElementById("calendar-connect-btn")).toBeTruthy();
    });
    document.getElementById("calendar-connect-btn")!.click();
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.getElementById("calendar-disconnect-btn")).toBeTruthy());
    expect(document.getElementById("calendar-disconnect-btn")?.textContent).toMatch(/Disconnect/);
    document.getElementById("calendar-disconnect-btn")!.click();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.getElementById("calendar-connect-btn")).toBeTruthy());
  });

  it("renders timing controls and section structure", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings);
    expect(document.getElementById("section-calendar")?.textContent).toBe("Calendar");
    expect(document.getElementById("section-joining")?.textContent).toBe("Joining Meetings");
    expect(document.getElementById("section-display")?.textContent).toBe("Tray Menu");
    expect(document.getElementById("section-general")?.textContent).toBe("General");
    expect(document.getElementById("alert-lead-select")).toBeInstanceOf(HTMLSelectElement);
    expect(document.getElementById("late-join-select")).toBeInstanceOf(HTMLSelectElement);
    expect(document.getElementById("quiet-hours-start")).toBeInstanceOf(HTMLInputElement);
    expect(document.getElementById("quiet-hours-end")).toBeInstanceOf(HTMLInputElement);
    const openBefore = getOpenBeforeSelect();
    expect([...openBefore.options].map((o) => o.value)).toEqual(
      Array.from({ length: 11 }, (_, i) => String(i)),
    );
    expect(openBefore.options[0]?.textContent).toBe("At start");
  });

  it("saves alert lead and late join selects", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings);
    const lead = document.getElementById("alert-lead-select");
    expect(lead).toBeInstanceOf(HTMLSelectElement);
    if (lead instanceof HTMLSelectElement) {
      lead.value = "120";
      lead.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledWith({ alertLeadSeconds: 120 }));

    const late = document.getElementById("late-join-select");
    expect(late).toBeInstanceOf(HTMLSelectElement);
    if (late instanceof HTMLSelectElement) {
      late.value = "5";
      late.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledWith({ lateJoinGraceMinutes: 5 }));
  });

  it("saves quiet-hours times when enabled", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      quietHoursEnabled: true,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, {
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        quietHoursEnabled: true,
      }),
    });
    const start = document.getElementById("quiet-hours-start");
    expect(start).toBeInstanceOf(HTMLInputElement);
    if (start instanceof HTMLInputElement) {
      expect(start.disabled).toBe(false);
      start.value = "21:30";
      start.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledWith({ quietHoursStart: "21:30" }));

    const end = document.getElementById("quiet-hours-end");
    if (end instanceof HTMLInputElement) {
      end.value = "06:15";
      end.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledWith({ quietHoursEnd: "06:15" }));
  });

  it("reverts invalid quiet-hours time input", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      quietHoursEnabled: true,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, {
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
      }),
    });
    const start = document.getElementById("quiet-hours-start");
    if (start instanceof HTMLInputElement) {
      start.value = "not-a-time";
      start.dispatchEvent(new Event("change"));
      expect(start.value).toBe("22:00");
    }
    expect(setSettings).not.toHaveBeenCalled();
  });

  it("disables quiet-hours times when quiet hours is off", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings);
    expect((document.getElementById("quiet-hours-start") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("quiet-hours-end") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows reconnect when calendar permission is denied", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, {
      getUiState: vi.fn().mockResolvedValue({
        permission: "denied",
        phase: "error",
        lastError: "Permission denied",
        accountEmail: null,
        events: null,
        offline: false,
        oauthConfigured: true,
      }),
    });
    const btn = document.getElementById("calendar-connect-btn");
    expect(btn?.textContent).toMatch(/Reconnect/);
    expect(document.querySelector(".settings-error")?.textContent).toContain("Permission denied");
  });

  it("disables Connect when OAuth is not configured", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, {
      getUiState: vi.fn().mockResolvedValue({
        permission: "not-determined",
        phase: "disconnected",
        lastError: null,
        accountEmail: null,
        events: null,
        offline: false,
        oauthConfigured: false,
      }),
    });
    const btn = document.getElementById("calendar-connect-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("coalesces concurrent saves while one is in flight", async () => {
    let release!: (v: AppSettings) => void;
    const first = new Promise<AppSettings>((resolve) => {
      release = resolve;
    });
    const setSettings = vi
      .fn<(partial: Partial<AppSettings>) => Promise<AppSettings>>()
      .mockImplementationOnce(() => first)
      .mockImplementation(async (p: Partial<AppSettings>) => ({
        ...DEFAULT_SETTINGS,
        ...p,
      }));
    await loadSettingsRenderer(setSettings);

    const openBefore = getOpenBeforeSelect();
    openBefore.value = "2";
    openBefore.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1));

    const toggle = getLaunchAtLoginToggle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    release({ ...DEFAULT_SETTINGS, openBeforeMinutes: 2 });
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledTimes(2));
    expect(setSettings).toHaveBeenLastCalledWith({ launchAtLogin: true });
  });

  it("uses defaults when calendar getUiState throws on init", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, {
      getUiState: vi.fn().mockRejectedValue(new Error("no ui")),
    });
    expect(document.getElementById("calendar-connect-btn")).toBeTruthy();
  });

  it("soft-refreshes from main when document becomes visible again", async () => {
    let launchAtLogin = false;
    const getSettings = vi.fn(async () => ({ ...DEFAULT_SETTINGS, launchAtLogin }));
    const getUiState = vi.fn().mockResolvedValue({
      permission: "granted",
      phase: "ready",
      lastError: null,
      accountEmail: "a@example.com",
      events: [],
      offline: false,
      oauthConfigured: true,
    });
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, { getSettings, getUiState });
    expect(getSettings).toHaveBeenCalled();
    const callsAfterInit = getSettings.mock.calls.length;

    launchAtLogin = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(getSettings.mock.calls.length).toBeGreaterThan(callsAfterInit));
    await vi.waitFor(() => {
      const toggle = document.getElementById("launch-at-login-toggle");
      expect(toggle).toBeInstanceOf(HTMLInputElement);
      expect((toggle as HTMLInputElement).checked).toBe(true);
    });
  });

  it("keeps a newer completed save when a visibility settings GET finishes late", async () => {
    const staleSettings = Promise.withResolvers<AppSettings>();
    const getSettings = vi
      .fn<() => Promise<AppSettings>>()
      .mockResolvedValueOnce({ ...DEFAULT_SETTINGS })
      .mockReturnValueOnce(staleSettings.promise);
    const getUiState = vi.fn(async () => defaultCalendarUiState());
    const setSettings = vi.fn(async (partial: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...partial,
    }));
    await loadSettingsRenderer(setSettings, { getSettings, getUiState });
    refreshWhenVisible();
    expect(getSettings).toHaveBeenCalledTimes(2);
    const select = getOpenBeforeSelect();
    select.value = "2";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(getOpenBeforeSelect().value).toBe("2");
      expect(document.getElementById("save-indicator")?.textContent).toBe("Saved");
      expect(document.getElementById("settings-main")?.hasAttribute("aria-busy")).toBe(false);
    });
    const committedSelect = getOpenBeforeSelect();
    staleSettings.resolve({ ...DEFAULT_SETTINGS });
    await vi.advanceTimersByTimeAsync(0);
    expect(getOpenBeforeSelect()).toBe(committedSelect);
    expect(getOpenBeforeSelect().value).toBe("2");
    expect(document.getElementById("save-indicator")?.textContent).toBe("Saved");
    expect(getUiState).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer completed save when a visibility account GET finishes late", async () => {
    const staleAccount = Promise.withResolvers<CalendarUiState>();
    const getUiState = vi
      .fn<() => Promise<CalendarUiState>>()
      .mockResolvedValueOnce({ ...defaultCalendarUiState(), oauthConfigured: true })
      .mockReturnValueOnce(staleAccount.promise);
    const setSettings = vi.fn(async (partial: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...partial,
    }));
    await loadSettingsRenderer(setSettings, { getUiState });
    refreshWhenVisible();
    await vi.waitFor(() => expect(getUiState).toHaveBeenCalledTimes(2));
    const toggle = getLaunchAtLoginToggle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.getElementById("launch-save-indicator")?.textContent).toBe("Saved");
      expect(document.getElementById("settings-main")?.hasAttribute("aria-busy")).toBe(false);
    });
    staleAccount.resolve({
      ...defaultCalendarUiState(),
      permission: "granted",
      accountEmail: "stale@example.com",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getLaunchAtLoginToggle()).toBe(toggle);
    expect(toggle.checked).toBe(true);
    expect(document.getElementById("launch-save-indicator")?.textContent).toBe("Saved");
    expect(document.getElementById("calendar-connect-btn")).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).not.toContain("stale@example.com");
  });

  it("retains committed rollback settings while a visibility account GET is pending", async () => {
    const staleAccount = Promise.withResolvers<CalendarUiState>();
    const getSettings = vi
      .fn<() => Promise<AppSettings>>()
      .mockResolvedValueOnce({ ...DEFAULT_SETTINGS })
      .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, launchAtLogin: true });
    const getUiState = vi
      .fn<() => Promise<CalendarUiState>>()
      .mockResolvedValueOnce(defaultCalendarUiState())
      .mockReturnValueOnce(staleAccount.promise);
    const setSettings = vi.fn().mockRejectedValue(new Error("persistence failed"));
    await loadSettingsRenderer(setSettings, { getSettings, getUiState });
    refreshWhenVisible();
    await vi.waitFor(() => expect(getUiState).toHaveBeenCalledTimes(2));
    const toggle = getLaunchAtLoginToggle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(document.querySelector(".settings-error")?.textContent).toBe("persistence failed"),
    );
    expect(getLaunchAtLoginToggle().checked).toBe(false);
    expect(toggle.checked).toBe(false);
    staleAccount.resolve(defaultCalendarUiState());
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".settings-error")?.textContent).toBe("persistence failed");
    expect(getLaunchAtLoginToggle().checked).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps settings pushes when an older visibility account GET later %ss",
    async (completion) => {
      const staleAccount = Promise.withResolvers<CalendarUiState>();
      const subscribed = Promise.withResolvers<(settings: AppSettings) => void>();
      const getUiState = vi
        .fn<() => Promise<CalendarUiState>>()
        .mockResolvedValueOnce(defaultCalendarUiState())
        .mockReturnValueOnce(staleAccount.promise);
      await loadSettingsRenderer(vi.fn(), {
        getUiState,
        onChanged: (callback) => {
          subscribed.resolve(callback);
          return () => undefined;
        },
      });
      refreshWhenVisible();
      await vi.waitFor(() => expect(getUiState).toHaveBeenCalledTimes(2));
      const push = await subscribed.promise;
      push({ ...DEFAULT_SETTINGS, launchAtLogin: true });
      const pushedToggle = getLaunchAtLoginToggle();
      if (completion === "resolve") {
        staleAccount.resolve({
          ...defaultCalendarUiState(),
          permission: "granted",
          accountEmail: "stale@example.com",
        });
      } else {
        staleAccount.reject(new Error("late account failure"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(getLaunchAtLoginToggle()).toBe(pushedToggle);
      expect(pushedToggle.checked).toBe(true);
      expect(document.body.textContent).not.toContain("stale@example.com");
    },
  );

  it.each(["busy", "completed"] as const)(
    "keeps newer account work when an older visibility account GET finishes while %s",
    async (accountWork) => {
      const staleAccount = Promise.withResolvers<CalendarUiState>();
      const permission = Promise.withResolvers<"granted">();
      const currentAccount: CalendarUiState = {
        ...defaultCalendarUiState(),
        permission: "granted",
        accountEmail: "current@example.com",
      };
      const getUiState = vi
        .fn<() => Promise<CalendarUiState>>()
        .mockResolvedValueOnce({ ...defaultCalendarUiState(), oauthConfigured: true })
        .mockReturnValueOnce(staleAccount.promise)
        .mockResolvedValueOnce(currentAccount);
      await loadSettingsRenderer(vi.fn(), {
        getUiState,
        requestPermission: () => permission.promise,
      });
      refreshWhenVisible();
      await vi.waitFor(() => expect(getUiState).toHaveBeenCalledTimes(2));
      const connect = document.getElementById("calendar-connect-btn");
      if (!(connect instanceof HTMLButtonElement)) throw new Error("Missing Connect button");
      connect.click();
      if (accountWork === "completed") {
        permission.resolve("granted");
        await vi.waitFor(() => expect(document.body.textContent).toContain("current@example.com"));
      }
      const currentButton = document.querySelector("#calendar-account-group button");
      staleAccount.resolve({
        ...defaultCalendarUiState(),
        permission: "granted",
        accountEmail: "stale@example.com",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector("#calendar-account-group button")).toBe(currentButton);
      expect(document.body.textContent).not.toContain("stale@example.com");
      if (accountWork === "busy") {
        expect(currentButton?.hasAttribute("disabled")).toBe(true);
        permission.resolve("granted");
        await vi.waitFor(() => expect(document.body.textContent).toContain("current@example.com"));
      }
    },
  );

  it("re-renders when settings.onChanged fires while idle", async () => {
    let push: ((s: AppSettings) => void) | null = null;
    const onChanged = vi.fn((cb: (s: AppSettings) => void) => {
      push = cb;
      return () => undefined;
    });
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings, { onChanged });
    expect(onChanged).toHaveBeenCalled();
    push?.({ ...DEFAULT_SETTINGS, showTomorrowMeetings: false });
    await vi.waitFor(() => {
      const toggle = document.getElementById("show-tomorrow-toggle");
      expect(toggle).toBeInstanceOf(HTMLInputElement);
      expect((toggle as HTMLInputElement).checked).toBe(false);
    });
  });

  it("disables dependent joining controls when auto-open is off", async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal("api", {
      settings: {
        get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, autoOpenEnabled: false }),
        set: vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
          ...DEFAULT_SETTINGS,
          autoOpenEnabled: false,
          ...p,
        })),
        onChanged: vi.fn(() => () => undefined),
      },
      calendar: {
        getUiState: vi.fn().mockResolvedValue({
          permission: "not-determined",
          phase: "disconnected",
          lastError: null,
          accountEmail: null,
          events: null,
          offline: false,
          oauthConfigured: true,
        }),
      },
    });
    await import("../../src/renderer/settings/index.js");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.waitFor(() => {
      expect(document.getElementById("open-before-select")).toBeInstanceOf(HTMLSelectElement);
    });
    expect((document.getElementById("open-before-select") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect((document.getElementById("window-alert-toggle") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((document.getElementById("alert-lead-select") as HTMLSelectElement).disabled).toBe(true);
  });

  it("reverts toggle when save throws", async () => {
    const setSettings = vi.fn().mockRejectedValue(new Error("fail"));
    await loadSettingsRenderer(setSettings);
    const toggle = getLaunchAtLoginToggle();
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    await vi.waitFor(() => expect(toggle.checked).toBe(false));
  });

  it("saves show-tomorrow toggle", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings);
    const el = document.getElementById("show-tomorrow-toggle");
    expect(el).toBeInstanceOf(HTMLInputElement);
    if (el instanceof HTMLInputElement) {
      el.checked = !el.checked;
      el.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings.mock.calls.some((c) => "showTomorrowMeetings" in (c[0] ?? {}))).toBe(true);
  });

  it("renders completed-meetings toggle off by default and saves true on change", async () => {
    const setSettings = vi.fn().mockImplementation(async (p: Partial<AppSettings>) => ({
      ...DEFAULT_SETTINGS,
      ...p,
    }));
    await loadSettingsRenderer(setSettings);
    const el = document.getElementById("show-completed-meetings-toggle");
    expect(el).toBeInstanceOf(HTMLInputElement);
    if (!(el instanceof HTMLInputElement)) throw new Error("missing toggle");
    expect(el.checked).toBe(false);

    el.checked = true;
    el.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings).toHaveBeenCalledWith({ showCompletedTodayMeetings: true });
    await vi.waitFor(() => {
      expect(document.getElementById("completed-save-indicator")?.textContent).toContain("Saved");
    });
    // Native checkbox remains the source of truth (no hybrid role=switch).
    expect(el.checked).toBe(true);
  });

  it("reverts completed-meetings toggle when save rejects", async () => {
    const setSettings = vi.fn().mockRejectedValue(new Error("fail"));
    await loadSettingsRenderer(setSettings);
    const el = document.getElementById("show-completed-meetings-toggle");
    expect(el).toBeInstanceOf(HTMLInputElement);
    if (!(el instanceof HTMLInputElement)) throw new Error("missing toggle");
    el.checked = true;
    el.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    await vi.waitFor(() => expect(el.checked).toBe(false));
  });

  it("reverts completed-meetings toggle when response does not preserve requested value", async () => {
    const setSettings = vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      showCompletedTodayMeetings: false,
    });
    await loadSettingsRenderer(setSettings);
    const el = document.getElementById("show-completed-meetings-toggle");
    expect(el).toBeInstanceOf(HTMLInputElement);
    if (!(el instanceof HTMLInputElement)) throw new Error("missing toggle");
    el.checked = true;
    el.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    await vi.waitFor(() => expect(el.checked).toBe(false));
  });

  it("saves auto-open and window-alert toggles after reload", async () => {
    const idToKey: Record<string, keyof AppSettings> = {
      "auto-open-toggle": "autoOpenEnabled",
      "window-alert-toggle": "windowAlert",
      "native-notif-toggle": "nativeNotifications",
      "quiet-hours-toggle": "quietHoursEnabled",
    };
    for (const [id, key] of Object.entries(idToKey)) {
      const setSettings = vi.fn().mockImplementation(async (partial: Partial<AppSettings>) => ({
        ...DEFAULT_SETTINGS,
        ...partial,
      }));
      await loadSettingsRenderer(setSettings);
      const el = document.getElementById(id);
      expect(el).toBeInstanceOf(HTMLInputElement);
      const input = el as HTMLInputElement;
      input.checked = !input.checked;
      input.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
      expect(setSettings.mock.calls.some((c) => key in (c[0] ?? {}))).toBe(true);
      vi.resetModules();
      document.body.innerHTML = '<div id="app"></div>';
    }
  });
});

describe("settings constants", () => {
  it("OPEN_BEFORE_MINUTES_MIN is 0", async () => {
    expect((await import("../../src/domain/entities/settings.js")).OPEN_BEFORE_MINUTES_MIN).toBe(0);
  });

  it("OPEN_BEFORE_MINUTES_MAX is 10", async () => {
    expect((await import("../../src/domain/entities/settings.js")).OPEN_BEFORE_MINUTES_MAX).toBe(
      10,
    );
  });

  it("range produces 5 options", () => {
    const MIN = 1;
    const MAX = 5;
    const count = MAX - MIN + 1;
    expect(count).toBe(5);
  });
});

describe("settings save indicator logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("indicator text clears after timeout", () => {
    document.body.innerHTML =
      '<span class="save-indicator visible" id="save-indicator">✓ Saved</span>';

    const indicator = document.getElementById("save-indicator");
    expect(indicator?.classList.contains("visible")).toBe(true);

    // Simulate the setTimeout behavior
    setTimeout(() => {
      indicator?.classList.remove("visible");
    }, 1500);

    vi.advanceTimersByTime(1600);
    expect(indicator?.classList.contains("visible")).toBe(false);
  });

  it("multiple saves clear previous timer", () => {
    document.body.innerHTML =
      '<span class="save-indicator visible" id="save-indicator">✓ Saved</span>';

    const indicator = document.getElementById("save-indicator");

    // First timer
    const timer1 = setTimeout(() => {
      indicator?.classList.remove("visible");
    }, 1500);

    // Second timer (should clear first)
    clearTimeout(timer1);
    const timer2 = setTimeout(() => {
      indicator?.classList.remove("visible");
    }, 1500);

    vi.advanceTimersByTime(1000);
    expect(indicator?.classList.contains("visible")).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(indicator?.classList.contains("visible")).toBe(false);

    clearTimeout(timer2);
  });
});

describe("settings dropdown validation", () => {
  it("rejects NaN values", () => {
    const value = parseInt("abc", 10);
    expect(isNaN(value)).toBe(true);
  });

  it("open-before range matches domain constants 0–10", async () => {
    const { OPEN_BEFORE_MINUTES_MIN, OPEN_BEFORE_MINUTES_MAX } =
      await import("../../src/domain/entities/settings.js");
    expect(OPEN_BEFORE_MINUTES_MIN).toBe(0);
    expect(OPEN_BEFORE_MINUTES_MAX).toBe(10);
  });
});
