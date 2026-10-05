/**
 * The scorer (PRD §10.1): events + expected + rubric → `ScoreResult`.
 *
 * Deterministic and explainable by construction. The only inputs are the three the
 * PRD names, every threshold comes from the rubric, and the output carries a reason
 * and event references for every non-zero score. There is no LLM anywhere on this
 * path — not in scoring, not in explaining, not in labelling (CLAUDE.md).
 *
 * Order of work, which is also the order the PRD's tree reads:
 *   N1/N3 detection · N4 brief · N5 classification · N6 reporting · N7 response
 *   · N8 prioritisation · N9 coordination · N10 recovery.
 *
 * The two headline numbers are computed independently (PRD §10.6): `process_score`
 * from this tree, `mission_outcome.score` from what actually happened. `total` is
 * the weighted process score less critical-error penalties, clamped — it is *not*
 * a blend of the two, so a trainee cannot improve their total by getting lucky.
 */

import { clamp } from "@skysentinel/shared";

import type { Competency } from "./generated/rubric.js";
import { criticalPenalty, isMandated, loadRubric, weightOf, type Rubric, type RubricId } from "./rubric.js";
import { readRun, type RunFacts } from "./log.js";
import { scoreOutcome } from "./outcome.js";
import {
  aggregateClassification,
  scoreClassification,
} from "./nodes/classification.js";
import {
  aggregateDetection,
  scoreCuePresented,
  scoreDetection,
} from "./nodes/detection.js";
import { aggregateReporting, scoreReporting } from "./nodes/reporting.js";
import { aggregateResponse, scoreResponse, criticalResults } from "./nodes/response.js";
import {
  collectCritical,
  scoreBriefConsulted,
  scoreCoordination,
  scorePrioritisation,
  scoreRecovery,
} from "./nodes/coordination.js";
import { buildMandated } from "./mandated.js";
import type {
  CompetencyScore,
  CriticalErrorResult,
  DecisionReview,
  NodeResult,
  ScoreInput,
  ScoreResult,
} from "./types.js";

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Competencies in PRD §10.2 table order, so `competencies[]` reads as the table. */
const COMPETENCIES: Competency[] = [
  "detection",
  "classification",
  "response",
  "reporting",
  "prioritisation",
  "coordination",
  "adaptation",
];

export interface ScoreOptions {
  /** Defaults to `default-v1`. Never silently substituted — see `loadRubric`. */
  rubric_id?: RubricId;
  /** Par response times per truth id. Falls back to a scenario-wide default. */
  par_response_s?: number;
  /** Par response time per truth id, overriding the scenario-wide value. */
  par_response_by_track?: ReadonlyMap<string, number>;
}

/**
 * Score one run.
 *
 * The signature is deliberately narrow — data in, data out. A caller that needs to
 * score a session must first hand over the event log and the truth correlation,
 * which is what keeps ground truth a server-side concern (PRD §4).
 */
export const scoreRun = (input: ScoreInput, options: ScoreOptions = {}): ScoreResult => {
  const rubric = loadRubric(options.rubric_id);
  const facts = readRun(input);

  const nodes: NodeResult[] = [];
  const per_competency = new Map<Competency, NodeResult[]>();

  const emit = (competency: Competency, node: NodeResult): void => {
    nodes.push(node);
    if (node.max_points > 0) {
      const list = per_competency.get(competency) ?? [];
      list.push(node);
      per_competency.set(competency, list);
    }
  };

  // --- N1/N3 detection -------------------------------------------------------
  for (const f of facts.tracks) {
    emit("detection", scoreCuePresented(f));
    const detection = scoreDetection(f, rubric);
    emit("detection", detection);
  }
  // An unattributed cue is a scenario or fusion fault, not a trainee failure. It is
  // reported as a zero-max node so it is visible without affecting the score.
  for (const [type, count] of Object.entries(facts.unattributed)) {
    if (count === 0) continue;
    nodes.push({
      id: `N1.unattributed.${type}`,
      label: `Unattributed ${type}`,
      passed: true,
      points: 0,
      max_points: 0,
      reason: `${count} ${type} event${count === 1 ? "" : "s"} could not be correlated to ground truth and are not scored.`,
      event_refs: [],
    });
  }

  // --- N4 brief (coordination) -----------------------------------------------
  emit("coordination", scoreBriefConsulted(facts));

  // --- N5 classification -----------------------------------------------------
  for (const f of facts.tracks) emit("classification", scoreClassification(f, rubric));

  // --- N6 reporting ----------------------------------------------------------
  for (const f of facts.tracks) {
    // Only tracks the scenario requires a report for are scored; reporting on a
    // bird is not a mark of competence and reporting on nothing is not a lapse.
    if (f.expected?.required_report) emit("reporting", scoreReporting(f, rubric));
  }

  // --- N7 response -----------------------------------------------------------
  const byTrack = new Map(facts.tracks.map((f) => [f.truth_id, f]));
  const findings: { kind: CriticalErrorResult["kind"]; reason: string; seq: number }[] = [];
  for (const f of facts.tracks) {
    const par = options.par_response_by_track?.get(f.truth_id) ?? options.par_response_s;
    const { node, critical } = scoreResponse(f, rubric, par);
    emit("response", node);
    findings.push(...critical);
  }

  // --- N8 prioritisation -----------------------------------------------------
  const prioritisation = scorePrioritisation(facts, input.expected.protect);
  emit("prioritisation", prioritisation);

  // --- N9 coordination -------------------------------------------------------
  const coordination = scoreCoordination(facts, rubric);
  emit("coordination", coordination);

  // --- N10 recovery ----------------------------------------------------------
  const recovery = scoreRecovery(facts, rubric);
  emit("adaptation", recovery);

  // --- aggregate competencies ------------------------------------------------
  //
  // A competency with no scored node was not exercised by this run, so it is marked
  // unassessed and left out of the weighted sum; `assessed_weight` then carries the
  // weight actually earned points, and each competency's share is renormalised
  // against it. Without this, a scenario that never lost a track would silently cost
  // the trainee the 5 points of `adaptation` for a loss that did not happen, and the
  // score would depend on the scenario as much as on the trainee.
  //
  // `weighted` is carried at full precision and rounded only once, at the sum.
  // Rounding each term to 2dp first let six perfect competencies total 100.01 — a
  // score that claims more than the rubric allows.
  const assessed = COMPETENCIES.filter((c) => (per_competency.get(c) ?? []).length > 0);
  const assessed_weight = assessed.reduce((acc, c) => acc + weightOf(rubric, c), 0);
  // The factor that puts a perfect run on a 100 scale when some weights are excluded.
  const renormalise = assessed_weight > 0 ? 100 / assessed_weight : 0;

  const competencies: CompetencyScore[] = COMPETENCIES.map((competency) => {
    const own = per_competency.get(competency) ?? [];
    const weight = weightOf(rubric, competency);
    const is_assessed = own.length > 0;
    const points =
      competency === "detection"
        ? aggregateDetection(own)
        : competency === "classification"
          ? aggregateClassification(own)
          : competency === "response"
            ? aggregateResponse(own)
            : competency === "reporting"
              ? aggregateReporting(own)
              : round2(own.reduce((acc, n) => acc + n.points, 0) / Math.max(1, own.length));

    return {
      competency,
      points: is_assessed ? points : 0,
      assessed: is_assessed,
      weight,
      weighted: is_assessed ? (points / 100) * weight * renormalise : 0,
      mandated: isMandated(rubric, competency),
      node_ids: own.map((n) => n.id),
    };
  });

  // --- critical errors -------------------------------------------------------
  const critical_errors: CriticalErrorResult[] = [
    ...criticalResults(findings, rubric, byTrack),
    ...collectCritical(facts, rubric),
  ];

  const penalty = critical_errors.reduce((acc, c) => acc + c.penalty, 0);
  const weighted_sum = competencies.reduce((acc, c) => acc + c.weighted, 0);
  const process_score = round2(clamp(weighted_sum, rubric.clamp.min, rubric.clamp.max));
  const total = round2(clamp(weighted_sum - penalty, rubric.clamp.min, rubric.clamp.max));

  return {
    scenario_id: input.scenario_id,
    seed: input.seed,
    rubric_id: rubric.id,
    rubric_version: rubric.version,
    process_score,
    mission_outcome: scoreOutcome(facts, input.expected.protect),
    total,
    competencies,
    critical_errors,
    nodes,
    reviews: buildReviews(facts, nodes),
    mandated: buildMandated(facts, nodes, critical_errors),
  };
};

/**
 * §10.6 decision labels: the trainee's process on a track, crossed with whether
 * the outcome there was good.
 *
 * A track with no declared outcome of its own (no impact, no effect resolved) is
 * labelled on process alone — inventing an outcome would be dishonest.
 */
const buildReviews = (facts: RunFacts, nodes: NodeResult[]): DecisionReview[] => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reviews: DecisionReview[] = [];

  for (const f of facts.tracks) {
    const process_nodes = [byId.get(`N3.${f.truth_id}`), byId.get(`N5.${f.truth_id}`), byId.get(`N7.${f.truth_id}`)]
      .filter((n): n is NodeResult => n !== undefined && n.max_points > 0);

    if (process_nodes.length === 0) continue;

    const process_fraction =
      process_nodes.reduce((acc, n) => acc + n.points / n.max_points, 0) / process_nodes.length;
    const good_process = process_fraction >= 0.6;

    // Per-track outcome. Only a response effect is attributable to one entity —
    // impacts name an asset, not a drone — so a neutralised contact is the only
    // per-track outcome signal the log actually carries. Anything else falls back
    // to "a non-hostile contact that did no harm went fine", which is a statement
    // about there being nothing to regret rather than a claimed success.
    const good_outcome =
      facts.neutralised.includes(f.truth_id) || f.entity.affiliation_truth !== "hostile";

    const label = good_process
      ? good_outcome
        ? "Good decision / Good outcome"
        : "Good decision / Bad outcome"
      : good_outcome
        ? "Poor process / Lucky outcome"
        : "Poor process / Bad outcome";

    const worst = process_nodes.reduce((a, b) => (b.points / b.max_points < a.points / a.max_points ? b : a));

    reviews.push({
      truth_id: f.truth_id,
      label,
      node_id: worst.id,
      reason: worst.reason,
      event_refs: worst.event_refs,
    });
  }

  return reviews;
};

/** Re-exported so the AAR can name the penalty without importing the rubric. */
export const penaltyOf = (r: Rubric, kind: Parameters<typeof criticalPenalty>[1]): number =>
  criticalPenalty(r, kind);