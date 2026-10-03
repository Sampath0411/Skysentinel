import { describe, expect, it } from "vitest";

import { FORBIDDEN_TRAINEE_KEYS } from "@skysentinel/shared";

import { LEGAL_TRANSITIONS, MIN_CLEARANCE_M, stepEntity, type BehaviourContext } from "./behaviours.js";
import { createBirdFlock, createDrone, toTraineeView, type BehaviourStep } from "./entities.js";
import { createRng } from "./rng.js";
import { createTerrain } from "./terrain/index.js";

const terrain = createTerrain("rural", 42, 2000);
const assetPositions = [{ x: 0, y: 0, z: 10 }];

const ctxAt = (t_ms: number, dt_s = 0.05): BehaviourContext => ({
  terrain,
  rng: createRng(7, "motion:test"),
  assetPositions,
  dt_s,
  t_ms,
});

const drone = (programme: BehaviourStep[], pos = { x: -500, y: 0, z: 120 }) =>
  createDrone({
    id: "d1",
    archetype: "quad_recon",
    affiliation_truth: "hostile",
    intent: "recon",
    pos,
    spawn_t_ms: 0,
    speed_mps: 20,
    programme,
    rf_emitting: false,
    spawned_seq: 0,
  });

/** Run a drone forward until `predicate` or `maxTicks`. Returns ticks taken. */
const runUntil = (d: ReturnType<typeof drone>, predicate: () => boolean, maxTicks = 4000): number => {
  for (let t = 0; t < maxTicks; t++) {
    const ctx = ctxAt(t * 50);
    if (predicate()) return t;
    stepEntity(d, ctx);
  }
  return predicate() ? maxTicks : -1;
};

describe("behaviour state machines", () => {
  it("transit moves the entity toward its waypoint and reports arrival", () => {
    const d = drone([{ state: "transit", to: { x: -400, y: 0, z: 120 }, speed: 20 }]);

    const first = stepEntity(d, ctxAt(0));
    expect(first.advance).toBe(false);
    expect(d.pos.x).toBeGreaterThan(-500);

    // A single-step programme ends on arrival, staying in `transit`.
    const ticks = runUntil(d, () => d.pos.x > -400.5);
    expect(ticks).toBeGreaterThan(0);
    expect(d.pos.x).toBeCloseTo(-400, 0);
    expect(d.step_index).toBe(0);
  });

  it("walks a multi-step programme in order", () => {
    const d = drone([
      { state: "transit", to: { x: -480, y: 0, z: 120 }, speed: 20 },
      { state: "orbit_loiter", center: { x: -450, y: 0, z: 120 }, radius: 60, duration_s: 2 },
      { state: "land", to: { x: -430, y: 0, z: 30 }, speed: 10 },
    ]);

    runUntil(d, () => d.step_index === 1);
    expect(d.behaviour_state).toBe("orbit_loiter");

    runUntil(d, () => d.step_index === 2, 2000);
    expect(d.behaviour_state).toBe("land");

    runUntil(d, () => d.landed === true, 2000);
    expect(d.landed).toBe(true);
  });

  it("orbit_loiter stays within its radius of the centre", () => {
    const center = { x: 0, y: 0, z: 100 };
    const d = drone([{ state: "orbit_loiter", center, radius: 80, speed: 15, duration_s: 3 }], { x: 80, y: 0, z: 100 });

    for (let t = 0; t < 60; t++) stepEntity(d, ctxAt(t * 50));
    const r = Math.hypot(d.pos.x - center.x, d.pos.y - center.y);
    expect(r).toBeCloseTo(80, 0);
    expect(d.pos.z).toBeCloseTo(100, 0);
  });

  it("orbit_loiter advances once its duration elapses", () => {
    const d = drone([
      { state: "orbit_loiter", center: { x: 0, y: 0, z: 100 }, radius: 50, speed: 10, duration_s: 1 },
      { state: "land", to: { x: 0, y: 0, z: 30 }, speed: 5 },
    ], { x: 50, y: 0, z: 100 });

    // 1 s at 50 ms/tick: the tick at t=950 ms is still inside, t=1000 ms advances.
    for (let t = 0; t <= 19; t++) stepEntity(d, ctxAt(t * 50));
    expect(d.step_index).toBe(0);
    stepEntity(d, ctxAt(20 * 50));
    expect(d.step_index).toBe(1);
  });

  it("popup climbs to the target altitude, then advances", () => {
    const d = drone([
      { state: "popup", alt: 200, speed: 25 },
      { state: "land", to: { x: 0, y: 0, z: 20 }, speed: 5 },
    ], { x: 0, y: 0, z: 100 });

    stepEntity(d, ctxAt(0));
    expect(d.pos.z).toBeGreaterThan(100);
    expect(d.step_index).toBe(0);

    runUntil(d, () => d.step_index === 1, 500);
    expect(d.pos.z).toBeCloseTo(200, 0);
  });

  it("terrain_masked_approach closes on an asset while staying low", () => {
    const d = drone(
      [{ state: "terrain_masked_approach", speed: 20 }],
      { x: -300, y: 0, z: 300 },
    );

    for (let t = 0; t < 10; t++) stepEntity(d, ctxAt(t * 50));
    const ground = terrain.obstructionAt(d.pos.x, d.pos.y);
    // Low enough to be masked, but never below the clearance floor.
    expect(d.pos.z).toBeLessThan(300);
    expect(d.pos.z).toBeGreaterThanOrEqual(ground + MIN_CLEARANCE_M);
  });

  it("never descends into terrain or off the map", () => {
    const d = drone(
      [{ state: "land", to: { x: 9000, y: 9000, z: -500 }, speed: 60 }],
      { x: 1800, y: 1800, z: 200 },
    );

    for (let t = 0; t < 500; t++) {
      stepEntity(d, ctxAt(t * 50));
      expect(Math.abs(d.pos.x)).toBeLessThanOrEqual(terrain.size);
      expect(Math.abs(d.pos.y)).toBeLessThanOrEqual(terrain.size);
      expect(d.pos.z).toBeGreaterThanOrEqual(terrain.obstructionAt(d.pos.x, d.pos.y) + MIN_CLEARANCE_M - 1e-6);
    }
  });

  it("holds position with an empty programme rather than crashing", () => {
    const d = drone([]);
    const outcome = stepEntity(d, ctxAt(0));
    expect(outcome.advance).toBe(false);
    expect(d.vel).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("is deterministic: same seed and programme give identical trajectories", () => {
    const run = () => {
      const d = drone([
        { state: "transit", to: { x: 200, y: 300, z: 150 }, speed: 22 },
        { state: "orbit_loiter", center: { x: 200, y: 300, z: 150 }, radius: 90, speed: 12, duration_s: 4 },
      ]);
      const trail: number[] = [];
      for (let t = 0; t < 400; t++) {
        stepEntity(d, ctxAt(t * 50));
        trail.push(d.pos.x, d.pos.y, d.pos.z);
      }
      return trail.join(",");
    };

    expect(run()).toBe(run());
  });

  it("transition table covers every state and only lists known states", () => {
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual(
      [
        "approach_direct",
        "decoy_hover",
        "land",
        "orbit_loiter",
        "popup",
        "retreat",
        "terrain_masked_approach",
        "transit",
      ].sort(),
    );
    for (const targets of Object.values(LEGAL_TRANSITIONS)) {
      for (const t of targets) expect(LEGAL_TRANSITIONS).toHaveProperty(t);
    }
  });
});

describe("trainee entity view", () => {
  it("never carries a forbidden truth key", () => {
    const d = drone([{ state: "transit", to: { x: 0, y: 0, z: 100 }, speed: 10 }]);
    d.group_id = "g1";
    d.role = "scout";

    const serialised = JSON.stringify(toTraineeView(d));
    for (const key of FORBIDDEN_TRAINEE_KEYS) {
      expect(serialised).not.toContain(`"${key}"`);
    }
    expect(serialised).not.toContain("hostile");
  });

  it("keeps bird flocks on the non-UAS side of the boundary", () => {
    const flock = createBirdFlock({
      id: "b1",
      pos: { x: 0, y: 0, z: 90 },
      spawn_t_ms: 0,
      speed_mps: 8,
      programme: [{ state: "transit", to: { x: 100, y: 0, z: 90 }, speed: 8 }],
      count: 20,
      spawned_seq: 1,
    });

    expect(flock.affiliation_truth).toBe("non_uas");
    expect(JSON.stringify(toTraineeView(flock))).not.toContain("non_uas");
  });
});