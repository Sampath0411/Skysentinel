/**
 * Visual sensor (PRD §9.2 FR-SEN-1).
 *
 * Detects entities by line-of-sight. Probability falls with range and is heavily
 * degraded at night or in poor visibility. No range measurement; bearing only.
 */

import { bearingDeg, range2d } from "@skysentinel/shared";

import { isLowLight } from "../environment.js";
import type { Observation, Sensor, SensorParams } from "./types.js";

const PARAMS: SensorParams = {
  p_detect_base: 0.7,
  max_range_m: 3000,
  fov_deg: 360,
  bearing_error_deg: 3,
  range_error_frac: 0,
  fa_rate_nominal: 0.002,
};

export const createVisualSensor = (): Sensor => ({
  id: "visual",
  mode: "normal",

  observe(entities, ctx) {
    if (this.mode === "failed") return [];
    const obs: Observation[] = [];

    for (const e of entities) {
      if (e.neutralised || e.landed) continue;

      const p = this.detectProbability(e, ctx);
      if (p <= 0) continue;

      if (this.mode === "intermittent" && ctx.rng.chance(0.5)) continue;
      if (!ctx.rng.chance(p)) continue;

      const trueBearing = bearingDeg(ctx.observer_pos, e.pos);
      const noisyBearing = trueBearing + ctx.rng.normal() * PARAMS.bearing_error_deg;

      obs.push({
        sensor: "visual",
        obs_id: `vis_${ctx.t_ms}_${e.id}`,
        truth_ref: e.id,
        bearing_deg: (noisyBearing + 360) % 360,
        confidence: Math.min(Math.max(p, 0.3), 0.95),
        t_ms: ctx.t_ms,
      });
    }
    return obs;
  },

  detectProbability(e, ctx) {
    if (this.mode === "failed") return 0;
    if (e.neutralised || e.landed) return 0;
    if (!ctx.terrain.hasLineOfSight(ctx.observer_pos, e.pos)) return 0;

    const r = range2d(ctx.observer_pos, e.pos);
    if (r > PARAMS.max_range_m) return 0;

    let p = PARAMS.p_detect_base * (1 - r / PARAMS.max_range_m);
    p *= ctx.environment.factors.light;
    p *= ctx.environment.factors.vis;

    if (this.mode === "degraded") p *= 0.5;
    return Math.min(Math.max(p, 0), 1);
  },

  falseAlarmRate(ctx) {
    if (this.mode === "failed") return 0;
    let rate = PARAMS.fa_rate_nominal;
    if (isLowLight(ctx.environment)) rate *= 2;
    if (this.mode === "degraded") rate *= 1.5;
    return rate;
  },

  generateFalseAlarm(ctx) {
    return {
      sensor: "visual",
      obs_id: `vis_fa_${ctx.t_ms}_${ctx.rng.int(10000)}`,
      truth_ref: "",
      bearing_deg: ctx.rng.floatBetween(0, 360),
      confidence: ctx.rng.floatBetween(0.2, 0.5),
      t_ms: ctx.t_ms,
    };
  },
});