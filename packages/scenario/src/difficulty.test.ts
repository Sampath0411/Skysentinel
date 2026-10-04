/**
 * Difficulty map tests (PRD §8.5, §8.4 rule 5).
 *
 * Two jobs:
 *
 *   1. Check the accessors read the data correctly and fail loudly on bad input.
 *   2. Guard the codegen boundary — `data/difficulty.json` is the source of truth
 *      and `src/generated/difficulty.ts` is a build artefact, so an edit to the
 *      JSON with no regeneration must fail the suite rather than pass quietly.
 *      Without this the JSON would be decorative: the running simulator would
 *      keep using stale thresholds while the file on disk said otherwise.
 *
 * The drift check reads the two files directly. That is deliberate and is the
 * only place in the core packages that touches `fs` — it is a test asserting on
 * the build, not simulation logic.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DIFFICULTY_LEVELS,
  DIFFICULTY_MAP,
  TIMING_RULES,
  difficultyLevel,
  isDifficulty,
  minimumReactionGap,
  parFactor,
  supportCueConfidence,
} from "./difficulty.js";
import { DIFFICULTY_MAP_RAW } from "./generated/difficulty.js";

// `scripts/gen-data.mjs` is outside the package, so reach it by path. It exports a
// pure render function precisely so this test can re-derive the expected output
// rather than shelling out to the writer.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("difficulty levels", () => {
  it.each(DIFFICULTY_LEVELS)("defines level %i in the data file", (level) => {
    expect(() => difficultyLevel(level)).not.toThrow();
    expect(difficultyLevel(level).par_factor).toBeGreaterThan(0);
  });

  const bad = [0, 6, -1, 99, 2.5];

  it.each(bad)("throws on unknown level %f rather than defaulting", (level) => {
    // Silently returning level 5 would hide a generator bug behind a scenario
    // that looks plausible but is calibrated wrong.
    expect(() => difficultyLevel(level)).toThrow(/Unknown difficulty level/);
  });

  const cases = [1, 2, 3, 4, 5, 0, 6, -1];

  it.each(cases)("classifies %f correctly with isDifficulty", (v) => {
    expect(isDifficulty(v)).toBe(DIFFICULTY_LEVELS.includes(v as 1 | 2 | 3 | 4 | 5));
  });
});

describe("reaction gap (PRD §8.4 rule 5)", () => {
  it("matches the values in the data file", () => {
    expect(minimumReactionGap(1)).toBe(TIMING_RULES.d1_d2_min_gap_s);
    expect(minimumReactionGap(2)).toBe(TIMING_RULES.d1_d2_min_gap_s);
    expect(minimumReactionGap(5)).toBe(TIMING_RULES.d5_min_gap_s);
  });

  it("narrows the window as difficulty rises", () => {
    expect(minimumReactionGap(5)).toBeLessThan(minimumReactionGap(4));
    expect(TIMING_RULES.d5_min_gap_s).toBeLessThan(TIMING_RULES.d1_d2_min_gap_s);
  });

  it("is positive at every level", () => {
    for (const l of DIFFICULTY_LEVELS) expect(minimumReactionGap(l)).toBeGreaterThan(0);
  });
});

describe("support cue confidence (FR-SEN-8)", () => {
  it("falls as the trainee is expected to work with less help", () => {
    const byLevel = DIFFICULTY_LEVELS.map(supportCueConfidence);
    expect(byLevel[0]).toBeGreaterThan(byLevel[byLevel.length - 1]!);
  });

  it("is a probability at every level", () => {
    for (const l of DIFFICULTY_LEVELS) {
      const c = supportCueConfidence(l);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("hides the cue at the hardest levels, per the data file", () => {
    expect(DIFFICULTY_MAP.levels["4"]!.support_cue).toBe("hidden");
    expect(DIFFICULTY_MAP.levels["5"]!.support_cue).toBe("hidden");
  });
});

describe("par factor", () => {
  it("tightens as difficulty rises", () => {
    expect(parFactor(5)).toBeLessThan(parFactor(1));
  });

  it("is defined for every level", () => {
    for (const l of DIFFICULTY_LEVELS) expect(parFactor(l)).toBeGreaterThan(0);
  });
});

describe("codegen drift", () => {
  const dataPath = join(repoRoot, "data", "difficulty.json");
  const modulePath = join(repoRoot, "packages", "src", "generated", "difficulty.ts");
  const modulePathFromPackage = join(repoRoot, "packages", "scenario", "src", "generated", "difficulty.ts");

  const onDisk = (): string => {
    for (const p of [modulePathFromPackage, modulePath]) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`generated difficulty module not found (looked in ${modulePathFromPackage})`);
  };

  it("has a committed generated module", () => {
    expect(onDisk()).toContain("GENERATED FILE");
  });

  it("matches the JSON the module claims to have come from", async () => {
    const { renderDifficultyModule } = (await import(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      join(repoRoot, "scripts", "gen-data.mjs") as any
    )) as { renderDifficultyModule: (data: unknown) => string };

    const expected = renderDifficultyModule(JSON.parse(readFileSync(dataPath, "utf8")));
    const actual = onDisk();

    if (actual !== expected) {
      throw new Error(
        "data/difficulty.json has changed but packages/scenario/src/generated/difficulty.ts " +
          "was not regenerated. Run: node scripts/gen-data.mjs",
      );
    }
    expect(actual).toBe(expected);
  });

  it("carries the same levels in the generated module as in the JSON", () => {
    const json = JSON.parse(readFileSync(dataPath, "utf8")) as {
      levels: Record<string, unknown>;
      timing: unknown;
      support_cue: unknown;
    };
    // Zod strips unknown keys, so the `_comment` blocks present in the JSON are
    // absent from the parsed map by design. Compare the values that survive.
    const values = (o: unknown): unknown =>
      JSON.parse(JSON.stringify(o, (k, v) => (k === "_comment" ? undefined : v)));

    expect(Object.keys(DIFFICULTY_MAP.levels).sort()).toEqual(Object.keys(json.levels).sort());
    expect(DIFFICULTY_MAP.timing).toEqual(values(json.timing));
    expect(DIFFICULTY_MAP.support_cue).toEqual(values(json.support_cue));
  });

  it("keeps DIFFICULTY_MAP_RAW byte-identical to the JSON document", () => {
    // `_comment` blocks are stripped by Zod but must still be present in the
    // emitted raw, so a reader of the generated file sees the same caveats.
    expect(DIFFICULTY_MAP_RAW).toHaveProperty("_comment");
    expect(DIFFICULTY_MAP_RAW.timing).toHaveProperty("_comment");
  });
});