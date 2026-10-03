/**
 * Response decision workflow and effect resolution (PRD §5.1 FR-SIM-8, §4).
 *
 * SAFETY: this module resolves *policy outcomes*, not *tactics*. A response is a
 * decision the trainee makes from a fixed set of posture-level actions (HOLD,
 * track, warn, deconflict, engage-authorised, drill, …). Its effect is a
 * probability drawn from the seeded PRNG. There is no emitter control, no jamming
 * parameter, no effect that operates on any real system, and no path by which
 * anything here could be applied outside the simulation.
 *
 * The two outcomes that matter pedagogically are both failure modes the trainee
 * must learn to avoid:
 *   - `fratricide`: engaging an entity that turns out to be friendly or civil.
 *   - `unauthorised`: acting without the required authority having been granted.
 */

import { range2d, type Affiliation, type Millis, type ResponseAction, type Vec3 } from "@skysentinel/shared";

import type { Drone } from "./entities.js";
import type { Rng } from "./rng.js";

export type Resolution =
  | "neutralised"
  | "partially_effective"
  | "missed"
  | "fratricide"
  | "collateral"
  | "no_effect";

export interface ResponseParams {
  action: ResponseAction;
  /** Fictional per-action effectiveness at nominal conditions. */
  base_success: number;
  /** Metres within which the responder is close enough to act. */
  engagement_range_m: number;
  /** How well the responder's solution matches the entity's behaviour. */
  match_quality: number;
  /** Entity affiliation as it is actually known to the responder, if known. */
  known_affiliation?: Affiliation;
  /** True when the responder has the authority the action requires. */
  authority_granted: boolean;
  /** Fictional probability the action causes fratricide when misapplied. */
  fratricide_risk: number;
}

export interface ResolutionResult {
  action: ResponseAction;
  resolution: Resolution;
  /** Probability the action succeeds, before the draw. */
  p_success: number;
  /** The value actually drawn, for explaining the outcome in the AAR. */
  draw: number;
  /** True when the action was taken without required authority. */
  unauthorised: boolean;
  /** True when a friendly or civilian was the target. */
  friendly_engaged: boolean;
  reason: string;
}

/** Actions that require authority before they may be taken. */
export const AUTHORITY_REQUIRED: readonly ResponseAction[] = [
  "execute_response",
  "request_support",
];

/** Actions that are advisory or protective and need no authority. */
export const NO_AUTHORITY_REQUIRED: readonly ResponseAction[] = [
  "continue_observe",
  "request_sensor_cue",
  "report",
  "assign_track_owner",
  "handover",
  "issue_warning",
  "activate_protective_drill",
  "request_response_authority",
  "stand_down",
  "reclassify",
];

export const requiresAuthority = (a: ResponseAction): boolean => AUTHORITY_REQUIRED.includes(a);

export interface ResolverInput {
  action: ResponseAction;
  /** The drone acted upon, if the action targeted one. */
  target?: Drone;
  /** Entity position from the responder's viewpoint. */
  responder_pos: Vec3;
  params: ResponseParams;
  t_ms: Millis;
  /** RNG stream for response resolution, independent of motion (DECISIONS.md D1). */
  rng: Rng;
}

/**
 * Resolve a response action to an outcome.
 *
 * Order of checks matters and is deliberate:
 *   1. Unauthorised action — an outcome regardless of whether it "would have
 *      worked", because the decision process is what is being assessed.
 *   2. Friendly/civil target — fratricide, which outranks any success roll.
 *   3. Range — out of range is a miss, before any effectiveness roll.
 *   4. Effectiveness roll — the ordinary stochastic outcome.
 */
export const resolveResponse = (input: ResolverInput): ResolutionResult => {
  const { action, target, responder_pos, params, rng } = input;
  const unauthorised = requiresAuthority(action) && !params.authority_granted;
  const draw = rng.next();

  // 1. Unauthorised.
  if (unauthorised) {
    return {
      action,
      resolution: "no_effect",
      p_success: 0,
      draw,
      unauthorised: true,
      friendly_engaged: false,
      reason: `${action} requires authority that had not been granted; the request was not actioned.`,
    };
  }

  // 2. Friendly or non-UAS target. The responder's knowledge matters: acting on what
  //    they believed was hostile is a process error, not automatically fratricide.
  const isProtected = target?.affiliation_truth === "friendly" || target?.affiliation_truth === "non_uas";
  const knewOrSuspected =
    params.known_affiliation === "friendly" ||
    params.known_affiliation === "non_uas" ||
    params.known_affiliation === "authorised";

  if (isProtected && target) {
    const roll = rng.next();
    if (!knewOrSuspected || roll < params.fratricide_risk) {
      return {
        action,
        resolution: "fratricide",
        p_success: 1 - params.fratricide_risk,
        draw: roll,
        unauthorised,
        friendly_engaged: true,
        reason: `Action taken against a ${target.affiliation_truth} entity. Fratricide is a critical error regardless of the effect roll.`,
      };
    }
    return {
      action,
      resolution: "no_effect",
      p_success: 0,
      draw: roll,
      unauthorised,
      friendly_engaged: false,
      reason: `Action against a ${target.affiliation_truth} entity was correctly withheld; deconfliction applied.`,
    };
  }

  // 3. Range.
  const range = target ? range2d(responder_pos, target.pos) : 0;
  if (range > params.engagement_range_m) {
    return {
      action,
      resolution: "missed",
      p_success: 0,
      draw,
      unauthorised,
      friendly_engaged: false,
      reason: `Target at ${range.toFixed(0)} m exceeded the ${params.engagement_range_m} m action range.`,
    };
  }

  // 4. Effectiveness. Match quality scales success; a mismatched action on a fast
  //    or low-slow target performs worse, which is what makes classification matter.
  const p = Math.min(Math.max(params.base_success * params.match_quality, 0), 1);
  if (draw < p) {
    return {
      action,
      resolution: "neutralised",
      p_success: p,
      draw,
      unauthorised,
      friendly_engaged: false,
      reason: `Action resolved within effect at ${range.toFixed(0)} m with match quality ${params.match_quality.toFixed(2)}.`,
    };
  }

  // Partial effect: worse outcomes are more likely than neutralisation for a poor match.
  const partial = draw < p + (1 - p) * 0.5;
  return {
    action,
    resolution: partial ? "partially_effective" : "missed",
    p_success: p,
    draw,
    unauthorised,
    friendly_engaged: false,
    reason: partial
      ? `Partial effect at ${range.toFixed(0)} m with match quality ${params.match_quality.toFixed(2)}.`
      : `No effect at ${range.toFixed(0)} m with match quality ${params.match_quality.toFixed(2)}.`,
  };
};

/**
 * How well a response matches a target's behaviour.
 *
 * Deliberately coarse and fictional: it rewards having classified the behaviour
 * rather than guessing at equipment. Ranges from 0.4 (blind action) to 1.0
 * (correctly matched).
 */
export const matchQualityFor = (knewBehaviour: boolean, classifiedConfidence: string): number => {
  if (!knewBehaviour) return 0.4;
  switch (classifiedConfidence) {
    case "high":
      return 1.0;
    case "medium":
      return 0.8;
    default:
      return 0.6;
  }
};