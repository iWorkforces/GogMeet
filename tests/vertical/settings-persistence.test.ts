import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultCalendarUiState } from "../../src/domain/entities/calendar-ui-state.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { Api } from "../../src/preload/index.js";
import { IPC_CHANNELS } from "../../src/shared/ipc-channels.js";

const loopback = await vi.hoisted(async () => {
  const { runInNewContext } = await import("node:vm");
  type InvokeHandler = (event: object, ...args: readonly unknown[]) => unknown;
  type RendererListener = (event: object, payload: unknown) => void;
  const handlers = new Map<string, InvokeHandler>();
  const listeners = new Map<string, Set<RendererListener>>();
  const paths = { userData: "" };
  return {
    handlers,
    listeners,
    paths,
    electron: {
      app: {
        getAppPath: () => "/app",
        getPath: () => paths.userData,
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
        setLoginItemSettings: vi.fn(),
        isPackaged: false,
      },
      contextBridge: {
        exposeInMainWorld: (key: string, value: object) => {
          Object.defineProperty(window, key, { configurable: true, value });
        },
        executeInMainWorld: (script: {
          readonly func: (...args: readonly unknown[]) => unknown;
          readonly args?: readonly unknown[];
        }) => {
          const world = { args: script.args ?? [], window, document };
          runInNewContext(`(${script.func.toString()})(...args)`, world);
          Object.defineProperty(window, "api", {
            configurable: true,
            value: Reflect.get(world, "api"),
          });
        },
      },
      ipcMain: {
        handle: (channel: string, handler: InvokeHandler) => handlers.set(channel, handler),
      },
      ipcRenderer: {
        invoke: vi.fn(async (channel: string, ...args: readonly unknown[]) => {
          const handler = handlers.get(channel);
          if (handler === undefined) throw new Error(`No loopback handler for ${channel}`);
          return handler({ senderFrame: { url: "http://localhost:5173/settings.html" } }, ...args);
        }),
        on: (channel: string, listener: RendererListener) => {
          const channelListeners = listeners.get(channel) ?? new Set<RendererListener>();
          channelListeners.add(listener);
          listeners.set(channel, channelListeners);
        },
        removeListener: (channel: string, listener: RendererListener) => {
          listeners.get(channel)?.delete(listener);
        },
        send: vi.fn(),
      },
      Notification: vi.fn(),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      shell: { openExternal: vi.fn(async () => undefined) },
    },
  };
});

vi.mock("electron", () => loopback.electron);

const documentListeners: Array<{
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly options: boolean | AddEventListenerOptions | undefined;
}> = [];
let removeDocumentListeners: (() => void) | null = null;
let originalApiDescriptor: PropertyDescriptor | undefined;

afterEach(async () => {
  window.dispatchEvent(new Event("unload"));
  removeDocumentListeners?.();
  removeDocumentListeners = null;
  documentListeners.length = 0;
  loopback.handlers.clear();
  loopback.listeners.clear();
  document.body.replaceChildren();
  document.getElementById("app-icon-aurora-styles")?.remove();
  if (originalApiDescriptor === undefined) Reflect.deleteProperty(window, "api");
  else Object.defineProperty(window, "api", originalApiDescriptor);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  if (loopback.paths.userData) {
    await rm(loopback.paths.userData, { recursive: true, force: true });
    loopback.paths.userData = "";
  }
});

describe("settings persistence vertical path", () => {
  it("rejects real storage failures, restores the committed toggle, and recovers without reloading", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, "api");
    loopback.paths.userData = await mkdtemp(join(tmpdir(), "gogmeet-settings-persistence-"));
    const settingsPath = join(loopback.paths.userData, "settings.json");
    document.body.innerHTML = '<div id="app"></div>';
    const initialized = Promise.withResolvers<void>();
    const nativeAdd = document.addEventListener.bind(document);
    const nativeRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "DOMContentLoaded" || type === "visibilitychange") {
        documentListeners.push({ type, listener, options });
      }
      nativeAdd(type, listener, options);
      if (type === "visibilitychange") initialized.resolve();
    });
    removeDocumentListeners = () => {
      for (const { type, listener, options } of documentListeners) {
        nativeRemove(type, listener, options);
      }
    };
    const [
      { createJsonSettingsStore },
      { registerSettingsHandlers },
      { registerCalendarHandlers },
      { testAppGraph },
    ] = await Promise.all([
      import("../../src/main/infrastructure/settings/json-settings-store.js"),
      import("../../src/main/ipc-handlers/settings.js"),
      import("../../src/main/ipc-handlers/calendar.js"),
      import("../helpers/app-graph.js"),
    ]);
    const store = createJsonSettingsStore();
    await store.save({ ...DEFAULT_SETTINGS });
    const restart = vi.fn();
    const forcePoll = vi.fn(async () => null);
    const graph = testAppGraph({
      settings: store,
      scheduler: { restart, forcePoll },
      calendar: { getUiState: () => ({ ...defaultCalendarUiState(), oauthConfigured: true }) },
    });
    const send = vi.fn((channel: string, payload: unknown) => {
      for (const listener of loopback.listeners.get(channel) ?? []) listener({}, payload);
    });
    registerSettingsHandlers(
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      }.As<BrowserWindow>(),
      graph,
    );
    registerCalendarHandlers(graph);
    await import("../../src/preload/index.js");
    const api = window.As<Window & { readonly api: Api }>().api;
    const pushedSettings = vi.fn();
    const unsubscribe = api.settings.onChanged(pushedSettings);
    await import("../../src/renderer/settings/index.js");
    const domContentLoaded = documentListeners.find(
      ({ type }) => type === "DOMContentLoaded",
    )?.listener;
    if (domContentLoaded === undefined)
      throw new Error("Settings renderer did not register initialization");
    const event = new Event("DOMContentLoaded");
    if (typeof domContentLoaded === "function") domContentLoaded.call(document, event);
    else domContentLoaded.handleEvent(event);
    await initialized.promise;

    await rm(settingsPath);
    await mkdir(settingsPath);
    await expect(
      api.settings.set({ openBeforeMinutes: 2, launchAtLogin: true, showTomorrowMeetings: false }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    const toggle = document.getElementById("launch-at-login-toggle");
    if (!(toggle instanceof HTMLInputElement)) throw new Error("Missing launch-at-login toggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.querySelector(".settings-error")?.textContent).toContain("EISDIR");
      expect(toggle.checked).toBe(false);
    });
    const restoredToggle = document.getElementById("launch-at-login-toggle");
    if (!(restoredToggle instanceof HTMLInputElement)) throw new Error("Missing restored toggle");
    expect(restoredToggle.checked).toBe(false);
    expect(document.querySelector(".save-indicator.visible")).toBeNull();
    expect(document.getElementById("launch-save-indicator")?.textContent).not.toContain("Saved");
    expect(graph.settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(await api.settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(send).not.toHaveBeenCalled();
    expect(pushedSettings).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(forcePoll).not.toHaveBeenCalled();
    expect(loopback.electron.app.setLoginItemSettings).not.toHaveBeenCalled();

    await rm(settingsPath, { recursive: true });
    restoredToggle.checked = true;
    restoredToggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.getElementById("launch-save-indicator")?.textContent).toBe("Saved");
      expect(pushedSettings).toHaveBeenCalledOnce();
    });
    const committed = { ...DEFAULT_SETTINGS, launchAtLogin: true };
    expect(restoredToggle.checked).toBe(true);
    expect(graph.settings.get()).toEqual(committed);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(committed);
    expect(pushedSettings).toHaveBeenCalledWith(committed);
    expect(send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.SETTINGS_CHANGED, committed);
    expect(loopback.electron.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({
      openAtLogin: true,
    });
    expect(restart).not.toHaveBeenCalled();
    expect(forcePoll).not.toHaveBeenCalled();
    expect(document.getElementById("settings-main")?.hasAttribute("aria-busy")).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.getElementById("launch-save-indicator")?.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });
});
