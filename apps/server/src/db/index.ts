/**
 * Database handle and migrations (PRD §7.1, §17).
 *
 * Wraps better-sqlite3 rather than spreading it through the app, so the pragmas
 * that matter are set in exactly one place:
 *
 *   - `journal_mode = WAL`, so a crash mid-session keeps the events flushed up to
 *     the last write (PRD §17 reliability);
 *   - `foreign_keys = ON`, which SQLite defaults *off* — without it the FK columns
 *     in the PRD schema are documentation rather than constraints, and a session
 *     can point at a trainee who does not exist;
 *   - `synchronous = NORMAL`, the standard pairing with WAL. `FULL` would fsync on
 *     every event insert, and a 15-minute scenario emits thousands.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { MIGRATIONS } from "./schema.js";

export type Db = Database.Database;

export interface OpenOptions {
  /** `:memory:` for tests. */
  path?: string;
  /** Applied to `PRAGMA foreign_keys`. Off only for migration-time introspection. */
  foreign_keys?: boolean;
}

/**
 * Open (and if needed create) the database, then apply pending migrations.
 *
 * `readonly` is honoured for the AAR read path, but migrations cannot run against
 * a read-only file, so the caller must pass a writable path when the schema may be
 * behind.
 */
export const openDatabase = (options: OpenOptions = {}): Db => {
  const file = options.path ?? ":memory:";

  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new Database(file);

  if (file !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  if (options.foreign_keys === false) db.pragma("foreign_keys = OFF");

  migrate(db);
  return db;
};

/**
 * Apply every migration not yet recorded.
 *
 * Each migration runs inside a transaction with its bookkeeping row, so an
 * interrupted upgrade leaves the database at a version it is actually consistent
 * with rather than half-way through a `CREATE TABLE`.
 */
export const migrate = (db: Db): number => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(
      idx INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare("SELECT idx FROM schema_migrations").all().map((r) => (r as { idx: number }).idx),
  );

  for (const [idx, migration] of MIGRATIONS.entries()) {
    if (applied.has(idx + 1)) continue;

    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(idx, name) VALUES (?, ?)").run(idx + 1, migration.name);
    });
    run();
  }

  const row = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
  return row.n;
};

/** Roll a database back to nothing. Test helper — never called by the app. */
export const freshDatabase = (): Db => {
  const db = openDatabase({ path: ":memory:" });
  return db;
};
