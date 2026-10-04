/**
 * Scenario fingerprinting (PRD §5.4 FR-SCN-5).
 *
 * A fingerprint identifies *what a scenario is*, independently of how it was
 * named or which random seed produced it. The recommender uses it to refuse to
 * serve a trainee the same scenario twice inside their last N sessions.
 *
 * ## What is excluded, and why
 *
 *   `id`, `title`, `description`, `seed`, `family` — two scenarios with the same
 *   layout but different seeds are the same exercise. Regenerating with a new seed
 *   must not read as a new scenario, or anti-rote would never fire: the whole
 *   point of the recommender is that it varies seed while keeping structure.
 *
 * Everything that changes *what the trainee actually does* is included: terrain,
 * time of day, weather, asset positions, entity behaviours, sensor modes and
 * timings. Round a position changed by a metre and the fingerprint changes,
 * because the trainee would genuinely face a different problem.
 *
 * The result is a stable hash so it can be stored in a database column and
 * compared across sessions and machines.
 */

import type { Scenario } from "./schema.js";

/** Keys stripped before hashing: identity, not content. */
const EXCLUDED_KEYS = new Set(["id", "title", "description", "seed", "family", "rubric_id"]);

/** Positions are rounded to this many metres before hashing. */
const POSITION_PRECISION_M = 1;

/**
 * Round a number for hashing so that floating-point noise from a different
 * evaluation order does not produce a different fingerprint.
 */
const round = (v: number): number => {
  const f = 10 ** POSITION_PRECISION_M;
  return Math.round(v * f) / f;
};

const normaliseValue = (key: string, value: unknown): unknown => {
  if (typeof value === "number") return round(value);
  if (Array.isArray(value)) return value.map((v) => normaliseValue(key, v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // Sorted keys: object key order must not affect the hash.
    for (const k of Object.keys(value).sort()) {
      if (EXCLUDED_KEYS.has(k)) continue;
      out[k] = normaliseValue(k, (value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
};

/**
 * Canonical string form of a scenario's meaning.
 *
 * Exposed so the fingerprint is inspectable in a test failure: comparing two
 * canonical strings explains *what* differs, where comparing two hashes only says
 * that something does.
 */
export const canonicalForm = (scenario: Scenario): string =>
  JSON.stringify(normaliseValue("scenario", scenario));

/** FNV-1a over a string with a given offset basis. */
const fnv1a = (s: string, basis: number): number => {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

/**
 * Stable 16-hex-character fingerprint (64 bits).
 *
 * Two FNV-1a passes over the same canonical form with different offset bases,
 * concatenated. One pass would be 32 bits, which over a library of thousands of
 * generated scenarios collides often enough to start silently suppressing
 * distinct exercises from the anti-rote check. Two independent bases cost one
 * extra pass over a ~2 KB string and give 64 bits — enough that an accidental
 * collision is not a realistic concern.
 *
 * Both halves are derived from the canonical string alone, with no wall-clock or
 * run-specific salt, so the fingerprint is stable across machines and sessions
 * and can be stored and compared directly.
 */
export const fingerprint = (scenario: Scenario): string => {
  const canonical = canonicalForm(scenario);
  const hi = fnv1a(canonical, 0x811c9dc5);
  const lo = fnv1a(canonical, 0x01000193);
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
};

/** How many recent sessions the anti-rote check looks back over (PRD §8.4 rule 7). */
export const ANTI_ROTE_WINDOW = 10;

/**
 * Has this trainee seen this scenario shape recently?
 *
 * A pure function of the fingerprint history, so it is testable without a
 * database and the recommender stays free of persistence concerns.
 */
export const isRepeatOf = (
  recentFingerprints: readonly string[],
  candidate: string,
  window = ANTI_ROTE_WINDOW,
): boolean => recentFingerprints.slice(-window).includes(candidate);