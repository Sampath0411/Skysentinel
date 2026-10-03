/**
 * Sensor system types (PRD §5.1 FR-SEN-1…8).
 *
 * Sensors produce observations that trainees fuse into tracks. Each sensor has its
 * own detection model, false-alarm rate, and degradation modes. The knowability
 * model (§9.4) compares what a trainee declared against what was actually knowable
 * from the observations available at time t.
 */

import type { Millis, SensorId, SensorMode, Vec3 } from "@skysentinel/shared";

import type { Drone } from "../entities.js";
import type { Environment } from "../environment.js";
import type { Rng } from "../rng.js";
import type { Terrain } from "../terrain/index.js";

export interface SensorContext {
  terrain: Terrain;
  environment: Environment;
  rng: Rng;
  t_ms: Millis;
  /** Sensor platform position. */
  observer_pos: Vec3;
}

export interface Observation {
  sensor: SensorId;
  /** Unique id for correlation. */
  obs_id: string;
  /** TRUTH: entity id, for scoring. Never sent to trainee. */
  truth_ref: string;
  bearing_deg: number;
  /** Horizontal range in metres. */
  range_m?: number;
  /** Altitude in metres. */
  altitude_m?: number;
  /** Estimated speed, m/s. */
  speed_mps?: number;
  /** Radar cross-section class, if radar. */
  rcs?: "small" | "medium" | "large";
  /** RF signature detected, if RF sensor. */
  rf_signature?: string;
  /** Detection confidence, 0..1. */
  confidence: number;
  t_ms: Millis;
}

export interface Sensor {
  readonly id: SensorId;
  mode: SensorMode;
  /** Observe all entities visible to this sensor at this tick. */
  observe(entities: readonly Drone[], ctx: SensorContext): Observation[];
  /** Sensor-specific false alarm rate per tick. */
  falseAlarmRate(ctx: SensorContext): number;
  /** Generate a false alarm. */
  generateFalseAlarm(ctx: SensorContext): Observation;
}

export interface SensorParams {
  /** Base detection probability at nominal range and conditions. */
  p_detect_base: number;
  /** Maximum detection range in metres. */
  max_range_m: number;
  /** Field of view, degrees (360 for omnidirectional). */
  fov_deg: number;
  /** Bearing accuracy, degrees (1-sigma). */
  bearing_error_deg: number;
  /** Range accuracy as a fraction of true range (1-sigma). */
  range_error_frac: number;
  /** False alarm rate per tick at nominal conditions. */
  fa_rate_nominal: number;
}

/** Mast height above local ground, in metres. Fictional. */
export const MAST_HEIGHT_M = 30;

/**
 * Sensor platform position: the origin, on a mast above local terrain.
 *
 * The height is not cosmetic, and a *fixed* height does not work either: a
 * constant z of 30 puts the observer inside the ground wherever the map rises
 * above it, and the platform then occludes every target and no sensor detects
 * anything. The mast must be measured from the terrain the platform stands on.
 */
export const observerAt = (terrain: Terrain, x = 0, y = 0): Vec3 => ({
  x,
  y,
  z: terrain.obstructionAt(x, y) + MAST_HEIGHT_M,
});