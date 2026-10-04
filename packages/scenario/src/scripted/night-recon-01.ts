/**
 * Scripted scenario 1 — `scr-night-recon-01` (PRD §8.3).
 *
 * **Teaches:** early warning, `unknown` vs `hostile` calibration, reporting.
 *
 * One unknown multirotor orbits near a fuel point at night with the EO sensor
 * degraded and RF intermittent. A friendly logistics flight is scheduled
 * elsewhere and a bird flock crosses the sector. The trainee's first real test is
 * not spotting the drone — it is resisting the urge to call it hostile when the
 * evidence only supports `unknown`.
 *
 * The scenario is deliberately *not* an attack: nothing impacts, so the only ways
 * to fail are over-claiming or missing the report.
 */

import { ScenarioSchema, type Scenario } from "../schema.js";

const raw = {
  schema_version: 1,
  id: "scr-night-recon-01",
  kind: "scripted",
  title: "Night reconnaissance at fuel point",
  description:
    "An unidentified multirotor orbits a fuel point at night. EO is degraded and RF is intermittent, so evidence is sparse and slow to corroborate. A scheduled logistics flight and a bird flock share the sector.",
  learning_objectives: ["early_detection", "calibrated_classification", "reporting"],
  seed: 1001,
  duration_s: 420,
  difficulty: 2,
  environment: { terrain: "rural", time_of_day: "night", weather: "haze", wind_mps: 4 },
  assets: [
    { id: "A1", name: "Fuel point", type: "fuel", pos: [120, -80], priority: 1, impact_radius_m: 15 },
    { id: "A2", name: "Command post", type: "command_post", pos: [-60, 40], priority: 2, impact_radius_m: 15 },
  ],
  observer_post: {
    pos: [0, 0, 0],
    sectors: [{ name: "North", from_deg: 300, to_deg: 60 }],
  },
  friendly_flights: [
    {
      id: "F1",
      label: "Logistics UAS",
      window_s: [60, 200],
      route: [
        [900, 300],
        [500, 100],
        [100, -300],
      ],
      info_state: "current",
    },
  ],
  sensors: {
    visual: "degraded",
    ir: "normal",
    radar: "normal",
    rf: "intermittent",
    flight_plan: "normal",
  },
  entities: [
    {
      id: "D1",
      archetype: "recon_multirotor",
      affiliation_truth: "hostile",
      intent: "recon",
      rf_emitting: true,
      spawn_t_s: 45,
      pos: [400, -200, 60],
      behaviour: [
        { state: "transit", to: [400, -200, 60], speed: 9 },
        { state: "orbit_loiter", center: [150, -90, 45], radius: 40, speed: 9, duration_s: 120 },
        { state: "retreat", to: [800, -400, 80], speed: 10 },
      ],
    },
    {
      id: "F1d",
      archetype: "friendly_logistics",
      affiliation_truth: "friendly",
      intent: "logistics",
      flight_ref: "F1",
      rf_emitting: true,
      spawn_t_s: 60,
      pos: [900, 300, 70],
      behaviour: [
        { state: "transit", to: [500, 100, 70], speed: 10 },
        { state: "transit", to: [100, -300, 70], speed: 10 },
      ],
    },
    {
      id: "B1",
      archetype: "bird_flock",
      affiliation_truth: "non_uas",
      intent: "none",
      rf_emitting: false,
      spawn_t_s: 90,
      count: 6,
      pos: [300, 400, 90],
      behaviour: [{ state: "transit", to: [-400, -200, 90], speed: 11 }],
    },
  ],
  authority: {
    initial_posture: "TIGHT",
    grant_rule: {
      min_category: "suspicious",
      min_confidence: "medium",
      min_sources: 2,
      delay_s: [8, 20],
    },
    response_assets: { available: true, delay_s: 6 },
  },
  expected: {
    tracks: [
      {
        truth_id: "D1",
        // The evidence supports suspicion, not certainty: one drone orbiting a fuel
        // point with no filed flight plan. Calling it `hostile` here is the trap.
        correct_category: ["suspicious", "unknown"],
        hostile_ok: false,
        first_detectable_s: 52,
        par_detect_s: 15,
        required_report: true,
      },
      {
        truth_id: "F1d",
        correct_category: ["friendly", "authorised"],
        hostile_ok: false,
        first_detectable_s: 65,
        par_detect_s: 20,
        required_report: false,
      },
      {
        truth_id: "B1",
        correct_category: ["non_uas", "unknown"],
        hostile_ok: false,
        first_detectable_s: 95,
        par_detect_s: 30,
        required_report: false,
      },
    ],
    protect: ["A1"],
  },
  rubric_id: "default-v1",
};

/**
 * Parsed at module load, so a malformed scripted scenario is a load-time failure
 * rather than something that surfaces when a trainee is already mid-run.
 */
export const nightRecon01: Scenario = ScenarioSchema.parse(raw);