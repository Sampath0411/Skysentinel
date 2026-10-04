/**
 * Knowability model (PRD §9.4, FR-SCR-7).
 *
 * This is the fair-scoring mechanic. A trainee is not scored against final truth
 * but against what was knowable from the evidence actually available at time t.
 *
 * Declaring "unknown / medium" on a hostile drone that was genuinely hard to
 * detect outscores declaring "hostile / high", because the second claim was not
 * supported by the evidence the trainee had. A trainee who is honest about
 * uncertainty is rewarded; one who guesses confidently is not.
 */

import type { ClassificationCategory, Confidence } from "@skysentinel/shared";

import type { Track } from "./fusion.js";

/** Evidence strength, derived from what a track could actually support. */
export type KnowabilityBand = "low" | "medium" | "high";

export interface Knowability {
  band: KnowabilityBand;
  /**
   * The category a reasonable analyst would call at this evidence level.
   *
   * Named `expected_category` rather than `expected_affiliation` because it spans
   * all six `ClassificationCategory` values. `Affiliation` is the four-value truth
   * vocabulary and has no `unknown`, `suspicious` or `non_uas` — those are analyst
   * calls, not facts about an object, which is exactly why the scorer compares a
   * declaration against this rather than against truth (PRD §9.4).
   *
   * This is the *evidence-only* call. The scorer may widen it using scenario truth
   * (a matching flight plan, a loiter profile) before indexing the rubric matrix,
   * because only it can see truth. See `expectedCategory` in `@skysentinel/scoring`.
   */
  expected_category: ClassificationCategory;
  /** The confidence a reasonable analyst would attach. */
  expected_confidence: Confidence;
  /** Which channels contributed. Reported to the trainee as an explanation. */
  evidence: string[];
  /** True when the track is corroborated by more than one sensor. */
  multi_sensor: boolean;
}

/**
 * Derive knowability from the track's evidence.
 *
 * The thresholds are fictional training parameters, chosen so that a single radar
 * return is `medium`, two independent sensors is `high`, and an RF-only detection
 * of a silent-capable archetype stays `low`.
 */
export const assessKnowability = (track: Track): Knowability => {
  const multi_sensor = track.sources.length >= 2;
  const hasRange = track.range_m !== undefined;
  const hasSpeed = track.speed_mps !== undefined;

  let score = 0;
  const evidence: string[] = [];

  // Corroboration across sensors is the single strongest signal.
  if (multi_sensor) {
    score += 2;
    evidence.push(`${track.sources.length} independent sensors`);
  } else {
    evidence.push("single sensor");
  }

  // Range and speed both mean the track has been measured, not merely seen.
  if (hasRange) {
    score += 1;
    evidence.push("range measured");
  }
  if (hasSpeed) {
    score += 1;
    evidence.push("speed measured");
  }

  // A confirmed track (sustained correlation) beats a one-frame detection.
  if (track.status === "confirmed" || track.status === "reacquired") {
    score += 1;
    evidence.push("track confirmed over time");
  } else if (track.status === "lost") {
    score -= 1;
    evidence.push("track lost");
  }

  // Confidence feeds back: a low-confidence detection cannot support a high band
  // however many fields it carries.
  if (track.confidence < 0.4) {
    score -= 1;
    evidence.push("low detection confidence");
  }

  const band: KnowabilityBand = score >= 3 ? "high" : score >= 1 ? "medium" : "low";

  // At `low` the honest call is unknown. At `high` the evidence supports a call.
  // `medium` supports a call only if more than one sensor saw it.
  const expected_category: Knowability["expected_category"] =
    band === "high" ? "hostile" : band === "medium" && multi_sensor ? "hostile" : "unknown";

  const expected_confidence: Confidence = band === "high" ? "high" : band === "medium" ? "medium" : "low";

  return { band, expected_category, expected_confidence, evidence, multi_sensor };
};

/**
 * Coarse 0..1 credit for a declaration, given what was knowable.
 *
 * This is the honest-uncertainty mechanic in miniature: an "unknown" on a
 * `medium` band is a better answer than a confident "hostile", because the second
 * was not supported by the evidence the trainee actually had.
 *
 * The scorer does **not** use this for points. It indexes the rubric's
 * classification matrix instead, so that every threshold lives in
 * `data/*.json` per CLAUDE.md. This stays exported for the trainee-facing
 * explanation and for tests that state the principle directly.
 */
export const scoreDeclaration = (declared: ClassificationCategory, k: Knowability): number => {
  if (declared === k.expected_category) return 1;
  // A cautious "unknown" on a `medium` band is only a partial match, not full credit.
  if (declared === "unknown" && k.band === "high") return 0.4;
  // Claiming a call the evidence did not support.
  if (declared !== "unknown" && k.band === "low") return 0;
  return 0;
};

/** Human-readable explanation, for the AAR. */
export const explainKnowability = (k: Knowability): string => {
  const band = k.band.toUpperCase();
  if (k.evidence.length === 0) return `Evidence: ${band} (none available).`;
  return `Evidence: ${band} — ${k.evidence.join(", ")}.`;
};