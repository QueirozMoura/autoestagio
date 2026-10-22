import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export const IN_MEMORY = ':memory:';

export function openDatabase(path: string, options: { readonly?: boolean } = {}): Db {
  if (path !== IN_MEMORY && !options.readonly) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { readonly: options.readonly ?? false });
  db.pragma('foreign_keys = ON');
  // Vários processos podem abrir o mesmo arquivo: esperar o outro terminar em vez de falhar.
  db.pragma('busy_timeout = 5000');
  if (path !== IN_MEMORY && !options.readonly) {
    db.pragma('journal_mode = WAL');
  }
  return db;
}
