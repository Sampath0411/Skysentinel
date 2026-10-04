/**
 * Score-input fixtures for the §10.7 acceptance tests.
 *
 * These build event logs directly rather than running a bot, because the acceptance
 * tests are about the scorer's response to a *shaped* log — an ideal run, a late one,
 * an unauthorised one. Driving them from real bots would make them depend on bot
 * behaviour, so a policy change would look like a scoring regression.
 *
 * Every helper returns the same `ScoreInput` shape, so a test can take a good run
 * and degrade exactly one thing about it. That is how the property tests hold two
 * runs apart by a single factor.
 */

import type { AnySimEvent, ClassificationCategory, Confidence, ResponseAction } from "@skysentinel/shared";
import type { ExpectedBlock } from "@skysentinel/scenario";

import type { Correlation, ScoreInput, TruthEntity } from "./types.js";

/** An event under construction. `seq` is assigned by `assemble`. */
interface Draft {
  t_ms: number;
  type: string;
  payload: Record<string, unknown>;
  actor?: string;
}

/**
 * Rewrite an assembled stream, keeping the union's payload types intact.
 *
 * Spreading an `AnySimEvent` directly widens its payload's literal types — a
 * rewritten `classification_submitted` stops being assignable to
 * `AnySimEvent`, because `category` becomes `string`. Casting once here keeps every
 * fixture's transformations readable instead of wrapping each one.
 */
const rewrite = (
  events: readonly AnySimEvent[],
  fn: (e: AnySimEvent) => AnySimEvent | null,
): AnySimEvent[] => events.map((e) => fn(e)).filter((e): e is AnySimEvent => e !== null);

export const assemble = (drafts: Draft[]): AnySimEvent[] =>
  drafts.map((d, seq) => ({
    seq,
    t_ms: d.t_ms,
    type: d.type,
    actor: d.actor ?? "trainee",
    visibility: "trainee",
    payload: d.payload,
  })) as unknown as AnySimEvent[];

export const TRUTH: ReadonlyMap<string, TruthEntity> = new Map([
  ["drone-hostile", { id: "drone-hostile", affiliation_truth: "hostile", intent: "payload" }],
  ["drone-friendly", { id: "drone-friendly", affiliation_truth: "friendly", intent: "transit" }],
  ["drone-bird", { id: "drone-bird", affiliation_truth: "non_uas", intent: "foraging" }],
]);

export const EXPECTED: ExpectedBlock = {
  tracks: [
    {
      truth_id: "drone-hostile",
      correct_category: ["suspicious", "hostile"],
      hostile_ok: true,
      first_detectable_s: 0,
      par_detect_s: 5,
      required_report: true,
      warn_before_s: 20,
    },
    {
      truth_id: "drone-friendly",
      correct_category: ["friendly", "authorised"],
      hostile_ok: false,
      first_detectable_s: 0,
      par_detect_s: 8,
      required_report: false,
    },
    {
      truth_id: "drone-bird",
      correct_category: ["non_uas"],
      hostile_ok: false,
      first_detectable_s: 0,
      par_detect_s: 8,
      required_report: false,
    },
  ],
  protect: ["asset-alpha"],
};

const correlation = (): Correlation => ({
  cue_truth: new Map([
    ["C001", "drone-hostile"],
    ["C002", "drone-friendly"],
    ["C003", "drone-bird"],
  ]),
  track_truth: new Map([
    ["T1", "drone-hostile"],
    ["T2", "drone-friendly"],
    ["T3", "drone-bird"],
  ]),
});

const wrap = (events: AnySimEvent[]): ScoreInput => ({
  scenario_id: "scr-fixture",
  seed: 42,
  duration_ms: 120_000,
  events,
  expected: EXPECTED,
  correlation: correlation(),
  truth: TRUTH,
});

const cue = (cue_id: string, t_ms: number): Draft => ({
  t_ms,
  type: "cue_presented",
  payload: { cue_id, sensor: "radar", first_for_truth: true },
});

const track = (track_id: string, t_ms: number, sources: string[]): Draft => ({
  t_ms,
  type: "track_update",
  payload: { track_id, sources, conf: 0.7, status: "confirmed", pos_est: [100, 200, 50] },
});

/**
 * A sensor measurement, carrying the internal `truth_ref` the scorer correlates on.
 *
 * The trainee never sees `truth_ref` — `filterForRole` strips it — but the server
 * keeps the raw stream, which is where scoring happens. The bearing/range here is
 * what the reports are measured against.
 */
const observe = (truth_id: string, t_ms: number, bearing_deg: number, range_m: number): Draft => ({
  t_ms,
  type: "sensor_observation",
  payload: {
    sensor: "radar",
    obs_id: `o-${truth_id}-${t_ms}`,
    truth_ref: truth_id,
    bearing_deg,
    range_m,
    alt_m: 120,
    conf: 0.8,
    is_false: false,
  },
});

const mark = (cue_id: string, t_ms: number): Draft => ({
  t_ms,
  type: "contact_marked",
  payload: { cue_or_track_id: cue_id },
});

export const classify = (
  track_id: string,
  category: ClassificationCategory,
  confidence: Confidence,
  t_ms: number,
  is_reclassification = false,
): Draft => ({
  t_ms,
  type: "classification_submitted",
  payload: { track_id, category, confidence, evidence: [], is_reclassification },
});

export const act = (action: ResponseAction, track_id: string | undefined, t_ms: number): Draft => ({
  t_ms,
  type: "action_taken",
  payload: { action, ...(track_id ? { target_track_id: track_id } : {}), params: {} },
});

export const report = (track_id: string, t_ms: number, fields: Record<string, unknown>): Draft => ({
  t_ms,
  type: "report_sent",
  payload: { fields, linked_track_id: track_id, delay_ms: 1200 },
});

const brief = (t_ms = 500): Draft => ({
  t_ms,
  type: "brief_viewed",
  payload: { sections_viewed: ["threat", "assets", "flight_plan"] },
});

const grant = (track_id: string, t_ms: number, granted = true): Draft => ({
  t_ms,
  type: "authority_resolved",
  payload: { track_id, granted, reason: granted ? "policy grant" : "denied" },
});

const requestAuthority = (track_id: string, t_ms: number): Draft => ({
  t_ms,
  type: "authority_requested",
  payload: { track_id, posture: "HOLD" },
});

/**
 * The ideal run: every cue marked at par, every contact classified defensibly,
 * a warning raised and authority sought before any response.
 */
export const ideal = (): ScoreInput =>
  wrap(
    assemble([
      brief(),
      cue("C001", 1000),
      cue("C002", 2000),
      cue("C003", 3000),
      track("T1", 1000, ["radar", "visual"]),
      track("T2", 2000, ["radar"]),
      track("T3", 3000, ["visual"]),
      observe("drone-hostile", 10_500, 35, 2400),
      observe("drone-friendly", 10_600, 300, 6000),
      observe("drone-bird", 10_700, 210, 900),
      mark("C001", 6000),
      mark("C002", 7000),
      mark("C003", 7500),
      // Two sensors corroborating is a `high` knowability band (PRD §9.4), so `high`
      // is the confidence the evidence supports here. Anything less is underconfident.
      classify("T1", "suspicious", "high", 8000),
      classify("T2", "friendly", "medium", 9000),
      classify("T3", "non_uas", "medium", 10_000),
      report("T1", 12_000, {
        quantity: 1,
        activity: "payload",
        bearing_deg: 35,
        range_m: 2400,
        description: "Single UAS inbound on the protected side.",
      }),
      // The picture hardens and the COP is updated. N9 credits a current picture, and
      // this is the behaviour that earns it.
      classify("T1", "hostile", "high", 13_000, true),
      report("T1", 13_500, {
        quantity: 1,
        activity: "payload",
        bearing_deg: 34,
        range_m: 2200,
        description: "Escalated to hostile; payload confirmed, closing on asset-alpha.",
      }),
      act("issue_warning", "T1", 15_000),
      act("assign_track_owner", "T1", 15_500),
      requestAuthority("T1", 16_000),
      grant("T1", 18_000),
      act("execute_response", "T1", 20_000),
      act("stand_down", "T2", 21_000),
      act("stand_down", "T3", 22_000),
    ]),
  );

/** Everything right except the timing: contacts marked well past par. */
export const late = (): ScoreInput => {
  const base = ideal();
  // Push the marks out to 40s and 45s after their cues. Same actions, same
  // classifications — only the latency differs.
  const slowed = rewrite(base.events, (e) => {
    if (e.type !== "contact_marked") return e;
    const is_first = e.payload.cue_or_track_id === "C001";
    return { ...e, t_ms: is_first ? 41_000 : 45_000 };
  });
  return { ...base, events: slowed };
};

/**
 * Confident and wrong: `hostile`/`high` declared where only `suspicious` was
 * defensible.
 *
 * The narrowed expected set is the point. Against `["suspicious", "hostile"]` — what
 * the ideal run is scored against — calling it hostile is a *correct* answer to a
 * different question, and the fixture would be testing nothing. Overconfidence is
 * only a failure when the evidence stopped short of the claim, so this run's
 * evidence stops at `suspicious`.
 */
export const overconfident = (): ScoreInput => {
  const base = ideal();
  const expected: ExpectedBlock = {
    ...base.expected,
    tracks: base.expected.tracks.map((t) =>
      t.truth_id === "drone-hostile" ? { ...t, correct_category: ["suspicious"] as const } : t,
    ),
  };
  const rewritten = rewrite(base.events, (e) =>
    e.type === "classification_submitted" && e.payload.track_id === "T1"
      ? ({ ...e, payload: { ...e.payload, category: "hostile", confidence: "high" } } as AnySimEvent)
      : e,
  );
  return { ...base, expected, events: rewritten };
};

/** Watches, never acts. */
export const passive = (): ScoreInput => {
  const base = ideal();
  const kept = base.events.filter(
    (e) =>
      e.type !== "action_taken" &&
      e.type !== "authority_requested" &&
      e.type !== "authority_resolved",
  );
  return { ...base, events: kept };
};

/** Executes a response with no authority ever granted. */
export const unauthorised = (): ScoreInput => {
  const base = ideal();
  const rewritten = rewrite(base.events, (e) => {
    if (e.type === "authority_resolved" || e.type === "authority_requested") return null;
    if (e.type === "action_taken" && e.payload.action === "execute_response") {
      return { ...e, t_ms: 16_000 };
    }
    return e;
  });
  return { ...base, events: rewritten };
};

/** Executes a response against a confirmed friendly flight. */
export const fratricide = (): ScoreInput => {
  const base = ideal();
  const rewritten = rewrite(base.events, (e) => {
    if (e.type !== "action_taken" || e.payload.action !== "stand_down") return e;
    // Drop the friendly stand-down and turn the bird stand-down into an
    // unauthorised execution against the friendly flight.
    if (e.payload.target_track_id === "T2") return null;
    return { ...e, payload: { ...e.payload, action: "execute_response", target_track_id: "T2" } };
  });
  return { ...base, events: rewritten };
};

/** Marks nothing at all. */
export const oblivious = (): ScoreInput => {
  const base = ideal();
  const kept = base.events.filter(
    (e) => e.type !== "contact_marked" && e.type !== "classification_submitted",
  );
  return { ...base, events: kept };
};

/** Declares hostile on the friendly flight. */
export const falseHostile = (): ScoreInput => {
  const base = ideal();
  const rewritten = rewrite(base.events, (e) =>
    e.type === "classification_submitted" && e.payload.track_id === "T2"
      ? ({ ...e, payload: { ...e.payload, category: "hostile", confidence: "high" } } as AnySimEvent)
      : e,
  );
  return { ...base, events: rewritten };
};

/** A run that ends with an impact on the protected asset, warned or not. */
export const withImpact = (warned: boolean): ScoreInput => {
  const base = ideal();

  const impact: AnySimEvent = {
    seq: base.events.length,
    t_ms: 90_000,
    type: "impact",
    actor: "sim",
    visibility: "all",
    payload: { asset_id: "asset-alpha", damage: 0.4 },
  };

  if (!warned) {
    const kept = rewrite(base.events, (e) =>
      e.type === "action_taken" && e.payload.action === "issue_warning" ? null : e,
    );
    return { ...base, events: [...kept, { ...impact, seq: kept.length }] };
  }
  return { ...base, events: [...base.events, impact] };
};

export { brief, grant, observe, requestAuthority };