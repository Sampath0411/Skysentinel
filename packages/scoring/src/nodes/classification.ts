/**
 * N4–N5: classification quality (PRD §10.3, FR-SCR-3).
 *
 * The mandated dimension, and the one PRD §9.4 governs: a declaration is judged
 * against `expected.correct_category` — what a competent analyst could defensibly
 * have concluded from the evidence actually presented — not against final truth.
 * A scenario author decides that set at authoring time; the scorer takes it as given
 * and never recomputes it, so the "was this knowable?" judgement stays in one place.
 *
 * Points come from the rubric's classification matrix (rows = expected, cols =
 * declared), so the curve that decides what counts as an over-call lives in
 * `data/rubrics/default-v1.json`, not here.
 *
 * Two adjustments sit on top of the matrix, both rubric-driven:
 *
 *   - a reclassification that moved *toward* a defensible category earns the
 *     rubric's bonus, capped so it cannot exceed a perfect first declaration;
 *   - a confidence that outruns the evidence is penalised, because the same
 *     category declared "low" and declared "high" are not the same claim.
 */

import { clamp, type ClassificationCategory } from "@skysentinel/shared";

import type { Rubric } from "../generated/rubric.js";
import { declaredCategories, type TrackFacts } from "../log.js";
import type { NodeResult } from "../types.js";

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The matrix cell for one (expected, declared) pair, defaulting to zero. */
const cell = (rubric: Rubric, expected: ClassificationCategory, declared: ClassificationCategory): number =>
  rubric.classification.matrix[expected]?.[declared] ?? 0;

/**
 * Best matrix score across every defensible category.
 *
 * A scenario may list several correct categories (an ambiguous contact). The
 * trainee is scored against the best of them, because holding them to only one
 * would make an ambiguous scenario fail a correct analyst.
 */
const bestCell = (
  rubric: Rubric,
  defensible: readonly ClassificationCategory[],
  declared: ClassificationCategory,
): number => Math.max(...defensible.map((d) => cell(rubric, d, declared)), 0);

/**
 * The confidence adjustment.
 *
 * `confidence_policy.order` is the rubric's own low → medium → high ordering, so
 * the comparison is against data rather than an assumed scale. The penalty scales
 * with how far the declared confidence outruns what a defensible category would
 * support: an over-call at the edge is a softer error than an over-call two steps out.
 */
const confidenceAdjustment = (
  rubric: Rubric,
  declared_confidence: TrackFacts["declarations"][number]["confidence"] | undefined,
  band_confidence: TrackFacts["declarations"][number]["confidence"],
): { delta: number; note: string } => {
  if (declared_confidence === undefined) return { delta: 0, note: "" };

  const { order, overconfidence_penalty, underconfidence_penalty } = rubric.classification.confidence_policy;
  const gap = order.indexOf(declared_confidence) - order.indexOf(band_confidence);

  if (gap > 0) {
    return {
      delta: -overconfidence_penalty * gap,
      note: ` Declared ${declared_confidence} against a defensible ${band_confidence} (${gap} step${gap > 1 ? "s" : ""} over).`,
    };
  }
  if (gap < 0) {
    return {
      delta: -underconfidence_penalty * -gap,
      note: ` Declared ${declared_confidence} against a defensible ${band_confidence}.`,
    };
  }
  return { delta: 0, note: "" };
};

/**
 * The confidence a defensible declaration carries, given the corroboration behind it.
 *
 * Mirrors sim-core's `assessKnowability` banding (PRD §9.4) from the log alone: the
 * scorer sees events, not live track objects, so it reconstructs the signal from the
 * `sources` accumulated on `track_update`. Two or more sensors corroborating is
 * what separates a `high` band from a `medium` one there, so it is the same test
 * here — keeping the scorer's expectation aligned with the simulation's.
 */
const bandConfidenceFor = (f: TrackFacts): TrackFacts["declarations"][number]["confidence"] =>
  f.sources.size >= 2 ? "high" : "medium";

/** N5: the classification score for one track, best-of across declarations. */
export const scoreClassification = (f: TrackFacts, rubric: Rubric): NodeResult => {
  const defensible = f.expected?.correct_category;

  if (f.declarations.length === 0) {
    return {
      id: `N5.${f.truth_id}`,
      label: `Classification of ${f.truth_id}`,
      passed: false,
      points: 0,
      max_points: 100,
      reason:
        defensible === undefined
          ? `${f.truth_id} has no authored expected block, so its classification is not scored.`
          : `No classification was submitted. Defensible answer${defensible.length > 1 ? "s" : ""}: ${defensible.join(", ")}.`,
      event_refs: [],
    };
  }

  if (defensible === undefined) {
    return {
      id: `N5.${f.truth_id}`,
      label: `Classification of ${f.truth_id}`,
      passed: true,
      points: 0,
      max_points: 0,
      reason: `Classified as ${f.declarations.map((d) => d.category).join(" then ")}. No expected block for ${f.truth_id}, so classification is not scored.`,
      event_refs: [f.declarations[0]!.seq],
    };
  }

  const band_confidence = bandConfidenceFor(f);

  // Best single declaration, then the reclassification bonus on top.
  let best_points = 0;
  let best_seq = f.declarations[0]!.seq;
  let best_note = "";

  for (const d of f.declarations) {
    const base = bestCell(rubric, defensible, d.category);
    const { delta, note } = confidenceAdjustment(rubric, d.confidence, band_confidence);
    const total = clamp(base + delta, 0, 100);
    if (total > best_points) {
      best_points = total;
      best_seq = d.seq;
      best_note = note;
    }
  }

  const seen = declaredCategories(f);
  const moved_toward_truth =
    seen.length > 1 &&
    seen.some((c, i) => i > 0 && defensible.includes(c) && !defensible.includes(seen[i - 1]!));

  const bonus = moved_toward_truth
    ? Math.min(rubric.classification.reclassify_bonus_cap - best_points, rubric.classification.reclassify_toward_truth_bonus)
    : 0;

  const final = clamp(best_points + bonus, 0, 100);
  const exact = defensible.includes(f.declarations.at(-1)!.category);

  const refs = [best_seq];
  if (moved_toward_truth && bonus > 0) refs.push(f.declarations.at(-1)!.seq);

  return {
    id: `N5.${f.truth_id}`,
    label: `Classification of ${f.truth_id}`,
    passed: final > 0,
    points: round2(final),
    max_points: 100,
    reason:
      `Declared ${seen.join(" then ")}; defensible ${defensible.join(" or ")}.` +
      `${best_note}` +
      (bonus > 0 ? ` Reclassified toward the defensible answer: +${bonus}.` : "") +
      (exact ? "" : " The final declaration does not match a defensible category."),
    event_refs: refs,
  };
};

/** Aggregate classification points, averaged over the tracks that were scored. */
export const aggregateClassification = (nodes: NodeResult[]): number => {
  const scored = nodes.filter((n) => n.max_points > 0);
  if (scored.length === 0) return 0;
  const sum = scored.reduce((acc, n) => acc + n.points / n.max_points, 0);
  return round2((sum / scored.length) * 100);
};