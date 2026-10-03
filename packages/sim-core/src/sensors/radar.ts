/**
 * Radar sensor (PRD §9.2 FR-SEN-3).
 *
 * Provides bearing, range, and speed. All-weather, but suffers from RF noise in
 * urban environments and cannot see through buildings. RCS (radar cross-section)
 * affects detection probability.
 */

import { bearingDeg, range2d } from "@skysentinel/shared";

import { getArchetype } from "../archetypes.js";
import { asUrban } from "../terrain/index.js";
import type { Observation, Sensor, SensorParams } from "./types.js";

const PARAMS: SensorParams = {
  p_detect_base: 0.85,
  max_range_m: 8000,
  fov_deg: 360,
  bearing_error_deg: 1.5,
  range_error_frac: 0.02,
  fa_rate_nominal: 0.003,
};

const rcsClass = (size: number): "small" | "medium" | "large" =>
  size < 0.05 ? "small" : size < 0.5 ? "medium" : "large";

export const createRadarSensor = (): Sensor => ({
  id: "radar",
  mode: "normal",

  observe(entities, ctx) {
    if (this.mode === "failed") return [];
    const obs: Observation[] = [];

    const rfNoise = ctx.environment.factors.rf_noise;

    for (const e of entities) {
      if (e.neutralised || e.landed) continue;
      if (!ctx.terrain.hasLineOfSight(ctx.observer_pos, e.pos)) continue;

      const r = range2d(ctx.observer_pos, e.pos);
      if (r > PARAMS.max_range_m) continue;

      const archetype = getArchetype(e.archetype);
      const rcsMultiplier = archetype.rcs_rel < 0.05 ? 0.5 : archetype.rcs_rel < 0.5 ? 1.0 : 1.3;

      let p = PARAMS.p_detect_base * (1 - r / PARAMS.max_range_m) * rcsMultiplier;
      p *= 1 / rfNoise;

      if (this.mode === "degraded") p *= 0.7;
      if (this.mode === "intermittent" && ctx.rng.chance(0.5)) continue;

      // Urban multipath: buildings near the target create false echoes.
      if (ctx.terrain.kind === "urban") {
        const urban = asUrban(ctx.terrain);
        const nearby = urban.buildingsNear(e.pos.x, e.pos.y, 150);
        if (nearby.length > 3) p *= 0.8;
      }

      if (!ctx.rng.chance(p)) continue;

      const trueBearing = bearingDeg(ctx.observer_pos, e.pos);
      const noisyBearing = trueBearing + ctx.rng.normal() * PARAMS.bearing_error_deg;
      const noisyRange = r * (1 + ctx.rng.normal() * PARAMS.range_error_frac);
      const noisySpeed = e.speed_mps * (1 + ctx.rng.normal() * 0.1);

      obs.push({
        sensor: "radar",
        obs_id: `radar_${ctx.t_ms}_${e.id}`,
        truth_ref: e.id,
        bearing_deg: (noisyBearing + 360) % 360,
        range_m: Math.max(0, noisyRange),
        speed_mps: Math.max(0, noisySpeed),
        rcs: rcsClass(archetype.rcs_rel),
        confidence: Math.min(Math.max(p, 0.4), 0.98),
        t_ms: ctx.t_ms,
      });
    }
    return obs;
  },

  falseAlarmRate(ctx) {
    if (this.mode === "failed") return 0;
    let rate = PARAMS.fa_rate_nominal;
    rate *= ctx.environment.factors.rf_noise;
    if (this.mode === "degraded") rate *= 1.6;
    return rate;
  },

  generateFalseAlarm(ctx) {
    return {
      sensor: "radar",
      obs_id: `radar_fa_${ctx.t_ms}_${ctx.rng.int(10000)}`,
      truth_ref: "",
      bearing_deg: ctx.rng.floatBetween(0, 360),
      range_m: ctx.rng.floatBetween(500, PARAMS.max_range_m),
      speed_mps: ctx.rng.floatBetween(0, 25),
      rcs: ctx.rng.pick(["small", "medium", "large"] as const),
      confidence: ctx.rng.floatBetween(0.3, 0.6),
      t_ms: ctx.t_ms,
    };
  },
});