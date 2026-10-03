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

import type { Affiliation, Confidence } from "@skysentinel/shared";

import type { Track } from "./fusion.js";

/** Evidence strength, derived from what a track could actually support. */
export type KnowabilityBand = "low" | "medium" | "high";

export interface Knowability {
  band: KnowabilityBand;
  /** The affiliation a reasonable analyst would call at this evidence level. */
  expected_affiliation: Affiliation | "unknown";
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
  const expected_affiliation: Knowability["expected_affiliation"] =
    band === "high" ? "hostile" : band === "medium" && multi_sensor ? "hostile" : "unknown";

  const expected_confidence: Confidence = band === "high" ? "high" : band === "medium" ? "medium" : "low";

  return { band, expected_affiliation, expected_confidence, evidence, multi_sensor };
};

/** Points for a declaration, given what was knowable. 0..1. */
export const scoreDeclaration = (declared: Affiliation | "unknown", k: Knowability): number => {
  if (declared === k.expected_affiliation) return 1;
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