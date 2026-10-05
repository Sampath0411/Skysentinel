/**
 * Auth routes (PRD §15).
 *
 * `POST /api/auth/login` is the only unauthenticated endpoint in the server. It is
 * the one place a wrong password must be answered identically to a wrong username,
 * and the one place the audit log records a failure — PRD §17 requires local RBAC
 * with hashed passwords and an audit trail, and a login is the event worth auditing
 * most.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hashPassword, needsRehash, verifyPassword } from "../../auth/password.js";
import { issueToken } from "../../auth/tokens.js";
import { audit, createUser, findUserByUsername, listUsers, setPasswordHash } from "../../db/repo.js";
import { callerOf } from "../auth-plugin.js";
import { nowIso, nowMs } from "../../ids.js";
import type { Role } from "@skysentinel/shared";

const LoginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});

const CreateUserSchema = LoginSchema.extend({
  display_name: z.string().min(1).max(200).optional(),
  role: z.enum(["trainee", "instructor", "admin"]).default("trainee"),
  unit_id: z.string().max(100).optional(),
});

export interface AuthRouteDeps {
  secret: string;
}

/** The user shape returned to a client. Never carries the hash. */
const publicUser = (u: {
  id: string;
  username: string;
  display_name: string | null;
  role: Role;
  unit_id: string | null;
}) => ({
  id: u.id,
  username: u.username,
  display_name: u.display_name,
  role: u.role,
  unit_id: u.unit_id,
});

export const authRoutes = async (app: FastifyInstance, deps: AuthRouteDeps) => {
  const db = app.db;

  /**
   * Create an account. Admin-only.
   *
   * Open registration would be indefensible here, so this is deliberately gated.
   * The first account is bootstrapped at startup rather than through this route,
   * because a system that cannot be set up without an existing admin cannot be
   * installed at all.
   */
  app.post("/api/users", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

    const { username, password, display_name, role, unit_id } = parsed.data;

    if (findUserByUsername(db, username)) {
      return reply.code(409).send({ error: "username_taken", message: "That username already exists." });
    }

    const user = createUser(db, {
      username,
      password_hash: await hashPassword(password),
      role,
      ...(display_name !== undefined ? { display_name } : {}),
      ...(unit_id !== undefined ? { unit_id } : {}),
    });

    audit(db, callerOf(request).id, "user.create", { user_id: user.id, username, role });
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.get("/api/users", { preHandler: app.requireRole(["admin"]) }, async (request) => {
    const { unit_id } = (request.query ?? {}) as { unit_id?: string };
    return { users: listUsers(db, unit_id).map(publicUser) };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: "Username and password are required." });
    }

    const { username, password } = parsed.data;
    const user = findUserByUsername(db, username);

    // One message and one status for both failure modes. "No such user" and "wrong
    // password" must be indistinguishable, or this endpoint is a username oracle.
    const reject = () =>
      reply.code(401).send({ error: "invalid_credentials", message: "Incorrect username or password." });

    if (!user) {
      audit(db, null, "auth.login_failed", { username, reason: "no_such_user" });
      return reject();
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      audit(db, user.id, "auth.login_failed", { username, reason: "bad_password" });
      return reject();
    }

    // Transparently upgrade a hash left on older cost parameters, so raising the
    // cost later does not force a reset on every existing user.
    if (needsRehash(user.password_hash)) {
      setPasswordHash(db, user.id, await hashPassword(password));
    }

    const token = issueToken(user.id, user.role, deps.secret, nowMs());
    audit(db, user.id, "auth.login", { username });

    return { token, user: publicUser(user) };
  });

  app.get("/api/me", { preHandler: app.authenticate }, async (request) => ({
    user: callerOf(request),
    server_time: nowIso(),
  }));
};
