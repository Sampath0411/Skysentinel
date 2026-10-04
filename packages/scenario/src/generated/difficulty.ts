/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: `data/difficulty.json`
 * Regenerate: `node scripts/gen-data.mjs`
 *
 * Difficulty levels are a training abstraction (PRD §8.5). They are not calibrated
 * against any real course and must not be presented as an assessment standard.
 */

import { z } from "zod";

import { ArchetypeSchema, SensorModeSchema, TimeOfDaySchema, WeatherSchema } from "@skysentinel/shared";

/** How much of the decision-support cue is shown (FR-SEN-8). Advisory only. */
export const SupportCueLevelSchema = z.enum(["full_accurate", "partial_no_p", "hidden"]);

/** How adversarial the swarm behaves. `none` means no swarm at all. */
export const SwarmStyleSchema = z.union([
  z.literal(false),
  z.literal("small"),
  z.literal("decoy_main_reactive"),
]);

export const DifficultyLevelSchema = z.object({
  threat_count: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  time_of_day: z.array(TimeOfDaySchema).min(1),
  weather: z.array(WeatherSchema).min(1),
  sensor_modes: z.record(z.string(), SensorModeSchema),
  distractors: z.array(ArchetypeSchema),
  stale_flight_data: z.boolean().optional(),
  mid_run_sensor_failure: z.boolean().optional(),
  support_cue: SupportCueLevelSchema,
  swarm: SwarmStyleSchema,
  par_factor: z.number().positive(),
});

export const TimingRulesSchema = z.object({
  d1_d2_min_gap_s: z.number().min(0),
  d5_min_gap_s: z.number().min(0),
});

export const SupportCueRulesSchema = z.object({
  confidence_at_levels: z.record(z.string(), z.number().min(0).max(1)),
});

export const DifficultyMapSchema = z.object({
  levels: z.record(z.string(), DifficultyLevelSchema),
  timing: TimingRulesSchema,
  support_cue: SupportCueRulesSchema,
});

export type SupportCueLevel = z.infer<typeof SupportCueLevelSchema>;
export type SwarmStyle = z.infer<typeof SwarmStyleSchema>;
export type DifficultyLevel = z.infer<typeof DifficultyLevelSchema>;
export type TimingRules = z.infer<typeof TimingRulesSchema>;
export type SupportCueRules = z.infer<typeof SupportCueRulesSchema>;

/** Raw parsed document, exactly as it appears in `data/difficulty.json`. */
export const DIFFICULTY_MAP_RAW = {
  "_comment": [
    "FICTIONAL TRAINING PARAMETERS (PRD §8.5). Difficulty is configuration, not code.",
    "Levels 1-5 are a training abstraction. They are not calibrated against any real course."
  ],
  "levels": {
    "1": {
      "threat_count": [
        1,
        1
      ],
      "time_of_day": [
        "day"
      ],
      "weather": [
        "clear"
      ],
      "sensor_modes": {
        "visual": "normal",
        "ir": "normal",
        "radar": "normal",
        "rf": "normal"
      },
      "distractors": [],
      "support_cue": "full_accurate",
      "swarm": false,
      "par_factor": 1.5
    },
    "2": {
      "threat_count": [
        1,
        1
      ],
      "time_of_day": [
        "day",
        "dusk"
      ],
      "weather": [
        "clear",
        "haze"
      ],
      "sensor_modes": {
        "visual": "normal",
        "ir": "normal",
        "radar": "normal",
        "rf": "intermittent"
      },
      "distractors": [
        "bird_flock"
      ],
      "support_cue": "full_accurate",
      "swarm": false,
      "par_factor": 1.25
    },
    "3": {
      "threat_count": [
        1,
        2
      ],
      "time_of_day": [
        "dusk",
        "night"
      ],
      "weather": [
        "haze",
        "rain"
      ],
      "sensor_modes": {
        "visual": "degraded",
        "ir": "normal",
        "radar": "normal",
        "rf": "normal"
      },
      "distractors": [
        "friendly_logistics",
        "bird_flock"
      ],
      "support_cue": "partial_no_p",
      "swarm": false,
      "par_factor": 1
    },
    "4": {
      "threat_count": [
        2,
        4
      ],
      "time_of_day": [
        "night"
      ],
      "weather": [
        "rain",
        "fog"
      ],
      "sensor_modes": {
        "visual": "degraded",
        "ir": "normal",
        "radar": "normal",
        "rf": "intermittent"
      },
      "distractors": [
        "friendly_logistics",
        "bird_flock",
        "neutral_civil"
      ],
      "support_cue": "hidden",
      "swarm": "small",
      "par_factor": 0.85
    },
    "5": {
      "threat_count": [
        5,
        10
      ],
      "time_of_day": [
        "night"
      ],
      "weather": [
        "fog",
        "dust"
      ],
      "sensor_modes": {
        "visual": "degraded",
        "ir": "normal",
        "radar": "normal",
        "rf": "intermittent"
      },
      "distractors": [
        "friendly_logistics",
        "neutral_civil",
        "bird_flock"
      ],
      "stale_flight_data": true,
      "mid_run_sensor_failure": true,
      "support_cue": "hidden",
      "swarm": "decoy_main_reactive",
      "par_factor": 0.7
    }
  },
  "timing": {
    "_comment": "PRD §8.4 rule 5: minimum seconds between first detectable and impact.",
    "d1_d2_min_gap_s": 25,
    "d5_min_gap_s": 12
  },
  "support_cue": {
    "_comment": "PRD §5.2 FR-SEN-8. Cue is advisory text only; it never alters classification or scoring.",
    "confidence_at_levels": {
      "full_accurate": 0.05,
      "partial_no_p": 0.15,
      "hidden": 0
    }
  }
} as const;
