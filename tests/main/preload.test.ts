import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/preload/index.js";
import type { AlertPayload } from "../../src/shared/alert.js";
import { err, ok } from "../../src/domain/entities/result.js";
import { As } from "../../src/shared/utils/as.js";
import { asTestEventId, asTestIsoUtc } from "../helpers/test-utils.js";

const { bridge, ipc, world } = await vi.hoisted(async () => {
  const { createContext, runInContext } = await import("node:vm");
  const world = { current: createContext({}) };
  const bridge = {
    exposeInMainWorld: vi.fn((key: string, value: object) => {
      Object.defineProperty(world.current, key, { configurable: true, value });
    }),
    executeInMainWorld: vi.fn(
      (script: {
        readonly func: (...args: readonly unknown[]) => unknown;
        readonly args?: readonly unknown[];
      }) => {
        world.current["bridgeArgs"] = script.args ?? [];
        return runInContext(`(${script.func.toString()})(...bridgeArgs)`, world.current);
      },
    ),
  };
  const ipc = {
    invoke: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
  return { bridge, ipc, world };
});

vi.mock("electron", () => ({ contextBridge: bridge, ipcRenderer: ipc }));

async function loadApi(): Promise<Api> {
  await import("../../src/preload/index.js");
  return As<Api>(world.current["api"]);
}

function payload(id = "evt-1"): AlertPayload {
  return {
    id: asTestEventId(id),
    title: "Standup",
    startDate: asTestIsoUtc("2026-10-02T10:00:00Z"),
    endDate: asTestIsoUtc("2026-10-02T10:30:00Z"),
    calendarName: "Work",
    isAllDay: false,
    hasMeetUrl: true,
  };
}

function deliver(epoch: number, data = payload()): void {
  const handler = ipc.on.mock.calls.find(([channel]) => channel === "alert:show")?.[1];
  if (typeof handler !== "function") throw new Error("No alert listener");
  handler({}, { epoch, payload: data });
}

describe("preload/index.ts", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { createContext } = await import("node:vm");
    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
    };
    world.current = createContext({
      window: target,
      document: { querySelector: () => null },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs the read-only api in the main world through a serialized bridge function", async () => {
    const api = await loadApi();
    expect(bridge.executeInMainWorld).toHaveBeenCalledOnce();
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.app)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(api.app, "joinMeeting")?.get).toBeTypeOf("function");
  });

  it("keeps the exact public namespace and method keys", async () => {
    const api = await loadApi();
    expect(Object.keys(api)).toEqual(["calendar", "window", "app", "settings", "alert"]);
    expect(Object.keys(api.calendar)).toEqual([
      "getEvents",
      "requestPermission",
      "getPermissionStatus",
      "disconnect",
      "getUiState",
      "onResultUpdated",
    ]);
    expect(Object.keys(api.window)).toEqual(["setHeight"]);
    expect(Object.keys(api.app)).toEqual(["openExternal", "joinMeeting", "getVersion"]);
    expect(Object.keys(api.settings)).toEqual(["get", "set", "onChanged"]);
    expect(Object.keys(api.alert)).toEqual(["onShowAlert", "notifyDismissed"]);
  });

  it("sends both correlated dismissal phases immediately when no card exists", async () => {
    const api = await loadApi();
    api.alert.onShowAlert(() => undefined);
    deliver(17, payload("event-123"));
    api.alert.notifyDismissed(asTestEventId("event-123"));
    expect(ipc.send.mock.calls).toEqual([
      ["alert:dismissed", { id: "event-123", epoch: 17, phase: "begin" }],
      ["alert:dismissed", { id: "event-123", epoch: 17, phase: "finish" }],
    ]);
  });

  it("does not send an uncorrelated dismissal before an alert delivery", async () => {
    const api = await loadApi();
    api.alert.notifyDismissed(asTestEventId("evt-1"));
    expect(ipc.send).not.toHaveBeenCalled();
  });

  it("finishes a successful own-ID join without beginning dismissal when no card exists", async () => {
    // Given a delivered origin and the exact successful IPC result.
    const result = ok(undefined);
    ipc.invoke.mockResolvedValueOnce(result);
    const api = await loadApi();
    api.alert.onShowAlert(() => undefined);
    deliver(18);
    // When its own join succeeds and a later explicit dismissal overlaps.
    expect(await api.app.joinMeeting("evt-1")).toBe(result);
    api.alert.notifyDismissed(asTestEventId("evt-1"));
    // Then only the origin's finish is sent, without another cancellation phase.
    expect(ipc.send.mock.calls).toEqual([
      ["alert:dismissed", { id: "evt-1", epoch: 18, phase: "finish" }],
    ]);
  });

  it.each([
    ["failed own-ID", "evt-1", err("Opener failed")],
    ["successful other-ID", "evt-2", ok(undefined)],
  ] as const)("returns a %s join unchanged without exiting the card", async (_kind, id, result) => {
    // Given a delivered origin whose action returns a typed result.
    ipc.invoke.mockResolvedValueOnce(result);
    const api = await loadApi();
    api.alert.onShowAlert(() => undefined);
    deliver(19);
    // When a failed or unrelated join completes.
    const returned = await api.app.joinMeeting(id);
    // Then the exact result is preserved and no dismissal phase is sent.
    expect(returned).toBe(result);
    expect(ipc.send).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "drops pending join exit after replacement (same ID: %s)",
    async (sameId) => {
      // Given a captured origin whose successful join is still pending.
      const pending = Promise.withResolvers<Awaited<ReturnType<Api["app"]["joinMeeting"]>>>();
      ipc.invoke.mockReturnValueOnce(pending.promise);
      const api = await loadApi();
      api.alert.onShowAlert(() => undefined);
      deliver(20);
      const joined = api.app.joinMeeting("evt-1");
      deliver(21, payload(sameId ? "evt-1" : "evt-2"));
      // When the obsolete join succeeds in the same installed world.
      const result = ok(undefined);
      pending.resolve(result);
      // Then it keeps its result but cannot finish the new presentation.
      expect(await joined).toBe(result);
      expect(ipc.send).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit dismissal first when an in-flight own join later succeeds", async () => {
    // Given a pending join and an explicit dismissal that has already finished.
    const pending = Promise.withResolvers<Awaited<ReturnType<Api["app"]["joinMeeting"]>>>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    const api = await loadApi();
    api.alert.onShowAlert(() => undefined);
    deliver(22);
    const joined = api.app.joinMeeting("evt-1");
    api.alert.notifyDismissed(asTestEventId("evt-1"));
    // When the pending join succeeds.
    pending.resolve(ok(undefined));
    await joined;
    // Then the explicit begin/finish pair remains the only exit.
    expect(ipc.send.mock.calls).toEqual([
      ["alert:dismissed", { id: "evt-1", epoch: 22, phase: "begin" }],
      ["alert:dismissed", { id: "evt-1", epoch: 22, phase: "finish" }],
    ]);
  });

  it("invalidates pending joined exit when the last subscriber leaves", async () => {
    // Given an originating action retained across unsubscribe.
    const pending = Promise.withResolvers<Awaited<ReturnType<Api["app"]["joinMeeting"]>>>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    const api = await loadApi();
    const unsubscribe = api.alert.onShowAlert(() => undefined);
    deliver(23);
    const joined = api.app.joinMeeting("evt-1");
    unsubscribe();
    // When that join succeeds after controller disposal.
    pending.resolve(ok(undefined));
    await joined;
    // Then no finish is sent for the disposed presentation.
    expect(ipc.send).not.toHaveBeenCalled();
    expect(ipc.removeListener).toHaveBeenCalledOnce();
  });

  it.each([
    ["getEvents", "calendar:get-events"],
    ["requestPermission", "calendar:request-permission"],
    ["getPermissionStatus", "calendar:permission-status"],
    ["disconnect", "calendar:disconnect"],
    ["getUiState", "calendar:ui-state"],
  ] as const)("calendar.%s invokes %s", async (method, channel) => {
    const api = await loadApi();
    await api.calendar[method]();
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it("invokes app version and settings get/set channels unchanged", async () => {
    const api = await loadApi();
    await api.app.getVersion();
    await api.settings.get();
    await api.settings.set({ openBeforeMinutes: 3 });
    expect(ipc.invoke.mock.calls).toEqual([
      ["app:get-version"],
      ["settings:get"],
      ["settings:set", { openBeforeMinutes: 3 }],
    ]);
  });

  it("setHeight sends the clamped height on the existing channel", async () => {
    const api = await loadApi();
    api.window.setHeight(350);
    api.window.setHeight(9999);
    expect(ipc.send.mock.calls).toEqual([
      ["window:set-height", { height: 350 }],
      ["window:set-height", { height: 480 }],
    ]);
  });

  it.each([
    "https://meet.google.com/abc",
    "https://calendar.google.com/event?eid=x",
    "https://accounts.google.com/signin",
    "https://zoom.us/j/1234567890",
    "https://us02web.zoom.us/j/1234567890",
    "https://acme.zoom.us/my/room",
    "https://calendly.com/someone/30min",
  ])("forwards allowed URL %s to IPC", async (url) => {
    const api = await loadApi();
    await api.app.openExternal(url);
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("app:open-external", { url });
  });

  it.each([
    "https://zoom.us.evil.com/j/1",
    "https://evil-zoom.us/j/1",
    "https://calendly.com.evil.com/x",
    "https://app.calendly.com/x",
    "http://meet.google.com/abc",
    "https://evil.example/whatever",
  ])("drops rejected URL %s without IPC", async (url) => {
    const api = await loadApi();
    expect((await api.app.openExternal(url)).ok).toBe(false);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it("rejects invalid join IDs and keeps non-alert joins as {id}", async () => {
    const api = await loadApi();
    expect((await api.app.joinMeeting("")).ok).toBe(false);
    expect(ipc.invoke).not.toHaveBeenCalled();
    await api.app.joinMeeting("evt-1");
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("app:join-meeting", { id: "evt-1" });
  });

  it("registers all pushes and removes their listeners on unsubscribe", async () => {
    const api = await loadApi();
    const unsub = [
      api.calendar.onResultUpdated(() => undefined),
      api.settings.onChanged(() => undefined),
      api.alert.onShowAlert(() => undefined),
    ];
    expect(ipc.on.mock.calls.map(([channel]) => channel)).toEqual([
      "calendar:result-updated",
      "settings:changed",
      "alert:show",
    ]);
    for (const remove of unsub) {
      expect(remove).toBeTypeOf("function");
      remove();
    }
    expect(ipc.removeListener).toHaveBeenCalledTimes(3);
    expect(Reflect.get(api, "scheduler")).toBeUndefined();
  });

  it.each([true, false])(
    "retains immutable originating join functions across delivery (same ID: %s)",
    async (sameId) => {
      // Given an API whose callbacks synchronously retain each delivery's actions.
      ipc.invoke.mockResolvedValueOnce(ok(undefined)).mockResolvedValueOnce(ok(undefined));
      const api = await loadApi();
      const retained: Array<Api["app"]["joinMeeting"]> = [];
      const callback = vi.fn((data: AlertPayload) => {
        retained.push(api.app.joinMeeting);
        expect(data).not.toHaveProperty("epoch");
        expect(data).not.toHaveProperty("meetUrl");
      });
      api.alert.onShowAlert(callback);
      const first = payload();
      deliver(11, first);
      deliver(12, payload(sameId ? "evt-1" : "evt-2"));
      // When a retained originating function runs after the newer delivery.
      const joinA = retained[0];
      const joinB = retained[1];
      if (joinA === undefined || joinB === undefined) throw new Error("Missing retained actions");
      await joinA("evt-1");
      await joinB(sameId ? "evt-1" : "evt-2");
      // Then each wire request keeps its originating epoch, and callbacks contain only the DTO.
      expect(ipc.invoke.mock.calls).toEqual([
        ["app:join-meeting", { id: "evt-1", alert: { epoch: 11 } }],
        ["app:join-meeting", { id: sameId ? "evt-1" : "evt-2", alert: { epoch: 12 } }],
      ]);
      expect(callback.mock.calls[0]).toEqual([first]);
      expect(joinA).not.toBe(joinB);
      expect(ipc.send.mock.calls).toEqual([
        ["alert:dismissed", { id: sameId ? "evt-1" : "evt-2", epoch: 12, phase: "finish" }],
      ]);
    },
  );

  it("invalidates old dismissal actions and fans out only the public payload", async () => {
    const api = await loadApi();
    const retained: Array<Api["alert"]["notifyDismissed"]> = [];
    const first = vi.fn(() => retained.push(api.alert.notifyDismissed));
    const second = vi.fn();
    api.alert.onShowAlert(first);
    const unsubscribe = api.alert.onShowAlert(second);
    deliver(21);
    unsubscribe();
    deliver(22);
    const old = retained[0];
    if (old === undefined) throw new Error("Missing dismissal action");
    old(asTestEventId("evt-1"));
    api.alert.notifyDismissed(asTestEventId("evt-1"));
    api.alert.notifyDismissed(asTestEventId("evt-1"));
    expect(second).toHaveBeenCalledExactlyOnceWith(payload());
    expect(ipc.send.mock.calls).toEqual([
      ["alert:dismissed", { id: "evt-1", epoch: 22, phase: "begin" }],
      ["alert:dismissed", { id: "evt-1", epoch: 22, phase: "finish" }],
    ]);
  });
});
