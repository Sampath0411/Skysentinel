/**
 * Flight-plan sensor (PRD §9.2 FR-SEN-5).
 *
 * Not a sensor in the physical sense: it is a scheduled data feed of entities that
 * have declared a flight plan. It produces exact position and affiliation for those
 * entities, and nothing at all for anything else.
 *
 * This is the deconfliction channel. A drone that filed a plan shows up here as
 * friendly/authorised whether or not the RF sensor sees it, which is what makes
 * "ignored the flight plan" a detectable error (FR-SCR / CRITICAL_ERRORS).
 */

import { bearingDeg, range2d } from "@skysentinel/shared";

import type { Observation, Sensor } from "./types.js";

export const createFlightPlanSensor = (): Sensor => ({
  id: "flight_plan",
  mode: "normal",

  observe(entities, ctx) {
    if (this.mode === "failed") return [];
    const obs: Observation[] = [];

    for (const e of entities) {
      // Only entities with a filed plan appear, and only while they are valid.
      if (e.neutralised || e.landed) continue;
      if (e.flight_ref === undefined) continue;

      // The feed is periodic, not per-tick: it refreshes once a second.
      if (ctx.t_ms % 1000 !== 0) continue;

      // The feed reports the contact's true bearing and range, not a placeholder.
      //
      // This was hardcoded to `bearing_deg: 0`, which is defensible as a *policy*
      // statement — "this entity is on the plan" — and wrong as a *position*. The
      // tracker's correlation gate compares bearings, so every listed flight landed
      // 90°+ away from the radar return for the same aircraft and opened its own
      // track. An operator then saw a friendly flight as two separate contacts: one
      // radar track with no plan, and one plan track with no radar. The deconfliction
      // channel existed and still did not deconflict anything, and the bots' only
      // way to behave well was to ignore the track that named the friendly flight.
      const r = range2d(ctx.observer_pos, e.pos);

      obs.push({
        sensor: "flight_plan",
        obs_id: `fp_${ctx.t_ms}_${e.id}`,
        truth_ref: e.id,
        bearing_deg: bearingDeg(ctx.observer_pos, e.pos),
        range_m: r,
        speed_mps: e.speed_mps,
        confidence: 1,
        t_ms: ctx.t_ms,
      });
    }
    return obs;
  },

  detectProbability(e) {
    // The feed is a subscription, not a detection: an entity is either on the
    // published schedule or it is not. Probability is therefore 1 for a listed
    // entity and 0 for everything else — including entities the feed has not yet
    // refreshed, which the 1 Hz cadence below handles.
    if (this.mode === "failed") return 0;
    if (e.neutralised || e.landed) return 0;
    return e.flight_ref === undefined ? 0 : 1;
  },

  falseAlarmRate: () => 0,

  generateFalseAlarm() {
    // A flight plan feed cannot invent an entity that never filed one. This is the
    // one sensor with no false alarms, which is precisely why it is the most
    // trustworthy source and why ignoring it is scored as a critical error.
    throw new Error("flight_plan cannot generate false alarms");
  },
});