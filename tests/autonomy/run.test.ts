import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RunRefused,
  createGrant,
  grantCode,
  listRuns,
  parsePolicy,
  runAutonomous,
  runDecisions,
  type Policy,
  type RunOptions,
} from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { seedJob, type SeedJob } from '../helpers/applications.js';
import { profile } from '../helpers/eligibility.js';

const NOW = new Date('2026-10-24T12:00:00Z');
let db: Db;
const dirs: string[] = [];
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Vaga que, com o perfil fictício, é apta: híbrida em local com tempo confirmado e bolsa conhecida. */
const apta = (over: SeedJob = {}): number =>
  seedJob(db, {
    verdict: null,
    title: 'Estágio em Suporte Técnico',
    workMode: 'hibrido',
    location: 'São Paulo - Pinheiros',
    stipend: 1500,
    applyUrl: 'https://empresa.inhire.app/vagas/abc',
    ...over,
  });

const recipient = (jobId: number): void => {
  db.prepare(
    `INSERT INTO verified_recipients (job_id, email, source_kind, source_url, evidence_hash, verified_at)
     VALUES (?, 'rh@empresa.example', 'vaga_oficial', 'https://empresa.example/vaga', ?, '2026-10-24T00:00:00Z')`,
  ).run(jobId, 'e'.repeat(64));
};

const run = (policy: Policy = parsePolicy({}), over: Partial<RunOptions> = {}) =>
  runAutonomous({ db, profile: profile(), policy, mode: 'simulacao', now: () => NOW, ...over });

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('execução autônoma em simulação', () => {
  it('mantém a trava durante o preparo e grava o resultado no histórico', async () => {
    apta();
    let checked = false;
    const report = await run(parsePolicy({}), {
      prepare: async () => {
        expect(count('autonomous_queue')).toBe(1);
        await expect(run()).rejects.toThrow('Já existe uma execução');
        checked = true;
        return { mode: 'preparar', items: [], remainingReady: 0 };
      },
    });
    expect(checked).toBe(true);
    expect(report.status).toBe('concluida');
    const stored = JSON.parse(listRuns(db)[0]?.summary ?? '{}') as {
      preparation: { mode: string };
    };
    expect(stored.preparation.mode).toBe('preparar');
  });

  it('falha de inicialização do preparo encerra a trava com erro explícito', async () => {
    const report = await run(parsePolicy({}), {
      prepare: () => Promise.reject(new Error('navegador indisponível')),
    });
    expect(report.status).toBe('falhou');
    expect(report.errors).toContain('execução: Error');
    expect((await run()).status).toBe('concluida');
  });

  it('vaga apta sem canal automático vira "pendente de canal"; nada é enviado nem criado', async () => {
    const id = apta();
    const report = await run();
    expect(report.status).toBe('concluida');
    expect(report.notes.join(' ')).toContain('desligada');
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]).toMatchObject({
      jobId: id,
      decision: 'pendente_canal',
      connector: 'portal-inhire',
    });
    expect(report.decisions[0]?.reasons.join(' ')).toContain('reCAPTCHA');
    expect(count('applications')).toBe(0);
    expect(count('email_dispatches')).toBe(0);
    expect(count('email_authorizations')).toBe(0);
  });

  it('com destinatário verificado a decisão é "candidatar", com a pretensão da política e variante de currículo', async () => {
    const id = apta();
    recipient(id);
    const report = await run();
    expect(report.decisions[0]).toMatchObject({
      decision: 'candidatar',
      connector: 'email',
      cvVariant: 'generico',
    });
    const row = db.prepare('SELECT salary_expectation AS s FROM autonomous_decisions').get() as {
      s: number;
    };
    expect(row.s).toBe(1800);
    expect(count('applications')).toBe(0);
  });

  it('escolhe a variante aprovada da área quando existe (desenvolvimento) e a genérica nos demais casos', async () => {
    recipient(apta({ title: 'Estágio em Desenvolvimento de Software', company: 'A' }));
    recipient(apta({ title: 'Estágio em Segurança da Informação', company: 'B' }));
    const report = await run();
    const variants = report.decisions.map((d) => d.cvVariant).sort();
    expect(variants).toEqual(['desenvolvimento', 'generico']);
  });

  it('revisão humana fica pendente por padrão e só segue se a política incluir esse veredito', async () => {
    const id = apta({ workMode: null });
    recipient(id);
    const padrao = await run();
    expect(padrao.decisions[0]).toMatchObject({ decision: 'pendente' });
    const aberta = await run(parsePolicy({ rules: { verdicts: ['apto', 'revisao_humana'] } }));
    expect(aberta.decisions[0]).toMatchObject({ decision: 'candidatar' });
  });

  it('bolsa desconhecida só deixa de bloquear se você tolerar; outros dados ausentes e bolsa baixa continuam bloqueando', async () => {
    const semBolsa = apta({ stipend: null, company: 'Sem Bolsa' });
    recipient(semBolsa);
    const semModalidade = apta({ stipend: null, workMode: null, company: 'Sem Modalidade' });
    recipient(semModalidade);
    const padrao = await run(parsePolicy({}));
    expect(padrao.decisions.map((d) => d.decision)).toEqual(['pendente', 'pendente']);
    const tolera = await run(parsePolicy({ rules: { tolerateUnknown: ['bolsa'] } }));
    const byId = new Map(tolera.decisions.map((d) => [d.jobId, d.decision]));
    expect(byId.get(semBolsa)).toBe('candidatar');
    expect(byId.get(semModalidade)).toBe('pendente');
  });

  it('o relatório agrupa os motivos de descarte da elegibilidade e da política', async () => {
    apta({ title: 'Estágio em Marketing' });
    apta({ title: 'Estágio em Vendas' });
    const bloqueada = apta({ company: 'Bloqueada SA' });
    recipient(bloqueada);
    const report = await run(parsePolicy({ rules: { companiesDeny: ['bloqueada sa'] } }));
    const reasons = report.discards.map((d) => d.reason);
    expect(reasons.some((r) => r.startsWith('elegibilidade:'))).toBe(true);
    expect(reasons).toContain('política: empresa na lista de exclusão');
    expect(report.discards.reduce((sum, d) => sum + d.count, 0)).toBe(3);
  });

  it('vaga inapta não entra; empresa excluída e fonte fora da lista são descartadas', async () => {
    apta({ title: 'Estágio em Marketing' });
    const a = apta({ company: 'Bloqueada SA' });
    recipient(a);
    const b = apta({ company: 'Outra SA' });
    recipient(b);
    const report = await run(
      parsePolicy({ rules: { companiesDeny: ['bloqueada sa'], sourcesAllow: ['lever'] } }),
    );
    expect(report.verdicts.inapto).toBe(1);
    expect(report.decisions.map((d) => d.decision)).toEqual(['descartada', 'descartada']);
    expect(report.decisions[0]?.reasons[0]).toMatch(/exclusão|fonte/);
  });

  it('a política de áreas descarta área diferente e deixa pendente quando a área não é identificável', async () => {
    const suporte = apta({ title: 'Estágio em Suporte Técnico' });
    recipient(suporte);
    const geral = apta({ title: 'Programa de Estágio 2027' });
    recipient(geral);
    const report = await run(
      parsePolicy({ rules: { areas: ['dados'], verdicts: ['apto', 'revisao_humana'] } }),
    );
    const byId = new Map(report.decisions.map((d) => [d.jobId, d.decision]));
    expect(byId.get(suporte)).toBe('descartada');
    expect(byId.get(geral)).toBe('pendente');
  });

  it('respeita o limite por execução e o menor entre o diário da política e o do ambiente', async () => {
    for (let i = 0; i < 3; i++) recipient(apta({ company: `Empresa ${i}` }));
    const two = await run(parsePolicy({ limits: { maxPerRun: 2 } }));
    expect(two.counts).toMatchObject({ candidatar: 2, limite_atingido: 1 });
    const env = await run(parsePolicy({ limits: { maxPerDay: 50 } }), { envMaxPerDay: 1 });
    expect(env.limits).toMatchObject({ perDay: 1, effective: 1 });
    expect(env.counts).toMatchObject({ candidatar: 1, limite_atingido: 2 });
  });

  it('descontao do limite diário o que já foi enviado hoje', async () => {
    const id = apta();
    recipient(id);
    const first = await run();
    db.prepare("UPDATE autonomous_decisions SET decision = 'enviada' WHERE run_id = ?").run(
      first.runId,
    );
    const report = await run(parsePolicy({ limits: { maxPerDay: 1 } }));
    expect(report.limits).toMatchObject({ sentToday: 1, effective: 0 });
    expect(report.counts).toMatchObject({ limite_atingido: 1 });
  });

  it('registra execução e decisões para consulta e a coleta que falha não derruba a execução', async () => {
    apta();
    const report = await run(parsePolicy({}), {
      trigger: 'timer',
      discover: () => Promise.reject(new Error('rede indisponível')),
    });
    expect(report.status).toBe('concluida');
    expect(report.errors).toEqual(['coleta: Error']);
    const [row] = listRuns(db, 5);
    expect(row).toMatchObject({
      id: report.runId,
      mode: 'simulacao',
      trigger: 'timer',
      status: 'concluida',
    });
    expect(runDecisions(db, report.runId)).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain('rede indisponível');
  });
});

describe('trava, parada e envio real', () => {
  it('recusa execução concorrente e libera uma execução morta depois do prazo', async () => {
    db.prepare(
      `INSERT INTO autonomous_runs (mode, trigger, status, policy_hash, started_at)
       VALUES ('simulacao', 'manual', 'executando', 'x', ?)`,
    ).run(new Date(NOW.getTime() - 60_000).toISOString());
    await expect(run()).rejects.toThrow(RunRefused);
    db.prepare("UPDATE autonomous_runs SET started_at = '2026-10-23T00:00:00Z'").run();
    const report = await run();
    expect(report.status).toBe('concluida');
    expect(
      (db.prepare('SELECT status FROM autonomous_runs WHERE id = 1').get() as { status: string })
        .status,
    ).toBe('interrompida');
  });

  it('o arquivo de parada impede iniciar e interrompe no meio, sem perder o que já foi decidido', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-'));
    dirs.push(dir);
    const stopFile = join(dir, 'STOP');
    for (let i = 0; i < 2; i++) recipient(apta({ company: `Empresa ${i}` }));
    writeFileSync(stopFile, 'x');
    await expect(run(parsePolicy({}), { stopFile })).rejects.toThrow(/parada/);
    expect(count('autonomous_runs')).toBe(0);
    rmSync(stopFile);
    const report = await run(parsePolicy({}), {
      stopFile,
      discover: () => {
        writeFileSync(stopFile, 'x');
        return Promise.resolve({ newJobs: 0, updatedJobs: 0, errors: [] });
      },
    });
    expect(report.stopped).toBe(true);
    expect(report.status).toBe('interrompida');
    expect(report.decisions).toHaveLength(0);
    expect(existsSync(stopFile)).toBe(true);
  });

  it('o modo real é recusado sem concessão e, sem contexto de e-mail, não envia nada', async () => {
    const id = apta();
    recipient(id);
    await expect(run(parsePolicy({}), { mode: 'real' })).rejects.toThrow(/Envio real recusado/);
    const policy = parsePolicy({
      enabled: true,
      real: { authorized: true, connectors: ['email'] },
    });
    await expect(run(policy, { mode: 'real' })).rejects.toThrow(/concessão/);
    expect(count('autonomous_runs')).toBe(0);
    createGrant(db, policy, {
      days: 30,
      confirm: grantCode(policy, 30),
      reason: 'teste',
      now: NOW,
    });
    await expect(run(policy, { mode: 'real' })).rejects.toThrow(/contexto de e-mail/);
    expect(count('applications')).toBe(0);
  });

  it('vaga que já tem candidatura não é reavaliada (a duplicidade é barrada pelo banco)', async () => {
    const id = apta();
    recipient(id);
    db.prepare(
      `INSERT INTO applications (job_id, mode, status, cv_sha256, cv_label, eligibility_verdict, profile_hash, created_at, updated_at)
       VALUES (?, 'revisao', 'enviada', ?, 'x.pdf', 'apto', 'h', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')`,
    ).run(id, 'a'.repeat(64));
    const report = await run();
    expect(report.alreadyApplied).toBe(1);
    expect(report.decisions).toHaveLength(0);
  });
});

describe('migração 0011', () => {
  it('é aditiva e as tabelas rejeitam decisões e modos inválidos', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO autonomous_runs (mode, trigger, status, policy_hash, started_at) VALUES ('livre','manual','concluida','x','t')",
        )
        .run(),
    ).toThrow();
    const id = apta();
    const runId = Number(
      db
        .prepare(
          "INSERT INTO autonomous_runs (mode, trigger, status, policy_hash, started_at) VALUES ('simulacao','manual','concluida','x','t')",
        )
        .run().lastInsertRowid,
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO autonomous_decisions (run_id, job_id, decision, reasons, created_at) VALUES (?, ?, 'enviar_tudo', '[]', 't')",
        )
        .run(runId, id),
    ).toThrow();
  });
});
