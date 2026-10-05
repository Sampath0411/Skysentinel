/**
 * Post-session routes: events, score, replay, annotations, and trainee progress.
 *
 * The AAR is the only place ground truth reaches a trainee, and only about their own
 * run — that is the entire point of the debrief (PRD §12). The check is
 * `canAccessSession`, the same one the live routes use, so "whose run is this" is
 * decided once.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { filterForRole } from "@skysentinel/shared";

import {
  addAnnotation,
  findScore,
  findSession,
  listAnnotations,
  listSessionsForTrainee,
  readEvents,
  listAudit,
} from "../../db/repo.js";
import type { Db } from "../../db/index.js";
import { canAccessSession, callerOf } from "../auth-plugin.js";
import { finalise } from "./sessions.js";
import type { SessionRegistry } from "../../session/registry.js";

const ALL_ROLES = ["trainee", "instructor", "admin"] as const;
const INSTRUCTOR_ROLES = ["instructor", "admin"] as const;

const AnnotationSchema = z.object({
  t_ms: z.number().int().min(0),
  text: z.string().min(1).max(2000),
});

export interface AarRouteDeps {
  registry: SessionRegistry;
}

export const aarRoutes = async (app: FastifyInstance, deps: AarRouteDeps) => {
  const { registry } = deps;
  const db = app.db;

  /**
   * The event log for a session.
   *
   * A live session reads from memory and a finished one from SQLite; either way the
   * filtering is `filterForRole`, and for a persisted session `readEvents` has
   * already excluded truth-bearing event *types* on the server so they never reach
   * browser memory even transiently.
   */
  app.get("/api/sessions/:id/events", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);
    const query = parseEventQuery(request.query);

    const live = registry.get(id);
    if (live) {
      if (!canAccessSession(caller, { trainee_id: live.trainee_id, instructor_id: live.instructor_id })) {
        return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
      }
      return {
        events: live.eventsFor(caller.role, {
          ...query,
        }),
      };
    }

    const row = findSession(db, id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
    if (!canAccessSession(caller, row)) {
      return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
    }

    const stored = readEvents(db, id, query);
    return { events: filterForRole(stored, caller.role) };
  });

  /**
   * The score.
   *
   * If the session has ended but has not been scored — a run the server restarted
   * mid-flight, say — it is scored here rather than 404-ing. The score is a pure
   * function of the log plus the truth the server still holds, so this is safe to
   * repeat.
   */
  app.get("/api/sessions/:id/score", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);

    const row = findSession(db, id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
    if (!canAccessSession(caller, row)) {
      return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
    }

    const live = registry.get(id);
    if (live && (live.currentStatus() === "ended" || live.currentStatus() === "scored")) {
      finalise(db, live, caller.id);
    }

    const score = findScore(db, id);
    if (!score) {
      return reply.code(409).send({
        error: "not_scored",
        message: "This session has not finished yet. The score appears when it does.",
        status: live?.currentStatus() ?? row.status,
      });
    }

    return { score: { ...score, result: JSON.parse(score.result_json) as unknown } };
  });

  /**
   * Replay data for the AAR timeline (PRD §12).
   *
   * The timeline's whole job is comparing *what you knew* against *what was actually
   * there*, so this returns both: the filtered event log, and — for a session still
   * in memory — the live truth map. A trainee who has ended their own run sees their
   * own truth here and nobody else's, which is why `canAccessSession` gates the
   * whole route rather than just the events field.
   *
   * After the session leaves the registry the truth map is gone — it lives in the
   * simulation, not the database. The AAR's "what actually happened" view is then
   * reconstructed from the persisted `entity_spawned` events, which the instructor
   * role can read and a trainee cannot. That asymmetry is deliberate: the debrief
   * for a just-finished run is fully populated, and an archived one degrades to the
   * process record rather than silently showing a half-truth.
   */
  app.get("/api/sessions/:id/replay", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);

    const row = findSession(db, id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
    if (!canAccessSession(caller, row)) {
      return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
    }

    const live = registry.get(id);
    const events = live
      ? live.eventsFor(caller.role)
      : filterForRole(readEvents(db, id, {}), caller.role);

    // Truth overlay only for an instructor/admin, and only while the world is still
    // in memory. A trainee's own debrief gets the correlation through the AAR's
    // per-track reviews instead, which is scored data rather than a raw truth map.
    const truth = live && caller.role !== "trainee" ? live.truthEntities() : [];

    return {
      session: row,
      events,
      truth,
      annotations: listAnnotations(db, id),
      score: findScore(db, id) ?? null,
    };
  });

  app.post("/api/sessions/:id/annotations", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);

    const row = findSession(db, id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
    if (!canAccessSession(caller, row)) {
      return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
    }

    const parsed = AnnotationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

    const annotation = addAnnotation(db, {
      session_id: id,
      t_ms: parsed.data.t_ms,
      author_id: caller.id,
      text: parsed.data.text,
    });
    return reply.code(201).send({ annotation });
  });

  /**
   * A trainee's own history and trend (PRD §11).
   *
   * Scores only — no truth, no other trainees' runs. `listSessionsForTrainee` rather
   * than a filter over `listSessions`, so the scope is a property of the query and
   * not of a parameter this handler could forget to check.
   */
  app.get("/api/trainees/:id/progress", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);

    // A trainee reads their own progress; anyone else must be staff.
    if (caller.role === "trainee" && caller.id !== id) {
      return reply.code(403).send({ error: "forbidden", message: "That is another trainee's record." });
    }

    const sessions = listSessionsForTrainee(db, id).filter((s) => s.status === "scored");
    const points = sessions.map((s) => {
      const score = findScore(db, s.id);
      return {
        session_id: s.id,
        scenario_id: s.scenario_id,
        mode: s.mode,
        ended_at: s.ended_at,
        total: score?.total ?? null,
        critical_errors: score?.critical_errors ?? null,
      };
    });

    const scored = points.filter((p): p is typeof p & { total: number } => p.total !== null);

    return {
      trainee_id: id,
      runs: points,
      summary: {
        runs: points.length,
        mean_total: scored.length === 0 ? null : round2(mean(scored.map((p) => p.total))),
        best_total: scored.length === 0 ? null : Math.max(...scored.map((p) => p.total)),
      },
    };
  });

  /** The audit trail. Staff only — a trainee cannot read it (PRD §17). */
  app.get("/api/audit", { preHandler: app.requireRole(INSTRUCTOR_ROLES) }, async () => ({
    entries: listAudit(db),
  }));

  return app;
};

/**
 * Event-log query.
 *
 * A malformed parameter is ignored rather than rejected: a client building a URL by
 * hand should get the whole log rather than a 400, and every filter here is
 * narrowing, so the worst case of ignoring one is a longer response.
 */
const parseEventQuery = (query: unknown): { from_seq?: number; to_t_ms?: number; types?: string[] } => {
  const q = (query ?? {}) as { from?: string; to?: string; types?: string };
  const out: { from_seq?: number; to_t_ms?: number; types?: string[] } = {};

  const from = Number(q.from);
  if (Number.isInteger(from) && from >= 0) out.from_seq = from;

  const to = Number(q.to);
  if (Number.isInteger(to) && to >= 0) out.to_t_ms = to;

  if (typeof q.types === "string" && q.types.length > 0) {
    const types = q.types.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    if (types.length > 0) out.types = types;
  }
  return out;
};

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Type-only re-export so tests can reach the Db type through this module. */
export type { Db };