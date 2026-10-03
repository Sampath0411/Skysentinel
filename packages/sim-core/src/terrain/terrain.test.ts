import { describe, expect, it } from "vitest";

import { vec3 } from "@skysentinel/shared";

import { createRuralTerrain } from "./rural.js";
import { asUrban, createTerrain, DEFAULT_TERRAIN_SIZE, lineIsClear } from "./index.js";
import { createUrbanTerrain, MAX_BUILDING_H, MIN_BUILDING_H } from "./urban.js";

const SIZE = 2000;

describe("createTerrain", () => {
  it("builds a rural terrain for kind=rural", () => {
    expect(createTerrain("rural", 7).kind).toBe("rural");
  });

  it("builds an urban terrain for kind=urban", () => {
    expect(createTerrain("urban", 7).kind).toBe("urban");
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const a = createRuralTerrain(11, SIZE);
    const b = createRuralTerrain(11, SIZE);
    const c = createRuralTerrain(12, SIZE);
    const probe = (t: ReturnType<typeof createRuralTerrain>): number =>
      Array.from({ length: 40 }, (_, i) => t.heightAt(i * 47 - 900, i * 31 - 700)).join();

    expect(probe(a)).toBe(probe(b));
    expect(probe(a)).not.toBe(probe(c));
  });
});

describe("rural terrain (FR-SIM-2)", () => {
  const terrain = createRuralTerrain(3, SIZE);

  it("stays within its fictional relief band", () => {
    for (let x = -SIZE; x <= SIZE; x += 37) {
      for (let y = -SIZE; y <= SIZE; y += 41) {
        const h = terrain.heightAt(x, y);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeLessThanOrEqual(60);
        expect(h).toBeGreaterThanOrEqual(-60);
      }
    }
  });

  it("varies across the map rather than being flat", () => {
    const heights = new Set<number>();
    for (let x = -SIZE; x <= SIZE; x += 25) {
      heights.add(Math.round(terrain.heightAt(x, 0)));
    }
    // A heightmap with actual relief, not a constant.
    expect(heights.size).toBeGreaterThan(10);
  });

  it("is continuous — no cliffs between adjacent samples", () => {
    // A 5 m horizontal step should not produce a large vertical jump. The finest
    // octave spans 32 cells across 4000 m, i.e. one cell per 125 m, so real
    // relief changes slowly; anything near the full relief height over 5 m would
    // indicate a stride bug rather than terrain.
    for (let x = -SIZE; x < SIZE; x += 5) {
      const jump = Math.abs(terrain.heightAt(x + 5, 300) - terrain.heightAt(x, 300));
      expect(jump).toBeLessThan(6);
    }
  });

  it("occludes across a ridge at low altitude (PRD §14 M1 DoD)", () => {
    // Find the tallest ridge in a transect and confirm a low-altitude line
    // through it is blocked while a high line clears it.
    let bestX = 0;
    let bestH = -Infinity;
    for (let x = -SIZE; x < SIZE; x += 10) {
      const h = terrain.heightAt(x, 0);
      if (h > bestH) {
        bestH = h;
        bestX = x;
      }
    }
    expect(bestH).toBeGreaterThan(5);

    // Relief must be substantial enough to actually mask low-altitude contacts,
    // not a few metres of rolling ground.
    let minH = Infinity;
    for (let x = -SIZE; x <= SIZE; x += 25) {
      minH = Math.min(minH, terrain.heightAt(x, 0));
    }
    expect(bestH - minH).toBeGreaterThan(30);

    const a = vec3(bestX - 400, 0, 2);
    const b = vec3(bestX + 400, 0, 2);
    expect(terrain.hasLineOfSight(a, b)).toBe(false);

    const high = vec3(bestX - 400, 0, bestH + 120);
    const highB = vec3(bestX + 400, 0, bestH + 120);
    expect(terrain.hasLineOfSight(high, highB)).toBe(true);
  });

  it("sees a target at altitude above intervening ground", () => {
    expect(terrain.hasLineOfSight(vec3(-1500, -1500, 300), vec3(1500, 1500, 300))).toBe(true);
  });

  it("treats a point as visible to itself", () => {
    const p = vec3(100, 200, 300);
    expect(terrain.hasLineOfSight(p, p)).toBe(true);
  });

  it("blocks a line that terminates below ground", () => {
    expect(terrain.hasLineOfSight(vec3(0, 0, 400), vec3(0, 0, -50))).toBe(false);
  });

  it("places vegetation deterministically", () => {
    const a = createRuralTerrain(5, SIZE);
    const b = createRuralTerrain(5, SIZE);
    const probe = (t: typeof a): string =>
      Array.from({ length: 200 }, (_, i) => (t.hasVegetation(i * 13 - 900, i * 29 - 700) ? 1 : 0)).join("");
    expect(probe(a)).toBe(probe(b));
  });

  it("has vegetation somewhere, and vegetation occludes", () => {
    // Find a clump whose interior is clear of neighbouring clumps, so the test
    // measures this bush and not a taller one next to it.
    let found: { x: number; y: number; h: number; ground: number } | null = null;
    for (let x = -SIZE + 60; x <= SIZE - 60 && !found; x += 10) {
      for (let y = -SIZE + 60; y <= SIZE - 60; y += 10) {
        const h = terrain.vegetationHeightAt(x, y);
        if (h > 0) {
          // Confirm the canopy dominates the ground across the whole span.
          const ground = Math.max(
            terrain.heightAt(x - 60, y),
            terrain.heightAt(x + 60, y),
            terrain.heightAt(x, y),
          );
          const obstruction = terrain.obstructionAt(x, y);
          if (obstruction - ground > 4) {
            found = { x, y, h, ground };
            break;
          }
        }
      }
    }
    expect(found).not.toBeNull();

    const { x, y, h, ground } = found!;

    // A line running level with the ground, through the bush's midpoint, is
    // blocked. The midpoint is an interior sample, so the skip-endpoints rule
    // does not exempt it.
    const z = ground + 1;
    expect(terrain.hasLineOfSight(vec3(x - 60, y, z), vec3(x + 60, y, z))).toBe(false);

    // The identical line, raised above the canopy, is clear.
    const above = ground + h + 20;
    expect(terrain.hasLineOfSight(vec3(x - 60, y, above), vec3(x + 60, y, above))).toBe(true);
  });

  it("reports out-of-bounds as obstructed", () => {
    expect(terrain.isInsideObstacle(SIZE + 10, 0, 500)).toBe(true);
  });
});

describe("urban terrain (FR-SIM-2)", () => {
  const terrain = createUrbanTerrain(3, SIZE);

  it("has flat ground with all relief in the buildings", () => {
    expect(terrain.heightAt(0, 0)).toBe(0);
    expect(terrain.heightAt(-1234, 567)).toBe(0);
  });

  it("generates buildings within the fictional height band", () => {
    const near = terrain.buildingsNear(0, 0, 2000);
    expect(near.length).toBeGreaterThan(50);
    for (const b of near) {
      expect(b.height).toBeGreaterThanOrEqual(MIN_BUILDING_H);
      expect(b.height).toBeLessThanOrEqual(MAX_BUILDING_H);
    }
  });

  it("occludes through a building at low altitude (PRD §14 M1 DoD)", () => {
    // Pick a real building and shoot a low line straight across its middle.
    const b = terrain.buildingsNear(0, 0, 2000)[0];
    expect(b).toBeDefined();

    const across = vec3(b.x - b.halfW - 40, b.y, b.height * 0.5);
    const to = vec3(b.x + b.halfW + 40, b.y, b.height * 0.5);
    expect(terrain.hasLineOfSight(across, to)).toBe(false);
  });

  it("sees over a building from above its roof (the same target, same plan position)", () => {
    const b = terrain.buildingsNear(0, 0, 2000)[0];
    const above = b.height + 40;
    const across = vec3(b.x - b.halfW - 40, b.y, above);
    const to = vec3(b.x + b.halfW + 40, b.y, above);
    expect(terrain.hasLineOfSight(across, to)).toBe(true);
  });

  it("leaves street gaps unoccluded, so a low line down a street is clear", () => {
    // Find a position with no building overhead.
    let open: { x: number; y: number } | null = null;
    for (let x = -SIZE; x <= SIZE && !open; x += 7) {
      for (let y = -SIZE; y <= SIZE; y += 7) {
        if (!terrain.isInsideObstacle(x, y, 5)) {
          open = { x, y };
          break;
        }
      }
    }
    expect(open).not.toBeNull();
    expect(terrain.hasLineOfSight(vec3(open!.x, open!.y, 5), vec3(open!.x + 3, open!.y, 5))).toBe(
      true,
    );
  });

  it("creates radar shadow: a drone low behind a block is masked from a low sensor", () => {
    // Pick an interior building with clearance around it, so the test measures
    // this building's shadow rather than a neighbour's.
    const b = terrain
      .buildingsNear(0, 0, 1500)
      .filter(
        (c) =>
          c.x > -SIZE / 2 &&
          c.x < SIZE / 2 &&
          c.y > -SIZE / 2 &&
          c.y < SIZE / 2 &&
          terrain.obstructionAt(c.x - 200, c.y) === 0 &&
          terrain.obstructionAt(c.x + 200, c.y) === 0,
      )[0];
    expect(b).toBeDefined();

    // A level line at low altitude, behind the building, is masked.
    const sensor = vec3(b.x - 200, b.y, 10);
    const behind = vec3(b.x + 200, b.y, 10);
    expect(terrain.hasLineOfSight(sensor, behind)).toBe(false);

    // The identical line, level and above the roof, is clear. Both endpoints sit
    // at the same height so the line cannot clip the roof on the way across.
    const above = b.height + 40;
    expect(terrain.hasLineOfSight(vec3(b.x - 200, b.y, above), vec3(b.x + 200, b.y, above))).toBe(
      true,
    );
  });

  it("indexes buildings consistently with the footprint test", () => {
    const near = terrain.buildingsNear(400, -300, 300);
    for (const b of near) {
      expect(terrain.isInsideObstacle(b.x, b.y, b.height * 0.5)).toBe(true);
    }
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const a = createUrbanTerrain(21, SIZE);
    const b = createUrbanTerrain(21, SIZE);
    const c = createUrbanTerrain(22, SIZE);
    const heights = (t: typeof a): string =>
      t.buildingsNear(0, 0, 2000)
        .map((b) => b.height.toFixed(3))
        .join(",");

    expect(heights(a)).toBe(heights(b));
    expect(heights(a)).not.toBe(heights(c));
  });
});

describe("lineIsClear", () => {
  it("matches the terrain's own LOS decision", () => {
    const t = createTerrain("rural", 9, SIZE);
    const a = vec3(-500, 0, 20);
    const b = vec3(500, 0, 20);
    expect(lineIsClear(t, a, b)).toBe(t.hasLineOfSight(a, b));
  });

  it("agrees with terrain.hasLineOfSight for urban too", () => {
    const t = createTerrain("urban", 9, SIZE);
    for (let x = -500; x <= 500; x += 100) {
      const a = vec3(x, -500, 15);
      const b = vec3(x, 500, 15);
      expect(lineIsClear(t, a, b)).toBe(t.hasLineOfSight(a, b));
    }
  });

  it("handles coincident points", () => {
    const t = createTerrain("urban", 1, SIZE);
    const p = vec3(10, 10, 10);
    expect(lineIsClear(t, p, p)).toBe(true);
  });
});

describe("narrowing helpers", () => {
  it("asUrban rejects a rural terrain", () => {
    expect(() => asUrban(createTerrain("rural", 1, SIZE))).toThrow(/urban/);
  });

  it("asUrban accepts an urban terrain", () => {
    expect(asUrban(createTerrain("urban", 1, SIZE)).kind).toBe("urban");
  });
});

describe("map bounds", () => {
  it("uses the default size when none is given", () => {
    expect(createTerrain("rural", 1).size).toBe(DEFAULT_TERRAIN_SIZE);
  });
});