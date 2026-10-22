import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection.js';
import { PROJECT_ROOT } from '../utils/paths.js';

export const DEFAULT_MIGRATIONS_DIR = join(PROJECT_ROOT, 'migrations');

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function appliedChecksums(db: Db): Map<string, string> {
  const rows = db.prepare('SELECT name, checksum FROM schema_migrations').all() as {
    name: string;
    checksum: string;
  }[];
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

/** Aplica as migrações pendentes, cada uma em uma transação. Retorna os nomes aplicados. */
export function runMigrations(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  ensureMigrationsTable(db);
  const applied = appliedChecksums(db);
  const insert = db.prepare('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)');
  const newlyApplied: string[] = [];

  for (const migration of readMigrationFiles(dir)) {
    const existing = applied.get(migration.name);
    if (existing !== undefined) {
      if (existing !== migration.checksum) {
        throw new Error(`Migração ${migration.name} foi alterada após ser aplicada`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.name, migration.checksum);
    })();
    newlyApplied.push(migration.name);
  }
  return newlyApplied;
}

/** Consulta o estado das migrações sem modificar o banco. */
export function getMigrationStatus(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR): MigrationStatus {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  const applied = hasTable ? [...appliedChecksums(db).keys()].sort() : [];
  const pending = readMigrationFiles(dir)
    .map((migration) => migration.name)
    .filter((name) => !applied.includes(name));
  return { applied, pending };
}
