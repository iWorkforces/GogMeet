import { recordCalendarResult } from "../facades/calendar-status.js";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { eventListSignature } from "../../domain/services/event-signature.js";
import { filterUpcomingMeetings } from "../../domain/services/meeting-time.js";
import {
  isCalendarAutomationEligible,
  isCalendarLiveOk,
  isCalendarOk,
} from "../../domain/entities/calendar-result.js";
import type { CalendarPublication } from "../../domain/entities/calendar-publication.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import { typedSend } from "../ipc-handlers/shared.js";
import { mainBus } from "../events.js";
import { CalendarRefreshCancelledError } from "../calendar/refresh-coordinator.js";
import { setDisplayHorizonEvents, clearDisplayHorizon } from "../system/display-horizon.js";

import { resolveActiveTitleEvent, clearAllDisplayTimers } from "./countdown.js";
import { suspendAutomation } from "./suspend-automation.js";

import { scheduleEvents } from "./index.js";
import type { SchedulerRuntime } from "./runtime.js";
import { MAX_CONSECUTIVE_ERRORS_CAP } from "./state/state-poll.js";

/** Number of consecutive poll errors before force-clearing the tray title (~6 min) */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Signature of events that are still upcoming for timed tray/popover lists.
 * Uses excludeAllDay to match tray menu membership.
 */
export function displayEventsSignature(
  events: readonly MeetingEvent[],
  nowMs: number = Date.now(),
): string {
  return eventListSignature(filterUpcomingMeetings(events, nowMs, { excludeAllDay: true }));
}

/** Clear tray state after too many consecutive poll failures */
function handleMaxConsecutiveErrors(runtime: SchedulerRuntime): void {
  runtime.state.titleDirty = true;
  runtime.state.inMeetingDirty = true;
  clearAllDisplayTimers(runtime);
  runtime.state.activeInMeetingEventId = null;
  resolveActiveTitleEvent(runtime);
  console.error(`[scheduler] ${MAX_CONSECUTIVE_ERRORS} consecutive errors — cleared tray title`);
}

/** Increment error counter and clear tray exactly once when threshold is crossed */
function handlePollFailure(runtime: SchedulerRuntime): void {
  const wasBelow = runtime.state.consecutiveErrors < MAX_CONSECUTIVE_ERRORS;
  runtime.state.consecutiveErrors = Math.min(
    runtime.state.consecutiveErrors + 1,
    MAX_CONSECUTIVE_ERRORS_CAP,
  );
  if (wasBelow && runtime.state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    handleMaxConsecutiveErrors(runtime);
  }
}

function publishPublicationToUi(
  runtime: SchedulerRuntime,
  publication: CalendarPublication,
  options?: { force?: boolean },
): void {
  const { state } = runtime;
  const force = options?.force === true;
  const nowMs = Date.now();
  const events: MeetingEvent[] = isCalendarOk(publication.result)
    ? [...publication.result.events]
    : [];
  if (isCalendarOk(publication.result)) {
    mainBus.emit("meeting-list-updated", events);
    setDisplayHorizonEvents(events, nowMs);
  } else {
    clearDisplayHorizon();
  }
  if (state.win && !state.win.isDestroyed()) {
    const contentSignature = isCalendarOk(publication.result)
      ? JSON.stringify([
          eventListSignature(events),
          publication.result.source,
          isCalendarLiveOk(publication.result) ? publication.result.completeness : null,
          publication.result.observedAt,
        ])
      : `err:${publication.publicationGeneration}`;
    const displaySignature = isCalendarOk(publication.result)
      ? displayEventsSignature(events, nowMs)
      : contentSignature;
    const contentChanged = contentSignature !== runtime.lastSentEventsSignature;
    const displayChanged = displaySignature !== runtime.lastSentDisplaySignature;
    if (force || contentChanged || displayChanged) {
      runtime.lastSentEventsSignature = contentSignature;
      runtime.lastSentDisplaySignature = displaySignature;
      typedSend(state.win.webContents, IPC_CHANNELS.CALENDAR_RESULT_UPDATED, publication);
    }
  }
}

/**
 * Re-push the last calendar publication so renderers re-filter with Date.now().
 * Used by the display-horizon timer when only wall clock advanced.
 */
export function republishUiForDisplayTick(runtime: SchedulerRuntime): void {
  const publication = runtime.dependencies.calendar.getLastPublication();
  if (publication) {
    publishPublicationToUi(runtime, publication, { force: true });
    return;
  }
  // Fall back to lastKnownEvents if coordinator has no publication yet.
  if (runtime.state.lastKnownEvents && isCalendarOk(runtime.state.lastKnownEvents)) {
    const events = [...runtime.state.lastKnownEvents.events];
    mainBus.emit("meeting-list-updated", events);
    setDisplayHorizonEvents(events);
  }
}

/** Poll calendar and refresh timers. Returns the coordinated publication when successful. */
export async function poll(
  runtime: SchedulerRuntime,
  isCurrentGeneration: () => boolean = () => true,
): Promise<CalendarPublication | null> {
  const { state } = runtime;
  const { calendar } = runtime.dependencies;
  try {
    const publication = await calendar.refreshCalendarPublication();
    if (!isCurrentGeneration()) return null;
    const result = publication.result;
    recordCalendarResult(result);
    if (isCalendarOk(result)) {
      state.consecutiveErrors = 0;
      // Always keep display/join snapshot for any successful result.
      state.lastKnownEvents = result;
      publishPublicationToUi(runtime, publication);

      if (isCalendarAutomationEligible(result)) {
        scheduleEvents(runtime, result.events);
      } else {
        // Partial / offline: cancel automatic browser/alert/title/countdown work;
        // tray/popover/shortcut still use lastKnownEvents + join hub.
        suspendAutomation(runtime);
      }
      return publication;
    }
    console.error("[scheduler] Calendar error:", result.error);
    // Still push error publication so renderer can update without a second fetch.
    publishPublicationToUi(runtime, publication);
    const lastEvents =
      state.lastKnownEvents && isCalendarOk(state.lastKnownEvents)
        ? state.lastKnownEvents.events
        : null;
    calendar.reportCalendarPollError(result.error, lastEvents);
    handlePollFailure(runtime);
    return publication;
  } catch (err) {
    if (!isCurrentGeneration()) return null;
    if (err instanceof CalendarRefreshCancelledError) {
      console.debug("[scheduler] Poll cancelled");
      return calendar.getLastPublication();
    }
    console.error("[scheduler] Poll error:", err);
    const message = err instanceof Error ? err.message : String(err);
    const lastEvents =
      state.lastKnownEvents && isCalendarOk(state.lastKnownEvents)
        ? state.lastKnownEvents.events
        : null;
    calendar.reportCalendarPollError(message, lastEvents);
    handlePollFailure(runtime);
    return null;
  }
}
