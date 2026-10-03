/**
 * Simulation event emitter (PRD §5.1 FR-SIM-10).
 *
 * The simulation is event-sourced: every state change and trainee action appends an
 * immutable, timestamped event. The emitter is the only way events enter the log,
 * which keeps three guarantees in one place:
 *
 *  1. `seq` is monotonic and gap-free.
 *  2. `t_ms` comes from the simulation clock, never the wall clock.
 *  3. Truth-bearing event types are forced to `visibility: "instructor"`, so an
 *     emitter call that forgets to pass visibility still cannot leak ground truth
 *     to a trainee client (PRD §4, §6.4).
 */

import {
  DEFAULT_VISIBILITY,
  type AnySimEvent,
  type SimEventMap,
  type EventOf,
  type EventType,
  type Visibility,
} from "@skysentinel/shared";
import type { Millis } from "@skysentinel/shared";

export type EventListener = (event: AnySimEvent) => void;

export interface EventEmitter {
  /** Append an event to the log. Returns the stored event with its seq. */
  emit<T extends EventType>(
    type: T,
    payload: SimEventMap[T],
    options?: { actor?: string; visibility?: Visibility; t_ms?: Millis },
  ): EventOf<T>;
  /** All events so far, in order. */
  log(): readonly AnySimEvent[];
  /** Subscribe to new events. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Events of a given type. */
  byType<T extends EventType>(type: T): readonly EventOf<T>[];
  /** The first event of a type, if any. */
  first<T extends EventType>(type: T): EventOf<T> | undefined;
  /** The last event of a type, if any. */
  last<T extends EventType>(type: T): EventOf<T> | undefined;
  /** Current sim time, which the emitter stamps onto new events. */
  now(): Millis;
  /** Advance the emitter's notion of sim time (called by the clock). */
  setTime(t_ms: Millis): void;
}

export interface EventEmitterOptions {
  seedActor?: string;
  startTime?: Millis;
}

export const createEventEmitter = (options: EventEmitterOptions = {}): EventEmitter => {
  const events: AnySimEvent[] = [];
  const listeners: EventListener[] = [];
  let seq = 0;
  let t = options.startTime ?? 0;
  const defaultActor = options.seedActor ?? "system";

  const emitter: EventEmitter = {
    emit(type, payload, opts) {
      // A truth-bearing type can never be downgraded to trainee-visible, whatever
      // the caller passes. This is the structural half of the truth boundary.
      const visibility: Visibility =
        DEFAULT_VISIBILITY[type] === "instructor"
          ? "instructor"
          : (opts?.visibility ?? DEFAULT_VISIBILITY[type]);

      const event = {
        seq: seq++,
        t_ms: opts?.t_ms ?? t,
        type,
        actor: opts?.actor ?? defaultActor,
        visibility,
        payload,
      } as AnySimEvent;

      events.push(event);
      for (const l of listeners) l(event);
      return event as EventOf<typeof type>;
    },

    log: () => events,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    byType(type) {
      return events.filter((e) => e.type === type) as never;
    },

    first(type) {
      return events.find((e) => e.type === type) as never;
    },

    last(type) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.type === type) return events[i] as never;
      }
      return undefined;
    },

    now: () => t,
    setTime(next) {
      t = next;
    },
  };

  return emitter;
};