import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/preload/index.js";
import type { AlertPayload } from "../../src/shared/alert.js";
import type { PushChannelMap } from "../../src/shared/ipc-channels.js";
import { IPC_CHANNELS } from "../../src/shared/ipc-channels.js";
import {
  asTestEventId,
  asTestIsoUtc,
  createMockEvent,
  okCalendarResult,
} from "../helpers/test-utils.js";

const loopback = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const { runInNewContext } = await import("node:vm");
  type Handler = (event: object, payload: unknown) => unknown;
  type Listener = (event: object, payload: unknown) => void;
  const invokes = new Map<string, Handler>();
  const sends = new Map<string, Handler>();
  const listeners = new Map<string, Set<Listener>>();
  const pushes: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const windows: NativeWindow[] = [];
  class NativeWindow extends EventEmitter {
    destroyed = false;
    visible = false;
    readonly webContents = {
      mainFrame: { url: "http://localhost:5173/alert.html", parent: null },
      isDestroyed: () => this.destroyed,
      getURL: () => this.webContents.mainFrame.url,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (source: string) =>
        runInNewContext(source, { window, document }),
      ),
      send: vi.fn((channel: string, payload: unknown) => pushes.push({ channel, payload })),
    };
    readonly show = vi.fn(() => {
      this.visible = true;
    });
    readonly hide = vi.fn(() => {
      this.visible = false;
    });
    readonly setSize = vi.fn();
    readonly setAlwaysOnTop = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);
    readonly loadFile = vi.fn(async () => undefined);
    constructor(readonly options: object) {
      super();
      windows.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isVisible(): boolean {
      return this.visible;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
      this.removeAllListeners();
    }
    static fromWebContents(sender: unknown): NativeWindow | null {
      return windows.find((win) => !win.destroyed && win.webContents === sender) ?? null;
    }
  }
  function sender(): object {
    const win = windows.at(-1);
    if (win === undefined) throw new Error("No native alert window");
    return {
      sender: win.webContents,
      senderFrame: win.webContents.mainFrame,
      frameId: 0,
      processId: 1,
    };
  }
  const electron = {
    BrowserWindow: NativeWindow,
    app: {
      isPackaged: false,
      getAppPath: () => "/app",
      getPath: () => "/unused",
      getVersion: () => "2.0.7",
    },
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    contextBridge: {
      exposeInMainWorld: (key: string, value: object) =>
        Object.defineProperty(window, key, { configurable: true, value }),
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
      handle: (channel: string, handler: Handler) => invokes.set(channel, handler),
      on: (channel: string, handler: Handler) => sends.set(channel, handler),
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        const handler = invokes.get(channel);
        if (handler === undefined) throw new Error(`No invoke handler: ${channel}`);
        return handler(sender(), payload);
      }),
      send: vi.fn((channel: string, payload: unknown) => sends.get(channel)?.(sender(), payload)),
      on: (channel: string, listener: Listener) => {
        const set = listeners.get(channel) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(channel, set);
      },
      removeListener: (channel: string, listener: Listener) => {
        listeners.get(channel)?.delete(listener);
      },
    },
    shell: { openExternal: vi.fn(async (_url: string) => undefined) },
    Notification: vi.fn(),
    safeStorage: { isEncryptionAvailable: () => false },
  };
  return { electron, windows, pushes, invokes, sends, listeners };
});
vi.mock("electron", () => loopback.electron);

type Wire = PushChannelMap[typeof IPC_CHANNELS.ALERT_SHOW];
let destroyWindow: (() => void) | null = null;
let originalApi: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  originalApi = Object.getOwnPropertyDescriptor(window, "api");
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  destroyWindow?.();
  destroyWindow = null;
  expect([...loopback.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  loopback.windows.length = 0;
  loopback.pushes.length = 0;
  loopback.invokes.clear();
  loopback.sends.clear();
  loopback.listeners.clear();
  document.body.replaceChildren();
  if (originalApi === undefined) Reflect.deleteProperty(window, "api");
  else Object.defineProperty(window, "api", originalApi);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function latestWire(): Wire {
  const push = loopback.pushes.filter(({ channel }) => channel === IPC_CHANNELS.ALERT_SHOW).at(-1);
  if (push === undefined) throw new Error("No alert wire delivery");
  return push.payload.As<Wire>();
}
function deliver(wire: Wire): void {
  for (const listener of loopback.listeners.get(IPC_CHANNELS.ALERT_SHOW) ?? []) listener({}, wire);
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
function button(action: "join" | "dismiss"): HTMLButtonElement {
  const node = document.querySelector(`[data-action="${action}"]`);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`Missing ${action}`);
  return node;
}
function alertCard(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".alert-card");
  if (node === null) throw new Error("Missing alert card");
  return node;
}

async function setup() {
  const [
    { showAlert, destroyAlertWindow, captureAlertPresentation, closeAlertPresentation },
    { registerAppHandlers },
    { registerAlertHandlers },
    { createJoinMeeting },
    { createShellMeetingOpener },
    { testAppGraph },
  ] = await Promise.all([
    import("../../src/main/windows/alert-window.js"),
    import("../../src/main/ipc-handlers/app.js"),
    import("../../src/main/ipc-handlers/alert.js"),
    import("../../src/main/application/use-cases/join-meeting.js"),
    import("../../src/main/infrastructure/electron/shell-meeting-opener.js"),
    import("../helpers/app-graph.js"),
  ]);
  destroyWindow = destroyAlertWindow;
  const eventA = createMockEvent({
    id: asTestEventId("alert-A"),
    title: "Origin A",
    startDate: asTestIsoUtc("2026-10-02T10:00:00Z"),
  });
  const cancel = vi.fn();
  const opener = createShellMeetingOpener();
  const join = createJoinMeeting({
    getLastKnownEvents: () => okCalendarResult([eventA]),
    fetchCalendarEvents: async () => okCalendarResult([eventA]),
    opener,
    cancelPendingBrowserOpen: cancel,
  });
  const graph = testAppGraph({
    opener,
    join: { byId: join.execute },
    scheduler: { cancelPendingBrowserOpen: cancel },
  });
  registerAppHandlers(graph);
  registerAlertHandlers(graph);
  await import("../../src/preload/index.js");
  const api = window.As<Window & { readonly api: Api }>().api;
  const received = vi.fn<(data: AlertPayload) => void>();
  api.alert.onShowAlert(received);
  await import("../../src/renderer/alert/index.js");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  const dismissA = vi.fn();
  showAlert(eventA, dismissA, undefined, () => true);
  const win = loopback.windows.at(-1);
  if (win === undefined) throw new Error("Missing alert window");
  win.emit("ready-to-show");
  await flush();
  const wireA = latestWire();
  deliver(wireA);
  const replace = async (sameId = true): Promise<ReturnType<typeof vi.fn>> => {
    if (!sameId) {
      const origin = captureAlertPresentation(win.webContents.As<WebContents>(), {
        id: eventA.id,
        epoch: wireA.epoch,
      });
      if (origin === null) throw new Error("Missing originating main ownership");
      closeAlertPresentation(origin);
    }
    const dismissB = vi.fn();
    showAlert(
      {
        ...eventA,
        id: sameId ? eventA.id : asTestEventId("alert-B"),
        title: "Origin B",
        startDate: asTestIsoUtc("2026-10-02T11:00:00Z"),
      },
      dismissB,
      undefined,
      () => true,
    );
    await flush();
    return dismissB;
  };
  return { api, eventA, cancel, received, win, wireA, replace, dismissA };
}

describe("alert presentation main/preload/renderer loopback", () => {
  it.each([true, false])(
    "rejects retained A dismissal during main B's pre-delivery handoff (same ID: %s)",
    async (sameId) => {
      // Given main-installed B while this page has only received A.
      const { api, eventA, cancel, received, win, wireA, replace, dismissA } = await setup();
      const dismiss = api.alert.notifyDismissed;
      const dismissB = await replace(sameId);
      const hideCount = win.hide.mock.calls.length;
      // When the retained A function begins and finishes its dismissal.
      dismiss(eventA.id);
      await vi.advanceTimersByTimeAsync(300);
      // Then only A's epoch is sent and neither main presentation is consumed.
      expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual([
        [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "begin" }],
        [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "finish" }],
      ]);
      expect(win.hide).toHaveBeenCalledTimes(hideCount);
      expect(cancel).not.toHaveBeenCalled();
      expect(dismissA).not.toHaveBeenCalled();
      expect(dismissB).not.toHaveBeenCalled();
      expect(received.mock.calls[0]?.[0]).not.toHaveProperty("meetUrl");
      expect(received.mock.calls[0]?.[0]).not.toHaveProperty("epoch");
      deliver(latestWire());
      expect(document.querySelector(".alert-title")?.textContent).toBe("Origin B");
    },
  );

  it.each([true, false])(
    "keeps stale join success from closing B and cancels A only after opener success (same ID: %s)",
    async (sameId) => {
      // Given a real ID join awaiting the native opener.
      const pending = Promise.withResolvers<void>();
      loopback.electron.shell.openExternal.mockReturnValueOnce(pending.promise);
      const { eventA, cancel, win, replace, dismissA } = await setup();
      button("join").click();
      await flush();
      expect(cancel).not.toHaveBeenCalled();
      const dismissB = await replace(sameId);
      deliver(latestWire());
      const current = button("join");
      const hideCount = win.hide.mock.calls.length;
      // When the old opener succeeds after main and renderer replacement.
      pending.resolve();
      await flush();
      // Then successful ID cancellation happens once without dismissal or closing B.
      expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
      expect(win.hide).toHaveBeenCalledTimes(hideCount);
      expect(dismissA).not.toHaveBeenCalled();
      expect(dismissB).not.toHaveBeenCalled();
      expect(loopback.electron.ipcRenderer.send).not.toHaveBeenCalled();
      expect(current.disabled).toBe(false);
    },
  );

  it("keeps stale opener failure from mutating the same-ID replacement", async () => {
    const pending = Promise.withResolvers<void>();
    loopback.electron.shell.openExternal.mockReturnValueOnce(pending.promise);
    const { cancel, replace } = await setup();
    button("join").click();
    await flush();
    await replace();
    deliver(latestWire());
    pending.reject(new Error("Old opener failure"));
    await flush();
    expect(document.getElementById("join-error")).toBeNull();
    expect(button("join").disabled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["animationend", "fallback"] as const)(
    "finishes explicit dismissal once via %s and preserves cancellation",
    async (finish) => {
      const { cancel, eventA, dismissA, win } = await setup();
      const card = document.querySelector(".alert-card");
      button("dismiss").click();
      expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
      expect(card?.classList.contains("alert-dismissing")).toBe(true);
      if (finish === "animationend") card?.dispatchEvent(new Event("animationend"));
      await vi.advanceTimersByTimeAsync(300);
      card?.dispatchEvent(new Event("animationend"));
      expect(dismissA).toHaveBeenCalledOnce();
      expect(win.hide).toHaveBeenCalledOnce();
      expect(loopback.electron.ipcRenderer.send.mock.calls.map(([, payload]) => payload)).toEqual([
        { id: eventA.id, epoch: latestWire().epoch, phase: "begin" },
        { id: eventA.id, epoch: latestWire().epoch, phase: "finish" },
      ]);
    },
  );

  it("removes obsolete animation listeners and fallback timers on delivery and unload", async () => {
    const { api, cancel, replace, dismissA, win } = await setup();
    const card = document.querySelector(".alert-card");
    if (card === null) throw new Error("Missing card");
    const remove = vi.spyOn(card, "removeEventListener");
    button("dismiss").click();
    await replace();
    deliver(latestWire());
    const hideCount = win.hide.mock.calls.length;
    card.dispatchEvent(new Event("animationend"));
    await vi.advanceTimersByTimeAsync(300);
    expect(remove).toHaveBeenCalledWith("animationend", expect.any(Function));
    expect(dismissA).not.toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(hideCount);
    expect(cancel).toHaveBeenCalledOnce();
    expect(loopback.electron.ipcRenderer.send).toHaveBeenCalledOnce();
    api.alert.notifyDismissed(asTestEventId("alert-A"));
    window.dispatchEvent(new Event("unload"));
    await vi.advanceTimersByTimeAsync(300);
    expect(
      loopback.electron.ipcRenderer.send.mock.calls.map(
        ([, payload]) => payload.As<{ phase: string }>().phase,
      ),
    ).toEqual(["begin", "begin"]);
  });

  it.each(["animationend", "fallback"] as const)(
    "preserves successful own-card join exit via %s without dismissal cancellation",
    async (finish) => {
      // Given the actual main, serialized preload and renderer in one page context.
      const { api, cancel, eventA, dismissA, win, wireA } = await setup();
      const card = alertCard();
      const dismiss = api.alert.notifyDismissed;
      // When the own-card join succeeds.
      button("join").click();
      await flush();
      // Then the existing exit animation runs while main stays visible.
      expect(card.classList.contains("alert-dismissing")).toBe(true);
      expect(win.visible).toBe(true);
      expect(win.hide).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
      dismiss(eventA.id);
      button("dismiss").click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(loopback.electron.ipcRenderer.send).not.toHaveBeenCalled();
      if (finish === "animationend") card.dispatchEvent(new Event("animationend"));
      else {
        await vi.advanceTimersByTimeAsync(299);
        expect(win.hide).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(300);
      card.dispatchEvent(new Event("animationend"));
      expect(win.hide).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
      expect(dismissA).not.toHaveBeenCalled();
      expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual([
        [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "finish" }],
      ]);
    },
  );

  it.each([true, false])(
    "keeps same-ID B safe when it replaces a joined exit (B delivered: %s)",
    async (delivered) => {
      // Given an A card already completing its successful join animation.
      const { eventA, cancel, replace, dismissA, win, wireA } = await setup();
      const card = alertCard();
      const remove = vi.spyOn(card, "removeEventListener");
      button("join").click();
      await flush();
      expect(card.classList.contains("alert-dismissing")).toBe(true);
      // When main reuses the window for the same ID before or after B delivery.
      const dismissB = await replace();
      if (delivered) deliver(latestWire());
      const hideCount = win.hide.mock.calls.length;
      card.dispatchEvent(new Event("animationend"));
      await vi.advanceTimersByTimeAsync(300);
      // Then A's obsolete finish cannot consume B or add cancellation/callbacks.
      expect(win.hide).toHaveBeenCalledTimes(hideCount);
      expect(win.visible).toBe(true);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
      expect(dismissA).not.toHaveBeenCalled();
      expect(dismissB).not.toHaveBeenCalled();
      expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual(
        delivered
          ? []
          : [
              [
                IPC_CHANNELS.ALERT_DISMISSED,
                { id: eventA.id, epoch: wireA.epoch, phase: "finish" },
              ],
            ],
      );
      if (delivered) expect(remove).toHaveBeenCalledWith("animationend", expect.any(Function));
      else deliver(latestWire());
      expect(alertCard().classList.contains("alert-dismissing")).toBe(false);
      expect(button("join").disabled).toBe(false);
    },
  );

  it("captures the joining card before same-ID main replacement is delivered", async () => {
    // Given an unresolved A opener and a retained originating card.
    const pending = Promise.withResolvers<void>();
    loopback.electron.shell.openExternal.mockReturnValueOnce(pending.promise);
    const { eventA, cancel, replace, dismissA, win, wireA } = await setup();
    const card = alertCard();
    button("join").click();
    await flush();
    const dismissB = await replace();
    const hideCount = win.hide.mock.calls.length;
    // When A succeeds after main clears its DOM, but before B reaches the page.
    pending.resolve();
    await flush();
    // Then the captured A node animates rather than immediately finishing or touching B.
    expect(card.classList.contains("alert-dismissing")).toBe(true);
    expect(loopback.electron.ipcRenderer.send).not.toHaveBeenCalled();
    card.dispatchEvent(new Event("animationend"));
    await vi.advanceTimersByTimeAsync(300);
    expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual([
      [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "finish" }],
    ]);
    expect(win.hide).toHaveBeenCalledTimes(hideCount);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
    expect(dismissA).not.toHaveBeenCalled();
    expect(dismissB).not.toHaveBeenCalled();
    deliver(latestWire());
    expect(alertCard().classList.contains("alert-dismissing")).toBe(false);
  });

  it("keeps explicit dismissal first when an in-flight renderer join succeeds", async () => {
    // Given a renderer join whose native opener is still pending.
    const pending = Promise.withResolvers<void>();
    loopback.electron.shell.openExternal.mockReturnValueOnce(pending.promise);
    const { eventA, cancel, dismissA, win, wireA } = await setup();
    const card = alertCard();
    button("join").click();
    await flush();
    // When explicit dismissal wins before the opener succeeds.
    button("dismiss").click();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
    pending.resolve();
    await flush();
    // Then success does not change the accepted reason or start a second exit.
    expect(win.hide).not.toHaveBeenCalled();
    expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual([
      [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "begin" }],
    ]);
    card.dispatchEvent(new Event("animationend"));
    await vi.advanceTimersByTimeAsync(300);
    expect(win.hide).toHaveBeenCalledOnce();
    expect(dismissA).toHaveBeenCalledOnce();
    expect(cancel.mock.calls).toEqual([[eventA.id], [eventA.id]]);
    expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual([
      [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "begin" }],
      [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "finish" }],
    ]);
  });

  it("finishes a successful own-ID join immediately when its card is missing", async () => {
    // Given a delivered origin whose card is no longer present.
    const { api, eventA, cancel, dismissA, win, wireA } = await setup();
    alertCard().remove();
    // When its captured main-world join succeeds.
    expect((await api.app.joinMeeting(eventA.id)).ok).toBe(true);
    // Then the joined finish closes it without an explicit begin or callback.
    expect(win.hide).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
    expect(dismissA).not.toHaveBeenCalled();
    expect(loopback.electron.ipcRenderer.send.mock.calls).toEqual([
      [IPC_CHANNELS.ALERT_DISMISSED, { id: eventA.id, epoch: wireA.epoch, phase: "finish" }],
    ]);
  });

  it.each([false, true])(
    "invalidates a joined exit on unload (destroyed: %s)",
    async (destroyed) => {
      // Given a successfully joined card with its exit still pending.
      const { api, eventA, cancel, dismissA, win } = await setup();
      const card = alertCard();
      const remove = vi.spyOn(card, "removeEventListener");
      const dismiss = api.alert.notifyDismissed;
      button("join").click();
      await flush();
      expect(card.classList.contains("alert-dismissing")).toBe(true);
      // When the native window/page is torn down before completion.
      if (destroyed) destroyWindow?.();
      window.dispatchEvent(new Event("unload"));
      dismiss(eventA.id);
      card.dispatchEvent(new Event("animationend"));
      await vi.advanceTimersByTimeAsync(300);
      // Then the listener/fallback cannot finish or cancel again after teardown.
      expect(remove).toHaveBeenCalledWith("animationend", expect.any(Function));
      expect(loopback.electron.ipcRenderer.send).not.toHaveBeenCalled();
      expect(win.hide).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledExactlyOnceWith(eventA.id);
      expect(dismissA).not.toHaveBeenCalled();
    },
  );

  it("invalidates an in-flight opener and dismissal on destruction without cancellation", async () => {
    const pending = Promise.withResolvers<void>();
    loopback.electron.shell.openExternal.mockReturnValueOnce(pending.promise);
    const { api, eventA, cancel, dismissA, win } = await setup();
    button("join").click();
    await flush();
    const dismiss = api.alert.notifyDismissed;
    const oldCard = document.querySelector(".alert-card");
    destroyWindow?.();
    window.dispatchEvent(new Event("unload"));
    dismiss(eventA.id);
    oldCard?.dispatchEvent(new Event("animationend"));
    pending.reject(new Error("Destroyed opener"));
    await flush();
    expect(cancel).not.toHaveBeenCalled();
    expect(dismissA).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(document.getElementById("join-error")).toBeNull();
  });
});
