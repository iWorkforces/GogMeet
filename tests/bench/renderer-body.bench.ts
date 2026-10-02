import { bench, describe } from "vitest";
import { renderBody } from "../../src/renderer/rendering/body.js";
import type { CalendarProvenance } from "../../src/renderer/lib/apply-events-push.js";
import type { AppState } from "../../src/shared/app-state.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import { asTestEventId, asTestIsoUtc, createMockEvent, isoFromNow } from "../helpers/test-utils.js";

const EVENT_COUNT = 20;
const provenance: CalendarProvenance = {
  source: "live",
  completeness: "complete",
  observedAt: Date.now(),
};

const state: AppState = {
  type: "has-events",
  events: Array.from({ length: EVENT_COUNT }, (_, index) =>
    createMockEvent({
      id: asTestEventId(`renderer-event-${index}`),
      title: `Renderer Meeting ${index}`,
      startDate: asTestIsoUtc(isoFromNow(10 + index)),
      endDate: asTestIsoUtc(isoFromNow(40 + index)),
      calendarName: index % 2 === 0 ? "Engineering" : "Product",
    }),
  ),
};

describe("renderer body benchmark", () => {
  bench("renderBody/20 events", () => {
    renderBody(state, DEFAULT_SETTINGS, provenance);
  });
});
