/**
 * Feeds the interpolation in `interpolate.ts` into the canvas draw loops.
 *
 * ## Why a reader function rather than state
 *
 * The obvious shape — hold the smoothed tracks in state and re-render at 60 Hz —
 * is wrong here. It would put a React render on every animation frame, with five
 * panels' worth of diffing, to move a handful of pixels. The canvases already own
 * a `requestAnimationFrame` loop and keep the authoritative props in refs; they
 * draw from those refs, so they already have the machinery this needs.
 *
 * So this hook's job is narrow: hold the last two frames, and hand the draw loops
 * a stable `read()` that returns the tracks for *right now*. The canvases call it
 * inside the loop they already run and get 60 Hz motion, while React re-renders at
 * the wire rate (20 Hz) — where it belongs, since everything in the tree except
 * the blips is driven by the sim's own state and has no business re-rendering
 * faster than the sim advances.
 *
 * The returned function's identity never changes, so the canvases can hold it in
 * a ref without re-subscribing on every frame.
 */

import { useCallback, useEffect, useRef } from "react";
import type { FusedTrack } from "@skysentinel/sim-core";

import { FrameClock, smoothTracks } from "./interpolate.js";

export interface SimFrame {
  /** Sim time of this frame. Also its identity: two frames at the same `t_ms` are one frame. */
  t_ms: number;
  tracks: readonly FusedTrack[];
}

interface Buffered {
  from: readonly FusedTrack[];
  to: readonly FusedTrack[];
  /** The `t_ms` of `to`, kept so a replayed frame can be recognised. */
  to_t_ms: number;
  /** `performance.now()` at which `to` was handed over by the socket. */
  to_at: number;
}

const NO_TRACKS: readonly FusedTrack[] = [];

/**
 * `frames`: the newest frame received, or `null` before the first one arrives.
 *
 * Returns the tracks to draw on this animation frame. Stable across renders.
 */
export const useSmoothTracks = (frames: SimFrame | null): (() => readonly FusedTrack[]) => {
  const clockRef = useRef<FrameClock | null>(null);
  const bufferRef = useRef<Buffered | null>(null);

  useEffect(() => {
    if (frames === null) return;
    const now = performance.now();
    const prev = bufferRef.current;

    // A frame at a sim time already seen is a resend, not a new frame: a
    // reconnecting socket is sent the current state again before its next tick.
    // Buffering it would push `to_at` forward and restart the interpolation
    // window from a standing start — the visible effect is a brief stutter at
    // exactly the moment someone reconnects.
    if (prev !== null && frames.t_ms <= prev.to_t_ms) return;

    bufferRef.current = {
      from: prev === null ? frames.tracks : prev.to,
      to: frames.tracks,
      to_t_ms: frames.t_ms,
      to_at: now,
    };
    clockRef.current ??= new FrameClock();
    clockRef.current.arrival(now);
  }, [frames]);

  const read = useCallback((): readonly FusedTrack[] => {
    const buf = bufferRef.current;
    if (buf === null) return NO_TRACKS;
    const clock = clockRef.current;
    if (clock === null) return buf.to;

    return smoothTracks({
      from: buf.from,
      to: buf.to,
      elapsed_since_to_ms: performance.now() - buf.to_at,
      interval_ms: clock.interval_ms,
    });
  }, []);

  return read;
};