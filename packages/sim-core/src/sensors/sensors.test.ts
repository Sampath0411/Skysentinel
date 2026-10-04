import { describe, expect, it } from "vitest";

import type { Millis } from "@skysentinel/shared";
import { bearingDeltaDeg } from "@skysentinel/shared";

import { createEnvironment } from "../environment.js";
import type { Drone } from "../entities.js";
import { createRng } from "../rng.js";
import { createTerrain } from "../terrain/index.js";
import {
  createFlightPlanSensor,
  createIRSensor,
  createRadarSensor,
  createRFSensor,
  createSensorSuite,
  createVisualSensor,
  type Observation,
  type Sensor,
  type SensorContext,
  observerAt,
} from "./index.js";

const terrain = createTerrain("rural", 99, 4000);

/**
 * Sensors sit on a mast above local terrain, not at a fixed z.
 *
 * This is not cosmetic: a constant z of 0 or 30 puts the observer inside the
 * ground wherever the map rises above it, and the platform then occludes every
 * target so no sensor ever detects anything.
 */
const OBSERVER = observerAt(terrain);

const ctx = (over: Partial<SensorContext> = {}): SensorContext => ({
  terrain,
  environment: createEnvironment("day", "clear"),
  rng: createRng(7, "sensor:test"),
  t_ms: 0,
  observer_pos: OBSERVER,
  ...over,
});

const target = (over: Partial<Drone> = {}): Drone =>
  ({
    kind: "drone",
    id: "d1",
    archetype: "recon_multirotor",
    affiliation_truth: "hostile",
    intent: "recon",
    pos: { x: 1000, y: 0, z: 120 },
    vel: { x: 0, y: 0, z: 0 },
    heading_deg: 0,
    speed_mps: 10,
    behaviour_state: "transit",
    step_index: 0,
    step_started_ms: 0,
    spawn_t_ms: 0,
    programme: [],
    rf_emitting: true,
    spawned_seq: 0,
    ...over,
  }) as Drone;

/**
 * Detection rate over many independent trials with a fixed seed.
 *
 * Each trial uses a fresh stream derived from the trial index, so a change to one
 * trial cannot shift the others and the number is reproducible.
 */
const detectionRate = (sensor: Sensor, mkTarget: () => Drone, n: number, c: SensorContext): number => {
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const trialCtx: SensorContext = { ...c, rng: createRng(1000 + i, `sensor:trial:${sensor.id}`) };
    if (sensor.observe([mkTarget(i)], trialCtx).length > 0) hits++;
  }
  return hits / n;
};

const N = 400;

describe("radar sensor (FR-SEN-3)", () => {
  it("detection rate falls with range", () => {
    const radar = createRadarSensor();
    const c = ctx();

    const near = detectionRate(radar, () => target({ pos: { x: 400, y: 0, z: 120 } }), N, c);
    const mid = detectionRate(radar, () => target({ pos: { x: 2500, y: 0, z: 120 } }), N, c);
    const far = detectionRate(radar, () => target({ pos: { x: 6500, y: 0, z: 120 } }), N, c);

    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    // Wide margins: the ordering must not rest on a statistical tie.
    expect(near - far).toBeGreaterThan(0.25);
  });

  it("reports range and speed, with error against truth", () => {
    const radar = createRadarSensor();
    let checked = 0;
    let maxRangeError = 0;

    for (let i = 0; i < 60; i++) {
      const c = ctx({ rng: createRng(2000 + i, "sensor:radar-check"), t_ms: i * 50 });
      const obs = radar.observe([target({ pos: { x: 2000, y: 0, z: 120 }, speed_mps: 12 })], c);
      if (obs.length === 0) continue;

      checked++;
      maxRangeError = Math.max(maxRangeError, Math.abs(obs[0]!.range_m! - 2000) / 2000);
      expect(obs[0]!.rcs).toBeDefined();
      expect(obs[0]!.speed_mps).toBeGreaterThan(0);
    }

    expect(checked).toBeGreaterThan(20);
    // 2% nominal error; allow 20% for the tail.
    expect(maxRangeError).toBeLessThan(0.2);
  });

  it("cannot see a target masked behind buildings, but sees one above them", () => {
    const urban = createTerrain("urban", 5, 2000);
    const radar = createRadarSensor();
    const observer = observerAt(urban);

    // A grid of low targets: some sit in a building's radar shadow, some do not.
    const lowSeen = new Set<string>();
    let lowBlocked = 0;
    for (let i = 0; i < 40; i++) {
      const pos = { x: (i % 10) * 100 - 450, y: Math.floor(i / 10) * 100 - 150, z: 15 };
      const key = `${pos.x},${pos.y}`;
      const c = ctx({ terrain: urban, rng: createRng(7000 + i, "sensor:urban"), t_ms: i * 50 });
      if (radar.observe([target({ id: key, pos })], c).length > 0) lowSeen.add(key);
    }
    // LOS is the gate, so a masked target can never be observed.
    for (let i = 0; i < 40; i++) {
      const pos = { x: (i % 10) * 100 - 450, y: Math.floor(i / 10) * 100 - 150, z: 15 };
      if (!urban.hasLineOfSight(observer, pos)) lowBlocked++;
    }
    expect(lowBlocked).toBeGreaterThan(0);
    for (const key of lowSeen) {
      const [x, y] = key.split(",").map(Number);
      expect(urban.hasLineOfSight(observer, { x: x!, y: y!, z: 15 })).toBe(true);
    }

    // Above the roofline the same position is visible and detectable.
    let highSeen = 0;
    for (let i = 0; i < 20; i++) {
      const c = ctx({ terrain: urban, rng: createRng(7500 + i, "sensor:urban-high"), t_ms: i * 50 });
      highSeen += radar.observe([target({ pos: { x: 0, y: 400, z: 250 } })], c).length;
    }
    expect(highSeen).toBeGreaterThan(0);
  });
});

describe("visual sensor (FR-SEN-1)", () => {
  it("night reduces detection at least fivefold versus day", () => {
    const day = ctx({ environment: createEnvironment("day", "clear") });
    const night = ctx({ environment: createEnvironment("night", "clear") });

    const dayRate = detectionRate(createVisualSensor(), () => target(), N, day);
    const nightRate = detectionRate(createVisualSensor(), () => target(), N, night);

    expect(nightRate).toBeLessThan(dayRate);
    expect(dayRate / Math.max(nightRate, 1e-9)).toBeGreaterThan(5);
  });

  it("provides bearing but no range", () => {
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const obs = createVisualSensor().observe([target({ pos: { x: 500, y: 0, z: 120 } })], ctx({ rng: createRng(3000 + i, "sensor:vis"), t_ms: i * 50 }));
      if (obs.length === 0) continue;
      checked++;
      expect(obs[0]!.bearing_deg).toBeGreaterThanOrEqual(0);
      expect(obs[0]!.bearing_deg).toBeLessThan(360);
      expect(obs[0]!.range_m).toBeUndefined();
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("IR sensor (FR-SEN-2)", () => {
  it("works at night, unlike visual", () => {
    const night = ctx({ environment: createEnvironment("night", "clear") });
    const visual = detectionRate(createVisualSensor(), () => target(), N, night);
    const ir = detectionRate(createIRSensor(), () => target(), N, night);

    expect(ir).toBeGreaterThan(visual);
  });

  it("sees a hot airframe better than a cold decoy", () => {
    const c = ctx();
    const hot = detectionRate(createIRSensor(), () => target({ archetype: "fixed_wing_recon" }), N, c);
    const cold = detectionRate(createIRSensor(), () => target({ archetype: "decoy_drone" }), N, c);
    expect(hot).toBeGreaterThan(cold);
  });
});

describe("RF sensor (FR-SEN-4)", () => {
  it("an RF-silent drone produces no RF alerts at all", () => {
    const rf = createRFSensor();
    let alerts = 0;
    for (let i = 0; i < 100; i++) {
      const c = ctx({ rng: createRng(4000 + i, "sensor:rf-silent"), t_ms: i * 50 });
      alerts += rf.observe([target({ rf_emitting: false })], c).length;
    }
    expect(alerts).toBe(0);
  });

  it("does see an emitting drone", () => {
    const rate = detectionRate(createRFSensor(), () => target({ rf_emitting: true }), N, ctx());
    expect(rate).toBeGreaterThan(0.3);
  });
});

describe("flight-plan sensor (FR-SEN-5)", () => {
  it("reports only entities that filed a plan, exactly", () => {
    const fp = createFlightPlanSensor();
    const obs = fp.observe([target({ flight_ref: "plan-1" })], ctx({ t_ms: 1000 }));
    expect(obs).toHaveLength(1);
    expect(obs[0]!.confidence).toBe(1);

    expect(fp.observe([target()], ctx({ t_ms: 1000 }))).toHaveLength(0);
  });

  it("refreshes at 1 Hz rather than every tick", () => {
    const fp = createFlightPlanSensor();
    const withPlan = () => [target({ flight_ref: "plan-1" })];
    expect(fp.observe(withPlan(), ctx({ t_ms: 1000 }))).toHaveLength(1);
    expect(fp.observe(withPlan(), ctx({ t_ms: 1050 }))).toHaveLength(0);
  });

  it("reports the contact's true bearing and range, not a placeholder", () => {
    // The plan feed is the deconfliction channel, and correlation is gate-based on
    // bearing. Reporting a constant bearing put every listed flight 90°+ away from
    // the radar return for the same aircraft, so a friendly opened its own track and
    // the operator saw one aircraft as two contacts — the plan track and the radar
    // track — neither of which deconflicted anything.
    //
    // Table-driven over the four quadrants from a known origin, because a single
    // case would sit on top of the old hardcoded placeholder and pass. Two details
    // are load-bearing: `ctx`'s default observer sits on the terrain's high point
    // rather than at the origin, and bearings are measured `atan2(dx, dy)` — north
    // is +y at 0°, so east is 90°, not the 0° the old placeholder claimed.
    const cases = [
      { pos: { x: 0, y: 1000, z: 120 }, bearing_deg: 0 },
      { pos: { x: 1000, y: 0, z: 120 }, bearing_deg: 90 },
      { pos: { x: 0, y: -1000, z: 120 }, bearing_deg: 180 },
      { pos: { x: -1000, y: 0, z: 120 }, bearing_deg: 270 },
    ];
    const fp = createFlightPlanSensor();
    for (const { pos, bearing_deg } of cases) {
      const obs = fp.observe(
        [target({ flight_ref: "plan-1", pos })],
        ctx({ t_ms: 1000, observer_pos: { x: 0, y: 0, z: 0 } }),
      );
      expect(obs, `bearing ${bearing_deg}`).toHaveLength(1);
      expect(bearingDeltaDeg(obs[0]!.bearing_deg, bearing_deg)).toBeCloseTo(0, 6);
      expect(obs[0]!.range_m).toBeCloseTo(1000, 6);
    }
  });

  it("cannot generate false alarms", () => {
    expect(() => createFlightPlanSensor().generateFalseAlarm(ctx())).toThrow();
  });
});

describe("degradation modes (FR-SEN-6)", () => {
  it("a failed sensor emits nothing at all", () => {
    for (const sensor of createSensorSuite()) {
      sensor.mode = "failed";
      let emitted = 0;
      for (let i = 0; i < 100; i++) {
        emitted += sensor.observe([target()], ctx({ rng: createRng(5000 + i, `sensor:failed:${sensor.id}`), t_ms: i * 50 })).length;
      }
      expect(emitted).toBe(0);
      expect(sensor.falseAlarmRate(ctx())).toBe(0);
    }
  });

  it("a degraded sensor detects less than a normal one", () => {
    const c = ctx();
    const normal = createRadarSensor();
    const degraded = createRadarSensor();
    degraded.mode = "degraded";

    const n = detectionRate(normal, () => target({ pos: { x: 3000, y: 0, z: 120 } }), N, c);
    const d = detectionRate(degraded, () => target({ pos: { x: 3000, y: 0, z: 120 } }), N, c);
    expect(d).toBeLessThan(n);
  });

  it("a degraded sensor raises its false-alarm rate", () => {
    const normal = createRadarSensor();
    const degraded = createRadarSensor();
    degraded.mode = "degraded";
    expect(degraded.falseAlarmRate(ctx())).toBeGreaterThan(normal.falseAlarmRate(ctx()));
  });

  it("an intermittent sensor skips roughly half its detections", () => {
    const intermittent = createRadarSensor();
    intermittent.mode = "intermittent";
    const rate = detectionRate(intermittent, () => target({ pos: { x: 1500, y: 0, z: 120 } }), N, ctx());
    const normalRate = detectionRate(createRadarSensor(), () => target({ pos: { x: 1500, y: 0, z: 120 } }), N, ctx());
    expect(rate).toBeLessThan(normalRate);
    expect(rate).toBeGreaterThan(0);
  });
});

describe("false alarms", () => {
  it("false alarms carry no truth reference", () => {
    const fa: Observation = createRadarSensor().generateFalseAlarm(ctx());
    expect(fa.truth_ref).toBe("");
    expect(fa.confidence).toBeLessThan(0.7);
  });

  it("false alarm rate rises with RF noise", () => {
    const radar = createRadarSensor();
    const rural = ctx({ environment: createEnvironment("day", "clear", 0, "rural") });
    const urban = ctx({ environment: createEnvironment("day", "clear", 0, "urban") });
    expect(urban.environment.factors.rf_noise).toBeGreaterThan(rural.environment.factors.rf_noise);
    expect(radar.falseAlarmRate(urban)).toBeGreaterThan(radar.falseAlarmRate(rural));
  });
});

describe("sensor determinism", () => {
  it("the same seed produces identical observations", () => {
    const run = (): string => {
      const s = createRadarSensor();
      const out: Observation[] = [];
      for (let i = 0; i < 20; i++) {
        const c = ctx({ rng: createRng(6000 + i, "sensor:det"), t_ms: (i * 50) as Millis });
        out.push(...s.observe([target({ pos: { x: 1500, y: 200, z: 130 } })], c));
      }
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
  });

  it("observation ids are unique per entity per tick", () => {
    const radar = createRadarSensor();
    const obs = radar.observe([target({ id: "a" }), target({ id: "b" })], ctx({ t_ms: 50 }));
    expect(new Set(obs.map((o) => o.obs_id)).size).toBe(obs.length);
  });
});