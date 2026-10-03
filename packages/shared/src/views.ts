/**
 * Role-filtered views (PRD §6.4).
 *
 * The server sends each client a *view*, never the raw stream. A trainee view must
 * never contain ground truth. This module is the single place that decides what a
 * role may see, so the rule is enforced in one testable function rather than being
 * re-implemented per endpoint.
 *
 * Two layers of defence:
 *  1. Drop whole events whose visibility excludes the role (e.g. `entity_state`).
 *  2. Strip forbidden keys from the payload of events that *are* forwarded
 *     (e.g. `sensor_observation.truth_ref`, which scoring needs but the client does not).
 */

import { FORBIDDEN_TRAINEE_KEYS, TRUTH_BEARING_EVENT_TYPES } from "./events.js";
import type { AnySimEvent } from "./events.js";
import type { Role } from "./vocabulary.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Recursively delete forbidden keys, including inside nested objects and arrays. */
export const stripForbiddenKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripForbiddenKeys);
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_TRAINEE_KEYS.includes(k)) continue;
    out[k] = stripForbiddenKeys(v);
  }
  return out;
};

/**
 * Can this role see an event with this visibility?
 * - `all`         → everyone
 * - `trainee`     → trainee, instructor, admin
 * - `instructor`  → instructor, admin only
 */
export const canSee = (visibility: string, role: Role): boolean => {
  switch (visibility) {
    case "all":
      return true;
    case "trainee":
      return role === "trainee" || role === "instructor" || role === "admin";
    case "instructor":
      return role === "instructor" || role === "admin";
    default:
      return false;
  }
};

/**
 * Produce the view of an event stream for a role.
 *
 * Truth-bearing event types are dropped for trainee role regardless of the
 * visibility field, so a mislabelled event still cannot leak truth.
 */
export const filterForRole = (
  events: readonly AnySimEvent[],
  role: Role,
): readonly AnySimEvent[] => {
  const isTruthBearing = TRUTH_BEARING_EVENT_TYPES as readonly string[];
  const stripPayload = role === "trainee";

  const out: AnySimEvent[] = [];
  for (const ev of events) {
    if (!canSee(ev.visibility, role)) continue;
    if (role === "trainee" && isTruthBearing.includes(ev.type)) continue;

    if (stripPayload) {
      out.push({ ...ev, payload: stripForbiddenKeys(ev.payload) } as AnySimEvent);
    } else {
      out.push(ev);
    }
  }
  return out;
};

/**
 * Assert that a value intended for a trainee carries no truth fields.
 * Used by the AAR leak test (PRD §18.6) and by the server before it sends a view.
 * Returns the offending key paths, empty when clean.
 */
export const findForbiddenKeys = (value: unknown, path = "$"): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findForbiddenKeys(v, `${path}[${i}]`));
  }
  if (!isRecord(value)) return [];

  const hits: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_TRAINEE_KEYS.includes(k)) hits.push(`${path}.${k}`);
    hits.push(...findForbiddenKeys(v, `${path}.${k}`));
  }
  return hits;
};

/** Throws if a trainee-bound payload leaks truth. Call before every trainee send. */
export const assertNoTruthLeak = (value: unknown, context = "trainee view"): void => {
  const hits = findForbiddenKeys(value);
  if (hits.length > 0) {
    throw new Error(
      `Truth leak into ${context}: forbidden key(s) ${hits.join(", ")} present. ` +
        `Ground truth must never reach a trainee client (PRD §4, §6.4).`,
    );
  }
};