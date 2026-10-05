/**
 * Session lifecycle routes (PRD §15).
 *
 * create → start → (act)* → end → score. Three rules run through every handler:
 *
 *   1. **Actions are validated against live sim state, never trusted.** See
 *      `../actions.ts`; the `execute_response` authority gate is the load-bearing
 *      case, because without it the score could be earned by posting events.
 *
 *   2. **Role filtering happens in one place.** `LiveSession.eventsFor` calls
 *      `filterForRole`; these routes never filter a second time, so there is exactly
 *      one implementation to audit against PRD §6.4.
 *
 *   3. **Scoring is idempotent.** `/end`, `/score` and the registry's own end hook
 *      all call `finalise`, which upserts. A trainee who hits refresh on the score
 *      page does not get two rows.
 *
 *   4. **Injects are instructor-only and never touch an assessment.** `/inject` is
 *      the one route that changes the world from outside the trainee's actions, so
 *      it is role-gated, refused in assessment mode before the sim is touched, and
 *      audited on both outcomes.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { SCENARIO_SCHEMA_VERSION, fingerprint, InjectTypeSchema } from "@skysentinel/scenario";

import {
  appendEvents,
  audit,
  createSession as createSessionRow,
  findScore,
  findSession,
  listSessions,
  listSessionsForTrainee,
  saveScore,
  setSessionStatus,
  upsertScenario,
} from "../../db/repo.js";
import type { Db } from "../../db/index.js";
import { canAccessSession, callerOf, type Caller } from "../auth-plugin.js";
import { applyAction } from "../actions.js";
import { nowIso, nowMs } from "../../ids.js";
import type { LiveSession } from "../../session/live.js";
import type { SessionRegistry } from "../../session/registry.js";
import { resolveScenario } from "./scenarios.js";

const ALL_ROLES = ["trainee", "instructor", "admin"] as const;
const INSTRUCTOR_ROLES = ["instructor", "admin"] as const;

/** The rubric the scorer will use. Pinned per session so a later edit cannot rewrite history. */
const RUBRIC_ID = "default-v1";
const RUBRIC_VERSION = 1;

const CreateSessionSchema = z.object({
  scenario_id: z.string().min(1),
  /** Absent for a trainee launching their own; an instructor may name someone. */
  trainee_id: z.string().min(1).optional(),
  mode: z.enum(["assessment", "training"]).default("training"),
});

const ActionSchema = z.object({
  type: z.enum(["mark_contact", "classify", "report", "act", "request_authority", "view_brief"]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/**
 * One instructor inject (FR-SIM-9).
 *
 * `params` is deliberately a loose record here: the sim decides what each type
 * needs and reports back whether it could use them, so a new inject type is a
 * sim-core change and nothing else. Validating the type itself keeps a typo from
 * being recorded as a real inject in the AAR.
 */
const InjectSchema = z.object({
  type: InjectTypeSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});

export interface SessionRouteDeps {
  registry: SessionRegistry;
}

export const sessionRoutes = async (app: FastifyInstance, deps: SessionRouteDeps) => {
  const { registry } = deps;
  const db = app.db;

  /** Resolve a live session, or reply 404. */
  const liveOr404 = (id: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): LiveSession | undefined => {
    const session = registry.get(id);
    if (!session) {
      void reply.code(404).send({ error: "not_found", message: "No such live session." });
      return undefined;
    }
    return session;
  };

  /** Resolve a live session the caller is allowed to touch, or reply and return undefined. */
  const owned = (
    id: string,
    caller: Caller,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): LiveSession | undefined => {
    const session = registry.get(id);
    if (!session) {
      void reply.code(404).send({ error: "not_found", message: "No such live session." });
      return undefined;
    }
    if (!canAccessSession(caller, { trainee_id: session.trainee_id, instructor_id: session.instructor_id })) {
      void reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
      return undefined;
    }
    return session;
  };

  // --- create ---------------------------------------------------------------

  app.post("/api/sessions", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const parsed = CreateSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

    const caller = callerOf(request);
    const { scenario_id, mode } = parsed.data;

    // A trainee can only start their own session. An instructor may name a trainee.
    const trainee_id = parsed.data.trainee_id ?? caller.id;
    if (caller.role === "trainee" && trainee_id !== caller.id) {
      return reply.code(403).send({ error: "forbidden", message: "A trainee may only launch their own session." });
    }

    const scenario = resolveScenario(db, scenario_id);
    if (!scenario) return reply.code(404).send({ error: "not_found", message: "No such scenario." });

    // Record the scenario so `sessions.scenario_id` has a parent row, which the
    // schema's foreign key requires.
    upsertScenario(db, {
      id: scenario.id,
      kind: scenario.kind,
      fingerprint: fingerprint(scenario),
      spec_json: JSON.stringify(scenario),
      schema_version: SCENARIO_SCHEMA_VERSION,
      ...(scenario.family !== undefined ? { family: scenario.family } : {}),
      ...(scenario.difficulty !== undefined ? { difficulty: scenario.difficulty } : {}),
      seed: scenario.seed,
    });

    const row = createSessionRow(db, {
      scenario_id: scenario.id,
      trainee_id,
      rubric_id: RUBRIC_ID,
      rubric_version: RUBRIC_VERSION,
      mode,
      ...(caller.role === "trainee" ? {} : { instructor_id: caller.id }),
    });

    const session = registry.create(scenario, {
      id: row.id,
      trainee_id,
      mode,
      rubric_id: RUBRIC_ID,
      rubric_version: RUBRIC_VERSION,
      now: nowMs(),
      ...(caller.role === "trainee" ? {} : { instructor_id: caller.id }),
    });

    audit(db, caller.id, "session.create", { session_id: session.id, scenario_id, trainee_id, mode });

    // The scenario goes out minus its answer key. `brief_sections` is repeated at
    // the top level because the console opens the brief before the first tick and a
    // trainee should not have to fetch two endpoints to read their own mission.
    const { expected: _answerKey, ...safeScenario } = scenario;

    return reply.code(201).send({
      session: row,
      scenario: { ...safeScenario, schema_version: SCENARIO_SCHEMA_VERSION },
      brief_sections: scenario.brief_sections,
    });
  });

  // --- read -----------------------------------------------------------------

  app.get("/api/sessions", { preHandler: app.requireRole(ALL_ROLES) }, async (request) => {
    const caller = callerOf(request);
    // A trainee's list is their own, always. The filter is applied here rather than
    // accepted as a query parameter — a trainee passing `?trainee_id=<other>` gets
    // their own list back, not an error, because there is no parameter to honour.
    const sessions = caller.role === "trainee" ? listSessionsForTrainee(db, caller.id) : listSessions(db);
    return { sessions };
  });

  app.get("/api/sessions/:id", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);

    const row = findSession(db, id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
    if (!canAccessSession(caller, row)) {
      return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
    }

    const live = registry.get(id);
    return {
      session: row,
      // A live session has its state in memory; a finished one is read from the log.
      live: live !== undefined,
      ...(live ? { t_ms: live.t_ms(), status: live.currentStatus() } : {}),
    };
  });

  // --- lifecycle ------------------------------------------------------------

  app.post("/api/sessions/:id/start", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = owned(id, callerOf(request), reply);
    if (!session) return reply;

    setSessionStatus(db, id, "running", { started_at: nowIso() });
    session.start(nowMs(), app.speed);
    audit(db, callerOf(request).id, "session.start", { session_id: id });

    return { session_id: id, status: session.currentStatus(), speed: app.speed };
  });

  /**
   * Pause is instructor-only.
   *
   * A trainee cannot freeze the world to buy decision time — that is not a skill the
   * trainer claims to assess, and allowing it would make the timing competencies
   * meaningless.
   */
  app.post("/api/sessions/:id/pause", { preHandler: app.requireRole(INSTRUCTOR_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = liveOr404(id, reply);
    if (!session) return reply;

    session.pause();
    setSessionStatus(db, id, "paused");
    audit(db, callerOf(request).id, "session.pause", { session_id: id });
    return { session_id: id, status: session.currentStatus() };
  });

  app.post("/api/sessions/:id/resume", { preHandler: app.requireRole(INSTRUCTOR_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = liveOr404(id, reply);
    if (!session) return reply;

    session.resume(nowMs(), app.speed);
    setSessionStatus(db, id, "running");
    audit(db, callerOf(request).id, "session.resume", { session_id: id });
    return { session_id: id, status: session.currentStatus() };
  });

  app.post("/api/sessions/:id/end", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);

    // Resolve live-or-persisted here rather than through `owned`: `owned` replies on
    // a miss, and a session that ended itself is absent from the registry but very
    // much present in the database, so the 404 decision belongs to this handler.
    const session = registry.get(id);
    if (!session) {
      const row = findSession(db, id);
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
      if (!canAccessSession(caller, row)) {
        return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
      }
      // Already finished — a client retrying `/end`, or a run that ended itself and
      // was retired. That is the outcome the caller asked for, so it is reported as
      // success with the persisted score rather than as a missing session.
      if (row.status === "scored" || row.status === "ended") {
        return { session_id: id, status: row.status, score: findScoreOrNull(db, id) };
      }
      return reply.code(409).send({
        error: "not_running",
        message: "This session has not started yet.",
        status: row.status,
      });
    }

    if (!canAccessSession(caller, { trainee_id: session.trainee_id, instructor_id: session.instructor_id })) {
      return reply.code(403).send({ error: "forbidden", message: "That session belongs to another trainee." });
    }

    const body = z.object({ reason: z.string().min(1).max(200).default("ended_by_user") })
      .safeParse(request.body ?? {});
    const reason = body.success ? body.data.reason : "ended_by_user";

    session.end(reason, nowMs());
    finalise(db, session, caller.id);

    return { session_id: id, status: session.currentStatus(), score: findScoreOrNull(db, id) };
  });

  // --- actions --------------------------------------------------------------

  /**
   * One trainee action.
   *
   * Returns the truth-free view so the client updates from the same authoritative
   * state the scorer reads, rather than optimistically from its own guess about
   * what the server did with it.
   */
  app.post("/api/sessions/:id/action", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);
    const session = owned(id, caller, reply);
    if (!session) return reply;

    const parsed = ActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

    const outcome = applyAction(session, parsed.data.type, parsed.data.payload);
    if (!outcome.ok) {
      // Rejections are audited because a client repeatedly posting unauthorised
      // actions is a signal worth having, and because the refusal itself is part of
      // the assessment record.
      audit(db, caller.id, "session.action_rejected", {
        session_id: id,
        type: parsed.data.type,
        reason: outcome.reason,
      });
      return reply.code(409).send({ error: "rejected", message: outcome.reason });
    }

    return { session_id: id, t_ms: session.t_ms(), view: session.view() };
  });

  /**
   * One instructor inject (FR-SIM-9, PRD §13.2 / §15).
   *
   * Instructor-only, and refused outright in assessment mode: an assessment run is
   * scored against what the trainee did on their own, and an instructor who degraded
   * a sensor mid-run would have changed the difficulty of the exercise being graded.
   * The refusal is decided before the sim is touched, so a refused inject leaves no
   * mark on the run at all.
   */
  app.post("/api/sessions/:id/inject", { preHandler: app.requireRole(INSTRUCTOR_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const caller = callerOf(request);
    const session = owned(id, caller, reply);
    if (!session) return reply;

    if (session.mode === "assessment") {
      audit(db, caller.id, "session.inject_refused", { session_id: id, reason: "assessment_mode" });
      return reply.code(409).send({
        error: "assessment",
        message: "Injects are disabled in assessment mode.",
      });
    }

    const parsed = InjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

    // `by` is the instructor's id, so the AAR can tell a scripted degradation from
    // one a human chose to add.
    const applied = session.inject(parsed.data.type, parsed.data.params, caller.id);
    // Both outcomes are audited: an inject that logged but had no effect is still a
    // thing an instructor tried, and a client that keeps sending unusable params is
    // a signal worth having.
    audit(db, caller.id, applied ? "session.inject" : "session.inject_no_effect", {
      session_id: id,
      type: parsed.data.type,
      params: parsed.data.params,
    });

    return { session_id: id, t_ms: session.t_ms(), applied, view: session.view() };
  });

  /**
   * The current view, on demand.
   *
   * The WS stream carries frames, but a client that reconnects mid-run needs the
   * present state immediately rather than waiting for the next tick.
   */
  app.get("/api/sessions/:id/view", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = owned(id, callerOf(request), reply);
    if (!session) return reply;

    return { session_id: id, t_ms: session.t_ms(), view: session.view() };
  });

  return app;
};

/**
 * Score and persist an ended session.
 *
 * Called from `/end`, from the AAR's first fetch, and when a session ends itself
 * (see `main.ts`). `saveScore` upserts and `setSessionStatus` is idempotent, so a
 * double call is harmless — which matters because all three callers can arrive,
 * in any order.
 *
 * The events are appended here rather than on every tick. A run is a few hundred
 * events, not a few thousand, and holding the whole log in memory until the end is
 * what makes an uninterrupted run cheap; the log is also already in memory because
 * the scorer needs it.
 */
export const finalise = (db: Db, session: LiveSession, actor: string | null): void => {
  const result = session.score();
  const snap = session.snapshot();

  const pointsOf = (competency: string): number =>
    result.competencies.find((c) => c.competency === competency)?.points ?? 0;

  saveScore(db, {
    session_id: session.id,
    total: result.total,
    detection: pointsOf("detection"),
    classification: pointsOf("classification"),
    response: pointsOf("response"),
    reporting: pointsOf("reporting"),
    prioritisation: pointsOf("prioritisation"),
    coordination: pointsOf("coordination"),
    adaptation: pointsOf("adaptation"),
    critical_errors: result.critical_errors.length,
    result_json: JSON.stringify(result),
  });

  appendEvents(db, session.id, session.rawEvents());

  setSessionStatus(db, session.id, "scored", {
    ended_at: nowIso(),
    ...(snap.duration_ms !== null ? { duration_ms: snap.duration_ms } : {}),
    ...(snap.end_reason !== null ? { end_reason: snap.end_reason } : {}),
  });

  audit(db, actor, "session.scored", { session_id: session.id, total: result.total });
};

/** The persisted score with its result tree parsed out, or null if not scored yet. */
const findScoreOrNull = (db: Db, session_id: string) => {
  const row = findScore(db, session_id);
  if (!row) return null;
  return { total: row.total, result: JSON.parse(row.result_json) as unknown };
};