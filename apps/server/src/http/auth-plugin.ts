/**
 * Authentication and RBAC (PRD §5.8, §7.1, §15).
 *
 * A Fastify plugin that resolves the bearer token on every request and attaches the
 * caller. Routes then declare what they need with `requireRole`, so authorisation
 * is stated at the route rather than being re-implemented per handler — which is
 * how "trainee cannot read another trainee's session" ends up being a property of
 * the code rather than a thing someone remembered.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Role } from "@skysentinel/shared";

import { verifyToken } from "../auth/tokens.js";
import { findUserById } from "../db/repo.js";
import type { Db } from "../db/index.js";
import { nowMs } from "../ids.js";

export interface Caller {
  id: string;
  username: string;
  display_name: string | null;
  role: Role;
  unit_id: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Present once `authenticate` has run. Absent on public routes. */
    caller?: Caller;
  }
  interface FastifyInstance {
    /** Resolve the bearer token or reply 401. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Resolve the caller, then require one of `roles` or reply 403. */
    requireRole(roles: readonly Role[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** SQLite handle, attached once at boot. */
    db: Db;
    /** Sim speed multiplier, attached once at boot. */
    speed: number;
  }
}

export interface AuthOptions {
  db: Db;
  secret: string;
}

export const authPlugin = fp(async (app: FastifyInstance, opts: AuthOptions) => {
  const { db, secret } = opts;

  const bearer = (request: FastifyRequest): string | undefined => {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value) return undefined;
    return value;
  };

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request);
    // A missing token and a bad one are answered identically. Distinguishing them
    // tells an attacker which usernames are worth guessing.
    if (!token) {
      await reply.code(401).send({ error: "unauthenticated", message: "Sign in to continue." });
      return;
    }

    const result = verifyToken(token, secret, nowMs());
    if (!result.ok) {
      await reply.code(401).send({ error: "unauthenticated", message: "Sign in to continue." });
      return;
    }

    // The token carries a role, but the *database* is the authority: a token minted
    // before a role change must not outlive it, and a deleted user must not keep
    // working until their token expires.
    const user = findUserById(db, result.claims.user_id);
    if (!user) {
      await reply.code(401).send({ error: "unauthenticated", message: "Sign in to continue." });
      return;
    }

    request.caller = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      unit_id: user.unit_id,
    };
  });

  app.decorate(
    "requireRole",
    (roles: readonly Role[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        await app.authenticate(request, reply);
        if (reply.sent) return;
        if (!request.caller || !roles.includes(request.caller.role)) {
          await reply.code(403).send({
            error: "forbidden",
            message: `This action requires one of: ${roles.join(", ")}.`,
          });
        }
      },
  );
});

/**
 * May this caller see this session?
 *
 * The PRD §14 M5 DoD requires "trainee cannot read others' sessions", and this is
 * the single place that decides it. Written as one function so every route — REST,
 * events, score, replay, annotations — inherits the same rule rather than each
 * re-deriving it and one of them getting the owner check wrong.
 *
 * A trainee sees only their own. An instructor sees everything (they are running
 * the exercise). An admin sees everything (they administer the system, and the
 * trainer is a local single-unit tool where that is the same practical scope).
 */
export const canAccessSession = (
  caller: Caller,
  session: { trainee_id: string; instructor_id: string | null },
): boolean => {
  if (caller.role === "admin" || caller.role === "instructor") return true;
  return session.trainee_id === caller.id;
};

/** The caller, or a thrown 401. For handlers behind `requireRole`. */
export const callerOf = (request: FastifyRequest): Caller => {
  if (!request.caller) throw new Error("callerOf called on an unauthenticated request");
  return request.caller;
};
