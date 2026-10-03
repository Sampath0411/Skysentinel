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

import { range2d } from "@skysentinel/shared";

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

      const r = range2d(ctx.observer_pos, e.pos);

      obs.push({
        sensor: "flight_plan",
        obs_id: `fp_${ctx.t_ms}_${e.id}`,
        truth_ref: e.id,
        bearing_deg: 0,
        range_m: r,
        speed_mps: e.speed_mps,
        confidence: 1,
        t_ms: ctx.t_ms,
      });
    }
    return obs;
  },

  falseAlarmRate: () => 0,

  generateFalseAlarm() {
    // A flight plan feed cannot invent an entity that never filed one. This is the
    // one sensor with no false alarms, which is precisely why it is the most
    // trustworthy source and why ignoring it is scored as a critical error.
    throw new Error("flight_plan cannot generate false alarms");
  },
});