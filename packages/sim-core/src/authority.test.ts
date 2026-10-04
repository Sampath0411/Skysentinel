/**
 * Authority tests (PRD §5.3 FR-DEC-5).
 *
 * Two properties matter and they pull against each other: the rule must be
 * *obtainable* (a trainee who does the work can get permission) and *meaningful*
 * (an unsupported claim does not get permission). A rule that is too strict trains
 * operators to give up on the process; one that is too loose trains them to ask
 * for permission as a formality.
 *
 * Table-driven, per the project rules.
 */

import { describe, expect, it } from "vitest";

import type { ClassificationCategory, Confidence } from "@skysentinel/shared";

import {
  CATEGORY_RANK,
  CONFIDENCE_RANK,
  evaluateAuthority,
  pickDelayMs,
  createAuthority,
  makeRequest,
  type GrantRule,
} from "./authority.js";

const RULE: GrantRule = {
  min_category: "suspicious",
  min_confidence: "medium",
  min_sources: 2,
  delay_s: [5, 15],
};

describe("category and confidence ranking", () => {
  it("ranks de-escalating calls below unknown", () => {
    // A trainee must not obtain response authority by declaring an entity
    // friendly. That would make the grant rule satisfiable by the one call that
    // most clearly argues against needing a response at all.
    for (const c of ["friendly", "authorised", "non_uas"] as const) {
      expect(CATEGORY_RANK[c]).toBeLessThan(CATEGORY_RANK.unknown);
    }
  });

  it("orders the escalating calls", () => {
    expect(CATEGORY_RANK.unknown).toBeLessThan(CATEGORY_RANK.suspicious);
    expect(CATEGORY_RANK.suspicious).toBeLessThan(CATEGORY_RANK.hostile);
  });

  it("orders confidence monotonically", () => {
    expect(CONFIDENCE_RANK.low).toBeLessThan(CONFIDENCE_RANK.medium);
    expect(CONFIDENCE_RANK.medium).toBeLessThan(CONFIDENCE_RANK.high);
  });
});

describe("evaluateAuthority", () => {
  const passing = [
    { name: "meets every threshold exactly", category: "suspicious", confidence: "medium", sources: 2 },
    { name: "exceeds every threshold", category: "hostile", confidence: "high", sources: 5 },
  ] as const;

  it.each(passing)("grants when the request $name", ({ category, confidence, sources }) => {
    const d = evaluateAuthority(RULE, { category, confidence, sources });
    expect(d.granted).toBe(true);
    expect(d.reason).toMatch(/Met the grant rule/);
  });

  const failing = [
    {
      name: "falls short on category",
      category: "unknown" as ClassificationCategory,
      confidence: "high" as Confidence,
      sources: 4,
      match: /does not meet the required category/,
    },
    {
      name: "falls short on confidence",
      category: "hostile" as ClassificationCategory,
      confidence: "low" as Confidence,
      sources: 4,
      match: /below the required/,
    },
    {
      name: "falls short on corroboration",
      category: "hostile" as ClassificationCategory,
      confidence: "high" as Confidence,
      sources: 1,
      match: /corroborating sensor/,
    },
    {
      name: "declares a friendly entity",
      category: "friendly" as ClassificationCategory,
      confidence: "high" as Confidence,
      sources: 5,
      match: /does not meet the required category/,
    },
  ] as const;

  it.each(failing)("refuses when the request $name", ({ category, confidence, sources, match }) => {
    const d = evaluateAuthority(RULE, { category, confidence, sources });
    expect(d.granted).toBe(false);
    expect(d.reason).toMatch(match);
  });

  it("always explains itself", () => {
    // An unexplained refusal is unlearnable: the AAR has nothing to show.
    for (const category of ["friendly", "unknown", "hostile"] as const) {
      for (const confidence of ["low", "high"] as const) {
        expect(evaluateAuthority(RULE, { category, confidence, sources: 0 }).reason.length)
          .toBeGreaterThan(10);
      }
    }
  });

  it("is pure — the same request always decides the same way", () => {
    const req = { category: "hostile" as const, confidence: "high" as const, sources: 3 };
    expect(evaluateAuthority(RULE, req)).toEqual(evaluateAuthority(RULE, req));
  });
});

describe("pickDelayMs", () => {
  it("stays inside the rule's window", () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const ms = pickDelayMs(RULE, draw);
      expect(ms).toBeGreaterThanOrEqual(5000);
      expect(ms).toBeLessThanOrEqual(15000);
    }
  });

  it("maps the endpoints of the draw onto the window endpoints", () => {
    expect(pickDelayMs(RULE, 0)).toBe(5000);
    expect(pickDelayMs(RULE, 1)).toBe(15000);
  });

  it("is monotonic in the draw", () => {
    let last = 0;
    for (const draw of [0, 0.2, 0.4, 0.6, 0.8]) {
      const ms = pickDelayMs(RULE, draw);
      expect(ms).toBeGreaterThanOrEqual(last);
      last = ms;
    }
  });

  it("clamps an out-of-range draw rather than returning a nonsense delay", () => {
    expect(pickDelayMs(RULE, -1)).toBe(5000);
    expect(pickDelayMs(RULE, 2)).toBeGreaterThanOrEqual(5000);
  });

  it("returns an integer number of milliseconds", () => {
    for (const draw of [0.1, 0.333, 0.777]) expect(Number.isInteger(pickDelayMs(RULE, draw))).toBe(true);
  });
});

describe("authority state", () => {
  let draw = 0;
  const state = () => {
    draw = 0;
    return createAuthority({ posture: "HOLD", rule: RULE, nextDraw: () => draw++ / 100 });
  };

  it("settles nothing before the delay has elapsed", () => {
    const a = state();
    const request = makeRequest({
      track_id: "T001",
      t_ms: 0,
      rule: RULE,
      category: "hostile",
      confidence: "high",
      sources: 3,
      draw: 0.5,
    });
    a.queue(request);
    expect(a.settle(4_999, RULE)).toEqual([]);
    expect(a.pending()).toHaveLength(1);
  });

  it("settles and grants once the delay has elapsed", () => {
    const a = state();
    const request = makeRequest({
      track_id: "T001",
      t_ms: 0,
      rule: RULE,
      category: "hostile",
      confidence: "high",
      sources: 3,
      draw: 0.5,
    });
    a.queue(request);
    const settled = a.settle(request.resolves_at_ms, RULE);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.decision.granted).toBe(true);
    expect(a.granted.has("T001")).toBe(true);
    expect(a.pending()).toHaveLength(0);
  });

  it("does not grant on a refusal", () => {
    const a = state();
    const request = makeRequest({
      track_id: "T001",
      t_ms: 0,
      rule: RULE,
      category: "unknown",
      confidence: "low",
      sources: 1,
      draw: 0,
    });
    a.queue(request);
    a.settle(request.resolves_at_ms, RULE);
    expect(a.granted.has("T001")).toBe(false);
  });

  it("supersedes a previous request for the same track", () => {
    // Two requests for one track must resolve to the later case, or authority
    // would be granted on grounds the trainee has since withdrawn.
    const a = state();
    const first = makeRequest({
      track_id: "T001",
      t_ms: 0,
      rule: RULE,
      category: "hostile",
      confidence: "high",
      sources: 3,
      draw: 0,
    });
    const second = makeRequest({
      track_id: "T001",
      t_ms: 1_000,
      rule: RULE,
      category: "unknown",
      confidence: "low",
      sources: 1,
      draw: 0.9,
    });
    a.queue(first);
    a.queue(second);
    expect(a.pending()).toHaveLength(1);
    a.settle(second.resolves_at_ms, RULE);
    expect(a.granted.has("T001")).toBe(false);
  });

  it("settles several due requests in the order they were made", () => {
    const a = state();
    for (const id of ["T001", "T002", "T003"]) {
      a.queue(
        makeRequest({
          track_id: id,
          t_ms: 0,
          rule: RULE,
          category: "hostile",
          confidence: "high",
          sources: 3,
          draw: 0.5,
        }),
      );
    }
    const settled = a.settle(20_000, RULE);
    expect(settled.map((s) => s.request.track_id)).toEqual(["T001", "T002", "T003"]);
  });

  it("settles only what is due, leaving later requests pending", () => {
    const a = state();
    a.queue(
      makeRequest({
        track_id: "T001",
        t_ms: 0,
        rule: RULE,
        category: "hostile",
        confidence: "high",
        sources: 3,
        draw: 0,
      }),
    );
    a.queue(
      makeRequest({
        track_id: "T002",
        t_ms: 10_000,
        rule: RULE,
        category: "hostile",
        confidence: "high",
        sources: 3,
        draw: 1,
      }),
    );
    expect(a.settle(6_000, RULE).map((s) => s.request.track_id)).toEqual(["T001"]);
    expect(a.pending()).toHaveLength(1);
  });

  it("takes its delay draws from the supplied stream, not a global one", () => {
    // Authority latency must not perturb the sensor streams (D1): the caller
    // supplies the draw, so this is structurally true rather than merely intended.
    const draws: number[] = [];
    const a = createAuthority({
      posture: "HOLD",
      rule: RULE,
      nextDraw: () => {
        draws.push(0.5);
        return 0.5;
      },
    });
    const before = draws.length;
    a.queue(
      makeRequest({
        track_id: "T001",
        t_ms: 0,
        rule: RULE,
        category: "hostile",
        confidence: "high",
        sources: 3,
        draw: 0.5,
      }),
    );
    expect(draws.length).toBe(before);
  });
});