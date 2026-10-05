/**
 * The mandated-three card (PRD §12.2).
 *
 * The card replaces three competency point scores with units a person can read —
 * seconds against a par, a percentage, correct-out-of-total. Two obligations follow
 * from it sitting next to the score tree, and both are tested here:
 *
 *   - it must *agree* with the tree: the detection grade is `scoreDetection`'s
 *     verdict, the response counts are the `N7` nodes, the unauthorised count is the
 *     critical-error table. A card that graded a run the tree calls late "at par"
 *     would be two reports of one score;
 *   - it must say what it *means* when the run did not produce a number: a scenario
 *     that cued nothing, a trainee who classified nothing, a track with no authored
 *     par. Each has a grade or note rather than a 0 that reads as failure.
 */

import { describe, expect, it } from "vitest";

import * as fixtures from "./fixtures.js";
import { scoreRun } from "./score.js";
import { detectionSummary, classificationSummary, responseSummary } from "./mandated.js";
import { readRun } from "./log.js";
import { loadRubric } from "./rubric.js";
import { scoreDetection } from "./nodes/detection.js";
import type { ScoreInput, ScoreResult } from "./types.js";

const PAR = { par_response_s: 30 };

const score = (input: ScoreInput): ScoreResult => scoreRun(input, PAR);

/* ============================================================== detection === */

describe("detection summary", () => {
  it("reports the latency against par for the earliest-cued track", () => {
    // The ideal fixture cues drone-hostile at t=1 s and marks it at t=6 s, with a
    // 5 s par — 5 s latency, exactly at par.
    const m = detectionSummary(readRun(fixtures.ideal()));

    expect(m.truth_id).toBe("drone-hostile");
    expect(m.latency_s).toBe(5);
    expect(m.par_s).toBe(5);
    expect(m.grade).toBe("at_par");
  });

  it("grades a late mark late, using the same bands as N3", () => {
    // Table-driven over the three latency bands. The `late` fixture pushes the mark
    // to 41 s against a cue at 1 s — 8× par, well past it — and the other two bands
    // are built by hand from the ideal run's own facts.
    const input = fixtures.late();
    const facts = readRun(input);
    expect(detectionSummary(facts).grade).toBe("well_past_par");

    const rubric = loadRubric();
    for (const [name, markMs, grade] of [
      ["at par", 6_000, "at_par"],
      ["late", 9_000, "late"],
      ["well past par", 20_000, "well_past_par"],
    ] as const) {
      const events = input.events.map((e) =>
        e.type === "contact_marked" && e.payload.cue_or_track_id === "C001"
          ? { ...e, t_ms: markMs }
          : e,
      );
      const f = readRun({ ...input, events });
      const summary = detectionSummary(f);

      // The grade is exactly the verdict the tree's own N3 node prints in its reason.
      const node = scoreDetection(f.tracks[0]!, rubric);
      expect(summary.grade, name).toBe(grade);
      if (node.max_points > 0) {
        expect(node.reason, name).toContain(
          grade === "at_par" ? "at or inside par" : grade === "late" ? "late" : "well past par",
        );
      }
    }
  });

  it("reads 'never marked' when the cues were presented and ignored", () => {
    const m = detectionSummary(readRun(fixtures.oblivious()));

    expect(m.grade).toBe("never_marked");
    expect(m.truth_id).toBe("drone-hostile");
    // No latency is claimed — the card says nothing was detected, not that it was
    // detected infinitely slowly.
    expect(m.latency_s).toBeUndefined();
  });

  it("reads 'never cued' when nothing was ever presented", () => {
    // Drop every cue and the run has no detection story at all. The placeholder id
    // keeps the card's `truth_id` slot populated rather than showing an empty field.
    const input = fixtures.ideal();
    const events = input.events.filter((e) => e.type !== "cue_presented");
    const m = detectionSummary(readRun({ ...input, events }));

    expect(m.grade).toBe("never_cued");
    expect(m.truth_id).toBe("—");
  });

  it("reads 'no par' when the author set no par detection time", () => {
    // A par-less track is not an ungraded failure; the latency is still worth showing
    // because "marked in 5 s" means something even without a standard to beat.
    const input = fixtures.ideal();
    const expected = {
      ...input.expected,
      tracks: input.expected.tracks.map((t) =>
        t.truth_id === "drone-hostile" ? { ...t, par_detect_s: undefined } : t,
      ),
    };
    const m = detectionSummary(readRun({ ...input, expected }));

    expect(m.grade).toBe("no_par");
    expect(m.latency_s).toBe(5);
    expect(m.par_s).toBeUndefined();
  });
});

/* ========================================================= classification === */

describe("classification summary", () => {
  it("scores 100% when every final declaration is defensible", () => {
    const m = classificationSummary(readRun(fixtures.ideal()));

    expect(m.correct).toBe(3);
    expect(m.scored).toBe(3);
    expect(m.accuracy_pct).toBe(100);
    expect(m.confusion_note).toBe("Every final declaration was defensible.");
  });

  it("counts a fraction and names the confusion", () => {
    // The falseHostile fixture declares the friendly flight hostile. The bird is
    // still correct, the hostile track's `suspicious`/`hostile` call is still
    // defensible, so 2 of 3 — and the note names the friendly confusion, which is
    // the one a debrief has to talk about.
    const m = classificationSummary(readRun(fixtures.falseHostile()));

    expect(m.correct).toBe(2);
    expect(m.scored).toBe(3);
    expect(m.accuracy_pct).toBe(67);
    expect(m.confusion_note).toContain("drone-friendly");
    expect(m.confusion_note).toContain("hostile");
    expect(m.confusion_note).toContain("defensible");
  });

  it("reports zero with a note when nothing was classified", () => {
    const m = classificationSummary(readRun(fixtures.oblivious()));

    expect(m.scored).toBe(0);
    expect(m.accuracy_pct).toBe(0);
    // Not "0% accurate" — the distinction between "wrong" and "absent" is the whole
    // reason `scored` is carried separately from `accuracy_pct`.
    expect(m.confusion_note).toBe("No classifications submitted.");
  });

  it("excludes tracks the scenario gave no defensible answer to", () => {
    // `overconfident` narrows the hostile track's expected set but keeps it scored;
    // to test exclusion, take a track out of the expected block entirely. Such a
    // track cannot dilute the percentage either way.
    const input = fixtures.ideal();
    const expected = {
      ...input.expected,
      tracks: input.expected.tracks.filter((t) => t.truth_id !== "drone-bird"),
    };
    const m = classificationSummary(readRun({ ...input, expected }));

    expect(m.scored).toBe(2);
    expect(m.correct).toBe(2);
    expect(m.accuracy_pct).toBe(100);
  });
});

/* ============================================================== response ==== */

describe("response summary", () => {
  it("counts the scored N7 nodes, passing ones as correct", () => {
    const r = score(fixtures.ideal());
    const m = r.mandated.response;

    // Three tracks, all three scored: the hostile one is the response, and standing
    // the friendly flight and the bird down is a decision the tree grades too — a
    // non-hostile contact needing no action is emitted unscored, but a deliberate
    // stand-down is not "no action". All three were permitted and timely.
    expect(m.total).toBe(3);
    expect(m.correct).toBe(3);
    expect(m.unauthorised).toBe(0);
  });

  it("counts an unexecuted response as a failed decision, still one decision", () => {
    const r = score(fixtures.passive());
    const m = r.mandated.response;

    expect(m.total).toBe(1);
    // A hostile contact with no protective action fails the node.
    expect(m.correct).toBe(0);
    // Standing still is not the same as acting without authority.
    expect(m.unauthorised).toBe(0);
  });

  it("counts an unauthorised execution separately from the failed decision", () => {
    const r = score(fixtures.unauthorised());
    const m = r.mandated.response;

    // The two stand-downs still pass, so the run is 2 of 3 correct — and the third
    // field is the one the PS asks for outright: the execution happened with no
    // granted authority, which is a critical error regardless of the points.
    expect(m.total).toBe(3);
    expect(m.correct).toBe(2);
    expect(m.unauthorised).toBe(1);
  });

  it("agrees with the score tree's own N7 nodes", () => {
    // The counts are the tree's, not a second reading of the log — so the card and
    // the expandable tree below it can never disagree.
    for (const name of ["ideal", "late", "passive", "unauthorised", "fratricide"] as const) {
      const r = score(fixtures[name]());
      const n7 = r.nodes.filter((n) => n.id.startsWith("N7.") && n.max_points > 0);
      expect(r.mandated.response.total, name).toBe(n7.length);
      expect(r.mandated.response.correct, name).toBe(n7.filter((n) => n.passed).length);
    }
  });
});

/* ================================================================ wiring ==== */

describe("wiring", () => {
  it("is attached to every ScoreResult", () => {
    for (const name of ["ideal", "late", "overconfident", "passive", "unauthorised", "fratricide"] as const) {
      const m = score(fixtures[name]()).mandated;
      expect(m.detection.grade.length, name).toBeGreaterThan(0);
      expect(m.classification.scored, name).toBeLessThanOrEqual(3);
      expect(Number.isFinite(m.response.total), name).toBe(true);
    }
  });

  it("is pure — the same run yields the same summary", () => {
    const a = score(fixtures.ideal()).mandated;
    const b = score(fixtures.ideal()).mandated;
    expect(a).toEqual(b);
  });

  it("responseSummary reads the nodes it is handed, not the log", () => {
    // The unauthorised count comes from the critical-error table the caller passes,
    // so a caller that has already built one does not pay for a second pass.
    const r = score(fixtures.unauthorised());
    expect(responseSummary(r.nodes, r.critical_errors).unauthorised).toBe(1);
    expect(responseSummary(r.nodes, []).unauthorised).toBe(0);
  });
});
