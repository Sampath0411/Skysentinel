import { describe, expect, it } from "vitest";

import { bearingDeg, bearingDeltaDeg, clamp, clamp01, range2d, vec3 } from "./units.js";

describe("bearingDeg (PRD §7.2: degrees clockwise from north)", () => {
  const origin = vec3(0, 0, 0);

  it("gives 0 for due north", () => {
    expect(bearingDeg(origin, vec3(0, 100, 0))).toBeCloseTo(0, 6);
  });

  it("gives 90 for due east", () => {
    expect(bearingDeg(origin, vec3(100, 0, 0))).toBeCloseTo(90, 6);
  });

  it("gives 180 for due south", () => {
    expect(bearingDeg(origin, vec3(0, -100, 0))).toBeCloseTo(180, 6);
  });

  it("gives 270 for due west", () => {
    expect(bearingDeg(origin, vec3(-100, 0, 0))).toBeCloseTo(270, 6);
  });

  it("ignores altitude", () => {
    expect(bearingDeg(origin, vec3(0, 100, 999))).toBeCloseTo(0, 6);
  });

  it("stays in 0-360 for negative coordinates", () => {
    expect(bearingDeg(origin, vec3(-1, -1, 0))).toBeCloseTo(225, 6);
  });
});

describe("bearingDeltaDeg", () => {
  it("is the small angle across north", () => {
    expect(bearingDeltaDeg(350, 10)).toBeCloseTo(20, 6);
  });

  it("is the small angle across 180", () => {
    expect(bearingDeltaDeg(170, 190)).toBeCloseTo(20, 6);
  });

  it("returns 180 for opposite bearings", () => {
    expect(bearingDeltaDeg(0, 180)).toBeCloseTo(180, 6);
  });

  it("is zero for identical bearings", () => {
    expect(bearingDeltaDeg(42, 42)).toBeCloseTo(0, 6);
  });
});

describe("range2d", () => {
  it("ignores altitude, per the horizontal-plane definition", () => {
    expect(range2d(vec3(0, 0, 0), vec3(3, 4, 500))).toBeCloseTo(5, 6);
  });
});

describe("clamp helpers", () => {
  it("clamps into range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("clamps to 0-1", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
  });
});