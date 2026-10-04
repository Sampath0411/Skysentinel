/**
 * Rubric loader tests (PRD §10.4) plus the codegen drift guard.
 *
 * The drift block is the load-bearing one. `data/rubrics/default-v1.json` is the
 * source of truth and `src/generated/rubric.ts` is a build artefact; without a
 * check, an edit to the JSON with no regeneration would leave the running scorer
 * on stale weights while the file on disk claimed otherwise.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUBRIC_ID,
  RUBRIC_IDS,
  curveAt,
  criticalPenalty,
  defineRubric,
  isMandated,
  isRubricId,
  loadRubric,
  weightOf,
  RUBRIC_DEFAULT_V1_RAW,
  RubricSchema,
} from "./rubric.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const RUBRIC = loadRubric();

describe("the shipped rubric", () => {
  it("parses against its own schema", () => {
    expect(RubricSchema.safeParse(RUBRIC_DEFAULT_V1_RAW).success).toBe(true);
  });

  it("has weights summing to exactly 100", () => {
    // Guards the superRefine too: this asserts the property, not just that the
    // validator ran.
    const sum = Object.values(RUBRIC.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("mandates detection, classification and response (PRD §10.2)", () => {
    expect(RUBRIC.mandated_dimensions).toEqual(["detection", "classification", "response"]);
  });

  it("gives every one of the six categories a row and a column in the matrix", () => {
    // A missing cell would score as `undefined` → NaN at report time, which reads
    // as "the trainee was wrong" when it means the rubric is incomplete.
    for (const band of Object.keys(RUBRIC.classification.matrix)) {
      expect(Object.keys(RUBRIC.classification.matrix[band]!).sort()).toEqual(
        [
          "authorised",
          "friendly",
          "hostile",
          "non_uas",
          "suspicious",
          "unknown",
        ],
      );
    }
  });

  it("gives every one of the six categories an allowed-actions list", () => {
    expect(Object.keys(RUBRIC.response.allowed).sort()).toEqual(
      ["authorised", "friendly", "hostile", "non_uas", "suspicious", "unknown"],
    );
  });

  it("admits execute_response only from the hostile band", () => {
    // PRD §10.3 N7: a response may only be executed against what the evidence
    // actually supports. Allowing it from `suspicious` would train exactly the
    // habit the authority model exists to prevent.
    for (const [band, actions] of Object.entries(RUBRIC.response.allowed)) {
      expect(actions.includes("execute_response")).toBe(band === "hostile");
    }
  });

  it("requires authority before execute_response", () => {
    expect(RUBRIC.response.authority_required_before_execute_response).toBe(true);
  });

  it("requires the trainee to hold authority, and the trainee to hold nothing more", () => {
    // Stand-down must not be reachable from a hostile band: you cannot resolve a
    // hostile by deciding it is fine.
    expect(RUBRIC.response.allowed.hostile).not.toContain("stand_down");
    expect(RUBRIC.response.allowed.friendly).toContain("stand_down");
  });

  it("starts the detection curve at 100 at par and reaches 0 at the cap", () => {
    const { curve, latency_divisor_cap: cap } = RUBRIC.detection;
    expect(curveAt(curve, 1)).toBe(100);
    expect(curveAt(curve, cap)).toBe(0);
  });

  it("falls monotonically along the detection curve", () => {
    const { curve } = RUBRIC.detection;
    let prev = Infinity;
    for (let x = 0; x <= 8; x += 0.1) {
      const y = curveAt(curve, x);
      expect(y).toBeLessThanOrEqual(prev + 1e-9);
      prev = y;
    }
  });
});

describe("loading", () => {
  it("loads the default rubric with no argument", () => {
    expect(loadRubric().id).toBe(DEFAULT_RUBRIC_ID);
  });

  it.each(RUBRIC_IDS)("loads %s", (id) => {
    expect(loadRubric(id).id).toBe(id);
  });

  it("throws on an unknown id instead of substituting the default", () => {
    // The dangerous failure is silent substitution: the run would score against a
    // rubric its configuration never named.
    expect(() => loadRubric("v2-final" as never)).toThrow(/Unknown rubric/);
  });

  it("classifies ids with isRubricId", () => {
    expect(isRubricId("default-v1")).toBe(true);
    expect(isRubricId("default-v2")).toBe(false);
    expect(isRubricId(7)).toBe(false);
    expect(isRubricId(undefined)).toBe(false);
  });

  it("returns a fresh object each call, so a caller cannot mutate the registry", () => {
    const a = loadRubric();
    const b = loadRubric();
    expect(a).not.toBe(b);
    expect(a.weights).not.toBe(b.weights);
  });
});

describe("defineRubric validation", () => {
  const broken = (patch: Record<string, unknown>) => ({ ...RUBRIC_DEFAULT_V1_RAW, ...patch });

  it("accepts the shipped document", () => {
    expect(defineRubric(RUBRIC_DEFAULT_V1_RAW).id).toBe("default-v1");
  });

  it("rejects weights that do not sum to 100", () => {
    expect(() => defineRubric(broken({ weights: { ...RUBRIC_DEFAULT_V1_RAW.weights, response: 25 } })))
      .toThrow(/must sum to 100, got 105/);
  });

  it("rejects a classification matrix missing a cell", () => {
    const matrix = JSON.parse(JSON.stringify(RUBRIC_DEFAULT_V1_RAW.classification.matrix)) as Record<
      string,
      Record<string, number>
    >;
    delete matrix.hostile!.unknown;
    expect(() => defineRubric(broken({ classification: { ...RUBRIC_DEFAULT_V1_RAW.classification, matrix } })))
      .toThrow(/classification\.matrix/);
  });

  it("rejects a matrix cell outside 0..100", () => {
    const matrix = JSON.parse(JSON.stringify(RUBRIC_DEFAULT_V1_RAW.classification.matrix)) as Record<
      string,
      Record<string, number>
    >;
    matrix.hostile!.unknown = 140;
    expect(() => defineRubric(broken({ classification: { ...RUBRIC_DEFAULT_V1_RAW.classification, matrix } })))
      .toThrow(/classification\.matrix/);
  });

  it("rejects an allowed-actions list that drops execute_response entirely", () => {
    const allowed = JSON.parse(JSON.stringify(RUBRIC_DEFAULT_V1_RAW.response.allowed)) as Record<
      string,
      string[]
    >;
    allowed.hostile = ["continue_observe"];
    expect(() => defineRubric(broken({ response: { ...RUBRIC_DEFAULT_V1_RAW.response, allowed } })))
      .toThrow(/response\.allowed/);
  });

  it("rejects weakening the authority requirement, which is not a tunable", () => {
    // PRD §10.3 N7 and the §4 safety boundary: authority-before-execute is a rule,
    // not a weight an admin may turn off.
    expect(() =>
      defineRubric(
        broken({ response: { ...RUBRIC_DEFAULT_V1_RAW.response, authority_required_before_execute_response: false } }),
      ),
    ).toThrow(/authority_required_before_execute_response/);
  });

  it("rejects a non-integer version", () => {
    expect(() => defineRubric(broken({ version: 1.5 }))).toThrow(/version/);
  });

  it("rejects a negative critical penalty", () => {
    const critical = { ...RUBRIC_DEFAULT_V1_RAW.critical, FRATRICIDE: -30 };
    expect(() => defineRubric(broken({ critical }))).toThrow(/critical/);
  });

  it("rejects a non-object", () => {
    expect(() => defineRubric("default-v1")).toThrow(/Invalid rubric/);
    expect(() => defineRubric(null)).toThrow(/Invalid rubric/);
  });

  it("reports the failing path in the message", () => {
    expect(() => defineRubric(broken({ clamp: { min: 0, max: "100" } }))).toThrow(/clamp\.max/);
  });

  it("rejects a registration whose alias disagrees with the declared id", () => {
    expect(() => defineRubric(RUBRIC_DEFAULT_V1_RAW, "default-v9")).toThrow(
      /registered as default-v9 but declares id default-v1/,
    );
  });
});

describe("accessors", () => {
  it("reads every weight", () => {
    expect(weightOf(RUBRIC, "detection")).toBe(25);
    expect(weightOf(RUBRIC, "classification")).toBe(25);
    expect(weightOf(RUBRIC, "response")).toBe(20);
  });

  it("throws rather than defaulting for an unknown competency", () => {
    expect(() => weightOf(RUBRIC, "marksmanship" as never)).toThrow(/no weight for "marksmanship"/);
  });

  it("reads mandated dimensions", () => {
    expect(isMandated(RUBRIC, "detection")).toBe(true);
    expect(isMandated(RUBRIC, "coordination")).toBe(false);
  });

  it("reads every critical penalty", () => {
    expect(criticalPenalty(RUBRIC, "FRATRICIDE")).toBe(30);
    expect(criticalPenalty(RUBRIC, "IGNORED_FLIGHT_PLAN")).toBe(10);
  });

  it("throws for an unknown critical error rather than scoring it as zero", () => {
    expect(() => criticalPenalty(RUBRIC, "MISJUDGED_TONE" as never)).toThrow(/no penalty for critical/);
  });
});

describe("curveAt", () => {
  const curve = [
    { x: 1, y: 100 },
    { x: 2, y: 40 },
    { x: 4, y: 0 },
  ];

  const cases: [number, number][] = [
    [0, 100], // clamped low — beat par
    [1, 100], // first point
    [1.5, 70], // midpoint of the first segment
    [2, 40],
    [3, 20],
    [4, 0], // last point
    [9, 0], // clamped high — past the cap
  ];

  it.each(cases)("y(%f) === %f", (x, y) => {
    expect(curveAt(curve, x)).toBeCloseTo(y, 6);
  });

  it("is monotone non-increasing across a dense sweep", () => {
    let prev = Infinity;
    for (let x = 0; x <= 10; x += 0.05) {
      const y = curveAt(curve, x);
      expect(y).toBeLessThanOrEqual(prev + 1e-9);
      prev = y;
    }
  });

  it("resolves two points sharing an x to the left edge rather than dividing by zero", () => {
    // A step in the curve. NaN here would silently poison a whole score.
    expect(curveAt([{ x: 1, y: 10 }, { x: 1, y: 90 }], 1)).toBe(10);
    expect(curveAt([{ x: 1, y: 10 }, { x: 1, y: 90 }], 1.5)).toBe(90);
  });

  it("handles a single point by returning it everywhere", () => {
    expect(curveAt([{ x: 2, y: 55 }], 0)).toBe(55);
    expect(curveAt([{ x: 2, y: 55 }], 9)).toBe(55);
  });
});

describe("codegen drift", () => {
  const dataPath = join(repoRoot, "data", "rubrics", "default-v1.json");
  const modulePath = join(repoRoot, "packages", "scoring", "src", "generated", "rubric.ts");

  const onDisk = (): string => readFileSync(modulePath, "utf8");

  it("has a committed generated module", () => {
    expect(onDisk()).toContain("GENERATED FILE");
  });

  it("matches the JSON the module claims to have come from", async () => {
    const { renderRubricModule } = (await import(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      join(repoRoot, "scripts", "gen-data.mjs") as any
    )) as { renderRubricModule: (data: unknown) => string };

    const expected = renderRubricModule(JSON.parse(readFileSync(dataPath, "utf8")));
    const actual = onDisk();

    if (actual !== expected) {
      throw new Error(
        "data/rubrics/default-v1.json has changed but packages/scoring/src/generated/rubric.ts " +
          "was not regenerated. Run: node scripts/gen-data.mjs",
      );
    }
    expect(actual).toBe(expected);
  });

  it("carries the same weights in the generated module as in the JSON", () => {
    const json = JSON.parse(readFileSync(dataPath, "utf8")) as { weights: unknown };
    expect(RUBRIC.weights).toEqual(json.weights);
  });

  it("keeps the training-parameters caveat in the generated raw", () => {
    // Zod strips `_comment`, so the parsed rubric has none. The raw must, or a
    // reader of the build artefact loses the disclaimer the JSON carries.
    expect(RUBRIC_DEFAULT_V1_RAW).toHaveProperty("_comment");
    expect(RUBRIC_DEFAULT_V1_RAW.response).toHaveProperty("_comment");
  });
});