/**
 * Identifiers and clock.
 *
 * `newId` is random and `nowIso` is wall-clock, which is exactly what a database
 * layer does and exactly what the simulation must never do (CLAUDE.md). The
 * distinction is the whole reason these live in their own module: inside
 * `sim-core` a wall-clock read would silently break determinism, and the fastest
 * way to keep that true is for the impure version to have a name you have to
 * import on purpose.
 */

import { randomUUID, randomBytes } from "node:crypto";

/** A fresh opaque identifier, e.g. a session or user id. */
export const newId = (prefix = ""): string => `${prefix}${randomUUID()}`;

/** Wall-clock ISO 8601, for `created_at`-style columns only. */
export const nowIso = (): string => new Date().toISOString();

/**
 * Wall-clock milliseconds since the epoch, for measuring durations.
 *
 * Never for sim time. Sim time is integer milliseconds from the scenario start
 * and comes from the clock in `sim-core` (D5).
 */
export const nowMs = (): number => Date.now();

/** URL-safe random bytes, for token secrets. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
