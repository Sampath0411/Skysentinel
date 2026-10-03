/**
 * Headless terrain demo.
 *
 * The trainee UI (PRD §14 M6) does not exist yet, so this is the earliest thing
 * that exercises the simulation end to end: it builds both terrain types from a
 * seed, prints a height/coverage map, and demonstrates line-of-sight occlusion.
 *
 * Pure TypeScript with no dependencies beyond the sim core, so it runs with
 * `node --experimental-strip-types` or after `pnpm build`.
 */

import { SYNTHETIC_BANNER, vec3 } from "@skysentinel/shared";

import { createEnvironment } from "./environment.js";
import { createRngBundle } from "./rng.js";
import { TICK_MS } from "./clock.js";
import { createRuralTerrain, createUrbanTerrain } from "./terrain/index.js";

const SIZE = 2000;
const WIDTH = 64;

const renderHeightMap = (label: string, heightAt: (x: number, y: number) => number): void => {
  // Shade ramp from low to high. Chosen to read well in both light and dark
  // terminals and to stay distinguishable without relying on colour alone.
  const ramp = " .:-=+*#%@";
  console.log(`\n${label}`);
  for (let row = 0; row < WIDTH / 2; row++) {
    let line = "";
    for (let col = 0; col < WIDTH; col++) {
      const x = -SIZE + (col / (WIDTH - 1)) * 2 * SIZE;
      const y = SIZE - (row / (WIDTH / 2 - 1)) * 2 * SIZE;
      const h = heightAt(x, y);
      const norm = Math.max(0, Math.min(0.999, (h + 60) / 120));
      line += ramp[Math.floor(norm * ramp.length)] as string;
    }
    console.log(`  |${line}|`);
  }
};

const main = (): void => {
  console.log("=".repeat(72));
  console.log("  SkySentinel — counter-UAS decision trainer (headless demo)");
  console.log("=".repeat(72));
  console.log(`  ${SYNTHETIC_BANNER}`);
  console.log(`  Fixed step: ${TICK_MS} ms  |  PRNG: sfc32, named streams`);

  const seed = Number(process.argv[2] ?? 1001);
  console.log(`\n  Seed: ${seed}\n`);

  // --- determinism ------------------------------------------------------
  const a = createRuralTerrain(seed, SIZE);
  const b = createRuralTerrain(seed, SIZE);
  let identical = true;
  for (let i = 0; i < 500; i++) {
    const x = -SIZE + (i * 13) % (2 * SIZE);
    const y = -SIZE + (i * 29) % (2 * SIZE);
    if (a.heightAt(x, y) !== b.heightAt(x, y)) {
      identical = false;
      break;
    }
  }
  console.log(`  Determinism: two builds of seed ${seed} ${identical ? "MATCH ✓" : "DIVERGED ✗"}`);

  // --- named streams ----------------------------------------------------
  const r1 = createRngBundle(seed);
  const motionFirst = r1.motion.next();
  r1.sensor.next();
  r1.clutter.next();
  const motionSecond = createRngBundle(seed).motion.next();
  console.log(
    `  Stream isolation: motion stream unaffected by other streams ${
      motionFirst === motionSecond ? "✓" : "✗"
    }`,
  );

  // --- terrain ----------------------------------------------------------
  const rural = createRuralTerrain(seed, SIZE);
  const urban = createUrbanTerrain(seed, SIZE);

  renderHeightMap("RURAL terrain — height map (shaded low → high)", (x, y) => rural.heightAt(x, y));

  // Urban relief is in the buildings, so show occupancy rather than height.
  console.log("\nURBAN terrain — building footprint coverage (# = building, . = street)");
  for (let row = 0; row < WIDTH / 2; row++) {
    let line = "";
    for (let col = 0; col < WIDTH; col++) {
      const x = -SIZE + (col / (WIDTH - 1)) * 2 * SIZE;
      const y = SIZE - (row / (WIDTH / 2 - 1)) * 2 * SIZE;
      line += urban.isInsideObstacle(x, y, 5) ? "#" : ".";
    }
    console.log(`  |${line}|`);
  }

  // --- line of sight ----------------------------------------------------
  console.log("\nLINE OF SIGHT (the property that drives radar masking)");
  const low = vec3(0, -1500, 10);
  const high = vec3(0, 1500, 10);
  console.log(`  rural, low level across the map:   ${rural.hasLineOfSight(low, high) ? "CLEAR" : "MASKED"}`);
  console.log(
    `  rural, same path at 400 m:          ${rural.hasLineOfSight(vec3(0, -1500, 400), vec3(0, 1500, 400)) ? "CLEAR" : "MASKED"}`,
  );

  // Find an interior building with clear ground on either side.
  const target = urban
    .buildingsNear(0, 0, 1500)
    .filter(
      (bld) =>
        bld.x > -SIZE / 2 &&
        bld.x < SIZE / 2 &&
        bld.y > -SIZE / 2 &&
        bld.y < SIZE / 2 &&
        urban.obstructionAt(bld.x - 200, bld.y) === 0 &&
        urban.obstructionAt(bld.x + 200, bld.y) === 0,
    )[0];

  if (target) {
    const across = vec3(target.x - 200, target.y, 10);
    const behind = vec3(target.x + 200, target.y, 10);
    const roof = target.height + 40;
    console.log(
      `  urban, low level behind a ${target.height.toFixed(0)} m block: ${urban.hasLineOfSight(across, behind) ? "CLEAR" : "MASKED"}`,
    );
    console.log(
      `  urban, same path above the roof:   ${urban.hasLineOfSight(vec3(target.x - 200, target.y, roof), vec3(target.x + 200, target.y, roof)) ? "CLEAR" : "MASKED"}`,
    );
  }

  // --- environment ------------------------------------------------------
  console.log("\nENVIRONMENT FACTORS (fictional training values, PRD §9.1)");
  console.log("  condition      light   vis    ir_pen  ir_boost  rf_noise");
  for (const [label, tod, wx, kind] of [
    ["rural / day / clear", "day", "clear", "rural"],
    ["rural / dusk / haze", "dusk", "haze", "rural"],
    ["urban / night / fog", "night", "fog", "urban"],
  ] as const) {
    const env = createEnvironment(tod, wx, 0, kind);
    const f = env.factors;
    console.log(
      `  ${label.padEnd(22)}${f.light.toFixed(2).padStart(5)}   ${f.vis.toFixed(2).padStart(5)}  ${f.ir_pen.toFixed(2).padStart(6)}  ${f.ir_boost.toFixed(2).padStart(8)}  ${f.rf_noise.toFixed(2).padStart(8)}`,
    );
  }

  console.log(`\n  ${SYNTHETIC_BANNER}`);
  console.log(
    "\n  Next: the trainee console (PRD §14 M6) is not built yet. Run `pnpm test`\n  for the full suite, or `pnpm scenario:generate` once the scenario package lands.\n",
  );
};

main();