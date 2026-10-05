/**
 * Scripted scenario 3 — `scr-urban-swarm-diversion-01` (PRD §8.3).
 *
 * **Teaches:** prioritisation, workload, main-effort identification, recovery.
 *
 * Two groups over one asset. Five loud decoys sit at the perimeter where every
 * sensor can see them; three RF-silent attackers come down the street canyons
 * toward the priority asset. At T+150 s the IR sensor goes down, and at T+210 s
 * the report channel congests.
 *
 * The decoys exist to be *wrongly* prioritised. Chasing five visible drones is
 * comfortable and scores nothing; the main group is the exercise. The T+150 s
 * outage lands mid-commitment, so the scenario also tests whether the trainee
 * recovers or keeps working the picture they already had.
 *
 * ## `day→dusk` is modelled as a single `dusk`
 *
 * The PRD describes the light fading over the run, but the environment model
 * resolves `time_of_day` once for the whole run (sim-core `environment.ts`). A
 * changing sun is a real feature, not a tuning knob, and belongs with the
 * instructor's weather-change inject (FR-SIM-9) in M9 — not smuggled in as a
 * per-scenario special case here. Until then the scenario is authored at the
 * harder end of the day, `dusk`, and says so.
 */

import { ScenarioSchema, type Scenario } from "../schema.js";

const raw = {
  schema_version: 1,
  id: "scr-urban-swarm-diversion-01",
  kind: "scripted",
  title: "Urban swarm diversion",
  description:
    "A five-drone decoy group holds the perimeter while a three-drone main group works the street canyons toward the priority asset. IR fails at T+150 s and the report channel congests at T+210 s.",
  learning_objectives: ["prioritisation", "workload_management", "main_effort_identification", "recovery"],
  seed: 3003,
  duration_s: 900,
  difficulty: 4,
  environment: { terrain: "urban", time_of_day: "dusk", weather: "rain", wind_mps: 5 },
  assets: [
    // Both on clear street. The observer mast sits at the origin, which this
    // seed's city grid puts on top of a 46 m block — so the priority asset is
    // beside the post, not under it.
    { id: "A1", name: "Operations centre", type: "command_post", pos: [0, 30], priority: 1, impact_radius_m: 15 },
    { id: "A2", name: "Substation", type: "fuel", pos: [-100, -10], priority: 2, impact_radius_m: 15 },
  ],
  observer_post: {
    pos: [0, 0, 0],
    sectors: [
      { name: "North", from_deg: 300, to_deg: 60 },
      { name: "East", from_deg: 45, to_deg: 135 },
    ],
  },
  friendly_flights: [
    {
      id: "F1",
      label: "Survey UAS",
      // Stale feed at D4+: the trainee is looking at the position the friendly was
      // in ten minutes ago, which is one more thing to get wrong under load.
      window_s: [60, 520],
      route: [
        [800, 400],
        [400, 200],
        [-200, 100],
      ],
      info_state: "stale",
      delay_s: 0,
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
    // --- the decoy group: loud, visible, and pointed at the wrong asset --------
    {
      id: "D1",
      archetype: "decoy_drone",
      affiliation_truth: "hostile",
      intent: "diversion",
      role: "decoy",
      group_id: "G_DECOY",
      rf_emitting: true, // deliberately noisy: they are *meant* to be seen first
      spawn_t_s: 30,
      pos: [520, 380, 95],
      behaviour: [
        // The hover holds where the transit ended, on the NE perimeter and 400+ m
        // from both assets. The behaviour engine snaps a decoy onto its hover
        // centre on the first tick, so a centre sited on the substation (where these
        // used to be) makes a *diversion* strike the asset it is drawing fire from.
        { state: "transit", to: [380, 300, 90], speed: 11, duration_s: 150 },
        { state: "decoy_hover", center: [380, 300, 90], radius: 60, duration_s: 180 },
      ],
    },
    {
      id: "D2",
      archetype: "decoy_drone",
      affiliation_truth: "hostile",
      intent: "diversion",
      role: "decoy",
      group_id: "G_DECOY",
      rf_emitting: true,
      spawn_t_s: 34,
      pos: [560, 340, 100],
      behaviour: [
        { state: "transit", to: [410, 265, 92], speed: 11, duration_s: 150 },
        { state: "decoy_hover", center: [410, 265, 92], radius: 60, duration_s: 180 },
      ],
    },
    {
      id: "D3",
      archetype: "decoy_drone",
      affiliation_truth: "hostile",
      intent: "diversion",
      role: "decoy",
      group_id: "G_DECOY",
      rf_emitting: true,
      spawn_t_s: 38,
      pos: [480, 420, 92],
      behaviour: [
        { state: "transit", to: [350, 335, 88], speed: 11, duration_s: 150 },
        { state: "decoy_hover", center: [350, 335, 88], radius: 60, duration_s: 180 },
      ],
    },
    {
      id: "D4",
      archetype: "decoy_drone",
      affiliation_truth: "hostile",
      intent: "diversion",
      role: "decoy",
      group_id: "G_DECOY",
      rf_emitting: true,
      spawn_t_s: 42,
      pos: [600, 300, 105],
      behaviour: [
        { state: "transit", to: [445, 225, 96], speed: 11, duration_s: 150 },
        { state: "decoy_hover", center: [445, 225, 96], radius: 60, duration_s: 180 },
      ],
    },
    {
      id: "D5",
      archetype: "decoy_drone",
      affiliation_truth: "hostile",
      intent: "diversion",
      role: "decoy",
      group_id: "G_DECOY",
      rf_emitting: true,
      spawn_t_s: 46,
      pos: [540, 430, 98],
      behaviour: [
        { state: "transit", to: [395, 350, 94], speed: 11, duration_s: 150 },
        { state: "decoy_hover", center: [395, 350, 94], radius: 60, duration_s: 180 },
      ],
    },

    // --- the main group: RF-silent, low, inside the canyons --------------------
    {
      id: "M1",
      archetype: "fpv_attack",
      affiliation_truth: "hostile",
      intent: "attack",
      role: "main",
      group_id: "G_MAIN",
      rf_emitting: false, // no RF cue at all: the decoys own the RF picture
      spawn_t_s: 60,
      pos: [1000, -900, 45],
      behaviour: [
        { state: "transit", to: [500, -430, 38], speed: 14 },
        { state: "terrain_masked_approach", to: [200, -170, 34], speed: 15 },
        { state: "approach_direct", to: [0, 30, 30], speed: 17 },
      ],
    },
    {
      id: "M2",
      archetype: "fpv_attack",
      affiliation_truth: "hostile",
      intent: "attack",
      role: "main",
      group_id: "G_MAIN",
      rf_emitting: false,
      spawn_t_s: 66,
      pos: [940, -940, 46],
      behaviour: [
        { state: "transit", to: [470, -470, 36], speed: 14 },
        { state: "terrain_masked_approach", to: [180, -190, 34], speed: 15 },
        { state: "approach_direct", to: [10, 40, 30], speed: 17 },
      ],
    },
    {
      id: "M3",
      archetype: "fpv_attack",
      affiliation_truth: "hostile",
      intent: "attack",
      role: "main",
      group_id: "G_MAIN",
      rf_emitting: false,
      spawn_t_s: 72,
      pos: [1020, -860, 48],
      behaviour: [
        { state: "transit", to: [520, -390, 40], speed: 14 },
        { state: "terrain_masked_approach", to: [210, -130, 34], speed: 15 },
        { state: "approach_direct", to: [-10, 20, 30], speed: 17 },
      ],
    },

    // --- distractors ----------------------------------------------------------
    {
      id: "F1d",
      archetype: "friendly_logistics",
      affiliation_truth: "friendly",
      intent: "logistics",
      flight_ref: "F1",
      rf_emitting: true,
      spawn_t_s: 60,
      pos: [800, 400, 85],
      behaviour: [
        { state: "transit", to: [400, 200, 85], speed: 10, duration_s: 200 },
        { state: "transit", to: [-200, 100, 85], speed: 10, duration_s: 200 },
      ],
    },
    {
      id: "N1",
      archetype: "neutral_civil",
      affiliation_truth: "non_uas",
      intent: "civil",
      rf_emitting: false,
      spawn_t_s: 260,
      // The crossing is held ~33 m clear of the operations centre (A1, 15 m impact
      // radius): a civilian that flies through the asset would strike it, and a
      // neutral destroying the priority asset makes the scenario unwinnable for a
      // trainee who classifies it correctly.
      pos: [-540, 380, 60],
      behaviour: [{ state: "transit", to: [400, -300, 60], speed: 13 }],
    },
  ],
  authority: {
    initial_posture: "TIGHT",
    grant_rule: {
      // At D4 the bar is deliberately higher: three independent sources, so a
      // single radar contact can never authorise engagement on its own.
      min_category: "suspicious",
      min_confidence: "medium",
      min_sources: 3,
      delay_s: [12, 28],
    },
    response_assets: { available: true, delay_s: 10 },
  },
  injects: [
    {
      at_t_s: 150,
      type: "sensor_outage",
      params: { sensor: "ir" },
      note: "IR fails mid-commitment, while the trainee may already be engaged with the decoys.",
    },
    {
      at_t_s: 210,
      type: "comms_delay",
      params: { delay_s: 45 },
      note: "Report channel congests: structured reports queue rather than arriving immediately.",
    },
  ],
  expected: {
    tracks: [
      // The main group is the whole exercise: three RF-silent attackers on the
      // priority asset. Reporting and warning on these dominates the score.
      ...["M1", "M2", "M3"].map((id) => ({
        truth_id: id,
        correct_category: ["hostile"],
        hostile_ok: true,
        first_detectable_s: 95,
        par_detect_s: 14,
        required_report: true,
        warn_before_s: 45,
      })),
      // The decoys are real threats to A2, but they are not what this scenario is
      // about. Reporting them is correct; spending the whole session on them is
      // the scored error, and that comes out of the workload rules, not here.
      ...["D1", "D2", "D3", "D4", "D5"].map((id) => ({
        truth_id: id,
        correct_category: ["suspicious", "hostile"],
        hostile_ok: true,
        first_detectable_s: 40,
        par_detect_s: 25,
        required_report: false,
      })),
      {
        truth_id: "F1d",
        correct_category: ["friendly", "authorised"],
        hostile_ok: false,
        first_detectable_s: 70,
        par_detect_s: 25,
        required_report: false,
      },
      {
        truth_id: "N1",
        correct_category: ["non_uas", "unknown"],
        hostile_ok: false,
        first_detectable_s: 265,
        par_detect_s: 30,
        required_report: false,
      },
    ],
    protect: ["A1"],
  },
  rubric_id: "default-v1",
};

export const urbanSwarmDiversion01: Scenario = ScenarioSchema.parse(raw);