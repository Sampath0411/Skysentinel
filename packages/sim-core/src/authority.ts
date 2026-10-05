/**
 * Response authority (PRD §5.3 FR-DEC-5, §8.1 `authority.grant_rule`).
 *
 * SAFETY: this module models a *bureaucratic* process — a trainee asks for
 * permission, some fictional rule decides whether it is granted, and a delay
 * passes. It contains no criteria for real use of force, no engagement doctrine,
 * and no threshold that could be read as a Service procedure. The grant rule is a
 * training abstraction authored per scenario and pending SME validation (PRD §22).
 *
 * The two failure modes it exists to produce are the ones the trainer must teach:
 * acting without authority (`UNAUTHORISED_ACTION`) and over-claiming a
 * classification to obtain authority that was not warranted.
 */

import type { ClassificationCategory, Confidence, Millis, Posture } from "@skysentinel/shared";

/**
 * How much a category asserts. Ordering is what makes "at least `suspicious`"
 * expressible: a request justified by a more specific category satisfies a rule
 * written against a weaker one.
 *
 * `friendly`, `authorised` and `non_uas` all sit at 0 — they are *de-escalating*
 * calls, and no amount of asserting one should ever satisfy a rule demanding
 * `suspicious`. Ranking them above `unknown` would mean a trainee could obtain
 * response authority by declaring an entity friendly, which is nonsense.
 */
export const CATEGORY_RANK: Record<ClassificationCategory, number> = {
  friendly: 0,
  authorised: 0,
  non_uas: 0,
  unknown: 1,
  suspicious: 2,
  hostile: 3,
};

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** The scenario-authored rule. Mirrors `AuthoritySchema.grant_rule`. */
export interface GrantRule {
  min_category: ClassificationCategory;
  min_confidence: Confidence;
  /** Distinct corroborating sensors required. */
  min_sources: number;
  /** Resolution delay in seconds, `[min, max]`. */
  delay_s: readonly [number, number];
}

export type AuthorityDecision =
  | { granted: true; reason: string }
  | { granted: false; reason: string };

/**
 * Evaluate a request against the grant rule.
 *
 * Pure and total: every input produces a decision with an explanation, because the
 * explanation is what the AAR shows the trainee for why authority was refused.
 * Failing silently here would make the lesson unlearnable.
 */
export const evaluateAuthority = (
  rule: GrantRule,
  request: { category: ClassificationCategory; confidence: Confidence; sources: number },
): AuthorityDecision => {
  if (CATEGORY_RANK[request.category] < CATEGORY_RANK[rule.min_category]) {
    return {
      granted: false,
      reason: `Declared "${request.category}" does not meet the required category "${rule.min_category}".`,
    };
  }
  if (CONFIDENCE_RANK[request.confidence] < CONFIDENCE_RANK[rule.min_confidence]) {
    return {
      granted: false,
      reason: `Declared confidence "${request.confidence}" is below the required "${rule.min_confidence}".`,
    };
  }
  if (request.sources < rule.min_sources) {
    return {
      granted: false,
      reason: `Only ${request.sources} corroborating sensor(s) on the track; ${rule.min_sources} required.`,
    };
  }
  return {
    granted: true,
    reason: `Met the grant rule: "${request.category}"/${request.confidence} on ${request.sources} source(s).`,
  };
};

export interface PendingRequest {
  track_id: string;
  requested_at_ms: Millis;
  resolves_at_ms: Millis;
  category: ClassificationCategory;
  confidence: Confidence;
  sources: number;
}

/**
 * Pick a resolution delay from `[min, max]`.
 *
 * Takes the draw as an argument rather than an `Rng` so the caller controls which
 * named stream the delay comes from (DECISIONS.md D1) — authority latency is not
 * sensor clutter and must not perturb the sensor streams.
 */
export const pickDelayMs = (rule: GrantRule, draw: number): Millis => {
  const [lo, hi] = rule.delay_s;
  const clamped = draw < 0 ? 0 : draw >= 1 ? 0.999999 : draw;
  return Math.round((lo + clamped * (hi - lo)) * 1000);
};

export interface AuthorityState {
  readonly posture: Posture;
  /** Track ids with granted authority. */
  readonly granted: Map<string, Millis>;
  /** Requests awaiting resolution, in the order they were made. */
  pending(): readonly PendingRequest[];
  /** Register a request. It resolves when `settle` is called at or after its due time. */
  queue(request: PendingRequest): void;
  /** Resolve anything due at `t_ms`, returning the requests that settled. */
  settle(t_ms: Millis, rule: GrantRule): readonly { request: PendingRequest; decision: AuthorityDecision }[];
  /**
   * Replace the posture mid-run (FR-SIM-9 `authority_change`).
   *
   * The trainee's view of posture is read off this state, so a change is visible on
   * the next view. Grants already made are kept: authority earned under a looser
   * posture is not retrospectively withdrawn, which keeps the *transition* — not the
   * revocation — as the lesson.
   */
  setPosture(posture: Posture): void;
}

export interface AuthorityOptions {
  posture: Posture;
  rule: GrantRule;
  /** Draws resolution delays from this stream, in [0,1). */
  nextDraw: () => number;
}

export const createAuthority = (options: AuthorityOptions): AuthorityState => {
  const granted = new Map<string, Millis>();
  const pending: PendingRequest[] = [];
  let posture: Posture = options.posture;

  return {
    get posture() {
      return posture;
    },
    granted,
    pending: () => pending,

    queue(request) {
      // A second request for the same track supersedes the first: the trainee has
      // revised their case, and granting on the older request would authorise an
      // action justified by evidence the trainee has since withdrawn.
      const existing = pending.findIndex((p) => p.track_id === request.track_id);
      if (existing >= 0) pending.splice(existing, 1);
      pending.push(request);
    },

    settle(t_ms, rule) {
      const settled: { request: PendingRequest; decision: AuthorityDecision }[] = [];
      // Iterate in request order and splice from the back, so the resolution order
      // is stable for a given set of due requests.
      for (let i = 0; i < pending.length; i++) {
        const request = pending[i]!;
        if (t_ms < request.resolves_at_ms) continue;

        const decision = evaluateAuthority(rule, {
          category: request.category,
          confidence: request.confidence,
          sources: request.sources,
        });
        if (decision.granted) granted.set(request.track_id, t_ms);
        pending.splice(i, 1);
        i--;
        settled.push({ request, decision });
      }
      return settled;
    },

    setPosture(next) {
      posture = next;
    },
  };
};

/** Create a pending authority request. Exposed so a session can schedule it. */
export const makeRequest = (params: {
  track_id: string;
  t_ms: Millis;
  rule: GrantRule;
  category: ClassificationCategory;
  confidence: Confidence;
  sources: number;
  draw: number;
}): PendingRequest => ({
  track_id: params.track_id,
  requested_at_ms: params.t_ms,
  resolves_at_ms: params.t_ms + pickDelayMs(params.rule, params.draw),
  category: params.category,
  confidence: params.confidence,
  sources: params.sources,
});
