/**
 * Scenario validator (PRD §5.4 FR-SCN-4, §8.4 rules 1-7).
 *
 * A scenario that cannot be solved, or that punishes the trainee for evidence
 * they were never given, is worse than no scenario at all — it teaches the wrong
 * lesson and, worse, teaches it confidently. Every rule here exists because
 * without it the simulator can silently generate unfair training.
 *
 * Each rule is an exported function returning its own findings, so a rule can be
 * unit-tested in isolation and a failure message can name the rule that fired.
 * `validateScenario` runs them all and aggregates.
 */

import {
  TICK_MS,
  createDrone,
  createEnvironment,
  createFlightPlanSensor,
  createIRSensor,
  createRadarSensor,
  createRFSensor,
  createRng,
  createTerrain,
  createVisualSensor,
  observerAt,
  sToMs,
  type Drone,
  type Sensor,
  type SensorContext,
} from "@skysentinel/sim-core";

import { minimumReactionGap } from "./difficulty.js";
import type { Scenario, ScenarioEntity } from "./schema.js";

/** One thing wrong with a scenario, attributable to a specific rule. */
export interface ValidationIssue {
  /** Matches the numbered rule in PRD §8.4. */
  rule: number;
  code: string;
  message: string;
  /** Entity or asset id the issue concerns, when it concerns one. */
  subject?: string;
  /** Fatal issues reject the scenario; warnings are reported but accepted. */
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Just the fatal issues, for a compact CLI summary. */
  errors: ValidationIssue[];
}

const issue = (
  rule: number,
  code: string,
  message: string,
  severity: ValidationIssue["severity"] = "error",
  subject?: string,
): ValidationIssue => ({ rule, code, message, severity, ...(subject !== undefined ? { subject } : {}) });

// --- shared construction helpers -------------------------------------------

/**
 * Materialise a scenario entity as a sim-core Drone.
 *
 * The validator needs real drones because it asks the real sensors real questions:
 * "could this threat ever be detected?" is only answerable by the same LOS and
 * detection code the simulation uses. Building a parallel model here would let the
 * validator pass a scenario the sensors would never show.
 */
const toDrone = (e: ScenarioEntity, seq: number): Drone =>
  createDrone({
    id: e.id,
    archetype: e.archetype,
    affiliation_truth: e.affiliation_truth,
    intent: e.intent,
    pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
    spawn_t_ms: sToMs(e.spawn_t_s),
    speed_mps: e.behaviour[0]?.speed ?? 10,
    programme: e.behaviour.map((s) => ({
      state: s.state,
      ...(s.to !== undefined ? { to: { x: s.to[0], y: s.to[1], z: s.to[2] } } : {}),
      ...(s.speed !== undefined ? { speed: s.speed } : {}),
      ...(s.center !== undefined ? { center: { x: s.center[0], y: s.center[1], z: s.center[2] } } : {}),
      ...(s.radius !== undefined ? { radius: s.radius } : {}),
      ...(s.duration_s !== undefined ? { duration_s: s.duration_s } : {}),
      ...(s.alt !== undefined ? { alt: s.alt } : {}),
    })),
    rf_emitting: e.rf_emitting,
    spawned_seq: seq,
    ...(e.role !== undefined ? { role: e.role } : {}),
    ...(e.group_id !== undefined ? { group_id: e.group_id } : {}),
    ...(e.flight_ref !== undefined ? { flight_ref: e.flight_ref } : {}),
  });

const sensorContext = (s: Scenario, t_ms: number): SensorContext => {
  const terrain = createTerrain(s.environment.terrain, s.seed);
  return {
    terrain,
    environment: createEnvironment(
      s.environment.time_of_day,
      s.environment.weather,
      s.environment.wind_mps,
      s.environment.terrain,
    ),
    rng: createRng(s.seed, "scenario:validate"),
    t_ms,
    observer_pos: observerAt(terrain, s.observer_post.pos[0], s.observer_post.pos[1]),
  };
};

const SENSOR_FACTORIES = {
  radar: createRadarSensor,
  visual: createVisualSensor,
  ir: createIRSensor,
  rf: createRFSensor,
  flight_plan: createFlightPlanSensor,
} as const;

/** Sensors that are actually switched on for this scenario, with their modes applied. */
const activeSensors = (s: Scenario): { sensor: Sensor; id: keyof typeof SENSOR_FACTORIES }[] => {
  const out: { sensor: Sensor; id: keyof typeof SENSOR_FACTORIES }[] = [];
  for (const id of Object.keys(SENSOR_FACTORIES) as (keyof typeof SENSOR_FACTORIES)[]) {
    const mode = s.sensors[id];
    if (mode === "failed") continue;
    const sensor = SENSOR_FACTORIES[id]();
    sensor.mode = mode;
    out.push({ sensor, id });
  }
  return out;
};

// --- corroboration ----------------------------------------------------------

/** How long a track survives with no new observation before fusion drops it, ms. */
const TRACK_TIMEOUT_MS = 3000;

/**
 * Ticks in one track lifetime — the window a sensor has to land at least one
 * observation on a track before that track ages out and a new id is minted.
 */
const CORROBORATION_TICKS = TRACK_TIMEOUT_MS / TICK_MS;

/**
 * The per-tick probability at which a sensor contributes a usable source.
 *
 * Fusion (PRD §9.3) promotes a track to `confirmed` on two *distinct* sensors,
 * and a sensor joins `track.sources` on its first successful detection — not at
 * any fixed confidence. So the question rule 2 must ask is not "is this sensor
 * above 0.5 on one tick" but "would this sensor land an observation before the
 * track times out".
 *
 * A sensor therefore qualifies when P(no detection in a track lifetime) falls to
 * 1/100 — a 1% chance the trainee never gets a look at that channel at all, so
 * the corroboration is reliable rather than merely possible.
 *
 * For a 20 Hz tick and a 3 s window this is p ≈ 0.015. It is deliberately much
 * lower than the 0.5 that rule 1 uses to decide whether a threat is *visible*:
 * visibility and corroboration are different questions, and using one threshold
 * for both is what previously made a two-sensor track impossible to justify.
 */
const CORROBORATION_P =
  1 - Math.pow(0.01, 1 / CORROBORATION_TICKS);

/** Would this sensor land an observation on a track within one track lifetime? */
const contributesSource = (p: number): boolean => p >= CORROBORATION_P;

// --- rules ------------------------------------------------------------------

/**
 * Rule 1 — every truth threat must be detectable at some point.
 *
 * Walks each threat's behaviour programme and asks every active sensor for a
 * detection probability at each step. Uses `detectProbability`, which is pure, so
 * this consumes no stream and cannot perturb the run it is validating.
 */
export const rule1_threatsDetectable = (s: Scenario): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const sensors = activeSensors(s);
  const drones = new Map(s.entities.map((e, i) => [e.id, toDrone(e, i)]));

  for (const expected of s.expected.tracks) {
    const entity = s.entities.find((e) => e.id === expected.truth_id);
    if (!entity) {
      issues.push(
        issue(1, "expected_track_unknown", `expected.tracks references unknown entity "${expected.truth_id}".`, "error", expected.truth_id),
      );
      continue;
    }

    // Only threats need to be detectable. A bird flock nobody can see is a
    // legitimate way to make the map quiet.
    const isThreat = entity.affiliation_truth === "hostile" || entity.affiliation_truth === "authorised";
    if (!isThreat) continue;

    const drone = drones.get(entity.id)!;
    let best = 0;
    let bestSensor = "";
    let bestStep = "";

    entity.behaviour.forEach((step, i) => {
      const ctx = sensorContext(s, sToMs(entity.spawn_t_s + i * 10));
      // Sample the pose the entity would hold during this step.
      if (step.to) drone.pos = { x: step.to[0], y: step.to[1], z: step.to[2] };
      if (step.center) drone.pos = { x: step.center[0], y: step.center[1], z: step.center[2] };
      if (step.alt !== undefined) drone.pos = { ...drone.pos, z: step.alt };

      for (const { sensor, id } of sensors) {
        const p = sensor.detectProbability(drone, ctx);
        if (p > best) {
          best = p;
          bestSensor = id;
          bestStep = `${entity.id} step ${i} (${step.state}) via ${id}`;
        }
      }
    });

    if (best < 0.5) {
      issues.push(
        issue(
          1,
          "threat_not_detectable",
          `Hostile "${entity.id}" has no sensor reaching P(detect) >= 0.5 anywhere on its path (best ${best.toFixed(2)}). The scenario is unsolvable.`,
          "error",
          entity.id,
        ),
      );
    } else {
      // Cross-check the authored value against what the sensors actually say.
      if (Math.abs(expected.first_detectable_s - entity.spawn_t_s) > 120 && entity.spawn_t_s > 0) {
        issues.push(
          issue(
            1,
            "first_detectable_disagrees",
            `"${entity.id}" spawns at ${entity.spawn_t_s}s but expected.first_detectable_s is ${expected.first_detectable_s}s; best candidate detection is ${bestSensor} at ${bestStep} (p=${best.toFixed(2)}).`,
            "warning",
            entity.id,
          ),
        );
      }
    }
  }

  return issues;
};

/**
 * Rule 2 — the expected category must be knowable from available evidence.
 *
 * A track with only one weak source cannot support a confident `hostile` call.
 * The knowability model (PRD §9.4) is the authority on what a given evidence
 * state justifies, so the validator defers to it rather than restating the rule.
 *
 * Like rule 1, this walks the entity's whole programme and takes the *best*
 * corroboration available at any point on its path. Sampling only the spawn
 * instant would fail every threat that approaches under cover — the exact shape
 * the PRD's hardest scenarios are built from — and would pass a scenario whose
 * drone is visible at spawn and then flies into a blind canyon. Knowability is a
 * question about the best evidence the run offers, not the evidence at t=0.
 */
export const rule2_expectedCategoryKnowable = (s: Scenario): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const drones = new Map(s.entities.map((e, i) => [e.id, toDrone(e, i)]));

  for (const expected of s.expected.tracks) {
    const entity = s.entities.find((e) => e.id === expected.truth_id);
    if (!entity) continue;
    const drone = drones.get(entity.id)!;

    // Best corroboration seen anywhere on the path, and where it happened.
    let bestSources = 0;
    let bestWhere = "";
    entity.behaviour.forEach((step, i) => {
      const ctx = sensorContext(s, sToMs(entity.spawn_t_s + i * 10));
      if (step.to) drone.pos = { x: step.to[0], y: step.to[1], z: step.to[2] };
      if (step.center) drone.pos = { x: step.center[0], y: step.center[1], z: step.center[2] };
      if (step.alt !== undefined) drone.pos = { ...drone.pos, z: step.alt };

      let sources = 0;
      for (const { sensor } of activeSensors(s)) {
        if (contributesSource(sensor.detectProbability(drone, ctx))) sources++;
      }
      if (sources > bestSources) {
        bestSources = sources;
        bestWhere = `step ${i} (${step.state})`;
      }
    });

    const callsHostile = expected.correct_category.includes("hostile") || expected.hostile_ok;

    // A `hostile` expectation with fewer than two independent sources is the
    // classic gotcha: the trainee is told the truth they could not have known.
    if (callsHostile && bestSources < 2) {
      issues.push(
        issue(
          2,
          "hostile_not_knowable",
          `"${entity.id}" expects a hostile call but never has more than ${bestSources} sensor(s) able to see it (best at ${bestWhere}). Support hostile_ok with at least 2 independent sources (FR-SCN-4 rule 2, PRD §9.4).`,
          "error",
          entity.id,
        ),
      );
    }

    if (callsHostile && bestSources < 2 && expected.correct_category.includes("unknown")) {
      issues.push(
        issue(
          2,
          "hostile_and_unknown_both_expected",
          `"${entity.id}" lists both hostile and unknown as correct. The knowability band decides between them; a single declaration should be able to be wrong.`,
          "warning",
          entity.id,
        ),
      );
    }
  }

  return issues;
};

/**
 * Rule 3 — not every sensor may be down at a threat's decisive window.
 *
 * Checks the configured modes directly rather than simulating: if two or more
 * sensors are `failed` and the rest are degraded, there is no cross-check
 * available and the trainee cannot corroborate anything.
 */
export const rule3_notAllSensorsDown = (s: Scenario): ValidationIssue[] => {
  const modes = Object.values(s.sensors);
  const failed = modes.filter((m) => m === "failed").length;
  const usable = modes.filter((m) => m === "normal" || m === "intermittent").length;

  if (usable === 0) {
    return [
      issue(
        3,
        "all_sensors_unusable",
        "Every sensor is failed or degraded. No scenario can be solved with no corroborating source (FR-SCN-4 rule 3).",
      ),
    ];
  }

  // A mid-run failure is legitimate (difficulty 5), but a sensor that is already
  // failed at t=0 removes an option the scenario never offers back.
  const initiallyFailed = failed;
  if (initiallyFailed >= 2) {
    return [
      issue(
        3,
        "too_many_failed_at_start",
        `${initiallyFailed} sensors start failed. At most one sensor may be down from t=0; the rest should fail mid-run via an inject (FR-SEN-6).`,
      ),
    ];
  }

  return [];
};

/** Rule 4 — at least one distractor from difficulty 2 up. */
export const rule4_hasDistractor = (s: Scenario): ValidationIssue[] => {
  if (s.difficulty < 2) return [];

  // A distractor is anything the trainee might mistake for a threat: a friendly
  // or authorised UAS, or a bird. Without one there is no deconfliction decision
  // to make, and the fratricide failure mode cannot be taught at all.
  const distractors = s.entities.filter((e) => e.affiliation_truth !== "hostile");

  if (distractors.length === 0) {
    return [
      issue(
        4,
        "no_distractor",
        `Difficulty ${s.difficulty} requires at least one non-threat (friendly, authorised, or bird) to deconflict against (FR-SCN-4 rule 4, PRD §8.5).`,
      ),
    ];
  }

  return [];
};

/** Behaviour states that fly toward a point and end on arrival. */
const POINT_STATES: ReadonlySet<string> = new Set([
  "transit",
  "approach_direct",
  "terrain_masked_approach",
  "popup",
  "retreat",
]);

/** Behaviour states that hold position for a fixed time. */
const HOLD_STATES: ReadonlySet<string> = new Set(["orbit_loiter", "decoy_hover"]);

/**
 * States that end on an asset, so an entity using them is *meant* to enter an
 * impact radius. `land` is included on purpose: a landing on an asset is a strike.
 */
const APPROACH_STATES: ReadonlySet<string> = new Set([
  "approach_direct",
  "terrain_masked_approach",
  "land",
]);

/** Fallback step duration when a scenario authors neither `duration_s` nor a speed. */
const DEFAULT_STEP_S = 30;

/** Fallback ground speed for a point-to-point step that omits `speed`, m/s. */
const DEFAULT_FALLBACK_SPEED_MPS = 10;

/**
 * Rule 5 — enough time to react between detection and impact.
 *
 * The gap runs from when the threat becomes detectable to when it *arrives*, not
 * when its approach step begins: the impact fires on arrival (sim-core `world.ts`
 * step 4), so a drone that starts closing at T+120 and reaches the asset at T+147
 * has given the trainee 27 seconds, not 120.
 *
 * Step durations are estimated the way the behaviour engine spends them — timed
 * states last `duration_s`, point-to-point states last distance ÷ speed — so the
 * arithmetic here tracks what the run will actually do. `first_detectable_s` is
 * the author's claim and is the scorer's business; this rule only checks that the
 * programme leaves room for it.
 */
export const rule5_reactionTime = (s: Scenario): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const minGap = minimumReactionGap(s.difficulty);

  for (const expected of s.expected.tracks) {
    const entity = s.entities.find((e) => e.id === expected.truth_id);
    if (!entity) continue;
    if (entity.affiliation_truth !== "hostile") continue;

    // Only threats that actually go somewhere matter: a recon drone that loiters
    // and retreats has no impact window at all.
    const impactStep = entity.behaviour.findIndex(
      (st) => st.state === "approach_direct" || st.state === "terrain_masked_approach" || st.state === "land",
    );
    if (impactStep < 0) continue;

    // Fly the programme forward, accumulating time. Position tracking starts at
    // the spawn point and moves only on the steps that actually move the entity.
    let t = entity.spawn_t_s;
    let here: [number, number, number] = [entity.pos[0], entity.pos[1], entity.pos[2]];

    for (let i = 0; i <= impactStep; i++) {
      const step = entity.behaviour[i]!;
      const target = step.to ?? step.center;

      if (POINT_STATES.has(step.state) && target) {
        const dist = Math.hypot(target[0] - here[0], target[1] - here[1], target[2] - here[2]);
        // An explicit `duration_s` on a point-to-point step is not honoured by the
        // behaviour engine (arrival governs), so distance and speed govern.
        t += dist / (step.speed ?? DEFAULT_FALLBACK_SPEED_MPS);
        here = [target[0], target[1], target[2]];
      } else if (HOLD_STATES.has(step.state)) {
        t += step.duration_s ?? DEFAULT_STEP_S;
        if (target) here = [target[0], target[1], target[2]];
      } else {
        t += step.duration_s ?? DEFAULT_STEP_S;
      }
    }

    const gap = t - expected.first_detectable_s;
    if (gap < minGap) {
      issues.push(
        issue(
          5,
          "insufficient_reaction_time",
          `"${entity.id}" leaves ${gap.toFixed(0)}s between first detectable (${expected.first_detectable_s}s) and arrival at the asset (~${t.toFixed(0)}s); difficulty ${s.difficulty} requires at least ${minGap}s (FR-SCN-4 rule 5).`,
          "error",
          entity.id,
        ),
      );
    }
  }

  return issues;
};

/**
 * Rule 6 — geometry: everything inside the map, assets not inside buildings.
 */
export const rule6_geometryValid = (s: Scenario): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const terrain = createTerrain(s.environment.terrain, s.seed);
  const size = terrain.size;

  for (const e of s.entities) {
    const [x, y] = e.pos;
    if (Math.abs(x) > size || Math.abs(y) > size) {
      issues.push(
        issue(
          6,
          "spawn_outside_map",
          `Entity "${e.id}" spawns at (${x}, ${y}), outside the ±${size} m map bounds.`,
          "error",
          e.id,
        ),
      );
    }
    // A spawn buried inside a building is invisible to everything and cannot be
    // shown to be at fault for never being detected.
    if (terrain.isInsideObstacle(x, y, e.pos[2])) {
      issues.push(
        issue(
          6,
          "spawn_inside_obstacle",
          `Entity "${e.id}" spawns inside a building or terrain at (${x}, ${y}, ${e.pos[2]}).`,
          "error",
          e.id,
        ),
      );
    }
  }

  for (const a of s.assets) {
    const [x, y] = a.pos;
    if (Math.abs(x) > size || Math.abs(y) > size) {
      issues.push(
        issue(6, "asset_outside_map", `Asset "${a.id}" is at (${x}, ${y}), outside the ±${size} m map.`, "error", a.id),
      );
      continue;
    }
    if (terrain.isInsideObstacle(x, y, 2)) {
      issues.push(
        issue(6, "asset_inside_building", `Asset "${a.id}" sits inside a building volume and cannot be reached or defended.`, "error", a.id),
      );
    }
  }

  // Protected assets must not overlap each other, or "which one was hit" has no
  // answer and the mission outcome becomes ambiguous.
  for (let i = 0; i < s.assets.length; i++) {
    for (let j = i + 1; j < s.assets.length; j++) {
      const a = s.assets[i]!;
      const b = s.assets[j]!;
      const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
      const minSep = a.impact_radius_m + b.impact_radius_m;
      if (d < minSep) {
        issues.push(
          issue(
            6,
            "assets_overlap",
            `Assets "${a.id}" and "${b.id}" are ${d.toFixed(0)} m apart, closer than the ${minSep} m sum of their impact radii.`,
            "error",
            a.id,
          ),
        );
      }
    }
  }

  // A programme that never attacks must stay out of every asset's impact radius.
  // The sim strikes any airborne entity inside one and neutralises it, so a loiter
  // sited on an asset makes a reconnaissance destroy the thing it is watching and
  // ends the only track in the scenario — the run looks broken from the trainee's
  // seat, and the AAR then reports a mission outcome the author did not write.
  // Attackers are exempt: entering the radius is the whole point of their approach.
  for (const e of s.entities) {
    if (e.behaviour.some((st) => APPROACH_STATES.has(st.state))) continue;
    // Fly the programme as the behaviour engine does, so a step is measured from
    // where the previous one actually left the entity.
    let here: [number, number, number] = [e.pos[0], e.pos[1], e.pos[2]];
    for (const st of e.behaviour) {
      for (const a of s.assets) {
        const d = closestApproachTo([a.pos[0], a.pos[1]], here, st);
        if (d !== null && d <= a.impact_radius_m) {
          issues.push(
            issue(
              6,
              "non_attacker_in_impact_radius",
              `Entity "${e.id}" comes within ${d.toFixed(0)} m of asset "${a.id}" (impact radius ${a.impact_radius_m} m) ` +
                `on a ${st.state} step, but nothing in its programme attacks. It would strike the asset on arrival.`,
              "error",
              e.id,
            ),
          );
        }
      }
      const next = st.to ?? st.center;
      if (next !== undefined && (POINT_STATES.has(st.state) || HOLD_STATES.has(st.state))) {
        here = [next[0], next[1], next[2]];
      }
    }
  }

  return issues;
};

/**
 * The closest a behaviour step's *occupied region* comes to a point in the xy
 * plane, in metres — the sim measures impacts horizontally (`impact.ts`), so
 * altitude never saves an overflight.
 *
 * Point-to-point states occupy the segment from where the entity was at the start
 * of the step. Orbit and hover states occupy a disc of `radius` around their
 * centre, because the behaviour engine snaps the entity onto that disc on the
 * first tick — an orbit 40 m wide around a centre 20 m from an asset passes
 * straight through it, which the centre alone would not show.
 *
 * Returns `null` for a step that holds the entity where it already is, which the
 * caller has already measured.
 */
const closestApproachTo = (
  asset: readonly [number, number],
  start: readonly [number, number, number],
  step: ScenarioEntity["behaviour"][number],
): number | null => {
  if (HOLD_STATES.has(step.state)) {
    const c = step.center ?? start;
    const r = step.radius ?? 0;
    const d = Math.hypot(c[0] - asset[0], c[1] - asset[1]);
    return Math.max(0, d - r);
  }

  const target = step.to;
  if (target === undefined || !POINT_STATES.has(step.state)) return null;

  const ax = asset[0];
  const ay = asset[1];
  const sx = start[0];
  const sy = start[1];
  const dx = target[0] - sx;
  const dy = target[1] - sy;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(ax - sx, ay - sy);

  // Clamp the projection of the asset onto the segment to its two ends.
  const u = Math.min(1, Math.max(0, ((ax - sx) * dx + (ay - sy) * dy) / len2));
  return Math.hypot(ax - (sx + u * dx), ay - (sy + u * dy));
};

/**
 * Rule 7 — cross-scenario checks that need history rather than the document.
 *
 * Anti-rote cannot be decided from a scenario alone, so it takes the trainee's
 * recent fingerprints and reports whether this one would be a repeat. The
 * launcher and recommender call this; the CLI can report it for a single
 * scenario without it.
 */
export const rule7_notRecentRepeat = (
  s: Scenario,
  recentFingerprints: readonly string[],
  fingerprintOf: (s: Scenario) => string,
  window = 10,
): ValidationIssue[] => {
  const fp = fingerprintOf(s);
  const recent = recentFingerprints.slice(-window);
  if (!recent.includes(fp)) return [];
  return [
    issue(
      7,
      "recent_repeat",
      `Fingerprint ${fp} appears in this trainee's last ${recent.length} sessions (FR-SCN-4 rule 7, anti-rote).`,
    ),
  ];
};

// --- aggregate --------------------------------------------------------------

const ALL_RULES = [
  rule1_threatsDetectable,
  rule2_expectedCategoryKnowable,
  rule3_notAllSensorsDown,
  rule4_hasDistractor,
  rule5_reactionTime,
  rule6_geometryValid,
] as const;

/**
 * Run every document-level rule.
 *
 * Returns all issues; the caller decides what to do with warnings. `valid` is
 * false only when at least one issue is an error.
 */
export const validateScenario = (s: Scenario): ValidationResult => {
  const issues = ALL_RULES.flatMap((rule) => rule(s));
  const errors = issues.filter((i) => i.severity === "error");
  return { valid: errors.length === 0, issues, errors };
};