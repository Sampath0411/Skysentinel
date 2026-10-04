/**
 * Generate typed TypeScript modules from the canonical `data/*.json` files.
 *
 * ## Why this exists
 *
 * CLAUDE.md requires doctrine, weights and thresholds to live in `data/*.json`
 * rather than in code. It also requires the core packages to be pure TypeScript
 * with no filesystem access. Those two rules cannot both hold if a package
 * imports JSON directly: `tsc -b` sets `rootDir` to the package's `src`, so a
 * reference to `../../data/difficulty.json` is a build error.
 *
 * Rather than hand-mirroring the JSON into constants — which is how the two drift
 * apart silently — the JSON is the single source of truth and this script emits a
 * typed module from it. `difficulty.test.ts` regenerates and compares, so a change
 * to the JSON without a rebuild fails the suite instead of passing quietly.
 *
 * Usage: `node scripts/gen-data.mjs`
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const banner = (source, what) => `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: \`${source}\`
 * Regenerate: \`node scripts/gen-data.mjs\`
 *
 * ${what} They are not calibrated against any real course and must not be
 * presented as an assessment standard.
 */
`;

const BANNER = banner(
  "data/difficulty.json",
  "Difficulty levels are a training abstraction (PRD §8.5).",
);

const RUBRIC_BANNER = banner(
  "data/rubrics/default-v1.json",
  "Scoring weights, curves and thresholds are a training abstraction (PRD §10).\n * No LLM reads or writes any value in them.",
);

/**
 * Build the difficulty module's text from a parsed data document.
 *
 * Exported and pure so `difficulty.test.ts` can regenerate the expected output
 * in-process and compare it against the committed file. The test cannot import
 * this module's `fs` calls into a pure package, so the drift check re-derives the
 * same string here and diffs it — a JSON edit with no regeneration fails the
 * suite instead of passing quietly.
 */
export const renderDifficultyModule = (data) => `${BANNER}
import { z } from "zod";

import { ArchetypeSchema, SensorModeSchema, TimeOfDaySchema, WeatherSchema } from "@skysentinel/shared";

/** How much of the decision-support cue is shown (FR-SEN-8). Advisory only. */
export const SupportCueLevelSchema = z.enum(["full_accurate", "partial_no_p", "hidden"]);

/** How adversarial the swarm behaves. \`none\` means no swarm at all. */
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

/** Raw parsed document, exactly as it appears in \`data/difficulty.json\`. */
export const DIFFICULTY_MAP_RAW = ${JSON.stringify(data, null, 2)} as const;
`;

export const DIFFICULTY_DATA_PATH = join(root, "data/difficulty.json");
export const DIFFICULTY_MODULE_PATH = join(root, "packages/scenario/src/generated/difficulty.ts");

/**
 * Build the rubric module's text from a parsed rubric document.
 *
 * Same contract as `renderDifficultyModule`: pure, exported, and re-derivable
 * in-process by a drift test.
 */
export const renderRubricModule = (data) => `${RUBRIC_BANNER}
import { z } from "zod";

import { ClassificationCategorySchema, ResponseActionSchema } from "@skysentinel/shared";

/** The mandated and secondary competency dimensions (PRD §10.2). */
export const CompetencySchema = z.enum([
  "detection",
  "classification",
  "response",
  "reporting",
  "prioritisation",
  "coordination",
  "adaptation",
]);
export type Competency = z.infer<typeof CompetencySchema>;

/** One point on a piecewise-linear curve: x = normalised latency, y = points. */
export const CurvePointSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().min(0).max(100),
});

export const DetectionRulesSchema = z.object({
  curve: z.array(CurvePointSchema).min(2),
  latency_divisor_cap: z.number().positive(),
});

/**
 * rows = expected band (knowability at time t), cols = declared category.
 *
 * Every cell is required. A missing cell would silently become \`undefined\` and
 * score as zero at runtime, which reads as "the trainee was wrong" when it
 * actually means the rubric is incomplete.
 */
/**
 * rows = expected band (knowability at time t), cols = declared category.
 *
 * Exhaustiveness is enforced rather than assumed. \`z.record(enum, value)\` only
 * checks the keys that are *present*, so a dropped cell would parse cleanly and
 * then read as \`undefined\` at scoring time — which the AAR would present as "the
 * trainee was wrong" when it actually means the rubric is incomplete.
 */
export const ClassificationMatrixSchema = z
  .record(
    ClassificationCategorySchema,
    z.record(ClassificationCategorySchema, z.number().min(0).max(100)),
  )
  .superRefine((matrix, ctx) => {
    const bands = ClassificationCategorySchema.options;
    for (const band of bands) {
      const row = matrix[band];
      if (row === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [band],
          message: \`missing row for "\${band}".\`,
        });
        continue;
      }
      for (const col of bands) {
        if (row[col] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [band, col],
            message: \`missing cell for declared "\${col}" against band "\${band}".\`,
          });
        }
      }
    }
    for (const band of Object.keys(matrix)) {
      if (!(bands as string[]).includes(band)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [band],
          message: \`"\${band}" is not a classification category.\`,
        });
      }
    }
  });

export const ClassificationRulesSchema = z.object({
  matrix: ClassificationMatrixSchema,
  non_uas_for_real_threat: z.number().min(0).max(100),
  reclassify_toward_truth_bonus: z.number().min(0),
  reclassify_bonus_cap: z.number().min(0).max(100),
  confidence_policy: z.object({
    overconfidence_penalty: z.number().min(0),
    underconfidence_penalty: z.number().min(0),
    order: z.array(z.enum(["low", "medium", "high"])).length(3),
  }),
});

export const ReportingRulesSchema = z.object({
  field_presence_points: z.number().min(0).max(100),
  position_tolerance_points: z.number().min(0).max(100),
  bearing_tolerance_deg: z.number().positive(),
  range_tolerance_frac: z.number().min(0),
  range_tolerance_abs_m: z.number().min(0),
  quantity_points: z.number().min(0).max(100),
  activity_points: z.number().min(0).max(100),
  promptness_points: z.number().min(0).max(100),
  promptness_window_s: z.number().positive(),
  update_after_change_bonus: z.number().min(0),
});

/** Allowed actions per expected band. Cumulative: a band admits the weaker bands' actions. */
export const AllowedActionsSchema = z.record(
  ClassificationCategorySchema,
  z.array(ResponseActionSchema).min(1),
);

export const ResponseRulesSchema = z.object({
  allowed: AllowedActionsSchema,
  late_after_par: z.number().positive(),
  late_score_low: z.number().min(0).max(100),
  late_score_high: z.number().min(0).max(100),
  passive_only_score: z.number().min(0).max(100),
  authority_required_before_execute_response: z.literal(true),
}).superRefine((r, ctx) => {
  // A response may only be executed against what the evidence supports (PRD §10.3
  // N7). If \`execute_response\` were reachable from a weaker band the rubric would
  // train exactly the habit the authority model exists to prevent, so this is
  // enforced at load rather than checked in the scorer where it might be missed.
  for (const [band, actions] of Object.entries(r.allowed)) {
    if (actions.includes("execute_response") && band !== "hostile") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed", band],
        message: "execute_response is reachable from a band that does not support it.",
      });
    }
  }
  // Conversely, a rubric in which no band can execute a response is unsolvable:
  // a trainee facing a genuine hostile would be punished for every option.
  if (!Object.values(r.allowed).some((a) => a.includes("execute_response"))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed"],
      message: "no band admits execute_response, so a hostile encounter is unsolvable.",
    });
  }
});

export const CoordinationRulesSchema = z.object({
  brief_not_viewed_penalty: z.number().min(0),
  brief_credit: z.number().min(0).max(100),
  owner_assigned_credit: z.number().min(0).max(100),
  cop_update_credit: z.number().min(0).max(100),
});

export const AdaptationRulesSchema = z.object({
  reacquire_par_ms: z.number().positive(),
  reacquire_full_credit: z.number().min(0).max(100),
  reacquire_zero_credit: z.number().min(0).max(100),
});

/** The fixed critical-error list (PRD §10.5). */
export const CriticalErrorSchema = z.enum([
  "FRATRICIDE",
  "UNAUTHORISED_ACTION",
  "MISSED_THREAT",
  "FALSE_HOSTILE_ON_FRIENDLY",
  "NO_WARNING_BEFORE_IMPACT",
  "IGNORED_FLIGHT_PLAN",
]);
export type CriticalError = z.infer<typeof CriticalErrorSchema>;

export const RubricSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  weights: z.record(CompetencySchema, z.number().min(0)),
  mandated_dimensions: z.array(CompetencySchema),
  detection: DetectionRulesSchema,
  classification: ClassificationRulesSchema,
  reporting: ReportingRulesSchema,
  response: ResponseRulesSchema,
  coordination: CoordinationRulesSchema,
  adaptation: AdaptationRulesSchema,
  critical: z.record(CriticalErrorSchema, z.number().min(0)),
  clamp: z.object({ min: z.number(), max: z.number() }),
}).superRefine((r, ctx) => {
  const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["weights"],
      message: \`Weights must sum to 100, got \${sum}.\`,
    });
  }
});

export type Rubric = z.infer<typeof RubricSchema>;
export type ClassificationMatrix = z.infer<typeof ClassificationMatrixSchema>;

/** Raw parsed document, exactly as it appears in \`data/rubrics/default-v1.json\`. */
export const RUBRIC_DEFAULT_V1_RAW = ${JSON.stringify(data, null, 2)} as const;
`;

export const RUBRIC_DATA_PATH = join(root, "data/rubrics/default-v1.json");
export const RUBRIC_MODULE_PATH = join(root, "packages/scoring/src/generated/rubric.ts");

const genDifficulty = () => {
  const raw = readFileSync(DIFFICULTY_DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  const body = renderDifficultyModule(data);

  const out = DIFFICULTY_MODULE_PATH;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, "utf8");
  return out;
};

const genRubric = () => {
  const raw = readFileSync(RUBRIC_DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  const body = renderRubricModule(data);

  const out = RUBRIC_MODULE_PATH;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, "utf8");
  return out;
};

// `difficulty.test.ts` and `rubric.test.ts` import the render functions from here
// to re-derive the expected output in-process. Guarding the write means those
// imports stay pure — a test that rewrites the artefact it is asserting on cannot
// fail honestly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of [genDifficulty(), genRubric()]) console.log(`wrote ${f.replace(root + "\\", "")}`);
}