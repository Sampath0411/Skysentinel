/**
 * Infrared sensor (PRD §9.2 FR-SEN-2).
 *
 * Works day and night. Detection multiplied by IR signature (hot engines vs cold
 * decoys). Degraded in poor visibility but less so than visual.
 */

import { bearingDeg, range2d } from "@skysentinel/shared";

import { getArchetype } from "../archetypes.js";
import { irMultiplier } from "../environment.js";
import type { Observation, Sensor, SensorParams } from "./types.js";

const PARAMS: SensorParams = {
  p_detect_base: 0.75,
  max_range_m: 4000,
  fov_deg: 360,
  bearing_error_deg: 2.5,
  range_error_frac: 0,
  fa_rate_nominal: 0.0015,
};

export const createIRSensor = (): Sensor => ({
  id: "ir",
  mode: "normal",

  observe(entities, ctx) {
    if (this.mode === "failed") return [];
    const obs: Observation[] = [];

    for (const e of entities) {
      if (e.neutralised || e.landed) continue;
      if (!ctx.terrain.hasLineOfSight(ctx.observer_pos, e.pos)) continue;

      const r = range2d(ctx.observer_pos, e.pos);
      if (r > PARAMS.max_range_m) continue;

      const archetype = getArchetype(e.archetype);
      let p = PARAMS.p_detect_base * (1 - r / PARAMS.max_range_m);
      // IR is all-weather: its own light factor is ~1, but signature differs
      // sharply between a hot airframe and a cold decoy.
      p *= archetype.thermal_rel;
      p *= irMultiplier(ctx.environment);
      p *= Math.pow(ctx.environment.factors.vis, 0.5);

      if (this.mode === "degraded") p *= 0.6;
      if (this.mode === "intermittent" && ctx.rng.chance(0.5)) continue;

      if (!ctx.rng.chance(p)) continue;

      const trueBearing = bearingDeg(ctx.observer_pos, e.pos);
      const noisyBearing = trueBearing + ctx.rng.normal() * PARAMS.bearing_error_deg;

      obs.push({
        sensor: "ir",
        obs_id: `ir_${ctx.t_ms}_${e.id}`,
        truth_ref: e.id,
        bearing_deg: (noisyBearing + 360) % 360,
        confidence: Math.min(Math.max(p, 0.3), 0.95),
        t_ms: ctx.t_ms,
      });
    }
    return obs;
  },

  falseAlarmRate() {
    if (this.mode === "failed") return 0;
    let rate = PARAMS.fa_rate_nominal;
    if (this.mode === "degraded") rate *= 1.4;
    return rate;
  },

  generateFalseAlarm(ctx) {
    return {
      sensor: "ir",
      obs_id: `ir_fa_${ctx.t_ms}_${ctx.rng.int(10000)}`,
      truth_ref: "",
      bearing_deg: ctx.rng.floatBetween(0, 360),
      confidence: ctx.rng.floatBetween(0.25, 0.55),
      t_ms: ctx.t_ms,
    };
  },
});