/**
 * Client-side view models.
 *
 * The server is the source of truth for shapes; these structural types
 * cover the parts of the API the client consumes. `ClientScenario` is
 * the scenario minus its answer key — the server strips `expected`
 * before sending (PRD §5.4), so the client type must not have it.
 */

import type { Role, SensorMode, Posture } from "@skysentinel/shared";
import type { BriefSection, Scenario } from "@skysentinel/scenario";
import type { ScoreResult } from "@skysentinel/scoring";
import type { AnySimEvent } from "@skysentinel/shared";

export type { AnySimEvent, Role };

/** Session lifecycle states (server `db/repo.ts`). */
export type SessionStatus = "created" | "running" | "paused" | "ended" | "scored";
export type SessionMode = "assessment" | "training";

export interface PublicUser {
  id: string;
  username: string;
  display_name: string | null;
  role: Role;
  unit_id: string | null;
}

export type ClientScenario = Omit<Scenario, "expected">;

export interface ScenarioSummary {
  id: string;
  kind: "scripted" | "generated";
  title: string;
  description: string | null;
  family: string | null;
  difficulty: number | null;
  seed: number | null;
  duration_s: number;
  fingerprint: string;
  learning_objectives: string[];
}

export interface SessionRecord {
  id: string;
  scenario_id: string;
  trainee_id: string;
  instructor_id: string | null;
  rubric_id: string;
  rubric_version: number;
  started_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  duration_ms: number | null;
  end_reason: string | null;
  mode: SessionMode;
}

export interface LaunchResult {
  session: SessionRecord;
  scenario: ClientScenario;
  brief_sections: BriefSection[];
}

/** Session sensors as the scenario defines them, plus runtime changes. */
export type SensorModes = Record<string, SensorMode>;

export interface PostureState {
  posture: Posture;
  granted: readonly string[];
  pending: readonly string[];
}

export interface ScorePayload {
  session_id: string;
  total: number;
  detection: number;
  classification: number;
  response: number;
  reporting: number;
  prioritisation: number;
  coordination: number;
  adaptation: number;
  critical_errors: number;
  result: ScoreResult;
}

export interface AnnotationRecord {
  id: string;
  session_id: string;
  t_ms: number;
  author_id: string;
  text: string;
  created_at: string;
}

export interface ProgressRun {
  session_id: string;
  scenario_id: string;
  mode: SessionMode;
  ended_at: string | null;
  total: number | null;
  critical_errors: number | null;
}

export interface ProgressSummary {
  runs: number;
  mean_total: number | null;
  best_total: number | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  user_id: string | null;
  action: string;
  detail_json: string;
}

export interface TruthEntityView {
  id: string;
  kind: string;
  pos: [number, number, number];
  vel: [number, number, number];
  affiliation_truth: string | null;
  intent: string | null;
  role?: string;
  group_id?: string;
  neutralised: boolean;
  landed: boolean;
}

export interface ReplayPayload {
  session: SessionRecord;
  events: AnySimEvent[];
  truth: TruthEntityView[];
  annotations: AnnotationRecord[];
  score: (ScorePayload & { total: number }) | null;
}

/** A trainee's classification state, derived client-side from the log. */
export interface ClassificationState {
  track_id: string;
  category: string;
  confidence: string;
  platform?: string;
  t_ms: number;
  is_reclassification: boolean;
}

/** Latest classification per track, plus the full history. */
export interface ClassificationLog {
  latest: Map<string, ClassificationState>;
  history: ClassificationState[];
}

export const emptyClassificationLog = (): ClassificationLog => ({
  latest: new Map(),
  history: [],
});

/** Fold classification events into a log. Pure — safe to re-run on every frame. */
export const foldClassifications = (
  events: readonly AnySimEvent[],
): ClassificationLog => {
  const log = emptyClassificationLog();
  for (const ev of events) {
    if (ev.type !== "classification_submitted") continue;
    const entry: ClassificationState = {
      track_id: ev.payload.track_id,
      category: ev.payload.category,
      confidence: ev.payload.confidence,
      ...(ev.payload.platform !== undefined ? { platform: ev.payload.platform } : {}),
      t_ms: ev.t_ms,
      is_reclassification: ev.payload.is_reclassification,
    };
    log.history.push(entry);
    log.latest.set(entry.track_id, entry);
  }
  return log;
};
