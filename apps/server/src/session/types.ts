/**
 * Session-layer types shared between the service, the routes and the WS layer.
 */

import type { Scenario } from "@skysentinel/scenario";
import type { Affiliation, EntityKind, SwarmRole } from "@skysentinel/shared";

export interface LiveSessionOptions {
  /** Supplied when resuming a persisted session; generated otherwise. */
  id?: string;
  scenario: Scenario;
  trainee_id: string;
  instructor_id?: string;
  mode: "assessment" | "training";
  rubric_id: string;
  rubric_version: number;
  /** Wall-clock ms at construction. Seeded rather than read so tests control it. */
  now: number;
  created_at: string;
}

/**
 * One ground-truth entity, as the instructor's truth map consumes it.
 *
 * Carries no track or cue correlation: the instructor sees where things *are*, and
 * which track the trainee built from them is the instructor's judgement to make,
 * not the server's.
 */
export interface TruthEntityView {
  id: string;
  kind: EntityKind;
  pos: [number, number, number];
  vel: [number, number, number];
  affiliation_truth: Affiliation | null;
  intent: string | null;
  role?: SwarmRole;
  group_id?: string;
  neutralised: boolean;
  landed: boolean;
}
