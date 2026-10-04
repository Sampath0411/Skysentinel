/**
 * Difficulty map accessors (PRD §5.4 FR-SCN-6, §8.5).
 *
 * Difficulty is configuration, never code: every number here is read from
 * `data/difficulty.json` via the generated module. Adding a level is a data
 * change plus a test, with no edit to the generator or validator (PRD §17,
 * "Extensibility").
 *
 * Levels are a training abstraction, not a Service assessment standard (PRD §22).
 */

import { z } from "zod";

import {
  DIFFICULTY_MAP_RAW,
  DifficultyLevelSchema,
  DifficultyMapSchema,
  type DifficultyLevel,
  type SupportCueLevel,
  type TimingRules,
} from "./generated/difficulty.js";

/** Parsed once at module load; a malformed data file fails fast, not per-call. */
export const DIFFICULTY_MAP = DifficultyMapSchema.parse(DIFFICULTY_MAP_RAW);

export const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const;
export type Difficulty = (typeof DIFFICULTY_LEVELS)[number];

export const isDifficulty = (v: number): v is Difficulty =>
  (DIFFICULTY_LEVELS as readonly number[]).includes(v);

export const TIMING_RULES: TimingRules = DIFFICULTY_MAP.timing;

/**
 * Fetch one difficulty level.
 *
 * Throws on an unknown level rather than defaulting: a scenario asking for
 * difficulty 7 is a bug in the generator, and silently returning level 5 would
 * hide it behind a scenario that looks plausible but is wrong.
 */
export const difficultyLevel = (level: number): DifficultyLevel => {
  const parsed = DifficultyLevelSchema.safeParse(DIFFICULTY_MAP.levels[String(level)]);
  if (!parsed.success) {
    throw new Error(
      `Unknown difficulty level ${level}. data/difficulty.json defines levels 1-5.`,
    );
  }
  return parsed.data;
};

/**
 * Minimum seconds between a threat becoming detectable and its impact.
 *
 * PRD §8.4 rule 5: 25 s at levels 1-2, 12 s at level 5. The window narrows as
 * difficulty rises, which is the whole point — at the hardest level the trainee
 * is expected to work faster, not with less information.
 */
export const minimumReactionGap = (level: number): number =>
  level >= 5 ? TIMING_RULES.d5_min_gap_s : TIMING_RULES.d1_d2_min_gap_s;

/**
 * Confidence error permitted on the decision-support cue at a level.
 *
 * The cue is advisory text only and never touches scoring, classification or
 * authority (PRD §9.5). At level 1 it is accurate; by level 4 it is hidden.
 */
export const supportCueConfidence = (level: number): number => {
  const l = difficultyLevel(level);
  const raw = DIFFICULTY_MAP.support_cue.confidence_at_levels[l.support_cue as SupportCueLevel];
  return z.number().min(0).max(1).parse(raw ?? 0);
};

/** Par times scale with difficulty: tighter at higher levels (PRD §8.5). */
export const parFactor = (level: number): number => difficultyLevel(level).par_factor;

export type { DifficultyLevel, SupportCueLevel };