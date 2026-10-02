import type { AppState } from "../../shared/app-state.js";
import type { AppSettings } from "../../domain/entities/settings.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import type {
  CalendarResultOkLive,
  CalendarResultOkOffline,
} from "../../domain/entities/calendar-result.js";
import { eventListSignature } from "../../domain/services/event-signature.js";
import { isTomorrow } from "../../domain/services/time.js";

export type CalendarProvenance =
  | Pick<CalendarResultOkLive, "source" | "completeness" | "observedAt">
  | Pick<CalendarResultOkOffline, "source" | "observedAt">;

export interface ApplyEventsPushInput {
  readonly events: readonly MeetingEvent[];
  readonly provenance: CalendarProvenance;
  readonly settings: AppSettings;
  readonly prevState: AppState;
  readonly prevProvenance: CalendarProvenance | null;
  readonly prevSignature: string;
}

export interface ApplyEventsPushResult {
  readonly state: AppState;
  readonly provenance: CalendarProvenance;
  readonly signature: string;
  readonly didChange: boolean;
}

export function applyEventsPush(input: ApplyEventsPushInput): ApplyEventsPushResult {
  const { events, provenance, settings, prevState, prevProvenance, prevSignature } = input;
  const filtered = settings.showTomorrowMeetings
    ? events
    : events.filter((e) => !isTomorrow(e.startDate));

  const signature = eventListSignature(filtered);
  const sameRows =
    signature === prevSignature &&
    (prevState.type === "has-events" || prevState.type === "no-events");
  let sameProvenance: boolean;
  switch (provenance.source) {
    case "live":
      sameProvenance =
        prevProvenance?.source === "live" &&
        prevProvenance.completeness === provenance.completeness &&
        prevProvenance.observedAt === provenance.observedAt;
      break;
    case "offline-cache":
      sameProvenance =
        prevProvenance?.source === "offline-cache" &&
        prevProvenance.observedAt === provenance.observedAt;
      break;
  }

  if (sameRows) {
    return { state: prevState, provenance, signature, didChange: !sameProvenance };
  }

  const state: AppState =
    filtered.length === 0 ? { type: "no-events" } : { type: "has-events", events: [...filtered] };
  return { state, provenance, signature, didChange: true };
}
