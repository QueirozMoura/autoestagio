import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './connection.js';

export interface BackupResult {
  path: string;
  tables: number;
  rows: number;
}

function userTables(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function rowCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of userTables(db)) {
    counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  }
  return counts;
}

/**
 * Cópia consistente do banco (API de backup do SQLite, segura com WAL e com o banco em uso) seguida
 * de verificação: `integrity_check` e contagem de linhas de todas as tabelas, iguais às do original.
 * Se algo não bater, a cópia é apagada e a função lança. O arquivo fica com permissão 0600.
 */
export async function backupDatabase(db: Db, destination: string): Promise<BackupResult> {
  if (existsSync(destination))
    throw new Error(`O backup já existe e não será sobrescrito: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });

  try {
    await db.backup(destination);
    chmodSync(destination, 0o600);

    const copy = new Database(destination, { readonly: true });
    try {
      const integrity = copy.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok')
        throw new Error(`integrity_check do backup falhou: ${String(integrity)}`);
      const original = rowCounts(db);
      const copied = rowCounts(copy);
      for (const [table, count] of Object.entries(original)) {
        if (copied[table] !== count) {
          throw new Error(
            `o backup difere do original na tabela ${table} (${copied[table] ?? 'ausente'} ≠ ${count})`,
          );
        }
      }
      return {
        path: destination,
        tables: Object.keys(original).length,
        rows: Object.values(original).reduce((sum, n) => sum + n, 0),
      };
    } finally {
      copy.close();
      // A abertura somente leitura de um banco WAL deixa arquivos auxiliares vazios.
      rmSync(`${destination}-wal`, { force: true });
      rmSync(`${destination}-shm`, { force: true });
    }
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

/** Nome padrão: `<pasta>/autoestagio.<motivo>.<AAAAMMDD-HHMMSS>.db`. */
export function backupPath(dir: string, reason: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return join(dir, `autoestagio.${reason}.${stamp}.db`);
}
