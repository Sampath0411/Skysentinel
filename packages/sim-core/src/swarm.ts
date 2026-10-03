/**
 * Swarm coordination (PRD §5.1 FR-SIM-6).
 *
 * A swarm is a group of entities sharing a `group_id` and a set of roles. Members
 * keep formation offsets relative to a group leader, so the group moves as one
 * shape rather than as unrelated tracks.
 *
 * Exactly one rule is reactive: a member whose group has been neutralised (or whose
 * leader is gone) breaks formation and retreats. This is deliberate. A simulation
 * that keeps flying after its members are engaged teaches the trainee nothing about
 * how a real group behaves, but a simulation with many reactive rules becomes hard
 * to reason about and hard to reproduce. One rule, one outcome, testable.
 */

import { SWARM_ROLES, type Millis, type Vec3 } from "@skysentinel/shared";

import type { Drone } from "./entities.js";
import type { Terrain } from "./terrain/index.js";

/**
 * How each role sits relative to the group centre, in metres.
 *
 * Formation is a fictional training abstraction: it gives the group a recognisable
 * shape on the plot without encoding any real-world tactics.
 */
export const FORMATION_OFFSETS: Record<string, { ahead: number; lateral: number; vertical: number }> = {
  main: { ahead: 0, lateral: 0, vertical: 0 },
  scout: { ahead: 120, lateral: 0, vertical: 30 },
  decoy: { ahead: 40, lateral: -120, vertical: 10 },
  follow_on: { ahead: -80, lateral: 60, vertical: 40 },
  unknown: { ahead: 0, lateral: 0, vertical: 0 },
};

export interface Swarm {
  group_id: string;
  member_ids: string[];
  /** Leader's id, or the first member if no explicit leader. */
  leader_id: string;
  /** Sim time the group was formed; drives the reactive rule's timing. */
  formed_at_ms: Millis;
  /** True once the reactive rule has fired. */
  broken: boolean;
}

/** Build the swarm membership from a set of entities sharing a group id. */
export const formSwarm = (groupId: string, members: Drone[], t_ms: Millis): Swarm => {
  // Stable ordering by id so the leader choice cannot vary between runs.
  const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // `main` is the group centre; the lowest id stands in when no member is marked.
  const leader = sorted.find((d) => d.role === "main") ?? sorted[0];
  if (!leader) throw new Error(`Cannot form swarm ${groupId}: no members`);

  return {
    group_id: groupId,
    member_ids: sorted.map((d) => d.id),
    leader_id: leader.id,
    formed_at_ms: t_ms,
    broken: false,
  };
};

/**
 * Formation offset for a member, rotated into the group's heading frame.
 *
 * Rotating by the leader's heading is what makes the group read as a group: the
 * offsets stay fixed in the group's frame as it turns, rather than staying pinned
 * to world north.
 */
export const offsetFor = (leader: Drone, member: Drone): Vec3 => {
  const base = FORMATION_OFFSETS[member.role ?? "unknown"] ?? FORMATION_OFFSETS.unknown!;
  const rad = (leader.heading_deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Heading 0 is north (+y). Rotating a forward/lateral offset into world space:
  const aheadX = base.ahead * sin;
  const aheadY = base.ahead * cos;
  return {
    x: aheadX + base.lateral * cos,
    y: aheadY - base.lateral * sin,
    z: base.vertical,
  };
};

/** Where a member should be, given where the leader is. */
export const formationTarget = (leader: Drone, member: Drone): Vec3 => {
  const o = offsetFor(leader, member);
  return {
    x: leader.pos.x + o.x,
    y: leader.pos.y + o.y,
    z: leader.pos.z + o.z,
  };
};

/**
 * The single reactive rule (FR-SIM-6).
 *
 * Fires when the leader is neutralised or no longer airborne, or when the group
 * has been under engagement for `BREAK_DELAY_MS`. Returns the ids of members
 * that should now retreat, and marks the swarm broken.
 */
export const BREAK_DELAY_MS = 4000;

export const applyReactiveRule = (
  swarm: Swarm,
  members: Map<string, Drone>,
  t_ms: Millis,
): string[] => {
  if (swarm.broken) return [];

  const leader = members.get(swarm.leader_id);
  const leaderGone = !leader || leader.neutralised === true || leader.landed === true;
  const elapsed = t_ms - swarm.formed_at_ms;

  if (!leaderGone && elapsed < BREAK_DELAY_MS) return [];

  swarm.broken = true;
  return swarm.member_ids.filter((id) => id !== swarm.leader_id && members.has(id));
};

/** Push every member's programme into a retreat, replacing whatever it was doing. */
export const orderRetreat = (members: Map<string, Drone>, ids: string[], terrain: Terrain): void => {
  for (const id of ids) {
    const m = members.get(id);
    if (!m) continue;

    // Retreat away from the group centre, toward open ground off the map edge.
    const r = Math.hypot(m.pos.x, m.pos.y) || 1;
    const away = {
      x: terrain.size * 0.8 * (m.pos.x / r),
      y: terrain.size * 0.8 * (m.pos.y / r),
      z: m.pos.z,
    };

    m.programme = [
      {
        state: "retreat",
        to: away,
        speed: (m.speed_mps || 12) * 1.2,
      },
      {
        state: "land",
        to: { x: away.x * 0.95, y: away.y * 0.95, z: terrain.obstructionAt(away.x, away.y) + 2 },
        speed: 8,
      },
    ];
    m.step_index = 0;
    m.behaviour_state = "retreat";
  }
};

/** Roles that must appear at most once per swarm, for the scenario validator. */
export const SINGLETON_ROLES: readonly string[] = ["main"];

/** True when the role string is one the swarm model understands. */
export const isSwarmRole = (v: string): boolean => (SWARM_ROLES as readonly string[]).includes(v);