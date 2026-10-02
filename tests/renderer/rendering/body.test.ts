import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderBody } from "../../../src/renderer/rendering/body.js";
import type { CalendarProvenance } from "../../../src/renderer/lib/apply-events-push.js";
import { calendarLiveOk, calendarOfflineOk } from "../../../src/domain/entities/calendar-result.js";
import {
  createMockEvent,
  createMockSettings,
  isoFromNow,
  asTestEventId,
  asTestIsoUtc,
  asTestMeetUrl,
} from "../../helpers/test-utils.js";

describe("renderBody", () => {
  // Pin time so relative-time labels and isTomorrow() are deterministic.
  // 2026-06-15T10:00:00Z → a Monday morning, not near midnight.
  const FIXED_NOW = new Date("2026-06-15T10:00:00Z").getTime();
  const COMPLETE_PROVENANCE: CalendarProvenance = {
    source: "live",
    completeness: "complete",
    observedAt: FIXED_NOW,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("loading state", () => {
    it("renders spinner and loading text", () => {
      const html = renderBody({ type: "loading" }, createMockSettings(), null);
      expect(html).toContain('class="spinner"');
      expect(html).toContain("Loading your meetings...");
      expect(html).toContain('class="state-screen"');
    });
  });

  describe("no-permission state", () => {
    it("renders grant-access button when not retrying", () => {
      const html = renderBody(
        { type: "no-permission", retrying: false },
        createMockSettings(),
        null,
      );
      expect(html).toContain("Calendar Access Needed");
      expect(html).toContain('data-action="grant-access"');
      expect(html).toContain("Grant Access");
      expect(html).not.toContain("disabled");
    });

    it("renders disabled button with 'Requesting...' label when retrying", () => {
      const html = renderBody(
        { type: "no-permission", retrying: true },
        createMockSettings(),
        null,
      );
      expect(html).toContain("Requesting...");
      expect(html).toContain("disabled");
    });
  });

  describe("no-events state", () => {
    it("renders empty state with today-only desc when showTomorrowMeetings is false", () => {
      const html = renderBody(
        { type: "no-events" },
        createMockSettings({ showTomorrowMeetings: false }),
        COMPLETE_PROVENANCE,
      );
      expect(html).toContain("No upcoming meetings");
      expect(html).toContain("No calendar events found for today.");
      expect(html).not.toContain("tomorrow");
    });

    it("renders today-and-tomorrow desc when showTomorrowMeetings is true", () => {
      const html = renderBody(
        { type: "no-events" },
        createMockSettings({ showTomorrowMeetings: true }),
        COMPLETE_PROVENANCE,
      );
      expect(html).toContain("today or tomorrow");
    });

    it.each(["partial", "offline"] as const)(
      "keeps centered description styling for empty %s calendar data",
      (kind) => {
        // Given: degraded calendar data with no displayed rows.
        const provenance =
          kind === "offline"
            ? calendarOfflineOk([], FIXED_NOW - 60_000, FIXED_NOW)
            : calendarLiveOk([], "partial", FIXED_NOW);

        // When: the empty state renders its provenance description.
        const html = renderBody({ type: "no-events" }, createMockSettings(), provenance);

        // Then: the centered paragraph does not acquire the list-only gutter.
        expect(html).toContain('class="state-desc"');
        expect(html).not.toContain("calendar-notice");
      },
    );
  });

  describe("error state", () => {
    it("renders escaped error message and retry button", () => {
      const html = renderBody(
        { type: "error", message: "Boom <script>alert(1)</script>" },
        createMockSettings(),
        null,
      );
      expect(html).toContain("Something went wrong");
      expect(html).toContain('data-action="retry"');
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
    });
  });

  describe("has-events state", () => {
    it("renders upcoming meetings with title, join button, and section header", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-1"),
        title: "Standup",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain('class="section-header"');
      expect(html).toContain("Today");
      expect(html).toContain('class="meeting-title"');
      expect(html).toContain("Standup");
      expect(html).toContain('data-action="join-meeting"');
      expect(html).toContain('data-event-id="evt-1"');
    });

    it("renders 'All done for today!' when only past events exist", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-past"),
        title: "Old Meeting",
        startDate: asTestIsoUtc(isoFromNow(-60)),
        endDate: asTestIsoUtc(isoFromNow(-30)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("All done for today!");
      expect(html).toContain("No more upcoming meetings.");
      expect(html).not.toContain('class="meeting-title"');
    });

    it("renders only upcoming when both past and future events exist", () => {
      const past = createMockEvent({
        id: asTestEventId("evt-past"),
        title: "Past Meeting",
        startDate: asTestIsoUtc(isoFromNow(-60)),
        endDate: asTestIsoUtc(isoFromNow(-30)),
      });
      const future = createMockEvent({
        id: asTestEventId("evt-future"),
        title: "Future Meeting",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const html = renderBody(
        { type: "has-events", events: [past, future] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("Future Meeting");
      expect(html).not.toContain("Past Meeting");
      expect(html).not.toContain("All done for today!");
    });

    it("REGRESSION: renders 'Today & Tomorrow' header when an upcoming event is tomorrow", () => {
      // Compute tomorrow at local noon from FIXED_NOW so isTomorrow() is
      // deterministic regardless of the runner timezone.
      const localTomorrowNoon = new Date(FIXED_NOW);
      localTomorrowNoon.setHours(0, 0, 0, 0);
      localTomorrowNoon.setDate(localTomorrowNoon.getDate() + 1);
      localTomorrowNoon.setHours(12, 0, 0, 0);
      const startMs = localTomorrowNoon.getTime();
      const endMs = startMs + 30 * 60_000;

      const tomorrowEvent = createMockEvent({
        id: asTestEventId("evt-tomorrow"),
        title: "Tomorrow Sync",
        startDate: asTestIsoUtc(new Date(startMs).toISOString()),
        endDate: asTestIsoUtc(new Date(endMs).toISOString()),
      });
      const html = renderBody(
        { type: "has-events", events: [tomorrowEvent] },
        createMockSettings({ showTomorrowMeetings: true }),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain('class="section-header"');
      expect(html).toContain("Today & Tomorrow");
      expect(html).not.toMatch(/<p class="section-header">Today<\/p>/);
      expect(html).toContain("Tomorrow Sync");
    });

    it("REGRESSION: renders plain 'Today' header when no upcoming event is tomorrow", () => {
      const todayEvent = createMockEvent({
        id: asTestEventId("evt-today"),
        title: "Today Sync",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const html = renderBody(
        { type: "has-events", events: [todayEvent] },
        createMockSettings({ showTomorrowMeetings: true }),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain('<p class="section-header">Today</p>');
      expect(html).not.toContain("Today & Tomorrow");
    });

    it("escapes special characters in meeting titles", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-xss"),
        title: '<img src=x onerror="alert(1)"> & "Quoted"',
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("&lt;img src=x onerror=");
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;Quoted&quot;");
      expect(html).not.toContain('<img src=x onerror="alert(1)">');
    });

    it("renders auto-join badge for events with meetUrl that are not all-day", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-auto"),
        title: "Auto Meeting",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        isAllDay: false,
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings({ openBeforeMinutes: 1 }),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain('class="badge-auto"');
      expect(html).toContain("⚡ Auto");
      expect(html).toContain("1 min");
    });

    it("uses plural 'mins' in auto-join badge tooltip when openBeforeMinutes > 1", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-auto-5"),
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings({ openBeforeMinutes: 5 }),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("5 mins before");
    });

    it("does NOT render auto-join badge for all-day events", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-allday"),
        title: "All Day",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        isAllDay: true,
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).not.toContain('class="badge-auto"');
    });

    it.each(["disabled", "partial", "offline", "all-day", "no-url"] as const)(
      "does not promise automatic opening for %s data while preserving eligible manual ID Join",
      (reason) => {
        // Given: explicit provenance and the relevant automation constraint.
        const event = createMockEvent({
          isAllDay: reason === "all-day",
          ...(reason === "no-url" ? { meetUrl: undefined } : {}),
        });
        const provenance =
          reason === "offline"
            ? calendarOfflineOk([event], FIXED_NOW - 60_000, FIXED_NOW)
            : calendarLiveOk([event], reason === "partial" ? "partial" : "complete", FIXED_NOW);

        // When: the existing body renders the accepted list.
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings({ autoOpenEnabled: reason !== "disabled" }),
          provenance,
        );

        // Then: the hint is absent, but a URL still permits manual ID Join.
        expect(html).not.toContain('class="badge-auto"');
        expect(html.includes('class="state-desc calendar-notice"')).toBe(
          reason === "partial" || reason === "offline",
        );
        if (reason !== "no-url") {
          expect(html).toContain(`data-event-id="${event.id}"`);
          expect(html).not.toContain("data-url=");
        }
      },
    );

    it("does NOT render Join button or auto-join badge for events without meetUrl", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-nourl"),
        title: "No URL",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        meetUrl: undefined,
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).not.toContain('data-action="join-meeting"');
      expect(html).not.toContain('class="badge-auto"');
      expect(html).toContain("No URL");
    });

    it("renders empty title gracefully without throwing", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-empty"),
        title: "",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain('class="meeting-title"');
      // Empty title produces an empty span body, but the structure is intact.
      expect(html).toContain('title=""');
    });

    it("renders multiple meetings in order with dividers between them", () => {
      const event1 = createMockEvent({
        id: asTestEventId("evt-1"),
        title: "First Meeting",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
      });
      const event2 = createMockEvent({
        id: asTestEventId("evt-2"),
        title: "Second Meeting",
        startDate: asTestIsoUtc(isoFromNow(90)),
        endDate: asTestIsoUtc(isoFromNow(120)),
      });
      const event3 = createMockEvent({
        id: asTestEventId("evt-3"),
        title: "Third Meeting",
        startDate: asTestIsoUtc(isoFromNow(150)),
        endDate: asTestIsoUtc(isoFromNow(180)),
      });
      const html = renderBody(
        { type: "has-events", events: [event1, event2, event3] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      const idx1 = html.indexOf("First Meeting");
      const idx2 = html.indexOf("Second Meeting");
      const idx3 = html.indexOf("Third Meeting");
      expect(idx1).toBeGreaterThan(-1);
      expect(idx2).toBeGreaterThan(idx1);
      expect(idx3).toBeGreaterThan(idx2);

      // 3 meetings → 2 dividers between them.
      const dividerCount = (html.match(/class="meeting-divider"/g) ?? []).length;
      expect(dividerCount).toBe(2);
    });

    it("renders 'In progress' label for meetings that started but have not ended", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-now"),
        title: "Live Meeting",
        startDate: asTestIsoUtc(isoFromNow(-5)),
        endDate: asTestIsoUtc(isoFromNow(25)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("In progress");
      expect(html).toContain('class="meeting-time now"');
    });

    it("does not list or label a meeting that has already ended", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-past"),
        title: "Afternoon Sync",
        startDate: asTestIsoUtc(isoFromNow(-120)),
        endDate: asTestIsoUtc(isoFromNow(-50)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).not.toContain("Afternoon Sync");
      expect(html).not.toContain("In progress");
      expect(html).toContain("All done for today");
    });

    describe("completed-today history (showCompletedTodayMeetings)", () => {
      it("keeps All done empty state when toggle is off", () => {
        const event = createMockEvent({
          id: asTestEventId("evt-past"),
          title: "Old Meeting",
          startDate: asTestIsoUtc(isoFromNow(-60)),
          endDate: asTestIsoUtc(isoFromNow(-30)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings({ showCompletedTodayMeetings: false }),
          COMPLETE_PROVENANCE,
        );
        expect(html).toContain("All done for today!");
        expect(html).not.toContain("Completed today");
        expect(html).not.toContain("Old Meeting");
      });

      it("renders muted completed history newest-ended first when enabled", () => {
        const earlier = createMockEvent({
          id: asTestEventId("evt-early"),
          title: "Morning Standup",
          startDate: asTestIsoUtc(isoFromNow(-120)),
          endDate: asTestIsoUtc(isoFromNow(-90)),
          calendarName: "Work",
        });
        const later = createMockEvent({
          id: asTestEventId("evt-late"),
          title: "Afternoon Sync",
          startDate: asTestIsoUtc(isoFromNow(-60)),
          endDate: asTestIsoUtc(isoFromNow(-30)),
          calendarName: "Personal",
        });
        const html = renderBody(
          { type: "has-events", events: [earlier, later] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );

        expect(html).toContain("Completed today");
        expect(html).toContain("Morning Standup");
        expect(html).toContain("Afternoon Sync");
        expect(html).toContain("Ended");
        expect(html).toContain('class="meeting-item meeting-item--completed"');
        expect(html).not.toContain("All done for today!");

        const idxLate = html.indexOf("Afternoon Sync");
        const idxEarly = html.indexOf("Morning Standup");
        expect(idxLate).toBeGreaterThan(-1);
        expect(idxEarly).toBeGreaterThan(idxLate);

        // Non-interactive: no join affordance, actions, badges, or focusable controls
        expect(html).not.toContain('data-action="join-meeting"');
        expect(html).not.toContain("data-event-id");
        expect(html).not.toContain("btn-join");
        expect(html).not.toContain("badge-auto");
        expect(html).not.toContain("<button");
      });

      it("shows completed history after upcoming rows", () => {
        const past = createMockEvent({
          id: asTestEventId("evt-past"),
          title: "Past Meeting",
          startDate: asTestIsoUtc(isoFromNow(-60)),
          endDate: asTestIsoUtc(isoFromNow(-30)),
        });
        const future = createMockEvent({
          id: asTestEventId("evt-future"),
          title: "Future Meeting",
          startDate: asTestIsoUtc(isoFromNow(30)),
          endDate: asTestIsoUtc(isoFromNow(60)),
        });
        const html = renderBody(
          { type: "has-events", events: [past, future] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );

        expect(html).toContain("Future Meeting");
        expect(html).toContain("Past Meeting");
        expect(html).toContain("Completed today");
        expect(html.indexOf("Future Meeting")).toBeLessThan(html.indexOf("Completed today"));
        expect(html.indexOf("Completed today")).toBeLessThan(html.indexOf("Past Meeting"));
        // Upcoming still has Join; completed section does not expose event id for the past row as a join target
        expect(html).toContain('data-event-id="evt-future"');
        expect(html).not.toContain('data-event-id="evt-past"');
      });

      it("excludes in-progress meetings from history", () => {
        const live = createMockEvent({
          id: asTestEventId("evt-live"),
          title: "Live Meeting",
          startDate: asTestIsoUtc(isoFromNow(-5)),
          endDate: asTestIsoUtc(isoFromNow(25)),
        });
        const html = renderBody(
          { type: "has-events", events: [live] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );
        expect(html).toContain("In progress");
        expect(html).not.toContain("Completed today");
        expect(html).toContain('data-action="join-meeting"');
      });

      it("excludes prior-day and overnight-spanning events", () => {
        const localMidnight = new Date(FIXED_NOW);
        localMidnight.setHours(0, 0, 0, 0);

        // Ended yesterday entirely
        const priorDay = createMockEvent({
          id: asTestEventId("evt-prior"),
          title: "Yesterday Meeting",
          startDate: asTestIsoUtc(
            new Date(localMidnight.getTime() - 5 * 60 * 60_000).toISOString(),
          ),
          endDate: asTestIsoUtc(new Date(localMidnight.getTime() - 4 * 60 * 60_000).toISOString()),
        });

        // Started yesterday, ended today (overnight)
        const overnight = createMockEvent({
          id: asTestEventId("evt-overnight"),
          title: "Overnight Call",
          startDate: asTestIsoUtc(
            new Date(localMidnight.getTime() - 2 * 60 * 60_000).toISOString(),
          ),
          endDate: asTestIsoUtc(new Date(localMidnight.getTime() + 1 * 60 * 60_000).toISOString()),
        });

        // Tomorrow (upcoming if showTomorrow)
        const tomorrowNoon = new Date(localMidnight);
        tomorrowNoon.setDate(tomorrowNoon.getDate() + 1);
        tomorrowNoon.setHours(12, 0, 0, 0);
        const tomorrow = createMockEvent({
          id: asTestEventId("evt-tomorrow"),
          title: "Tomorrow Meeting",
          startDate: asTestIsoUtc(tomorrowNoon.toISOString()),
          endDate: asTestIsoUtc(new Date(tomorrowNoon.getTime() + 30 * 60_000).toISOString()),
        });

        const html = renderBody(
          { type: "has-events", events: [priorDay, overnight, tomorrow] },
          createMockSettings({ showCompletedTodayMeetings: true, showTomorrowMeetings: true }),
          COMPLETE_PROVENANCE,
        );

        expect(html).not.toContain("Yesterday Meeting");
        expect(html).not.toContain("Overnight Call");
        expect(html).toContain("Tomorrow Meeting");
        // overnight ended already relative to FIXED_NOW (10:00 UTC) — still excluded by day bounds
        // tomorrow is upcoming — not history
        expect(html).not.toContain("Completed today");
      });

      it("excludes multi-day events that start today and end after local midnight", () => {
        const localMidnight = new Date(FIXED_NOW);
        localMidnight.setHours(0, 0, 0, 0);
        const nextMidnight = new Date(localMidnight);
        nextMidnight.setDate(nextMidnight.getDate() + 1);

        // Starts later today, ends tomorrow — both bounds must be today for history.
        // While still in progress it is upcoming; once "ended" it still must not be history.
        const multiDayLive = createMockEvent({
          id: asTestEventId("evt-multiday-live"),
          title: "Multi Day Live",
          startDate: asTestIsoUtc(isoFromNow(-30)),
          endDate: asTestIsoUtc(new Date(nextMidnight.getTime() + 2 * 60 * 60_000).toISOString()),
        });
        const liveHtml = renderBody(
          { type: "has-events", events: [multiDayLive] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );
        expect(liveHtml).toContain("Multi Day Live");
        expect(liveHtml).toContain("In progress");
        expect(liveHtml).not.toContain("Completed today");

        // Past end but end is after local midnight of FIXED_NOW day → still not history.
        const multiDayEnded = createMockEvent({
          id: asTestEventId("evt-multiday-ended"),
          title: "Multi Day Ended",
          startDate: asTestIsoUtc(
            new Date(localMidnight.getTime() + 8 * 60 * 60_000).toISOString(),
          ),
          endDate: asTestIsoUtc(new Date(nextMidnight.getTime() + 2 * 60 * 60_000).toISOString()),
        });
        // Advance past that end for classification
        vi.setSystemTime(nextMidnight.getTime() + 3 * 60 * 60_000);
        const endedHtml = renderBody(
          { type: "has-events", events: [multiDayEnded] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );
        expect(endedHtml).not.toContain("Multi Day Ended");
        expect(endedHtml).not.toContain("Completed today");
        // Restore FIXED_NOW for subsequent tests in this describe
        vi.setSystemTime(FIXED_NOW);
      });

      it("includes meeting that ended exactly at now", () => {
        const event = createMockEvent({
          id: asTestEventId("evt-exact"),
          title: "Just Ended",
          startDate: asTestIsoUtc(isoFromNow(-30)),
          endDate: asTestIsoUtc(isoFromNow(0)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );
        expect(html).toContain("Just Ended");
        expect(html).toContain("Completed today");
        expect(html).toContain("Ended");
      });

      it("escapes malicious title and calendar in completed rows", () => {
        const event = createMockEvent({
          id: asTestEventId("evt-xss-done"),
          title: '<img src=x onerror="alert(1)">',
          calendarName: 'Evil & "Cal"',
          startDate: asTestIsoUtc(isoFromNow(-60)),
          endDate: asTestIsoUtc(isoFromNow(-30)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );
        expect(html).toContain("&lt;img src=x onerror=");
        expect(html).toContain("Evil &amp; &quot;Cal&quot;");
        expect(html).not.toContain('<img src=x onerror="alert(1)">');
      });

      it("includes completed meetings without meetUrl", () => {
        const event = createMockEvent({
          id: asTestEventId("evt-nourl-done"),
          title: "No URL Done",
          meetUrl: undefined,
          startDate: asTestIsoUtc(isoFromNow(-60)),
          endDate: asTestIsoUtc(isoFromNow(-30)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );
        expect(html).toContain("No URL Done");
        expect(html).toContain("Completed today");
        expect(html).not.toContain("btn-join");
      });
    });

    it("renders 'In X min' soon label for meetings within 15 minutes", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-soon"),
        title: "Soon Meeting",
        startDate: asTestIsoUtc(isoFromNow(10)),
        endDate: asTestIsoUtc(isoFromNow(40)),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("In 10 min");
      expect(html).toContain('class="meeting-time soon"');
    });

    it("escapes calendar names and meet URLs", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-cal"),
        title: "Cal Meeting",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        calendarName: 'Work & "Home"',
        meetUrl: asTestMeetUrl("https://meet.google.com/xyz-abcd-efg"),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("Work &amp; &quot;Home&quot;");
      expect(html).toContain('data-event-id="evt-cal"');
    });

    describe("meeting title middle-truncation", () => {
      it("middle-truncates long upcoming titles while keeping full title on tooltip and aria", () => {
        const longTitle = "Weekly Product Sync with Design";
        const event = createMockEvent({
          id: asTestEventId("evt-long"),
          title: longTitle,
          startDate: asTestIsoUtc(isoFromNow(30)),
          endDate: asTestIsoUtc(isoFromNow(60)),
          meetUrl: asTestMeetUrl("https://meet.google.com/abc-defg-hij"),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings(),
          COMPLETE_PROVENANCE,
        );

        // Display: head 12 + … + tail 12 (max 25 code points)
        expect(html).toContain(">Weekly Produ\u2026 with Design</span>");
        expect(html).toContain(`title="${longTitle}"`);
        expect(html).toContain(`aria-label="Join ${longTitle}"`);
        // Full untruncated string must not appear as the span's text content path alone —
        // the raw full title still appears in attributes; ensure the visible label is truncated.
        expect(html).not.toContain(`>${longTitle}</span>`);
      });

      it("leaves short titles unchanged", () => {
        const event = createMockEvent({
          id: asTestEventId("evt-short"),
          title: "Standup",
          startDate: asTestIsoUtc(isoFromNow(30)),
          endDate: asTestIsoUtc(isoFromNow(60)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings(),
          COMPLETE_PROVENANCE,
        );
        expect(html).toContain('title="Standup">Standup</span>');
      });

      it("escapes after truncate for malicious long titles", () => {
        const malicious = "<script>alert(1)</script>EXTRA";
        const event = createMockEvent({
          id: asTestEventId("evt-xss"),
          title: malicious,
          startDate: asTestIsoUtc(isoFromNow(30)),
          endDate: asTestIsoUtc(isoFromNow(60)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings(),
          COMPLETE_PROVENANCE,
        );

        expect(html).not.toContain("<script>alert(1)</script>");
        // Truncated form still HTML-escaped
        expect(html).toContain("&lt;");
        expect(html).toContain(`title="${malicious.replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`);
      });

      it("middle-truncates completed-today history titles with full title tooltip", () => {
        const longTitle = "Weekly Product Sync with Design";
        const event = createMockEvent({
          id: asTestEventId("evt-done-long"),
          title: longTitle,
          startDate: asTestIsoUtc(isoFromNow(-60)),
          endDate: asTestIsoUtc(isoFromNow(-30)),
        });
        const html = renderBody(
          { type: "has-events", events: [event] },
          createMockSettings({ showCompletedTodayMeetings: true }),
          COMPLETE_PROVENANCE,
        );

        expect(html).toContain("Completed today");
        expect(html).toContain(">Weekly Produ\u2026 with Design</span>");
        expect(html).toContain(`title="${longTitle}"`);
        expect(html).not.toContain(`>${longTitle}</span>`);
        expect(html).not.toContain("btn-join");
      });
    });
  });

  describe("Zoom events", () => {
    it("renders Join button and auto-join badge for Zoom events with meetUrl", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-zoom"),
        title: "Zoom Standup",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        meetUrl: asTestMeetUrl("https://zoom.us/j/1234567890"),
        isAllDay: false,
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings({ openBeforeMinutes: 1 }),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("Zoom Standup");
      expect(html).toContain('data-action="join-meeting"');
      expect(html).toContain('data-event-id="evt-zoom"');
      expect(html).toContain('class="badge-auto"');
      expect(html).toContain("⚡ Auto");
    });

    it("renders Zoom event without Join button when meetUrl is undefined", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-zoom-nourl"),
        title: "Zoom No URL",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        meetUrl: undefined,
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("Zoom No URL");
      expect(html).not.toContain('data-action="join-meeting"');
    });

    it("renders Zoom subdomain URL in Join button", () => {
      const event = createMockEvent({
        id: asTestEventId("evt-zoom-sub"),
        title: "Acme Sync",
        startDate: asTestIsoUtc(isoFromNow(30)),
        endDate: asTestIsoUtc(isoFromNow(60)),
        meetUrl: asTestMeetUrl("https://acme.zoom.us/j/456?pwd=abc"),
      });
      const html = renderBody(
        { type: "has-events", events: [event] },
        createMockSettings(),
        COMPLETE_PROVENANCE,
      );

      expect(html).toContain("Acme Sync");
      expect(html).toContain('data-event-id="evt-zoom-sub"');
    });
  });
});
