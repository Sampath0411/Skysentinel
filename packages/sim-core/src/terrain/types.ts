/**
 * Terrain interface and shared LOS machinery (PRD §5.1 FR-SIM-2).
 *
 * Both generators expose the same surface so sensors and behaviours do not branch
 * on terrain type. `heightAt` and `hasLineOfSight` are the only two members the rest
 * of the simulation depends on.
 *
 * All geometry is fictional and procedural; no real terrain data is used.
 */

import type { Vec3 } from "@skysentinel/shared";
import type { TerrainType } from "@skysentinel/shared";

export interface Terrain {
  readonly kind: TerrainType;
  /** Half-width of the playable square, in metres. Map spans -size..+size. */
  readonly size: number;
  /**
   * Ground elevation at a horizontal position, in metres.
   * For urban terrain this is the street level; buildings are handled by
   * `obstructionAt`.
   */
  heightAt(x: number, y: number): number;
  /**
   * Height of whatever blocks line of sight at a horizontal position: ground plus
   * vegetation on rural maps, building roofs on urban ones. This is the surface
   * every occlusion test marches against.
   */
  obstructionAt(x: number, y: number): number;
  /**
   * Is there an unobstructed line of sight between two 3D points?
   * A point exactly on the surface counts as visible to itself.
   */
  hasLineOfSight(a: Vec3, b: Vec3): boolean;
  /** True when a position is inside terrain or an occupied building volume. */
  isInsideObstacle(x: number, y: number, z: number): boolean;
}

/** Half-width of the standard playable map, in metres. */
export const DEFAULT_TERRAIN_SIZE = 2000;

/** Samples used when marching a line for occlusion tests. */
export const LOS_SAMPLES = 96;

/**
 * March a line between two points and report whether it is unobstructed.
 *
 * This is the single implementation of occlusion testing: each generator's
 * `hasLineOfSight` delegates here, so the two can never disagree. Sampling is
 * uniform with a fixed sample count, which keeps the result deterministic and the
 * cost bounded — LOS is the hottest call in the simulation, and the M1 DoD
 * requires a 10-minute, 30-entity run in under 5 s.
 *
 * Sample indices 1..samples-1 skip both endpoints, so a point resting on the
 * surface is always visible to itself.
 */
export const lineIsClear = (
  terrain: Terrain,
  a: Vec3,
  b: Vec3,
  samples = LOS_SAMPLES,
): boolean => {
  if (a.x === b.x && a.y === b.y && a.z === b.z) return true;

  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (z < terrain.obstructionAt(x, y)) return false;
  }
  return true;
};

/** Clamp a position into the playable map. */
export const clampToMap = (
  terrain: Terrain,
  x: number,
  y: number,
): { x: number; y: number } => ({
  x: Math.max(-terrain.size, Math.min(terrain.size, x)),
  y: Math.max(-terrain.size, Math.min(terrain.size, y)),
});