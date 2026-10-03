import { describe, expect, it } from "vitest";

import type { Millis } from "@skysentinel/shared";

import {
  GATE_BEARING_DEG,
  TRACK_TIMEOUT_MS,
  createTracker,
  fuseConfidence,
  toTraineeTrack,
  withinGate,
  type Track,
} from "./fusion.js";
import { assessKnowability, explainKnowability, scoreDeclaration } from "./knowability.js";
import type { Observation } from "./sensors/types.js";

const obs = (over: Partial<Observation> = {}): Observation => ({
  sensor: "radar",
  obs_id: "o1",
  truth_ref: "d1",
  bearing_deg: 90,
  range_m: 1000,
  speed_mps: 10,
  confidence: 0.5,
  t_ms: 0,
  ...over,
});

const track = (over: Partial<Track> = {}): Track => ({
  track_id: "T001",
  status: "confirmed",
  bearing_deg: 90,
  range_m: 1000,
  speed_mps: 10,
  confidence: 0.7,
  sources: ["radar", "visual"],
  first_seen_ms: 0,
  last_seen_ms: 0,
  truth_ref: "d1",
  evidence: [],
  best_by_source: new Map(),
  ...over,
});

describe("correlation gate (PRD §9.3)", () => {
  it("accepts observations inside the bearing and range gate", () => {
    expect(withinGate(obs({ bearing_deg: 90 }), obs({ bearing_deg: 90 + GATE_BEARING_DEG - 1 }))).toBe(true);
    expect(withinGate(obs({ range_m: 1000 }), obs({ range_m: 1000 + 140 }))).toBe(true);
  });

  it("rejects observations outside the bearing gate", () => {
    expect(withinGate(obs({ bearing_deg: 0 }), obs({ bearing_deg: 90 }))).toBe(false);
    // The gate wraps correctly across north.
    expect(withinGate(obs({ bearing_deg: 1 }), obs({ bearing_deg: 359 }))).toBe(true);
    expect(withinGate(obs({ bearing_deg: 1 }), obs({ bearing_deg: 350 }))).toBe(false);
  });

  it("rejects observations outside the range gate", () => {
    expect(withinGate(obs({ range_m: 1000 }), obs({ range_m: 1200 }))).toBe(false);
  });

  it("uses the absolute range tolerance at short range", () => {
    // At 200 m, ±15% is only ±30 m, so the ±150 m floor governs.
    expect(withinGate(obs({ range_m: 200 }), obs({ range_m: 340 }))).toBe(true);
    expect(withinGate(obs({ range_m: 200 }), obs({ range_m: 400 }))).toBe(false);
  });

  it("compares bearing only when range is unmeasured", () => {
    expect(withinGate(obs({ bearing_deg: 90, range_m: undefined }), obs({ bearing_deg: 95, range_m: 99999 }))).toBe(true);
  });
});

describe("confidence fusion", () => {
  it("rises with the number of independent sources", () => {
    expect(fuseConfidence([0.5])).toBeCloseTo(0.5, 5);
    expect(fuseConfidence([0.5, 0.5])).toBeCloseTo(0.75, 5);
    expect(fuseConfidence([0.5, 0.5, 0.5])).toBeCloseTo(0.875, 5);
    expect(fuseConfidence([0.5, 0.5, 0.5, 0.5])).toBeGreaterThan(fuseConfidence([0.5, 0.5]));
  });

  it("diminishes: the second source helps more than the fourth", () => {
    const second = fuseConfidence([0.5, 0.5]) - fuseConfidence([0.5]);
    const fourth = fuseConfidence([0.5, 0.5, 0.5, 0.5]) - fuseConfidence([0.5, 0.5, 0.5]);
    expect(second).toBeGreaterThan(fourth);
  });

  it("is bounded to [0, 1)", () => {
    expect(fuseConfidence([])).toBe(0);
    for (const c of [0.1, 0.5, 0.9, 0.99]) {
      expect(fuseConfidence([c, c, c, c, c])).toBeLessThan(1);
      expect(fuseConfidence([c, c])).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("tracker", () => {
  it("correlates observations from two sensors into one confirmed track", () => {
    const t = createTracker();
    const tracks = t.update([
        obs({ sensor: "radar", obs_id: "a", bearing_deg: 90, confidence: 0.6 }),
        obs({ sensor: "visual", obs_id: "b", bearing_deg: 93, range_m: undefined, confidence: 0.5 }),
      ]);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.sources.sort()).toEqual(["radar", "visual"]);
    expect(tracks[0]!.status).toBe("confirmed");
    expect(tracks[0]!.confidence).toBeGreaterThan(0.6);
  });

  it("keeps distant targets on separate tracks", () => {
    const t = createTracker();
    const tracks = t.update([obs({ obs_id: "a", bearing_deg: 0 }), obs({ obs_id: "b", bearing_deg: 180 })]);
    expect(tracks).toHaveLength(2);
  });

  it("does not let one sensor's repeats inflate confidence", () => {
    // One radar return at 0.9, and twenty of them at 0.9, must give the same
    // confidence: repeated looks at the same thing are not independent evidence.
    const single = createTracker().update([obs({ obs_id: "a", confidence: 0.9 })])[0]!.confidence;
    const repeated = createTracker().update(
      Array.from({ length: 20 }, (_, i) => obs({ obs_id: `a${i}`, sensor: "radar", confidence: 0.9 })),
    )[0]!.confidence;

    expect(repeated).toBeCloseTo(single, 6);

    // And corroboration from a second sensor must still raise it.
    const corroborated = createTracker().update(
      [
        obs({ obs_id: "a", sensor: "radar", confidence: 0.9 }),
        obs({ obs_id: "b", sensor: "visual", confidence: 0.5, range_m: undefined, bearing_deg: 92 }),
      ],
    )[0]!.confidence;
    expect(corroborated).toBeGreaterThan(single);
  });

  it("marks a track lost after the timeout and reacquired when it returns", () => {
    const t = createTracker();
    t.update([obs({ obs_id: "a" })]);

    const after = t.tick(TRACK_TIMEOUT_MS + 500);
    expect(after[0]!.status).toBe("lost");

    const back = t.update([obs({ obs_id: "b", bearing_deg: 91 })]);
    expect(back[0]!.status).toBe("reacquired");
  });

  it("numbers tracks stably for a given observation set", () => {
    const run = () => {
      const t = createTracker();
      return t
        .update([obs({ obs_id: "z" }), obs({ obs_id: "y", bearing_deg: 200 }), obs({ obs_id: "x", bearing_deg: 300 })])
        .map((x) => x.track_id);
    };
    expect(run()).toEqual(run());
    expect(run()[0]).toBe("T001");
  });

  it("a false alarm carries no truth reference", () => {
    const t = createTracker();
    const tracks = t.update([obs({ obs_id: "fa", truth_ref: "", bearing_deg: 45 })]);
    expect(tracks[0]!.truth_ref).toBeNull();
  });

  it("resets cleanly", () => {
    const t = createTracker();
    t.update([obs()]);
    t.reset();
    expect(t.tracks()).toHaveLength(0);
    expect(t.update([obs()])[0]!.track_id).toBe("T001");
  });
});

describe("trainee track view", () => {
  it("never carries truth_ref", () => {
    const view = toTraineeTrack(track({ truth_ref: "drone-7" }));
    expect(JSON.stringify(view)).not.toContain("drone-7");
    expect(JSON.stringify(view)).not.toContain("truth_ref");
  });

  it("preserves what the trainee legitimately sees", () => {
    const view = toTraineeTrack(track());
    expect(view.bearing_deg).toBe(90);
    expect(view.confidence).toBe(0.7);
    expect(view.sources).toEqual(["radar", "visual"]);
  });
});

describe("knowability (PRD §9.4, FR-SCR-7)", () => {
  it("a single radar return is medium, two sensors is high", () => {
    const single = assessKnowability(track({ status: "new", sources: ["radar"], confidence: 0.6 }));
    const multi = assessKnowability(track({ status: "confirmed", sources: ["radar", "visual"], confidence: 0.8 }));
    expect(single.band).toBe("medium");
    expect(multi.band).toBe("high");
  });

  it("a weak detection is low and expects unknown", () => {
    const weak = assessKnowability(track({ status: "new", sources: ["visual"], confidence: 0.3, range_m: undefined }));
    expect(weak.band).toBe("low");
    expect(weak.expected_affiliation).toBe("unknown");
  });

  it("scores an honest unknown above an unsupported confident call", () => {
    const k = assessKnowability(track({ status: "new", sources: ["visual"], confidence: 0.3, range_m: undefined }));

    const honest = scoreDeclaration("unknown", k);
    const overconfident = scoreDeclaration("hostile", k);

    // This is the core fair-scoring property: on thin evidence, admitting
    // uncertainty beats asserting a call the evidence cannot support.
    expect(honest).toBeGreaterThan(overconfident);
    expect(honest).toBe(1);
  });

  it("rewards the right call when the evidence supports one", () => {
    const k = assessKnowability(track({ status: "confirmed", sources: ["radar", "visual"], confidence: 0.85 }));
    expect(k.expected_affiliation).toBe("hostile");
    expect(scoreDeclaration("hostile", k)).toBe(1);
    expect(scoreDeclaration("unknown", k)).toBeLessThan(1);
  });

  it("caution on a medium single-sensor track is only partial credit", () => {
    const k = assessKnowability(track({ status: "new", sources: ["radar"], confidence: 0.6 }));
    expect(k.band).toBe("medium");
    // Medium + single sensor cannot support a call, so unknown is the honest answer.
    expect(k.expected_affiliation).toBe("unknown");
  });

  it("always produces a non-empty explanation", () => {
    for (const k of [
      assessKnowability(track({ status: "new", sources: ["visual"], confidence: 0.3, range_m: undefined })),
      assessKnowability(track({ status: "confirmed", sources: ["radar", "visual"], confidence: 0.9 })),
    ]) {
      expect(explainKnowability(k).length).toBeGreaterThan(0);
      expect(explainKnowability(k)).toContain("Evidence");
    }
  });

  it("scores are always within [0, 1]", () => {
    const k = assessKnowability(track());
    for (const d of ["hostile", "friendly", "authorised", "non_uas", "unknown"] as const) {
      const s = scoreDeclaration(d, k);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("determinism", () => {
  it("the same observation set produces the same tracks", () => {
    const run = () => {
      const t = createTracker();
      for (let i = 0; i < 20; i++) {
        const m = (i * 50) as Millis;
        t.update([
            obs({ obs_id: `r${i}`, bearing_deg: 90 + i * 0.5, t_ms: m }),
            obs({ obs_id: `v${i}`, sensor: "visual", bearing_deg: 92 + i * 0.5, range_m: undefined, t_ms: m }),
          ]);
        t.tick(m);
      }
      return JSON.stringify(t.tracks());
    };
    expect(run()).toBe(run());
  });
});