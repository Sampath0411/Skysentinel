/**
 * Asset impact and protective drill (PRD §5.1 FR-SIM-7).
 *
 * This models what happens to a protected asset when a drone reaches it, and what
 * the protective drill changes. All numbers are fictional and configured in data,
 * not doctrine.
 *
 * The module deliberately computes *consequence*, not *method*: it knows that a
 * drone inside an impact radius damages an asset by some amount, and that a drill
 * raises the cost of being seen. It contains no information about how any real
 * system is defeated, protected, or deployed.
 */

import { range2d, type Millis, type Vec3 } from "@skysentinel/shared";

import type { ProtectedAsset } from "./entities.js";

/** How much integrity one impact removes, by drone class. Fictional. */
export const IMPACT_DAMAGE: Record<string, number> = {
  recon: 0.05,
  payload: 0.4,
  decoy: 0.0,
  bird_flock: 0.0,
};

/** Integrity lost per second while a protective drill is running, by asset class. */
export const DRILL_COST_PER_S: Record<string, number> = {
  fuel: 0.06,
  command_post: 0.03,
  radar_site: 0.02,
  comms: 0.02,
};

export const DEFAULT_DRILL_COST_PER_S = 0.03;

export type DrillPhase = "requested" | "active" | "completed" | "aborted";

export interface DrillState {
  asset_id: string;
  phase: DrillPhase;
  started_ms: Millis;
  /** Seconds the drill runs when it completes normally. */
  duration_s: number;
  /**
   * How much the drill reduces the chance of being detected by a given sensor,
   * 0..1. Fictional; configured in data.
   */
  signature_reduction: number;
}

export interface ImpactResult {
  asset_id: string;
  entity_id: string;
  integrity_before: number;
  integrity_after: number;
  /** True when the asset's integrity reached zero. */
  destroyed: boolean;
}

/** Damage class for an entity archetype, defaulting to a light value. */
export const damageFor = (archetype: string): number => IMPACT_DAMAGE[archetype] ?? 0.1;

/**
 * Apply one impact to an asset, in place.
 *
 * Damage is applied to integrity and clamped at zero. A destroyed asset stays in
 * the world at zero integrity rather than being removed, so the AAR timeline can
 * show when it was destroyed and what was visible at that moment.
 */
export const applyImpact = (asset: ProtectedAsset, entityId: string, archetype: string): ImpactResult => {
  const before = asset.integrity;
  const after = Math.max(0, before - damageFor(archetype));
  asset.integrity = after;

  return {
    asset_id: asset.id,
    entity_id: entityId,
    integrity_before: before,
    integrity_after: after,
    destroyed: after <= 0,
  };
};

/** Is an entity inside an asset's impact radius? Horizontal only, as in training. */
export const isInsideImpactRadius = (asset: ProtectedAsset, pos: Vec3): boolean =>
  range2d(asset.pos, pos) <= asset.impact_radius_m;

/**
 * Integrity cost of running a drill for `elapsedS` seconds.
 *
 * Modelled as an ongoing cost so that calling a drill is not free: it reduces
 * signature but degrades readiness. This is the trade-off a trainee has to weigh,
 * and the reason the scoring tree can reward *not* calling one.
 */
export const drillCost = (asset: ProtectedAsset, elapsedS: number): number =>
  (DRILL_COST_PER_S[asset.type] ?? DEFAULT_DRILL_COST_PER_S) * Math.max(0, elapsedS);

export const startDrill = (assetId: string, t_ms: Millis, duration_s: number, signature_reduction: number): DrillState => ({
  asset_id: assetId,
  phase: "requested",
  started_ms: t_ms,
  duration_s,
  signature_reduction: Math.min(Math.max(signature_reduction, 0), 1),
});

/**
 * Advance a drill by one tick and apply its integrity cost.
 *
 * Returns the integrity after the cost. When the drill completes it stops costing
 * anything further; the cost of the drill window itself is already paid.
 */
export const stepDrill = (
  drill: DrillState,
  asset: ProtectedAsset,
  dt_s: number,
  t_ms: Millis,
): number => {
  if (drill.phase === "completed" || drill.phase === "aborted") return asset.integrity;

  drill.phase = "active";
  asset.integrity = Math.max(0, asset.integrity - drillCost(asset, dt_s));

  if (t_ms - drill.started_ms >= drill.duration_s * 1000) {
    drill.phase = "completed";
  }
  return asset.integrity;
};

/**
 * Multiplier applied to a sensor's detection probability while a drill runs.
 *
 * Returns 1 when no drill is active, so callers can multiply unconditionally.
 */
export const signatureMultiplier = (drill: DrillState | undefined): number =>
  !drill || drill.phase !== "active" ? 1 : 1 - drill.signature_reduction;

/** Mission outcome, reported separately from the process score (PRD §10.6). */
export type Outcome = "protected" | "damaged" | "asset_lost" | "mission_failed";

export const deriveOutcome = (assets: ProtectedAsset[], anyImpact: boolean): Outcome => {
  if (assets.some((a) => a.integrity <= 0)) return "asset_lost";
  if (assets.some((a) => a.integrity < 1)) return anyImpact ? "damaged" : "protected";
  return anyImpact ? "damaged" : "protected";
};