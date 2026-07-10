import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

/**
 * One table. The log is the only durable state on this server, which is why
 * restarting it is always safe. See DECISIONS #5.
 *
 * `seq` is a GLOBAL autoincrement, not per-session. A single writer gives a
 * total order, which is exactly what SSE's Last-Event-ID resume contract wants.
 *
 * `session_id` and `project_id` will hold one value each for months. They cost
 * nothing now and are irritating to backfill. See DECISIONS #14.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    project_id  TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    type        TEXT    NOT NULL,
    payload     TEXT    NOT NULL
  );
  CREATE INDEX events_session ON events (session_id, seq);
  CREATE INDEX events_type    ON events (type);
  `,
]

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number

  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]
    if (!sql) continue
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.pragma(`user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
