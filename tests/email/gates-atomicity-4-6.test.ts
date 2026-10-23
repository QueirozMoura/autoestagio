import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApplication } from '../../src/applications/index.js';
import { openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  EmailError,
  TEST_EVIDENCE_FUTURE_TOLERANCE_MIN,
  TEST_EVIDENCE_MAX_HOURS,
  preflight,
  sendEmail,
  type EmailContext,
} from '../../src/email/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { NOW } from '../helpers/eligibility.js';
import {
  authorizeConfirmed,
  seedTestEvidence,
  setupApproved,
  type Setup,
} from '../helpers/email.js';

vi.setConfig({ testTimeout: 120_000 });
const run = promisify(execFile);
const WORKER = join(PROJECT_ROOT, 'tests', 'helpers', 'application-worker.ts');

let dir: string;
let db: Db;
let extra: Db[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoestagio-gates-'));
  db = openDatabase(join(dir, 'teste.db'));
  runMigrations(db);
  extra = [];
});
afterEach(() => {
  db.close();
  for (const e of extra) e.close();
  rmSync(dir, { recursive: true, force: true });
});
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const withClock = (ctx: EmailContext, minutes: number): EmailContext => ({
  ...ctx,
  now: () => at(minutes),
});
/** O mesmo arquivo SQLite aberto por uma conexão INDEPENDENTE. */
const otherConnection = (ctx: EmailContext): EmailContext => {
  const conn = openDatabase(join(dir, 'teste.db'));
  extra.push(conn);
  return { ...ctx, db: conn };
};
const app = (
  recipient: string,
  title: string,
  company: string,
  over: Parameters<typeof setupApproved>[1] = {},
): Setup => setupApproved(db, { recipient, job: { title, company }, ...over });
const realRows = (): number =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real'").get() as {
      n: number;
    }
  ).n;

describe('validade da evidência de teste (24 h)', () => {
  const tested = async (s: Setup): Promise<void> => {
    const t = authorizeConfirmed(s.ctx, s.applicationId, 'teste', 'teste');
    expect((await sendEmail(s.ctx, s.applicationId, t.id, 'teste')).outcome).toBe('aceito');
  };
  const failing = (ctx: EmailContext, id: number): string[] =>
    preflight(ctx, id, 'real')
      .checks.filter((c) => !c.ok && c.sendOnly !== true)
      .map((c) => c.id);

  it('teste recente vale; com mais de 24 h vence (usando o horário persistido do despacho)', async () => {
    const s = app(
      'rh@acme-ficticia.com.br',
      'Estágio em Desenvolvimento Backend',
      'Acme Ficticia',
      { testEvidence: false },
    );
    await tested(s);
    expect(failing(withClock(s.ctx, 5), s.applicationId)).toEqual([]);
    expect(failing(withClock(s.ctx, TEST_EVIDENCE_MAX_HOURS * 60 - 1), s.applicationId)).toEqual(
      [],
    );
    const old = withClock(s.ctx, TEST_EVIDENCE_MAX_HOURS * 60 + 1);
    expect(failing(old, s.applicationId)).toEqual(['teste_previo']);
    expect(
      preflight(old, s.applicationId, 'real').checks.find((c) => c.id === 'teste_previo')?.detail,
    ).toContain('mais de 24 h');
    expect(() => authorizeConfirmed(old, s.applicationId, 'real', 'autorizo')).toThrow(
      /teste_previo/,
    );
  });

  it('teste com conteúdo diferente ou de outra candidatura não vale', async () => {
    const a = app(
      'rh@acme-ficticia.com.br',
      'Estágio em Desenvolvimento Backend',
      'Acme Ficticia',
      { testEvidence: false },
    );
    const b = app('rh@outra-ficticia.com.br', 'Estágio em QA', 'Outra Ficticia', {
      testEvidence: false,
    });
    await tested(a);
    expect(failing(b.ctx, b.applicationId)).toEqual(['teste_previo']);
    db.prepare(
      'UPDATE application_drafts SET content_hash = ?, reviewed_hash = ? WHERE application_id = ?',
    ).run('c'.repeat(64), 'c'.repeat(64), a.applicationId);
    expect(failing(a.ctx, a.applicationId)).toEqual(['teste_previo']);
  });

  it('timestamp inválido ou futuro (além da tolerância) invalida; dentro da tolerância vale', async () => {
    const s = app(
      'rh@acme-ficticia.com.br',
      'Estágio em Desenvolvimento Backend',
      'Acme Ficticia',
      { testEvidence: false },
    );
    await tested(s);
    const set = (value: string): void => {
      db.prepare(
        "UPDATE email_dispatches SET finished_at = ?, reserved_at = ? WHERE kind = 'teste'",
      ).run(value, value);
    };
    const stamp = (minutes: number): string => at(minutes).toISOString();
    set(stamp(TEST_EVIDENCE_FUTURE_TOLERANCE_MIN - 1));
    expect(failing(s.ctx, s.applicationId)).toEqual([]);
    set(stamp(TEST_EVIDENCE_FUTURE_TOLERANCE_MIN + 5));
    expect(failing(s.ctx, s.applicationId)).toEqual(['teste_previo']);
    expect(
      preflight(s.ctx, s.applicationId, 'real').checks.find((c) => c.id === 'teste_previo')?.detail,
    ).toContain('inválido ou no futuro');
    set('não é uma data');
    expect(failing(s.ctx, s.applicationId)).toEqual(['teste_previo']);
    set('');
    expect(failing(s.ctx, s.applicationId)).toEqual(['teste_previo']);
  });

  it('o registro histórico do teste não é alterado pelas verificações', async () => {
    const s = app(
      'rh@acme-ficticia.com.br',
      'Estágio em Desenvolvimento Backend',
      'Acme Ficticia',
      { testEvidence: false },
    );
    await tested(s);
    const before = db.prepare('SELECT * FROM email_dispatches').all();
    failing(withClock(s.ctx, 3 * 24 * 60), s.applicationId);
    expect(db.prepare('SELECT * FROM email_dispatches').all()).toEqual(before);
  });
});

describe('revalidação atômica na reserva do envio real (conexões independentes)', () => {
  it('intervalo mínimo: outra execução reservou depois do preflight', async () => {
    const a = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const b = app('contato@outra-ficticia.com.br', 'Estágio em QA', 'Outra Ficticia');
    const authA = authorizeConfirmed(a.ctx, a.applicationId, 'real', 'a');
    const authB = authorizeConfirmed(b.ctx, b.applicationId, 'real', 'b');
    const ctxB: EmailContext = {
      ...otherConnection(withClock(b.ctx, 5)),
      // Entre o preflight de B e a reserva de B, A conclui o seu envio.
      beforeReserve: async () => {
        expect((await sendEmail(a.ctx, a.applicationId, authA.id, 'real')).outcome).toBe('aceito');
      },
    };
    await expect(sendEmail(ctxB, b.applicationId, authB.id, 'real')).rejects.toThrow(
      /bloqueado na reserva.*intervalo_minimo/u,
    );
    expect(b.transport.calls).toEqual([]);
    expect(realRows()).toBe(1);
    expect(
      db.prepare('SELECT used_at FROM email_authorizations WHERE id = ?').get(authB.id),
    ).toEqual({ used_at: null });
    expect(getApplication(db, b.applicationId)?.status).toBe('aprovada_para_envio');
  });

  it('destinatário repetido (já fora do intervalo): bloqueado na reserva', async () => {
    const a = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const b = app('rh+vaga2@acme-ficticia.com.br', 'Estágio em QA', 'Outra Ficticia');
    const authA = authorizeConfirmed(a.ctx, a.applicationId, 'real', 'a');
    const later = withClock(b.ctx, 20);
    seedTestEvidence(later, b.applicationId);
    const authB = authorizeConfirmed(later, b.applicationId, 'real', 'b');
    const ctxB: EmailContext = {
      ...otherConnection(later),
      beforeReserve: async () => {
        await sendEmail(a.ctx, a.applicationId, authA.id, 'real');
      },
    };
    await expect(sendEmail(ctxB, b.applicationId, authB.id, 'real')).rejects.toThrow(
      /bloqueado na reserva.*destinatario_repetido/u,
    );
    expect(b.transport.calls).toEqual([]);
    expect(realRows()).toBe(1);
  });

  it('limite diário global: bloqueado na reserva', async () => {
    const a = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const b = app('contato@outra-ficticia.com.br', 'Estágio em QA', 'Outra Ficticia');
    const authA = authorizeConfirmed({ ...a.ctx, maxPerDay: 1 }, a.applicationId, 'real', 'a');
    const later = { ...withClock(b.ctx, 20), maxPerDay: 1 };
    seedTestEvidence(later, b.applicationId);
    const authB = authorizeConfirmed(later, b.applicationId, 'real', 'b');
    const ctxB: EmailContext = {
      ...otherConnection(later),
      beforeReserve: async () => {
        await sendEmail({ ...a.ctx, maxPerDay: 1 }, a.applicationId, authA.id, 'real');
      },
    };
    await expect(sendEmail(ctxB, b.applicationId, authB.id, 'real')).rejects.toThrow(
      /bloqueado na reserva.*limite_diario/u,
    );
    expect(realRows()).toBe(1);
  });

  it('evidência de teste que some entre o preflight e a reserva: bloqueado', async () => {
    const s = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const auth = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a');
    const conn = otherConnection(s.ctx);
    const ctx: EmailContext = {
      ...conn,
      beforeReserve: () => {
        db.prepare(
          "UPDATE email_dispatches SET status = 'desconhecido' WHERE kind = 'teste'",
        ).run();
      },
    };
    await expect(sendEmail(ctx, s.applicationId, auth.id, 'real')).rejects.toThrow(
      /bloqueado na reserva.*teste_previo/u,
    );
    expect(s.transport.calls).toEqual([]);
    expect(realRows()).toBe(0);
  });

  it('autorização de uso único consumida por outra execução: a segunda não envia', async () => {
    const s = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const auth = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a');
    const ctx: EmailContext = {
      ...otherConnection(s.ctx),
      beforeReserve: async () => {
        await sendEmail(s.ctx, s.applicationId, auth.id, 'real');
      },
    };
    await expect(sendEmail(ctx, s.applicationId, auth.id, 'real')).rejects.toThrow(EmailError);
    expect(s.transport.calls).toHaveLength(1);
    expect(realRows()).toBe(1);
  });

  it('anti-duplicação: duas autorizações da mesma candidatura, só um envio', async () => {
    const s = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const first = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a');
    const second = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'b');
    const ctx: EmailContext = {
      ...otherConnection(s.ctx),
      beforeReserve: async () => {
        await sendEmail(s.ctx, s.applicationId, second.id, 'real');
      },
    };
    await expect(sendEmail(ctx, s.applicationId, first.id, 'real')).rejects.toThrow(
      /bloqueado na reserva.*sem_envio_anterior|EmailError/u,
    );
    expect(s.transport.calls).toHaveLength(1);
    expect(realRows()).toBe(1);
  });

  it('sem os limites violados a reserva segue normalmente (a revalidação não bloqueia o caminho feliz)', async () => {
    const s = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const auth = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a');
    expect(
      (await sendEmail(otherConnection(s.ctx), s.applicationId, auth.id, 'real')).outcome,
    ).toBe('aceito');
  });
});

describe('envio simultâneo em processos separados (mesmo arquivo SQLite, Gmail simulado)', () => {
  async function child(
    applicationId: number,
    authorizationId: number,
    logFile: string,
    offsetMin = 0,
  ) {
    try {
      const { stdout } = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          WORKER,
          join(dir, 'teste.db'),
          'email-send',
          String(applicationId),
          String(authorizationId),
          logFile,
          String(offsetMin),
        ],
        { cwd: PROJECT_ROOT, timeout: 90_000 },
      );
      return JSON.parse(stdout.trim().split('\n').filter(Boolean)[0] ?? '{}') as {
        outcome?: string;
        error?: string;
      };
    } catch (error) {
      const out = (error as { stdout?: string }).stdout ?? '';
      return JSON.parse(out.trim().split('\n').filter(Boolean)[0] ?? '{}') as {
        outcome?: string;
        error?: string;
      };
    }
  }
  const sent = (log: string): number =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;

  it('candidaturas diferentes e destinatários diferentes: exatamente UMA passa (intervalo global)', async () => {
    const log = join(dir, 'saidas.log');
    const apps = ['alfa', 'beta', 'gama', 'delta'].map((n) =>
      app(`rh@${n}-ficticia.com.br`, `Estágio em Desenvolvimento ${n}`, `${n} Ficticia`),
    );
    const auths = apps.map((s) => authorizeConfirmed(s.ctx, s.applicationId, 'real', 'x'));
    const results = await Promise.all(
      apps.map((s, i) => child(s.applicationId, nn(auths[i]).id, log)),
    );
    expect(results.filter((r) => r.outcome === 'aceito')).toHaveLength(1);
    expect(sent(log)).toBe(1);
    expect(realRows()).toBe(1);
  });

  it('mesmo destinatário em candidaturas diferentes, mesmo com relógios afastados: exatamente UMA passa', async () => {
    const log = join(dir, 'saidas.log');
    const a = app('rh@acme-ficticia.com.br', 'Estágio em Desenvolvimento Backend', 'Acme Ficticia');
    const b = app('rh+outra@acme-ficticia.com.br', 'Estágio em QA', 'Outra Ficticia');
    // B enxerga o relógio 20 min à frente: o intervalo não a barra, o destinatário repetido sim.
    seedTestEvidence(withClock(b.ctx, 20), b.applicationId);
    const authA = authorizeConfirmed(a.ctx, a.applicationId, 'real', 'a');
    const authB = authorizeConfirmed(withClock(b.ctx, 20), b.applicationId, 'real', 'b');
    const results = await Promise.all([
      child(a.applicationId, authA.id, log, 0),
      child(b.applicationId, authB.id, log, 20),
    ]);
    expect(results.filter((r) => r.outcome === 'aceito')).toHaveLength(1);
    expect(sent(log)).toBe(1);
    expect(realRows()).toBe(1);
  });
});

const nn = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('valor ausente');
  return v;
};
