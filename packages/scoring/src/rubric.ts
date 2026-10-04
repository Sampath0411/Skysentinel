/**
 * Rubric loading (PRD §10.4).
 *
 * The rubric is the only thing that decides points. It lives in `data/*.json`
 * because doctrine and thresholds are configuration, not code (CLAUDE.md), and it
 * arrives here as a generated typed module because a core package may not read
 * `fs` (see `scripts/gen-data.mjs` for the full argument).
 *
 * Two things this module refuses to do:
 *
 *   - It never mutates a rubric. `RubricSchema.parse` returns a fresh object, but
 *     the *accessors* below are the only sanctioned way to read one, and they are
 *     total — every accessor either returns a value or throws. A rubric missing a
 *     dimension must fail loudly at load, not score zero at report time where it
 *     reads as "the trainee was wrong".
 *   - It never lets a caller supply a different rubric by accident. Scenarios name
 *     a rubric; if that name is unknown, `loadRubric` throws rather than silently
 *     substituting the default. A silently-defaulted rubric would make every
 *     session's score unauditable against its own configuration.
 */

import {
  RUBRIC_DEFAULT_V1_RAW,
  RubricSchema,
  type Competency,
  type CriticalError,
  type Rubric,
} from "./generated/rubric.js";

export * from "./generated/rubric.js";

/** The rubric ids shipped in `data/rubrics/`, in load order. */
export const RUBRIC_IDS = ["default-v1"] as const;
export type RubricId = (typeof RUBRIC_IDS)[number];

export const DEFAULT_RUBRIC_ID: RubricId = "default-v1";

const REGISTRY: Record<RubricId, unknown> = {
  "default-v1": RUBRIC_DEFAULT_V1_RAW,
};

/**
 * Parse and register a rubric document.
 *
 * Exists so `FR-SCR-8` (admin-editable rubrics with version history) has a seam
 * and so tests can build a deliberately broken rubric without writing JSON.
 */
export const defineRubric = (raw: unknown, id?: string): Rubric => {
  const parsed = RubricSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid rubric: ${detail}`);
  }
  if (id !== undefined && parsed.data.id !== id) {
    throw new Error(`Rubric registered as ${id} but declares id ${parsed.data.id}.`);
  }
  return parsed.data;
};

/** Look up a rubric by id. Throws on an unknown id — never falls back to a default. */
export const loadRubric = (id: RubricId = DEFAULT_RUBRIC_ID): Rubric => {
  const raw = REGISTRY[id];
  if (raw === undefined) {
    throw new Error(
      `Unknown rubric "${id}". Known: ${RUBRIC_IDS.join(", ")}. ` +
        `Refusing to substitute a default — the run's score would not be auditable.`,
    );
  }
  return defineRubric(raw, id);
};

export const isRubricId = (v: unknown): v is RubricId =>
  typeof v === "string" && (RUBRIC_IDS as readonly string[]).includes(v);

/* ------------------------------------------------------------------ accessors */

export const weightOf = (r: Rubric, c: Competency): number => {
  const w = r.weights[c];
  if (w === undefined) throw new Error(`Rubric ${r.id} has no weight for "${c}".`);
  return w;
};

export const isMandated = (r: Rubric, c: Competency): boolean => r.mandated_dimensions.includes(c);

export const criticalPenalty = (r: Rubric, k: CriticalError): number => {
  const p = r.critical[k];
  if (p === undefined) throw new Error(`Rubric ${r.id} has no penalty for critical "${k}".`);
  return p;
};

/**
 * Evaluate a piecewise-linear curve at `x`.
 *
 * Clamped at both ends rather than extrapolated: `x` below the first point is the
 * best case (a trainee who beat par) and beyond the last is the worst. The rubric
 * is deliberately allowed to omit the flat tails and have this supply them, so
 * authors do not have to write a 0-point guard cell that reads like a rule.
 *
 * The segment search takes the *first* point at or past `x`. Combined with the
 * end clamps that means a pair of points sharing an `x` (a step in the curve)
 * resolves to the left edge and never divides by zero.
 */
export const curveAt = (points: readonly { x: number; y: number }[], x: number): number => {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
};