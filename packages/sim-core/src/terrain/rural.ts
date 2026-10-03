/**
 * Rural / forward-post terrain (PRD §5.1 FR-SIM-2).
 *
 * A heightmap of gentle ridges and valleys plus scattered vegetation clumps.
 * The heightmap is built on a fixed lattice and sampled bilinearly, so `heightAt`
 * is O(1) — LOS marching calls it ~96 times per query and the sim runs it for every
 * entity against every sensor each tick.
 *
 * Vegetation is stored in a deterministic spatial hash, so the occlusion lookup
 * stays O(1) regardless of how many clumps exist.
 */

import { type Vec3 } from "@skysentinel/shared";

import { createRng } from "../rng.js";
import { lineIsClear, type Terrain } from "./types.js";

/**
 * Lattice edge length. Must be a power of two so each octave's stride is an exact
 * integer: a fractional stride makes consecutive cells skip or duplicate lattice
 * points, which shows up as a cliff in the heightmap (found while testing this).
 */
const LATTICE = 128;

/** Peak-to-peak ridge relief in metres. Fictional terrain relief. */
export const MAX_RELIEF_M = 60;

/**
 * Octaves are defined by how many lattice cells they span across the map.
 * Values are divisors of LATTICE, so `stride = LATTICE / cells` is integral.
 */
const OCTAVES = [
  { cells: 2, amp: 1.0 }, // broad landform
  { cells: 8, amp: 0.35 }, // hills
  { cells: 32, amp: 0.12 }, // local relief
] as const;

const AMP_TOTAL = OCTAVES.reduce((s, o) => s + o.amp, 0);

/**
 * Fraction of the relief band the terrain's height standard deviation should reach.
 *
 * A gain is needed because averaging several 0..1 octaves concentrates values near
 * the mean: without it the map had a few metres of relief and nothing occluded, so
 * the PRD §14 M1 ridge-occlusion test could not pass. The octaves share one lattice
 * and are therefore partly correlated, so the spread cannot be derived
 * analytically — it is measured at construction instead (see RELIEF_GAIN below),
 * which keeps the result deterministic and independent of the analysis above.
 */
const TARGET_STD_FRACTION = 0.3;

/** Smoothstep fade, so interpolated lattice values have no visible creases. */
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export interface RuralTerrain extends Terrain {
  readonly kind: "rural";
  /** True when a vegetation clump occupies this horizontal position. */
  hasVegetation(x: number, y: number): boolean;
  /** Height of the vegetation canopy above ground at a position, or 0 if none. */
  vegetationHeightAt(x: number, y: number): number;
}

export const createRuralTerrain = (seed: number, size: number): RuralTerrain => {
  const rng = createRng(seed, "terrain:rural");

  // Seeded lattice of height control points in 0..1. Indexing wraps, so the
  // map is seamless across its edges.
  const lattice = new Float32Array(LATTICE * LATTICE);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();

  const sampleLattice = (ix: number, iy: number): number => {
    const x = ((ix % LATTICE) + LATTICE) % LATTICE;
    const y = ((iy % LATTICE) + LATTICE) % LATTICE;
    return lattice[y * LATTICE + x] as number;
  };

  /** The raw octave sum at a normalised position, before scaling. */
  const rawField = (u: number, v: number): number => {
    let sum = 0;
    for (const { cells, amp } of OCTAVES) {
      const stride = LATTICE / cells;

      // Cell coordinate within this octave's grid, then the lattice position it
      // maps to. Both stay integral, so adjacent cells always step by `stride`.
      const fx = u * cells;
      const fy = v * cells;
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      const tx = smoothstep(fx - cx);
      const ty = smoothstep(fy - cy);

      const px = cx * stride;
      const py = cy * stride;

      const a = sampleLattice(px, py);
      const b = sampleLattice(px + stride, py);
      const c = sampleLattice(px, py + stride);
      const d = sampleLattice(px + stride, py + stride);

      const top = a + (b - a) * tx;
      const bottom = c + (d - c) * tx;
      sum += (top + (bottom - top) * ty) * amp;
    }
    return sum / AMP_TOTAL;
  };

  /**
   * Measure the raw field's spread over a fixed grid, then choose a gain that puts
   * one standard deviation at TARGET_STD_FRACTION of the relief band. Measuring
   * rather than assuming keeps this correct whatever the lattice happens to be,
   * and the measurement itself is deterministic.
   */
  const computeReliefGain = (): number => {
    const N = 32;
    const values: number[] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) values.push(rawField(i / N, j / N));
    }
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance =
      values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
    const std = Math.sqrt(variance);
    // A degenerate (zero-variance) field would divide by zero; fall back to no gain.
    return std > 1e-9 ? (TARGET_STD_FRACTION * MAX_RELIEF_M) / std : 1;
  };

  const RELIEF_GAIN = computeReliefGain();

  const heightAt = (x: number, y: number): number => {
    const u = (x + size) / (2 * size);
    const v = (y + size) / (2 * size);
    const centred = rawField(u, v) - 0.5;
    const h = centred * RELIEF_GAIN;
    return Math.max(-MAX_RELIEF_M, Math.min(MAX_RELIEF_M, h));
  };

  // --- vegetation ---------------------------------------------------------
  // Clumps placed on a deterministic grid of cells, so lookup is O(1).
  const VEG_CELL = 100;
  const vegCells = new Map<number, { x: number; y: number; h: number; r: number }[]>();

  for (let cx = -size / VEG_CELL; cx <= size / VEG_CELL; cx++) {
    for (let cy = -size / VEG_CELL; cy <= size / VEG_CELL; cy++) {
      const cellRng = createRng(seed ^ (cx * 73856093) ^ (cy * 19349663), "terrain:rural:veg");
      const count = cellRng.int(4); // 0-3 clumps per cell
      if (count === 0) continue;
      const items: { x: number; y: number; h: number; r: number }[] = [];
      for (let i = 0; i < count; i++) {
        items.push({
          x: cx * VEG_CELL + cellRng.floatBetween(0, VEG_CELL),
          y: cy * VEG_CELL + cellRng.floatBetween(0, VEG_CELL),
          h: cellRng.floatBetween(8, 25), // tree / scrub canopy, fictional
          r: cellRng.floatBetween(15, 45),
        });
      }
      vegCells.set(cx * 100003 + cy, items);
    }
  }

  const vegetationHeightAt = (x: number, y: number): number => {
    const items = vegCells.get(Math.floor(x / VEG_CELL) * 100003 + Math.floor(y / VEG_CELL));
    if (!items) return 0;
    let maxH = 0;
    for (const v of items) {
      if (Math.hypot(x - v.x, y - v.y) <= v.r && v.h > maxH) maxH = v.h;
    }
    return maxH;
  };

  const hasVegetation = (x: number, y: number): boolean => vegetationHeightAt(x, y) > 0;

  /**
   * The occluding surface: ground plus vegetation, since both block sight.
   * Urban overrides this with building roofs.
   */
  const obstructionAt = (x: number, y: number): number =>
    heightAt(x, y) + vegetationHeightAt(x, y);

  const terrain: RuralTerrain = {
    kind: "rural",
    size,
    heightAt,
    obstructionAt,
    vegetationHeightAt,
    hasVegetation,

    hasLineOfSight(a: Vec3, b: Vec3): boolean {
      return lineIsClear(terrain, a, b);
    },

    /** Rural has no hard obstacles, so only ground elevation can obstruct. */
    isInsideObstacle(x: number, y: number, z: number): boolean {
      if (Math.abs(x) > size || Math.abs(y) > size) return true;
      return z < heightAt(x, y);
    },
  };

  return terrain;
};