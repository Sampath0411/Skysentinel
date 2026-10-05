/**
 * `@skysentinel/scoring` — the deterministic score for one run (PRD §10).
 *
 * Pure TypeScript: no DOM, no fs, no network, no wall clock, no randomness. Given
 * the same `ScoreInput` it returns the same `ScoreResult`, and given the same
 * `ScoreResult` the same coach text (FR-SIM-1).
 *
 * Ground truth reaches this package and only this package. A run's score cannot be
 * computed from the event log alone — the caller must also supply the correlation
 * and truth maps, which the server holds and the trainee client never receives
 * (PRD §4, §6.4).
 */

export * from "./types.js";
export * from "./rubric.js";
export { readRun } from "./log.js";
export type { RunFacts, TrackFacts, ReportFact, PositionFact } from "./log.js";
export { scoreRun, penaltyOf } from "./score.js";
export type { ScoreOptions } from "./score.js";
export { buildMandated, detectionSummary, classificationSummary, responseSummary } from "./mandated.js";
export { scoreOutcome } from "./outcome.js";

export { scoreCuePresented, scoreDetection, aggregateDetection } from "./nodes/detection.js";
export { scoreClassification, aggregateClassification } from "./nodes/classification.js";
export { scoreReporting, aggregateReporting } from "./nodes/reporting.js";
export { scoreResponse, aggregateResponse, isAllowed, truthBand } from "./nodes/response.js";
export {
  scoreBriefConsulted,
  scoreCoordination,
  coordinationCeiling,
  scorePrioritisation,
  scoreRecovery,
  collectCritical,
} from "./nodes/coordination.js";

export {
  bandOf,
  bandFor,
  coachBrief,
  competencyComments,
  criticalComments,
  headline,
  reviewComments,
  weakestNodes,
} from "./coach.js";
export type { Band } from "./coach.js";

export const PACKAGE_NAME = "@skysentinel/scoring" as const;