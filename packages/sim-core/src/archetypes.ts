/**
 * Drone archetype library (PRD §8.2).
 *
 * ## Fictional parameters
 *
 * Sizes, radar cross-sections and speeds below are invented for this simulator so
 * that the detection, fusion and scoring logic behave sensibly and consistently.
 * They are NOT measured values, NOT derived from any real platform, and must not
 * be presented as characteristic of any real system. The relative ordering (an FPV
 * drone is small and fast; a fixed-wing is large and fast) is the only thing the
 * simulation actually relies on.
 */

import type { Affiliation, Archetype } from "@skysentinel/shared";

export interface ArchetypeSpec {
  readonly id: Archetype;
  /** Physical size, metres (characteristic dimension). */
  readonly size_m: number;
  /** Relative radar cross-section. Unitless by design — it is a relative term. */
  readonly rcs_rel: number;
  /** Cruise speed range, m/s. */
  readonly speed_mps: [number, number];
  /** Typical behaviour states, for the generator and validator. */
  readonly typical_behaviours: readonly string[];
  /** Does this archetype normally radiate an RF cue in the simulator? */
  readonly rf_typical: boolean;
  /** True if the archetype is not a UAS at all (birds and clutter). */
  readonly is_non_uas: boolean;
  /** Typical affiliation the generator assigns this archetype. */
  readonly default_affiliation: Affiliation;
  /** True when the generator may silently drop the RF emitter (e.g. FPV on a raid). */
  readonly rf_can_be_silent: boolean;
}

export const ARCHETYPE_SPECS: Record<Archetype, ArchetypeSpec> = {
  recon_multirotor: {
    id: "recon_multirotor",
    size_m: 0.4,
    rcs_rel: 1.0,
    speed_mps: [6, 12],
    typical_behaviours: ["transit", "orbit_loiter", "retreat"],
    rf_typical: true,
    is_non_uas: false,
    default_affiliation: "hostile",
    rf_can_be_silent: false,
  },

  fpv_attack: {
    id: "fpv_attack",
    size_m: 0.3,
    rcs_rel: 0.7,
    speed_mps: [25, 40],
    typical_behaviours: ["terrain_masked_approach", "approach_direct"],
    rf_typical: true,
    is_non_uas: false,
    default_affiliation: "hostile",
    // An attack drone may fly dark, which is the whole point of it.
    rf_can_be_silent: true,
  },

  fixed_wing_recon: {
    id: "fixed_wing_recon",
    size_m: 1.5,
    rcs_rel: 1.6,
    speed_mps: [18, 30],
    typical_behaviours: ["transit", "orbit_loiter"],
    rf_typical: true,
    is_non_uas: false,
    default_affiliation: "hostile",
    rf_can_be_silent: false,
  },

  decoy_drone: {
    id: "decoy_drone",
    size_m: 0.5,
    rcs_rel: 1.0,
    speed_mps: [5, 10],
    typical_behaviours: ["decoy_hover", "transit"],
    rf_typical: true,
    is_non_uas: false,
    default_affiliation: "hostile",
    rf_can_be_silent: false,
  },

  friendly_logistics: {
    id: "friendly_logistics",
    size_m: 0.8,
    rcs_rel: 1.3,
    speed_mps: [8, 12],
    typical_behaviours: ["transit"],
    rf_typical: true,
    is_non_uas: false,
    default_affiliation: "friendly",
    rf_can_be_silent: false,
  },

  neutral_civil: {
    id: "neutral_civil",
    size_m: 0.4,
    rcs_rel: 1.0,
    speed_mps: [5, 12],
    typical_behaviours: ["transit", "orbit_loiter"],
    rf_typical: true,
    is_non_uas: false,
    default_affiliation: "authorised",
    rf_can_be_silent: false,
  },

  bird_flock: {
    id: "bird_flock",
    size_m: 0.3,
    rcs_rel: 0.3,
    speed_mps: [8, 15],
    typical_behaviours: ["transit", "orbit_loiter"],
    rf_typical: false,
    is_non_uas: true,
    default_affiliation: "non_uas",
    rf_can_be_silent: false,
  },
};

export const getArchetype = (id: Archetype): ArchetypeSpec => ARCHETYPE_SPECS[id];

/** True when the archetype is a bird or other clutter rather than a UAS. */
export const isNonUas = (id: Archetype): boolean => ARCHETYPE_SPECS[id].is_non_uas;

/** Midpoint of the archetype's speed range, for defaults in the generator. */
export const nominalSpeed = (id: Archetype): number => {
  const [lo, hi] = ARCHETYPE_SPECS[id].speed_mps;
  return (lo + hi) / 2;
};