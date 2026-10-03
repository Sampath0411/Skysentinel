/**
 * Drone behaviour state machines (PRD §5.1 FR-SIM-5).
 *
 * Implements the eight states: transit, orbit_loiter, approach_direct,
 * terrain_masked_approach, popup, decoy_hover, retreat, land.
 *
 * Each entity walks a programme of steps, advancing when its current step's exit
 * condition is met. Motion is pure kinematics against the terrain — no steering,
 * no avoidance — which keeps behaviour reproducible and makes each state's
 * transition condition testable in isolation.
 */

import { bearingDeg, type BehaviourState, type Millis, type Vec3 } from "@skysentinel/shared";

import type { BehaviourStep, Drone } from "./entities.js";
import type { Rng } from "./rng.js";
import { clampToMap, type Terrain } from "./terrain/index.js";

/** Minimum ground clearance an airborne entity keeps, in metres. */
export const MIN_CLEARANCE_M = 15;

export interface BehaviourContext {
  terrain: Terrain;
  /** Deterministic per-run randomness, from the motion stream. */
  rng: Rng;
  /** Assets the entity may be approaching, used by approach states. */
  assetPositions: Vec3[];
  dt_s: number;
  /** Current sim time. */
  t_ms: Millis;
}

/** Does the step change when its exit condition is met? */
export interface StepOutcome {
  /** True when the entity should move on to the next step. */
  advance: boolean;
  /** Why, for the event log and for tests. */
  reason: "arrived" | "elapsed" | "final" | "held";
}

const stepOf = (e: Drone): BehaviourStep | undefined => e.programme[e.step_index];

/** Clamp a position to the map and above local ground clearance. */
const applyTerrainFloor = (terrain: Terrain, pos: Vec3): Vec3 => {
  const clamped = clampToMap(terrain, pos.x, pos.y);
  const ground = terrain.obstructionAt(clamped.x, clamped.y);
  const z = Math.max(pos.z, ground + MIN_CLEARANCE_M);
  return { x: clamped.x, y: clamped.y, z };
};

/** Move toward a point at `speed`, returning the new position and whether it arrived. */
const stepToward = (from: Vec3, to: Vec3, speed: number, dt_s: number): { pos: Vec3; arrived: boolean } => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const total = Math.hypot(dx, dy, dz);
  const stepDist = speed * dt_s;

  if (total <= stepDist || total < 1e-6) return { pos: { ...to }, arrived: true };

  return {
    pos: {
      x: from.x + (dx / total) * stepDist,
      y: from.y + (dy / total) * stepDist,
      z: from.z + (dz / total) * stepDist,
    },
    arrived: false,
  };
};

/**
 * Advance one entity by one tick.
 *
 * Mutates the entity in place. Returns the outcome so callers can detect a state
 * change and emit an `entity_state` event.
 */
export const stepEntity = (e: Drone, ctx: BehaviourContext): StepOutcome => {
  const step = stepOf(e);
  if (!step) {
    // No programme: hold position.
    e.vel = { x: 0, y: 0, z: 0 };
    return { advance: false, reason: "final" };
  }

  const speed = step.speed ?? e.speed_mps;
  let outcome: StepOutcome = { advance: false, reason: "held" };
  let nextPos = e.pos;

  switch (step.state) {
    case "transit":
    case "approach_direct":
    case "retreat":
    case "land": {
      const to = step.to ?? e.pos;
      const r = stepToward(e.pos, to, step.state === "land" ? speed * 0.4 : speed, ctx.dt_s);
      nextPos = r.pos;
      outcome = r.arrived
        ? { advance: true, reason: "arrived" }
        : { advance: false, reason: "held" };
      if (step.state === "land" && r.arrived) e.landed = true;
      break;
    }

    case "orbit_loiter": {
      // Circle a centre at `radius`, holding altitude.
      const center = step.center ?? e.pos;
      const radius = step.radius ?? 50;
      // Advance the angle at a rate that keeps the tangential speed ≈ speed.
      const rate = radius > 1 ? speed / radius : 0;
      const angle = Math.atan2(e.pos.y - center.y, e.pos.x - center.x) + rate * ctx.dt_s;
      nextPos = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
        z: step.to?.z ?? e.pos.z,
      };
      outcome = step.duration_s !== undefined
        ? elapsedOrAdvance(e, step, ctx)
        : { advance: false, reason: "held" };
      break;
    }

    case "decoy_hover": {
      // Hang near a point with small jitter, to look like a stationary decoy.
      const center = step.center ?? e.pos;
      const jitter = step.radius ?? 8;
      const wobble = Math.sin(ctx.t_ms / 1000) * jitter;
      nextPos = {
        x: center.x + wobble,
        y: center.y + wobble * 0.5,
        z: (step.alt ?? center.z) + wobble * 0.2,
      };
      outcome = step.duration_s !== undefined
        ? elapsedOrAdvance(e, step, ctx)
        : { advance: false, reason: "held" };
      break;
    }

    case "popup": {
      // Climb to an altitude, then hold. Used for a reveal from behind terrain.
      const targetAlt = step.alt ?? e.pos.z + 50;
      if (e.pos.z < targetAlt - 1) {
        nextPos = { ...e.pos, z: Math.min(targetAlt, e.pos.z + speed * ctx.dt_s) };
        outcome = { advance: false, reason: "held" };
      } else {
        nextPos = { ...e.pos, z: targetAlt };
        outcome = { advance: true, reason: "arrived" };
      }
      break;
    }

    case "terrain_masked_approach": {
      // Close on the nearest asset while staying low enough to be masked.
      const to = step.to ?? nearest(e, ctx.assetPositions) ?? e.pos;
      // Hold a low altitude: enough clearance to fly, low enough to be masked.
      const lowTarget = Math.min(to.z, ctx.terrain.obstructionAt(e.pos.x, e.pos.y) + 40);
      const target = { x: to.x, y: to.y, z: lowTarget };
      const r = stepToward(e.pos, target, speed, ctx.dt_s);
      nextPos = r.pos;
      outcome = r.arrived ? { advance: true, reason: "arrived" } : { advance: false, reason: "held" };
      break;
    }

    default: {
      // Unreachable for a validated programme; hold rather than crash the sim.
      outcome = { advance: false, reason: "held" };
      break;
    }
  }

  const before = e.pos;
  const floored = applyTerrainFloor(ctx.terrain, nextPos);

  e.pos = floored;
  const moved = Math.hypot(floored.x - before.x, floored.y - before.y, floored.z - before.z);
  e.speed_mps = ctx.dt_s > 0 ? moved / ctx.dt_s : 0;
  e.vel = {
    x: ctx.dt_s > 0 ? (floored.x - before.x) / ctx.dt_s : 0,
    y: ctx.dt_s > 0 ? (floored.y - before.y) / ctx.dt_s : 0,
    z: ctx.dt_s > 0 ? (floored.z - before.z) / ctx.dt_s : 0,
  };
  if (Math.hypot(e.vel.x, e.vel.y) > 1e-3) e.heading_deg = bearingDeg(before, floored);

  if (outcome.advance && e.step_index < e.programme.length - 1) {
    e.step_index += 1;
    // A timed step measures from when it began, so reset the clock on entry.
    e.step_started_ms = ctx.t_ms;
    const s = stepOf(e);
    if (s) e.behaviour_state = s.state;
  } else if (outcome.advance) {
    // Last step reached: stay in it.
    outcome = { advance: true, reason: "final" };
  }

  return outcome;
};

/**
 * Time-based step exit. Uses the step's own duration measured from the moment the
 * step began, tracked by comparing the elapsed sim time against when the step
 * started. `enterStepAt` is set on the entity by `startStep`.
 */
const elapsedOrAdvance = (e: Drone, step: BehaviourStep, ctx: BehaviourContext): StepOutcome => {
  const elapsed_s = (ctx.t_ms - e.step_started_ms) / 1000;
  return elapsed_s >= (step.duration_s ?? 0)
    ? { advance: true, reason: "elapsed" }
    : { advance: false, reason: "held" };
};

/** Record when the current step began, so timed steps can measure their duration. */
export const startStep = (e: Drone, t_ms: Millis): void => {
  e.step_started_ms = t_ms;
};

const nearest = (e: Drone, points: Vec3[]): Vec3 | undefined => {
  let best: Vec3 | undefined;
  let bestD = Infinity;
  for (const p of points) {
    const d = (p.x - e.pos.x) ** 2 + (p.y - e.pos.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
};

/**
 * The state machine's transition table, for validation and for the scenario
 * validator (FR-SCN-4). Maps a state to the states that may legally follow.
 */
export const LEGAL_TRANSITIONS: Record<BehaviourState, readonly BehaviourState[]> = {
  transit: ["orbit_loiter", "approach_direct", "terrain_masked_approach", "popup", "retreat", "land", "transit"],
  orbit_loiter: ["approach_direct", "terrain_masked_approach", "retreat", "land", "transit", "orbit_loiter"],
  approach_direct: ["popup", "retreat", "land", "approach_direct"],
  terrain_masked_approach: ["popup", "approach_direct", "retreat", "land", "terrain_masked_approach"],
  popup: ["approach_direct", "terrain_masked_approach", "transit", "retreat", "land"],
  decoy_hover: ["transit", "retreat", "land", "approach_direct"],
  retreat: ["transit", "orbit_loiter", "land"],
  land: [],
};