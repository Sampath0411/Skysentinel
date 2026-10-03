/**
 * Terrain barrel (PRD §5.1 FR-SIM-2).
 *
 * `createTerrain` lives here rather than in `types.ts` so both generators can be
 * imported normally without a circular import.
 */

import type { TerrainType } from "@skysentinel/shared";

import { createRuralTerrain, type RuralTerrain } from "./rural.js";
import type { Terrain } from "./types.js";
import { createUrbanTerrain, type UrbanTerrain } from "./urban.js";

export { clampToMap, DEFAULT_TERRAIN_SIZE, lineIsClear, LOS_SAMPLES } from "./types.js";
export type { Terrain } from "./types.js";
export { createRuralTerrain, MAX_RELIEF_M as RURAL_MAX_RELIEF_M } from "./rural.js";
export type { RuralTerrain } from "./rural.js";
export { createUrbanTerrain, BLOCK_PITCH, MAX_BUILDING_H, MIN_BUILDING_H } from "./urban.js";
export type { Building, UrbanTerrain } from "./urban.js";

/** Build the terrain for a kind and seed. */
export const createTerrain = (
  kind: TerrainType,
  seed: number,
  size?: number,
): Terrain => {
  const s = size ?? 2000;
  return kind === "urban" ? createUrbanTerrain(seed, s) : createRuralTerrain(seed, s);
};

/** Narrowing helper for code that knows it is dealing with an urban map. */
export const asUrban = (t: Terrain): UrbanTerrain => {
  if (t.kind !== "urban") throw new Error(`Expected urban terrain, got ${t.kind}`);
  return t;
};

/** Narrowing helper for code that knows it is dealing with a rural map. */
export const asRural = (t: Terrain): RuralTerrain => {
  if (t.kind !== "rural") throw new Error(`Expected rural terrain, got ${t.kind}`);
  return t;
};