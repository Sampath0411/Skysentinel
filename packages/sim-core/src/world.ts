/**
 * The simulation world (PRD §5.1 FR-SIM-1, FR-SIM-9).
 *
 * Owns the tick loop and the ordered update of every subsystem. Everything that
 * affects the event log goes through here, which is what makes determinism a
 * property of the design rather than a thing to remember at each call site.
 *
 * Update order is fixed and documented. Changing it changes the event log for a
 * given seed, so it is part of the simulation's contract, not an implementation
 * detail.
 */

import {
  SYNTHETIC_BANNER,
  type Millis,
  type Vec3,
} from "@skysentinel/shared";

import { stepEntity, startStep, type BehaviourContext } from "./behaviours.js";
import { TICK_HZ, TICK_MS, createClock } from "./clock.js";
import { type Environment, createEnvironment } from "./environment.js";
import {
  type Drone,
  type Entity,
  type ProtectedAsset,
  createAsset,
  createDrone,
  createFriendlyPosition,
  type BehaviourStep,
} from "./entities.js";
import { type EventEmitter, createEventEmitter } from "./events.js";
import { type DrillState, deriveOutcome, applyImpact, isInsideImpactRadius, startDrill, stepDrill } from "./impact.js";
import { createRngBundle, type RngBundle } from "./rng.js";
import { applyReactiveRule, formSwarm, orderRetreat, type Swarm } from "./swarm.js";
import { createTerrain, type Terrain } from "./terrain/index.js";

export interface WorldParams {
  scenario_id: string;
  seed: number;
  /** Simulated duration, ms. */
  duration_ms: Millis;
  terrain: Terrain;
  environment: Environment;
  drones: Drone[];
  assets: ProtectedAsset[];
  friendly_positions?: { id: string; label: string; pos: Vec3 }[];
}

export interface DrillRequest {
  asset_id: string;
  duration_s: number;
  signature_reduction: number;
}

export interface World {
  readonly scenario_id: string;
  readonly seed: number;
  readonly terrain: Terrain;
  readonly environment: Environment;
  readonly emitter: EventEmitter;
  readonly rng: RngBundle;
  /** Live entities, in stable id order. */
  entities(): Entity[];
  t_ms(): Millis;
  /** Run to completion. Returns the number of ticks executed. */
  run(): number;
  /** Run one tick. Returns false once the clock has expired. */
  tick(): boolean;
  requestDrill(req: DrillRequest): DrillState;
  drills(): readonly DrillState[];
  outcome(): ReturnType<typeof deriveOutcome>;
  /** Entities not neutralised and not landed, in stable id order. */
  activeThreats(): Drone[];
  /** A hash over the whole event log. Equal logs hash equal (FR-SIM-1). */
  logHash(): string;
}

export const createWorld = (params: WorldParams): World => {
  const rng = createRngBundle(params.seed);
  const emitter = createEventEmitter({ seedActor: "sim" });
  const clock = createClock(params.duration_ms);
  const terrain = params.terrain;

  const assets = params.assets;
  const friendly = (params.friendly_positions ?? []).map((f, i) =>
    createFriendlyPosition({ ...f, spawned_seq: assets.length + i }),
  );

  // Stable id order. Entity update order must not depend on spawn order, or two
  // runs that spawn the same entities differently would produce different logs.
  const drones = [...params.drones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map<string, Drone>(drones.map((d) => [d.id, d]));

  const swarms = new Map<string, Swarm>();
  const groupIds = new Set(drones.map((d) => d.group_id).filter((g): g is string => g !== undefined));
  for (const gid of [...groupIds].sort()) {
    swarms.set(gid, formSwarm(gid, drones.filter((d) => d.group_id === gid), 0));
  }

  const drills = new Map<string, DrillState>();
  let impacts = 0;

  emitter.emit("session_started", { scenario_id: params.scenario_id, seed: params.seed });

  // Spawn events are emitted once, in id order, before any motion.
  for (const d of drones) {
    startStep(d, 0);
    emitter.emit("entity_spawned", {
      id: d.id,
      archetype: d.archetype,
      affiliation_truth: d.affiliation_truth,
      intent: d.intent,
      ...(d.role !== undefined ? { role: d.role } : {}),
      ...(d.group_id !== undefined ? { group_id: d.group_id } : {}),
    });
  }
  for (const a of assets) {
    emitter.emit("entity_spawned", {
      id: a.id,
      archetype: "protected_asset",
      affiliation_truth: "authorised",
      intent: "static",
    });
  }

  const behaviourCtx = (t_ms: Millis): BehaviourContext => ({
    terrain,
    rng: rng.motion,
    assetPositions: assets.map((a) => a.pos),
    dt_s: TICK_MS / 1000,
    t_ms,
  });

  const world: World = {
    scenario_id: params.scenario_id,
    seed: params.seed,
    terrain,
    environment: params.environment,
    emitter,
    rng,

    entities: () => [...drones, ...assets, ...friendly].sort(byIdOrder),

    t_ms: () => emitter.now(),

    tick() {
      if (clock.atEnd()) return false;
      const t = clock.step();
      emitter.setTime(t);

      const ctx = behaviourCtx(t);

      // 1. Spawn drones whose time has come. Sorted by spawn time, then id.
      for (const d of drones) {
        if (t >= d.spawn_t_ms && d.step_started_ms === 0 && !d.neutralised) {
          d.step_started_ms = t;
        }
      }

      // 2. Behaviour, in stable id order.
      for (const d of drones) {
        if (t < d.spawn_t_ms || d.neutralised) continue;
        stepEntity(d, ctx);
      }

      // 3. Swarm reactive rule, then any retreats it ordered.
      for (const gid of [...swarms.keys()].sort()) {
        const swarm = swarms.get(gid)!;
        const retreating = applyReactiveRule(swarm, byId, t);
        if (retreating.length > 0) orderRetreat(byId, retreating, terrain);
      }

      // 4. Impacts. Asset-major order so a tie between two assets resolves the same
      //    way every run.
      for (const a of assets) {
        for (const d of drones) {
          if (t < d.spawn_t_ms || d.neutralised || d.landed) continue;
          if (!isInsideImpactRadius(a, d.pos)) continue;

          const result = applyImpact(a, d.id, d.archetype);
          if (result.integrity_after === result.integrity_before) continue; // harmless contact

          impacts++;
          d.neutralised = true;
          emitter.emit("impact", {
            asset_id: a.id,
            damage: result.integrity_before - result.integrity_after,
          });
        }
      }

      // 5. Drills.
      for (const drill of drills.values()) {
        const asset = assets.find((a) => a.id === drill.asset_id);
        if (asset) stepDrill(drill, asset, TICK_MS / 1000, t);
      }

      // 6. Truth state at 1 Hz, not per tick, to bound log size (FR-SIM-10).
      if (t % 1000 === 0) {
        for (const d of drones) {
          if (t < d.spawn_t_ms || d.neutralised) continue;
          // Positions serialise as tuples: this event fires once per entity per
          // second and the log is the largest artefact the sim produces.
          emitter.emit("entity_state", {
            id: d.id,
            pos: [d.pos.x, d.pos.y, d.pos.z],
            vel: [d.vel.x, d.vel.y, d.vel.z],
            behaviour_state: d.behaviour_state,
          });
        }
      }

      return true;
    },

    run() {
      let ticks = 0;
      while (world.tick()) ticks++;
      emitter.emit("session_ended", {
        scenario_id: params.scenario_id,
        seed: params.seed,
        end_reason: world.outcome(),
      });
      return ticks;
    },

    requestDrill(req) {
      const drill = startDrill(req.asset_id, emitter.now(), req.duration_s, req.signature_reduction);
      drills.set(req.asset_id, drill);
      emitter.emit("action_taken", { action: "activate_protective_drill", params: { asset_id: req.asset_id } });
      return drill;
    },

    drills: () => [...drills.values()],

    outcome: () => deriveOutcome(assets, impacts > 0),

    activeThreats: () =>
      drones.filter((d) => !d.neutralised && !d.landed && d.affiliation_truth === "hostile"),

    logHash: () => hashLog(emitter.log()),
  };

  return world;
};

/** Stable ordering across mixed entity kinds, by id. */
const byIdOrder = (a: Entity, b: Entity): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * FNV-1a over the serialised log.
 *
 * A hash rather than a byte comparison so the determinism test can assert
 * equality in one line, and so a divergence reports *which* run differs without
 * dumping a multi-megabyte log into the test output.
 */
export const hashLog = (log: readonly unknown[]): string => {
  const s = JSON.stringify(log);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

export { SYNTHETIC_BANNER, TICK_HZ, TICK_MS };
export { createTerrain, createEnvironment, createDrone, createAsset };
export type { BehaviourStep };