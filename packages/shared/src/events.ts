/**
 * Event catalogue (PRD §7.3).
 *
 * The simulation is event-sourced (FR-SIM-10): every state change and trainee action
 * appends an immutable, timestamped event. `seq` is monotonic within a session.
 *
 * Two invariants this module exists to protect:
 *  1. Truth-bearing payloads are marked `visibility: "instructor"` so the server can
 *     strip them from trainee views (PRD §6.4). The leak test in PRD §18.6 scans
 *     every trainee payload for forbidden keys; the types below make that structural.
 *  2. Events carry no wall-clock time — only integer sim `t_ms` (DECISIONS.md D5), so
 *     a replay of the same seed produces a byte-identical log.
 */

import { z } from "zod";

import {
  AffiliationSchema,
  BehaviourStateSchema,
  ClassificationCategorySchema,
  ConfidenceSchema,
  PostureSchema,
  ResponseActionSchema,
  SensorIdSchema,
  SensorModeSchema,
  SwarmRoleSchema,
} from "./vocabulary.js";
import type { Millis } from "./units.js";
import type { Visibility } from "./vocabulary.js";

export const TrackStatusSchema = z.enum(["new", "confirmed", "lost", "reacquired"]);
export type TrackStatus = z.infer<typeof TrackStatusSchema>;

export const EVENT_TYPES = [
  "session_started",
  "session_ended",
  "brief_viewed",
  "entity_spawned",
  "entity_state",
  "sensor_observation",
  "cue_presented",
  "track_update",
  "contact_marked",
  "classification_submitted",
  "report_sent",
  "report_acked",
  "action_taken",
  "authority_requested",
  "authority_resolved",
  "response_effect_resolved",
  "impact",
  "sensor_state_changed",
  "inject_applied",
  "track_lost",
  "track_reacquired",
  "support_cue_shown",
  "annotation_added",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

// --- payload schemas -------------------------------------------------------
// Grouped to mirror PRD §7.3's table. Each is validated at the emit site so a
// malformed payload fails loudly rather than poisoning the replay log.

export const SessionStartedSchema = z.object({
  scenario_id: z.string(),
  seed: z.number().int(),
  end_reason: z.string().optional(),
});
export type SessionStartedPayload = z.infer<typeof SessionStartedSchema>;

export const SessionEndedSchema = z.object({
  scenario_id: z.string(),
  seed: z.number().int(),
  end_reason: z.string(),
});
export type SessionEndedPayload = z.infer<typeof SessionEndedSchema>;

export const BriefViewedSchema = z.object({
  sections_viewed: z.array(z.string()),
});
export type BriefViewedPayload = z.infer<typeof BriefViewedSchema>;

/** TRUTH: instructor-only. Carries affiliation and intent. */
export const EntitySpawnedSchema = z.object({
  id: z.string(),
  archetype: z.string(),
  affiliation_truth: AffiliationSchema,
  intent: z.string(),
  role: SwarmRoleSchema.optional(),
  group_id: z.string().optional(),
});
export type EntitySpawnedPayload = z.infer<typeof EntitySpawnedSchema>;

/** TRUTH: instructor-only. Sampled at 1 Hz, not per tick, to bound log size. */
export const EntityStateSchema = z.object({
  id: z.string(),
  pos: z.tuple([z.number(), z.number(), z.number()]),
  vel: z.tuple([z.number(), z.number(), z.number()]),
  behaviour_state: BehaviourStateSchema,
});
export type EntityStatePayload = z.infer<typeof EntityStateSchema>;

/**
 * A sensor observation presented to the trainee. `truth_ref` is present internally
 * for scoring correlation but MUST be stripped from any trainee-facing view.
 */
export const SensorObservationSchema = z.object({
  sensor: SensorIdSchema,
  obs_id: z.string(),
  truth_ref: z.string().optional(),
  bearing_deg: z.number(),
  range_m: z.number(),
  alt_m: z.number(),
  conf: z.number(),
  is_false: z.boolean(),
  shape: z.string().optional(),
});
export type SensorObservationPayload = z.infer<typeof SensorObservationSchema>;

export const CuePresentedSchema = z.object({
  cue_id: z.string(),
  sensor: SensorIdSchema,
  track_id: z.string().optional(),
  /** True the first time this truth entity produced any cue for this trainee. */
  first_for_truth: z.boolean(),
});
export type CuePresentedPayload = z.infer<typeof CuePresentedSchema>;

export const TrackUpdateSchema = z.object({
  track_id: z.string(),
  sources: z.array(SensorIdSchema),
  conf: z.number(),
  status: TrackStatusSchema,
  pos_est: z.tuple([z.number(), z.number(), z.number()]),
});
export type TrackUpdatePayload = z.infer<typeof TrackUpdateSchema>;

export const ContactMarkedSchema = z.object({
  cue_or_track_id: z.string(),
  linked_truth_id: z.string().optional(),
});
export type ContactMarkedPayload = z.infer<typeof ContactMarkedSchema>;

export const ClassificationSubmittedSchema = z.object({
  track_id: z.string(),
  category: ClassificationCategorySchema,
  confidence: ConfidenceSchema,
  platform: z.string().optional(),
  evidence: z.array(z.string()),
  is_reclassification: z.boolean(),
});
export type ClassificationSubmittedPayload = z.infer<typeof ClassificationSubmittedSchema>;

/** Report form fields are configurable doctrine-style data (PRD §1.4), not code. */
export const ReportFieldsSchema = z.object({
  quantity: z.number().optional(),
  activity: z.string().optional(),
  bearing_deg: z.number().optional(),
  range_m: z.number().optional(),
  pos: z.tuple([z.number(), z.number()]).optional(),
  time_s: z.number().optional(),
  description: z.string().optional(),
  equipment: z.string().optional(),
  confidence: ConfidenceSchema.optional(),
});
export type ReportFields = z.infer<typeof ReportFieldsSchema>;

export const ReportSentSchema = z.object({
  fields: ReportFieldsSchema,
  linked_track_id: z.string().optional(),
  delay_ms: z.number(),
});
export type ReportSentPayload = z.infer<typeof ReportSentSchema>;

export const ReportAckedSchema = z.object({
  fields: ReportFieldsSchema,
  linked_track_id: z.string().optional(),
  delay_ms: z.number(),
});
export type ReportAckedPayload = z.infer<typeof ReportAckedSchema>;

export const ActionTakenSchema = z.object({
  action: ResponseActionSchema,
  target_track_id: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ActionTakenPayload = z.infer<typeof ActionTakenSchema>;

export const AuthorityRequestedSchema = z.object({
  track_id: z.string(),
  posture: PostureSchema,
});
export type AuthorityRequestedPayload = z.infer<typeof AuthorityRequestedSchema>;

export const AuthorityResolvedSchema = z.object({
  track_id: z.string(),
  granted: z.boolean(),
  reason: z.string(),
});
export type AuthorityResolvedPayload = z.infer<typeof AuthorityResolvedSchema>;

/**
 * A simulated response effect resolving (FR-SIM-8).
 * Purely policy-level: resolution is a seeded probability with no operational detail.
 */
export const ResponseEffectResolvedSchema = z.object({
  track_id: z.string(),
  truth_id: z.string(),
  outcome: z.enum(["neutralised", "miss", "fratricide"]),
});
export type ResponseEffectResolvedPayload = z.infer<typeof ResponseEffectResolvedSchema>;

export const ImpactSchema = z.object({
  asset_id: z.string(),
  damage: z.number(),
});
export type ImpactPayload = z.infer<typeof ImpactSchema>;

export const SensorStateChangedSchema = z.object({
  sensor: SensorIdSchema,
  mode: SensorModeSchema,
});
export type SensorStateChangedPayload = z.infer<typeof SensorStateChangedSchema>;

export const InjectAppliedSchema = z.object({
  inject_type: z.string(),
  params: z.record(z.string(), z.unknown()),
  by: z.string(),
});
export type InjectAppliedPayload = z.infer<typeof InjectAppliedSchema>;

export const TrackLostSchema = z.object({ track_id: z.string() });
export type TrackLostPayload = z.infer<typeof TrackLostSchema>;

export const TrackReacquiredSchema = z.object({ track_id: z.string() });
export type TrackReacquiredPayload = z.infer<typeof TrackReacquiredSchema>;

export const SupportCueShownSchema = z.object({
  track_id: z.string(),
  text: z.string(),
  p: z.number(),
});
export type SupportCueShownPayload = z.infer<typeof SupportCueShownSchema>;

export const AnnotationAddedSchema = z.object({ text: z.string() });
export type AnnotationAddedPayload = z.infer<typeof AnnotationAddedSchema>;

// --- the event envelope ----------------------------------------------------

/**
 * The single envelope every event uses. Payload is a discriminated union keyed by
 * `type`, so a consumer can narrow without casting.
 */
export interface SimEventMap {
  session_started: SessionStartedPayload;
  session_ended: SessionEndedPayload;
  brief_viewed: BriefViewedPayload;
  entity_spawned: EntitySpawnedPayload;
  entity_state: EntityStatePayload;
  sensor_observation: SensorObservationPayload;
  cue_presented: CuePresentedPayload;
  track_update: TrackUpdatePayload;
  contact_marked: ContactMarkedPayload;
  classification_submitted: ClassificationSubmittedPayload;
  report_sent: ReportSentPayload;
  report_acked: ReportAckedPayload;
  action_taken: ActionTakenPayload;
  authority_requested: AuthorityRequestedPayload;
  authority_resolved: AuthorityResolvedPayload;
  response_effect_resolved: ResponseEffectResolvedPayload;
  impact: ImpactPayload;
  sensor_state_changed: SensorStateChangedPayload;
  inject_applied: InjectAppliedPayload;
  track_lost: TrackLostPayload;
  track_reacquired: TrackReacquiredPayload;
  support_cue_shown: SupportCueShownPayload;
  annotation_added: AnnotationAddedPayload;
}

export type EventOf<T extends EventType> = {
  seq: number;
  t_ms: Millis;
  type: T;
  actor: string;
  visibility: Visibility;
  payload: SimEventMap[T];
};

export type AnySimEvent = {
  [K in EventType]: EventOf<K>;
}[EventType];

/**
 * Default visibility per event type. Truth-bearing types default to `instructor`
 * so an emitter that forgets to pass visibility still cannot leak truth.
 */
export const DEFAULT_VISIBILITY: Record<EventType, Visibility> = {
  session_started: "all",
  session_ended: "all",
  brief_viewed: "instructor",
  entity_spawned: "instructor",
  entity_state: "instructor",
  sensor_observation: "trainee",
  cue_presented: "trainee",
  track_update: "trainee",
  contact_marked: "trainee",
  classification_submitted: "trainee",
  report_sent: "trainee",
  report_acked: "trainee",
  action_taken: "trainee",
  authority_requested: "trainee",
  authority_resolved: "trainee",
  response_effect_resolved: "trainee",
  impact: "all",
  sensor_state_changed: "all",
  inject_applied: "instructor",
  track_lost: "trainee",
  track_reacquired: "trainee",
  support_cue_shown: "trainee",
  annotation_added: "instructor",
};

/**
 * Event types that carry ground truth. The server must never forward these to a
 * trainee client, and the AAR leak test (PRD §18.6) asserts they never appear.
 */
export const TRUTH_BEARING_EVENT_TYPES: readonly EventType[] = [
  "entity_spawned",
  "entity_state",
];

/** Payload keys that must never reach a trainee view (PRD §18.6). */
export const FORBIDDEN_TRAINEE_KEYS: readonly string[] = [
  "truth_ref",
  "affiliation_truth",
  "intent",
  "linked_truth_id",
  "truth_id",
  "group_id",
];

export const isEventType = (v: string): v is EventType =>
  (EVENT_TYPES as readonly string[]).includes(v);