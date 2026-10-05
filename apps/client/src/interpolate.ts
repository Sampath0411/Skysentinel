/**
 * Frame interpolation (PRD §13.1 "smooth continuous movement").
 *
 * ## The problem
 *
 * The server steps the sim at 20 Hz (`TICK_MS = 50`) and pushes one frame per
 * tick. That is the right rate for the *record* — it is the resolution of the
 * event log, which is the assessment artefact — but it is visibly steppy for a
 * *display*: a monitor redraws at 60 Hz, so two frames in three re-draw exactly
 * the pixels the last one drew and the third teleports the contact. Fast runs are
 * worse: at 4× the frames land every 12 ms of wall clock and the loop is fine,
 * but at 1× the eye has 50 ms of stillness between every step.
 *
 * ## The fix
 *
 * Interpolate *between* two authoritative frames rather than stepping to one.
 * The client holds the last two frames and, on every animation frame, asks for
 * the position partway from the older to the newer in step with how long it has
 * actually been since the newer one was due. That renders at the display's own
 * refresh rate, so motion is continuous regardless of the wire rate.
 *
 * Two properties matter more than the smoothness:
 *
 * 1. **Nothing is extrapolated.** Every drawn position is between two positions
 *    the sim actually reported, so the client never invents a track location
 *    (CLAUDE.md: the server owns the truth; the client is a view).
 * 2. **The lag is one frame interval, and it is bounded.** Rendering `previous` at
 *    `alpha = 0` means the newest frame is not shown until it has been in hand
 *    for one interval. At 20 Hz that is 50 ms — under the ~100 ms threshold at
 *    which added latency reads as sluggish — and it buys motion that never
 *    overshoots. `MAX_LEAD_MS` caps how far ahead of the newest frame the clock
 *    may run, so a stalled socket or a backgrounded tab resumes by snapping to
 *    the newest frame instead of crawling toward it from behind.
 */

import type { FusedTrack } from "@skysentinel/sim-core";

/** How far past the newest frame the render clock may run before it gives up. */
export const MAX_LEAD_MS = 250;

/** Shortest signed angular difference `to - from`, in degrees, within (-180, 180]. */
export const bearingDelta = (to: number, from: number): number => {
  const d = (to - from) % 360;
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
};

/** Normalise any bearing into [0, 360). */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

export interface FramePair {
  /** The older of the two frames. */
  from: readonly FusedTrack[];
  /** The newer of the two frames — the most recent one received. */
  to: readonly FusedTrack[];
  /**
   * How long the newer frame had been in hand when the render frame ran, in ms.
   * The caller supplies this from `performance.now()`; passing wall-clock in from
   * the caller keeps this module free of ambient time.
   */
  elapsed_since_to_ms: number;
  /** How long one frame interval took, in ms. Estimated from recent arrivals. */
  interval_ms: number;
}

/**
 * Where on the way from `from` to `to` the render frame sits, as 0…1.
 *
 * At the moment `to` arrives the answer is 0, so a frame is never displayed
 * before its successor exists. It reaches 1 one interval later, which is exactly
 * when the next frame is due; holding at 1 until then means a slightly late
 * frame shows the newest position rather than a stale one.
 */
export const lerpAlpha = (elapsed_since_to_ms: number, interval_ms: number): number => {
  if (interval_ms <= 0) return 1;
  const alpha = elapsed_since_to_ms / interval_ms;
  return Math.max(0, Math.min(1, alpha));
};

/** True when the render clock has run so far past `to` that interpolation is pointless. */
export const isStale = (elapsed_since_to_ms: number): boolean => elapsed_since_to_ms > MAX_LEAD_MS;

/**
 * The tracks to draw on this animation frame.
 *
 * A track in both frames slides between the two positions. A track in only one of
 * them is drawn where it is — a new track has no history to interpolate from,
 * and one that has aged out has nothing left to show.
 */
export const smoothTracks = (pair: FramePair): FusedTrack[] => {
  const { from, to } = pair;
  if (isStale(pair.elapsed_since_to_ms)) return [...to];

  const alpha = lerpAlpha(pair.elapsed_since_to_ms, pair.interval_ms);
  if (alpha <= 0) return [...to];
  if (alpha >= 1) return [...to];

  const prev = new Map(from.map((t) => [t.track_id, t]));
  return to.map((t) => {
    const p = prev.get(t.track_id);
    if (p === undefined) return t;

    // Range is optional on a track; a track with no range in either frame stays
    // without one rather than being given a fabricated 0 m fix.
    const range_m =
      t.range_m === undefined && p.range_m === undefined
        ? undefined
        : (p.range_m ?? 0) * (1 - alpha) + (t.range_m ?? 0) * alpha;

    return {
      ...t,
      bearing_deg: norm360(p.bearing_deg + bearingDelta(t.bearing_deg, p.bearing_deg) * alpha),
      ...(range_m === undefined ? {} : { range_m }),
    };
  });
};

/**
 * A running estimate of the frame interval, from the gaps between arrivals.
 *
 * Seeded at 50 ms — the sim's own `TICK_MS` — so the very first frames, before
 * two arrivals have been seen, interpolate against the right rate rather than
 * dividing by zero. The estimate is an EMA rather than the last gap because a
 * single delayed frame (a GC pause, a busy disk) should not make every later
 * frame jump straight to its endpoint.
 */
export class FrameClock {
  /** The sim's own tick period: the interval to assume before any frame arrives. */
  static readonly NOMINAL_INTERVAL_MS = 50;

  private last_arrival: number | null = null;
  private interval = FrameClock.NOMINAL_INTERVAL_MS;

  /** Record a frame arrival at `now_ms` and return the current interval estimate. */
  arrival(now_ms: number): number {
    if (this.last_arrival !== null) {
      const gap = Math.max(1, now_ms - this.last_arrival);
      this.interval = this.interval * 0.7 + gap * 0.3;
    }
    this.last_arrival = now_ms;
    return this.interval;
  }

  /** The current interval estimate. */
  get interval_ms(): number {
    return this.interval;
  }
}

export type Vec3 = readonly [number, number, number];

/**
 * Smooths a keyed set of world positions between frames.
 *
 * `smoothTracks` handles the track list, which is rebuilt each frame and arrives
 * as an array. The instructor's truth map instead holds a `Map` of ids to
 * positions that is updated in place, and it needs the same easing for two
 * independently-moving sets: the ground-truth entities and the trainee's own
 * track estimates. Sharing one clock across both keeps them in step, which is the
 * point of that view — the gap between the two markers *is* the exercise (D40).
 *
 * Ids absent from the latest update are dropped rather than extrapolated, so a
 * neutralised entity does not sail off screen on a stale position.
 */
export class PositionSmoother {
  private readonly from = new Map<string, Vec3>();
  private readonly to = new Map<string, Vec3>();
  private to_at = 0;
  private readonly clock = new FrameClock();
  private primed = false;

  /**
   * Replace the current set. `positions` is every key present in this frame;
   * keys missing from it are forgotten, not carried forward.
   */
  update(positions: ReadonlyMap<string, Vec3>, now_ms: number): void {
    if (this.primed) {
      this.from.clear();
      for (const [k, v] of this.to) this.from.set(k, v);
    }
    this.to.clear();
    for (const [k, v] of positions) this.to.set(k, v);
    this.to_at = now_ms;
    this.clock.arrival(now_ms);
    this.primed = true;
  }

  /** The position to draw for `key` right now, or `undefined` if it is not present. */
  position(key: string, now_ms: number): Vec3 | undefined {
    const to = this.to.get(key);
    if (to === undefined) return undefined;
    const from = this.from.get(key);
    if (from === undefined) return to;

    const alpha = isStale(now_ms - this.to_at)
      ? 1
      : lerpAlpha(now_ms - this.to_at, this.clock.interval_ms);
    if (alpha >= 1) return to;

    return [
      from[0] + (to[0] - from[0]) * alpha,
      from[1] + (to[1] - from[1]) * alpha,
      from[2] + (to[2] - from[2]) * alpha,
    ];
  }
}