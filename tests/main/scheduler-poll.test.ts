import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CalendarResult } from "../../src/domain/entities/calendar-result.js";
import { calendarLiveOk, calendarOfflineOk } from "../../src/domain/entities/calendar-result.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import type { SchedulerFacade } from "../../src/main/scheduler/facade.js";
import type { SchedulerTestContext } from "../helpers/scheduler-runtime.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import {
  createMockEvent,
  asTestEventId,
  asTestIsoUtc,
  asTestMeetUrl,
  isoFromNow,
} from "../helpers/test-utils.js";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test"),
    getAppPath: vi.fn().mockReturnValue("/tmp/test"),
  },
}));

// Mock power module
vi.mock("../../src/main/system/power.js", () => ({
  getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
}));

const { createSchedulerFacade } = await import("../../src/main/scheduler/facade.js");
const { mainBus } = await import("../../src/main/events.js");

const { poll: pollImpl, republishUiForDisplayTick: republishUiImpl } =
  await import("../../src/main/scheduler/poll.js");

let context: SchedulerTestContext;
let runtime: SchedulerRuntime;
let facade: SchedulerFacade;
let refreshCalendarPublication: SchedulerTestContext["refresh"];
let getLastPublication: SchedulerTestContext["getLastPublication"];

function createFreshFixture(): void {
  context = schedulerTestContext();
  runtime = context.runtime;
  facade = createSchedulerFacade(context.dependencies, runtime);
  refreshCalendarPublication = context.refresh;
  getLastPublication = context.getLastPublication;
}

function resetFixture(): void {
  createFreshFixture();
}

function initPowerCallbacks(callbacks: NonNullable<typeof runtime.state.powerCallbacks>): void {
  runtime.state.powerCallbacks = callbacks;
}

function startScheduler(): void {
  facade.start();
}

function stopScheduler(): void {
  facade.stop();
}

function restartScheduler(): void {
  facade.restart();
}

function poll(isCurrentGeneration?: () => boolean) {
  return pollImpl(runtime, isCurrentGeneration);
}

const stateModule = {
  get state() {
    return runtime.state;
  },
  setConsecutiveErrors(value: number) {
    runtime.state.consecutiveErrors = value;
  },
  getConsecutiveErrors: () => runtime.state.consecutiveErrors,
  getTimers: () => runtime.state.timers,
  getAlertTimers: () => runtime.state.alertTimers,
  getCountdownIntervals: () => runtime.state.countdownIntervals,
  setActiveInMeetingEventId: (id: typeof runtime.state.activeInMeetingEventId) => {
    runtime.state.activeInMeetingEventId = id;
  },
  setActiveTitleEventId: (id: typeof runtime.state.activeTitleEventId) => {
    runtime.state.activeTitleEventId = id;
  },
  getActiveTitleEventId: () => runtime.state.activeTitleEventId,
  getActiveInMeetingEventId: () => runtime.state.activeInMeetingEventId,
};

const getCountdownIntervals = () => runtime.state.countdownIntervals;
const getClearTimers = () => runtime.state.clearTimers;
const getInMeetingIntervals = () => runtime.state.inMeetingIntervals;
const getInMeetingEndTimers = () => runtime.state.inMeetingEndTimers;
let countdownIntervals: SchedulerRuntime["state"]["countdownIntervals"];
let clearTimers: SchedulerRuntime["state"]["clearTimers"];
let inMeetingIntervals: SchedulerRuntime["state"]["inMeetingIntervals"];
let inMeetingEndTimers: SchedulerRuntime["state"]["inMeetingEndTimers"];
function refreshStateRefs(): void {
  countdownIntervals = getCountdownIntervals();
  clearTimers = getClearTimers();
  inMeetingIntervals = getInMeetingIntervals();
  inMeetingEndTimers = getInMeetingEndTimers();
}

function makeEvent(overrides: Partial<MeetingEvent> = {}): MeetingEvent {
  return createMockEvent(overrides);
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve = (_value: T): void => {};
  let reject = (_reason: unknown): void => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mockTrayCallback = vi.fn();

describe("poll()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
    stateModule.state.onTrayTitleUpdate = mockTrayCallback;
    mockTrayCallback.mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });

  afterEach(() => {
    resetFixture();
    refreshStateRefs();
    vi.useRealTimers();
    stateModule.state.powerCallbacks = null;
  });

  it("resets consecutiveErrors to 0 on successful poll with events", async () => {
    stateModule.setConsecutiveErrors(2);
    const event = makeEvent();
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [event],
      },
    });

    await poll();

    expect(stateModule.getConsecutiveErrors()).toBe(0);
  });

  it("resets consecutiveErrors to 0 on success with empty events", async () => {
    stateModule.setConsecutiveErrors(1);
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    await poll();

    expect(stateModule.getConsecutiveErrors()).toBe(0);
  });

  it("live complete schedules timers for future meetings", async () => {
    const event = makeEvent({
      id: asTestEventId("auto-ok"),
      startDate: asTestIsoUtc(new Date(Date.now() + 10 * 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 40 * 60_000).toISOString()),
      meetUrl: asTestMeetUrl("https://meet.google.com/aaa-bbb-ccc"),
    });
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [event],
      },
    });
    await poll();
    expect(stateModule.getTimers().size).toBe(1);
    expect(stateModule.state.lastKnownEvents?.kind).toBe("ok");
  });

  it("live partial suspends automation but keeps lastKnownEvents for join", async () => {
    const allowSleep = vi.fn();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep,
    });
    // Seed a browser timer + countdown as if a prior complete poll armed them.
    stateModule.state.timers.set(
      asTestEventId("stale"),
      setTimeout(() => {}, 60_000),
    );
    stateModule.state.countdownIntervals.set(
      asTestEventId("stale"),
      setInterval(() => {}, 60_000),
    );
    const event = makeEvent({
      id: asTestEventId("partial-1"),
      startDate: asTestIsoUtc(new Date(Date.now() + 10 * 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 40 * 60_000).toISOString()),
      meetUrl: asTestMeetUrl("https://meet.google.com/aaa-bbb-ccc"),
    });
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "partial",
        observedAt: Date.now(),
        events: [event],
        darwinPartialRefreshDiagnostics: {
          total: 1,
          malformedRecord: 1,
          malformedFieldCount: 0,
          invalidIso: 0,
          invalidId: 0,
          duplicateUid: 0,
        },
      },
    });
    await poll();
    expect(stateModule.getTimers().size).toBe(0);
    expect(stateModule.getCountdownIntervals().size).toBe(0);
    expect(allowSleep).toHaveBeenCalled();
    expect(stateModule.state.lastKnownEvents).toMatchObject({
      kind: "ok",
      source: "live",
      completeness: "partial",
    });
    expect(
      stateModule.state.lastKnownEvents && stateModule.state.lastKnownEvents.kind === "ok"
        ? stateModule.state.lastKnownEvents.events
        : [],
    ).toHaveLength(1);
    expect(stateModule.state.lastKnownEvents).toMatchObject({
      darwinPartialRefreshDiagnostics: { total: 1 },
    });
  });

  it("offline-cache suspends automation and preserves joinable events", async () => {
    stateModule.state.alertTimers.set(
      asTestEventId("a"),
      setTimeout(() => {}, 60_000),
    );
    const event = makeEvent({
      id: asTestEventId("offline-1"),
      startDate: asTestIsoUtc(new Date(Date.now() + 10 * 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 40 * 60_000).toISOString()),
      meetUrl: asTestMeetUrl("https://meet.google.com/aaa-bbb-ccc"),
    });
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "offline-cache",
        observedAt: Date.now() - 60_000,
        cachedAt: Date.now() - 30_000,
        events: [event],
      },
    });
    await poll();
    expect(stateModule.getAlertTimers().size).toBe(0);
    expect(stateModule.getTimers().size).toBe(0);
    expect(stateModule.state.lastKnownEvents).toMatchObject({
      kind: "ok",
      source: "offline-cache",
    });
  });

  it("increments consecutiveErrors on error result", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "Calendar access denied", code: "unknown" },
    });

    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(1);

    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(2);
  });

  it("increments consecutiveErrors on thrown exception", async () => {
    vi.mocked(refreshCalendarPublication).mockRejectedValue(new Error("Network failure"));

    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(1);
  });

  it("does not clear display timers on 1-2 consecutive errors", async () => {
    // Set up a countdown interval to track via the real state
    stateModule.state.countdownIntervals.set(
      asTestEventId("evt-1"),
      setInterval(() => {}, 60_000),
    );

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "permission denied", code: "unknown" },
    });

    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(1);
    expect(countdownIntervals.size).toBe(1);

    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(2);
    expect(countdownIntervals.size).toBe(1);

    clearInterval(stateModule.state.countdownIntervals.get(asTestEventId("evt-1"))!);
    stateModule.state.countdownIntervals.clear();
  });

  it("clears all display timers after MAX_CONSECUTIVE_ERRORS (3)", async () => {
    // Set up timers to be cleared
    stateModule.state.countdownIntervals.set(
      asTestEventId("a"),
      setInterval(() => {}, 60_000),
    );
    stateModule.state.clearTimers.set(
      asTestEventId("a"),
      setTimeout(() => {}, 60_000),
    );
    stateModule.state.inMeetingIntervals.set(
      asTestEventId("b"),
      setInterval(() => {}, 60_000),
    );
    stateModule.state.inMeetingEndTimers.set(
      asTestEventId("b"),
      setTimeout(() => {}, 60_000),
    );

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "permission denied", code: "unknown" },
    });

    await poll();
    await poll();
    await poll();

    expect(stateModule.getConsecutiveErrors()).toBe(3);
    expect(countdownIntervals.size).toBe(0);
    expect(clearTimers.size).toBe(0);
    expect(inMeetingIntervals.size).toBe(0);
    expect(inMeetingEndTimers.size).toBe(0);
  });

  it("releases pre-meeting sleep blocker when error cleanup clears countdown timers", async () => {
    const allowSleep = vi.fn();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep,
    });
    const eventId = asTestEventId("a");
    stateModule.state.countdownIntervals.set(
      eventId,
      setInterval(() => {}, 60_000),
    );
    stateModule.state.clearTimers.set(
      eventId,
      setTimeout(() => {}, 60_000),
    );

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "permission denied", code: "unknown" },
    });

    await poll();
    await poll();
    await poll();

    expect(allowSleep).toHaveBeenCalledTimes(1);
    expect(countdownIntervals.size).toBe(0);
    expect(clearTimers.size).toBe(0);
  });

  it("fires threshold cleanup exactly once across consecutive errors past MAX (one-shot)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "permission denied", code: "unknown" },
    });

    await poll();
    await poll();
    await poll(); // crosses threshold — cleanup fires
    await poll(); // already past threshold — must NOT re-fire
    await poll();

    const thresholdLogs = errSpy.mock.calls.filter(
      ([msg]) =>
        typeof msg === "string" && msg.includes("consecutive errors \u2014 cleared tray title"),
    );
    expect(thresholdLogs).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("resets activeInMeetingEventId after MAX_CONSECUTIVE_ERRORS", async () => {
    stateModule.setActiveInMeetingEventId(asTestEventId("im-1"));
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "error", code: "unknown" },
    });

    await poll();
    await poll();
    await poll();

    expect(stateModule.state.activeInMeetingEventId).toBeNull();
  });

  it("clears tray title (resolveActiveTitleEvent) after MAX_CONSECUTIVE_ERRORS", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "error", code: "unknown" },
    });

    await poll();
    await poll();
    await poll();

    // resolveActiveTitleEvent was called → clears tray since no countdowns
    expect(mockTrayCallback).toHaveBeenCalledWith(null);
  });

  it("clears display timers on thrown exception at threshold", async () => {
    stateModule.state.countdownIntervals.set(
      asTestEventId("a"),
      setInterval(() => {}, 60_000),
    );

    vi.mocked(refreshCalendarPublication).mockRejectedValue(new Error("crash"));

    await poll();
    await poll();
    // After 2 errors, countdown should still be there
    // (Note: errors >= 3 triggers clear, so at count=2 no clear)
    expect(stateModule.getConsecutiveErrors()).toBe(2);

    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(3);
    expect(countdownIntervals.size).toBe(0);
  });

  it("sends IPC to renderer on success when window is alive", async () => {
    const mockSend = vi.fn();
    stateModule.state.win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { send: mockSend, isDestroyed: vi.fn().mockReturnValue(false) },
    } as never;

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    await poll();
    // IPC now sends events array (empty in this case) instead of undefined
    expect(mockSend).toHaveBeenCalledWith(
      "calendar:result-updated",
      expect.objectContaining({
        publicationGeneration: expect.any(Number),
        result: expect.objectContaining({ kind: "ok" }),
      }),
    );

    stateModule.state.win = null;
  });

  it("does NOT send IPC when window is null", async () => {
    stateModule.state.win = null;
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    // Should not throw
    await expect(poll()).resolves.toMatchObject({ publicationGeneration: expect.any(Number) });
  });

  it("does NOT send IPC when window is destroyed", async () => {
    const mockSend = vi.fn();
    stateModule.state.win = {
      isDestroyed: vi.fn().mockReturnValue(true),
      webContents: { send: mockSend },
    } as never;

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    await poll();

    expect(mockSend).not.toHaveBeenCalled();

    stateModule.state.win = null;
  });

  it("sends error publication on error so renderer can update without a second fetch", async () => {
    const mockSend = vi.fn();
    stateModule.state.win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { send: mockSend, isDestroyed: vi.fn().mockReturnValue(false) },
    } as never;

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "denied", code: "unknown" },
    });

    await poll();

    expect(mockSend).toHaveBeenCalledWith(
      "calendar:result-updated",
      expect.objectContaining({
        result: expect.objectContaining({ kind: "err", error: "denied" }),
      }),
    );

    stateModule.state.win = null;
  });

  it("marks both dirty flags after MAX_CONSECUTIVE_ERRORS", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", error: "error", code: "unknown" },
    });

    await poll();
    await poll();
    await poll();

    // After resolution, tray was cleared
    expect(mockTrayCallback).toHaveBeenCalledWith(null);
  });
});

describe("event list signature gating (renderer push)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    resetFixture();
    refreshStateRefs();
    stateModule.state.onTrayTitleUpdate = mockTrayCallback;
    mockTrayCallback.mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });

  afterEach(() => {
    stopScheduler();
    vi.clearAllTimers();
    resetFixture();
    refreshStateRefs();
    vi.useRealTimers();
    stateModule.state.powerCallbacks = null;
  });

  async function pushAndCount(events: MeetingEvent[]): Promise<number> {
    const mockSend = vi.fn();
    stateModule.state.win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { send: mockSend, isDestroyed: vi.fn().mockReturnValue(false) },
    } as never;
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events,
      },
    });
    await poll();
    return mockSend.mock.calls.length;
  }

  const baseFields = {
    title: "Standup",
    startDate: asTestIsoUtc(isoFromNow(5)),
    endDate: asTestIsoUtc(isoFromNow(35)),
    calendarName: "Work",
    isAllDay: false,
    userEmail: "a@example.com",
    description: "Notes A",
    meetUrl: asTestMeetUrl("https://meet.google.com/aaa-bbbb-ccc"),
  } satisfies Partial<MeetingEvent>;

  const overrides: Array<[string, Partial<MeetingEvent>]> = [
    ["meetUrl", { meetUrl: asTestMeetUrl("https://meet.google.com/zzz-yyyy-xxx") }],
    ["userEmail", { userEmail: "b@example.com" }],
    ["isAllDay", { isAllDay: true }],
    ["calendarName", { calendarName: "Personal" }],
  ];

  it.each([
    ["complete-to-partial", false],
    ["partial-to-offline", false],
    ["observedAt", false],
    ["complete-to-partial", true],
    ["partial-to-offline", true],
    ["observedAt", true],
  ] as const)("re-pushes provenance %s when empty=%s", async (change, empty) => {
    // Given: an accepted observation with retained rows (or an empty list).
    const events = empty
      ? []
      : [
          createMockEvent({
            startDate: asTestIsoUtc(isoFromNow(10)),
            endDate: asTestIsoUtc(isoFromNow(40)),
          }),
        ];
    const observedAt = Date.now() - 60_000;
    const initial = calendarLiveOk(
      events,
      change === "partial-to-offline" ? "partial" : "complete",
      observedAt,
    );
    const result =
      change === "partial-to-offline"
        ? calendarOfflineOk(events, observedAt, observedAt + 30_000)
        : calendarLiveOk(
            events,
            change === "complete-to-partial" ? "partial" : "complete",
            change === "observedAt" ? observedAt + 1000 : observedAt,
          );
    const send = vi.fn();
    runtime.state.win = {
      isDestroyed: () => false,
      webContents: { send, isDestroyed: () => false },
    }.As<NonNullable<SchedulerRuntime["state"]["win"]>>();
    refreshCalendarPublication.mockResolvedValue({ publicationGeneration: 1, result: initial });
    await poll();
    send.mockClear();
    const publication = { publicationGeneration: 2, result };
    refreshCalendarPublication.mockResolvedValue(publication);

    // When: only provenance changes; rows and display membership do not.
    await poll();

    // Then: the renderer receives the new observation, not just changed rows.
    expect(send).toHaveBeenCalledExactlyOnceWith("calendar:result-updated", publication);
  });

  it.each(["complete", "partial", "offline-cache"] as const)(
    "deduplicates identical empty %s observations despite a newer generation",
    async (provenance) => {
      // Given: the same observation is published in successive envelopes.
      const observedAt = Date.now() - 60_000;
      const result =
        provenance === "offline-cache"
          ? calendarOfflineOk([], observedAt, observedAt + 30_000)
          : calendarLiveOk([], provenance, observedAt);
      const send = vi.fn();
      runtime.state.win = {
        isDestroyed: () => false,
        webContents: { send, isDestroyed: () => false },
      }.As<NonNullable<SchedulerRuntime["state"]["win"]>>();
      refreshCalendarPublication.mockResolvedValue({ publicationGeneration: 1, result });
      await poll();
      send.mockClear();
      refreshCalendarPublication.mockResolvedValue({ publicationGeneration: 2, result });

      // When: no observation or content changed.
      await poll();

      // Then: generation alone does not trigger a push.
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(overrides)("re-pushes events when %s changes", async (_field, override) => {
    const evt1 = createMockEvent(baseFields);
    // First poll establishes baseline hash (returns 1 send on its own mock)
    let count = await pushAndCount([evt1]);
    expect(count).toBe(1);

    // Second poll, different field — must trigger another send (1 on the new mock)
    const evt2 = createMockEvent({ ...baseFields, ...override });
    count = await pushAndCount([evt2]);
    expect(count).toBe(1);
  });

  it("does NOT re-push when no relevant fields change", async () => {
    const evt = createMockEvent(baseFields);
    let count = await pushAndCount([evt]);
    expect(count).toBe(1);
    // Identical event — signature unchanged, no extra send on the new mock
    count = await pushAndCount([createMockEvent(baseFields)]);
    expect(count).toBe(0);
  });

  it("does NOT re-push when only description changes", async () => {
    // description is excluded from the signature: notes churn often and
    // never affects tray-list rendering.
    let count = await pushAndCount([createMockEvent(baseFields)]);
    expect(count).toBe(1);
    count = await pushAndCount([
      createMockEvent({ ...baseFields, description: "Different notes" }),
    ]);
    expect(count).toBe(0);
  });

  it("does NOT re-push when only event order changes", async () => {
    const evtA = createMockEvent({
      ...baseFields,
      id: asTestEventId("evt-a"),
      title: "A",
    });
    const evtB = createMockEvent({
      ...baseFields,
      id: asTestEventId("evt-b"),
      title: "B",
    });
    let count = await pushAndCount([evtA, evtB]);
    expect(count).toBe(1);
    // Same set, reordered — signature is order-independent
    count = await pushAndCount([evtB, evtA]);
    expect(count).toBe(0);
  });

  it("re-pushes when display membership changes after meeting end (content unchanged)", async () => {
    const start = Date.now() - 60 * 60_000;
    const end = Date.now() + 5 * 60_000;
    const fields = {
      ...baseFields,
      startDate: asTestIsoUtc(new Date(start).toISOString()),
      endDate: asTestIsoUtc(new Date(end).toISOString()),
    };
    const evt = createMockEvent(fields);
    let count = await pushAndCount([evt]);
    expect(count).toBe(1);

    // Advance past end without changing event fields — display signature must change.
    vi.setSystemTime(end + 1000);
    count = await pushAndCount([createMockEvent(fields)]);
    expect(count).toBe(1);
  });
});

describe("republishUiForDisplayTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
  });

  afterEach(() => {
    resetFixture();
    refreshStateRefs();
    vi.useRealTimers();
  });

  it("force-pushes last publication even when content signature is unchanged", async () => {
    const evt = createMockEvent({
      title: "Standup",
      startDate: asTestIsoUtc(isoFromNow(5)),
      endDate: asTestIsoUtc(isoFromNow(35)),
    });
    const publication = {
      publicationGeneration: 3,
      result: {
        kind: "ok" as const,
        source: "live" as const,
        completeness: "complete" as const,
        observedAt: Date.now(),
        events: [evt],
      },
    };
    const mockSend = vi.fn();
    stateModule.state.win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { send: mockSend, isDestroyed: vi.fn().mockReturnValue(false) },
    } as never;
    vi.mocked(refreshCalendarPublication).mockResolvedValue(publication);
    vi.mocked(getLastPublication).mockReturnValue(publication);
    await poll();
    expect(mockSend).toHaveBeenCalledTimes(1);
    mockSend.mockClear();
    // Identical content would normally skip; force path must send.
    vi.setSystemTime(Date.now() + 60_000);
    republishUiImpl(runtime);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith("calendar:result-updated", publication);
    expect(refreshCalendarPublication).toHaveBeenCalledTimes(1);
  });

  it("falls back to lastKnownEvents when coordinator has no publication", async () => {
    const { calendarLiveOk } = await import("../../src/domain/entities/calendar-result.js");
    vi.mocked(getLastPublication).mockReturnValue(null);
    const events = [createMockEvent()];
    stateModule.state.lastKnownEvents = calendarLiveOk(events, "complete", Date.now());
    const listener = vi.fn();
    mainBus.on("meeting-list-updated", listener);
    republishUiImpl(runtime);
    expect(listener).toHaveBeenCalledWith(events);
    mainBus.off("meeting-list-updated", listener);
  });

  it("facade instance calls poll implementation", () => {
    vi.mocked(getLastPublication).mockReturnValue(null);
    stateModule.state.lastKnownEvents = null;
    // No-op when nothing cached — must not throw.
    expect(() => facade.republishUiForDisplayTick()).not.toThrow();
  });
});

describe("startScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
    stateModule.state.onTrayTitleUpdate = mockTrayCallback;
    mockTrayCallback.mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });

  afterEach(() => {
    resetFixture();
    refreshStateRefs();
    vi.useRealTimers();
    stateModule.state.powerCallbacks = null;
  });

  it("starts polling and sets pollTimeout after initial poll resolves", async () => {
    startScheduler();

    // Initial poll is async — need to flush it
    await vi.advanceTimersByTimeAsync(0);

    expect(stateModule.state.pollTimeout).not.toBeNull();
  });

  it("is idempotent — second call is a no-op when already running", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const firstTimeout = stateModule.state.pollTimeout;

    startScheduler(); // should be no-op

    expect(stateModule.state.pollTimeout).toBe(firstTimeout);
  });

  it("calls poll on startup", async () => {
    vi.mocked(refreshCalendarPublication).mockClear();

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalendarPublication).toHaveBeenCalledTimes(1);
  });
});

describe("stopScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
    stateModule.state.onTrayTitleUpdate = mockTrayCallback;
    mockTrayCallback.mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });

  afterEach(() => {
    resetFixture();
    refreshStateRefs();
    vi.useRealTimers();
    stateModule.state.powerCallbacks = null;
  });

  it("clears pollTimeout and resets state", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateModule.state.pollTimeout).not.toBeNull();

    stopScheduler();

    expect(stateModule.state.pollTimeout).toBeNull();
  });

  it("clears tray title on stop", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    mockTrayCallback.mockClear();

    stopScheduler();

    expect(mockTrayCallback).toHaveBeenCalledWith(null);
  });

  it("preserves window reference after stop", () => {
    const mockWin = {
      isDestroyed: vi.fn(),
      webContents: { send: vi.fn() },
    } as never;
    stateModule.state.win = mockWin;

    stopScheduler();

    expect(stateModule.state.win).toBe(mockWin);
    stateModule.state.win = null;
  });
});

describe("restartScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    vi.mocked(refreshCalendarPublication).mockClear();
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
    stateModule.state.onTrayTitleUpdate = mockTrayCallback;
    mockTrayCallback.mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });

  afterEach(() => {
    resetFixture();
    refreshStateRefs();
    vi.useRealTimers();
    stateModule.state.powerCallbacks = null;
  });

  it("stops and restarts the scheduler", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const firstTimeout = stateModule.state.pollTimeout;

    restartScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateModule.state.pollTimeout).not.toBeNull();
    expect(stateModule.state.pollTimeout).not.toBe(firstTimeout);
  });

  it("does not fire a stale poll from a prior epoch after restart", async () => {
    const callMock = vi.mocked(refreshCalendarPublication);
    callMock.mockClear();

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(callMock).toHaveBeenCalledTimes(1);

    // Restart immediately — old epoch's pending re-arm must not survive.
    restartScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(callMock).toHaveBeenCalledTimes(2);

    // Advance a full poll interval (2 min on AC). If a stale epoch timer
    // survived, we would see >1 additional poll fire here.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(callMock).toHaveBeenCalledTimes(3);
  });

  it("ignores a pre-restart successful poll and runs one current-generation follow-up", async () => {
    const stalePoll = createDeferred<{ publicationGeneration: number; result: CalendarResult }>();
    const currentPoll = createDeferred<{ publicationGeneration: number; result: CalendarResult }>();
    const staleEvent = makeEvent({ id: asTestEventId("stale-generation") });
    const currentEvent = makeEvent({ id: asTestEventId("current-generation") });
    const emittedEventIds: string[] = [];
    const onMeetingListUpdated = (events: MeetingEvent[]): void => {
      emittedEventIds.push(...events.map((event) => event.id));
    };
    const send = vi.fn();
    stateModule.state.win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { send, isDestroyed: vi.fn().mockReturnValue(false) },
    } as never;
    mainBus.on("meeting-list-updated", onMeetingListUpdated);
    vi.mocked(refreshCalendarPublication)
      .mockReturnValueOnce(stalePoll.promise)
      .mockReturnValueOnce(currentPoll.promise);

    startScheduler();
    await Promise.resolve();
    restartScheduler();
    stalePoll.resolve({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [staleEvent],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const staleWasScheduled = stateModule.state.timers.has(staleEvent.id);
    const emittedAfterStale = [...emittedEventIds];
    const sendsAfterStale = send.mock.calls.length;

    currentPoll.resolve({
      publicationGeneration: 2,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [currentEvent],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    mainBus.off("meeting-list-updated", onMeetingListUpdated);
    stopScheduler();

    expect(staleWasScheduled).toBe(false);
    expect(emittedAfterStale).toEqual([]);
    expect(sendsAfterStale).toBe(0);
    expect(refreshCalendarPublication).toHaveBeenCalledTimes(2);
    expect(emittedEventIds).toEqual([currentEvent.id]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "calendar:result-updated",
      expect.objectContaining({
        result: expect.objectContaining({
          kind: "ok",
          events: [currentEvent],
        }),
      }),
    );
  });

  it("ignores a pre-restart rejected poll before current-generation error state", async () => {
    const stalePoll = createDeferred<{ publicationGeneration: number; result: CalendarResult }>();
    const currentPoll = createDeferred<{ publicationGeneration: number; result: CalendarResult }>();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(refreshCalendarPublication)
      .mockReturnValueOnce(stalePoll.promise)
      .mockReturnValueOnce(currentPoll.promise);

    startScheduler();
    await Promise.resolve();
    restartScheduler();
    stalePoll.reject(new Error("stale calendar failure"));
    await Promise.resolve();
    await Promise.resolve();

    const errorsAfterStale = stateModule.getConsecutiveErrors();
    const logsAfterStale = errorSpy.mock.calls.length;

    currentPoll.resolve({
      publicationGeneration: 2,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    errorSpy.mockRestore();
    stopScheduler();

    expect(refreshCalendarPublication).toHaveBeenCalledTimes(2);
    expect(errorsAfterStale).toBe(0);
    expect(logsAfterStale).toBe(0);
    expect(stateModule.getConsecutiveErrors()).toBe(0);
  });
});

describe("fresh runtime defaults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets consecutive errors to 0", () => {
    stateModule.setConsecutiveErrors(5);

    resetFixture();

    expect(stateModule.getConsecutiveErrors()).toBe(0);
  });

  it("resets activeTitleEventId to null", () => {
    stateModule.setActiveTitleEventId(asTestEventId("some-id"));

    resetFixture();

    expect(stateModule.getActiveTitleEventId()).toBeNull();
  });

  it("resets activeInMeetingEventId to null", () => {
    stateModule.setActiveInMeetingEventId(asTestEventId("other-id"));

    resetFixture();

    expect(stateModule.getActiveInMeetingEventId()).toBeNull();
  });

  it("clears pollTimeout", () => {
    stateModule.state.pollTimeout = setTimeout(() => {}, 1000);

    resetFixture();

    expect(stateModule.state.pollTimeout).toBeNull();
  });

  it("clears maps", () => {
    stateModule.state.countdownIntervals.set(
      asTestEventId("x"),
      setInterval(() => {}, 1000),
    );

    resetFixture();
    refreshStateRefs();

    expect(countdownIntervals.size).toBe(0);
  });
});
