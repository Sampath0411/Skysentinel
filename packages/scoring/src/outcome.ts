/**
 * Mission outcome (PRD §10.6).
 *
 * Deliberately separate from the process tree. A trainee can make every correct
 * decision and still lose the asset, or stumble through and get lucky — and the
 * AAR has to be able to say which, because that is the difference between a
 * decision that will generalise and one that will not.
 *
 * All of this is simulated consequence from the impact and response models. There
 * is no operational content here: the module counts events and reads damage
 * numbers that `sim-core` already produced.
 */

import type { RunFacts } from "./log.js";
import type { MissionOutcome } from "./types.js";

/**
 * Weighted so that a protected asset's loss dominates, per PRD §10.3 §10.6.
 *
 * Impact damage is already a 0..1 fraction per hit from `sim-core`, so summing it
 * and clamping gives integrity directly rather than a proxy.
 */
export const scoreOutcome = (facts: RunFacts, protect: readonly string[]): MissionOutcome => {
  const protected_hits = facts.impacts.filter((i) => protect.includes(i.asset_id));
  const total_damage = facts.impacts.reduce((acc, i) => acc + i.damage, 0);
  const protected_damage = protected_hits.reduce((acc, i) => acc + i.damage, 0);

  const asset_integrity = Math.max(0, 1 - total_damage);

  // Losing a protected asset is worse than losing an unprotected one, so the
  // protected portion is counted twice. The weights are fictional training
  // parameters and deliberately live here rather than in the rubric: they
  // describe the *world*, not the trainee's decisions, and changing them must not
  // change anyone's score.
  const weighted_penalty = protected_damage * 2 + total_damage;
  const integrity_points = Math.max(0, 100 - weighted_penalty * 100);

  const engaged = facts.engaged.length;
  const neutralised = facts.neutralised.length;
  const engagement_points = engaged === 0 ? 100 : Math.min(100, (neutralised / engaged) * 100);

  const impact_points = Math.max(0, 100 - facts.impact_count * 25);

  const score = Math.round(integrity_points * 0.5 + engagement_points * 0.3 + impact_points * 0.2);

  return {
    score: Math.max(0, Math.min(100, score)),
    asset_integrity: round2(asset_integrity),
    assets_lost: facts.impacts.filter((i) => i.damage >= 1).length,
    threats_neutralised: neutralised,
    threats_engaged: engaged,
    impacts: facts.impact_count,
  };
};

const round2 = (v: number): number => Math.round(v * 100) / 100;