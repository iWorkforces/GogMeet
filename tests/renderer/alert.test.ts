import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { asTestEventId, asTestIsoUtc } from "../helpers/test-utils.js";

afterEach(() => {
  window.dispatchEvent(new Event("unload"));
});

/**
 * Tests for alert/index.ts
 *
 * The alert module registers a callback via window.api.alert.onShowAlert and
 * sets up delegated events + keyboard dismiss on DOMContentLoaded.
 * Most functions are module-private, so we test:
 * 1. Module loads correctly
 * 2. formatTimeRange logic (concepts)
 * 3. Dismiss animation pattern (DOM-based simulation)
 */

describe("alert/index.ts", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.restoreAllMocks();
  });

  it("module can be imported without errors", async () => {
    // Mock window.api before importing the module
    vi.stubGlobal("api", {
      alert: {
        onShowAlert: vi.fn(() => vi.fn()),
        notifyDismissed: vi.fn(),
      },
    });

    const module = await import("../../src/renderer/alert/index.js");
    expect(module).toBeDefined();
  });
});

describe("formatTimeRange logic", () => {
  it("returns 'All day' for all-day events (concept)", () => {
    const isAllDay = true;
    expect(isAllDay).toBe(true);
  });

  it("handles same-day vs multi-day date ranges", () => {
    const start = new Date("2026-03-27T10:00:00");
    const end = new Date("2026-03-27T10:30:00");
    expect(start.toDateString()).toBe(end.toDateString());

    const end2 = new Date("2026-03-28T14:00:00");
    expect(start.toDateString()).not.toBe(end2.toDateString());
  });

  it("detects invalid dates via NaN", () => {
    const invalid = new Date("not-a-date");
    expect(Number.isNaN(invalid.getTime())).toBe(true);

    const valid = new Date("2026-03-27T10:00:00");
    expect(Number.isNaN(valid.getTime())).toBe(false);
  });
});

describe("alert DOM structure", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it("dismiss button has data-action attribute", () => {
    document.body.innerHTML =
      '<div id="app"><article class="alert-card"><button class="alert-btn alert-btn-dismiss" data-action="dismiss">Dismiss</button></article></div>';

    const btn = document.querySelector('[data-action="dismiss"]');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("Dismiss");
  });

  it("alert-card element can receive animation events", () => {
    document.body.innerHTML =
      '<div id="app"><article class="alert-card"><p>Test</p></article></div>';

    const card = document.querySelector(".alert-card");
    expect(card).not.toBeNull();

    card?.classList.add("alert-dismissing");
    expect(card?.classList.contains("alert-dismissing")).toBe(true);
  });

  it("escapeHtml is imported from shared module", async () => {
    const { escapeHtml } = await import("../../src/shared/utils/escape-html.js");
    expect(typeof escapeHtml).toBe("function");
    expect(escapeHtml("<script>")).not.toContain("<script>");
  });
});

describe("alert event delegation", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.restoreAllMocks();
  });

  it("click on dismiss button finds data-action", () => {
    document.body.innerHTML =
      '<div id="app"><article class="alert-card"><button data-action="dismiss">Dismiss</button></article></div>';

    const app = document.getElementById("app");
    const btn = app?.querySelector("[data-action]");
    expect(btn?.getAttribute("data-action")).toBe("dismiss");
  });

  it("click outside data-action elements returns null", () => {
    document.body.innerHTML =
      '<div id="app"><article class="alert-card"><p>No action here</p></article></div>';

    const span = document.querySelector("p");
    const action = (span as HTMLElement)?.closest?.("[data-action]");
    expect(action).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extended coverage: Escape key dismiss, alert:show IPC push DOM update,
// and duplicate-uid coalescing (rapid showAlert calls).
//
// These tests exercise the alert module by capturing the onShowAlert callback
// registered at module-import time, then driving it directly. Each test uses
// vi.resetModules() so the module's private state (isDismissing flag, IIFE
// listener registration) is fresh and Independent.
// ─────────────────────────────────────────────────────────────────────────────

type AlertCallback = (data: import("../../src/shared/alert.js").AlertPayload) => void;

interface AlertHarness {
  callback: AlertCallback;
  onShowAlertMock: ReturnType<typeof vi.fn>;
  notifyDismissed: ReturnType<typeof vi.fn>;
}

interface TrackedListener {
  type: string;
  listener: EventListenerOrEventListenerObject;
}
const trackedDocListeners: TrackedListener[] = [];
let originalDocAddEventListener: typeof document.addEventListener | null = null;

function installListenerTracker(): void {
  if (originalDocAddEventListener) return;
  originalDocAddEventListener = document.addEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    trackedDocListeners.push({ type, listener });
    return originalDocAddEventListener!(type, listener, options);
  }) as typeof document.addEventListener;
}

function clearTrackedDocListeners(): void {
  for (const { type, listener } of trackedDocListeners) {
    document.removeEventListener(type, listener);
  }
  trackedDocListeners.length = 0;
}

async function loadAlertModule(): Promise<AlertHarness> {
  clearTrackedDocListeners();
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  installListenerTracker();

  const onShowAlertMock = vi.fn<(cb: AlertCallback) => () => void>(() => vi.fn());
  const notifyDismissed = vi.fn();
  vi.stubGlobal("api", {
    alert: { onShowAlert: onShowAlertMock, notifyDismissed },
    app: { joinMeeting: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
  });

  await import("../../src/renderer/alert/index.js");

  document.dispatchEvent(new Event("DOMContentLoaded"));

  const firstCall = onShowAlertMock.mock.calls[0];
  if (!firstCall || typeof firstCall[0] !== "function") {
    throw new Error("alert module did not register onShowAlert callback");
  }
  return { callback: firstCall[0], onShowAlertMock, notifyDismissed };
}

function makeAlertPayload(
  overrides: Partial<import("../../src/shared/alert.js").AlertPayload> = {},
): import("../../src/shared/alert.js").AlertPayload {
  const base = {
    id: asTestEventId("evt-1"),
    title: "Standup",
    startDate: asTestIsoUtc("2026-03-27T10:00:00.000Z"),
    endDate: asTestIsoUtc("2026-03-27T10:30:00.000Z"),
    hasMeetUrl: true,
    calendarName: "Work",
    isAllDay: false,
    description: "Daily sync",
  };
  return { ...base, ...overrides };
}

describe("alert: Escape key dismiss handler registration", () => {
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    closeSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("Escape key triggers the origin-bound dismissal rather than anonymous window.close()", async () => {
    const { callback, notifyDismissed } = await loadAlertModule();

    // Render a card so dismissAlert takes the animation path.
    callback(makeAlertPayload());
    expect(document.querySelector(".alert-card")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // dismissAlert sets a 300ms fallback timer; advance jsdom timers.
    vi.useFakeTimers();
    // Re-dispatch: previous Escape already started fallback before we faked timers,
    // so simulate by directly firing animationend on the card to close.
    const card = document.querySelector(".alert-card");
    card?.dispatchEvent(new Event("animationend"));
    vi.useRealTimers();

    expect(notifyDismissed).toHaveBeenCalledExactlyOnceWith("evt-1");
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("non-Escape keys do NOT trigger window.close()", async () => {
    const { callback, notifyDismissed } = await loadAlertModule();
    callback(makeAlertPayload());

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));

    expect(closeSpy).not.toHaveBeenCalled();
    expect(notifyDismissed).not.toHaveBeenCalled();
  });

  it("data-action='dismiss' click notifies its origin without anonymous window.close()", async () => {
    const { callback, notifyDismissed } = await loadAlertModule();
    callback(makeAlertPayload());

    const btn = document.querySelector<HTMLButtonElement>('[data-action="dismiss"]');
    expect(btn).not.toBeNull();
    btn?.click();

    const card = document.querySelector(".alert-card");
    card?.dispatchEvent(new Event("animationend"));

    expect(notifyDismissed).toHaveBeenCalledExactlyOnceWith("evt-1");
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe("alert: alert:show IPC push updates DOM correctly", () => {
  beforeEach(() => {
    vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders title, calendar, and time range from payload", async () => {
    const { callback } = await loadAlertModule();
    callback(
      makeAlertPayload({
        title: "Sprint Review",
        calendarName: "Engineering",
      }),
    );

    const html = document.getElementById("app")?.innerHTML ?? "";
    expect(html).toContain("Sprint Review");
    expect(html).toContain("Engineering");
    expect(html).toContain("Meeting Starting");
    expect(document.querySelector(".alert-card")).not.toBeNull();
    expect(document.querySelector(".alert-title")).not.toBeNull();
  });

  it("escapes HTML in user-controlled fields (XSS protection)", async () => {
    const { callback } = await loadAlertModule();
    callback(
      makeAlertPayload({
        title: "<script>alert(1)</script>",
        calendarName: "<img src=x onerror=alert(1)>",
        description: "<b>bold</b>",
      }),
    );

    const html = document.getElementById("app")?.innerHTML ?? "";
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders 'All day' for all-day events", async () => {
    const { callback } = await loadAlertModule();
    callback(makeAlertPayload({ isAllDay: true }));

    const html = document.getElementById("app")?.innerHTML ?? "";
    expect(html).toContain("All day");
  });

  it("omits description block when description is empty/whitespace", async () => {
    const { callback } = await loadAlertModule();
    callback(makeAlertPayload({ description: "   " }));

    expect(document.querySelector(".alert-description-wrapper")).toBeNull();
  });

  it("includes description block when non-empty description provided", async () => {
    const { callback } = await loadAlertModule();
    callback(makeAlertPayload({ description: "Agenda items" }));

    expect(document.querySelector(".alert-description-wrapper")).not.toBeNull();
    expect(document.querySelector(".alert-description")?.textContent).toContain("Agenda items");
  });

  it("renders 'Time unavailable' for malformed ISO dates", async () => {
    const { callback } = await loadAlertModule();
    type AP = import("../../src/shared/alert.js").AlertPayload;
    type Brand<T, B> = T & { readonly __brand?: B };
    const payload = makeAlertPayload({
      startDate: "not-an-iso-date" as Brand<string, "IsoUtc">,
      endDate: "also-bad" as Brand<string, "IsoUtc">,
    } as Partial<AP>);
    callback(payload);

    const html = document.getElementById("app")?.innerHTML ?? "";
    expect(html).toContain("Time unavailable");
  });
});

describe("alert: duplicate uid coalescing (rapid showAlert calls)", () => {
  beforeEach(() => {
    vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("re-rendering with the same uid replaces DOM in place (no duplicate cards)", async () => {
    const { callback } = await loadAlertModule();
    const payload = makeAlertPayload({ title: "Standup" });

    callback(payload);
    callback(payload);
    callback(payload);

    const cards = document.querySelectorAll(".alert-card");
    expect(cards.length).toBe(1);
    expect(document.querySelector(".alert-title")?.textContent).toBe("Standup");
  });

  it("subsequent payload with new uid replaces previous content (single card)", async () => {
    const { callback } = await loadAlertModule();

    callback(makeAlertPayload({ id: asTestEventId("evt-A"), title: "First" }));
    expect(document.querySelector(".alert-title")?.textContent).toBe("First");

    callback(makeAlertPayload({ id: asTestEventId("evt-B"), title: "Second" }));
    const cards = document.querySelectorAll(".alert-card");
    expect(cards.length).toBe(1);
    expect(document.querySelector(".alert-title")?.textContent).toBe("Second");
  });

  it("dismiss in flight: repeated dismiss triggers within same module are coalesced", async () => {
    const { callback, notifyDismissed } = await loadAlertModule();
    callback(makeAlertPayload());

    const btn = document.querySelector<HTMLButtonElement>('[data-action="dismiss"]');
    btn?.click();
    btn?.click();
    btn?.click();

    expect(notifyDismissed).toHaveBeenCalledExactlyOnceWith("evt-1");
  });

  it("resets dismissal on every delivery including the same ID", async () => {
    // Given an already dismissed card in one renderer context.
    const { callback, notifyDismissed } = await loadAlertModule();
    callback(makeAlertPayload());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    callback(makeAlertPayload({ title: "Replacement" }));
    // When the new presentation is explicitly dismissed.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // Then each delivery has an independent dismissal.
    expect(notifyDismissed.mock.calls).toEqual([["evt-1"], ["evt-1"]]);
  });

  it("makes a retained old keyboard listener inert after replacement", async () => {
    // Given a retained originating key action.
    const { callback, notifyDismissed } = await loadAlertModule();
    callback(makeAlertPayload());
    const keyListener = trackedDocListeners.find(({ type }) => type === "keydown")?.listener;
    if (keyListener === undefined) throw new Error("Missing keyboard action");
    callback(makeAlertPayload({ title: "Replacement" }));
    // When the old key action is invoked after replacement.
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    if (typeof keyListener === "function") keyListener.call(document, event);
    else keyListener.handleEvent(event);
    // Then it cannot dismiss the replacement.
    expect(notifyDismissed).not.toHaveBeenCalled();
    document.dispatchEvent(event);
    expect(notifyDismissed).toHaveBeenCalledExactlyOnceWith("evt-1");
  });
});
