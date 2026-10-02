import "./styles/main.css";
import type { CalendarPermission, CalendarResultOk } from "../domain/entities/calendar-result.js";
import { isCalendarOk } from "../domain/entities/calendar-result.js";
import type { CalendarPublication } from "../domain/entities/calendar-publication.js";
import type { AppSettings } from "../domain/entities/settings.js";
import { DEFAULT_SETTINGS } from "../domain/entities/settings.js";
import { startOfDay } from "../domain/services/time.js";
import { renderBody } from "./rendering/body.js";
import { setupDelegatedEvents } from "./events/delegation.js";
import { applyEventsPush } from "./lib/apply-events-push.js";

import type { AppState } from "../shared/app-state.js";

// Layout constants for window height calculation
const FOOTER_H = 32;
const MIN_H = 220;
const MAX_H = 480;

interface RendererState {
  state: AppState;
  version: string;
  settings: AppSettings;
  provenance: CalendarResultOk | null;
  cachedSettings: AppSettings | null;
  cachedPermission: CalendarPermission | null;
  lastHeight: number;
  lastEventsSignature: string;
  lastPollTime: number;
  /** Defense-in-depth: ignore stale publications with older generations. */
  loadGeneration: number;
  loadRequestId: number;
  /** Renderer-owned presentation timer for completed-history invalidation. */
  presentationTimer: ReturnType<typeof setTimeout> | null;
}

const rs: RendererState = {
  state: { type: "loading" },
  version: "",
  settings: { ...DEFAULT_SETTINGS },
  provenance: null,
  cachedSettings: null,
  cachedPermission: null,
  lastHeight: 0,
  lastEventsSignature: "",
  lastPollTime: Date.now(),
  loadGeneration: -1,
  loadRequestId: 0,
  presentationTimer: null,
};

/**
 * True when only the completed-history display toggle differs.
 * Fails closed: any other key difference (including future AppSettings fields)
 * returns false so the caller still runs loadEvents.
 */
function isOnlyCompletedHistoryToggle(prev: AppSettings, next: AppSettings): boolean {
  if (prev.showCompletedTodayMeetings === next.showCompletedTodayMeetings) return false;
  const keys = Object.keys(next) as (keyof AppSettings)[];
  for (const key of keys) {
    if (key === "showCompletedTodayMeetings") continue;
    if (prev[key] !== next[key]) return false;
  }
  // Also fail closed if prev has keys next lacks (defensive against partial objects).
  for (const key of Object.keys(prev) as (keyof AppSettings)[]) {
    if (key === "showCompletedTodayMeetings") continue;
    if (!(key in next) || prev[key] !== next[key]) return false;
  }
  return true;
}

function clearPresentationTimer(): void {
  if (rs.presentationTimer !== null) {
    clearTimeout(rs.presentationTimer);
    rs.presentationTimer = null;
  }
}

/**
 * Earliest wall-clock deadline for completed-history presentation: the next
 * strictly future event end, or local midnight — whichever comes first.
 * Returns null when history is disabled or there is no event state.
 */
function nextPresentationDeadlineMs(nowMs: number): number | null {
  if (!rs.settings.showCompletedTodayMeetings) return null;
  if (rs.state.type !== "has-events") return null;

  let soonest: number | null = null;
  const consider = (ms: number): void => {
    if (!Number.isFinite(ms) || ms <= nowMs) return;
    if (soonest === null || ms < soonest) soonest = ms;
  };

  const midnight = startOfDay(new Date(nowMs));
  midnight.setDate(midnight.getDate() + 1);
  consider(midnight.getTime());

  for (const event of rs.state.events) {
    const endMs = new Date(event.endDate).getTime();
    consider(endMs);
  }

  return soonest;
}

/**
 * Arm a single presentation timeout. Fires a local re-render only — no
 * calendar fetch, settings IPC, join call, or footer freshness update.
 */
function armPresentationTimer(): void {
  clearPresentationTimer();
  const nowMs = Date.now();
  const deadline = nextPresentationDeadlineMs(nowMs);
  if (deadline === null) return;
  const delay = Math.max(0, deadline - nowMs);
  rs.presentationTimer = setTimeout(() => {
    rs.presentationTimer = null;
    // Local re-filter only — preserve the accepted observation time.
    render();
  }, delay);
}

function formatLastUpdated(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Updated just now";
  if (diffMin === 1) return "Updated 1 min ago";
  return `Updated ${diffMin} min ago`;
}

function renderFooter(): string {
  const observedAt = rs.provenance?.observedAt ?? null;
  const label = observedAt === null ? "Loading…" : formatLastUpdated(observedAt);
  const isLoading = observedAt === null;
  const icon = isLoading ? "" : '<span class="footer-refresh-icon" aria-hidden="true">↻</span>';
  return `
    <footer class="footer">
      <span class="footer-version">v${rs.version}</span>
      <span class="footer-sep" aria-hidden="true"></span>
      <button class="footer-refresh${isLoading ? " footer-refresh--loading" : ""}" data-action="refresh" aria-label="Refresh meetings">
        ${icon}<span class="footer-refresh-label">${label}</span>
      </button>
    </footer>
  `;
}

function render(viewState?: AppState) {
  if (
    viewState === undefined &&
    rs.provenance !== null &&
    (rs.state.type === "has-events" || rs.state.type === "no-events")
  ) {
    applyResult(rs.provenance);
  }
  const state = viewState ?? rs.state;
  try {
    const app = document.getElementById("app");
    if (!app) {
      clearPresentationTimer();
      return;
    }

    app.innerHTML = `<div role="dialog" aria-label="GogMeet meetings" aria-live="polite">
        <div class="body">${renderBody(state, rs.settings, rs.provenance)}</div>
        ${renderFooter()}
      </div>`;

    // Measure actual rendered height and resize the Electron BrowserWindow
    const bodyEl = app.querySelector<HTMLElement>(".body");
    const bodyH = bodyEl ? bodyEl.scrollHeight : 0;
    const targetH = Math.min(MAX_H, Math.max(MIN_H, bodyH + FOOTER_H));
    if (targetH !== rs.lastHeight) {
      window.api.window.setHeight(targetH);
      rs.lastHeight = targetH;
    }
  } catch (error) {
    console.error("[renderer] Render error:", error);
  }
  // Re-arm (or clear) after a successful render decision so presentation stays current.
  armPresentationTimer();
}

async function grantAccess() {
  const requestId = ++rs.loadRequestId;
  const generationAtStart = rs.loadGeneration;
  rs.state = { type: "no-permission", retrying: true };
  render();

  const status = await window.api.calendar.requestPermission();
  if (requestId !== rs.loadRequestId || generationAtStart !== rs.loadGeneration) return;
  rs.cachedPermission = status;
  if (status === "granted") {
    await loadEvents();
  } else {
    rs.state = { type: "no-permission", retrying: false };
    render();
  }
}

function applyPublication(publication: CalendarPublication): void {
  if (publication.publicationGeneration <= rs.loadGeneration) {
    return;
  }
  rs.loadGeneration = publication.publicationGeneration;
  const result = publication.result;
  if (!isCalendarOk(result)) {
    rs.state = { type: "error", message: result.error };
    return;
  }
  applyResult(result);
}

function applyResult(result: CalendarResultOk): void {
  const applied = applyEventsPush({
    events: result.events,
    provenance: result,
    settings: rs.settings,
    prevState: rs.state,
    prevProvenance: rs.provenance,
    prevSignature: rs.lastEventsSignature,
  });
  rs.provenance = result;
  rs.lastEventsSignature = applied.signature;
  rs.state = applied.state;
}

/**
 * Single refresh path: await coordinated publication from main (no separate forcePoll).
 */
async function loadEvents() {
  const requestId = ++rs.loadRequestId;
  const generationAtStart = rs.loadGeneration;
  render({ type: "loading" });

  try {
    // Fetch settings and permission in parallel — they are independent
    const [fetchedSettings, fetchedPermission] = await Promise.all([
      rs.cachedSettings ?? window.api.settings.get(),
      rs.cachedPermission ?? window.api.calendar.getPermissionStatus(),
    ]);
    if (requestId !== rs.loadRequestId || generationAtStart !== rs.loadGeneration) return;
    rs.settings = rs.cachedSettings ?? fetchedSettings;
    rs.cachedSettings = rs.settings;
    rs.cachedPermission = fetchedPermission;

    if (fetchedPermission === "denied" || fetchedPermission === "not-determined") {
      rs.state = { type: "no-permission", retrying: false };
      render();
      return;
    }

    const publication = await window.api.calendar.getEvents();
    if (requestId !== rs.loadRequestId) return;
    applyPublication(publication);
  } catch (err) {
    if (requestId !== rs.loadRequestId || generationAtStart !== rs.loadGeneration) return;
    rs.state = {
      type: "error",
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }

  render();
}

async function init() {
  setupDelegatedEvents({
    onForcePoll: () => {
      // Single path: coordinated GET_EVENTS (main schedules + returns publication).
      void loadEvents();
    },
    onGrantAccess: () => void grantAccess(),
    onJoinMeeting: (eventId) => {
      void window.api.app.joinMeeting(eventId).then((result) => {
        if (!result.ok) {
          console.error("[renderer] Join failed:", result.error);
          const message =
            typeof result.error === "string" && result.error.length > 0
              ? result.error
              : "Could not open the meeting";
          let banner = document.getElementById("join-error-banner");
          if (!banner) {
            banner = document.createElement("div");
            banner.id = "join-error-banner";
            banner.setAttribute("role", "alert");
            banner.style.cssText =
              "margin:8px 12px;padding:8px 10px;border-radius:8px;background:rgba(255,69,58,0.16);color:#ffb4ae;font-size:12px;";
            document.body.prepend(banner);
          }
          banner.textContent = message.slice(0, 160);
          window.setTimeout(() => {
            banner?.remove();
          }, 5_000);
        }
      });
    },
  });

  // Main pushes full publications after polls / coordinated refreshes.
  window.api.calendar.onResultUpdated((publication: CalendarPublication) => {
    if (publication.publicationGeneration < rs.loadGeneration) return;
    applyPublication(publication);
    render();
  });

  // Listen for settings changes from the settings window
  window.api.settings.onChanged((updated: AppSettings) => {
    const previous = rs.settings;
    rs.cachedSettings = updated;
    rs.settings = updated;
    // Display-only toggle: local re-render/re-arm — no calendar fetch.
    if (isOnlyCompletedHistoryToggle(previous, updated)) {
      render();
      return;
    }
    void loadEvents();
  });

  rs.version = await window.api.app.getVersion();

  // Initial load
  await loadEvents();

  // On show: always re-render from cached state so ended meetings drop immediately.
  // Soft "In N min" / end membership while open is driven by main display-horizon
  // pushes (CALENDAR_RESULT_UPDATED). Network refresh remains debounced.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // Local re-filter with Date.now() — no loading flash, no network required.
      render();
      const now = Date.now();
      if (now - rs.lastPollTime >= 5000) {
        rs.lastPollTime = now;
        void loadEvents();
      }
    }
  });

  // Keyboard accessibility: Escape closes, Enter/Space activates focused button
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      window.blur?.();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.dataset["action"]) {
        e.preventDefault();
        active.click();
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", () => init());
