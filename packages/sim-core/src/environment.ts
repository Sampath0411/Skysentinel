/**
 * Environment state and its numeric factors (PRD §5.1 FR-SIM-3, §9.1).
 *
 * Time of day and weather are reduced to multiplicative factors that the sensor
 * models read. The values are fictional training parameters and live in
 * `data/sensors.json`; the defaults here mirror that file so the core package can
 * run headless without file access (core packages must stay pure — see CLAUDE.md).
 *
 * Nothing here models a real sensor's performance.
 */

import { clamp01, type TimeOfDay, type Weather } from "@skysentinel/shared";

/** The factor table, matching data/sensors.json's `environment` block. */
export interface EnvironmentFactors {
  /** Multiplier on visual detection. */
  light: number;
  /** General atmospheric visibility multiplier. */
  vis: number;
  /** How far IR penetrates the atmosphere. */
  ir_pen: number;
  /** IR advantage at this time of day. */
  ir_boost: number;
  /** Bearing-error multiplier for RF-like sensing, by terrain. */
  rf_noise: number;
}

const LIGHT: Record<TimeOfDay, number> = { day: 1.0, dusk: 0.45, night: 0.08 };
const VIS: Record<Weather, number> = {
  clear: 1.0,
  haze: 0.7,
  rain: 0.55,
  fog: 0.35,
  dust: 0.45,
};
const IR_PEN: Record<Weather, number> = {
  clear: 1.0,
  haze: 0.9,
  rain: 0.7,
  fog: 0.5,
  dust: 0.6,
};
const IR_BOOST: Record<TimeOfDay, number> = { night: 1.3, dusk: 1.1, day: 0.9 };
const RF_NOISE: Record<"rural" | "urban", number> = { rural: 1.0, urban: 1.8 };

/**
 * A configured environment, with its factors resolved once.
 *
 * `wind_mps` is carried through for motion drift but does not affect sensing here.
 */
export interface Environment {
  readonly time_of_day: TimeOfDay;
  readonly weather: Weather;
  readonly wind_mps: number;
  readonly factors: EnvironmentFactors;
}

export const createEnvironment = (
  time_of_day: TimeOfDay,
  weather: Weather,
  wind_mps = 0,
  terrain_kind: "rural" | "urban" = "rural",
): Environment => {
  const factors: EnvironmentFactors = {
    light: LIGHT[time_of_day],
    vis: VIS[weather],
    ir_pen: IR_PEN[weather],
    ir_boost: IR_BOOST[time_of_day],
    rf_noise: RF_NOISE[terrain_kind],
  };
  return { time_of_day, weather, wind_mps, factors };
};

/** Is it dark enough that visual detection is materially degraded? */
export const isLowLight = (env: Environment): boolean => env.factors.light <= 0.45;

/** Does the atmosphere meaningfully attenuate sensing? */
export const isDegradedAir = (env: Environment): boolean => env.factors.vis < 0.7;

/** Combined IR performance multiplier: penetration times the time-of-day advantage. */
export const irMultiplier = (env: Environment): number =>
  clamp01(env.factors.ir_pen * env.factors.ir_boost);

/**
 * Wind drift applied to an airborne entity over a period.
 * Returns a lateral offset in metres; deterministic given the inputs.
 */
export const windDrift = (env: Environment, dt_s: number): { x: number; y: number } => {
  // Fixed bearing for the synthetic wind field. A real wind vector would be
  // scenario data; this keeps the model deterministic without adding a field.
  const speed = env.wind_mps;
  const north = speed * 0.7 * dt_s;
  const east = speed * 0.3 * dt_s;
  return { x: east, y: north };
};