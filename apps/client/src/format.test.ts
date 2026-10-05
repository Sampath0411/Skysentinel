/**
 * Display formatting (PRD §7.2).
 *
 * These are the only place the console turns sim milliseconds into something a
 * person reads, so a wrong format is a wrong number on screen — and the clock is
 * what a trainee times a decision against.
 */

import { describe, expect, it } from "vitest";

import {
  bearingLabel,
  describeEvent,
  eventClass,
  fmtClock,
  fmtClockTenths,
  fmtConf,
  fmtDeg,
  fmtDuration,
  fmtRange,
  fmtSpeed,
} from "./format.js";

describe("fmtClock", () => {
  // Table-driven: the boundary the format must survive is the minute roll-over,
  // which is where a naive `${s}` would print "01:68".
  it.each([
    [0, "00:00"],
    [999, "00:00"],
    [60_000, "01:00"],
    [125_000, "02:05"],
    [3_600_000, "60:00"],
  ])("renders %i ms as %s", (ms, expected) => {
    expect(fmtClock(ms)).toBe(expected);
  });

  it("never renders negative time", () => {
    // A clock that can display -00:05 looks like the sim is running backwards.
    expect(fmtClock(-5_000)).toBe("00:00");
  });
});

describe("fmtClockTenths", () => {
  it("keeps a tenth of a second, padding to a fixed width", () => {
    // The top bar clock is the one place sub-second precision is useful, and the
    // fixed width keeps it from jittering as the tenths digit changes.
    expect(fmtClockTenths(1_250)).toBe("00:01.2");
    expect(fmtClockTenths(59_900)).toBe("00:59.9");
    expect(fmtClockTenths(60_000)).toBe("01:00.0");
  });

  it("never rolls a tenth over into an impossible minute", () => {
    // 59.96 s must read 00:59.9, never 00:60.0 — a rounding `toFixed(1)` on the
    // seconds prints the latter, and a clock that counts to 60 looks broken.
    expect(fmtClockTenths(59_960)).toBe("00:59.9");
    expect(fmtClockTenths(59_999)).toBe("00:59.9");
  });
});

describe("fmtDeg / fmtRange / fmtSpeed / fmtConf", () => {
  it("formats a bearing to the requested precision", () => {
    expect(fmtDeg(12.3456)).toBe("12°");
    expect(fmtDeg(12.3456, 1)).toBe("12.3°");
  });

  it("renders a missing range and speed as a dash, never as NaN", () => {
    // `undefined` is the sensor model's "no fix". Printing "NaN m" would be a
    // statement about the app, not about the contact.
    expect(fmtRange(undefined)).toBe("—");
    expect(fmtSpeed(undefined)).toBe("—");
  });

  it("renders confidence as a whole percent", () => {
    expect(fmtConf(0.678)).toBe("68%");
  });
});

describe("fmtDuration", () => {
  it("is the clock over a nullable column", () => {
    // AAR rows store `duration_ms` as nullable; the null case is "the run did not
    // finish", which is worth a dash rather than 00:00.
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(90_000)).toBe("01:30");
  });
});

describe("bearingLabel", () => {
  // Table-driven over the eight compass points plus the wrap-around, which is the
  // case a `% 360` implementation gets wrong.
  it.each([
    [0, "N"],
    [45, "NE"],
    [90, "E"],
    [135, "SE"],
    [180, "S"],
    [270, "W"],
    [315, "NW"],
    [360, "N"],
    [-45, "NW"],
  ])("reads %i° as %s", (deg, expected) => {
    expect(bearingLabel(deg)).toBe(expected);
  });
});

describe("describeEvent", () => {
  it("renders the event types the radio log shows", () => {
    // The radio log is the trainee's record of what they did; a type that renders as
    // its own raw name is a gap in the log.
    expect(
      describeEvent({ type: "contact_marked", t_ms: 0, payload: { cue_or_track_id: "C001" } }),
    ).toBe("Contact marked: C001");
    expect(
      describeEvent({
        type: "classification_submitted",
        t_ms: 0,
        payload: { track_id: "T1", category: "hostile", confidence: "high", is_reclassification: false },
      }),
    ).toBe("Classified T1: hostile/high");
    expect(
      describeEvent({
        type: "classification_submitted",
        t_ms: 0,
        payload: {
          track_id: "T1",
          category: "hostile",
          confidence: "high",
          platform: "quadcopter",
          is_reclassification: true,
        },
      }),
    ).toBe("Re-classified T1: hostile/high, quadcopter");
    expect(describeEvent({ type: "authority_requested", t_ms: 0, payload: { track_id: "T1" } })).toBe(
      "Response authority requested: T1",
    );
  });

  it("tags a clutter observation so a false return is not read as a contact", () => {
    expect(
      describeEvent({
        type: "sensor_observation",
        t_ms: 0,
        payload: { sensor: "radar", bearing_deg: 90, range_m: 400, conf: 0.5, is_false: true },
      }),
    ).toContain("[clutter]");
  });

  it("falls back to the type name for anything it does not know", () => {
    // A new event type must render as *something* rather than throwing.
    expect(describeEvent({ type: "some_future_event", t_ms: 0, payload: {} })).toBe("some_future_event");
  });
});

describe("eventClass", () => {
  // The radio log colours by category, and the colour-blind-safe palette depends on
  // each decision type landing in one bucket. Table-driven over the types the log
  // actually renders.
  it.each([
    ["classification_submitted", "decision"],
    ["contact_marked", "decision"],
    ["action_taken", "decision"],
    ["report_sent", "report"],
    ["report_acked", "report"],
    ["authority_requested", "authority"],
    ["authority_resolved", "authority"],
    ["response_effect_resolved", "critical"],
    ["impact", "critical"],
    ["sensor_observation", "sensor"],
    ["track_update", "sensor"],
    ["cue_presented", "sensor"],
  ])("buckets %s", (type, expected) => {
    expect(eventClass(type)).toBe(expected);
  });

  it("colours a resolved response effect as critical, not authority", () => {
    // A kinetic outcome is the red row in the log. The substring check for
    // "response_effect" would file it under authority, which reads as a purple
    // permission row and buries the one event that says a weapon was used.
    expect(eventClass("response_effect_resolved")).toBe("critical");
    expect(eventClass("authority_resolved")).toBe("authority");
  });
});
