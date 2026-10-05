/**
 * The mandated three for the AAR card (PRD §12.2).
 *
 * Detection time against par, classification accuracy with a confusion note, and
 * response decisions correct out of total with the unauthorised count. PRD §12.2
 * asks for those three *instead of* competency points, which is what the card used
 * to show — a trainee read "62/100" where the PS asks "14 s, par 12 s".
 *
 * Derived from `RunFacts` and the emitted nodes rather than re-reading the log, so
 * it cannot disagree with the tree: the card's `correct/total` is the same `N7` set
 * the score explanation below it expands, and its grade is the same verdict `N3`
 * gives in its reason text.
 *
 * Pure, like everything else in this package.
 */

import type { ClassificationCategory } from "@skysentinel/shared";

import type { RunFacts, TrackFacts } from "./log.js";
import type {
  ClassificationSummary,
  CriticalErrorResult,
  DetectionGrade,
  DetectionSummary,
  MandatedSummary,
  NodeResult,
  ResponseSummary,
} from "./types.js";

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The track the detection card should describe.
 *
 * `RunFacts.tracks` is sorted by first cue, so the first cued track is the run's
 * earliest warning problem — the one a detection-time headline is about. A scenario
 * that cued nothing has no detection story, and `undefined` propagates to a card
 * that says so rather than to a zero that looks like a very slow detection.
 */
const detectionTrack = (facts: RunFacts): TrackFacts | undefined =>
  facts.tracks.find((f) => Number.isFinite(f.first_cue_ms));

/**
 * Detection time, par and grade for the earliest-cued track.
 *
 * Mirrors `scoreDetection`'s latency math and its three verdict bands exactly. If
 * that grading ever changes, the card changes with it — the test in
 * `mandated.test.ts` asserts the two agree.
 */
export const detectionSummary = (facts: RunFacts): DetectionSummary => {
  const f = detectionTrack(facts);
  if (f === undefined) {
    return { truth_id: "—", grade: "never_cued" };
  }

  if (f.marked_ms === undefined) {
    return { truth_id: f.truth_id, grade: "never_marked" };
  }

  const latency_s = round1((f.marked_ms - f.first_cue_ms) / 1000);
  const par_s = f.expected?.par_detect_s;

  if (par_s === undefined) {
    return { truth_id: f.truth_id, latency_s, grade: "no_par" };
  }

  const normalised = Math.max(0, latency_s / par_s);
  const grade: DetectionGrade =
    normalised <= 1 ? "at_par" : normalised <= 2 ? "late" : "well_past_par";

  return { truth_id: f.truth_id, latency_s, par_s: round1(par_s), grade };
};

/** Was this track's final declaration one the scenario accepts? */
const finalDeclarationCorrect = (f: TrackFacts): boolean | undefined => {
  const defensible = f.expected?.correct_category;
  const last = f.declarations.at(-1);
  if (defensible === undefined || last === undefined) return undefined;
  return defensible.includes(last.category);
};

/**
 * Classification accuracy across the tracks that had a defensible answer, with a
 * note naming the worst confusion.
 *
 * Accuracy is over *scored* tracks, so a scenario whose third contact has no
 * `expected` block cannot dilute the percentage. The final declaration is the one
 * judged, matching `scoreClassification`'s `exact` — a trainee who corrected a bad
 * call is accurate on the call they stood behind.
 */
export const classificationSummary = (facts: RunFacts): ClassificationSummary => {
  let scored = 0;
  let correct = 0;
  const wrong: { truth_id: string; declared: ClassificationCategory; defensible: readonly ClassificationCategory[] }[] = [];

  for (const f of facts.tracks) {
    const ok = finalDeclarationCorrect(f);
    if (ok === undefined) continue;
    scored++;
    if (ok) {
      correct++;
      continue;
    }
    wrong.push({
      truth_id: f.truth_id,
      declared: f.declarations.at(-1)!.category,
      defensible: f.expected!.correct_category,
    });
  }

  if (scored === 0) {
    return {
      accuracy_pct: 0,
      correct: 0,
      scored: 0,
      confusion_note:
        facts.tracks.length === 0
          ? "No tracks in the run."
          : facts.tracks.every((f) => f.declarations.length === 0)
            ? "No classifications submitted."
            : "No track had a defensible answer to score against.",
    };
  }

  if (wrong.length === 0) {
    return {
      accuracy_pct: 100,
      correct,
      scored,
      confusion_note: "Every final declaration was defensible.",
    };
  }

  const first = wrong[0]!;
  const s = wrong.length === 1 ? "" : "s";
  return {
    accuracy_pct: Math.round((correct / scored) * 100),
    correct,
    scored,
    confusion_note:
      `${wrong.length} of ${scored} misdeclared${s}; e.g. ${first.truth_id} declared ` +
      `${first.declared} where ${first.defensible.join(" or ")} was defensible.`,
  };
};

/** Response decisions, from the `N7` nodes the tree already emitted. */
export const responseSummary = (
  nodes: readonly NodeResult[],
  critical_errors: readonly CriticalErrorResult[],
): ResponseSummary => {
  const scored = nodes.filter((n) => n.id.startsWith("N7.") && n.max_points > 0);
  return {
    correct: scored.filter((n) => n.passed).length,
    total: scored.length,
    unauthorised: critical_errors.filter((c) => c.kind === "UNAUTHORISED_ACTION").length,
  };
};

export const buildMandated = (
  facts: RunFacts,
  nodes: readonly NodeResult[],
  critical_errors: readonly CriticalErrorResult[],
): MandatedSummary => ({
  detection: detectionSummary(facts),
  classification: classificationSummary(facts),
  response: responseSummary(nodes, critical_errors),
});
