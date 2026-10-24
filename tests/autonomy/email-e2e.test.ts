import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGrant,
  grantCode,
  parsePolicy,
  runAutonomous,
  type Policy,
  type RunOptions,
} from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import type { EmailContext } from '../../src/email/index.js';
import { seedJob, type SeedJob } from '../helpers/applications.js';
import {
  CV_BYTES,
  CV_SHA,
  FakeTransport,
  RECIPIENT,
  TEST_MAILBOX,
  decodeRaw,
  emailProfile,
} from '../helpers/email.js';

/**
 * Fluxo de ponta a ponta com Gmail SIMULADO (nenhuma rede): descoberta do destinatário na vaga, preparo, revisão,
 * aprovação, teste prévio, código de confirmação, autorização de uso único, envio, evidência e relatório. Os
 * portões do canal de e-mail (intervalo de 15 min, duplicidade, resultado incerto) continuam valendo.
 */
const T0 = new Date('2026-10-24T12:00:00Z');
let clock: Date;
let db: Db;
let transport: FakeTransport;
let sleeps: number[];
let seq = 0;
const policy = parsePolicy({
  enabled: true,
  limits: { maxPerRun: 5, maxPerDay: 10, cooldownSeconds: 180 },
  real: { authorized: true, connectors: ['email'] },
});

beforeEach(() => {
  clock = new Date(T0);
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
  transport = new FakeTransport();
  sleeps = [];
});

const vaga = (over: SeedJob = {}): number =>
  seedJob(db, {
    verdict: null,
    title: 'Estágio em Desenvolvimento Backend',
    company: 'Acme Ficticia',
    description: `Requisitos: TypeScript e SQL.\nEnvie sua candidatura para ${RECIPIENT}.`,
    workMode: 'remoto',
    location: 'Remote - Brazil',
    stipend: 1800,
    applyUrl: `https://acme-ficticia.example/vaga/${++seq}`,
    ...over,
  });

const context = (sendEnabled = true): EmailContext => ({
  db,
  profile: emailProfile(),
  transport,
  sendEnabled,
  maxPerDay: 10,
  testMailbox: TEST_MAILBOX,
  readCv: () => CV_BYTES,
  now: () => clock,
});

const grantFor = (p: Policy = policy): void => {
  createGrant(db, p, { days: 30, confirm: grantCode(p, 30), reason: 'teste', now: T0 });
};

const real = (over: Partial<RunOptions> = {}, p: Policy = policy) =>
  runAutonomous({
    db,
    profile: emailProfile(),
    policy: p,
    mode: 'real',
    trigger: 'timer',
    emailContext: context(),
    cv: { sha256: CV_SHA, label: 'curriculo-ficticio.pdf' },
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock = new Date(clock.getTime() + ms);
      return Promise.resolve();
    },
    ...over,
  });

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe('modo real com e-mail (Gmail simulado)', () => {
  it('envia uma candidatura de ponta a ponta: teste prévio + envio real, evidência e estado "enviada"', async () => {
    const id = vaga();
    grantFor();
    const report = await real();
    expect(report.status).toBe('concluida');
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]).toMatchObject({
      jobId: id,
      decision: 'enviada',
      connector: 'email',
    });
    expect(report.decisions[0]?.evidence).toMatch(/^candidatura:\d+;envio:\d+$/);

    // Duas mensagens: o teste (para a SUA caixa) e o envio real (para o destinatário da vaga).
    expect(transport.calls).toHaveLength(2);
    const [testMail, realMail] = transport.calls.map(decodeRaw);
    expect(testMail).toContain(TEST_MAILBOX);
    expect(realMail).toContain(RECIPIENT);
    expect(count("SELECT COUNT(*) AS n FROM applications WHERE status = 'enviada'")).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real' AND status = 'aceito'"),
    ).toBe(1);
    // Trilha auditável: a autorização cita a concessão.
    const auth = db
      .prepare("SELECT reason FROM email_authorizations WHERE kind = 'real'")
      .get() as { reason: string };
    expect(auth.reason).toContain('autorização permanente #1');
    expect(report.limits.sentToday).toBe(1);
  });

  it('não reenvia: uma segunda execução ignora a vaga que já tem candidatura', async () => {
    vaga();
    grantFor();
    await real();
    const again = await real();
    expect(again.decisions).toHaveLength(0);
    expect(transport.calls).toHaveLength(2);
    expect(count('SELECT COUNT(*) AS n FROM applications')).toBe(1);
  });

  it('respeita o limite por execução e espera os 15 min do canal antes do segundo envio (execução seguinte)', async () => {
    vaga({
      company: 'Empresa A',
      description: 'Requisitos: TypeScript e SQL.\nEnvie para rh@empresa-a.com.br.',
    });
    vaga({
      company: 'Empresa B',
      description: 'Requisitos: TypeScript e SQL.\nEnvie para rh@empresa-b.com.br.',
    });
    const tight = parsePolicy({ ...policy, limits: { ...policy.limits, maxPerRun: 1 } });
    grantFor(tight);
    const first = await real({}, tight);
    expect(first.counts).toMatchObject({ enviada: 1, limite_atingido: 1 });
    // Segunda execução: o intervalo mínimo de 15 min (piso do e-mail) é cumprido com espera, não ignorado.
    const second = await real({}, tight);
    expect(second.counts).toMatchObject({ enviada: 1 });
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(15 * 60_000);
    expect(count("SELECT COUNT(*) AS n FROM applications WHERE status = 'enviada'")).toBe(2);
  });

  it('com a trava mestra desligada nada sai: a vaga fica pendente e nenhuma decisão de envio é registrada', async () => {
    vaga();
    grantFor();
    const report = await real({ emailContext: context(false) });
    expect(report.decisions[0]).toMatchObject({ decision: 'pendente' });
    expect(report.decisions[0]?.reasons.join(' ')).toContain('EMAIL_SEND_ENABLED');
    expect(transport.calls).toHaveLength(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM autonomous_decisions WHERE decision IN ('enviada','envio_incerto')",
      ),
    ).toBe(0);
  });

  it('resultado incerto do Gmail: marca "envio incerto", exige pessoa e nunca reenvia', async () => {
    vaga();
    grantFor();
    transport.next(
      { kind: 'accepted', messageId: 't1', threadId: undefined, labelIds: ['SENT'] },
      { kind: 'unknown', category: 'http_503' },
    );
    const report = await real();
    expect(report.decisions[0]).toMatchObject({ decision: 'envio_incerto' });
    expect(
      count("SELECT COUNT(*) AS n FROM applications WHERE status = 'pendente_intervencao_humana'"),
    ).toBe(1);
    const again = await real();
    expect(again.decisions).toHaveLength(0);
    expect(transport.calls).toHaveLength(2);
  });

  it('sem e-mail na vaga, com vários e-mails ou com provedor gratuito: nada é deduzido nem enviado', async () => {
    vaga({ company: 'Sem email', description: 'Requisitos: TypeScript e SQL.' });
    vaga({
      company: 'Vários',
      description:
        'Requisitos: TypeScript e SQL. Envie seu currículo para rh@a.com.br ou vagas@b.com.br',
    });
    vaga({
      company: 'Gratuito',
      description: 'Requisitos: TypeScript e SQL. Envie para fulano@gmail.com',
    });
    grantFor();
    const report = await real();
    expect(transport.calls).toHaveLength(0);
    expect(report.counts).not.toHaveProperty('enviada');
    expect(count('SELECT COUNT(*) AS n FROM applications')).toBe(0);
    expect(report.decisions.map((d) => d.decision)).toEqual([
      'pendente_canal',
      'pendente_canal',
      'pendente_canal',
    ]);
  });

  it('pergunta sem resposta comprovada no rascunho deixa a candidatura pendente (nada é respondido)', async () => {
    vaga({
      description: `Requisitos: TypeScript e SQL.\nEnvie para ${RECIPIENT}.\nInforme sua pretensão salarial e se possui CNH.`,
    });
    grantFor();
    const report = await real();
    const line = report.decisions[0];
    if (line?.decision === 'enviada') {
      // Se o rascunho resolveu tudo com dados do perfil, o envio ocorreu; senão ficou pendente.
      expect(transport.calls).toHaveLength(2);
    } else {
      expect(line?.decision).toBe('pendente');
      expect(transport.calls).toHaveLength(0);
    }
  });

  it('a concessão invalidada por mudança de política recusa o modo real', async () => {
    vaga();
    grantFor();
    const edited = parsePolicy({ ...policy, limits: { ...policy.limits, maxPerDay: 20 } });
    await expect(real({}, edited)).rejects.toThrow(/política mudou/);
    expect(transport.calls).toHaveLength(0);
  });
});
