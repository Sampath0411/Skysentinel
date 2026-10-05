/**
 * Test harness (PRD §14 M5 DoD).
 *
 * One app, one in-memory database, one listening socket per suite. The server is
 * the only place the truth boundary and the RBAC rules actually run, so these
 * tests build the real app rather than a mock of it — `buildApp` is exported for
 * exactly this reason.
 *
 * Users are created through the repository and minted real tokens, so a test that
 * exercises RBAC carries a token the server itself signed and would have accepted
 * over the wire.
 */

import type { FastifyInstance } from "fastify";

import { attachWs } from "../ws.js";
import { issueToken } from "../auth/tokens.js";
import { hashPassword } from "../auth/password.js";
import { createUser } from "../db/repo.js";
import { buildApp } from "../main.js";

/** A fixed secret, because a test that cannot predict its own tokens is a flaky test. */
export const TEST_SECRET = "test-secret-not-a-real-key";

export type Role = "admin" | "instructor" | "trainee";

export interface TestUser {
  id: string;
  username: string;
  role: Role;
  token: string;
}

export interface TestApp {
  app: FastifyInstance;
  registry: ReturnType<typeof buildApp>["registry"];
  /** Every user the harness has minted, keyed by username. */
  users: Map<string, TestUser>;
  /** Bind to a free port and attach the frame socket. Idempotent. */
  listen(): Promise<void>;
  /** The base URL, once `listen` has been called. */
  origin(): string;
  /** Create a user, or return the existing one. */
  user(username: string, role: Role): Promise<TestUser>;
  close(): Promise<void>;
}

export interface BuildOptions {
  /** Sim-ms per wall-clock ms. High values run a whole scenario inside a test. */
  speed?: number;
}

/**
 * Build an app with nothing on disk and no client dist.
 *
 * `client_dist` is a path that cannot exist: serving the built client in a test
 * would make the suite depend on a prior build in another package, and the SPA
 * fallback would swallow every 404 a test wants to observe.
 */
export const buildTestApp = async (options: BuildOptions = {}): Promise<TestApp> => {
  const { app, registry, config } = await buildApp({
    database_path: ":memory:",
    secret: TEST_SECRET,
    speed: options.speed ?? 1,
    client_dist: "__no_client_dist_in_tests__",
  });

  let listening = false;
  const users = new Map<string, TestUser>();

  const user = async (username: string, role: Role): Promise<TestUser> => {
    const existing = users.get(username);
    if (existing) return existing;

    const record = createUser(app.db, {
      username,
      password_hash: await hashPassword(username),
      role,
      display_name: username,
    });
    const token = issueToken(record.id, role, config.secret, Date.now());
    const made: TestUser = { id: record.id, username, role, token };
    users.set(username, made);
    return made;
  };

  return {
    app,
    registry,
    users,
    listen: async () => {
      if (listening) return;
      await app.listen({ host: "127.0.0.1", port: 0 });
      attachWs(app.server, { db: app.db, registry, secret: config.secret });
      listening = true;
    },
    origin: () => {
      if (!listening) throw new Error("call listen() before origin()");
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server is not bound to a port");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    user,
    close: async () => {
      registry.shutdown();
      await app.close();
    },
  };
};
