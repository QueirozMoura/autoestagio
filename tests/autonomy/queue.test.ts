import { beforeEach, describe, expect, it } from 'vitest';
import {
  QueueError,
  buildQueue,
  cleanUrl,
  listQueue,
  parsePolicy,
  runAutonomous,
  setQueueStatus,
} from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { seedJob, type SeedJob } from '../helpers/applications.js';
import { profile } from '../helpers/eligibility.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const policy = parsePolicy({ rules: { tolerateUnknown: ['bolsa', 'modalidade'] } });
let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const vaga = (over: SeedJob = {}): number =>
  seedJob(db, {
    verdict: null,
    title: 'Estágio em Suporte Técnico',
    workMode: 'remoto',
    location: 'Brasil',
    stipend: 1800,
    applyUrl: 'https://empresa.inhire.app/vagas/1?utm=pessoal#x',
    ...over,
  });
const analyze = () =>
  runAutonomous({ db, profile: profile(), policy, mode: 'simulacao', now: () => NOW });

describe('política: modalidade desconhecida tolerada', () => {
  it('permite seguir sem presumir remoto/híbrido e deixa o aviso para quem executa', async () => {
    const id = vaga({ workMode: null, stipend: null, location: 'São Paulo' });
    await analyze();
    const item = listQueue(db).find((q) => q.jobId === id);
    expect(item?.flow).toBe('assistido');
    expect(item?.barriers.join(' ')).toContain('modalidade desconhecida');
    expect(item?.barriers.join(' ')).toContain('disponibilidade presencial');
    expect(db.prepare('SELECT work_mode AS m FROM jobs WHERE id = ?').get(id)).toEqual({ m: null });
  });

  it('sem a tolerância, modalidade desconhecida continua pendente; outros dados ausentes nunca são tolerados', async () => {
    const strict = parsePolicy({ rules: { tolerateUnknown: ['bolsa'] } });
    vaga({ workMode: null });
    vaga({ title: 'Programa de Estágio 2027' });
    await runAutonomous({
      db,
      profile: profile(),
      policy: strict,
      mode: 'simulacao',
      now: () => NOW,
    });
    expect(listQueue(db)).toHaveLength(0);
    await analyze();
    const ids = listQueue(db).map((q) => q.jobId);
    expect(ids).toHaveLength(1);
  });
});

describe('fila de candidaturas', () => {
  it('monta a fila priorizada, com o fluxo automático antes do assistido e o link sem parâmetros pessoais', async () => {
    const auto = vaga({
      company: 'Com E-mail',
      description: 'Requisitos: TypeScript. Envie seu currículo para rh@comemail.com.br',
    });
    const assistida = vaga({ company: 'Só Portal' });
    await analyze();
    const queue = listQueue(db);
    expect(queue.map((q) => [q.jobId, q.flow, q.priority])).toEqual([
      [auto, 'automatico', 1],
      [assistida, 'assistido', 2],
    ]);
    expect(queue[1]).toMatchObject({
      status: 'pronta',
      connector: 'portal-inhire',
      cvVariant: 'generico',
      salaryExpectation: 1800,
      applyUrl: 'https://empresa.inhire.app/vagas/1',
    });
    expect(queue[1]?.barriers).toContain('barreira do canal: recaptcha-enterprise');
    expect(cleanUrl('http://inseguro.example/x')).toBeNull();
  });

  it('é idempotente, não duplica e preserva o andamento de itens já em andamento ou concluídos', async () => {
    const a = vaga({ company: 'A', applyUrl: 'https://a.inhire.app/vagas/1' });
    const b = vaga({ company: 'B', applyUrl: 'https://b.inhire.app/vagas/1' });
    await analyze();
    const again = buildQueue(db, profile(), policy, NOW);
    expect(again).toMatchObject({ created: 0, updated: 2 });
    expect(listQueue(db)).toHaveLength(2);
    const item = listQueue(db).find((q) => q.jobId === a);
    setQueueStatus(
      db,
      item?.id ?? 0,
      { status: 'em_andamento', notes: 'preenchendo no navegador' },
      NOW,
    );
    buildQueue(db, profile(), policy, NOW);
    expect(listQueue(db, { status: 'em_andamento' }).map((q) => q.jobId)).toEqual([a]);
    expect(listQueue(db, { status: 'pronta' }).map((q) => q.jobId)).toEqual([b]);
  });

  it('concluir exige evidência, é definitivo e a vaga não volta; cancelar exige motivo', async () => {
    const id = vaga();
    await analyze();
    const item = listQueue(db)[0];
    const qid = item?.id ?? 0;
    expect(() => {
      setQueueStatus(db, qid, { status: 'concluida' }, NOW);
    }).toThrow(/evidência/);
    expect(() => {
      setQueueStatus(db, qid, { status: 'cancelada' }, NOW);
    }).toThrow(/motivo/);
    setQueueStatus(
      db,
      qid,
      { status: 'concluida', evidence: 'e-mail de confirmação da plataforma' },
      NOW,
    );
    expect(() => {
      setQueueStatus(db, qid, { status: 'pronta' }, NOW);
    }).toThrow(QueueError);
    buildQueue(db, profile(), policy, NOW);
    expect(listQueue(db).filter((q) => q.jobId === id)).toHaveLength(1);
    expect(listQueue(db)[0]).toMatchObject({
      status: 'concluida',
      evidence: 'e-mail de confirmação da plataforma',
    });
  });

  it('cancela, com motivo, o que deixou de ser elegível; respeita o cancelamento feito por você', async () => {
    const a = vaga({ company: 'A', applyUrl: 'https://a.inhire.app/vagas/1' });
    const b = vaga({ company: 'B', applyUrl: 'https://b.inhire.app/vagas/1' });
    await analyze();
    const itemB = listQueue(db).find((q) => q.jobId === b);
    setQueueStatus(
      db,
      itemB?.id ?? 0,
      { status: 'cancelada', reason: 'não quero esta empresa' },
      NOW,
    );
    db.prepare("UPDATE jobs SET title = 'Estágio em Marketing' WHERE id = ?").run(a);
    await analyze();
    const byJob = new Map(listQueue(db).map((q) => [q.jobId, q]));
    expect(byJob.get(a)?.status).toBe('cancelada');
    expect(byJob.get(b)?.status).toBe('cancelada');
    db.prepare("UPDATE jobs SET title = 'Estágio em Suporte Técnico' WHERE id = ?").run(a);
    await analyze();
    const after = new Map(listQueue(db).map((q) => [q.jobId, q]));
    expect(after.get(a)?.status).toBe('pronta');
    expect(after.get(b)?.status).toBe('cancelada');
  });

  it('o relatório informa as quatro categorias e a fila (simulação não cria candidaturas)', async () => {
    vaga({ company: 'Pronta' });
    vaga({ title: 'Programa de Estágio 2027', company: 'Pendente' });
    vaga({ title: 'Estágio em Marketing', company: 'Descartada' });
    const report = await analyze();
    expect(report.opportunities.buckets).toEqual({
      automatizavel: 0,
      manual: 1,
      insuficiente: 1,
      incompativel: 1,
    });
    expect(report.queue).toMatchObject({ created: 1, ready: { automatico: 0, assistido: 1 } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
  });
});
