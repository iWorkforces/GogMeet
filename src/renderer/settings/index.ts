import "./styles.css";
import type { AppSettings } from "../../domain/entities/settings.js";
import type { CalendarUiState } from "../../domain/entities/calendar-ui-state.js";
import { defaultCalendarUiState } from "../../domain/entities/calendar-ui-state.js";
import {
  DEFAULT_SETTINGS,
  OPEN_BEFORE_MINUTES_MIN,
  OPEN_BEFORE_MINUTES_MAX,
  ALERT_LEAD_SECONDS_MIN,
  ALERT_LEAD_SECONDS_MAX,
  LATE_JOIN_GRACE_MINUTES_MIN,
  LATE_JOIN_GRACE_MINUTES_MAX,
  isHHmm,
} from "../../domain/entities/settings.js";
import { queryRequiredElement } from "../utils/dom.js";
import { escapeHtml } from "../../shared/utils/escape-html.js";
import { APP_ICON_AURORA_CSS, appIconWithAuroraHtml } from "../../shared/utils/app-icon-aurora.js";
import appIconUrl from "../../assets/about-icon.svg";

/** Inject shared aurora CSS once (About embeds the same string in data: HTML). */
function ensureAppIconAuroraStyles(): void {
  if (document.getElementById("app-icon-aurora-styles")) return;
  const style = document.createElement("style");
  style.id = "app-icon-aurora-styles";
  style.textContent = APP_ICON_AURORA_CSS;
  document.head.appendChild(style);
}

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let calendarUi: CalendarUiState = defaultCalendarUiState();
let isSaving = false;
/** Coalesce concurrent saves: merge latest partial; waiters resolve when applied. */
let pendingSave: {
  partial: Partial<AppSettings>;
  indicatorId: string;
  waiters: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }>;
} | null = null;
let isCalendarBusy = false;
/** An edit owns the UI even if its save finishes before an older refresh resumes. */
let settingsRevision = 0;
let saveIndicatorTimers = new Map<string, ReturnType<typeof setTimeout>>();

const ALERT_LEAD_OPTIONS = [0, 15, 30, 60, 120, 180, 300] as const;

function isDarwinRenderer(): boolean {
  return /Mac/i.test(navigator.userAgent) && !/Win|Windows/i.test(navigator.userAgent);
}

function calendarAccountSectionHtml(): string {
  // macOS uses EventKit system calendars — do not surface Google Connect UI.
  if (isDarwinRenderer()) {
    const permission = calendarUi.permission;
    const statusLine =
      permission === "granted"
        ? "Using system calendars (EventKit)"
        : permission === "denied"
          ? "Calendar access denied — enable in System Settings"
          : "Calendar access not granted yet";
    const dotClass =
      permission === "granted" ? "account-status-dot account-status-dot--on" : "account-status-dot";
    return `
      <section class="settings-section" aria-labelledby="section-calendar">
        <h2 class="settings-section-heading" id="section-calendar">Calendar</h2>
        <div class="settings-group" id="calendar-account-group">
          <div class="setting-row">
            <div class="setting-row-inner">
              <span class="setting-label" id="account-label">macOS calendars</span>
              <span class="account-status" id="account-status-text">
                <span class="${dotClass}" aria-hidden="true"></span>
                <span class="setting-description">${statusLine}</span>
              </span>
            </div>
          </div>
        </div>
        ${
          calendarUi.lastError
            ? `<p class="settings-error" role="alert">${escapeHtml(calendarUi.lastError)}</p>`
            : ""
        }
        <p class="settings-section-footer">GogMeet reads meetings from calendars already on this Mac. Grant access from the tray if prompted.</p>
      </section>
  `;
  }

  const connected = calendarUi.permission === "granted";
  const email = calendarUi.accountEmail ? escapeHtml(calendarUi.accountEmail) : "Google Calendar";
  const statusLine = connected
    ? `Connected as ${email}`
    : calendarUi.oauthConfigured
      ? "Not connected — required for meeting reminders on Windows"
      : "This build can’t connect to Google Calendar";
  const actionLabel = connected
    ? "Disconnect"
    : calendarUi.permission === "denied"
      ? "Reconnect"
      : "Connect";
  const actionId = connected ? "calendar-disconnect-btn" : "calendar-connect-btn";
  const disabled = isCalendarBusy || (!connected && !calendarUi.oauthConfigured) ? " disabled" : "";
  const btnClass = connected ? "setting-button setting-button--destructive" : "setting-button";
  const dotClass = connected ? "account-status-dot account-status-dot--on" : "account-status-dot";
  const busyAttrs = isCalendarBusy ? ' aria-busy="true"' : "";

  return `
      <section class="settings-section" aria-labelledby="section-calendar"${busyAttrs}>
        <h2 class="settings-section-heading" id="section-calendar">Calendar</h2>
        <div class="settings-group" id="calendar-account-group">
          <div class="setting-row">
            <div class="setting-row-inner">
              <span class="setting-label" id="account-label">Account</span>
              <span class="account-status" id="account-status-text">
                <span class="${dotClass}" aria-hidden="true"></span>
                <span class="setting-description">${statusLine}</span>
              </span>
            </div>
            <div class="setting-control">
              <button type="button" class="${btnClass}" id="${actionId}"${disabled}
                aria-describedby="account-status-text">
                ${isCalendarBusy ? "Working…" : actionLabel}
              </button>
            </div>
          </div>
        </div>
        ${
          calendarUi.lastError
            ? `<p class="settings-error" role="alert">${escapeHtml(calendarUi.lastError)}</p>`
            : ""
        }
        <p class="settings-section-footer">Connect a Google account to list meetings. Outlook/Microsoft Graph is planned for a later version.</p>
      </section>
  `;
}

/** Native checkbox + styled track (no hybrid role=switch on a label). */
function toggleRowHtml(
  id: string,
  label: string,
  description: string,
  checked: boolean,
  indicatorId: string,
  options?: { disabled?: boolean; descriptionId?: string },
): string {
  const disabled = options?.disabled === true;
  const descId = options?.descriptionId ?? `${id}-desc`;
  const rowDisabledClass = disabled ? " setting-row--disabled" : "";
  return `
          <div class="setting-row setting-row--toggle${rowDisabledClass}">
            <div class="setting-row-inner">
              <label class="setting-label" for="${id}">${label}</label>
              <span class="setting-description" id="${descId}">${description}</span>
            </div>
            <div class="setting-control">
              <span class="save-indicator" id="${indicatorId}" aria-live="polite"></span>
              <label class="toggle-switch">
                <input type="checkbox" id="${id}" class="toggle-input"${checked ? " checked" : ""}${
                  disabled ? " disabled" : ""
                }
                  aria-describedby="${descId}" />
                <span class="toggle-track" aria-hidden="true">
                  <span class="toggle-thumb"></span>
                </span>
              </label>
            </div>
          </div>`;
}

function selectRowHtml(
  id: string,
  label: string,
  description: string,
  optionsHtml: string,
  indicatorId: string,
  options?: { disabled?: boolean; descriptionId?: string },
): string {
  const disabled = options?.disabled === true;
  const descId = options?.descriptionId ?? `${id}-desc`;
  const rowDisabledClass = disabled ? " setting-row--disabled" : "";
  return `
          <div class="setting-row${rowDisabledClass}">
            <div class="setting-row-inner">
              <label class="setting-label" for="${id}">${label}</label>
              <span class="setting-description" id="${descId}">${description}</span>
            </div>
            <div class="setting-control">
              <span class="save-indicator" id="${indicatorId}" aria-live="polite"></span>
              <select class="setting-select" id="${id}" aria-describedby="${descId}"${
                disabled ? " disabled" : ""
              }>
                ${optionsHtml}
              </select>
            </div>
          </div>`;
}

function timeRowHtml(
  id: string,
  label: string,
  value: string,
  indicatorId: string,
  options?: { disabled?: boolean },
): string {
  const disabled = options?.disabled === true;
  const rowDisabledClass = disabled ? " setting-row--disabled" : "";
  const safeValue = isHHmm(value) ? value : "00:00";
  return `
          <div class="setting-row${rowDisabledClass}">
            <div class="setting-row-inner">
              <label class="setting-label" for="${id}">${label}</label>
            </div>
            <div class="setting-control">
              <span class="save-indicator" id="${indicatorId}" aria-live="polite"></span>
              <input type="time" class="setting-time" id="${id}" value="${safeValue}"${
                disabled ? " disabled" : ""
              } />
            </div>
          </div>`;
}

function openBeforeOptionsHtml(): string {
  return Array.from({ length: OPEN_BEFORE_MINUTES_MAX - OPEN_BEFORE_MINUTES_MIN + 1 }, (_, i) => {
    const val = OPEN_BEFORE_MINUTES_MIN + i;
    const selected = val === settings.openBeforeMinutes ? " selected" : "";
    const label = val === 0 ? "At start" : val === 1 ? "1 minute" : `${val} minutes`;
    return `<option value="${val}"${selected}>${label}</option>`;
  }).join("");
}

function alertLeadOptionsHtml(): string {
  const current = settings.alertLeadSeconds;
  const values = ALERT_LEAD_OPTIONS.includes(current as (typeof ALERT_LEAD_OPTIONS)[number])
    ? [...ALERT_LEAD_OPTIONS]
    : [...ALERT_LEAD_OPTIONS, current].sort((a, b) => a - b);

  return values
    .map((val) => {
      const selected = val === current ? " selected" : "";
      const label =
        val === 0
          ? "At open"
          : val < 60
            ? `${val} seconds`
            : `${val / 60} minute${val === 60 ? "" : "s"}`;
      return `<option value="${val}"${selected}>${label}</option>`;
    })
    .join("");
}

function lateJoinOptionsHtml(): string {
  return Array.from(
    { length: LATE_JOIN_GRACE_MINUTES_MAX - LATE_JOIN_GRACE_MINUTES_MIN + 1 },
    (_, i) => {
      const val = LATE_JOIN_GRACE_MINUTES_MIN + i;
      const selected = val === settings.lateJoinGraceMinutes ? " selected" : "";
      const label = val === 0 ? "Off" : val === 1 ? "1 minute" : `${val} minutes`;
      return `<option value="${val}"${selected}>${label}</option>`;
    },
  ).join("");
}

function render(errorMessage?: string): void {
  const app = document.getElementById("app");
  if (!app) return;

  ensureAppIconAuroraStyles();

  const autoOpen = settings.autoOpenEnabled;
  const windowAlert = settings.windowAlert;
  const quietOn = settings.quietHoursEnabled;

  app.innerHTML = `
    <header class="settings-titlebar">
      <h1 class="settings-title">Settings</h1>
    </header>
    <div class="settings-brand">
      ${appIconWithAuroraHtml(appIconUrl, { size: 72, className: "app-icon-aurora--settings" })}
    </div>
    <main class="settings-content" id="settings-main">
      ${calendarAccountSectionHtml()}

      <section class="settings-section" aria-labelledby="section-joining">
        <h2 class="settings-section-heading" id="section-joining">Joining Meetings</h2>
        <div class="settings-group">
          ${toggleRowHtml(
            "auto-open-toggle",
            "Auto-Open Browser",
            "Open meeting links automatically before they start",
            settings.autoOpenEnabled,
            "auto-open-save-indicator",
          )}
          ${selectRowHtml(
            "open-before-select",
            "Open browser before meeting",
            autoOpen ? "How early to open the join link" : "Used when Auto-Open is on",
            openBeforeOptionsHtml(),
            "save-indicator",
            { disabled: !autoOpen },
          )}
          ${toggleRowHtml(
            "window-alert-toggle",
            "Meeting Alert",
            autoOpen
              ? "Show a full-screen alert before auto-open"
              : "Requires Auto-Open to be enabled",
            settings.windowAlert,
            "alert-save-indicator",
            { disabled: !autoOpen },
          )}
          ${selectRowHtml(
            "alert-lead-select",
            "Alert lead time",
            windowAlert && autoOpen
              ? "How long before open to show the alert"
              : "Used when Meeting Alert is on",
            alertLeadOptionsHtml(),
            "alert-lead-save-indicator",
            { disabled: !autoOpen || !windowAlert },
          )}
          ${toggleRowHtml(
            "native-notif-toggle",
            "Notifications",
            autoOpen
              ? "Show a system notification when a meeting auto-opens"
              : "Requires Auto-Open to be enabled",
            settings.nativeNotifications,
            "native-notif-save-indicator",
            { disabled: !autoOpen },
          )}
          ${selectRowHtml(
            "late-join-select",
            "Late join grace",
            autoOpen
              ? "Still auto-open shortly after a meeting has started"
              : "Requires Auto-Open to be enabled",
            lateJoinOptionsHtml(),
            "late-join-save-indicator",
            { disabled: !autoOpen },
          )}
          ${toggleRowHtml(
            "quiet-hours-toggle",
            "Quiet Hours",
            "Hides alerts and OS notifications only. Browser auto-open still runs so you don’t miss joins (times may wrap past midnight)",
            settings.quietHoursEnabled,
            "quiet-hours-save-indicator",
          )}
          ${timeRowHtml(
            "quiet-hours-start",
            "Quiet hours start",
            settings.quietHoursStart,
            "quiet-start-save-indicator",
            {
              disabled: !quietOn,
            },
          )}
          ${timeRowHtml(
            "quiet-hours-end",
            "Quiet hours end",
            settings.quietHoursEnd,
            "quiet-end-save-indicator",
            {
              disabled: !quietOn,
            },
          )}
        </div>
        ${
          errorMessage
            ? `<p class="settings-error" role="alert">${escapeHtml(errorMessage)}</p>`
            : ""
        }
      </section>

      <section class="settings-section" aria-labelledby="section-display">
        <h2 class="settings-section-heading" id="section-display">Tray Menu</h2>
        <div class="settings-group">
          ${toggleRowHtml(
            "show-tomorrow-toggle",
            "Tomorrow's Meetings",
            "Include tomorrow's meetings in the tray menu",
            settings.showTomorrowMeetings,
            "tomorrow-save-indicator",
          )}
          ${toggleRowHtml(
            "show-completed-meetings-toggle",
            "Completed Meetings",
            "Show today's finished meetings as muted history",
            settings.showCompletedTodayMeetings,
            "completed-save-indicator",
          )}
        </div>
      </section>

      <section class="settings-section" aria-labelledby="section-general">
        <h2 class="settings-section-heading" id="section-general">General</h2>
        <div class="settings-group">
          ${toggleRowHtml(
            "launch-at-login-toggle",
            "Open at Login",
            "Start GogMeet when you log in to this computer",
            settings.launchAtLogin,
            "launch-save-indicator",
          )}
        </div>
      </section>
    </main>
    <footer class="settings-footer">
      <span class="settings-footer-text">GogMeet · ${new Date().getFullYear()}</span>
    </footer>
  `;

  wireControls();
}

function wireControls(): void {
  setupNumberSelectListener(
    "open-before-select",
    OPEN_BEFORE_MINUTES_MIN,
    OPEN_BEFORE_MINUTES_MAX,
    (v) => ({ openBeforeMinutes: v }),
    "save-indicator",
    true,
  );
  setupNumberSelectListener(
    "alert-lead-select",
    ALERT_LEAD_SECONDS_MIN,
    ALERT_LEAD_SECONDS_MAX,
    (v) => ({ alertLeadSeconds: v }),
    "alert-lead-save-indicator",
    true,
  );
  setupNumberSelectListener(
    "late-join-select",
    LATE_JOIN_GRACE_MINUTES_MIN,
    LATE_JOIN_GRACE_MINUTES_MAX,
    (v) => ({ lateJoinGraceMinutes: v }),
    "late-join-save-indicator",
    true,
  );
  setupTimeListener("quiet-hours-start", "quietHoursStart", "quiet-start-save-indicator");
  setupTimeListener("quiet-hours-end", "quietHoursEnd", "quiet-end-save-indicator");

  setupToggleListener("launch-at-login-toggle", "launchAtLogin", "launch-save-indicator");
  setupToggleListener("show-tomorrow-toggle", "showTomorrowMeetings", "tomorrow-save-indicator");
  setupToggleListener(
    "show-completed-meetings-toggle",
    "showCompletedTodayMeetings",
    "completed-save-indicator",
  );
  setupToggleListener("window-alert-toggle", "windowAlert", "alert-save-indicator", true);
  setupToggleListener("auto-open-toggle", "autoOpenEnabled", "auto-open-save-indicator", true);
  setupToggleListener("native-notif-toggle", "nativeNotifications", "native-notif-save-indicator");
  setupToggleListener(
    "quiet-hours-toggle",
    "quietHoursEnabled",
    "quiet-hours-save-indicator",
    true,
  );
  setupCalendarAccountListeners();
}

function setupCalendarAccountListeners(): void {
  const connectBtn = document.getElementById("calendar-connect-btn");
  const disconnectBtn = document.getElementById("calendar-disconnect-btn");

  connectBtn?.addEventListener("click", () => {
    void (async () => {
      if (isCalendarBusy) return;
      settingsRevision++;
      isCalendarBusy = true;
      render();
      try {
        await window.api.calendar.requestPermission();
        calendarUi = await window.api.calendar.getUiState();
      } catch {
        // keep previous state
      } finally {
        isCalendarBusy = false;
        render();
        document.getElementById("calendar-connect-btn")?.focus();
        document.getElementById("calendar-disconnect-btn")?.focus();
      }
    })();
  });

  disconnectBtn?.addEventListener("click", () => {
    void (async () => {
      if (isCalendarBusy) return;
      settingsRevision++;
      isCalendarBusy = true;
      render();
      try {
        await window.api.calendar.disconnect();
        calendarUi = await window.api.calendar.getUiState();
      } catch {
        // keep previous state
      } finally {
        isCalendarBusy = false;
        render();
        document.getElementById("calendar-connect-btn")?.focus();
      }
    })();
  });
}

function showSaveIndicator(id: string, text: string): void {
  const indicator = document.getElementById(id);
  if (!indicator) return;

  const existingTimer = saveIndicatorTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Clear then set so polite live regions re-announce identical text.
  indicator.textContent = "";
  indicator.classList.remove("visible");
  // Force a reflow so the subsequent text change is observed.
  void indicator.offsetWidth;
  indicator.textContent = text;
  indicator.classList.add("visible");

  const timer = setTimeout(() => {
    indicator.classList.remove("visible");
    indicator.textContent = "";
    saveIndicatorTimers.delete(id);
  }, 1500);
  saveIndicatorTimers.set(id, timer);
}

function clearSaveIndicatorTimers(): void {
  for (const timer of saveIndicatorTimers.values()) {
    clearTimeout(timer);
  }
  saveIndicatorTimers.clear();
}

function setupNumberSelectListener(
  selectId: string,
  min: number,
  max: number,
  toPartial: (value: number) => Partial<AppSettings>,
  indicatorId: string,
  needsRerender: boolean,
): void {
  const select = queryRequiredElement(selectId, HTMLSelectElement);
  if (!select) return;

  select.addEventListener("change", () => {
    const value = parseInt(select.value, 10);
    if (isNaN(value) || value < min || value > max) {
      return;
    }
    void saveSettings(toPartial(value), indicatorId, needsRerender);
  });
}

function setupTimeListener(
  inputId: string,
  key: "quietHoursStart" | "quietHoursEnd",
  indicatorId: string,
): void {
  const input = queryRequiredElement(inputId, HTMLInputElement);
  if (!input) return;

  input.addEventListener("change", () => {
    const value = input.value;
    if (!isHHmm(value)) {
      input.value = settings[key];
      return;
    }
    void saveSettings({ [key]: value }, indicatorId, false);
  });
}

type ToggleSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

function setupToggleListener(
  toggleId: string,
  settingKey: ToggleSettingKey,
  indicatorId: string,
  needsRerender = false,
): void {
  const toggle = queryRequiredElement(toggleId, HTMLInputElement);
  if (!toggle) return;

  toggle.addEventListener("change", () => {
    const previous = settings[settingKey];
    const next = toggle.checked;
    void saveToggleSetting(toggle, settingKey, next, previous, indicatorId, needsRerender);
  });
}

async function saveToggleSetting(
  toggle: HTMLInputElement,
  settingKey: ToggleSettingKey,
  next: boolean,
  previous: boolean,
  indicatorId: string,
  needsRerender: boolean,
): Promise<void> {
  const ok = await saveSettings(buildTogglePatch(settingKey, next), indicatorId, needsRerender);
  if (!ok || settings[settingKey] !== next) {
    revertToggle(toggle, previous);
  }
}

function buildTogglePatch(key: ToggleSettingKey, value: boolean): Partial<AppSettings> {
  switch (key) {
    case "launchAtLogin":
      return { launchAtLogin: value };
    case "showTomorrowMeetings":
      return { showTomorrowMeetings: value };
    case "showCompletedTodayMeetings":
      return { showCompletedTodayMeetings: value };
    case "windowAlert":
      return { windowAlert: value };
    case "autoOpenEnabled":
      return { autoOpenEnabled: value };
    case "nativeNotifications":
      return { nativeNotifications: value };
    case "quietHoursEnabled":
      return { quietHoursEnabled: value };
  }
}

function revertToggle(toggle: HTMLInputElement, previous: boolean): void {
  toggle.checked = previous;
}

function needsStructureRerender(partial: Partial<AppSettings>): boolean {
  return (
    partial.openBeforeMinutes !== undefined ||
    partial.autoOpenEnabled !== undefined ||
    partial.windowAlert !== undefined ||
    partial.quietHoursEnabled !== undefined ||
    partial.alertLeadSeconds !== undefined ||
    partial.lateJoinGraceMinutes !== undefined ||
    partial.quietHoursStart !== undefined ||
    partial.quietHoursEnd !== undefined
  );
}

async function saveSettings(
  partial: Partial<AppSettings>,
  indicatorId: string = "save-indicator",
  forceRerender = false,
): Promise<boolean> {
  settingsRevision++;
  if (isSaving) {
    return new Promise<boolean>((resolve) => {
      if (pendingSave) {
        pendingSave.partial = { ...pendingSave.partial, ...partial };
        pendingSave.indicatorId = indicatorId;
        pendingSave.waiters.push({
          resolve: () => {
            resolve(true);
          },
          reject: () => {
            resolve(false);
          },
        });
      } else {
        pendingSave = {
          partial: { ...partial },
          indicatorId,
          waiters: [
            {
              resolve: () => {
                resolve(true);
              },
              reject: () => {
                resolve(false);
              },
            },
          ],
        };
      }
    });
  }

  isSaving = true;
  const form = document.getElementById("settings-main");
  form?.setAttribute("aria-busy", "true");

  let toSave = partial;
  let indicator = indicatorId;
  let rerender = forceRerender;
  let waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  let ok = true;

  try {
    for (;;) {
      const updated = await window.api.settings.set(toSave);
      settings = updated;

      if (rerender || needsStructureRerender(toSave)) {
        clearSaveIndicatorTimers();
        render();
      }

      showSaveIndicator(indicator, "Saved");
      for (const w of waiters) w.resolve();
      waiters = [];

      if (!pendingSave) break;
      toSave = pendingSave.partial;
      indicator = pendingSave.indicatorId;
      waiters = pendingSave.waiters;
      pendingSave = null;
      rerender = true;
    }
  } catch (err) {
    ok = false;
    for (const w of waiters) w.reject(err);
    if (pendingSave) {
      for (const w of pendingSave.waiters) w.reject(err);
      pendingSave = null;
    }
    const message = err instanceof Error ? err.message : "Failed to save settings";
    clearSaveIndicatorTimers();
    render(message);
  } finally {
    isSaving = false;
    document.getElementById("settings-main")?.removeAttribute("aria-busy");
  }
  return ok;
}

/**
 * Soft-refresh from main without reloading the BrowserWindow.
 * Used after hide-cache re-show and on SETTINGS_CHANGED from other surfaces.
 */
async function refreshFromMain(): Promise<void> {
  if (isSaving || isCalendarBusy) return;
  const revision = ++settingsRevision;
  let nextSettings = settings;
  try {
    const next = await window.api.settings.get();
    if (next && typeof next === "object") {
      nextSettings = next;
    }
  } catch {
    // keep last good settings
  }
  if (revision !== settingsRevision || isSaving || isCalendarBusy) return;
  let nextCalendarUi = calendarUi;
  try {
    const ui = await window.api.calendar.getUiState();
    if (ui && typeof ui === "object") {
      nextCalendarUi = ui;
    }
  } catch {
    // keep last good calendar UI
  }
  if (revision !== settingsRevision || isSaving || isCalendarBusy) return;
  settings = nextSettings;
  calendarUi = nextCalendarUi;
  clearSaveIndicatorTimers();
  render();
}

function wireLifetimeListeners(): void {
  // Re-sync when the hide-cached window becomes visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshFromMain();
    }
  });

  // External prefs updates (and fan-out from SETTINGS_SET while this window is open).
  window.api.settings.onChanged((next) => {
    if (isSaving) return;
    settingsRevision++;
    settings = next;
    clearSaveIndicatorTimers();
    render();
  });
}

async function init(): Promise<void> {
  try {
    settings = await window.api.settings.get();
  } catch {
    // Use default if load fails; render will show no error
  }
  try {
    calendarUi = await window.api.calendar.getUiState();
  } catch {
    calendarUi = defaultCalendarUiState();
  }
  render();
  wireLifetimeListeners();
}

document.addEventListener("DOMContentLoaded", () => {
  void init();
});
