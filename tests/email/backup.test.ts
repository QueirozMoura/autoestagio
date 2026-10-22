import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupDatabase,
  backupPath,
  openDatabase,
  runMigrations,
  type Db,
} from '../../src/db/index.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-'));
  db = openDatabase(join(dir, 'origem.db'));
  runMigrations(db);
  db.exec("INSERT INTO sources (id, kind, slug, name) VALUES (1, 'ashby', 'x', 'X')");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('copia o banco em uso (WAL), confere integridade e contagem de linhas, e deixa 0600', async () => {
    const target = join(dir, 'backups', 'copia.db');
    const result = await backupDatabase(db, target);
    expect(result.path).toBe(target);
    expect(result.tables).toBeGreaterThan(10);
    expect(result.rows).toBeGreaterThanOrEqual(2); // sources + migrações registradas
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'backups')).mode & 0o777).toBe(0o700);

    const copy = new Database(target, { readonly: true });
    expect(copy.prepare('SELECT slug FROM sources').get()).toEqual({ slug: 'x' });
    copy.close();
  });

  it('nunca sobrescreve um backup existente', async () => {
    const target = join(dir, 'copia.db');
    writeFileSync(target, 'importante');
    await expect(backupDatabase(db, target)).rejects.toThrow(/não será sobrescrito/);
  });

  it('o nome do backup traz o motivo e a data', () => {
    expect(backupPath('/x/backups', 'pre-0007', new Date('2026-10-22T16:07:12Z'))).toBe(
      '/x/backups/autoestagio.pre-0007.20261022-160712.db',
    );
  });

  it('a verificação detecta cópia diferente do original e apaga o backup ruim', async () => {
    const target = join(dir, 'ruim.db');
    // Simula escritas concorrentes: o original ganha uma linha enquanto o backup é feito.
    const original = db.backup.bind(db);
    db.backup = async (destination: string) => {
      const result = await original(destination);
      db.exec("INSERT INTO sources (id, kind, slug, name) VALUES (2, 'ashby', 'y', 'Y')");
      return result;
    };
    await expect(backupDatabase(db, target)).rejects.toThrow(
      /difere do original na tabela sources/,
    );
    expect(() => statSync(target)).toThrow();
  });
});
