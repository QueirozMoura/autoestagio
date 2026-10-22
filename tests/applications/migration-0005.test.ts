import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  IN_MEMORY,
  getMigrationStatus,
  openDatabase,
  runMigrations,
} from '../../src/db/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Migrações 0001 a 0004: um banco como estava antes da Etapa 3.2. */
function before3_2(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
  dirs.push(dir);
  for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (name < '0005') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

describe('migração 0005 (histórico de candidaturas)', () => {
  it('migra candidaturas e eventos antigos sem perder nada', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db, before3_2());
    db.exec(`
      INSERT INTO sources (id, kind, slug, name) VALUES (1, 'ashby', 'x', 'X');
      INSERT INTO jobs (id, source_id, url, canonical_url, title, content_hash)
        VALUES (1, 1, 'https://e.com/1', 'https://e.com/1', 'Vaga', 'h');
      INSERT INTO applications (id, job_id, mode, status) VALUES (7, 1, 'manual', 'preparada');
      INSERT INTO application_events (application_id, from_status, to_status, detail)
        VALUES (7, NULL, 'preparada', 'criada');
    `);

    expect(runMigrations(db)[0]).toBe('0005_applications_history.sql');

    expect(db.prepare('SELECT id, job_id, mode, status, cv_label FROM applications').all()).toEqual(
      [{ id: 7, job_id: 1, mode: 'revisao', status: 'preparada', cv_label: 'legado' }],
    );
    expect(
      db.prepare('SELECT application_id, to_status, reason, actor FROM application_events').all(),
    ).toEqual([{ application_id: 7, to_status: 'preparada', reason: 'criada', actor: 'sistema' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('é idempotente e não altera migrações anteriores', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
    expect(getMigrationStatus(db).pending).toEqual([]);
  });
});
