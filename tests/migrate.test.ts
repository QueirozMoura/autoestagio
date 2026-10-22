import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getMigrationStatus, IN_MEMORY, openDatabase, runMigrations } from '../src/db/index.js';

const tempDirs: string[] = [];

function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrações', () => {
  it('aplica o esquema inicial real', () => {
    const db = openDatabase(IN_MEMORY);
    const applied = runMigrations(db);
    expect(applied).toContain('0001_initial_schema.sql');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'sources',
        'jobs',
        'job_analysis',
        'applications',
        'application_events',
        'scan_runs',
      ]),
    );
    db.close();
  });

  it('é idempotente', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
    expect(getMigrationStatus(db).pending).toEqual([]);
    db.close();
  });

  it('reverte uma migração que falha', () => {
    const dir = tempMigrations({
      '0001_ok.sql': 'CREATE TABLE a (id INTEGER);',
      '0002_bad.sql': 'CREATE TABLE b (id INTEGER); SELECT * FROM tabela_inexistente;',
    });
    const db = openDatabase(IN_MEMORY);
    expect(() => runMigrations(db, dir)).toThrow();
    expect(getMigrationStatus(db, dir)).toEqual({
      applied: ['0001_ok.sql'],
      pending: ['0002_bad.sql'],
    });
    const b = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'").get();
    expect(b).toBeUndefined();
    db.close();
  });

  it('detecta migração alterada após aplicada', () => {
    const dir = tempMigrations({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    const db = openDatabase(IN_MEMORY);
    runMigrations(db, dir);
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER, x TEXT);');
    expect(() => runMigrations(db, dir)).toThrow(/foi alterada/);
    db.close();
  });

  it('impõe as restrições do esquema', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO applications (job_id, mode, cv_sha256, cv_label, eligibility_verdict,
                                     profile_hash, created_at, updated_at)
           VALUES (999, 'dry-run', ?, 'cv.pdf', 'apto', 'h', 'x', 'x')`,
        )
        .run('a'.repeat(64)),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
