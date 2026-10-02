import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyEventsPush } from "../../src/renderer/lib/apply-events-push.js";
import type { CalendarProvenance } from "../../src/renderer/lib/apply-events-push.js";
import type { AppState } from "../../src/shared/app-state.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { AppSettings } from "../../src/domain/entities/settings.js";
import { calendarLiveOk, calendarOfflineOk } from "../../src/domain/entities/calendar-result.js";
import { createMockEvent, isoFromNow } from "../helpers/test-utils.js";

const FIXED_NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const COMPLETE_PROVENANCE: CalendarProvenance = {
  source: "live",
  completeness: "complete",
  observedAt: FIXED_NOW,
};

function loadingState(): AppState {
  return { type: "loading" };
}

function settingsWith(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("applyEventsPush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders on first call (prevState=loading) and returns a non-empty signature", () => {
    const events = [createMockEvent({ id: "e1", startDate: isoFromNow(60) })];
    const result = applyEventsPush({
      events,
      settings: settingsWith(),
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });
    expect(result.didChange).toBe(true);
    expect(result.state.type).toBe("has-events");
    expect(result.signature).not.toBe("");
  });

  it("skips re-render when post-filter signature is unchanged and prevState is has-events", () => {
    const events = [createMockEvent({ id: "e1", startDate: isoFromNow(60) })];
    const first = applyEventsPush({
      events,
      settings: settingsWith(),
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });

    const second = applyEventsPush({
      events: [...events],
      settings: settingsWith(),
      prevState: first.state,
      prevSignature: first.signature,
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: first.provenance,
    });
    expect(second.didChange).toBe(false);
    expect(second.signature).toBe(first.signature);
    expect(second.state).toBe(first.state);
  });

  it("re-renders when signature matches but prevState is NOT has-events (e.g. after error)", () => {
    const events = [createMockEvent({ id: "e1", startDate: isoFromNow(60) })];
    const first = applyEventsPush({
      events,
      settings: settingsWith(),
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });

    const errorState: AppState = { type: "error", message: "boom" };
    const second = applyEventsPush({
      events,
      settings: settingsWith(),
      prevState: errorState,
      prevSignature: first.signature,
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: first.provenance,
    });
    expect(second.didChange).toBe(true);
    expect(second.state.type).toBe("has-events");
  });

  it("re-renders when only title changes (title is part of the shared signature)", () => {
    const base = createMockEvent({ id: "e1", title: "Standup", startDate: isoFromNow(60) });
    const first = applyEventsPush({
      events: [base],
      settings: settingsWith(),
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });

    const updated = createMockEvent({
      id: "e1",
      title: "Standup (rescheduled)",
      startDate: base.startDate,
      endDate: base.endDate,
    });
    const second = applyEventsPush({
      events: [updated],
      settings: settingsWith(),
      prevState: first.state,
      prevSignature: first.signature,
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: first.provenance,
    });
    expect(second.didChange).toBe(true);
    expect(second.signature).not.toBe(first.signature);
  });

  it("treats reordered event lists as equal (sorted-by-signature)", () => {
    const a = createMockEvent({ id: "a", startDate: isoFromNow(60) });
    const b = createMockEvent({ id: "b", startDate: isoFromNow(120) });
    const first = applyEventsPush({
      events: [a, b],
      settings: settingsWith(),
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });
    const second = applyEventsPush({
      events: [b, a],
      settings: settingsWith(),
      prevState: first.state,
      prevSignature: first.signature,
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: first.provenance,
    });
    expect(second.didChange).toBe(false);
    expect(second.signature).toBe(first.signature);
  });

  it("gates on the POST-filter signature: tomorrow-only change is a no-op when showTomorrowMeetings=false", () => {
    const today = createMockEvent({ id: "today", startDate: isoFromNow(60) });
    // Tomorrow at the same wall-clock time so isTomorrow() is true.
    const tomorrowStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const tomorrow1 = createMockEvent({ id: "tmr-1", title: "T1", startDate: tomorrowStart });
    const tomorrow2 = createMockEvent({ id: "tmr-2", title: "T2", startDate: tomorrowStart });

    const settings = settingsWith({ showTomorrowMeetings: false });
    const first = applyEventsPush({
      events: [today, tomorrow1],
      settings,
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });
    expect(first.didChange).toBe(true);
    expect(first.state.type).toBe("has-events");

    const second = applyEventsPush({
      events: [today, tomorrow2], // tomorrow-only difference
      settings,
      prevState: first.state,
      prevSignature: first.signature,
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: first.provenance,
    });
    expect(second.didChange).toBe(false);
    expect(second.signature).toBe(first.signature);
  });

  it("transitions to no-events when the filter empties the list", () => {
    const tomorrowStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const tomorrowOnly = createMockEvent({ id: "tmr", startDate: tomorrowStart });
    const result = applyEventsPush({
      events: [tomorrowOnly],
      settings: settingsWith({ showTomorrowMeetings: false }),
      prevState: loadingState(),
      prevSignature: "",
      provenance: COMPLETE_PROVENANCE,
      prevProvenance: null,
    });
    expect(result.didChange).toBe(true);
    expect(result.state.type).toBe("no-events");
  });

  it.each(["partial", "offline", "observedAt"] as const)(
    "retains a provenance-only %s change when the row signature is unchanged",
    (change) => {
      // Given: the same post-filter rows were accepted as live complete.
      const events = [createMockEvent()];
      const initial = calendarLiveOk(events, "complete", FIXED_NOW - 60_000);
      const first = applyEventsPush({
        events,
        settings: settingsWith(),
        prevState: loadingState(),
        prevSignature: "",
        provenance: initial,
        prevProvenance: null,
      });
      const provenance =
        change === "offline"
          ? calendarOfflineOk(events, FIXED_NOW - 5 * 60_000, FIXED_NOW)
          : calendarLiveOk(events, change === "partial" ? "partial" : "complete", FIXED_NOW);

      // When: only provenance changes.
      const next = applyEventsPush({
        events,
        settings: settingsWith(),
        prevState: first.state,
        prevSignature: first.signature,
        provenance,
        prevProvenance: initial,
      });

      // Then: rows stay retained, but the publication change is observable.
      expect(next.didChange).toBe(true);
      expect(next.state).toEqual(first.state);
      expect(next).toMatchObject({ provenance });
    },
  );

  it.each(["partial", "offline"] as const)(
    "retains %s provenance even when tomorrow filtering leaves an empty list",
    (kind) => {
      // Given: a degraded result whose only row is hidden by the setting.
      const events = [createMockEvent({ startDate: isoFromNow(24 * 60) })];
      const provenance =
        kind === "offline"
          ? calendarOfflineOk(events, FIXED_NOW - 10 * 60_000, FIXED_NOW)
          : calendarLiveOk(events, "partial", FIXED_NOW);

      // When: the result is reduced to empty displayed rows.
      const next = applyEventsPush({
        events,
        settings: settingsWith({ showTomorrowMeetings: false }),
        prevState: loadingState(),
        prevSignature: "",
        provenance,
        prevProvenance: null,
      });

      // Then: empty display is not confused with complete/live provenance.
      expect(next.state.type).toBe("no-events");
      expect(next).toMatchObject({ provenance });
    },
  );
});
