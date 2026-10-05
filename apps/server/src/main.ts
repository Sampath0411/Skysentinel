/**
 * Server entry point (PRD §6.3).
 *
 * Boots the Fastify app: SQLite, auth, REST routes, the frame WebSocket,
 * and — in production — the built client as static assets. In dev the
 * Vite dev server proxies to this process instead, so the two can be run
 * and restarted independently.
 *
 * The first account is bootstrapped here rather than through the API,
 * because a system that cannot be set up without an existing admin cannot
 * be installed at all (see `routes/auth.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { hashPassword } from "./auth/password.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { createUser, listUsers } from "./db/repo.js";
import { authPlugin } from "./http/auth-plugin.js";
import { aarRoutes } from "./http/routes/aar.js";
import { authRoutes } from "./http/routes/auth.js";
import { scenarioRoutes } from "./http/routes/scenarios.js";
import { finalise, sessionRoutes } from "./http/routes/sessions.js";
import { SessionRegistry } from "./session/registry.js";
import { attachWs } from "./ws.js";

export interface BuiltApp {
  app: Fastify.FastifyInstance;
  registry: SessionRegistry;
  config: ReturnType<typeof loadConfig>;
}

/** Assemble the app. Exported so tests can build one without listening. */
export const buildApp = async (
  over: Partial<ReturnType<typeof loadConfig>> = {},
): Promise<BuiltApp> => {
  const config = loadConfig(over);
  const db = openDatabase({ path: config.database_path });
  const registry = new SessionRegistry({
    // A scenario that runs to its own duration ends itself, and no client has to
    // be watching for that to count. Without this hook a trainee who lost the
    // socket mid-run — laptop closed, Wi-Fi dropped — would find a session stuck
    // in `running` with no score, for an exercise they did in fact finish.
    onEnded: (session) => finalise(db, session, null),
  });

  const app = Fastify({ logger: false });
  app.decorate("db", db);
  app.decorate("speed", config.speed);

  app.register(authPlugin, { db, secret: config.secret });
  app.register(authRoutes, { secret: config.secret });
  app.register(scenarioRoutes);
  app.register(sessionRoutes, { registry });
  app.register(aarRoutes, { registry });

  // The built client, when it exists. In dev (no dist) the Vite dev
  // server owns the UI and proxies here, so serving nothing is correct.
  if (fs.existsSync(config.client_dist)) {
    await app.register(fastifyStatic, { root: config.client_dist, prefix: "/" });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "not_found", message: "No such route." });
    }
    // SPA fallback: any other path is the client's router.
    return reply.sendFile("index.html");
  });

  return { app, registry, config };
};

/**
 * Create the default administrator when the user store is empty.
 *
 * The password is `SKYSENTINEL_ADMIN_PASSWORD` or `admin` — it is
 * printed to the console on first boot because a local, offline,
 * single-operator tool has no out-of-band channel, and a silent default
 * would be worse than a printed one.
 */
export const bootstrapAdmin = (db: ReturnType<typeof openDatabase>): void => {
  if (listUsers(db).length > 0) return;

  const password = process.env["SKYSENTINEL_ADMIN_PASSWORD"] ?? "admin";
  void hashPassword(password).then((hash) => {
    createUser(db, {
      username: "admin",
      password_hash: hash,
      role: "admin",
      display_name: "System Administrator",
    });
    console.log(`[skysentinel] bootstrapped admin — username: admin, password: ${password}`);
    console.log("[skysentinel] change this password from the admin console after first sign-in.");
  });
};

const isMain = (metaUrl: string): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(metaUrl)) === path.resolve(entry);
  } catch {
    return false;
  }
};

if (isMain(import.meta.url)) {
  const { app, registry, config } = await buildApp();
  bootstrapAdmin(app.db);

  await app.listen({ host: config.host, port: config.port });
  attachWs(app.server, { db: app.db, registry, secret: config.secret });

  console.log(`[skysentinel] server on http://${config.host}:${config.port}`);
  console.log(`[skysentinel] client dist: ${config.client_dist}`);
}
