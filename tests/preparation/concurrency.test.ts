import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { seedJob } from '../helpers/applications.js';

const run = promisify(execFile);
const WORKER = join(PROJECT_ROOT, 'tests', 'helpers', 'application-worker.ts');
const PROCESSES = 6;

let dir: string;
let file: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoestagio-prep-'));
  file = join(dir, 'teste.db');
  db = openDatabase(file);
  runMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function prepareInChild(
  jobId: number,
): Promise<{ outcome?: string; applicationId?: number; error?: string }> {
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', WORKER, file, 'prepare', String(jobId)],
    {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
    },
  ).catch((error: unknown) => ({ stdout: (error as { stdout?: string }).stdout ?? '' }));
  const line = stdout.trim().split('\n').filter(Boolean).at(0);
  return line === undefined
    ? { error: 'sem saída' }
    : (JSON.parse(line) as { outcome?: string; applicationId?: number; error?: string });
}

describe('preparação concorrente (vários processos, mesmo arquivo SQLite)', () => {
  it('N processos preparando a mesma vaga: uma candidatura, um rascunho, um único "preparada"', async () => {
    const jobId = seedJob(db, {
      title: 'Estágio em Desenvolvimento',
      description: 'Requisitos: TypeScript.',
      workMode: 'remoto',
      location: 'Remote - Brazil',
      stipend: 1800,
      verdict: null,
    });
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, () => prepareInChild(jobId)),
    );

    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(results.filter((r) => r.outcome === 'preparada')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'inalterada')).toHaveLength(PROCESSES - 1);
    expect(new Set(results.map((r) => r.applicationId)).size).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM application_drafts').get()).toEqual({ n: 1 });
    // criação + geração do rascunho, uma vez só
    expect(db.prepare('SELECT COUNT(*) AS n FROM application_events').get()).toEqual({ n: 2 });
  }, 90_000);
});
