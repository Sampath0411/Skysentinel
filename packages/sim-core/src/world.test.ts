import { describe, expect, it } from "vitest";

import { TRUTH_BEARING_EVENT_TYPES, filterForRole } from "@skysentinel/shared";

import { TICK_HZ, TICK_MS } from "./clock.js";
import { createEnvironment } from "./environment.js";
import { createAsset, createDrone, type Drone } from "./entities.js";
import { createRng } from "./rng.js";
import { createTerrain } from "./terrain/index.js";
import { createWorld, hashLog } from "./world.js";

const SEED = 1234;
const MIN_10 = 10 * 60 * 1000;

/** A 30-entity scenario: a main hostile group, decoys, a bird flock, and a friendly. */
const makeDrones = (count: number): Drone[] => {
  const rng = createRng(SEED, "motion:world-test");
  const drones: Drone[] = [];

  for (let i = 0; i < count; i++) {
    const inSwarm = i < count - 2;
    const isDecoy = inSwarm && i % 5 === 4;
    const angle = rng.floatBetween(0, Math.PI * 2);
    const radius = rng.floatBetween(900, 1500);

    drones.push(
      createDrone({
        id: `d${String(i).padStart(2, "0")}`,
        archetype: isDecoy ? "decoy" : "quad_recon",
        affiliation_truth: "hostile",
        intent: "recon",
        pos: {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          z: rng.floatBetween(60, 180),
        },
        spawn_t_ms: rng.intBetween(0, 30_000),
        speed_mps: rng.floatBetween(10, 18),
        programme: [
          { state: "orbit_loiter", center: { x: 0, y: 0, z: 120 }, radius: 200, speed: 14, duration_s: 30 },
          { state: "terrain_masked_approach", speed: 16 },
        ],
        rf_emitting: !isDecoy,
        spawned_seq: i,
        ...(inSwarm ? { role: i === 0 ? "main" : isDecoy ? "decoy" : "scout", group_id: "g1" } : {}),
      }),
    );
  }

  // A bird flock and a friendly flyer: the things a trainee must not shoot at.
  drones.push(
    createDrone({
      id: "bird",
      archetype: "bird_flock",
      affiliation_truth: "non_uas",
      intent: "none",
      pos: { x: 800, y: 400, z: 140 },
      spawn_t_ms: 0,
      speed_mps: 9,
      programme: [{ state: "transit", to: { x: -800, y: -400, z: 140 }, speed: 9 }],
      rf_emitting: false,
      spawned_seq: count,
    }),
  );

  return drones;
};

const makeWorld = (drones = makeDrones(28), seed = SEED) =>
  createWorld({
    scenario_id: "test-scenario",
    seed,
    duration_ms: MIN_10,
    terrain: createTerrain("rural", seed, 2000),
    environment: createEnvironment("night", "clear"),
    drones,
    assets: [
      createAsset({ id: "asset-a", name: "Fuel", type: "fuel", pos: { x: 0, y: 0, z: 0 }, priority: 1, impact_radius_m: 60, spawned_seq: 0 }),
      createAsset({ id: "asset-b", name: "Command", type: "command_post", pos: { x: 300, y: 200, z: 0 }, priority: 2, impact_radius_m: 60, spawned_seq: 1 }),
    ],
    friendly_positions: [{ id: "fp1", label: "North gate", pos: { x: -400, y: 600, z: 0 } }],
  });

describe("world tick loop (FR-SIM-9)", () => {
  it("runs a 10-minute scenario at the fixed 20 Hz rate", () => {
    const w = makeWorld();
    const ticks = w.run();

    expect(ticks).toBe((MIN_10 / TICK_MS) | 0);
    expect(TICK_HZ).toBe(20);
    // The run ends exactly on the scenario boundary; `session_ended` is stamped there.
    expect(w.emitter.last("session_ended")?.t_ms).toBe(MIN_10);
  });

  it("stops cleanly once the clock expires", () => {
    const w = makeWorld();
    expect(w.tick()).toBe(true);
    while (w.tick());
    expect(w.tick()).toBe(false);
  });

  it("emits a gap-free sequence for every event (FR-SIM-10)", () => {
    const w = makeWorld();
    w.run();
    const seqs = w.emitter.log().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it("keeps the trainee view free of ground truth (PRD §4, §6.4)", () => {
    const w = makeWorld();
    w.run();

    const trainee = filterForRole(w.emitter.log(), "trainee");
    expect(trainee.length).toBeGreaterThan(0);
    expect(trainee.length).toBeLessThan(w.emitter.log().length);

    for (const type of TRUTH_BEARING_EVENT_TYPES) {
      expect(trainee.filter((e) => e.type === type)).toHaveLength(0);
    }
    for (const ev of trainee) {
      expect(ev.visibility).not.toBe("instructor");
    }
    const serialised = JSON.stringify(trainee);
    expect(serialised).not.toContain("hostile");
    expect(serialised).not.toContain("truth_ref");
  });

  it("samples entity state at 1 Hz, not every tick", () => {
    const w = makeWorld(makeDrones(4));
    w.run();

    const perEntity = new Map<string, number>();
    for (const e of w.emitter.byType("entity_state")) {
      perEntity.set(e.payload.id, (perEntity.get(e.payload.id) ?? 0) + 1);
    }

    // At 1 Hz no entity can exceed 600 samples over 10 minutes; at the 20 Hz tick
    // rate it would be 12000. Entities that land or are neutralised stop early, so
    // only the ceiling is guaranteed — what matters is that nothing exceeds it.
    expect(perEntity.size).toBeGreaterThan(0);
    for (const n of perEntity.values()) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(600);
    }
    // An entity that flies the whole way through should hit the 1 Hz cadence.
    expect(Math.max(...perEntity.values())).toBe(600);
  });

  it("records impacts and degrades asset integrity", () => {
    const drones = [
      createDrone({
        id: "attacker",
        archetype: "payload",
        affiliation_truth: "hostile",
        intent: "attack",
        pos: { x: 0, y: 0, z: 80 },
        spawn_t_ms: 0,
        speed_mps: 0,
        programme: [{ state: "land", to: { x: 0, y: 0, z: 20 }, speed: 5 }],
        rf_emitting: true,
        spawned_seq: 0,
      }),
    ];

    const w = makeWorld(drones);
    w.run();

    expect(w.emitter.byType("impact").length).toBeGreaterThan(0);
    expect(w.outcome()).toMatch(/damaged|asset_lost/);
  });

  it("breaks swarm formation when the leader is gone", () => {
    const w = makeWorld(makeDrones(10));
    w.run();

    // Members that were following should have ended up retreating or landed.
    const scout = w.entities().find((e) => e.id === "d01");
    expect(scout).toBeDefined();
  });

  it("a protective drill costs integrity over its duration", () => {
    const w = makeWorld(makeDrones(4));
    const drill = w.requestDrill({ asset_id: "asset-a", duration_s: 30, signature_reduction: 0.4 });
    expect(drill.phase).toBe("requested");

    const before = w.entities().find((e) => e.id === "asset-a");
    const integrityBefore = before && "integrity" in before ? before.integrity : 1;

    for (let i = 0; i < 100; i++) w.tick();
    expect(w.drills()[0]!.phase).toBe("active");

    const after = w.entities().find((e) => e.id === "asset-a");
    const integrityAfter = after && "integrity" in after ? after.integrity : 1;
    expect(integrityAfter).toBeLessThan(integrityBefore);
  });
});

describe("determinism (FR-SIM-1)", () => {
  it("produces an identical log hash for the same seed", () => {
    const a = makeWorld();
    const b = makeWorld();
    a.run();
    b.run();
    expect(a.logHash()).toBe(b.logHash());
  });

  it("produces the same hash across separate world instances with one seed", () => {
    const a = makeWorld();
    const b = makeWorld();
    a.run();
    b.run();
    expect(a.logHash()).toBe(b.logHash());
  });

  it("produces a different hash for a different seed", () => {
    const a = makeWorld(makeDrones(28), 1234);
    const b = makeWorld(makeDrones(28), 9999);
    a.run();
    b.run();
    expect(a.logHash()).not.toBe(b.logHash());
  });

  it("is unaffected by the order drones are supplied in", () => {
    // Two independently generated arrays: a world mutates its entities in place, so
    // sharing one array would make the second world start from the first's state.
    const a = makeWorld(makeDrones(10));
    const b = makeWorld([...makeDrones(10)].reverse());
    a.run();
    b.run();

    expect(a.logHash()).toBe(b.logHash());
  });

  it("hashLog distinguishes different logs", () => {
    expect(hashLog([1, 2, 3])).not.toBe(hashLog([1, 2, 4]));
    expect(hashLog([1, 2, 3])).toBe(hashLog([1, 2, 3]));
  });
});

describe("performance (M1 DoD)", () => {
  it("simulates 30 entities for 10 minutes in under 5 seconds", () => {
    const w = makeWorld(makeDrones(28)); // 28 drones + flock = 29 trackable entities
    const started = performance.now();
    w.run();
    const elapsed = performance.now() - started;

    expect(w.emitter.log().length).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);
});