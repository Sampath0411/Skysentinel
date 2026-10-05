/**
 * Validator tests (PRD §5.4 FR-SCN-4, §8.4 rules 1-7).
 *
 * Table-driven where the rules are, per the project rules. Each rule gets the
 * same two-sided treatment: a scenario that must trip it, and a clean scenario
 * that must not. A validator that only ever passes is not evidence of anything,
 * and the failure modes here are the ones that would silently ship an unfair
 * scenario to a trainee.
 */

import { describe, expect, it } from "vitest";

import { fingerprint } from "./fingerprint.js";
import { SCRIPTED_SCENARIOS, nightRecon01 } from "./scripted/index.js";
import type { Scenario } from "./schema.js";
import {
  rule1_threatsDetectable,
  rule2_expectedCategoryKnowable,
  rule3_notAllSensorsDown,
  rule4_hasDistractor,
  rule5_reactionTime,
  rule6_geometryValid,
  rule7_notRecentRepeat,
  validateScenario,
} from "./validate.js";

/** Deep clone so a mutation in one test cannot leak into the next. */
const draft = (base: Scenario = nightRecon01): Scenario =>
  structuredClone(base) as unknown as Scenario;

const codes = (issues: readonly { code: string }[]): string[] => issues.map((i) => i.code);

describe("shipped scenarios", () => {
  it.each(SCRIPTED_SCENARIOS.map((s) => [s.id, s] as const))(
    "%s passes every rule with no issues at all",
    (_id, s) => {
      const r = validateScenario(s as Scenario);
      expect(r.issues).toEqual([]);
      expect(r.valid).toBe(true);
    },
  );

  it("gives the three shipped scenarios distinct fingerprints", () => {
    const fps = SCRIPTED_SCENARIOS.map(fingerprint);
    expect(new Set(fps).size).toBe(SCRIPTED_SCENARIOS.length);
  });
});

describe("rule 1 — every threat must be detectable", () => {
  it("passes a scenario whose threat is clearly visible", () => {
    expect(rule1_threatsDetectable(draft())).toEqual([]);
  });

  it("rejects a threat no sensor can see", () => {
    const s = draft();
    // All sensors off: nothing can see anything, so nothing is solvable.
    s.sensors = { visual: "failed", ir: "failed", radar: "failed", rf: "failed", flight_plan: "failed" };
    expect(codes(rule1_threatsDetectable(s))).toContain("threat_not_detectable");
  });

  it("rejects a threat whose whole path stays in radar shadow", () => {
    const s = draft();
    // RF-silent, and flown at a range where radar and IR both fall under 0.5.
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.rf_emitting = false;
    d1.pos = [1800, 1800, 40];
    d1.behaviour = [{ state: "transit", to: [1850, 1850, 40], speed: 8 }];
    expect(codes(rule1_threatsDetectable(s))).toContain("threat_not_detectable");
  });

  it("reports an expected track naming an entity that does not exist", () => {
    const s = draft();
    s.expected.tracks[0]!.truth_id = "GHOST";
    expect(codes(rule1_threatsDetectable(s))).toContain("expected_track_unknown");
  });

  it("does not require a bird flock to be detectable at all", () => {
    // A distractor nobody ever sees is a legitimate way to keep the map quiet,
    // so rule 1 must skip non-threats rather than demand a sighting.
    const s = draft();
    const birds = s.entities.find((e) => e.id === "B1")!;
    birds.affiliation_truth = "non_uas";
    birds.rf_emitting = false;
    birds.pos = [1900, 1900, 30];
    birds.behaviour = [{ state: "transit", to: [1950, 1950, 30], speed: 10 }];
    const issues = rule1_threatsDetectable(s).filter((i) => i.subject === "B1");
    expect(issues).toEqual([]);
  });
});

describe("rule 2 — a hostile call must be knowable", () => {
  it("passes when two independent channels can corroborate", () => {
    expect(rule2_expectedCategoryKnowable(draft())).toEqual([]);
  });

  it("rejects a hostile expectation with a single possible source", () => {
    const s = draft();
    // Visual-only: in this environment nothing else clears the corroboration bar.
    s.sensors = { visual: "normal", ir: "failed", radar: "failed", rf: "failed", flight_plan: "failed" };
    s.expected.tracks[0]!.correct_category = ["hostile"];
    s.expected.tracks[0]!.hostile_ok = true;
    expect(codes(rule2_expectedCategoryKnowable(s))).toContain("hostile_not_knowable");
  });

  it("does not apply to a track that never claims hostile", () => {
    // night-recon's D1 deliberately expects `suspicious` with hostile_ok false.
    // That is the calibrated call, and rule 2 must not punish it for honesty.
    expect(rule2_expectedCategoryKnowable(draft())).toEqual([]);
  });

  it("judges the whole path, not just the spawn instant", () => {
    // D1 spawns masked behind the city and only emerges on the approach. A
    // validator that sampled t=0 alone would call this unknowable and reject a
    // scenario that is in fact clearly solvable a few seconds later.
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.pos = [1500, 1500, 20];
    d1.behaviour = [
      { state: "terrain_masked_approach", to: [300, -200, 45], speed: 20 },
      { state: "approach_direct", to: [120, -80, 40], speed: 24 },
    ];
    expect(codes(rule2_expectedCategoryKnowable(s))).not.toContain("hostile_not_knowable");
  });
});

describe("rule 3 — not every sensor may be down", () => {
  const cases = [
    { name: "all degraded", modes: ["degraded", "degraded", "degraded", "degraded", "degraded"], code: "all_sensors_unusable" },
    { name: "all failed", modes: ["failed", "failed", "failed", "failed", "failed"], code: "all_sensors_unusable" },
    { name: "two failed at t=0", modes: ["failed", "failed", "normal", "normal", "normal"], code: "too_many_failed_at_start" },
  ] as const;

  it.each(cases)("rejects $name", ({ modes, code }) => {
    const s = draft();
    const [visual, ir, radar, rf, flight_plan] = modes;
    s.sensors = { visual: visual!, ir: ir!, radar: radar!, rf: rf!, flight_plan: flight_plan! };
    expect(codes(rule3_notAllSensorsDown(s))).toContain(code);
  });

  const passing = [
    { name: "all normal", modes: ["normal", "normal", "normal", "normal", "normal"] },
    { name: "one failed, rest usable", modes: ["failed", "normal", "normal", "normal", "normal"] },
    { name: "intermittent counts as usable", modes: ["intermittent", "degraded", "degraded", "degraded", "degraded"] },
  ] as const;

  it.each(passing)("accepts $name", ({ modes }) => {
    const s = draft();
    const [visual, ir, radar, rf, flight_plan] = modes;
    s.sensors = { visual: visual!, ir: ir!, radar: radar!, rf: rf!, flight_plan: flight_plan! };
    expect(rule3_notAllSensorsDown(s)).toEqual([]);
  });
});

describe("rule 4 — a distractor is required from difficulty 2 up", () => {
  it("rejects a scenario with nothing to deconflict against", () => {
    const s = draft();
    s.entities = s.entities.filter((e) => e.affiliation_truth === "hostile");
    expect(codes(rule4_hasDistractor(s))).toContain("no_distractor");
  });

  it("does not require a distractor at difficulty 1", () => {
    const s = draft();
    s.difficulty = 1;
    s.entities = s.entities.filter((e) => e.affiliation_truth === "hostile");
    expect(rule4_hasDistractor(s)).toEqual([]);
  });

  const kinds = ["friendly", "authorised", "non_uas"] as const;

  it.each(kinds)("counts a %s entity as a distractor", (affiliation) => {
    const s = draft();
    s.entities = s.entities.filter((e) => e.affiliation_truth === "hostile");
    s.entities.push({ ...draft().entities.find((e) => e.id === "B1")!, id: "X1", affiliation_truth: affiliation });
    expect(rule4_hasDistractor(s)).toEqual([]);
  });
});

describe("rule 5 — enough time to react", () => {
  it("passes when the gap meets the difficulty's minimum", () => {
    expect(rule5_reactionTime(draft())).toEqual([]);
  });

  it("rejects a threat that arrives moments after it becomes visible", () => {
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    // Sprints in from close range: visible and lethal almost at once.
    d1.pos = [120, 0, 40];
    d1.behaviour = [{ state: "approach_direct", to: [120, -80, 40], speed: 30 }];
    s.expected.tracks[0]!.first_detectable_s = d1.spawn_t_s;
    expect(codes(rule5_reactionTime(s))).toContain("insufficient_reaction_time");
  });

  it("scales the required gap with difficulty", () => {
    const build = (difficulty: number): Scenario => {
      const s = draft();
      s.difficulty = difficulty;
      const d1 = s.entities.find((e) => e.id === "D1")!;
      d1.spawn_t_s = 0;
      d1.pos = [400, 0, 50];
      d1.behaviour = [{ state: "approach_direct", to: [100, 0, 50], speed: 20 }]; // ~15 s flight
      s.expected.tracks[0]!.first_detectable_s = 0;
      return s;
    };
    // 15 s of flight: enough for the level-5 minimum (12 s), not the 25 s that
    // levels 1-4 demand.
    expect(rule5_reactionTime(build(5))).toEqual([]);
    expect(codes(rule5_reactionTime(build(3)))).toContain("insufficient_reaction_time");
  });

  it("ignores a threat that loiters and retreats", () => {
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.behaviour = [
      { state: "orbit_loiter", center: [400, -200, 60], radius: 40, duration_s: 120 },
      { state: "retreat", to: [800, -400, 80], speed: 10 },
    ];
    expect(rule5_reactionTime(s)).toEqual([]);
  });

  it("measures to arrival, not to the start of the approach", () => {
    // The behaviour engine flies a point-to-point step for distance ÷ speed and
    // ignores `duration_s` on it. A validator that trusted `duration_s` here
    // would report a flight time the simulation never actually flies.
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.pos = [0, 600, 50];
    d1.spawn_t_s = 0;
    d1.behaviour = [{ state: "approach_direct", to: [0, 0, 50], speed: 10 }]; // 60 s real
    s.expected.tracks[0]!.first_detectable_s = 0;
    // 60 s of flight clears even the strictest gap.
    expect(rule5_reactionTime(s)).toEqual([]);
  });
});

describe("rule 6 — geometry", () => {
  it("passes a well-formed layout", () => {
    expect(rule6_geometryValid(draft())).toEqual([]);
  });

  it("rejects an entity spawned outside the map", () => {
    const s = draft();
    s.entities[0]!.pos = [5000, 0, 50];
    expect(codes(rule6_geometryValid(s))).toContain("spawn_outside_map");
  });

  it("rejects an asset buried inside a building", () => {
    const s = draft();
    // The origin of this urban seed is the top of a block.
    s.environment = { ...s.environment, terrain: "urban" };
    s.seed = 3003;
    s.assets[0]!.pos = [0, 0];
    expect(codes(rule6_geometryValid(s))).toContain("asset_inside_building");
  });

  it("rejects assets whose impact radii overlap", () => {
    const s = draft();
    s.assets[0]!.pos = [0, 0];
    s.assets[0]!.impact_radius_m = 50;
    s.assets[1]!.pos = [60, 0]; // 60 m apart, radii sum to 100
    expect(codes(rule6_geometryValid(s))).toContain("assets_overlap");
  });

  it("accepts assets separated by more than their radii", () => {
    const s = draft();
    // The positions are picked clear of every entity's programme — put an asset on
    // the logistics flight's corridor and the impact-radius rule fires instead,
    // which says nothing about whether the two radii overlap.
    s.assets[0]!.pos = [-300, 200];
    s.assets[0]!.impact_radius_m = 15;
    s.assets[1]!.pos = [300, 300];
    expect(codes(rule6_geometryValid(s))).toEqual([]);
  });

  it("rejects an entity spawned inside terrain", () => {
    const hills = draft();
    hills.environment = { ...hills.environment, terrain: "rural" };
    hills.entities[0]!.pos = [0, 0, -50]; // below ground
    expect(rule6_geometryValid(hills).some((i) => i.code === "spawn_inside_obstacle")).toBe(true);
  });

  it("rejects a non-attacker that overflies an asset's impact radius", () => {
    // A bird crossing the fuel point would be struck by the impact rule and
    // neutralised — the sim destroys the asset for the trainee.
    const s = draft();
    const birds = s.entities.find((e) => e.id === "B1")!;
    birds.pos = [400, -80, 90];
    birds.behaviour = [{ state: "transit", to: [-400, -80, 90], speed: 10 }];
    expect(codes(rule6_geometryValid(s))).toContain("non_attacker_in_impact_radius");
  });

  it("rejects a reconnaissance whose orbit clips the asset", () => {
    // The behaviour engine snaps an entity onto its orbit circle on the first
    // loiter tick, so a centre clear of the asset with too wide a radius still
    // flies through it. Measuring the centre alone would miss this.
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.behaviour = [
      { state: "transit", to: [180, -80, 45], speed: 9 },
      { state: "orbit_loiter", center: [180, -80, 45], radius: 90, speed: 9, duration_s: 120 },
    ];
    expect(codes(rule6_geometryValid(s))).toContain("non_attacker_in_impact_radius");
  });

  it("exempts an attacker whose programme is meant to close on the asset", () => {
    // Entering the radius is the point of an approach; a rule that forbade it
    // would reject every honest attack scenario in the set.
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.intent = "attack";
    d1.behaviour = [{ state: "approach_direct", to: [120, -80, 40], speed: 12 }];
    expect(codes(rule6_geometryValid(s))).not.toContain("non_attacker_in_impact_radius");
  });

  it("measures a step from where the previous step left the entity", () => {
    // A transit lands the entity on its `to`, and the next step starts there —
    // measuring every step from the spawn point would absolve a programme that
    // loiters on the asset only after an intermediate hop.
    const s = draft();
    const d1 = s.entities.find((e) => e.id === "D1")!;
    d1.behaviour = [
      { state: "transit", to: [1000, 1000, 45], speed: 9 },
      { state: "orbit_loiter", center: [120, -80, 45], radius: 5, speed: 9, duration_s: 120 },
    ];
    expect(codes(rule6_geometryValid(s))).toContain("non_attacker_in_impact_radius");
  });

  it("ignores altitude when measuring overflights", () => {
    // The sim's impact rule is horizontal (`impact.ts`), so a high transit still
    // strikes the asset; the validator must not be talked out of it by altitude.
    const s = draft();
    const birds = s.entities.find((e) => e.id === "B1")!;
    birds.pos = [400, -80, 400];
    birds.behaviour = [{ state: "transit", to: [-400, -80, 400], speed: 10 }];
    expect(codes(rule6_geometryValid(s))).toContain("non_attacker_in_impact_radius");
  });
});

describe("rule 7 — anti-rote", () => {
  it("passes when the fingerprint is not in the recent history", () => {
    expect(rule7_notRecentRepeat(draft(), ["deadbeefdeadbeef"], fingerprint)).toEqual([]);
  });

  it("rejects a fingerprint seen recently", () => {
    const fp = fingerprint(draft());
    expect(codes(rule7_notRecentRepeat(draft(), [fp], fingerprint))).toContain("recent_repeat");
  });

  it("ignores a fingerprint that has aged out of the window", () => {
    const fp = fingerprint(draft());
    // Most recent last: ten unrelated sessions have since pushed it out of the
    // trailing window of ten.
    const history = [fp, ...Array.from({ length: 10 }, (_, i) => `old${i}`)];
    expect(rule7_notRecentRepeat(draft(), history, fingerprint)).toEqual([]);
  });

  it("honours an explicit window", () => {
    const fp = fingerprint(draft());
    const history = Array.from({ length: 10 }, (_, i) => `old${i}`);
    history.push(fp);
    expect(codes(rule7_notRecentRepeat(draft(), history, fingerprint, 20))).toContain("recent_repeat");
  });
});

describe("validateScenario", () => {
  it("aggregates issues across rules and separates errors from warnings", () => {
    const s = draft();
    // Keep difficulty at 2 so rule 4 is active; the distractor removal is the defect.
    s.entities = s.entities.filter((e) => e.affiliation_truth === "hostile"); // trips rule 4
    s.assets[0]!.pos = [0, 0];
    s.environment = { ...s.environment, terrain: "urban" };
    s.seed = 3003; // makes that asset sit inside a block: trips rule 6

    const r = validateScenario(s);
    expect(r.valid).toBe(false);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["no_distractor", "asset_inside_building"]));
    // Removing the non-hostile entities orphaned their expected tracks, and the
    // validator reports that too — a dangling answer key is a real defect.
    expect(codes(r.errors)).toContain("expected_track_unknown");
    expect(r.issues.length).toBeGreaterThanOrEqual(r.errors.length);
  });

  it("is deterministic — the same scenario always yields the same issues", () => {
    const s = draft();
    s.entities[0]!.pos = [9000, 0, 50];
    expect(codes(validateScenario(s).issues)).toEqual(codes(validateScenario(s).issues));
  });
});