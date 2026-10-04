/**
 * Scenario schema (PRD §5.4 FR-SCN-1, §8.1).
 *
 * A scenario is the complete, self-contained description of one training run:
 * where the map is, what the weather does, what is flying, what the trainee is
 * protecting, and — crucially — what the *correct answer* was.
 *
 * ## `expected` is ground truth
 *
 * The `expected` block is authored data describing the right answer. It is used
 * by the validator, the generator, and the scorer. It is never shown to a
 * trainee, and the server filters it out of any client payload exactly as it does
 * for `entity_spawned` (PRD §4, §6.4).
 *
 * ## Everything is fictional
 *
 * No field here encodes a real Service procedure, threshold, frequency, or
 * doctrine. Postures, categories and authority rules are training abstractions
 * pending SME validation (PRD §22).
 */

import { z } from "zod";

import {
  AffiliationSchema,
  ArchetypeSchema,
  BehaviourStateSchema,
  ClassificationCategorySchema,
  ConfidenceSchema,
  PostureSchema,
  SensorModeSchema,
  SwarmRoleSchema,
  TerrainTypeSchema,
  TimeOfDaySchema,
  WeatherSchema,
} from "@skysentinel/shared";

/** Schema version. Bump on any breaking structural change (PRD §7.1). */
export const SCENARIO_SCHEMA_VERSION = 1;

// --- primitives ------------------------------------------------------------

/** Metres on the local ENU plane, as a 2- or 3-tuple to match the JSON form. */
export const Vec2Schema = z.tuple([z.number(), z.number()]);
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Inclusive second range, e.g. a flight window or a resolution delay. */
export const SecondRangeSchema = z.tuple([z.number().min(0), z.number().min(0)]).refine(
  ([lo, hi]) => hi >= lo,
  { message: "range must be non-decreasing: [min, max]" },
);

// --- environment -----------------------------------------------------------

export const EnvironmentSchema = z.object({
  terrain: TerrainTypeSchema,
  time_of_day: TimeOfDaySchema,
  weather: WeatherSchema,
  wind_mps: z.number().min(0).max(30),
});
export type ScenarioEnvironment = z.infer<typeof EnvironmentSchema>;

// --- assets and observer ---------------------------------------------------

export const AssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Fictional asset category (fuel, command_post, …). Drives drill cost. */
  type: z.string().min(1),
  pos: Vec2Schema,
  /** Lower number = higher priority (PRD §8.1). */
  priority: z.number().int().min(1).max(5),
  impact_radius_m: z.number().positive().default(15),
});
export type ScenarioAsset = z.infer<typeof AssetSchema>;

export const SectorSchema = z.object({
  name: z.string().min(1),
  /** Bearings are degrees clockwise from north (PRD §7.2). */
  from_deg: z.number().min(0).max(360),
  to_deg: z.number().min(0).max(360),
});

export const ObserverPostSchema = z.object({
  pos: Vec3Schema,
  sectors: z.array(SectorSchema).default([]),
});
export type ObserverPost = z.infer<typeof ObserverPostSchema>;

// --- friendly flights (deconfliction source, FR-SEN-5) ---------------------

/**
 * `info_state` controls how much of the plan the feed actually shows (PRD §9.2).
 * `stale` freezes the last known position; `delayed` lags by a fixed period. A
 * stale feed is what makes IGNORED_FLIGHT_PLAN a subtle error rather than a
 * trivial one, so difficulty levels above 3 use it deliberately.
 */
export const FlightInfoStateSchema = z.enum(["current", "stale", "delayed"]);

export const FriendlyFlightSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Scenario-second window during which the flight is valid. */
  window_s: SecondRangeSchema,
  /** Ordered waypoints the flight nominally follows. */
  route: z.array(Vec2Schema).min(2),
  info_state: FlightInfoStateSchema.default("current"),
  /** Seconds of lag applied when `info_state` is `delayed`. */
  delay_s: z.number().min(0).default(0),
});
export type FriendlyFlight = z.infer<typeof FriendlyFlightSchema>;

// --- sensors ---------------------------------------------------------------

export const ScenarioSensorsSchema = z.object({
  visual: SensorModeSchema.default("normal"),
  ir: SensorModeSchema.default("normal"),
  radar: SensorModeSchema.default("normal"),
  rf: SensorModeSchema.default("normal"),
  flight_plan: SensorModeSchema.default("normal"),
});
export type ScenarioSensors = z.infer<typeof ScenarioSensorsSchema>;

// --- entities --------------------------------------------------------------

/** One step of a behaviour programme (FR-SIM-5). Mirrors sim-core's BehaviourStep. */
export const ScenarioBehaviourStepSchema = z.object({
  state: BehaviourStateSchema,
  to: Vec3Schema.optional(),
  speed: z.number().positive().optional(),
  center: Vec3Schema.optional(),
  radius: z.number().nonnegative().optional(),
  duration_s: z.number().nonnegative().optional(),
  alt: z.number().optional(),
});

export const ScenarioEntitySchema = z.object({
  id: z.string().min(1),
  archetype: ArchetypeSchema,
  /** TRUTH: never sent to a trainee client. */
  affiliation_truth: AffiliationSchema,
  intent: z.string().min(1),
  role: SwarmRoleSchema.optional(),
  group_id: z.string().min(1).optional(),
  /** Links this entity to a `friendly_flights` entry. */
  flight_ref: z.string().min(1).optional(),
  rf_emitting: z.boolean().default(true),
  spawn_t_s: z.number().min(0).default(0),
  pos: Vec3Schema,
  behaviour: z.array(ScenarioBehaviourStepSchema).min(1),
  /** Bird flocks are one entity representing several birds (FR-SIM-4). */
  count: z.number().int().min(1).optional(),
});
export type ScenarioEntity = z.infer<typeof ScenarioEntitySchema>;

// --- authority -------------------------------------------------------------

/**
 * The grant rule (FR-DEC-5) is a training abstraction, not a Service procedure.
 * It answers "what evidence was enough to be authorised", which is the judgement
 * the simulator exists to train.
 */
export const GrantRuleSchema = z.object({
  min_category: ClassificationCategorySchema,
  min_confidence: ConfidenceSchema,
  /** Distinct corroborating sensors required. */
  min_sources: z.number().int().min(1).max(5),
  delay_s: SecondRangeSchema,
});

export const AuthoritySchema = z.object({
  initial_posture: PostureSchema,
  grant_rule: GrantRuleSchema,
  // Defaults to "responders are available after six seconds". Stated on the
  // object as well as on its fields, so a scenario that omits the block
  // entirely parses the same as one that writes it out in full.
  response_assets: z
    .object({
      available: z.boolean().default(true),
      delay_s: z.number().min(0).default(6),
    })
    .default({}),
});
export type ScenarioAuthority = z.infer<typeof AuthoritySchema>;

// --- expected (ground truth for scoring) -----------------------------------

export const ExpectedTrackSchema = z.object({
  truth_id: z.string().min(1),
  /**
   * Categories a competent analyst could reasonably declare given the evidence
   * actually available. The validator checks this against the knowability model
   * and rejects scenarios where the truth could not have been inferred.
   */
  correct_category: z.array(ClassificationCategorySchema).min(1),
  /** May this track be declared hostile without penalty? */
  hostile_ok: z.boolean().default(false),
  /** Earliest second at which some sensor could credibly detect it (FR-SCN-4). */
  first_detectable_s: z.number().min(0),
  /** Detection latency in seconds that earns full marks. */
  par_detect_s: z.number().positive(),
  required_report: z.boolean().default(false),
  /** A warning should be issued at least this long before impact. */
  warn_before_s: z.number().min(0).optional(),
});

export const ExpectedSchema = z.object({
  tracks: z.array(ExpectedTrackSchema).default([]),
  /** Asset ids whose loss should dominate the mission outcome. */
  protect: z.array(z.string().min(1)).default([]),
});
export type ExpectedBlock = z.infer<typeof ExpectedSchema>;

// --- injects ---------------------------------------------------------------

/**
 * Runtime inject types (PRD §5.1 FR-SIM-9).
 *
 * An instructor can fire these live during a session. A *scripted* scenario has
 * no instructor, so it declares them itself: authored as data on a timeline, the
 * same event table serves both cases. Without this a scripted scenario cannot
 * teach sensor-outage recovery, because the failure would have to be hand-fired
 * by a human who is not present.
 */
export const INJECT_TYPES = [
  "sensor_outage",
  "new_track",
  "weather_change",
  "comms_delay",
  "authority_change",
] as const;
export const InjectTypeSchema = z.enum(INJECT_TYPES);
export type InjectType = z.infer<typeof InjectTypeSchema>;

export const ScenarioInjectSchema = z.object({
  at_t_s: z.number().min(0),
  type: InjectTypeSchema,
  /** Type-specific arguments; see the FR-SIM-9 table. Never trainee-visible. */
  params: z.record(z.unknown()).default({}),
  /** Human-readable note for the AAR timeline. */
  note: z.string().default(""),
});
export type ScenarioInject = z.infer<typeof ScenarioInjectSchema>;

// --- the scenario ----------------------------------------------------------

export const ScenarioSchema = z
  .object({
    schema_version: z.number().int().min(1).default(SCENARIO_SCHEMA_VERSION),
    id: z.string().min(1),
    kind: z.enum(["scripted", "generated"]),
    /** Procedural family, set only when `kind` is `generated`. */
    family: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().default(""),
    learning_objectives: z.array(z.string().min(1)).default([]),
    seed: z.number().int(),
    duration_s: z.number().int().positive(),
    difficulty: z.number().int().min(1).max(5).default(2),
    environment: EnvironmentSchema,
    assets: z.array(AssetSchema).min(1),
    observer_post: ObserverPostSchema,
    friendly_flights: z.array(FriendlyFlightSchema).default([]),
    sensors: ScenarioSensorsSchema,
    entities: z.array(ScenarioEntitySchema).min(1),
    authority: AuthoritySchema,
    /** Authored runtime injects, applied in time order (FR-SIM-9). */
    injects: z.array(ScenarioInjectSchema).default([]),
    /**
     * TRUTH. Never sent to a trainee client.
     *
     * Required, unlike the other optional blocks. This is the answer key: the
     * validator iterates `expected.tracks` to decide whether the scenario is
     * solvable at all, and the scorer has nothing to score against without it.
     * Defaulting it to empty would let an unscoreable scenario load cleanly and
     * fail later, at the point a trainee is waiting on their result.
     */
    expected: ExpectedSchema,
    rubric_id: z.string().min(1).default("default-v1"),
  })
  .refine((s) => (s.kind === "generated" ? s.family !== undefined : true), {
    message: "a generated scenario must name its family",
    path: ["family"],
  })
  .refine((s) => s.assets.length <= 3, {
    message: "MVP scenarios carry at most 3 protected assets (PRD §8.4)",
    path: ["assets"],
  })
  .refine((s) => s.injects.every((i) => i.at_t_s < s.duration_s), {
    message: "every inject must fall inside the scenario duration",
    path: ["injects"],
  });

export type Scenario = z.infer<typeof ScenarioSchema>;

/** Procedural families shipped in the MVP (PRD §8.4). */
export const SCENARIO_FAMILIES = ["recon_near_asset", "decoy_plus_main_swarm"] as const;
export type ScenarioFamily = (typeof SCENARIO_FAMILIES)[number];
export const ScenarioFamilySchema = z.enum(SCENARIO_FAMILIES);

/** Outcome of parsing, so callers can report every problem rather than the first. */
export type ParseResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; issues: string[] };

/**
 * Parse and validate an unknown value as a scenario.
 *
 * Never throws: a validator CLI has to report *every* problem in a file, not just
 * the first one it trips over, or an author fixing a scenario learns one error
 * per run.
 */
export const parseScenario = (input: unknown): ParseResult => {
  const result = ScenarioSchema.safeParse(input);
  if (result.success) return { ok: true, scenario: result.data };

  const issues = result.error.issues.map(
    (i) => `${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`,
  );
  return { ok: false, issues };
};