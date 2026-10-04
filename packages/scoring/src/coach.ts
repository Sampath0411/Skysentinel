/**
 * Coach template text (PRD §14 M4).
 *
 * Fill-in-the-blanks, not generation. Every string here is a fixed template with a
 * number or a phrase substituted, assembled from the rubric and the node reasons the
 * scorer already produced. There is no LLM in this path and there never will be
 * (CLAUDE.md): a comment that invents a reason the scorer did not compute would be
 * an unsourced claim presented as assessment, which is worse than no comment.
 *
 * Templates select on score band and on the node's competency, so a rewrite of the
 * tree flows through to the text without editing this file.
 */

import type { CompetencyScore, DecisionReview, ScoreResult } from "./types.js";

/** A band a competency score falls into. Named for the AAR, not for arithmetic. */
export type Band = "strong" | "adequate" | "weak" | "absent" | "not_assessed";

export const bandOf = (points: number): Band => {
  if (points >= 75) return "strong";
  if (points >= 45) return "adequate";
  if (points > 0) return "weak";
  return "absent";
};

/**
 * The phrase for a competency, chosen from the band.
 *
 * `not_assessed` is separated from `absent` deliberately: the scenario never tested
 * the dimension, which says nothing about the trainee. Reporting it as "absent"
 * would read as a failure that never happened.
 */
export const bandFor = (score: Pick<CompetencyScore, "points" | "assessed">): Band =>
  score.assessed ? bandOf(score.points) : "not_assessed";

const COMPETENCY_PHRASE: Record<CompetencyScore["competency"], Record<Band, string>> = {
  detection: {
    strong: "Cues were converted into contacts promptly.",
    adequate: "Cues were detected, though later than par on some tracks.",
    weak: "Detection was slow or missed on several tracks.",
    absent: "Contacts went unmarked, so nothing downstream could be judged.",
    not_assessed: "No cues were presented, so detection was not tested.",
  },
  classification: {
    strong: "Declarations matched what the evidence supported.",
    adequate: "Most declarations were defensible; some drifted from the evidence.",
    weak: "Declarations often asserted more than the evidence carried.",
    absent: "No classifications were submitted.",
    not_assessed: "Nothing was classified in this run.",
  },
  response: {
    strong: "Actions were appropriate for what each contact was.",
    adequate: "Actions were mostly appropriate but some were late.",
    weak: "Actions were late, or not available at the band the evidence supported.",
    absent: "No response actions were taken when the picture called for them.",
    not_assessed: "No contact required a response in this run.",
  },
  reporting: {
    strong: "Reports were complete, accurate and prompt.",
    adequate: "Reports were usable but missed detail or arrived late.",
    weak: "Reports were incomplete or inaccurate.",
    absent: "Required reports were not sent.",
    not_assessed: "This scenario required no reports.",
  },
  prioritisation: {
    strong: "Attention went to the main effort first.",
    adequate: "The right contacts were addressed, though not first.",
    weak: "Attention went to decoys before the main effort.",
    absent: "No prioritisation decision could be judged.",
    not_assessed: "Only one contact needed attention, so there was no order to judge.",
  },
  coordination: {
    strong: "Ownership was assigned and the picture was kept current.",
    adequate: "Some coordination happened; ownership or updates were missing.",
    weak: "Little coordination: no ownership assigned or picture not updated.",
    absent: "No coordination was attempted.",
    not_assessed: "Coordination was not exercised in this run.",
  },
  adaptation: {
    strong: "The picture was rebuilt quickly after losses.",
    adequate: "Recovery happened but took longer than par.",
    weak: "Recovery was slow after tracks were lost.",
    absent: "Tracks were lost and never reacquired.",
    not_assessed: "Nothing was lost during this run, so recovery was not tested.",
  },
};

/** One templated line per competency, in PRD §10.2 table order. */
export const competencyComments = (result: ScoreResult): { competency: string; band: Band; comment: string }[] =>
  result.competencies.map((c) => {
    const band = bandFor(c);
    return { competency: c.competency, band, comment: COMPETENCY_PHRASE[c.competency][band] };
  });

/**
 * The headline. Two sentences, both derived from numbers already computed.
 *
 * The process/outcome split is the point: it names which half of the run the
 * trainee should study first, which is the question the AAR exists to answer.
 */
export const headline = (result: ScoreResult): string => {
  const gap = result.process_score - result.mission_outcome.score;
  const direction =
    Math.abs(gap) < 10
      ? "Process and outcome were consistent."
      : gap > 0
        ? `Decisions were sound (process ${result.process_score}) but the outcome fell short (${result.mission_outcome.score}) — the next review should focus on why sound decisions did not produce a better result.`
        : `The outcome was favourable (${result.mission_outcome.score}) but the process was weak (${result.process_score}) — treat it as a result that will not repeat.`;

  return `Scored ${result.total}/100 after critical-error penalties. ${direction}`;
};

/** One templated line per critical error, each naming the event that caused it. */
export const criticalComments = (result: ScoreResult): string[] =>
  result.critical_errors.map(
    (c) => `${c.kind} (−${c.penalty}): ${c.reason}`,
  );

/** The §10.6 process-vs-outcome labels, as ready-to-display strings. */
export const reviewComments = (reviews: readonly DecisionReview[]): string[] =>
  reviews.map((r) => `${r.truth_id}: ${r.label} — ${r.reason}`);

/** The weakest three scored nodes, which is where a review should start. */
export const weakestNodes = (result: ScoreResult, count = 3): string[] =>
  result.nodes
    .filter((n) => n.max_points > 0)
    .sort((a, b) => a.points / a.max_points - b.points / b.max_points)
    .slice(0, count)
    .map((n) => `${n.label}: ${n.points}/${n.max_points}. ${n.reason}`);

/**
 * The whole coaching brief.
 *
 * Assembled in a fixed order so two runs of the same log produce byte-identical
 * text — the AAR must be reproducible like everything else (FR-SIM-1).
 */
export const coachBrief = (result: ScoreResult): string[] => [
  headline(result),
  "",
  ...competencyComments(result).map((c) => `${c.competency} [${c.band}]: ${c.comment}`),
  ...(criticalComments(result).length > 0 ? ["", ...criticalComments(result)] : []),
  "",
  "Weakest nodes:",
  ...weakestNodes(result).map((s) => `  - ${s}`),
];