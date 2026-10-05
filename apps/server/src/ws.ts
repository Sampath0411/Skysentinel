/**
 * Frame WebSocket (PRD §6.3).
 *
 * One endpoint, `/ws?session_id=<id>&token=<token>`. The token rides the
 * query string because browsers cannot set headers on a WebSocket
 * handshake; the token is the same bearer token the REST routes accept,
 * and it is verified against the same secret before anything is sent.
 *
 * The server owns the simulation, so this layer only fans frames out:
 * `LiveSession` emits `frame` and `ended`, and each socket receives the
 * events its role is allowed to see. Filtering happens inside
 * `LiveSession.frame(role)` — the one place that decides what a role
 * receives (PRD §6.4).
 */

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import type { Role } from "@skysentinel/shared";

import { verifyToken } from "./auth/tokens.js";
import { canAccessSession, type Caller } from "./http/auth-plugin.js";
import { findUserById } from "./db/repo.js";
import type { Db } from "./db/index.js";
import { nowMs } from "./ids.js";
import type { LiveSession } from "./session/live.js";
import type { SessionRegistry } from "./session/registry.js";

export interface WsDeps {
  db: Db;
  registry: SessionRegistry;
  secret: string;
}

const OPEN = WebSocket.OPEN;

/** Attach the frame socket to the running HTTP server. */
export const attachWs = (server: Server, deps: WsDeps): WebSocketServer => {
  const { db, registry, secret } = deps;
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const sessionId = url.searchParams.get("session_id") ?? "";

    const reject = (message: string) => {
      if (socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: "error", message }));
      }
      socket.close();
    };

    const verified = verifyToken(token, secret, nowMs());
    if (!verified.ok) return reject("unauthenticated");

    const user = findUserById(db, verified.claims.user_id);
    if (!user) return reject("unauthenticated");

    const caller: Caller = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      unit_id: user.unit_id,
    };

    const session = registry.get(sessionId);
    if (!session) return reject("no such live session");
    if (!canAccessSession(caller, session)) return reject("forbidden");

    const role: Role = user.role;

    const onFrame = (live: LiveSession) => {
      if (live.id !== sessionId || socket.readyState !== OPEN) return;
      socket.send(JSON.stringify(live.frame(role)));
    };
    const onEnded = (msg: unknown) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
      socket.close();
    };

    session.on("frame", onFrame);
    session.on("ended", onEnded);

    // Current state immediately, so a client that connects mid-run does not
    // wait for the next tick to paint. The full event log is included so
    // the radio log and track history are populated from the first frame.
    socket.send(
      JSON.stringify({
        type: "tick",
        session_id: sessionId,
        t_ms: session.t_ms(),
        view: session.view(),
        events: session.eventsFor(role),
      }),
    );

    const ping = setInterval(() => {
      if (socket.readyState === OPEN) socket.ping();
    }, 30_000);

    socket.on("close", () => {
      clearInterval(ping);
      session.off("frame", onFrame);
      session.off("ended", onEnded);
    });
  });

  return wss;
};
