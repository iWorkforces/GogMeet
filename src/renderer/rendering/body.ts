import type { AppSettings } from "../../domain/entities/settings.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import { escapeHtml } from "../../shared/utils/escape-html.js";
import { isTomorrow } from "../../domain/services/time.js";
import {
  filterCompletedTodayMeetings,
  filterUpcomingMeetings,
  isMeetingInProgress,
  isMeetingNotEnded,
} from "../../domain/services/meeting-time.js";
import {
  MEETING_TITLE_DISPLAY_MAX_CHARS,
  truncateMiddle,
} from "../../domain/services/truncate-middle.js";

import type { AppState } from "../../shared/app-state.js";
import type { CalendarProvenance } from "../lib/apply-events-push.js";

/** Visible title: middle-truncate then escape. Full title stays on tooltip/aria. */
function displayMeetingTitle(title: string): string {
  return escapeHtml(truncateMiddle(title, MEETING_TITLE_DISPLAY_MAX_CHARS));
}

function formatRelativeTime(event: MeetingEvent, nowMs: number): { label: string; cls: string } {
  const start = new Date(event.startDate).getTime();
  const end = new Date(event.endDate).getTime();
  const diffMs = start - nowMs;
  const diffMin = Math.round(diffMs / 60000);

  if (isMeetingInProgress(event, nowMs)) {
    return { label: "In progress", cls: "now" };
  }

  if (!isMeetingNotEnded(event, nowMs) || nowMs >= end) {
    return { label: "Ended", cls: "" };
  }

  if (diffMin < 1) {
    return { label: "Starting now!", cls: "now" };
  }
  if (diffMin <= 15) {
    return { label: `In ${diffMin} min`, cls: "soon" };
  }

  const startTime = new Date(event.startDate);
  const hours = startTime.getHours().toString().padStart(2, "0");
  const minutes = startTime.getMinutes().toString().padStart(2, "0");
  return { label: `${hours}:${minutes}`, cls: "" };
}

function renderCompletedHistoryRow(event: MeetingEvent): string {
  const fullTitle = escapeHtml(event.title);
  return `
            <div class="meeting-item meeting-item--completed">
              <div class="meeting-item-row">
                <span class="meeting-title" title="${fullTitle}">${displayMeetingTitle(event.title)}</span>
              </div>
              <div class="meeting-item-row">
                <span class="meeting-time">Ended</span>
                <span class="meeting-meta">
                  <span class="meeting-cal">${escapeHtml(event.calendarName)}</span>
                </span>
              </div>
            </div>
          `;
}

export function renderBody(
  s: AppState,
  settings: AppSettings,
  provenance: CalendarProvenance | null,
): string {
  let calendarStatus: string;
  switch (provenance?.source) {
    case "live":
      switch (provenance.completeness) {
        case "complete":
          calendarStatus = "";
          break;
        case "partial":
          calendarStatus = "Calendar data is incomplete. Automatic opening and alerts are paused.";
          break;
      }
      break;
    case "offline-cache":
      calendarStatus =
        "Showing saved calendar data while offline. Automatic opening and alerts are paused.";
      break;
    case undefined:
      calendarStatus = "";
      break;
  }
  switch (s.type) {
    case "loading":
      return `
        <div class="state-screen">
          <div class="spinner"></div>
          <p class="state-desc">Loading your meetings...</p>
        </div>
      `;

    case "no-permission":
      return `
        <div class="state-screen">
          <div class="state-icon">📅</div>
          <p class="state-title">Calendar Access Needed</p>
          <p class="state-desc">GogMeet needs access to your calendar to show upcoming events.</p>
          <button class="btn-primary" id="btn-grant" data-action="grant-access" ${s.retrying ? "disabled" : ""}>
            ${s.retrying ? "Requesting..." : "Grant Access"}
          </button>
        </div>
      `;

    case "no-events":
      return `
        <div class="state-screen">
          <div class="state-icon">☕</div>
          <p class="state-title">No upcoming meetings</p>
          <p class="state-desc">${calendarStatus || (settings.showTomorrowMeetings ? "No calendar events found for today or tomorrow." : "No calendar events found for today.")}</p>
        </div>
      `;

    case "error":
      return `
        <div class="state-screen">
          <div class="state-icon">⚠️</div>
          <p class="state-title">Something went wrong</p>
          <p class="state-desc">${escapeHtml(s.message)}</p>
          <button class="btn-primary" id="btn-retry" data-action="retry">Try Again</button>
        </div>
      `;

    case "has-events": {
      const now = Date.now();
      const upcoming = filterUpcomingMeetings(s.events, now);
      const hasPastEvents = s.events.some((e) => !isMeetingNotEnded(e, now));
      const completedToday = settings.showCompletedTodayMeetings
        ? filterCompletedTodayMeetings(s.events, now)
        : [];

      // Check if any upcoming event is tomorrow
      const hasTomorrowEvents = upcoming.some((e) => isTomorrow(e.startDate));
      const sectionHeader = hasTomorrowEvents ? "Today & Tomorrow" : "Today";

      const parts: string[] = [];
      if (calendarStatus) parts.push(`<p class="state-desc">${calendarStatus}</p>`);
      if (upcoming.length > 0) {
        parts.push(`<p class="section-header">${sectionHeader}</p>`);
        upcoming.forEach((event, i) => {
          const rel = formatRelativeTime(event, now);
          const autoJoin =
            settings.autoOpenEnabled &&
            provenance?.source === "live" &&
            provenance.completeness === "complete" &&
            !event.isAllDay &&
            !!event.meetUrl;
          const fullTitle = escapeHtml(event.title);
          parts.push(`
            <div class="meeting-item">
              <div class="meeting-item-row">
                <span class="meeting-title" title="${fullTitle}">${displayMeetingTitle(event.title)}</span>
                ${event.meetUrl ? `<button class="btn-join" data-action="join-meeting" data-event-id="${escapeHtml(event.id)}" aria-label="Join ${fullTitle}">Join</button>` : ""}
              </div>
              <div class="meeting-item-row">
                <span class="meeting-time ${rel.cls}">${rel.label}</span>
                <span class="meeting-meta">
                  ${autoJoin ? `<span class="badge-auto" title="Browser will open automatically ${settings.openBeforeMinutes === 1 ? "1 min" : `${settings.openBeforeMinutes} mins`} before">⚡ Auto</span>` : ""}
                  <span class="meeting-cal">${escapeHtml(event.calendarName)}</span>
                </span>
              </div>
            </div>
          `);
          if (i < upcoming.length - 1) parts.push(`<div class="meeting-divider"></div>`);
        });
      }

      if (hasPastEvents && upcoming.length === 0 && completedToday.length === 0) {
        parts.push(`
          <div class="state-screen">
            <div class="state-icon">✅</div>
            <p class="state-title">All done for today!</p>
            <p class="state-desc">No more upcoming meetings.</p>
          </div>
        `);
      }

      if (completedToday.length > 0) {
        parts.push(`<p class="section-header">Completed today</p>`);
        completedToday.forEach((event, i) => {
          parts.push(renderCompletedHistoryRow(event));
          if (i < completedToday.length - 1) parts.push(`<div class="meeting-divider"></div>`);
        });
      }

      return parts.join("");
    }
  }
}
