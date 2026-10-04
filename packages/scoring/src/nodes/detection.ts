/**
 * N1–N3: detection and early warning (PRD §10.3, FR-SCR-2).
 *
 * The mandated dimension. Points come from a curve on normalised latency, so a
 * trainee who marks a cue immediately and one who marks it at par score the same,
 * and the curve supplies every threshold — nothing here hard-codes a latency.
 *
 * N1 excludes a track from the run when no credible cue was ever presented. That
 * exclusion is a node with `points: 0` and `passed: false` so it is visible in the
 * AAR rather than silently absent: a scenario that never cued something did test
 * something, and the report should say so.
 */

import { curveAt } from "../rubric.js";
import type { Rubric } from "../generated/rubric.js";
import type { TrackFacts } from "../log.js";
import type { NodeResult } from "../types.js";

const msToS = (ms: number): number => ms / 1000;

/**
 * N1: was a credible cue presented for this track at all?
 *
 * A track the trainee was never shown anything about cannot be held to a detection
 * standard — penalising it would teach that the simulator is withholding
 * information, not that the trainee is slow.
 */
export const scoreCuePresented = (f: TrackFacts): NodeResult => {
  const cued = Number.isFinite(f.first_cue_ms);
  return {
    id: `N1.${f.truth_id}`,
    label: `Cue presented for ${f.truth_id}`,
    passed: cued,
    points: 0,
    max_points: 0,
    reason: cued
      ? `First credible cue at ${msToS(f.first_cue_ms).toFixed(1)}s; track is in scope.`
      : `No sensor ever cued ${f.truth_id}; excluded from detection scoring.`,
    event_refs: f.first_cue_seq !== undefined ? [f.first_cue_seq] : [],
  };
};

/** N2+N3: did the trainee mark the contact, and how quickly? */
export const scoreDetection = (f: TrackFacts, rubric: Rubric): NodeResult => {
  const par_s = f.expected?.par_detect_s;

  if (!Number.isFinite(f.first_cue_ms)) {
    return {
      id: `N3.${f.truth_id}`,
      label: `Detection of ${f.truth_id}`,
      passed: false,
      points: 0,
      max_points: 0,
      reason: `Not scored: ${f.truth_id} was never cued.`,
      event_refs: [],
    };
  }

  const markRefs = f.marked_seq !== undefined ? [f.marked_seq] : [];

  if (f.marked_ms === undefined) {
    return {
      id: `N3.${f.truth_id}`,
      label: `Detection of ${f.truth_id}`,
      passed: false,
      points: 0,
      max_points: 100,
      reason: `Cue presented at ${msToS(f.first_cue_ms).toFixed(1)}s was never marked as a contact.`,
      event_refs: f.first_cue_seq !== undefined ? [f.first_cue_seq] : [],
    };
  }

  if (par_s === undefined) {
    // A track the scenario author did not give a par to has no latency standard.
    // Score the mark as correct and say why there are no latency points.
    return {
      id: `N3.${f.truth_id}`,
      label: `Detection of ${f.truth_id}`,
      passed: true,
      points: 0,
      max_points: 0,
      reason: `Contact marked at ${msToS(f.marked_ms).toFixed(1)}s. The scenario sets no par detection time for ${f.truth_id}, so latency is not scored.`,
      event_refs: markRefs,
    };
  }

  const latency_s = msToS(f.marked_ms - f.first_cue_ms);
  const normalised = Math.max(0, latency_s / par_s);
  const points = curveAt(rubric.detection.curve, normalised);

  const verdict =
    normalised <= 1 ? "at or inside par" : normalised <= 2 ? "late" : "well past par";

  return {
    id: `N3.${f.truth_id}`,
    label: `Detection of ${f.truth_id}`,
    passed: points > 0,
    points: round2(points),
    max_points: 100,
    reason:
      `Marked ${latency_s.toFixed(1)}s after the first cue (par ${par_s.toFixed(1)}s, ` +
      `×${normalised.toFixed(2)}) — ${verdict}.`,
    event_refs: f.first_cue_seq !== undefined ? [f.first_cue_seq, ...markRefs] : markRefs,
  };
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Aggregate per-track detection points.
 *
 * Averaged, not summed: a scenario with eight tracks and one with two must both be
 * able to reach 100, or detection weight would silently mean different things in
 * different scenarios. A track that produced no cue is excluded from the average
 * rather than counted as zero — it is excluded from scoring altogether (N1).
 */
export const aggregateDetection = (nodes: NodeResult[]): number => {
  const scored = nodes.filter((n) => n.max_points > 0);
  if (scored.length === 0) return 0;
  const sum = scored.reduce((acc, n) => acc + n.points / n.max_points, 0);
  return round2((sum / scored.length) * 100);
};