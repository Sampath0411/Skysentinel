/**
 * Core units and small value types shared by every package (PRD §7.2).
 *
 * Sim time is integer milliseconds. Positions are metres on a local ENU plane
 * (x east, y north, z up). Bearings are degrees clockwise from north.
 */

export type Millis = number;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const vec2 = (x: number, y: number): Vec2 => ({ x, y });

export const add3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const scale3 = (a: Vec3, k: number): Vec3 => ({
  x: a.x * k,
  y: a.y * k,
  z: a.z * k,
});

export const length3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

/** Horizontal distance only; altitude is handled separately by sensors. */
export const range2d = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y);

export const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Bearing in degrees clockwise from north, matching PRD §7.2.
 * Range 0-360.
 */
export const bearingDeg = (from: Vec3, to: Vec3): number => {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return (deg + 360) % 360;
};

/** Smallest absolute difference between two bearings, in degrees (0-180). */
export const bearingDeltaDeg = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Clamp to the inclusive range 0-1. */
export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const DEG = Math.PI / 180;