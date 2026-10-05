/**
 * Frame interpolation.
 *
 * The two properties under test are the ones a smooth display must not break:
 * nothing is drawn that the sim did not report, and the render stays continuous
 * across a frame boundary. A regression in either is invisible in a screenshot
 * and obvious to a trainee watching a contact move.
 */

import { describe, expect, it } from "vitest";
import type { FusedTrack } from "@skysentinel/sim-core";

import { FrameClock, MAX_LEAD_MS, bearingDelta, lerpAlpha, norm360, smoothTracks } from "./interpolate.js";

const track = (id: string, bearing: number, range = 1000): FusedTrack => ({
  track_id: id,
  status: "confirmed",
  bearing_deg: bearing,
  range_m: range,
  speed_mps: 8,
  confidence: 0.8,
  sources: ["radar"],
  first_seen_ms: 0,
  last_seen_ms: 0,
});

describe("bearingDelta", () => {
  it.each([
    ["10 from 350 goes forward over north", 10, 350, 20],
    ["10 from 0 goes backward", 10, 0, 10],
    ["350 from 10 goes backward over north", 350, 10, -20],
    ["identical bearings have no delta", 45, 45, 0],
    ["a full turn is zero, not 360", 90, 90, 0],
  ])("%s", (_label, to, from, expected) => {
    // Interpolation across north is the whole reason this is not plain
    // subtraction: 350°→10° is +20°, not -340°, and a naive lerp sends the
    // track the long way round the scope.
    expect(bearingDelta(to, from)).toBeCloseTo(expected, 6);
  });
});

describe("norm360", () => {
  it.each([
    [10, 10],
    [370, 10],
    [-10, 350],
    [-370, 350],
    [0, 0],
  ])("normalises %s to %s", (input, expected) => {
    expect(norm360(input)).toBeCloseTo(expected, 6);
  });
});

describe("lerpAlpha", () => {
  it("is 0 the instant the newest frame arrives, so it is never drawn early", () => {
    expect(lerpAlpha(0, 50)).toBe(0);
  });

  it("reaches 1 after one interval, which is when the next frame is due", () => {
    expect(lerpAlpha(50, 50)).toBe(1);
  });

  it("holds at 1 rather than overshooting on a late frame", () => {
    expect(lerpAlpha(500, 50)).toBe(1);
  });

  it("clamps a negative elapsed time, which a clock adjustment can produce", () => {
    expect(lerpAlpha(-10, 50)).toBe(0);
  });

  it("treats a zero interval as already arrived, rather than dividing by zero", () => {
    expect(lerpAlpha(10, 0)).toBe(1);
  });
});

describe("smoothTracks", () => {
  const pair = (over: Partial<Parameters<typeof smoothTracks>[0]> = {}) => ({
    from: [track("T1", 0), track("T2", 90)],
    to: [track("T1", 10), track("T2", 90)],
    elapsed_since_to_ms: 25,
    interval_ms: 50,
    ...over,
  });

  it("draws the newest frame exactly at alpha 0", () => {
    const out = smoothTracks(pair({ elapsed_since_to_ms: 0 }));
    expect(out.find((t) => t.track_id === "T1")?.bearing_deg).toBeCloseTo(10, 6);
  });

  it("sits halfway between the two frames at alpha 0.5", () => {
    const out = smoothTracks(pair({ elapsed_since_to_ms: 25 }));
    const t1 = out.find((t) => t.track_id === "T1");
    expect(t1?.bearing_deg).toBeCloseTo(5, 6);
    expect(t1?.range_m).toBeCloseTo(1000, 6);
  });

  it("interpolates across north the short way", () => {
    const out = smoothTracks(
      pair({ from: [track("T1", 350)], to: [track("T1", 10)], elapsed_since_to_ms: 25 }),
    );
    // 360° would be a track swinging the long way round the scope; 0° is a track
    // drifting over the top.
    expect(out[0]?.bearing_deg).toBeCloseTo(0, 6);
  });

  it("never draws a position the sim did not report", () => {
    // Every alpha from 0 to 1 in small steps must stay within the two frames.
    for (let i = 0; i <= 20; i++) {
      const out = smoothTracks(pair({ elapsed_since_to_ms: (i / 20) * 50 }));
      const bearing = out.find((t) => t.track_id === "T1")?.bearing_deg ?? -1;
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThanOrEqual(10);
    }
  });

  it("holds at the newest frame rather than overshooting it", () => {
    const out = smoothTracks(pair({ elapsed_since_to_ms: 5000 }));
    expect(out.find((t) => t.track_id === "T1")?.bearing_deg).toBeCloseTo(10, 6);
  });

  it("snaps forward once the clock runs past MAX_LEAD_MS", () => {
    // The recovery path after a backgrounded tab or a dropped socket: the client
    // must jump to the newest frame, not crawl toward it from a stale one.
    const out = smoothTracks(pair({ elapsed_since_to_ms: MAX_LEAD_MS + 1 }));
    expect(out.find((t) => t.track_id === "T1")?.bearing_deg).toBeCloseTo(10, 6);
  });

  it("still interpolates just inside MAX_LEAD_MS", () => {
    const out = smoothTracks(pair({ elapsed_since_to_ms: MAX_LEAD_MS - 1 }));
    // Alpha clamps at 1, so a long-elapsed frame shows the newest position rather
    // than anything past it — which is the same answer, and the invariant is that
    // nothing is ever drawn beyond `to`.
    expect(out.find((t) => t.track_id === "T1")?.bearing_deg).toBeCloseTo(10, 6);
  });

  it("leaves a track with no counterpart in the older frame where it is", () => {
    // A newly acquired track has no history: snapping is the only honest option.
    const out = smoothTracks(pair({ from: [track("T2", 90)], to: [track("T1", 10), track("T2", 90)] }));
    const t1 = out.find((t) => t.track_id === "T1");
    expect(t1?.bearing_deg).toBeCloseTo(10, 6);
  });

  it("drops a track that is only in the older frame", () => {
    // An aged-out track must not linger: the newer frame is the truth.
    const out = smoothTracks(pair({ from: [track("T1", 0), track("T2", 90)], to: [track("T1", 10)] }));
    expect(out.map((t) => t.track_id)).toEqual(["T1"]);
  });

  it("leaves a range-less track range-less rather than inventing a 0 m fix", () => {
    const bare: FusedTrack = { ...track("T1", 0), range_m: undefined };
    const bareNext: FusedTrack = { ...track("T1", 10), range_m: undefined };
    const out = smoothTracks({ from: [bare], to: [bareNext], elapsed_since_to_ms: 25, interval_ms: 50 });
    expect(out[0]?.range_m).toBeUndefined();
  });

  it("interpolates range when only one frame measured it", () => {
    const next: FusedTrack = { ...track("T1", 10), range_m: undefined };
    const out = smoothTracks({ from: [track("T1", 0, 1000)], to: [next], elapsed_since_to_ms: 25, interval_ms: 50 });
    expect(out[0]?.range_m).toBeCloseTo(500, 6);
  });
});

describe("FrameClock", () => {
  it("assumes the sim's own tick period before any frame has arrived", () => {
    // TICK_MS is 50 ms; seeding with it means the first frames interpolate against
    // the right rate instead of dividing by a zero interval.
    expect(new FrameClock().interval_ms).toBe(FrameClock.NOMINAL_INTERVAL_MS);
  });

  it("tracks the real interval after two arrivals", () => {
    const c = new FrameClock();
    c.arrival(1000);
    // The first arrival only sets the baseline. The second gives a 40 ms gap, which
    // pulls the estimate toward 40 — partway, because it is an EMA, not a replace.
    expect(c.arrival(1040)).toBeLessThan(FrameClock.NOMINAL_INTERVAL_MS);
    expect(c.interval_ms).toBeLessThan(FrameClock.NOMINAL_INTERVAL_MS);
    expect(c.interval_ms).toBeGreaterThan(40);
  });

  it("holds the nominal when frames arrive at exactly the sim's tick rate", () => {
    const c = new FrameClock();
    c.arrival(0);
    expect(c.arrival(FrameClock.NOMINAL_INTERVAL_MS)).toBeCloseTo(FrameClock.NOMINAL_INTERVAL_MS, 6);
  });

  it("does not let one late frame swallow the next", () => {
    // An EMA, not the last gap: a GC pause must not make every subsequent frame
    // jump straight to its endpoint and stutter.
    const c = new FrameClock();
    c.arrival(0);
    c.arrival(50);
    const afterSteady = c.interval_ms;
    c.arrival(5000); // one long stall
    const afterStall = c.interval_ms;
    c.arrival(5050); // back to normal
    expect(afterStall).toBeGreaterThan(afterSteady);
    expect(c.interval_ms).toBeLessThan(afterStall);
  });

  it("treats a zero gap as 1 ms rather than collapsing the estimate", () => {
    const c = new FrameClock();
    c.arrival(0);
    expect(c.arrival(0)).toBeGreaterThan(0);
  });
});