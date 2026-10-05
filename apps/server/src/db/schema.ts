/**
 * SQLite schema and migrations (PRD §7.1).
 *
 * One migration list, applied in order and recorded in `schema_migrations`. There
 * is no down-migration: this is a local training tool whose data is a record of
 * what a trainee did, and silently dropping rows to "roll back" would destroy the
 * evidence an assessment exists to keep. A restore is a file copy.
 *
 * Every statement is parameterised by the repo layer. Nothing in this file
 * interpolates a value — the only interpolation is the migration index, which is
 * an integer this module chose.
 */

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/** Indexed, versioned migrations (PRD §17 reliability). */
export const MIGRATIONS: readonly Migration[] = [
  {
    name: "001-initial",
    sql: `
CREATE TABLE units(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK(role IN ('trainee','instructor','admin')),
  password_hash TEXT NOT NULL,
  unit_id TEXT REFERENCES units(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_users_unit ON users(unit_id);

CREATE TABLE scenarios(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('scripted','generated')),
  family TEXT,
  difficulty INTEGER,
  seed INTEGER,
  fingerprint TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL REFERENCES scenarios(id),
  trainee_id TEXT NOT NULL REFERENCES users(id),
  instructor_id TEXT REFERENCES users(id),
  rubric_id TEXT NOT NULL,
  rubric_version INTEGER NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('created','running','paused','ended','scored')),
  duration_ms INTEGER,
  end_reason TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('assessment','training'))
);
CREATE INDEX idx_sessions_trainee ON sessions(trainee_id);
CREATE INDEX idx_sessions_scenario ON sessions(scenario_id);

CREATE TABLE events(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  visibility TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
CREATE INDEX idx_events_type ON events(session_id, type);
CREATE INDEX idx_events_time ON events(session_id, t_ms);

CREATE TABLE scores(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  total REAL,
  detection REAL,
  classification REAL,
  response REAL,
  reporting REAL,
  prioritisation REAL,
  coordination REAL,
  adaptation REAL,
  critical_errors INTEGER,
  result_json TEXT NOT NULL
);
CREATE INDEX idx_scores_total ON scores(total);

CREATE TABLE skill_state(
  trainee_id TEXT NOT NULL REFERENCES users(id),
  competency TEXT NOT NULL,
  mastery REAL NOT NULL,
  n_obs INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(trainee_id, competency)
);

CREATE TABLE recommendations(
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL REFERENCES users(id),
  after_session_id TEXT REFERENCES sessions(id),
  family TEXT,
  difficulty INTEGER,
  seed INTEGER,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','accepted','dismissed')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reco_trainee ON recommendations(trainee_id);

CREATE TABLE annotations(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  t_ms INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_session ON annotations(session_id, t_ms);

CREATE TABLE rubrics(
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(id, version)
);

CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX idx_audit_user ON audit_log(user_id);
`,
  },
  {
    name: "002-brief-events",
    // `brief_viewed` defaults to instructor visibility (an operator reading their
    // own brief is not privileged information), but N4 and N9 score it, so the
    // trainee needs to see their own. Recorded here rather than by changing the
    // default, because the default exists to fail safe for truth-bearing events.
    sql: `
CREATE INDEX idx_events_visibility ON events(session_id, visibility);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
