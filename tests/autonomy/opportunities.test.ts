import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyOpportunities,
  extractionCauses,
  parsePolicy,
  runAutonomous,
  summarizeOpportunities,
} from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { classifyJobAreas, evaluateJob } from '../../src/eligibility/index.js';
import { seedJob, type SeedJob } from '../helpers/applications.js';
import { job, profile } from '../helpers/eligibility.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const policy = parsePolicy({ rules: { tolerateUnknown: ['bolsa'] } });
let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const vaga = (over: SeedJob = {}): number =>
  seedJob(db, {
    verdict: null,
    title: 'Estágio em Suporte Técnico',
    workMode: 'hibrido',
    location: 'São Paulo - Pinheiros',
    stipend: 1500,
    applyUrl: 'https://empresa.gupy.io/jobs/1',
    ...over,
  });
const analyze = () =>
  runAutonomous({ db, profile: profile(), policy, mode: 'simulacao', now: () => NOW });

describe('as quatro categorias de oportunidade', () => {
  it('separa automatizável, manual, informações insuficientes e incompatível', async () => {
    const auto = vaga({
      company: 'Com E-mail',
      description: 'Requisitos: TypeScript. Envie seu currículo para rh@comemail.com.br',
    });
    const manual = vaga({ company: 'Só Portal', stipend: null });
    const insuf = vaga({ company: 'Sem Modalidade', workMode: null });
    const incomp = vaga({ title: 'Estágio em Marketing', company: 'Fora de TI' });
    await analyze();
    const list = classifyOpportunities(db, profile(), policy);
    const bucket = (id: number) => list.find((o) => o.jobId === id)?.bucket;
    expect(bucket(auto)).toBe('automatizavel');
    expect(bucket(manual)).toBe('manual');
    expect(bucket(insuf)).toBe('insuficiente');
    expect(bucket(incomp)).toBe('incompativel');
    const summary = summarizeOpportunities(list);
    expect(summary).toMatchObject({
      total: 4,
      eligible: 2,
      buckets: { automatizavel: 1, manual: 1, insuficiente: 1, incompativel: 1 },
    });
    expect(summary.blockers[0]).toEqual({ id: 'modalidade', count: 1 });
    expect(list.find((o) => o.jobId === auto)?.connector).toBe('email');
  });

  it('e-mail de acessibilidade ou sem pedido de candidatura NÃO torna a vaga automatizável', async () => {
    const id = vaga({ description: 'Para acomodações, escreva para accommodation@empresa.com' });
    await analyze();
    const item = classifyOpportunities(db, profile(), policy).find((o) => o.jobId === id);
    expect(item?.bucket).toBe('manual');
    expect(item?.connector).toBe('portal-gupy');
  });

  it('vaga que já tem candidatura sai da lista', async () => {
    const id = vaga();
    await analyze();
    db.prepare(
      `INSERT INTO applications (job_id, mode, status, cv_sha256, cv_label, eligibility_verdict, profile_hash, created_at, updated_at)
       VALUES (?, 'revisao', 'enviada', ?, 'x.pdf', 'apto', 'h', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')`,
    ).run(id, 'a'.repeat(64));
    expect(classifyOpportunities(db, profile(), policy)).toHaveLength(0);
  });

  it('mede se a pendência vem de anúncio genérico ou de menção não declarativa', async () => {
    vaga({ workMode: null, description: 'Estágio em equipe colaborativa.' });
    vaga({ workMode: null, description: 'Temos um escritório moderno e benefícios.' });
    await analyze();
    const modalidade = extractionCauses(db, profile()).find((c) => c.criterion === 'modalidade');
    expect(modalidade).toMatchObject({ pending: 2, generic: 1, mentioned: 1 });
    expect(modalidade?.samples[0]?.snippet).toContain('escritório');
  });
});

describe('vaga afirmativa e funções de negócio', () => {
  it('vaga afirmativa/exclusiva no título fica pendente: o perfil não declara identidade', () => {
    const outcome = (title: string) =>
      evaluateJob(profile(), job({ title })).criteria.find((c) => c.id === 'afirmativa')?.outcome;
    expect(outcome('Estágio em Engenharia de Dados - Vaga afirmativa para pessoas negras')).toBe(
      'indeterminado',
    );
    expect(outcome('Estágio em TI - Exclusivo para PcD')).toBe('indeterminado');
    expect(outcome('Estágio em Suporte (vaga também para PcD)')).toBeUndefined();
    expect(outcome('Estágio em Desenvolvimento de Software')).toBeUndefined();
    const result = evaluateJob(
      profile(),
      job({ title: 'Estágio em Dados - Vaga afirmativa para mulheres' }),
    );
    expect(result.verdict).toBe('revisao_humana');
  });

  it('títulos de áreas de negócio/financeiras não são tratados como TI, e sinais fortes continuam valendo', () => {
    for (const title of [
      'Estágio em Equity Research',
      'Pessoa Estagiária em Políticas de Crédito',
      'Estágio em Capacitação e Treinamento',
      'Estagiário(a) em RPPS Poder Público',
    ])
      expect(classifyJobAreas(title, 'Trabalhe com dados e desenvolvimento.').nonIt).toBe(true);
    expect(classifyJobAreas('Estágio em Dados de Crédito', null).nonIt).toBe(false);
    expect(classifyJobAreas('Estágio em Dados de Crédito', null).fromTitle).toContain('dados');
  });
});
