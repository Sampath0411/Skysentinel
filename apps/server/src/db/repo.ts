/**
 * Repository layer (PRD §7.1).
 *
 * Every SQL statement in the server lives here, parameterised (PRD §17 security).
 * The routes above this layer deal in domain objects and never see a row.
 *
 * Two shapes are deliberately kept apart. `SessionRow` and friends are the stored
 * record; the `*Record` types are what a caller gets back. For most tables they
 * coincide, but not for sessions: a session row carries the raw `spec_json` and
 * the mode/instructor wiring that only the server needs, and returning it whole
 * would put scenario internals in an HTTP response.
 */

import type { AnySimEvent, Role } from "@skysentinel/shared";

import type { Db } from "./index.js";
import { newId, nowIso } from "../ids.js";

// --- users and units -------------------------------------------------------

export interface UserRecord {
  id: string;
  username: string;
  display_name: string | null;
  role: Role;
  unit_id: string | null;
  created_at: string;
}

export interface UserWithSecret extends UserRecord {
  password_hash: string;
}

export interface UnitRecord {
  id: string;
  name: string;
  created_at: string;
}

export const createUnit = (db: Db, name: string, id = newId("unit_")): UnitRecord => {
  const created_at = nowIso();
  db.prepare("INSERT INTO units(id, name, created_at) VALUES (?, ?, ?)").run(id, name, created_at);
  return { id, name, created_at };
};

export const listUnits = (db: Db): UnitRecord[] =>
  db.prepare("SELECT id, name, created_at FROM units ORDER BY name").all() as UnitRecord[];

export const createUser = (
  db: Db,
  input: { username: string; password_hash: string; role: Role; display_name?: string; unit_id?: string },
): UserRecord => {
  const id = newId("usr_");
  const created_at = nowIso();
  db.prepare(
    `INSERT INTO users(id, username, display_name, role, password_hash, unit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.username,
    input.display_name ?? null,
    input.role,
    input.password_hash,
    input.unit_id ?? null,
    created_at,
  );
  return { id, username: input.username, display_name: input.display_name ?? null, role: input.role, unit_id: input.unit_id ?? null, created_at };
};

/**
 * Look up by username for login.
 *
 * The only query that returns the password hash, and it is the only place a
 * caller may legitimately need one.
 */
export const findUserByUsername = (db: Db, username: string): UserWithSecret | undefined =>
  db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserWithSecret | undefined;

export const findUserById = (db: Db, id: string): UserRecord | undefined =>
  db.prepare("SELECT id, username, display_name, role, unit_id, created_at FROM users WHERE id = ?").get(id) as
    | UserRecord
    | undefined;

export const listUsers = (db: Db, unit_id?: string): UserRecord[] =>
  (unit_id
    ? db.prepare("SELECT id, username, display_name, role, unit_id, created_at FROM users WHERE unit_id = ? ORDER BY username")
    : db.prepare("SELECT id, username, display_name, role, unit_id, created_at FROM users ORDER BY username")
  ).all(...(unit_id ? [unit_id] : [])) as UserRecord[];

/** Overwrite a password hash. Used at login to transparently upgrade old hashes. */
export const setPasswordHash = (db: Db, user_id: string, password_hash: string): void => {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, user_id);
};

// --- scenarios -------------------------------------------------------------

export interface ScenarioRow {
  id: string;
  kind: "scripted" | "generated";
  family: string | null;
  difficulty: number | null;
  seed: number | null;
  fingerprint: string;
  spec_json: string;
  schema_version: number;
  created_at: string;
}

/**
 * Record a scenario, or return the existing row if the fingerprint is known.
 *
 * Keyed on fingerprint rather than id because a generated scenario's id contains
 * its seed, so re-generating the same seed would otherwise accumulate duplicate
 * rows that differ only in their id — and `sessions.scenario_id` would then have
 * many parents for identical content.
 */
export const upsertScenario = (
  db: Db,
  input: { id: string; kind: "scripted" | "generated"; fingerprint: string; spec_json: string; schema_version: number; family?: string; difficulty?: number; seed?: number },
): ScenarioRow => {
  const existing = db.prepare("SELECT * FROM scenarios WHERE fingerprint = ?").get(input.fingerprint) as
    | ScenarioRow
    | undefined;
  if (existing) return existing;

  const created_at = nowIso();
  db.prepare(
    `INSERT INTO scenarios(id, kind, family, difficulty, seed, fingerprint, spec_json, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    input.family ?? null,
    input.difficulty ?? null,
    input.seed ?? null,
    input.fingerprint,
    input.spec_json,
    input.schema_version,
    created_at,
  );
  return db.prepare("SELECT * FROM scenarios WHERE id = ?").get(input.id) as ScenarioRow;
};

export const findScenario = (db: Db, id: string): ScenarioRow | undefined =>
  db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as ScenarioRow | undefined;

export const findScenarioByFingerprint = (db: Db, fingerprint: string): ScenarioRow | undefined =>
  db.prepare("SELECT * FROM scenarios WHERE fingerprint = ?").get(fingerprint) as ScenarioRow | undefined;

export const listScenarios = (db: Db): ScenarioRow[] =>
  db.prepare("SELECT * FROM scenarios ORDER BY created_at DESC").all() as ScenarioRow[];

// --- sessions --------------------------------------------------------------

export type SessionStatus = "created" | "running" | "paused" | "ended" | "scored";
export type SessionMode = "assessment" | "training";

export interface SessionRecord {
  id: string;
  scenario_id: string;
  trainee_id: string;
  instructor_id: string | null;
  rubric_id: string;
  rubric_version: number;
  started_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  duration_ms: number | null;
  end_reason: string | null;
  mode: SessionMode;
}

export const createSession = (
  db: Db,
  input: {
    scenario_id: string;
    trainee_id: string;
    instructor_id?: string;
    rubric_id: string;
    rubric_version: number;
    mode: SessionMode;
  },
): SessionRecord => {
  const id = newId("ses_");
  db.prepare(
    `INSERT INTO sessions(id, scenario_id, trainee_id, instructor_id, rubric_id, rubric_version, status, mode)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?)`,
  ).run(id, input.scenario_id, input.trainee_id, input.instructor_id ?? null, input.rubric_id, input.rubric_version, input.mode);

  return { id, scenario_id: input.scenario_id, trainee_id: input.trainee_id, instructor_id: input.instructor_id ?? null, rubric_id: input.rubric_id, rubric_version: input.rubric_version, started_at: null, ended_at: null, status: "created", duration_ms: null, end_reason: null, mode: input.mode };
};

export const findSession = (db: Db, id: string): SessionRecord | undefined =>
  db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | undefined;

export const setSessionStatus = (
  db: Db,
  id: string,
  status: SessionStatus,
  patch: Partial<Pick<SessionRecord, "started_at" | "ended_at" | "duration_ms" | "end_reason">> = {},
): void => {
  const sets: string[] = ["status = ?"];
  const args: unknown[] = [status];

  for (const key of ["started_at", "ended_at", "duration_ms", "end_reason"] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      args.push(patch[key]);
    }
  }
  args.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args);
};

export const listSessionsForTrainee = (db: Db, trainee_id: string, limit = 100): SessionRecord[] =>
  db
    .prepare("SELECT * FROM sessions WHERE trainee_id = ? ORDER BY COALESCE(started_at, '') DESC LIMIT ?")
    .all(trainee_id, limit) as SessionRecord[];

export const listSessions = (db: Db, limit = 200): SessionRecord[] =>
  db.prepare("SELECT * FROM sessions ORDER BY COALESCE(started_at, '') DESC LIMIT ?").all(limit) as SessionRecord[];

// --- events ----------------------------------------------------------------

/**
 * Append events for a session.
 *
 * `INSERT OR IGNORE` rather than a plain insert: `seq` is the primary key within a
 * session, and a client reconnecting mid-run re-receives the tail it missed. Being
 * idempotent here means the store can absorb that without the caller having to
 * know whether the batch was new.
 */
export const appendEvents = (db: Db, session_id: string, events: readonly AnySimEvent[]): number => {
  if (events.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO events(session_id, seq, t_ms, type, actor, visibility, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insert = db.transaction((batch: readonly AnySimEvent[]) => {
    let n = 0;
    for (const e of batch) {
      n += stmt.run(session_id, e.seq, e.t_ms, e.type, e.actor, e.visibility, JSON.stringify(e.payload)).changes;
    }
    return n;
  });
  return insert(events);
};

/**
 * Read events back, for the REST feed and the AAR replay.
 *
 * `types` filters server-side. The client uses it to fetch just the track stream
 * when scrubbing the timeline, and fetching everything and filtering in the
 * browser would put the truth-bearing events into the browser's memory even if it
 * never displayed them.
 */
export const readEvents = (
  db: Db,
  session_id: string,
  opts: { from_seq?: number; to_t_ms?: number; types?: readonly string[]; limit?: number } = {},
): AnySimEvent[] => {
  const where: string[] = ["session_id = ?"];
  const args: unknown[] = [session_id];

  if (opts.from_seq !== undefined) {
    where.push("seq >= ?");
    args.push(opts.from_seq);
  }
  if (opts.to_t_ms !== undefined) {
    where.push("t_ms <= ?");
    args.push(opts.to_t_ms);
  }
  if (opts.types && opts.types.length > 0) {
    where.push(`type IN (${opts.types.map(() => "?").join(",")})`);
    args.push(...opts.types);
  }
  if (opts.limit !== undefined) {
    args.push(opts.limit);
  }

  const sql = `SELECT seq, t_ms, type, actor, visibility, payload_json FROM events
               WHERE ${where.join(" AND ")} ORDER BY seq ASC${opts.limit !== undefined ? " LIMIT ?" : ""}`;

  const rows = db.prepare(sql).all(...args) as {
    seq: number;
    t_ms: number;
    type: string;
    actor: string;
    visibility: string;
    payload_json: string;
  }[];

  return rows.map((r) => ({
    seq: r.seq,
    t_ms: r.t_ms,
    type: r.type,
    actor: r.actor,
    visibility: r.visibility,
    payload: JSON.parse(r.payload_json),
  })) as AnySimEvent[];
};

export const countEvents = (db: Db, session_id: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(session_id) as { n: number }).n;

// --- scores ----------------------------------------------------------------

export interface ScoreRecord {
  session_id: string;
  total: number;
  detection: number;
  classification: number;
  response: number;
  reporting: number;
  prioritisation: number;
  coordination: number;
  adaptation: number;
  critical_errors: number;
  result_json: string;
}

export const saveScore = (
  db: Db,
  score: Omit<ScoreRecord, "result_json"> & { result_json: string },
): void => {
  db.prepare(
    `INSERT INTO scores(session_id, total, detection, classification, response, reporting,
                        prioritisation, coordination, adaptation, critical_errors, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       total = excluded.total, detection = excluded.detection, classification = excluded.classification,
       response = excluded.response, reporting = excluded.reporting, prioritisation = excluded.prioritisation,
       coordination = excluded.coordination, adaptation = excluded.adaptation,
       critical_errors = excluded.critical_errors, result_json = excluded.result_json`,
  ).run(
    score.session_id,
    score.total,
    score.detection,
    score.classification,
    score.response,
    score.reporting,
    score.prioritisation,
    score.coordination,
    score.adaptation,
    score.critical_errors,
    score.result_json,
  );
};

export const findScore = (db: Db, session_id: string): ScoreRecord | undefined =>
  db.prepare("SELECT * FROM scores WHERE session_id = ?").get(session_id) as ScoreRecord | undefined;

// --- annotations -----------------------------------------------------------

export interface AnnotationRecord {
  id: string;
  session_id: string;
  t_ms: number;
  author_id: string;
  text: string;
  created_at: string;
}

export const addAnnotation = (
  db: Db,
  input: { session_id: string; t_ms: number; author_id: string; text: string },
): AnnotationRecord => {
  const id = newId("ann_");
  const created_at = nowIso();
  db.prepare(
    "INSERT INTO annotations(id, session_id, t_ms, author_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.session_id, input.t_ms, input.author_id, input.text, created_at);
  return { ...input, id, created_at };
};

export const listAnnotations = (db: Db, session_id: string): AnnotationRecord[] =>
  db.prepare("SELECT * FROM annotations WHERE session_id = ? ORDER BY t_ms").all(session_id) as AnnotationRecord[];

// --- audit -----------------------------------------------------------------

export interface AuditRecord {
  id: number;
  ts: string;
  user_id: string | null;
  action: string;
  detail_json: string;
}

/**
 * Append to the audit log (PRD §17).
 *
 * Never throws and never rejects: an audit write failing must not take down a
 * login or a session start, because losing the action is worse than losing its
 * log line. A gap in the audit is visible; a 500 on a trainee's login is not
 * recoverable.
 */
export const audit = (db: Db, user_id: string | null, action: string, detail: unknown = {}): void => {
  try {
    db.prepare("INSERT INTO audit_log(ts, user_id, action, detail_json) VALUES (?, ?, ?, ?)").run(
      nowIso(),
      user_id,
      action,
      JSON.stringify(detail),
    );
  } catch {
    // Deliberately swallowed. See the doc comment.
  }
};

export const listAudit = (db: Db, limit = 200): AuditRecord[] =>
  db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as AuditRecord[];
