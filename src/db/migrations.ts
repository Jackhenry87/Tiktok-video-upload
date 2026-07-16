import type { Database as DatabaseType } from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from './schema';

interface Migration {
  id: number;
  name: string;
  up: (db: DatabaseType) => void;
}

/**
 * Ordered migrations. Add new entries at the end — never edit an applied one.
 */
const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    up: (db) => {
      for (const stmt of SCHEMA_STATEMENTS) {
        db.exec(stmt);
      }
    },
  },
];

export function runMigrations(db: DatabaseType): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const appliedIds = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );

  let appliedCount = 0;
  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name,
      );
    });
    apply();
    appliedCount += 1;
  }
  return appliedCount;
}
