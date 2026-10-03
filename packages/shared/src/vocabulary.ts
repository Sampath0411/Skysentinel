/**
 * Domain vocabulary (PRD §7.3, §8.1, §10.3).
 *
 * These are training categories used inside the simulator. They are NOT a Service
 * classification standard and must not be presented as one — the PRD records this as
 * an open question for SME validation (§22.1). Nothing here encodes a real procedure,
 * threshold or authority.
 */

import { z } from "zod";

/** Trainee-facing classification categories (FR-DEC-2). */
export const CLASSIFICATION_CATEGORIES = [
  "friendly",
  "authorised",
  "unknown",
  "suspicious",
  "hostile",
  "non_uas",
] as const;

export const ClassificationCategorySchema = z.enum(CLASSIFICATION_CATEGORIES);
export type ClassificationCategory = z.infer<typeof ClassificationCategorySchema>;

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const PLATFORM_TYPES = [
  "multirotor",
  "fixed_wing",
  "fpv_like",
  "unknown",
] as const;
export const PlatformSchema = z.enum(PLATFORM_TYPES);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * Ground-truth affiliation. Never sent to a trainee view — the server filters
 * truth-bearing payloads by role (PRD §6.4, §18.6).
 */
export const AFFILIATIONS = ["friendly", "authorised", "hostile", "non_uas"] as const;
export const AffiliationSchema = z.enum(AFFILIATIONS);
export type Affiliation = z.infer<typeof AffiliationSchema>;

/** Sensor identifier (FR-SEN-1…5). */
export const SENSOR_IDS = ["visual", "ir", "radar", "rf", "flight_plan"] as const;
export const SensorIdSchema = z.enum(SENSOR_IDS);
export type SensorId = z.infer<typeof SensorIdSchema>;

/** Sensor degradation modes (FR-SEN-6). */
export const SENSOR_MODES = ["normal", "degraded", "intermittent", "failed"] as const;
export const SensorModeSchema = z.enum(SENSOR_MODES);
export type SensorMode = z.infer<typeof SensorModeSchema>;

/** Drone behaviour states (FR-SIM-5). */
export const BEHAVIOUR_STATES = [
  "transit",
  "orbit_loiter",
  "approach_direct",
  "terrain_masked_approach",
  "popup",
  "decoy_hover",
  "retreat",
  "land",
] as const;
export const BehaviourStateSchema = z.enum(BEHAVIOUR_STATES);
export type BehaviourState = z.infer<typeof BehaviourStateSchema>;

/** Drone archetypes (PRD §8.2). All parameters fictional. */
export const ARCHETYPES = [
  "recon_multirotor",
  "fpv_attack",
  "fixed_wing_recon",
  "decoy_drone",
  "friendly_logistics",
  "neutral_civil",
  "bird_flock",
] as const;
export const ArchetypeSchema = z.enum(ARCHETYPES);
export type Archetype = z.infer<typeof ArchetypeSchema>;

/** Swarm member roles (FR-SIM-6). */
export const SWARM_ROLES = ["decoy", "main", "scout", "follow_on"] as const;
export const SwarmRoleSchema = z.enum(SWARM_ROLES);
export type SwarmRole = z.infer<typeof SwarmRoleSchema>;

/** Scenario environment axes (FR-SIM-3). */
export const TIME_OF_DAY = ["day", "dusk", "night"] as const;
export const TimeOfDaySchema = z.enum(TIME_OF_DAY);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

export const WEATHER = ["clear", "haze", "rain", "fog", "dust"] as const;
export const WeatherSchema = z.enum(WEATHER);
export type Weather = z.infer<typeof WeatherSchema>;

export const TERRAIN_TYPES = ["rural", "urban"] as const;
export const TerrainTypeSchema = z.enum(TERRAIN_TYPES);
export type TerrainType = z.infer<typeof TerrainTypeSchema>;

/**
 * Posture is a training abstraction only (PRD §5.3 FR-DEC-5, §22). Not a Service term.
 */
export const POSTURES = ["HOLD", "TIGHT", "FREE"] as const;
export const PostureSchema = z.enum(POSTURES);
export type Posture = z.infer<typeof PostureSchema>;

/** Policy-level trainee response actions (FR-DEC-4). No operational detail (PRD §4). */
export const RESPONSE_ACTIONS = [
  "continue_observe",
  "request_sensor_cue",
  "report",
  "assign_track_owner",
  "handover",
  "issue_warning",
  "activate_protective_drill",
  "request_support",
  "request_response_authority",
  "execute_response",
  "stand_down",
  "reclassify",
] as const;
export const ResponseActionSchema = z.enum(RESPONSE_ACTIONS);
export type ResponseAction = z.infer<typeof ResponseActionSchema>;

/** Critical errors (PRD §10.5), fixed list. */
export const CRITICAL_ERRORS = [
  "FRATRICIDE",
  "UNAUTHORISED_ACTION",
  "MISSED_THREAT",
  "FALSE_HOSTILE_ON_FRIENDLY",
  "NO_WARNING_BEFORE_IMPACT",
  "IGNORED_FLIGHT_PLAN",
] as const;
export const CriticalErrorSchema = z.enum(CRITICAL_ERRORS);
export type CriticalError = z.infer<typeof CriticalErrorSchema>;

/** Competencies (PRD §10.2). */
export const COMPETENCIES = [
  "detection",
  "classification",
  "response",
  "reporting",
  "prioritisation",
  "coordination",
  "adaptation",
] as const;
export const CompetencySchema = z.enum(COMPETENCIES);
export type Competency = z.infer<typeof CompetencySchema>;

/** Condition tags tracked per trainee in the skill model (PRD §11.1). */
export const CONDITION_TAGS = [
  "night",
  "degraded_sensors",
  "urban",
  "swarm",
  "friendly_deconflict",
] as const;
export const ConditionTagSchema = z.enum(CONDITION_TAGS);
export type ConditionTag = z.infer<typeof ConditionTagSchema>;

/** Who produced an event (PRD §6.4). */
export const ROLES = ["trainee", "instructor", "admin", "system"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Visibility of an event. `instructor`-only payloads carry ground truth and must
 * be filtered server-side before reaching a trainee client.
 */
export const VisibilitySchema = z.enum(["trainee", "instructor", "all"]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const ROLE_NAMES = ["Trainee", "Instructor", "Admin"] as const;

/**
 * Mandatory banner (PRD §4). Every trainee-facing surface displays this.
 * Keep in sync with apps/client and exported reports.
 */
export const SYNTHETIC_BANNER =
  "Synthetic training environment. Not connected to real sensors, weapons or emitters. Fictional parameters.";