/**
 * Scoring result types (PRD §10.1).
 *
 * A `ScoreResult` is the AAR's data, not the AAR's rendering. Everything the
 * dashboard shows — the tree, the two headline numbers, the critical errors — is
 * read off this structure, so it has to be self-explaining: a reviewer with no
 * access to the rubric and no access to the event log should still be able to see
 * why a score came out as it did.
 *
 * Three properties are enforced by `packages/scoring/src/score.test.ts` (PRD §10.7):
 *
 *   1. Every node with `points !== 0` has a non-empty `reason` and at least one
 *      `event_ref`, so a score can always be traced back to the log.
 *   2. Every `event_ref` is a real `seq` from the run.
 *   3. Scores are in `[0, 100]` and adding a critical error never raises the total.
 */

import type {
  Affiliation,
  AnySimEvent,
} from "@skysentinel/shared";
import type { ExpectedBlock } from "@skysentinel/scenario";

import type { Competency, CriticalError } from "./generated/rubric.js";

/** A reference to an event by its `seq`, which is monotonic and gap-free (FR-SIM-10). */
export type EventRef = number;

/** One decision in the PRD §10.3 tree, or one aggregate under it. */
export interface NodeResult {
  /** Stable id, e.g. `N3` or `N5.det.hostile-1`. Used by tests and the AAR tree. */
  id: string;
  /** Human-readable label for the AAR. */
  label: string;
  passed: boolean;
  points: number;
  max_points: number;
  /** Why this score. Non-empty whenever `points !== 0` (PRD §10.7). */
  reason: string;
  /** `seq` values in the source log. Non-empty whenever `points !== 0`. */
  event_refs: EventRef[];
}

export interface CompetencyScore {
  competency: Competency;
  /**
   * Points earned, 0..100 within the competency.
   *
   * When `assessed` is false this reads 0 and means "not measured", not "scored
   * zero" — the run never exercised the dimension. The AAR must read `assessed`
   * rather than rendering the number, or it will tell a trainee they failed a
   * dimension nothing tested.
   */
  points: number;
  /**
   * Did this run exercise the competency at all?
   *
   * False when every node the tree emitted for it was zero-max — nothing was lost
   * to recover from, only one contact needed attention, so there was nothing to
   * prioritise. Unassessed competencies are excluded from the weighted sum and the
   * remaining weights are renormalised, so a dimension the scenario did not test
   * neither penalises the trainee nor inflates the score.
   */
  assessed: boolean;
  weight: number;
  /**
   * Contribution to `process_score`, after renormalising over assessed weights.
   *
   * Carried at full precision rather than rounded: rounding each term and then
   * summing let a perfect run total 100.01. `process_score` rounds once, at the end.
   */
  weighted: number;
  /** True when PRD §10.2 marks this dimension mandated by the PS. */
  mandated: boolean;
  /** The nodes that produced this competency, for the AAR drill-down. */
  node_ids: string[];
}

export interface CriticalErrorResult {
  kind: CriticalError;
  penalty: number;
  reason: string;
  event_refs: EventRef[];
  /** Which truth entity triggered it, when attributable. */
  truth_id?: string;
}

/** §10.6 mission outcome — what happened, independent of how well it was handled. */
export interface MissionOutcome {
  /** 0..100. Higher is better. */
  score: number;
  asset_integrity: number;
  assets_lost: number;
  threats_neutralised: number;
  threats_engaged: number;
  /** Number of simulated impacts that reached a protected asset. */
  impacts: number;
}

export type DecisionLabel =
  | "Good decision / Good outcome"
  | "Good decision / Bad outcome"
  | "Poor process / Lucky outcome"
  | "Poor process / Bad outcome";

/** One AAR decision label (PRD §10.6): a process verdict crossed with the outcome. */
export interface DecisionReview {
  truth_id: string;
  label: DecisionLabel;
  /** The node that judged this track's process. */
  node_id: string;
  reason: string;
  event_refs: EventRef[];
}

export interface ScoreResult {
  scenario_id: string;
  seed: number;
  rubric_id: string;
  rubric_version: number;

  /** PRD §10.6 — the tree. This is what `sim:run`'s ordering check compares. */
  process_score: number;
  /** PRD §10.6 — asset integrity, neutralisations, impacts. */
  mission_outcome: MissionOutcome;
  /** Clamped to the rubric's `clamp` range. */
  total: number;

  competencies: CompetencyScore[];
  critical_errors: CriticalErrorResult[];
  /** The whole tree, flat with dotted ids so it can be rebuilt hierarchically. */
  nodes: NodeResult[];

  /** Per-track AAR verdicts, cross-referencing process against outcome. */
  reviews: DecisionReview[];
}

/**
 * Track↔truth correlation.
 *
 * Deliberately a separate input rather than extra fields on the event log. The log
 * is what a trainee client receives, and it must never carry ground truth
 * (PRD §4, §6.4) — so the scorer is handed the correlation explicitly by whoever
 * holds the truth, and a log alone is not a sufficient input to score a run.
 * `session.cues()` and `session.tracks()` supply both maps (DECISIONS.md D20).
 */
export interface Correlation {
  /** cue id → truth entity id. */
  cue_truth: ReadonlyMap<string, string>;
  /** track id → truth entity id. `null` for a track that is clutter or unattributed. */
  track_truth: ReadonlyMap<string, string | null>;
}

/** Everything the scorer needs for one run. Pure data — no I/O, no clock. */
export interface ScoreInput {
  scenario_id: string;
  seed: number;
  duration_ms: number;
  events: readonly AnySimEvent[];
  /** The scenario's `expected` block: authored ground truth for scoring. */
  expected: ExpectedBlock;
  correlation: Correlation;
  /** Ground truth per entity id, from `entity_spawned` events. */
  truth: ReadonlyMap<string, TruthEntity>;
}

export interface TruthEntity {
  id: string;
  affiliation_truth: Affiliation;
  intent: string;
  group_id?: string;
}

/** Signature used across the tree modules. */
export type NodeSink = (node: NodeResult) => void;