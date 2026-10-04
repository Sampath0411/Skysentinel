/**
 * Scripted scenario 2 — `scr-friendly-deconflict-01` (PRD §8.3).
 *
 * **Teaches:** pre-brief use, fratricide prevention, evidence reasoning.
 *
 * At dusk in haze, a scheduled friendly drone deviates slightly from its filed
 * route while an unscheduled drone approaches from a sector where radar is weak.
 * The two are visible in roughly the same place at roughly the same time.
 *
 * The failure this trains is fratricide: shooting the friendly because it is
 * closer to your own assets than the threat is. The brief is the only thing that
 * tells the trainee the flight exists, which is why `required_report` is set on
 * neither and the coordination penalty for not viewing the brief is the whole
 * point of the exercise.
 */

import { ScenarioSchema, type Scenario } from "../schema.js";

const raw = {
  schema_version: 1,
  id: "scr-friendly-deconflict-01",
  kind: "scripted",
  title: "Friendly vs unknown at dusk",
  description:
    "A scheduled logistics flight deviates from its filed route while an unscheduled drone approaches from a radar-weak sector. Both are in the same airspace at the same time; only the pre-mission brief identifies the friendly one.",
  learning_objectives: ["deconfliction", "calibrated_classification", "coordination"],
  seed: 2002,
  duration_s: 480,
  difficulty: 3,
  environment: { terrain: "urban", time_of_day: "dusk", weather: "haze", wind_mps: 3 },
  assets: [
    // Sited on clear street, not on a building footprint: an asset inside a block
    // can neither be defended nor destroyed, so the whole exercise would be moot.
    { id: "A1", name: "Command post", type: "command_post", pos: [0, 0], priority: 1, impact_radius_m: 15 },
    { id: "A2", name: "Fuel depot", type: "fuel", pos: [-400, -120], priority: 2, impact_radius_m: 15 },
  ],
  observer_post: {
    pos: [0, 0, 0],
    sectors: [{ name: "East", from_deg: 45, to_deg: 135 }],
  },
  friendly_flights: [
    {
      id: "F1",
      label: "Logistics UAS",
      window_s: [40, 320],
      // The filed route runs north of the depot; the drone drifts south of it,
      // which is exactly the deviation that makes it look unscheduled.
      route: [
        [700, 500],
        [350, 320],
        [0, 180],
      ],
      info_state: "current",
    },
  ],
  sensors: {
    visual: "degraded",
    ir: "normal",
    radar: "degraded",
    rf: "normal",
    flight_plan: "normal",
  },
  entities: [
    {
      id: "D1",
      archetype: "fpv_attack",
      affiliation_truth: "hostile",
      intent: "attack",
      rf_emitting: false, // flies dark: no RF cue at all
      spawn_t_s: 120,
      // Far enough out, and slow enough inbound, that the flight to the post
      // takes real time. A threat that spawns 300 m away and covers it in 12 s
      // leaves no decision to make — the scenario would be a reaction test
      // wearing the costume of a classification test.
      pos: [1000, -780, 80],
      behaviour: [
        // Holds behind the block fronts on the way in, then commits.
        { state: "terrain_masked_approach", to: [380, -300, 60], speed: 20 },
        { state: "approach_direct", to: [0, 0, 40], speed: 24 },
      ],
    },
    {
      id: "F1d",
      archetype: "friendly_logistics",
      affiliation_truth: "friendly",
      intent: "logistics",
      flight_ref: "F1",
      rf_emitting: true,
      spawn_t_s: 40,
      pos: [700, 500, 90],
      behaviour: [
        { state: "transit", to: [350, 300, 90], speed: 9 },
        { state: "transit", to: [0, 120, 90], speed: 9 },
        { state: "transit", to: [-300, -60, 90], speed: 9 },
      ],
    },
    {
      id: "B1",
      archetype: "bird_flock",
      affiliation_truth: "non_uas",
      intent: "none",
      rf_emitting: false,
      spawn_t_s: 200,
      count: 8,
      pos: [-400, 500, 110],
      behaviour: [{ state: "transit", to: [400, -100, 110], speed: 12 }],
    },
  ],
  authority: {
    initial_posture: "TIGHT",
    grant_rule: {
      min_category: "suspicious",
      min_confidence: "medium",
      min_sources: 2,
      delay_s: [10, 24],
    },
    response_assets: { available: true, delay_s: 8 },
  },
  expected: {
    tracks: [
      {
        truth_id: "D1",
        // Silent and terrain-masked: for a long stretch `unknown` is the honest
        // call, and only becomes `suspicious` once IR and radar corroborate.
        correct_category: ["suspicious", "hostile"],
        hostile_ok: true,
        first_detectable_s: 128,
        par_detect_s: 18,
        required_report: true,
        warn_before_s: 60,
      },
      {
        truth_id: "F1d",
        correct_category: ["friendly", "authorised"],
        hostile_ok: false,
        first_detectable_s: 55,
        par_detect_s: 20,
        required_report: false,
      },
      {
        truth_id: "B1",
        correct_category: ["non_uas", "unknown"],
        hostile_ok: false,
        first_detectable_s: 205,
        par_detect_s: 30,
        required_report: false,
      },
    ],
    protect: ["A1"],
  },
  rubric_id: "default-v1",
};

export const friendlyDeconflict01: Scenario = ScenarioSchema.parse(raw);