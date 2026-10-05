/**
 * Session tokens (PRD §7.1 auth, §15 `POST /api/auth/login`).
 *
 * A signed opaque token: `userId.expiry.hmac`. Not a JWT, deliberately — there is
 * nothing here that needs to be verified by a third party, so the only operations
 * required are "sign this" and "is this signature mine and unexpired". A JWT would
 * add a second signature format and a third library for no capability.
 *
 * The secret comes from config and is per-boot unless explicitly set, so tokens
 * do not survive a server restart. For a local single-machine tool that is the
 * right default: it means closing the app ends the session, and it removes any
 * possibility of a committed signing key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { Role } from "@skysentinel/shared";

export interface TokenClaims {
  user_id: string;
  role: Role;
  /** Expiry as epoch milliseconds. */
  expires_at: number;
}

/** Twelve hours: a working day, so a trainee is not re-authenticating mid-scenario. */
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const sign = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export const issueToken = (
  user_id: string,
  role: Role,
  secret: string,
  now: number,
  ttl_ms = TOKEN_TTL_MS,
): string => {
  const claims: TokenClaims = { user_id, role, expires_at: now + ttl_ms };
  const payload = b64u(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
};

/**
 * Verify a token, or return why it failed.
 *
 * The reason is returned rather than thrown so the caller can log it without
 * telling the client which of the three failure modes occurred — an expired token
 * and a forged one should look identical from outside.
 */
export const verifyToken = (
  token: string,
  secret: string,
  now: number,
): { ok: true; claims: TokenClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" } => {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof claims.user_id !== "string" || typeof claims.expires_at !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.expires_at <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
};
