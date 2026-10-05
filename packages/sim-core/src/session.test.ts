/**
 * Trainee session harness (PRD §9.5 FR-SIM-11, §7.3).
 *
 * The harness is the only boundary a trainee acts through, so these tests are
 * about what the boundary *admits* rather than about the simulation underneath —
 * which `world.test.ts` and `sensors.test.ts` already cover. Three things are
 * load-bearing enough to pin down here:
 *
 *   - the truth-free projection, because a leak here is a PRD §4 breach that no
 *     downstream test would catch;
 *   - `viewBrief`, because N4 and N9 pay for briefing discipline and the control
 *     did not exist until recently;
 *   - the spawn gate, because getting it wrong is silent and looks like a scoring
 *     nuance rather than the phantom early track it actually was.
 */

import { describe, expect, it } from "vitest";

import { TICK_MS } from "./clock.js";
import { createEnvironment } from "./environment.js";
import { createAsset, createDrone } from "./entities.js";
import { createSession } from "./session.js";
import { observerAt } from "./sensors/types.js";
import { createTerrain } from "./terrain/index.js";
import { createWorld } from "./world.js";
import type { SessionSpec } from "./session.js";

const SEED = 4242;

const SPEC: SessionSpec = {
  scenario_id: "scr-session-test",
  seed: SEED,
  duration_s: 60,
  observer_pos: { x: 0, y: 0, z: 3 },
  sensors: {
    radar: "normal",
    visual: "normal",
    ir: "normal",
    rf: "normal",
    flight_plan: "normal",
  },
  grant_rule: { min_category: "suspicious", min_confidence: "medium", min_sources: 2, delay_s: [1, 2] },
  posture: "TIGHT",
  comms_delay_s: 3,
  brief_sections: ["situation", "assets", "authority", "objectives"],
  injects: [],
};

/** One hostile inbound on a short flight, spawning after `spawn_t_ms`. */
const sessionWith = (spawn_t_ms: number, over: Partial<SessionSpec> = {}) => {
  const terrain = createTerrain("rural", SEED);
  const world = createWorld({
    scenario_id: SPEC.scenario_id,
    seed: SEED,
    duration_ms: 60_000,
    terrain,
    environment: createEnvironment("day", "clear"),
    drones: [
      createDrone({
        id: "D1",
        archetype: "recon_multirotor",
        affiliation_truth: "hostile",
        intent: "recon",
        pos: { x: 900, y: 0, z: 120 },
        spawn_t_ms,
        speed_mps: 10,
        programme: [{ state: "transit", to: { x: -900, y: 0, z: 120 }, speed: 10 }],
        rf_emitting: true,
        spawned_seq: 0,
      }),
    ],
    assets: [
      createAsset({
        id: "A1",
        name: "Depot",
        type: "fuel",
        pos: { x: -1500, y: 0, z: 0 },
        priority: 1,
        impact_radius_m: 15,
        spawned_seq: 1,
      }),
    ],
  });

  const spec: SessionSpec = { ...SPEC, observer_pos: observerAt(terrain), ...over };
  return createSession({ spec, world });
};

/** Advance until `predicate` holds, or the run ends. Returns the tick count. */
const advanceUntil = (
  s: ReturnType<typeof sessionWith>,
  predicate: () => boolean,
  max_ticks = 1200,
): number => {
  for (let i = 0; i < max_ticks; i++) {
    if (predicate()) return i;
    if (!s.tick()) break;
  }
  return predicate() ? max_ticks : -1;
};

describe("truth-free projection (PRD §4, §6.4)", () => {
  it("carries no ground truth in the trainee view", () => {
    // Serialised and searched, rather than spot-checked on named fields: a leak
    // under a name nobody thought to check is exactly the failure mode, and
    // `FORBIDDEN_TRAINEE_KEYS` is the list of names that matter.
    const s = sessionWith(0);
    advanceUntil(s, () => s.traineeView().tracks.length > 0);
    const view = JSON.stringify(s.traineeView());

    for (const key of ["truth_ref", "affiliation_truth", "intent", "linked_truth_id", "truth_id", "group_id"]) {
      expect(view, `trainee view leaked ${key}`).not.toContain(key);
    }
  });

  it("still gives the scorer the internal tracks and correlation", () => {
    // The other half of PRD §4: filtering the trainee view must not cost the
    // server its ability to score. Table-driven over both accessors.
    const s = sessionWith(0);
    advanceUntil(s, () => s.traineeView().tracks.length > 0);
    const track = s.tracks()[0]!;

    expect(track.truth_ref).toBe("D1");
    expect(s.correlation().track_truth.get(track.track_id)).toBe("D1");
    expect([...s.correlation().cue_truth.values()]).toContain("D1");
  });
});

describe("spawn gate (PRD §9.2, §9.3)", () => {
  it("does not detect a contact before its spawn time", () => {
    // The regression this pins. Every sensor checks `neutralised` and `landed`
    // but none of them check `spawn_t_ms`, because each sees only the list it is
    // handed — so a drone authored to arrive at t=20 s was detectable from t=0,
    // sitting at its start position. That gave a scenario's late-arriving
    // neutral civilian a track from the first minute, and a bot that correctly
    // classified everything it could see was then penalised for calling a
    // long-dormant civilian a threat.
    const s = sessionWith(20_000);

    for (let i = 0; i < 10_000 / TICK_MS; i++) {
      s.tick();
      expect(s.traineeView().tracks, `a track existed at t=${s.t_ms()}ms`).toHaveLength(0);
    }
  });

  it("detects the contact once it spawns", () => {
    // The other half: the gate must not be a blanket suppression. Without this
    // the test above would pass for a session whose sensors were simply dead.
    const s = sessionWith(20_000);
    expect(advanceUntil(s, () => s.traineeView().tracks.length > 0)).toBeGreaterThan(0);
    expect(s.cues().length).toBeGreaterThan(0);
  });
});

describe("viewBrief (PRD §7.1)", () => {
  it("emits brief_viewed with the sections opened", () => {
    const s = sessionWith(0);
    expect(s.controls().viewBrief(["situation", "authority"])).toBe(true);

    const event = s.log().find((e) => e.type === "brief_viewed");
    expect(event).toBeDefined();
    expect(event!.payload["sections_viewed"]).toEqual(["situation", "authority"]);
    expect(event!.t_ms).toBe(s.t_ms());
  });

  it("defaults to the whole brief", () => {
    // Opening the brief at all is the scored act. A console that made the trainee
    // tick each heading to earn the credit would be measuring clicking, not
    // preparation, so a bare `viewBrief()` reads everything.
    const s = sessionWith(0);
    expect(s.controls().viewBrief()).toBe(true);
    expect(s.log().find((e) => e.type === "brief_viewed")!.payload["sections_viewed"]).toEqual([
      "situation",
      "assets",
      "authority",
      "objectives",
    ]);
  });

  it("refuses a section this brief does not have, and emits nothing for it", () => {
    // Table-driven. `friendly_flights` is a valid heading that the minimal brief
    // above does not offer, and a nonsense string is not a heading at all.
    for (const section of ["friendly_flights", "secrets", ""]) {
      const s = sessionWith(0);
      expect(s.controls().viewBrief([section]), section).toBe(false);
      expect(s.log().some((e) => e.type === "brief_viewed"), section).toBe(false);
    }
  });

  it("opens what it can and drops what it cannot, rather than failing outright", () => {
    // A console asking for a stale section list should still deliver the headings
    // that do exist; refusing the whole request would lose the briefing credit for
    // a trainee who did nothing wrong.
    const s = sessionWith(0);
    expect(s.controls().viewBrief(["secrets", "situation"])).toBe(true);
    expect(s.log().find((e) => e.type === "brief_viewed")!.payload["sections_viewed"]).toEqual([
      "situation",
    ]);
  });

  it("offers the brief's own sections in the view, and never more", () => {
    const s = sessionWith(0, { brief_sections: ["situation", "objectives"] });
    expect(s.traineeView().brief_sections).toEqual(["situation", "objectives"]);
  });
});

describe("report", () => {
  it("carries activity and description, which a bearing alone does not convey", () => {
    // PRD §7.3: a chain operator needs to know what is looking at them. Both are
    // recorded verbatim and neither is checked against truth — that is D24, and
    // the scoring rule lives in the rubric rather than here.
    const s = sessionWith(0);
    advanceUntil(s, () => s.traineeView().tracks.length > 0);
    const track_id = s.traineeView().tracks[0]!.track_id;

    expect(
      s.controls().report({
        track_id,
        quantity: 1,
        bearing_deg: 90,
        range_m: 900,
        activity: "uncoordinated inbound",
        description: "single contact, level, no comms",
      }),
    ).toBe(true);

    const event = s.log().find((e) => e.type === "report_sent")!;
    expect(event.payload["fields"]).toMatchObject({
      quantity: 1,
      bearing_deg: 90,
      range_m: 900,
      activity: "uncoordinated inbound",
      description: "single contact, level, no comms",
    });
    expect(event.payload["linked_track_id"]).toBe(track_id);
    // The chain delay is carried as a field, not applied to the clock: the log's
    // `t_ms` is when the trainee pressed send.
    expect(event.payload["delay_ms"]).toBe(3000);
    expect(s.actions().at(-1)).toMatchObject({ action: "report", quantity: 1, activity: "uncoordinated inbound" });
  });

  it("omits fields the trainee left blank rather than sending them as undefined", () => {
    // A sparse report is a real report — "one contact, no bearing" is information —
    // but a `bearing_deg: undefined` key in the log would make the scorer's
    // field-presence check see a field that was never sent.
    const s = sessionWith(0);
    advanceUntil(s, () => s.traineeView().tracks.length > 0);

    s.controls().report({ track_id: s.traineeView().tracks[0]!.track_id, quantity: 1 });
    const fields = s.log().find((e) => e.type === "report_sent")!.payload["fields"] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["quantity"]);
  });
});

describe("injects (FR-SIM-9)", () => {
  /**
   * The authored timeline and a live instructor inject share one implementation, so
   * a scripted outage and a clicked outage degrade the same sensor by the same code.
   * Each case asserts the *effect on the world*, not just that an event was logged —
   * an inject that logged `inject_applied` and changed nothing would be a UI button
   * that the AAR lies about.
   */
  it("applies an authored inject when its time arrives", () => {
    const s = sessionWith(60_000, {
      injects: [{ at_t_ms: 1_000, type: "comms_delay", params: { delay_s: 12 } }],
    });

    s.tick(); // t = 50 ms — before the inject is due.
    expect(s.controls().report({ quantity: 1, activity: "early report" })).toBe(true);
    expect(s.log().at(-1)!.payload["delay_ms"]).toBe(3000);

    for (let i = 0; i < 20; i++) s.tick(); // past t = 1000 ms.
    expect(s.log().filter((e) => e.type === "inject_applied")).toHaveLength(1);
    expect(s.log().find((e) => e.type === "inject_applied")!.payload["by"]).toBe("scenario");

    s.controls().report({ quantity: 1, activity: "late report" });
    expect(s.log().at(-1)!.payload["delay_ms"]).toBe(12_000);
  });

  it("fires a runtime inject immediately and records who fired it", () => {
    const s = sessionWith(0);

    expect(s.inject("weather_change", { weather: "fog" }, "usr_instructor")).toBe(true);

    const event = s.log().find((e) => e.type === "inject_applied")!;
    expect(event.payload).toMatchObject({
      inject_type: "weather_change",
      params: { weather: "fog" },
      by: "usr_instructor",
    });
    expect(s.world.environment.weather).toBe("fog");
  });

  it("logs an unusable inject but has no effect on the world", () => {
    // Table-driven over the failure shapes: a type the sim does not know, a value
    // of the wrong shape, and a value that is not in the vocabulary.
    const cases: [string, Record<string, unknown>][] = [
      ["not_an_inject", {}],
      ["sensor_outage", { sensor: "lidar" }],
      ["sensor_outage", { sensor: 3 }],
      ["weather_change", { weather: "monsoon" }],
      ["comms_delay", { delay_s: -1 }],
      ["authority_change", { posture: "WEAPONS_FREE" }],
      ["new_track", { range_m: 500 }],
    ];

    for (const [type, params] of cases) {
      const s = sessionWith(0);
      const before = s.log().length;
      expect(s.inject(type, params, "usr_instructor"), `${type} ${JSON.stringify(params)}`).toBe(false);

      // The inject is still in the log: it happened, and the AAR should say so.
      const applied = s.log().slice(before).find((e) => e.type === "inject_applied");
      expect(applied, `${type} logged nothing`).toBeDefined();
      expect(applied!.payload["inject_type"]).toBe(type);
    }
  });

  it("kills a sensor on a sensor_outage inject", () => {
    const s = sessionWith(0);
    // The suite starts whole; the trainee's own picture is what the outage costs.
    expect(s.traineeView().tracks.length).toBe(0);

    expect(s.inject("sensor_outage", { sensor: "radar" }, "usr_instructor")).toBe(true);

    expect(s.log().find((e) => e.type === "sensor_state_changed")!.payload).toMatchObject({
      sensor: "radar",
      mode: "failed",
    });
    // The sensor stops contributing on the very next observation.
    advanceUntil(s, () => s.traineeView().tracks.length > 0);
    expect(s.cues().some((c) => c.sensor === "radar")).toBe(false);
  });

  it("re-resolves the environment factors on a weather_change inject", () => {
    const s = sessionWith(0);
    const clear = s.world.environment.factors;

    expect(s.inject("weather_change", { weather: "fog" }, "usr_instructor")).toBe(true);

    const fog = s.world.environment.factors;
    expect(fog.vis).toBeLessThan(clear.vis);
    expect(fog.ir_pen).toBeLessThan(clear.ir_pen);
    // Time-of-day factors are untouched: the inject is the atmosphere, not the clock.
    expect(fog.light).toBe(clear.light);
    expect(fog.ir_boost).toBe(clear.ir_boost);
  });

  it("changes the delay on a comms_delay inject, for reports sent after it", () => {
    const s = sessionWith(0);
    expect(s.inject("comms_delay", { delay_s: 20 }, "usr_instructor")).toBe(true);

    s.controls().report({ quantity: 1, activity: "after the inject" });
    expect(s.log().at(-1)!.payload["delay_ms"]).toBe(20_000);
  });

  it("flips posture on an authority_change inject, visible in the trainee view", () => {
    const s = sessionWith(0);
    expect(s.traineeView().authority.posture).toBe("TIGHT");

    expect(s.inject("authority_change", { posture: "FREE" }, "usr_instructor")).toBe(true);

    expect(s.authority().posture).toBe("FREE");
    expect(s.traineeView().authority.posture).toBe("FREE");
  });

  it("spawns a loitering contact on a new_track inject, placed from the observer's bearing and range", () => {
    const s = sessionWith(0);
    expect(s.world.entities().filter((e) => e.kind === "drone")).toHaveLength(1);

    expect(s.inject("new_track", { bearing_deg: 0, range_m: 700, altitude_m: 90 }, "usr_instructor")).toBe(true);

    const drones = s.world.entities().filter((e) => e.kind === "drone");
    expect(drones).toHaveLength(2);
    const injected = drones.find((d) => d.id.startsWith("INJ-"))!;
    expect(injected).toBeDefined();
    // Bearing 0° is north on the ENU plane, so the contact is 700 m north of the
    // observer — the same geometry the trainee's own plot uses.
    expect(injected.pos.x).toBeCloseTo(0, 0);
    expect(injected.pos.y).toBeCloseTo(700, 0);
    expect(injected.spawn_t_ms).toBe(s.t_ms());

    // It is a real contact the sensors can see, not a logged marker.
    const cuesBefore = s.cues().length;
    expect(advanceUntil(s, () => s.cues().length > cuesBefore)).toBeGreaterThanOrEqual(0);
    expect(s.cues().filter((c) => c.truth_ref.startsWith("INJ-"))).not.toHaveLength(0);
    expect(s.traineeView().tracks.length).toBeGreaterThan(0);
  });
});

describe("determinism (CLAUDE.md, FR-SIM-10)", () => {
  it("produces an identical log for the same scenario, seed and inputs", () => {
    const drive = (): string => {
      const s = sessionWith(0);
      s.controls().viewBrief();
      advanceUntil(s, () => s.traineeView().tracks.length > 0);
      const track_id = s.traineeView().tracks[0]!.track_id;
      s.controls().classify({ track_id, category: "suspicious", confidence: "medium" });
      s.controls().report({ track_id, quantity: 1, activity: "unidentified, uncoordinated" });
      while (s.tick()) {
        /* run to completion */
      }
      return s.logHash();
    };

    expect(drive()).toBe(drive());
  });
});
