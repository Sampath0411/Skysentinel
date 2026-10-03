/**
 * Fixed-timestep simulation clock (PRD §5.1 FR-SIM-1, DECISIONS.md D5).
 *
 * Sim time is integer milliseconds and never derived from the wall clock. The
 * clock advances in whole ticks; it does not accept a real elapsed time, because
 * that would make the simulation depend on machine speed.
 *
 * 20 Hz is the PRD-specified rate: 50 ms per tick.
 */

import type { Millis } from "@skysentinel/shared";

export const TICK_HZ = 20;
export const TICK_MS: Millis = 1000 / TICK_HZ; // exactly 50

export interface Clock {
  /** Current sim time in integer milliseconds. */
  now(): Millis;
  /** Current tick index, starting at 0 before the first step. */
  tick(): number;
  /** Advance one fixed step and return the new time. */
  step(): Millis;
  /** Advance `n` steps. */
  stepBy(n: number): Millis;
  /** Has the clock reached the end of the scenario? */
  atEnd(): boolean;
  /** Scenario duration in ms. */
  duration(): Millis;
  /** Seconds elapsed, as a float, for display only. */
  seconds(): number;
}

/**
 * Create a clock for a scenario of `durationMs`.
 *
 * The clock stops exactly at the duration: the final returned time never exceeds
 * `durationMs`, which keeps replay positions comparable across runs.
 */
export const createClock = (durationMs: Millis): Clock => {
  let t = 0;
  let ticks = 0;

  return {
    now: () => t,
    tick: () => ticks,
    duration: () => durationMs,

    step(): Millis {
      if (t >= durationMs) return t;
      t = Math.min(t + TICK_MS, durationMs);
      ticks += 1;
      return t;
    },

    stepBy(n: number): Millis {
      if (n <= 0) return t;
      // Clamp so a long run cannot overshoot the scenario end.
      const target = Math.min(t + n * TICK_MS, durationMs);
      ticks += Math.round((target - t) / TICK_MS);
      t = target;
      return t;
    },

    atEnd: () => t >= durationMs,
    seconds: () => t / 1000,
  };
};

/** Convert milliseconds to whole ticks (useful for spawn scheduling). */
export const msToTicks = (ms: Millis): number => Math.round(ms / TICK_MS);

/** Convert whole ticks to milliseconds. */
export const ticksToMs = (ticks: number): Millis => ticks * TICK_MS;

/** Seconds to milliseconds, as an integer. */
export const sToMs = (seconds: number): Millis => Math.round(seconds * 1000);