import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getApplication } from '../../src/applications/index.js';
import { openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { recoverEmailDispatches } from '../../src/email/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { NOW } from '../helpers/eligibility.js';
import { authorizeConfirmed, setupApproved, type Setup } from '../helpers/email.js';

const run = promisify(execFile);
const WORKER = join(PROJECT_ROOT, 'tests', 'helpers', 'application-worker.ts');
const PROCESSES = 6;

let dir: string;
let db: Db;
let setup: Setup;
let logFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoestagio-email-'));
  db = openDatabase(join(dir, 'teste.db'));
  runMigrations(db);
  setup = setupApproved(db);
  logFile = join(dir, 'saidas.log');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function child(
  action: string,
  ...args: (string | number)[]
): Promise<{ outcome?: string; error?: string; crashed?: boolean }> {
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', WORKER, join(dir, 'teste.db'), action, ...args.map(String)],
      {
        cwd: PROJECT_ROOT,
        timeout: 60_000,
      },
    );
    const line = stdout.trim().split('\n').filter(Boolean).at(0);
    return line === undefined
      ? { error: 'sem saída' }
      : (JSON.parse(line) as { outcome?: string; error?: string });
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    const line = (failure.stdout ?? '').trim().split('\n').filter(Boolean).at(0);
    return line === undefined
      ? { crashed: failure.code === 137 }
      : (JSON.parse(line) as { error?: string });
  }
}

const sentLines = (): number =>
  existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;

describe('envio concorrente (vários processos, mesmo arquivo SQLite, Gmail simulado)', () => {
  it('N processos com N autorizações válidas: exatamente UM e-mail sai', async () => {
    const authorizations = Array.from({ length: PROCESSES }, () =>
      authorizeConfirmed(setup.ctx, setup.applicationId, 'real', 'teste de concorrência'),
    );
    const results = await Promise.all(
      authorizations.map((auth) => child('email-send', setup.applicationId, auth.id, logFile)),
    );

    expect(results.filter((r) => r.outcome === 'aceito')).toHaveLength(1);
    expect(sentLines()).toBe(1); // o "Gmail" foi chamado uma única vez
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real'").get(),
    ).toEqual({ n: 1 });
    expect(getApplication(db, setup.applicationId)?.status).toBe('enviada');
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM application_confirmations WHERE kind = 'aceito_pelo_gmail'",
        )
        .get(),
    ).toEqual({ n: 1 });
  }, 120_000);

  it('processo que cai logo depois de o Gmail aceitar: resultado desconhecido, recuperação, e NENHUM reenvio', async () => {
    const first = authorizeConfirmed(setup.ctx, setup.applicationId, 'real', 'primeira');
    const second = authorizeConfirmed(setup.ctx, setup.applicationId, 'real', 'segunda');

    const crashed = await child('email-send-crash', setup.applicationId, first.id, logFile);
    expect(crashed.crashed).toBe(true);
    expect(sentLines()).toBe(1);
    expect(getApplication(db, setup.applicationId)?.status).toBe('enviando');

    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(recoverEmailDispatches(db, { olderThanMs: 10 * 60_000, now: later })).toHaveLength(1);
    expect(getApplication(db, setup.applicationId)?.status).toBe('pendente_intervencao_humana');

    // Mesmo com outra autorização válida em mãos, o sistema não reenvia.
    const retry = await child('email-send', setup.applicationId, second.id, logFile);
    expect(retry.error ?? retry.outcome).not.toBe('aceito');
    expect(sentLines()).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real'").get(),
    ).toEqual({ n: 1 });
  }, 120_000);
});
