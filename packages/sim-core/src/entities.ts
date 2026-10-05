/**
 * Entity model (PRD §5.1 FR-SIM-4).
 *
 * Entities carry ground truth (`affiliation_truth`, `intent`) that must never reach
 * a trainee client. Those fields are named to match `FORBIDDEN_TRAINEE_KEYS` in
 * `@skysentinel/shared`, so the view filter strips them structurally rather than
 * relying on each call site to remember.
 *
 * Positions are metres on a local ENU plane (x east, y north, z up).
 */

import {
  vec3,
  type Affiliation,
  type Archetype,
  type BehaviourState,
  type EntityKind,
  type Millis,
  type Vec3,
  type SwarmRole,
} from "@skysentinel/shared";

export type { EntityKind } from "@skysentinel/shared";

/** One step of a scripted or generated behaviour programme. */
export interface BehaviourStep {
  state: BehaviourState;
  /** Waypoint for transit/approach/retreat/land. */
  to?: Vec3;
  /** Cruise speed for this step, m/s. */
  speed?: number;
  /** Orbit centre and radius for orbit_loiter. */
  center?: Vec3;
  radius?: number;
  /** Duration for timed states (orbit_loiter, decoy_hover, popup). */
  duration_s?: number;
  /** Climb altitude for popup. */
  alt?: number;
}

export interface Drone {
  kind: "drone";
  id: string;
  archetype: Archetype;
  /** TRUTH: never sent to a trainee view. */
  affiliation_truth: Affiliation;
  /** TRUTH: never sent to a trainee view. */
  intent: string;
  /** TRUTH: swarm membership and role. */
  role?: SwarmRole;
  /** TRUTH: swarm group id. */
  group_id?: string;
  /** Flight-plan reference for friendly/civil entities. */
  flight_ref?: string;

  pos: Vec3;
  vel: Vec3;
  /** Heading in degrees, derived from velocity each tick. */
  heading_deg: number;
  speed_mps: number;

  behaviour_state: BehaviourState;
  /** Index into the behaviour programme. */
  step_index: number;
  /** Sim time the current step began; timed steps measure their duration from here. */
  step_started_ms: Millis;
  /** Sim time at which the entity becomes active. */
  spawn_t_ms: Millis;
  /** Behaviour programme. Empty means "hold position". */
  programme: BehaviourStep[];

  /** Does the entity radiate an RF cue? Only meaningful for rf_emitting drones. */
  rf_emitting: boolean;
  /** Sim time at which this entity was first spawned, for stable ordering. */
  spawned_seq: number;
  /** Set when the entity has impacted an asset and is no longer airborne. */
  neutralised?: boolean;
  landed?: boolean;
}

export interface BirdFlock {
  kind: "bird";
  id: string;
  archetype: "bird_flock";
  affiliation_truth: "non_uas";
  intent: "none";
  pos: Vec3;
  vel: Vec3;
  heading_deg: number;
  speed_mps: number;
  behaviour_state: BehaviourState;
  step_index: number;
  step_started_ms: Millis;
  spawn_t_ms: Millis;
  programme: BehaviourStep[];
  /** How many individual birds the flock represents. */
  count: number;
  rf_emitting: false;
  spawned_seq: number;
}

export interface ProtectedAsset {
  kind: "protected_asset";
  id: string;
  name: string;
  /** Fictional asset category (fuel, command_post, …). */
  type: string;
  pos: Vec3;
  /** Lower number = higher priority. */
  priority: number;
  /** Distance at which an attacking drone causes damage. */
  impact_radius_m: number;
  /** Remaining integrity, 0..1. */
  integrity: number;
  spawned_seq: number;
}

export interface FriendlyPosition {
  kind: "friendly_position";
  id: string;
  label: string;
  pos: Vec3;
  spawned_seq: number;
}

export type Entity = Drone | BirdFlock | ProtectedAsset | FriendlyPosition;

/** True for the entity kinds that move and can be sensed. */
export const isAirborne = (e: Entity): e is Drone | BirdFlock =>
  e.kind === "drone" || e.kind === "bird";

/** Entities the sensors should look for (not assets or friendly markers). */
export const isTrackable = (e: Entity): e is Drone | BirdFlock => isAirborne(e);

/**
 * Projection of an entity for a trainee view.
 *
 * Truth fields are dropped here rather than at the transport layer, so there is one
 * place to audit. `truth_ref` is intentionally absent: a track carries it internally
 * for scoring, but it is never part of a client-facing entity projection.
 */
export interface TraineeEntityView {
  id: string;
  kind: EntityKind;
  /** Estimated position; identical to truth here, since position is knowable. */
  pos: Vec3;
  speed_mps: number;
  heading_deg: number;
  /** Only present for assets. */
  name?: string;
  priority?: number;
  integrity?: number;
  impact_radius_m?: number;
}

export const toTraineeView = (e: Entity): TraineeEntityView => {
  if (e.kind === "protected_asset") {
    return {
      id: e.id,
      kind: e.kind,
      pos: e.pos,
      speed_mps: 0,
      heading_deg: 0,
      name: e.name,
      priority: e.priority,
      integrity: e.integrity,
      impact_radius_m: e.impact_radius_m,
    };
  }
  if (e.kind === "friendly_position") {
    return { id: e.id, kind: e.kind, pos: e.pos, speed_mps: 0, heading_deg: 0 };
  }
  return {
    id: e.id,
    kind: e.kind,
    pos: e.pos,
    speed_mps: e.speed_mps,
    heading_deg: e.heading_deg,
  };
};

/** Build a drone at a spawn point. Truth fields are set by the caller/scenario. */
export const createDrone = (params: {
  id: string;
  archetype: Archetype;
  affiliation_truth: Affiliation;
  intent: string;
  pos: Vec3;
  spawn_t_ms: Millis;
  speed_mps: number;
  programme: BehaviourStep[];
  rf_emitting: boolean;
  spawned_seq: number;
  role?: SwarmRole;
  group_id?: string;
  flight_ref?: string;
}): Drone => ({
  kind: "drone",
  id: params.id,
  archetype: params.archetype,
  affiliation_truth: params.affiliation_truth,
  intent: params.intent,
  pos: { ...params.pos },
  vel: vec3(0, 0, 0),
  heading_deg: 0,
  speed_mps: params.speed_mps,
  behaviour_state: params.programme[0]?.state ?? "transit",
  step_index: 0,
  step_started_ms: params.spawn_t_ms,
  spawn_t_ms: params.spawn_t_ms,
  programme: params.programme,
  rf_emitting: params.rf_emitting,
  spawned_seq: params.spawned_seq,
  ...(params.role !== undefined ? { role: params.role } : {}),
  ...(params.group_id !== undefined ? { group_id: params.group_id } : {}),
  ...(params.flight_ref !== undefined ? { flight_ref: params.flight_ref } : {}),
});

export const createBirdFlock = (params: {
  id: string;
  pos: Vec3;
  spawn_t_ms: Millis;
  speed_mps: number;
  programme: BehaviourStep[];
  count: number;
  spawned_seq: number;
}): BirdFlock => ({
  kind: "bird",
  id: params.id,
  archetype: "bird_flock",
  affiliation_truth: "non_uas",
  intent: "none",
  pos: { ...params.pos },
  vel: vec3(0, 0, 0),
  heading_deg: 0,
  speed_mps: params.speed_mps,
  behaviour_state: params.programme[0]?.state ?? "transit",
  step_index: 0,
  step_started_ms: params.spawn_t_ms,
  spawn_t_ms: params.spawn_t_ms,
  programme: params.programme,
  count: params.count,
  rf_emitting: false,
  spawned_seq: params.spawned_seq,
});

export const createAsset = (params: {
  id: string;
  name: string;
  type: string;
  pos: Vec3;
  priority: number;
  impact_radius_m: number;
  spawned_seq: number;
}): ProtectedAsset => ({
  kind: "protected_asset",
  id: params.id,
  name: params.name,
  type: params.type,
  pos: { ...params.pos },
  priority: params.priority,
  impact_radius_m: params.impact_radius_m,
  integrity: 1,
  spawned_seq: params.spawned_seq,
});

export const createFriendlyPosition = (params: {
  id: string;
  label: string;
  pos: Vec3;
  spawned_seq: number;
}): FriendlyPosition => ({
  kind: "friendly_position",
  id: params.id,
  label: params.label,
  pos: { ...params.pos },
  spawned_seq: params.spawned_seq,
});