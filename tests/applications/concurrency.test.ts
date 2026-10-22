import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  getApplication,
  getHistory,
  recoverInterrupted,
  setApplicationMode,
  transitionApplication,
} from '../../src/applications/index.js';
import { openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { CV, PROFILE_HASH, T0, seedJob } from '../helpers/applications.js';

const run = promisify(execFile);
const WORKER = join(PROJECT_ROOT, 'tests', 'helpers', 'application-worker.ts');
const PROCESSES = 6;

let dir: string;
let file: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoestagio-conc-'));
  file = join(dir, 'teste.db');
  db = openDatabase(file);
  runMigrations(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  created?: boolean;
  reason?: string | null;
  changed?: boolean;
  error?: string;
}

async function worker(action: string, ...args: (string | number)[]): Promise<Outcome> {
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', WORKER, file, action, ...args.map(String)],
    { cwd: PROJECT_ROOT, timeout: 60_000 },
  ).catch((error: unknown) => ({
    stdout: (error as { stdout?: string }).stdout ?? '',
  }));
  const line = stdout.trim().split('\n').filter(Boolean).at(0);
  return line === undefined ? { error: 'sem saída' } : (JSON.parse(line) as Outcome);
}

function approvedApplication(): number {
  const result = createApplication(
    db,
    { jobId: seedJob(db), cv: CV, profileHash: PROFILE_HASH, channel: 'email' },
    T0,
  );
  if (!result.created) throw new Error('esperava criar');
  const id = result.application.id;
  setApplicationMode(db, id, 'revisao', { reason: 'r', actor: 'usuario' }, T0);
  transitionApplication(db, id, { to: 'aprovada_para_envio', reason: 'ok', actor: 'usuario' }, T0);
  return id;
}

describe('concorrência entre processos (mesmo arquivo SQLite)', () => {
  it('N processos criando a candidatura da mesma vaga: só uma é criada', async () => {
    const jobId = seedJob(db);
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, () => worker('create', jobId)),
    );

    expect(results.filter((r) => r.created === true)).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'ja_existe')).toHaveLength(PROCESSES - 1);
    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM application_events').get()).toEqual({ n: 1 });
  }, 90_000);

  it('N processos tentando enviar a mesma candidatura: exatamente um reserva o envio', async () => {
    const id = approvedApplication();
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, (_, i) => worker('send', id, `chave-${i}`)),
    );

    expect(results.filter((r) => r.changed === true)).toHaveLength(1);
    expect(results.filter((r) => r.error === 'transicao_invalida')).toHaveLength(PROCESSES - 1);
    expect(getApplication(db, id)?.status).toBe('enviando');
    expect(getHistory(db, id).filter((e) => e.toStatus === 'enviando')).toHaveLength(1);
  }, 90_000);

  it('retentativas com a mesma chave de idempotência: uma só mudança, sem erro', async () => {
    const id = approvedApplication();
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, () => worker('send', id, 'mesma-chave')),
    );

    expect(results.filter((r) => r.changed === true)).toHaveLength(1);
    expect(results.filter((r) => r.changed === false)).toHaveLength(PROCESSES - 1);
    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(getHistory(db, id).filter((e) => e.toStatus === 'enviando')).toHaveLength(1);
  }, 90_000);

  it('processo que cai logo depois de reservar o envio: recuperação leva para intervenção humana', async () => {
    const id = approvedApplication();
    const outcome = await worker('reserve-and-crash', id, 'k1'); // sai com código 137
    expect(outcome.changed).toBe(true);

    // O estado sobreviveu à queda do processo (WAL) e nada foi reenviado.
    expect(getApplication(db, id)?.status).toBe('enviando');
    const later = new Date(Date.now() + 60 * 60_000);
    expect(recoverInterrupted(db, { olderThanMs: 15 * 60_000, now: later })).toEqual([id]);
    expect(getApplication(db, id)?.status).toBe('pendente_intervencao_humana');

    // Uma nova tentativa automática de envio é recusada.
    const retry = await worker('send', id, 'k2');
    expect(retry.error).toBe('transicao_invalida');
  }, 90_000);
});
