import { describe, expect, it } from "vitest";

import type { AnySimEvent } from "./events.js";
import { assertNoTruthLeak, canSee, filterForRole, findForbiddenKeys, stripForbiddenKeys } from "./views.js";

const ev = (partial: Partial<AnySimEvent> & Pick<AnySimEvent, "type">): AnySimEvent =>
  ({
    seq: 1,
    t_ms: 0,
    actor: "system",
    visibility: "all",
    payload: {},
    ...partial,
  }) as AnySimEvent;

describe("filterForRole (PRD §6.4)", () => {
  const stream: AnySimEvent[] = [
    ev({ type: "entity_state", visibility: "instructor", payload: { id: "D1", pos: [1, 2, 3], vel: [0, 0, 0], behaviour_state: "transit" } as never }),
    ev({ type: "entity_spawned", visibility: "instructor", payload: { id: "D1", archetype: "recon_multirotor", affiliation_truth: "hostile", intent: "recon" } as never }),
    ev({ type: "sensor_observation", visibility: "trainee", payload: { sensor: "radar", obs_id: "o1", truth_ref: "D1", bearing_deg: 10, range_m: 500, alt_m: 60, conf: 0.7, is_false: false } as never }),
    ev({ type: "track_update", visibility: "trainee", payload: { track_id: "T1", sources: ["radar"], conf: 0.7, status: "new", pos_est: [0, 0, 0] } as never }),
  ];

  it("drops instructor-only truth events for a trainee", () => {
    const view = filterForRole(stream, "trainee");
    expect(view.map((e) => e.type)).toEqual(["sensor_observation", "track_update"]);
  });

  it("keeps truth events for an instructor", () => {
    const view = filterForRole(stream, "instructor");
    expect(view.map((e) => e.type)).toContain("entity_state");
    expect(view.map((e) => e.type)).toContain("entity_spawned");
  });

  it("strips truth_ref from a trainee payload but keeps the useful fields", () => {
    const view = filterForRole(stream, "trainee");
    const obs = view.find((e) => e.type === "sensor_observation");
    expect(obs).toBeDefined();
    expect(obs!.payload).not.toHaveProperty("truth_ref");
    expect(obs!.payload).toMatchObject({ sensor: "radar", range_m: 500, conf: 0.7 });
  });

  it("keeps truth_ref for an instructor, who needs it for scoring", () => {
    const view = filterForRole(stream, "instructor");
    const obs = view.find((e) => e.type === "sensor_observation");
    expect(obs!.payload).toHaveProperty("truth_ref", "D1");
  });

  it("produces a trainee view with no forbidden key anywhere", () => {
    const view = filterForRole(stream, "trainee");
    for (const e of view) {
      expect(findForbiddenKeys(e.payload)).toEqual([]);
    }
  });

  it("drops a truth-bearing event even if mislabelled as visible", () => {
    const mislabelled = ev({
      type: "entity_state",
      visibility: "all", // wrong on purpose
      payload: { id: "D1", pos: [0, 0, 0], vel: [0, 0, 0], behaviour_state: "transit" } as never,
    });
    expect(filterForRole([mislabelled], "trainee")).toHaveLength(0);
  });
});

describe("canSee", () => {
  it("follows the visibility ladder", () => {
    expect(canSee("all", "trainee")).toBe(true);
    expect(canSee("trainee", "trainee")).toBe(true);
    expect(canSee("instructor", "trainee")).toBe(false);
    expect(canSee("instructor", "instructor")).toBe(true);
    expect(canSee("instructor", "admin")).toBe(true);
    expect(canSee("all", "admin")).toBe(true);
  });

  it("denies an unrecognised visibility value", () => {
    expect(canSee("something_new", "admin")).toBe(false);
  });
});

describe("stripForbiddenKeys", () => {
  it("removes forbidden keys recursively through arrays", () => {
    const input = { a: [{ truth_id: "D1", keep: 1 }], b: { intent: "recon", keep: 2 } };
    expect(stripForbiddenKeys(input)).toEqual({ a: [{ keep: 1 }], b: { keep: 2 } });
  });

  it("leaves primitives and non-forbidden keys untouched", () => {
    expect(stripForbiddenKeys({ range_m: 5, shape: "ambiguous" })).toEqual({
      range_m: 5,
      shape: "ambiguous",
    });
  });
});

describe("assertNoTruthLeak", () => {
  it("passes on a clean payload", () => {
    expect(() => assertNoTruthLeak({ range_m: 5 })).not.toThrow();
  });

  it("throws and names the offending key", () => {
    expect(() => assertNoTruthLeak({ obs: { truth_ref: "D1" } })).toThrow(/truth_ref/);
  });
});