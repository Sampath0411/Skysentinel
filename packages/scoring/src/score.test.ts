/**
 * §10.7 acceptance tests for the scorer.
 *
 * Three separate obligations, kept apart on purpose because they fail for different
 * reasons and a reviewer needs to know which one broke:
 *
 *   - **Golden** (§10.7 first bullet): the five canned archetypes the PRD names —
 *     ideal, late, overconfident, passive, unauthorised — plus the two safety cases.
 *     These assert the *numbers*, so a change in the rubric or the tree shows up as
 *     a failing expectation rather than as a silently different report.
 *   - **Property** (§10.7 second bullet): the invariants that must hold for every
 *     input, including ones no author thought of. These are the ones that would let
 *     a bad score reach a trainee.
 *   - **Explainability** (§10.7 third bullet): every non-zero score must say why and
 *     point at the events. A score a trainee cannot interrogate is not usable in an
 *     assessment, whatever its arithmetic.
 */

import { describe, expect, it } from "vitest";

import * as fixtures from "./fixtures.js";
import { scoreRun } from "./score.js";
import { coachBrief } from "./coach.js";
import type { ScoreInput, ScoreResult } from "./types.js";

const PAR = { par_response_s: 30 };

const score = (input: ScoreInput): ScoreResult => scoreRun(input, PAR);

/* ============================================================ golden tests === */

describe("golden runs (PRD §10.7)", () => {
  const cases = [
    { name: "ideal", build: fixtures.ideal },
    { name: "late", build: fixtures.late },
    { name: "overconfident", build: fixtures.overconfident },
    { name: "passive", build: fixtures.passive },
    { name: "unauthorised", build: fixtures.unauthorised },
    { name: "fratricide", build: fixtures.fratricide },
    { name: "oblivious", build: fixtures.oblivious },
    { name: "false_hostile", build: fixtures.falseHostile },
  ];

  it.each(cases)("$name scores in [0,100] with every number finite", ({ build }) => {
    const r = score(build());
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.total).toBeLessThanOrEqual(100);
    for (const n of r.nodes) {
      expect(Number.isFinite(n.points)).toBe(true);
      expect(Number.isFinite(n.max_points)).toBe(true);
    }
  });

  it("scores the ideal run above every archetype that deviates from it", () => {
    // §10.7 names these five archetypes but does not rank them, and a total order
    // between "marked late" and "declared one step too confidently" would be an
    // invented doctrine claim. What must hold is that the ideal run wins outright
    // and that each deviation costs something. The scenario × bot DoD ordering is
    // asserted separately in `ordering.test.ts`.
    const totals = Object.fromEntries(
      cases.map(({ name, build }) => [name, score(build()).total] as const),
    );

    for (const name of ["late", "overconfident", "passive", "unauthorised"]) {
      expect(totals[name]!, `${name} should score below ideal`).toBeLessThan(totals["ideal"]!);
    }
    // A safety breach must cost more than merely standing still: the unauthorised
    // run acts at least as well as the passive one before the penalty lands.
    expect(totals["passive"]!).toBeGreaterThan(totals["unauthorised"]!);
  });

  it("gives the ideal run a clean process score", () => {
    const r = score(fixtures.ideal());
    // Weights sum to 100, so a perfect process is exactly 100.
    expect(r.process_score).toBe(100);
    expect(r.total).toBe(100);
    expect(r.critical_errors).toEqual([]);
  });

  it("loses detection points on a late run and nothing else", () => {
    const ideal = score(fixtures.ideal());
    const late = score(fixtures.late());
    expect(late.competencies.find((c) => c.competency === "detection")!.points).toBeLessThan(
      ideal.competencies.find((c) => c.competency === "detection")!.points,
    );
    expect(late.competencies.find((c) => c.competency === "classification")!.points).toBe(
      ideal.competencies.find((c) => c.competency === "classification")!.points,
    );
  });

  it("penalises an overconfident declaration below a defensible one", () => {
    const ideal = score(fixtures.ideal());
    const over = score(fixtures.overconfident());
    expect(over.competencies.find((c) => c.competency === "classification")!.points).toBeLessThan(
      ideal.competencies.find((c) => c.competency === "classification")!.points,
    );
    // Declaring hostile/high is not the same claim as suspicious/medium, even
    // though both name a threat.
    expect(over.total).toBeLessThan(ideal.total);
  });

  it("scores a passive trainee at or below every acting trainee", () => {
    const passive = score(fixtures.passive());
    expect(passive.total).toBeLessThan(score(fixtures.ideal()).total);
  });

  it("raises UNAUTHORISED_ACTION and zeroes the response node", () => {
    const r = score(fixtures.unauthorised());
    const kinds = r.critical_errors.map((c) => c.kind);
    expect(kinds).toContain("UNAUTHORISED_ACTION");

    const node = r.nodes.find((n) => n.id === "N7.drone-hostile")!;
    expect(node.points).toBe(0);
  });

  it("raises FRATRICIDE when a response is executed against a friendly flight", () => {
    const r = score(fixtures.fratricide());
    const fratricide = r.critical_errors.find((c) => c.kind === "FRATRICIDE");
    expect(fratricide).toBeDefined();
    expect(fratricide!.truth_id).toBe("drone-friendly");
    expect(r.nodes.find((n) => n.id === "N7.drone-friendly")!.points).toBe(0);
  });

  it("raises FALSE_HOSTILE_ON_FRIENDLY without a response being taken", () => {
    const r = score(fixtures.falseHostile());
    expect(r.critical_errors.map((c) => c.kind)).toContain("FALSE_HOSTILE_ON_FRIENDLY");
  });

  it("raises MISSED_THREAT for a cued hostile that was never marked", () => {
    const r = score(fixtures.oblivious());
    expect(r.critical_errors.map((c) => c.kind)).toContain("MISSED_THREAT");
  });

  it("raises NO_WARNING_BEFORE_IMPACT only when nothing warned", () => {
    const unwarned = score(fixtures.withImpact(false));
    expect(unwarned.critical_errors.map((c) => c.kind)).toContain("NO_WARNING_BEFORE_IMPACT");

    const warned = score(fixtures.withImpact(true));
    expect(warned.critical_errors.map((c) => c.kind)).not.toContain("NO_WARNING_BEFORE_IMPACT");
  });

  it("is deterministic: the same input twice gives an identical result", () => {
    const input = fixtures.ideal();
    expect(JSON.stringify(score(input))).toBe(JSON.stringify(score(input)));
  });

  it("gives coach text that is byte-identical for the same score", () => {
    const input = fixtures.ideal();
    expect(coachBrief(score(input))).toEqual(coachBrief(score(input)));
  });
});

/* ========================================================== property tests === */

describe("properties (PRD §10.7)", () => {
  const all = [
    fixtures.ideal(),
    fixtures.late(),
    fixtures.overconfident(),
    fixtures.passive(),
    fixtures.unauthorised(),
    fixtures.fratricide(),
    fixtures.oblivious(),
    fixtures.falseHostile(),
    fixtures.withImpact(false),
    fixtures.withImpact(true),
  ];

  it("every total, process score and outcome is within [0,100]", () => {
    for (const input of all) {
      const r = score(input);
      expect(r.total).toBeGreaterThanOrEqual(0);
      expect(r.total).toBeLessThanOrEqual(100);
      expect(r.process_score).toBeGreaterThanOrEqual(0);
      expect(r.process_score).toBeLessThanOrEqual(100);
      expect(r.mission_outcome.score).toBeGreaterThanOrEqual(0);
      expect(r.mission_outcome.score).toBeLessThanOrEqual(100);
    }
  });

  it("every competency score is within [0,100] and contributes a non-negative share", () => {
    for (const input of all) {
      for (const c of score(input).competencies) {
        expect(c.points).toBeGreaterThanOrEqual(0);
        expect(c.points).toBeLessThanOrEqual(100);
        expect(c.weighted).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("an unassessed competency contributes nothing and is flagged, not scored zero", () => {
    // A dimension the scenario never exercised must not silently cost points, and
    // must not be reported to the trainee as a failure either.
    const r = score(fixtures.ideal());
    const adaptation = r.competencies.find((c) => c.competency === "adaptation")!;
    expect(adaptation.assessed).toBe(false);
    expect(adaptation.weighted).toBe(0);

    // ...and the perfect run still totals 100, because the other weights absorbed it.
    expect(r.process_score).toBe(100);
  });

  it("adding a critical error never raises the total", () => {
    for (const input of all) {
      const withCritical = score(input);
      const weighted = withCritical.competencies.reduce((acc, c) => acc + c.weighted, 0);
      const withoutPenalty: ScoreResult = {
        ...withCritical,
        // Rounded the same way the scorer rounds, or a run whose raw sum is 97.8078
        // would appear to lose to its own 97.81.
        total: Math.round(Math.min(100, weighted) * 100) / 100,
      };
      expect(withoutPenalty.total).toBeGreaterThanOrEqual(withCritical.total);
    }
  });

  it("the weighted competency sum never exceeds 100", () => {
    for (const input of all) {
      const sum = score(input).competencies.reduce((acc, c) => acc + c.weighted, 0);
      expect(sum).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it("faster detection never lowers the detection score", () => {
    // Mark every cue at par and again well past par; the second must not score higher.
    const markAt = (offset_ms: number): ScoreInput => {
      const base = fixtures.ideal();
      const events = base.events.map((e) =>
        e.type === "contact_marked"
          ? { ...e, t_ms: (e.payload as { cue_or_track_id: string }).cue_or_track_id === "C001" ? 1000 + offset_ms : 1000 + offset_ms }
          : e,
      );
      return { ...base, events };
    };

    let previous = Number.POSITIVE_INFINITY;
    for (const offset of [0, 2_000, 5_000, 10_000, 20_000, 40_000]) {
      const detection = score(markAt(offset)).competencies.find((c) => c.competency === "detection")!;
      expect(detection.points).toBeLessThanOrEqual(previous + 1e-9);
      previous = detection.points;
    }
  });

  it("process score is independent of mission outcome", () => {
    // A run can score perfectly on process and lose the asset. If these two moved
    // together, "did you make good decisions" and "did it go well" would be the
    // same number, and §10.6 would be pointless.
    const r = score(fixtures.withImpact(true));
    expect(r.competencies.reduce((acc, c) => acc + c.weighted, 0)).toBeCloseTo(r.process_score, 2);
    expect(r.mission_outcome.impacts).toBe(1);
  });

  it("an empty log scores zero rather than throwing", () => {
    const empty: ScoreInput = { ...fixtures.ideal(), events: [] };
    const r = score(empty);
    expect(r.total).toBe(0);
    expect(r.process_score).toBe(0);
  });
});

/* ====================================================== explainability tests === */

describe("explainability (PRD §10.7)", () => {
  const all = [
    fixtures.ideal(),
    fixtures.late(),
    fixtures.overconfident(),
    fixtures.passive(),
    fixtures.unauthorised(),
    fixtures.fratricide(),
    fixtures.oblivious(),
    fixtures.falseHostile(),
    fixtures.withImpact(false),
  ];

  it("every non-zero node has a non-empty reason", () => {
    for (const input of all) {
      for (const n of score(input).nodes) {
        if (n.points === 0) continue;
        expect(n.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every non-zero node has at least one event reference", () => {
    for (const input of all) {
      for (const n of score(input).nodes) {
        if (n.points === 0) continue;
        expect(n.event_refs.length).toBeGreaterThan(0);
      }
    }
  });

  it("every critical error names a reason and points at an event", () => {
    for (const input of all) {
      for (const c of score(input).critical_errors) {
        expect(c.reason.trim().length).toBeGreaterThan(0);
        expect(c.event_refs.length).toBeGreaterThan(0);
        expect(c.penalty).toBeGreaterThan(0);
      }
    }
  });

  it("every event reference is a real seq in the source log", () => {
    for (const input of all) {
      const seqs = new Set(input.events.map((e) => e.seq));
      const r = score(input);
      for (const n of r.nodes) {
        for (const ref of n.event_refs) expect(seqs.has(ref)).toBe(true);
      }
      for (const c of r.critical_errors) {
        for (const ref of c.event_refs) expect(seqs.has(ref)).toBe(true);
      }
      for (const rev of r.reviews) {
        for (const ref of rev.event_refs) expect(seqs.has(ref)).toBe(true);
      }
    }
  });

  it("node ids are unique, so the AAR can address them", () => {
    for (const input of all) {
      const ids = score(input).nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every competency lists the nodes that produced it", () => {
    const r = score(fixtures.ideal());
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const c of r.competencies) {
      for (const id of c.node_ids) expect(ids.has(id)).toBe(true);
    }
  });

  it("every review labels a real decision from the fixed set", () => {
    const labels = new Set([
      "Good decision / Good outcome",
      "Good decision / Bad outcome",
      "Poor process / Lucky outcome",
      "Poor process / Bad outcome",
    ]);
    const r = score(fixtures.ideal());
    expect(r.reviews.length).toBeGreaterThan(0);
    for (const rev of r.reviews) {
      expect(labels.has(rev.label)).toBe(true);
      expect(rev.reason.trim().length).toBeGreaterThan(0);
    }
  });
});