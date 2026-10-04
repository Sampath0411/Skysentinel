/**
 * The M4 Definition of Done, asserted end to end (PRD §14 M4, §10.7).
 *
 * `score.test.ts` in the scoring package proves the scorer responds correctly to a
 * *shaped* log. This file proves the thing that actually matters to a customer:
 * that the scorer ranks five real trainees in the right order, on real scenarios,
 * driven through the same control surface a trainee client uses.
 *
 * It lives here rather than in `scoring` because this is the only package that
 * legitimately holds both halves of the problem — the run and the answer key. The
 * dependency runs bots → scoring, so the test cannot go the other way.
 *
 * The required order is `expert > novice > passive ≈ random > trigger_happy`.
 * Two parts of that are strict and one is deliberately not:
 *
 *   - `trigger_happy` must come last, every time. It is the profile that acts
 *     without authority, and the safety rules in N7 are absolute rather than
 *     weighted. A scorer that let a fast, decisive bot outscore a disciplined one
 *     would be teaching the wrong thing, so this is asserted without a margin.
 *   - `passive` and `random` are *not* separated. Nothing in the rubric rewards the
 *     difference between watching and acting at random — PRD §10.2 scores both as
 *     weak response behaviour — so asserting an order between them would be
 *     inventing a doctrine distinction the PRD does not make. They are asserted to
 *     be within a band of each other instead.
 *
 * ## Why the bands are asserted across scenarios, not within one
 *
 * Per scenario, a two-track exercise cannot resolve these two profiles, and asking
 * it to is asking the test to be lucky rather than correct. `random` picks its
 * category uniformly from six; on a scenario with two tracks it has a one-in-six
 * chance of naming the friendly's category correctly on any given run, and that
 * single guess is worth up to 16 points of the 25-weight classification competency.
 * If it also reports both tracks it collects the entire 10-weight reporting
 * competency, which `passive` does not. Thirteen points of swing, arriving from a
 * coin flip, is variance in the measurement — not a scorer that has formed an
 * opinion about passivity.
 *
 * So the ordering is asserted on the mean across all three scripted scenarios
 * (fifteen runs, every one of which the bot suite already has to run for the
 * regression tests), and only the two structural invariants — expert above novice,
 * and `trigger_happy` last — are asserted per scenario, because those hold
 * regardless of what any individual bot happened to guess.
 */

import { describe, expect, it } from "vitest";

import { SCRIPTED_SCENARIOS, SCRIPTED_SCENARIO_IDS } from "@skysentinel/scenario";
import { scoreRun, type ScoreResult } from "@skysentinel/scoring";

import { BOT_NAMES, type BotName } from "./policy.js";
import { runScenario } from "./run.js";
import { scoreInputFor } from "./score-input.js";

/** Par response time, so `response` is scored the same way for every bot. */
const PAR = { par_response_s: 30 };

/**
 * How far apart two mean scores may be and still count as "about the same".
 *
 * The reporting competency's full weight, PRD §10.2. Not a fudge factor: it is the
 * largest the gap can honestly be, because reporting is the *only* dimension on
 * which the PRD separates passive from random — both are scored as weak on every
 * other one. A band narrower than one whole competency would be asserting that the
 * scorer can tell these two apart better than the rubric can.
 *
 * Set against the observed means (36.8 passive, 29.9 random) this is satisfied with
 * room to spare, and it would still catch the failure it exists to catch: a scorer
 * that scored passivity itself, rather than the acts of watching, would open a gap
 * far wider than one competency.
 */
const TIE_BAND = 10;

const scoreMatrix = (scenario_id: string): Map<BotName, ScoreResult> => {
  const scenario = SCRIPTED_SCENARIOS.find((s) => s.id === scenario_id);
  if (!scenario) throw new Error(`No scripted scenario "${scenario_id}"`);
  const out = new Map<BotName, ScoreResult>();
  for (const bot of BOT_NAMES) {
    const result = runScenario({ scenario, bot });
    out.set(bot, scoreRun(scoreInputFor(scenario, result), PAR));
  }
  return out;
};

describe("M4 DoD: score ordering (PRD §14 M4)", () => {
  // Precomputed once: three scenarios × five bots is fifteen full simulations, and
  // the assertions below all read the same runs.
  const matrix = new Map(SCRIPTED_SCENARIO_IDS.map((id) => [id, scoreMatrix(id)] as const));

  const total = (scenario_id: string, bot: BotName): number =>
    matrix.get(scenario_id)!.get(bot)!.total;

  /** Mean total for a bot across every scripted scenario. */
  const mean = (bot: BotName): number =>
    SCRIPTED_SCENARIO_IDS.reduce((sum, id) => sum + total(id, bot), 0) /
    SCRIPTED_SCENARIO_IDS.length;

  it("has a result for every scenario and bot", () => {
    expect(SCRIPTED_SCENARIO_IDS.length).toBe(3);
    for (const id of SCRIPTED_SCENARIO_IDS) {
      expect([...matrix.get(id)!.keys()].sort()).toEqual([...BOT_NAMES].sort());
    }
  });

  for (const id of SCRIPTED_SCENARIO_IDS) {
    describe(id, () => {
      it("scores every bot within [0,100] with a finite breakdown", () => {
        for (const bot of BOT_NAMES) {
          const r = matrix.get(id)!.get(bot)!;
          expect(Number.isFinite(r.total), `${bot} total`).toBe(true);
          expect(r.total).toBeGreaterThanOrEqual(0);
          expect(r.total).toBeLessThanOrEqual(100);
          for (const c of r.competencies) {
            expect(Number.isFinite(c.points), `${bot}/${c.competency} points`).toBe(true);
            expect(c.points).toBeGreaterThanOrEqual(0);
            expect(c.points).toBeLessThanOrEqual(100);
          }
        }
      });

      it("ranks expert above novice", () => {
        // Structural, so it is asserted per scenario: a trainee who corroborates,
        // classifies honestly, waits for authority and reports properly is ahead of
        // one who guesses, and no plausible arrangement of two or three contacts
        // reverses that.
        expect(total(id, "expert")).toBeGreaterThan(total(id, "novice"));
      });

      it("ranks trigger_happy last, without exception", () => {
        const lowest = Math.min(...BOT_NAMES.map((b) => total(id, b)));
        expect(total(id, "trigger_happy")).toBe(lowest);
      });

      it("is deterministic: re-running the same bot gives the same total", () => {
        // Scorer-level determinism, on one pair rather than fifteen. The run level
        // is already asserted log-hash-for-log-hash in `bots.test.ts`, and fifteen
        // extra full simulations (the longest scenario is 900 s at 20 Hz) would cost
        // more wall clock than the property is worth.
        const scenario = SCRIPTED_SCENARIOS.find((s) => s.id === id)!;
        const a = scoreRun(scoreInputFor(scenario, runScenario({ scenario, bot: "expert" })), PAR);
        const b = scoreRun(scoreInputFor(scenario, runScenario({ scenario, bot: "expert" })), PAR);
        expect(b.total).toBe(a.total);
      });
    });
  }

  describe("across all scenarios", () => {
    it("ranks expert above novice above the passive and random band", () => {
      // The §10.7 ordering, on the aggregate. Fifteen runs, so a lucky category
      // guess on one two-track scenario cannot decide the result on its own.
      expect(mean("expert")).toBeGreaterThan(mean("novice"));
      expect(mean("novice")).toBeGreaterThan(Math.max(mean("passive"), mean("random")));
    });

    it("leaves passive and random within a band of each other", () => {
      // Asserted as a band, not an order: PRD §10.2 scores both as weak response
      // behaviour and makes no distinction between them.
      expect(Math.abs(mean("passive") - mean("random"))).toBeLessThanOrEqual(TIE_BAND);
    });

    it("ranks trigger_happy last, without exception", () => {
      const lowest = Math.min(...BOT_NAMES.map(mean));
      expect(mean("trigger_happy")).toBe(lowest);
    });

    it("spreads the profiles across the score range", () => {
      // A guard on the whole table: if every bot scored the same, every ordering
      // assertion above would pass trivially and the suite would say nothing.
      // `trigger_happy` is floored at zero because the critical penalties are real
      // and not clamped away, which is the point of the profile.
      expect(mean("expert")).toBeGreaterThan(50);
      expect(mean("trigger_happy")).toBe(0);
    });
  });

  it("never lets a bot that acted without authority score above one that sought it", () => {
    // The safety invariant, stated as a score rather than as a code path: the
    // critical-error penalties must actually bite. If a future rubric edit reduced
    // UNAUTHORISED_ACTION to a rounding error, this fails rather than the AAR
    // quietly rewarding a fratricide.
    for (const id of SCRIPTED_SCENARIO_IDS) {
      const trigger = matrix.get(id)!.get("trigger_happy")!;
      const expert = matrix.get(id)!.get("expert")!;
      expect(trigger.total).toBeLessThan(expert.total);
    }
  });
});