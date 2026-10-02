import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AlertPayload } from "../../src/shared/alert.js";
import type { Result } from "../../src/domain/entities/result.js";
import { asTestEventId, asTestIsoUtc } from "../helpers/test-utils.js";

/**
 * Integration-style tests for alert Join + Dismiss wiring against the real
 * alert renderer module (with stubbed window.api).
 */
describe("alert join and dismiss", () => {
  let onShowAlert: ((data: AlertPayload) => void) | null = null;
  const notifyDismissed = vi.fn();
  const joinMeeting = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const unsubscribe = vi.fn();
  let joinAction = joinMeeting;
  let dismissAction = notifyDismissed;
  const documentListeners: Array<{
    readonly type: string;
    readonly listener: EventListenerOrEventListenerObject;
  }> = [];

  beforeEach(async () => {
    vi.resetModules();
    onShowAlert = null;
    notifyDismissed.mockReset();
    joinMeeting.mockReset();
    joinMeeting.mockResolvedValue({ ok: true, value: undefined });
    unsubscribe.mockReset();
    joinAction = joinMeeting;
    dismissAction = notifyDismissed;
    const addListener = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      documentListeners.push({ type, listener });
      addListener(type, listener, options);
    });
    // Isolate document listeners so re-imports do not stack click/keydown handlers.
    document.body.replaceWith(document.createElement("body"));
    document.body.innerHTML = '<div id="app"></div>';

    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        alert: {
          onShowAlert: (cb: (data: AlertPayload) => void) => {
            onShowAlert = cb;
            return () => {
              onShowAlert = null;
              unsubscribe();
            };
          },
          get notifyDismissed() {
            return dismissAction;
          },
        },
        app: {
          get joinMeeting() {
            return joinAction;
          },
        },
      },
    });

    await import("../../src/renderer/alert/index.js");
    document.dispatchEvent(new Event("DOMContentLoaded"));
  });

  afterEach(() => {
    window.dispatchEvent(new Event("unload"));
    for (const { type, listener } of documentListeners)
      document.removeEventListener(type, listener);
    documentListeners.length = 0;
    vi.restoreAllMocks();
  });

  function showAlert(overrides: Partial<AlertPayload> = {}): void {
    const payload: AlertPayload = {
      id: asTestEventId("evt-alert-1"),
      title: "Standup",
      startDate: asTestIsoUtc(new Date().toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 30 * 60_000).toISOString()),
      calendarName: "Work",
      isAllDay: false,
      hasMeetUrl: true,
      ...overrides,
    };
    expect(onShowAlert).toBeTypeOf("function");
    if (onShowAlert === null) throw new Error("Missing alert subscription");
    onShowAlert(payload);
  }

  function button(action: "join" | "dismiss"): HTMLButtonElement {
    const element = document.querySelector(`[data-action="${action}"]`);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing ${action} button`);
    return element;
  }

  it("renders Join when hasMeetUrl is true", () => {
    showAlert({ hasMeetUrl: true });
    expect(document.querySelector('[data-action="join"]')).not.toBeNull();
    expect(document.querySelector('[data-action="dismiss"]')).not.toBeNull();
  });

  it("omits Join when hasMeetUrl is false", () => {
    showAlert({ hasMeetUrl: false });
    expect(document.querySelector('[data-action="join"]')).toBeNull();
  });

  it("Join calls app.joinMeeting with event id without a second dismissal", async () => {
    showAlert({ id: asTestEventId("evt-join-me"), hasMeetUrl: true });
    const joinBtn = document.querySelector<HTMLButtonElement>('[data-action="join"]');
    expect(joinBtn).not.toBeNull();
    joinBtn!.click();

    await vi.waitFor(() => {
      expect(joinMeeting).toHaveBeenCalledWith("evt-join-me");
    });
    await Promise.resolve();
    expect(notifyDismissed).not.toHaveBeenCalled();
    const card = document.querySelector(".alert-card");
    expect(card).not.toBeNull();
    card?.dispatchEvent(new Event("animationend"));
  });

  it("Join failure keeps the alert open with an error banner", async () => {
    joinMeeting.mockResolvedValue({ ok: false, error: "Blocked by allowlist" });
    showAlert({ id: asTestEventId("evt-join-fail"), hasMeetUrl: true });
    const joinBtn = document.querySelector<HTMLButtonElement>('[data-action="join"]');
    expect(joinBtn).not.toBeNull();
    joinBtn!.click();

    await vi.waitFor(() => {
      expect(joinMeeting).toHaveBeenCalledWith("evt-join-fail");
    });
    await vi.waitFor(() => {
      const banner = document.getElementById("join-error");
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("Blocked by allowlist");
    });
    expect(notifyDismissed).not.toHaveBeenCalled();
    const btnAfter = document.querySelector<HTMLButtonElement>('[data-action="join"]');
    expect(btnAfter?.disabled).toBe(false);
    expect(btnAfter?.textContent).toContain("Join Meeting");
  });

  it("Join failure with empty error uses a generic message", async () => {
    joinMeeting.mockResolvedValue({ ok: false, error: "" });
    showAlert({ id: asTestEventId("evt-join-empty"), hasMeetUrl: true });
    document.querySelector<HTMLButtonElement>('[data-action="join"]')!.click();

    await vi.waitFor(() => {
      const banner = document.getElementById("join-error");
      expect(banner?.textContent).toContain("Could not open the meeting");
    });
    expect(notifyDismissed).not.toHaveBeenCalled();
  });

  it("Dismiss notifies main without joining", async () => {
    showAlert({ id: asTestEventId("evt-dismiss"), hasMeetUrl: true });
    document.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.click();

    await vi.waitFor(() => {
      expect(notifyDismissed).toHaveBeenCalledWith("evt-dismiss");
    });
    const card = document.querySelector(".alert-card");
    expect(card).not.toBeNull();
    card?.dispatchEvent(new Event("animationend"));
    expect(joinMeeting).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "drops late join success after replacement (same ID: %s)",
    async (sameId) => {
      // Given one renderer context and an unresolved originating join.
      const pending = Promise.withResolvers<Result<void, string>>();
      joinMeeting.mockReturnValueOnce(pending.promise);
      showAlert();
      button("join").click();
      showAlert({
        id: asTestEventId(sameId ? "evt-alert-1" : "evt-alert-2"),
        title: "Replacement",
      });
      const replacement = button("join");
      // When the originating join succeeds after replacement.
      pending.resolve({ ok: true, value: undefined });
      await pending.promise;
      await Promise.resolve();
      // Then the replacement is still actionable, with no dismissal side effect.
      expect(notifyDismissed).not.toHaveBeenCalled();
      expect(replacement.disabled).toBe(false);
      expect(document.querySelector(".alert-card.alert-dismissing")).toBeNull();
    },
  );

  it.each([true, false])(
    "drops late join failure while the replacement is joining (same ID: %s)",
    async (sameId) => {
      // Given separate joins in a single renderer context.
      const old = Promise.withResolvers<Result<void, string>>();
      const current = Promise.withResolvers<Result<void, string>>();
      joinMeeting.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      showAlert();
      button("join").click();
      showAlert({
        id: asTestEventId(sameId ? "evt-alert-1" : "evt-alert-2"),
        title: "Replacement",
      });
      button("join").click();
      // When only the obsolete join fails.
      old.resolve({ ok: false, error: "Obsolete failure" });
      await old.promise;
      await Promise.resolve();
      // Then no replacement error or button mutation occurs.
      expect(document.getElementById("join-error")).toBeNull();
      expect(button("join").disabled).toBe(true);
      current.resolve({ ok: true, value: undefined });
      await current.promise;
    },
  );

  it("uses the function captured on display rather than a later facade getter", async () => {
    // Given a presentation whose immutable actions have been installed.
    const joinA = vi.fn().mockResolvedValue({ ok: false, error: "A failure" });
    const dismissA = vi.fn();
    joinAction = joinA;
    dismissAction = dismissA;
    showAlert();
    joinAction = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    dismissAction = vi.fn();
    // When its action runs before the replacement is delivered.
    button("join").click();
    await Promise.resolve();
    button("dismiss").click();
    // Then it keeps its originating functions.
    expect(joinA).toHaveBeenCalledExactlyOnceWith("evt-alert-1");
    expect(dismissA).toHaveBeenCalledExactlyOnceWith("evt-alert-1");
    expect(joinAction).not.toHaveBeenCalled();
    expect(dismissAction).not.toHaveBeenCalled();
  });

  it("reenables the current failed join for retry", async () => {
    // Given a current failure with a subsequent successful retry.
    joinMeeting.mockResolvedValueOnce({ ok: false, error: "Try again" });
    showAlert();
    button("join").click();
    await Promise.resolve();
    expect(button("join").disabled).toBe(false);
    // When the same button is retried.
    button("join").click();
    await Promise.resolve();
    // Then both attempts use the same ID and neither adds a dismissal cancellation.
    expect(joinMeeting).toHaveBeenCalledTimes(2);
    expect(notifyDismissed).not.toHaveBeenCalled();
  });

  it("invalidates joins, keyboard actions, and the show subscription on unload", async () => {
    // Given an unresolved join and a retained show callback.
    const pending = Promise.withResolvers<Result<void, string>>();
    joinMeeting.mockReturnValueOnce(pending.promise);
    showAlert();
    button("join").click();
    const retainedShow = onShowAlert;
    // When the page unloads and the old join fails.
    window.dispatchEvent(new Event("unload"));
    pending.resolve({ ok: false, error: "After unload" });
    await pending.promise;
    await Promise.resolve();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    retainedShow?.({
      id: asTestEventId("late"),
      title: "Late",
      startDate: asTestIsoUtc("2026-10-02T10:00:00Z"),
      endDate: asTestIsoUtc("2026-10-02T10:30:00Z"),
      calendarName: "Work",
      isAllDay: false,
    });
    // Then teardown removes the subscription and makes all retained work inert.
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(document.getElementById("join-error")).toBeNull();
    expect(document.querySelector(".alert-title")?.textContent).toBe("Standup");
    expect(notifyDismissed).not.toHaveBeenCalled();
  });
});
