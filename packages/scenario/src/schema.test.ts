/**
 * Scenario schema tests (PRD §8.1).
 *
 * The schema is the boundary every scenario crosses — authored, generated, or
 * read from disk — so these test the boundary behaviour rather than re-testing
 * Zod. In particular: `parseScenario` must never throw, because the validator
 * CLI's whole job is to report every problem in a file at once.
 */

import { describe, expect, it } from "vitest";

import { SCRIPTED_SCENARIOS, nightRecon01 } from "./scripted/index.js";
import {
  BRIEF_SECTIONS,
  INJECT_TYPES,
  SCENARIO_SCHEMA_VERSION,
  ScenarioSchema,
  parseScenario,
} from "./schema.js";

/** A deep-enough clone to mutate without touching the shared fixture. */
const draft = (): Record<string, unknown> => structuredClone(nightRecon01 as unknown as Record<string, unknown>);

describe("parseScenario", () => {
  it("accepts every shipped scripted scenario", () => {
    for (const s of SCRIPTED_SCENARIOS) {
      const r = parseScenario(JSON.parse(JSON.stringify(s)));
      expect(r.ok, `${s.id} should parse`).toBe(true);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, 42, "scenario", [], {}, { id: 1 }]) {
      expect(() => parseScenario(junk)).not.toThrow();
    }
  });

  it("reports every problem at once, not just the first", () => {
    // Two independent, clearly-named defects.
    const bad = { ...draft(), id: "", duration_s: -5, difficulty: 99 };
    const r = parseScenario(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
    expect(r.issues.join(" ")).toContain("duration_s");
    expect(r.issues.join(" ")).toContain("difficulty");
  });

  it("names the path to each offending field", () => {
    const r = parseScenario({ ...draft(), environment: { terrain: "swamp", time_of_day: "night", weather: "clear", wind_mps: 2 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.startsWith("environment."))).toBe(true);
  });

  it("flags a root-level issue as <root> rather than an empty path", () => {
    const r = parseScenario({ ...draft(), kind: "generated" }); // generated without a family
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.startsWith("<root>") || i.startsWith("family"))).toBe(true);
  });
});

describe("scenario structural rules", () => {
  it("pins the schema version every scripted scenario declares", () => {
    for (const s of SCRIPTED_SCENARIOS) {
      expect(s.schema_version).toBe(SCENARIO_SCHEMA_VERSION);
    }
  });

  it("requires a family on generated scenarios only", () => {
    const gen = { ...draft(), kind: "generated" };
    expect(ScenarioSchema.safeParse(gen).success).toBe(false);
    const genWithFamily = { ...gen, family: "recon_near_asset" };
    expect(ScenarioSchema.safeParse(genWithFamily).success).toBe(true);

    // A scripted scenario with a stray family is tolerated, not an error.
    expect(ScenarioSchema.safeParse({ ...draft(), family: "recon_near_asset" }).success).toBe(true);
  });

  it("caps protected assets at 3 (PRD §8.4)", () => {
    const base = draft();
    const asset = (id: string) => ({
      id, name: id, type: "fuel", pos: [0, 0], priority: 3, impact_radius_m: 15,
    });
    const three = { ...base, assets: [asset("A1"), asset("A2"), asset("A3")] };
    expect(ScenarioSchema.safeParse(three).success).toBe(true);
    const four = { ...base, assets: [...three.assets, asset("A4")] };
    expect(ScenarioSchema.safeParse(four).success).toBe(false);
  });

  it("rejects an inject scheduled past the end of the scenario", () => {
    const base = draft();
    expect(
      ScenarioSchema.safeParse({ ...base, injects: [{ at_t_s: 10, type: "sensor_outage" }] }).success,
    ).toBe(true);
    expect(
      ScenarioSchema.safeParse({ ...base, injects: [{ at_t_s: base.duration_s as number, type: "sensor_outage" }] }).success,
    ).toBe(false);
  });
});

describe("range and tuple invariants", () => {
  const cases = [
    { name: "accepts an ascending second range", value: [8, 20], ok: true },
    { name: "accepts a zero-width second range", value: [10, 10], ok: true },
    { name: "rejects a descending second range", value: [20, 8], ok: false },
    { name: "rejects a negative second range", value: [-1, 8], ok: false },
  ] as const;

  it.each(cases)("$name", ({ value, ok }) => {
    const r = parseScenario({ ...draft(), authority: { ...(draft().authority as object), grant_rule: { min_category: "suspicious", min_confidence: "medium", min_sources: 2, delay_s: value } } });
    expect(r.ok).toBe(ok);
  });

  const tupleCases = [
    { name: "rejects a 1-tuple where a 3-tuple is required", value: [1, 2] },
    { name: "rejects a 4-tuple where a 3-tuple is required", value: [1, 2, 3, 4] },
    { name: "rejects a non-numeric coordinate", value: [1, "2", 3] },
  ] as const;

  it.each(tupleCases)("$name", ({ value }) => {
    const r = parseScenario({ ...draft(), entities: [{ ...(draft().entities as Record<string, unknown>[])[0], pos: value }] });
    expect(r.ok).toBe(false);
  });
});

describe("inject vocabulary", () => {
  it("accepts every FR-SIM-9 inject type", () => {
    for (const type of INJECT_TYPES) {
      const r = parseScenario({ ...draft(), injects: [{ at_t_s: 5, type }] });
      expect(r.ok, `inject type ${type} should be accepted`).toBe(true);
    }
  });

  it("rejects an unknown inject type", () => {
    expect(parseScenario({ ...draft(), injects: [{ at_t_s: 5, type: "launch_missiles" }] }).ok).toBe(false);
  });
});

describe("defaults", () => {
  it("fills optional fields rather than failing on absent ones", () => {
    const minimal = {
      id: "scr-min", kind: "scripted", title: "Minimal", seed: 7, duration_s: 60,
      environment: { terrain: "rural", time_of_day: "day", weather: "clear", wind_mps: 0 },
      assets: [{ id: "A1", name: "Depot", type: "fuel", pos: [0, 0], priority: 1 }],
      observer_post: { pos: [0, 0, 3] },
      sensors: {},
      entities: [{
        id: "D1", archetype: "recon_multirotor", affiliation_truth: "hostile", intent: "recon",
        pos: [100, 0, 50], behaviour: [{ state: "transit", to: [0, 0, 50], speed: 8 }],
      }],
      authority: {
        initial_posture: "TIGHT",
        grant_rule: { min_category: "suspicious", min_confidence: "medium", min_sources: 2, delay_s: [5, 10] },
      },
      expected: { tracks: [], protect: ["A1"] },
    };
    const r = parseScenario(minimal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.sensors.radar).toBe("normal");
    expect(r.scenario.difficulty).toBe(2);
    expect(r.scenario.rubric_id).toBe("default-v1");
    expect(r.scenario.injects).toEqual([]);
    expect(r.scenario.expected.tracks).toEqual([]);
    expect(r.scenario.assets[0]!.impact_radius_m).toBe(15);
    expect(r.scenario.observer_post.sectors).toEqual([]);
    expect(r.scenario.authority.response_assets).toEqual({ available: true, delay_s: 6 });
    expect(r.scenario.brief_sections).toEqual([...BRIEF_SECTIONS]);
  });

  it("offers only the brief headings a scenario actually has", () => {
    // The heading list is what the console renders, so it is authored per scenario.
    // A short scenario with nothing to say about friendly flights should not open
    // an empty panel — and it must not open one the trainee could tick off for
    // credit, which N4 and N9 both pay for.
    const trimmed = draft();
    trimmed["brief_sections"] = ["situation", "authority", "objectives"];
    const r = parseScenario(trimmed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.brief_sections).toEqual(["situation", "authority", "objectives"]);
  });

  it("rejects an empty or unknown brief heading", () => {
    // Table-driven: an empty list leaves the trainee with no way to read the brief
    // at all, and an unrecognised heading would render as a blank tab.
    for (const bad of [[], ["situation", "secrets"], ["SITUATION"]]) {
      const d = draft();
      d["brief_sections"] = bad;
      expect(parseScenario(d).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a scenario with no `expected` block", () => {
    // `expected` is the answer key. Without it the validator cannot decide
    // whether the scenario is solvable and the scorer has nothing to score, so
    // it must fail here rather than silently at the end of a trainee's run.
    const { expected: _expected, ...withoutExpected } = nightRecon01 as unknown as Record<string, unknown>;
    const r = parseScenario(withoutExpected);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join(" ")).toContain("expected");
  });
});