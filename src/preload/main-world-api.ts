import type { EventId } from "../domain/entities/brand.js";
import type { AlertPayload } from "../shared/alert.js";
import type { Api } from "./index.js";

export interface AlertActions {
  readonly join: Api["app"]["joinMeeting"];
  readonly begin: (id: EventId) => void;
  readonly finish: (id: EventId) => void;
}

export type AlertSubscriber = (
  callback: (payload: AlertPayload, actions: AlertActions) => void,
) => () => void;

// Electron serializes this installer: every runtime dependency must be a supplied proxy or main-world global.
export function installMainWorldApi(base: Omit<Api, "alert">, subscribe: AlertSubscriber): void {
  const callbacks = new Set<(payload: AlertPayload) => void>();
  let live = true;
  let unsubscribe: (() => void) | null = null;
  let disposePresentation = (): void => undefined;
  let joinMeeting = base.app.joinMeeting;
  let notifyDismissed = (_id: EventId): void => undefined;

  const onShowAlert = (callback: (payload: AlertPayload) => void): (() => void) => {
    if (!live) return () => undefined;
    callbacks.add(callback);
    if (unsubscribe === null) {
      unsubscribe = subscribe((payload, actions) => {
        if (!live) return;
        disposePresentation();
        let active = true;
        let dismissing = false;
        let card: HTMLElement | null = null;
        let timer: number | null = null;
        let finish = (): void => undefined;
        const clearAnimation = (): void => {
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          card?.removeEventListener("animationend", finish);
        };
        disposePresentation = (): void => {
          active = false;
          clearAnimation();
        };
        const startExit = (id: EventId): void => {
          let finished = false;
          finish = (): void => {
            if (!active || finished) return;
            finished = true;
            clearAnimation();
            actions.finish(id);
          };
          if (card === null) {
            finish();
            return;
          }
          timer = window.setTimeout(finish, 300);
          card.addEventListener("animationend", finish, { once: true });
          card.classList.add("alert-dismissing");
        };
        joinMeeting = async (id: string) => {
          const originCard = document.querySelector<HTMLElement>(".alert-card");
          const result = await actions.join(id);
          switch (result.ok) {
            case true:
              if (active && !dismissing && id === payload.id) {
                dismissing = true;
                card = originCard;
                startExit(payload.id);
              }
              break;
            case false:
              break;
            default:
              result satisfies never;
          }
          return result;
        };
        notifyDismissed = (id: EventId): void => {
          if (!active || dismissing) return;
          dismissing = true;
          actions.begin(id);
          card = document.querySelector<HTMLElement>(".alert-card");
          startExit(id);
        };
        for (const listener of callbacks) listener(payload);
      });
    }
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        unsubscribe?.();
        unsubscribe = null;
        disposePresentation();
      }
    };
  };

  Object.defineProperty(globalThis, "api", {
    enumerable: true,
    value: Object.freeze({
      calendar: Object.freeze(base.calendar),
      window: Object.freeze(base.window),
      app: Object.freeze({
        ...base.app,
        get joinMeeting() {
          return joinMeeting;
        },
      }),
      settings: Object.freeze(base.settings),
      alert: Object.freeze({
        onShowAlert,
        get notifyDismissed() {
          return notifyDismissed;
        },
      }),
    }),
  });
  const dispose = (): void => {
    live = false;
    disposePresentation();
    callbacks.clear();
    unsubscribe?.();
    unsubscribe = null;
    window.removeEventListener("unload", dispose);
  };
  window.addEventListener("unload", dispose);
}
