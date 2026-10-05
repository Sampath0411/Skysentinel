/**
 * Server configuration (PRD §6.1, §17).
 *
 * Everything is local and offline by construction. There is no outbound host to
 * configure because there is no code that makes an outbound request — the
 * verification script (`scripts/verify-offline.mjs`, M9) greps for one rather than
 * trusting a setting here.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, from `apps/server/dist/` or `apps/server/src/`. */
export const REPO_ROOT = path.resolve(here, "..", "..", "..");

export interface ServerConfig {
  host: string;
  port: number;
  /** SQLite file. `:memory:` for tests. */
  database_path: string;
  /**
   * Signing key for session tokens.
   *
   * Read from `SKYSENTINEL_SECRET`, and generated per-boot when absent. A generated
   * key means restarting the server invalidates every token — correct for a local
   * single-machine tool, and better than a hardcoded default that would ship in the
   * repository and be reused by every installation.
   */
  secret: string;
  /** Sim ticks per wall-clock millisecond. 1.0 is real time; 0 disables the clock. */
  speed: number;
  /** Client build directory served as static assets in production. */
  client_dist: string;
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const loadConfig = (over: Partial<ServerConfig> = {}): ServerConfig => {
  const db = process.env["SKYSENTINEL_DB"] ?? path.join(REPO_ROOT, "data", "skysentinel.db");
  return {
    host: process.env["SKYSENTINEL_HOST"] ?? "127.0.0.1",
    port: num(process.env["SKYSENTINEL_PORT"], 8787),
    database_path: db,
    secret:
      process.env["SKYSENTINEL_SECRET"] ??
      // A per-boot key. See the field comment: the failure mode of not having one
      // is a token that stops working, which is recoverable; the failure mode of a
      // committed default is every install sharing a signing key.
      `ephemeral-${Math.random().toString(36).slice(2)}${process.pid.toString(36)}`,
    speed: num(process.env["SKYSENTINEL_SPEED"], 1),
    client_dist: process.env["SKYSENTINEL_CLIENT_DIST"] ?? path.join(REPO_ROOT, "apps", "client", "dist"),
    ...over,
  };
};
