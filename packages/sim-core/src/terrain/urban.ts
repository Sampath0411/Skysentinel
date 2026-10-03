/**
 * Urban terrain (PRD §5.1 FR-SIM-2).
 *
 * A grid of city blocks separated by streets, with a building inside each block.
 * Buildings are the occluders that make urban terrain behaviourally distinct from
 * rural: they create radar shadow and RF multipath (PRD §9.1 `rf_noise`), and they
 * give `terrain_masked_approach` (FR-SIM-5) somewhere to hide.
 *
 * Buildings are stored in a spatial hash by block cell, so occlusion lookup touches
 * only the buildings near the segment being marched.
 */

import { type Vec3 } from "@skysentinel/shared";

import { createRng } from "../rng.js";
import { lineIsClear, type Terrain } from "./types.js";

export interface UrbanTerrain extends Terrain {
  readonly kind: "urban";
  /** Buildings whose footprint intersects the given circle. */
  buildingsNear(x: number, y: number, radius: number): Building[];
}

export interface Building {
  /** Centre of the footprint. */
  x: number;
  y: number;
  /** Footprint half-extents, in metres. */
  halfW: number;
  halfD: number;
  /** Roof height, in metres. */
  height: number;
}

/** Block pitch, in metres: one block plus its street. */
export const BLOCK_PITCH = 120;
/** Street width inside each pitch. */
const STREET_W = 30;

/** Building height bounds, in metres. Fictional low-poly city. */
export const MIN_BUILDING_H = 12;
export const MAX_BUILDING_H = 70;

export const createUrbanTerrain = (seed: number, size: number): UrbanTerrain => {
  const rng = createRng(seed, "terrain:urban");

  // Half the blocks are deliberately left open, so there is a mix of open ground
  // and dense coverage rather than a uniform wall of blocks.
  const buildings: Building[] = [];
  const perSide = Math.ceil((size * 2) / BLOCK_PITCH);

  for (let ix = 0; ix < perSide; ix++) {
    for (let iy = 0; iy < perSide; iy++) {
      if (rng.chance(0.5)) continue;

      const cx = -size + ix * BLOCK_PITCH + BLOCK_PITCH / 2;
      const cy = -size + iy * BLOCK_PITCH + BLOCK_PITCH / 2;

      // Footprint fills the block minus the surrounding street.
      const usable = BLOCK_PITCH - STREET_W;
      const halfW = rng.floatBetween(usable * 0.3, usable * 0.5);
      const halfD = rng.floatBetween(usable * 0.3, usable * 0.5);

      buildings.push({
        x: cx,
        y: cy,
        halfW,
        halfD,
        height: rng.floatBetween(MIN_BUILDING_H, MAX_BUILDING_H),
      });
    }
  }

  /**
   * Spatial index: each building is registered in the grid cells its footprint
   * touches. A LOS march samples ~96 points per query and runs for every entity
   * against every sensor every tick, so scanning all buildings would dominate the
   * frame budget; this keeps each lookup proportional to the local cell, not the city.
   */
  const INDEX_CELL = BLOCK_PITCH;
  const grid = new Map<number, Building[]>();
  const key = (cx: number, cy: number): number => cx * 100003 + cy;

  for (const b of buildings) {
    const minCx = Math.floor((b.x - b.halfW) / INDEX_CELL);
    const maxCx = Math.floor((b.x + b.halfW) / INDEX_CELL);
    const minCy = Math.floor((b.y - b.halfD) / INDEX_CELL);
    const maxCy = Math.floor((b.y + b.halfD) / INDEX_CELL);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const k = key(cx, cy);
        const list = grid.get(k);
        if (list) list.push(b);
        else grid.set(k, [b]);
      }
    }
  }

  /** Flat street level; urban relief is entirely in the buildings. */
  const heightAt = (): number => 0;

  /**
   * Blocking height at a horizontal position: the roof of any building covering
   * that point, else 0 (open street). This is the surface LOS marches against.
   */
  const obstructionAt = (x: number, y: number): number => {
    const list = grid.get(key(Math.floor(x / INDEX_CELL), Math.floor(y / INDEX_CELL)));
    if (!list) return 0;
    let maxH = 0;
    for (const b of list) {
      if (Math.abs(x - b.x) <= b.halfW && Math.abs(y - b.y) <= b.halfD && b.height > maxH) {
        maxH = b.height;
      }
    }
    return maxH;
  };

  /** Buildings whose footprint is within `radius` of a point. */
  const buildingsNear = (x: number, y: number, radius: number): Building[] => {
    const out: Building[] = [];
    const seen = new Set<Building>();
    const r2 = radius * radius;
    const minCx = Math.floor((x - radius) / INDEX_CELL);
    const maxCx = Math.floor((x + radius) / INDEX_CELL);
    const minCy = Math.floor((y - radius) / INDEX_CELL);
    const maxCy = Math.floor((y + radius) / INDEX_CELL);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const list = grid.get(key(cx, cy));
        if (!list) continue;
        for (const b of list) {
          if (seen.has(b)) continue;
          // Distance to the footprint, not the centre.
          const dx = Math.max(Math.abs(x - b.x) - b.halfW, 0);
          const dy = Math.max(Math.abs(y - b.y) - b.halfD, 0);
          if (dx * dx + dy * dy <= r2) {
            seen.add(b);
            out.push(b);
          }
        }
      }
    }
    return out;
  };

  const terrain: UrbanTerrain = {
    kind: "urban",
    size,
    heightAt,
    obstructionAt,
    buildingsNear,

    hasLineOfSight(a: Vec3, b: Vec3): boolean {
      return lineIsClear(terrain, a, b);
    },

    isInsideObstacle(x: number, y: number, z: number): boolean {
      if (Math.abs(x) > size || Math.abs(y) > size) return true;
      return z < obstructionAt(x, y);
    },
  };

  return terrain;
};