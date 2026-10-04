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

const BANNER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: \`data/difficulty.json\`
 * Regenerate: \`node scripts/gen-data.mjs\`
 *
 * Difficulty levels are a training abstraction (PRD §8.5). They are not calibrated
 * against any real course and must not be presented as an assessment standard.
 */
`;

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

const genDifficulty = () => {
  const raw = readFileSync(DIFFICULTY_DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  const body = renderDifficultyModule(data);

  const out = DIFFICULTY_MODULE_PATH;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, "utf8");
  return out;
};

// `difficulty.test.ts` imports `renderDifficultyModule` from here to re-derive the
// expected output in-process. Guarding the write means that import stays pure —
// a test that rewrites the artefact it is asserting on cannot fail honestly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of [genDifficulty()]) console.log(`wrote ${f.replace(root + "\\", "")}`);
}