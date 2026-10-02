import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/domain/entities/result.js";
import type { Api } from "../../src/preload/index.js";
import {
  installMainWorldApi,
  type AlertActions,
  type AlertSubscriber,
} from "../../src/preload/main-world-api.js";
import type { AlertPayload } from "../../src/shared/alert.js";
import { asTestEventId, asTestIsoUtc } from "../helpers/test-utils.js";

const payload: AlertPayload = {
  id: asTestEventId("origin"),
  title: "Origin",
  startDate: asTestIsoUtc("2026-10-02T10:00:00Z"),
  endDate: asTestIsoUtc("2026-10-02T10:30:00Z"),
  calendarName: "Work",
  isAllDay: false,
  hasMeetUrl: true,
};

function createActions() {
  return {
    join: vi.fn<Api["app"]["joinMeeting"]>().mockResolvedValue(ok(undefined)),
    begin: vi.fn<AlertActions["begin"]>(),
    finish: vi.fn<AlertActions["finish"]>(),
  };
}

function setup() {
  const unused = (): never => {
    throw new Error("Unexpected base API call");
  };
  const base: Omit<Api, "alert"> = {
    calendar: {
      getEvents: unused,
      requestPermission: unused,
      getPermissionStatus: unused,
      disconnect: unused,
      getUiState: unused,
      onResultUpdated: unused,
    },
    window: { setHeight: unused },
    app: {
      openExternal: unused,
      joinMeeting: vi.fn<Api["app"]["joinMeeting"]>().mockResolvedValue(ok(undefined)),
      getVersion: unused,
    },
    settings: { get: unused, set: unused, onChanged: unused },
  };
  let delivery: Parameters<AlertSubscriber>[0] | null = null;
  const stop = vi.fn();
  const subscribe = vi.fn<AlertSubscriber>((callback) => {
    delivery = callback;
    return stop;
  });
  installMainWorldApi(base, subscribe);
  const api = Reflect.get(globalThis, "api").As<Api>();
  const received = vi.fn<(data: AlertPayload) => void>();
  const leave = api.alert.onShowAlert(received);
  const actions = createActions();
  const card = document.createElement("div");
  card.className = "alert-card";
  document.body.append(card);
  const deliver = (data = payload, nextActions: AlertActions = actions): void => {
    if (delivery === null) throw new Error("Missing alert subscription");
    delivery(data, nextActions);
  };
  return { api, base, actions, card, deliver, received, subscribe, stop, leave };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("api", undefined);
  document.body.replaceChildren();
});
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  expect(vi.getTimerCount()).toBe(0);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("main-world alert controller DOM lifecycle", () => {
  it.each(["animationend", "fallback"] as const)(
    "finishes an own-card successful join once via %s without beginning dismissal",
    async (completion) => {
      // Given a directly installed controller with a real DOM card.
      const { api, actions, card, deliver } = setup();
      const result = ok(undefined);
      actions.join.mockResolvedValue(result);
      deliver();
      // When the own-card action succeeds and an explicit action overlaps.
      expect(await api.app.joinMeeting(payload.id)).toBe(result);
      expect(await api.app.joinMeeting(payload.id)).toBe(result);
      api.alert.notifyDismissed(payload.id);
      // Then the shared animation lifecycle sends only one originating finish.
      expect(card.classList.contains("alert-dismissing")).toBe(true);
      expect(actions.begin).not.toHaveBeenCalled();
      expect(actions.finish).not.toHaveBeenCalled();
      if (completion === "animationend") card.dispatchEvent(new Event("animationend"));
      else {
        await vi.advanceTimersByTimeAsync(299);
        expect(actions.finish).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(300);
      card.dispatchEvent(new Event("animationend"));
      expect(actions.finish).toHaveBeenCalledExactlyOnceWith(payload.id);
    },
  );

  it.each([
    ["failed own-ID", payload.id, err("Opener failed")],
    ["successful other-ID", "other", ok(undefined)],
  ] as const)("keeps a %s join result unchanged without exit", async (_kind, id, result) => {
    // Given a delivered controller whose join returns a typed result.
    const { api, actions, card, deliver } = setup();
    actions.join.mockResolvedValueOnce(result);
    deliver();
    // When a failed or unrelated join completes.
    expect(await api.app.joinMeeting(id)).toBe(result);
    // Then its card remains available without an exit timer or dismissal.
    expect(card.classList.contains("alert-dismissing")).toBe(false);
    expect(actions.begin).not.toHaveBeenCalled();
    expect(actions.finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the card captured before await rather than a later DOM replacement", async () => {
    // Given a pending originating join and a different card inserted without delivery.
    const { api, actions, card, deliver } = setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<Api["app"]["joinMeeting"]>>>();
    actions.join.mockReturnValueOnce(pending.promise);
    deliver();
    const joined = api.app.joinMeeting(payload.id);
    const replacement = document.createElement("div");
    replacement.className = "alert-card";
    card.replaceWith(replacement);
    // When the originating join succeeds in the still-active controller.
    pending.resolve(ok(undefined));
    await joined;
    // Then only its captured card animates and completes the originating action.
    expect(card.classList.contains("alert-dismissing")).toBe(true);
    expect(replacement.classList.contains("alert-dismissing")).toBe(false);
    expect(actions.finish).not.toHaveBeenCalled();
    card.dispatchEvent(new Event("animationend"));
    expect(actions.finish).toHaveBeenCalledExactlyOnceWith(payload.id);
    expect(actions.begin).not.toHaveBeenCalled();
  });

  it.each(["delivery", "unsubscribe", "unload"] as const)(
    "invalidates the joined animation listener and fallback on %s",
    async (invalidation) => {
      // Given a successful joined exit whose DOM completion is still pending.
      const { api, actions, card, deliver, leave } = setup();
      deliver();
      const dismiss = api.alert.notifyDismissed;
      await api.app.joinMeeting(payload.id);
      expect(card.classList.contains("alert-dismissing")).toBe(true);
      const replacement = createActions();
      const invalidate = {
        delivery: () => deliver({ ...payload, title: "Replacement" }, replacement),
        unsubscribe: leave,
        unload: () => window.dispatchEvent(new Event("unload")),
      };
      // When its origin is invalidated before either completion signal.
      invalidate[invalidation]();
      dismiss(payload.id);
      card.dispatchEvent(new Event("animationend"));
      await vi.advanceTimersByTimeAsync(300);
      // Then neither the old nor replacement action can finish or begin from stale work.
      expect(actions.begin).not.toHaveBeenCalled();
      expect(actions.finish).not.toHaveBeenCalled();
      expect(replacement.begin).not.toHaveBeenCalled();
      expect(replacement.finish).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["animationend", "fallback"] as const)(
    "keeps explicit dismissal first over an in-flight join via %s",
    async (completion) => {
      // Given a pending join before explicit dismissal accepts its reason.
      const { api, actions, card, deliver } = setup();
      const pending = Promise.withResolvers<Awaited<ReturnType<Api["app"]["joinMeeting"]>>>();
      actions.join.mockReturnValueOnce(pending.promise);
      deliver();
      const joined = api.app.joinMeeting(payload.id);
      // When explicit dismissal wins and the join subsequently succeeds.
      api.alert.notifyDismissed(payload.id);
      api.alert.notifyDismissed(payload.id);
      pending.resolve(ok(undefined));
      await joined;
      // Then only the original explicit lifecycle completes.
      expect(actions.begin).toHaveBeenCalledExactlyOnceWith(payload.id);
      expect(card.classList.contains("alert-dismissing")).toBe(true);
      if (completion === "animationend") card.dispatchEvent(new Event("animationend"));
      await vi.advanceTimersByTimeAsync(300);
      expect(actions.finish).toHaveBeenCalledExactlyOnceWith(payload.id);
    },
  );

  it.each(["join", "dismiss"] as const)(
    "finishes %s immediately when the DOM card is missing",
    async (action) => {
      // Given a delivered controller whose DOM has no alert card.
      const { api, actions, card, deliver } = setup();
      deliver();
      card.remove();
      // When the originating exit is requested.
      if (action === "join") await api.app.joinMeeting(payload.id);
      else api.alert.notifyDismissed(payload.id);
      // Then it finishes without a timer, with begin reserved for explicit dismissal.
      expect(actions.finish).toHaveBeenCalledExactlyOnceWith(payload.id);
      expect(actions.begin).toHaveBeenCalledTimes(action === "dismiss" ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("shares one subscription and installs captured actions before observer delivery", async () => {
    // Given two observers of one installer and an available non-alert join.
    const { api, base, actions, deliver, received, subscribe, stop, leave } = setup();
    await api.app.joinMeeting(payload.id);
    const retained: Array<Api["app"]["joinMeeting"]> = [];
    const leaveSecond = api.alert.onShowAlert(() => {
      retained.push(api.app.joinMeeting);
    });
    // When the origin is delivered and one observer leaves.
    deliver();
    leaveSecond();
    // Then delivery used installed origin actions and the remaining observer keeps its subscription.
    expect(base.app.joinMeeting).toHaveBeenCalledExactlyOnceWith(payload.id);
    const captured = retained[0];
    expect(captured).not.toBe(base.app.joinMeeting);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledExactlyOnceWith(payload);
    expect(stop).not.toHaveBeenCalled();
    if (captured === undefined) throw new Error("Missing captured join");
    await captured(payload.id);
    expect(actions.join).toHaveBeenCalledExactlyOnceWith(payload.id);
    leave();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("ignores retained delivery and new observers after unload", () => {
    // Given a subscribed installer with a retained upstream delivery callback.
    const { api, deliver, received, subscribe, stop } = setup();
    window.dispatchEvent(new Event("unload"));
    const late = vi.fn();
    // When the unloaded page receives old work and attempts to resubscribe.
    deliver();
    api.alert.onShowAlert(late)();
    // Then it remains unsubscribed and no observer receives the payload.
    expect(stop).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });
});
