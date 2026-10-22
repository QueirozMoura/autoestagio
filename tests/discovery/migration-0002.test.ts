import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Pasta de migrações só com a 0001, para simular um banco criado na Fase 1. */
function onlyFirstMigration(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
  tempDirs.push(dir);
  copyFileSync(
    join(DEFAULT_MIGRATIONS_DIR, '0001_initial_schema.sql'),
    join(dir, '0001_initial_schema.sql'),
  );
  return dir;
}

describe('migração 0002 (incremental sobre a 0001)', () => {
  it('preserva os dados existentes e as relações entre tabelas', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db, onlyFirstMigration());

    // Dados criados com o esquema da Fase 1.
    db.exec(`
      INSERT INTO sources (kind, name) VALUES ('gupy', 'Empresa X');
      INSERT INTO jobs (source_id, external_id, url, title, company, content_hash, first_seen_at, last_seen_at)
        VALUES (1, 'E-1', 'https://v.test/1', 'Estágio', 'Empresa X', 'hash-1', '2026-10-01 10:00:00', '2026-10-02 10:00:00');
      INSERT INTO job_analysis (job_id, score) VALUES (1, 80);
      INSERT INTO applications (job_id, mode) VALUES (1, 'dry-run');
      INSERT INTO application_events (application_id, to_status) VALUES (1, 'preparada');
    `);

    const applied = runMigrations(db);
    expect(applied[0]).toBe('0002_jobs_persistence.sql');
    expect(applied).toContain('0003_jobs_apply_url.sql');

    expect(db.prepare('SELECT kind, slug, name FROM sources').all()).toEqual([
      { kind: 'gupy', slug: 'Empresa X', name: 'Empresa X' },
    ]);
    expect(
      db
        .prepare(
          'SELECT id, external_id, url, canonical_url, title, first_seen_at, last_seen_at, updated_at FROM jobs',
        )
        .get(),
    ).toEqual({
      id: 1,
      external_id: 'E-1',
      url: 'https://v.test/1',
      canonical_url: 'https://v.test/1',
      title: 'Estágio',
      first_seen_at: '2026-10-01 10:00:00',
      last_seen_at: '2026-10-02 10:00:00',
      updated_at: '2026-10-02 10:00:00',
    });
    // As tabelas que referenciam `jobs` continuam intactas, sem cascata acidental.
    expect(db.prepare('SELECT job_id, score FROM job_analysis').all()).toEqual([
      { job_id: 1, score: 80 },
    ]);
    expect(db.prepare('SELECT job_id FROM applications').all()).toEqual([{ job_id: 1 }]);
    expect(db.prepare('SELECT to_status FROM application_events').all()).toEqual([
      { to_status: 'preparada' },
    ]);
    // A aparição da vaga antiga foi reconstruída.
    expect(db.prepare('SELECT job_id, source_id, external_id FROM job_sightings').all()).toEqual([
      { job_id: 1, source_id: 1, external_id: 'E-1' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('as foreign keys voltam a ser impostas depois da migração', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO job_sightings (job_id, source_id, url, canonical_url, first_seen_at, last_seen_at) VALUES (999, 1, 'u', 'u', 'a', 'a')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('content_hash deixou de ser único, e as restrições novas valem', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    db.exec("INSERT INTO sources (kind, slug, name) VALUES ('greenhouse', 'x', 'X')");
    const insert = db.prepare(
      "INSERT INTO jobs (source_id, url, canonical_url, title, content_hash) VALUES (1, ?, ?, 'T', 'mesmo-hash')",
    );
    insert.run('https://v.test/1', 'https://v.test/1');
    expect(() => insert.run('https://v.test/2', 'https://v.test/2')).not.toThrow();

    expect(() =>
      db.exec("INSERT INTO sources (kind, slug, name) VALUES ('greenhouse', 'x', 'Outro')"),
    ).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO sources (kind, slug, name) VALUES ('', 'y', 'Y')")).toThrow(
      /CHECK/,
    );
    expect(() =>
      db.exec(
        "INSERT INTO job_possible_duplicates (job_id, other_job_id, reason, created_at) VALUES (1, 1, 'r', 'a')",
      ),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('é idempotente e não altera a migração 0001 já aplicada', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
    expect(getMigrationStatus(db).pending).toEqual([]);
    db.close();
  });

  it('uma migração que deixa foreign key inválida é revertida por inteiro', () => {
    const dir = onlyFirstMigration();
    writeFileSync(
      join(dir, '0002_quebrada.sql'),
      `INSERT INTO sources (kind, name) VALUES ('other', 'S');
       INSERT INTO jobs (source_id, url, title, content_hash) VALUES (999, 'u', 't', 'h');`,
    );
    const db = openDatabase(IN_MEMORY);
    expect(() => runMigrations(db, dir)).toThrow(/foreign key/);

    expect(getMigrationStatus(db, dir).applied).toEqual(['0001_initial_schema.sql']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});
