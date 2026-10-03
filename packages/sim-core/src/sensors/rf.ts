/**
 * RF sensor (PRD §9.2 FR-SEN-4).
 *
 * Detects radio emissions. Only sees entities marked `rf_emitting`. No range or
 * speed, just bearing and a signature fingerprint. Works through terrain (passive
 * intercept) but is noisier in urban areas.
 */

import { bearingDeg, range2d } from "@skysentinel/shared";

import type { Observation, Sensor, SensorParams } from "./types.js";

const PARAMS: SensorParams = {
  p_detect_base: 0.9,
  max_range_m: 12000,
  fov_deg: 360,
  bearing_error_deg: 4,
  range_error_frac: 0,
  fa_rate_nominal: 0.004,
};

/** Fictional RF signature fingerprints. */
const RF_SIGNATURES = ["sig_2400", "sig_5800", "sig_900", "sig_433"];

export const createRFSensor = (): Sensor => ({
  id: "rf",
  mode: "normal",

  observe(entities, ctx) {
    if (this.mode === "failed") return [];
    const obs: Observation[] = [];

    for (const e of entities) {
      if (e.neutralised || e.landed || !e.rf_emitting) continue;

      const r = range2d(ctx.observer_pos, e.pos);
      if (r > PARAMS.max_range_m) continue;

      let p = PARAMS.p_detect_base * (1 - r / PARAMS.max_range_m);
      p *= 1 / ctx.environment.factors.rf_noise;

      if (this.mode === "degraded") p *= 0.65;
      if (this.mode === "intermittent" && ctx.rng.chance(0.5)) continue;

      if (!ctx.rng.chance(p)) continue;

      const trueBearing = bearingDeg(ctx.observer_pos, e.pos);
      const noisyBearing = trueBearing + ctx.rng.normal() * PARAMS.bearing_error_deg;

      obs.push({
        sensor: "rf",
        obs_id: `rf_${ctx.t_ms}_${e.id}`,
        truth_ref: e.id,
        bearing_deg: (noisyBearing + 360) % 360,
        rf_signature: ctx.rng.pick(RF_SIGNATURES),
        confidence: Math.min(Math.max(p, 0.5), 0.95),
        t_ms: ctx.t_ms,
      });
    }
    return obs;
  },

  falseAlarmRate(ctx) {
    if (this.mode === "failed") return 0;
    let rate = PARAMS.fa_rate_nominal;
    rate *= ctx.environment.factors.rf_noise;
    if (this.mode === "degraded") rate *= 1.5;
    return rate;
  },

  generateFalseAlarm(ctx) {
    return {
      sensor: "rf",
      obs_id: `rf_fa_${ctx.t_ms}_${ctx.rng.int(10000)}`,
      truth_ref: "",
      bearing_deg: ctx.rng.floatBetween(0, 360),
      rf_signature: ctx.rng.pick(RF_SIGNATURES),
      confidence: ctx.rng.floatBetween(0.3, 0.6),
      t_ms: ctx.t_ms,
    };
  },
});