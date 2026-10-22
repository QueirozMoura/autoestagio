import { describe, expect, it } from 'vitest';
import { HttpStatusError, ResponseValidationError } from '../../src/http/index.js';
import { LeverSource, rawJobSchema, toSourceError } from '../../src/sources/index.js';
import { collect, setup, target } from '../helpers/adapters.js';
import { jsonResponse, textResponse } from '../helpers/mock-fetch.js';

const SITE = 'https://api.lever.co/v0/postings/exemplo';
const page = (skip: number) => `${SITE}?mode=json&limit=100&skip=${skip}`;

// Formato conforme https://github.com/lever/postings-api (dados fictícios).
const posting = (
  id: string,
  text: string,
  location: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  text,
  hostedUrl: `https://jobs.lever.co/exemplo/${id}`,
  applyUrl: `https://jobs.lever.co/exemplo/${id}/apply`,
  categories: {
    location,
    team: 'Engenharia',
    department: 'Tecnologia',
    commitment: 'Estágio',
    allLocations: [location],
  },
  country: 'BR',
  workplaceType: 'hybrid',
  description: '<div>Descrição da vaga</div>',
  descriptionPlain: 'Descrição da vaga',
  lists: [{ text: 'Requisitos', content: '<li>SQL</li><li>Git</li>' }],
  additional: '<div>Benefícios: VR</div>',
  createdAt: 1_790_000_000_000,
  ...extra,
});

const FIRST_PAGE = [
  posting('a1', 'Estagiário de Desenvolvimento', 'São Paulo, Brazil'),
  posting('a2', 'Software Engineering Intern', 'Remote', {
    workplaceType: 'remote',
    country: 'BR',
  }),
  posting('a3', 'Senior Backend Engineer', 'São Paulo, Brazil'),
  posting('a4', 'Data Intern', 'London, UK', { country: 'GB', workplaceType: 'on-site' }),
  posting('a5', 'Estágio em Suporte', 'Campinas', { country: null, workplaceType: 'unspecified' }),
  { id: 'quebrado' },
];

describe('LeverSource', () => {
  const source = (overrides: Record<string, unknown> = {}) =>
    new LeverSource(target({ kind: 'lever', ...overrides }));

  it('coleta só estágios no Brasil, com modalidade e data estruturadas', async () => {
    const { context } = setup({ [page(0)]: () => jsonResponse(FIRST_PAGE) });
    const jobs = await collect(source(), context);

    expect(jobs.map((job) => job.externalId)).toEqual(['a1', 'a2', 'a5']);
    expect(jobs[0]).toEqual({
      externalId: 'a1',
      url: 'https://jobs.lever.co/exemplo/a1',
      title: 'Estagiário de Desenvolvimento',
      company: 'Empresa Exemplo',
      location: 'São Paulo, Brazil',
      workMode: 'hibrido',
      description:
        '<div>Descrição da vaga</div>\n<h3>Requisitos</h3><ul><li>SQL</li><li>Git</li></ul>\n<div>Benefícios: VR</div>',
      postedAt: '2026-09-21T14:13:20.000Z',
    });
    expect(jobs[1]?.workMode).toBe('remoto');
    expect(jobs[2]).not.toHaveProperty('workMode'); // "unspecified" não é presumido
    for (const job of jobs) expect(rawJobSchema.safeParse(job).success).toBe(true);
  });

  it('registra estatísticas', async () => {
    const { context } = setup({ [page(0)]: () => jsonResponse(FIRST_PAGE) });
    const s = source();
    await collect(s, context);
    expect(s.lastRunStats()).toEqual({
      listed: 6,
      internships: 4,
      inRegion: 3,
      invalid: 1,
      detailSkipped: 0,
      truncated: false,
    });
  });

  it('brazilOnly=false inclui estágios de outras regiões', async () => {
    const { context } = setup({ [page(0)]: () => jsonResponse(FIRST_PAGE) });
    const jobs = await collect(source({ brazilOnly: false }), context);
    expect(jobs.map((job) => job.externalId)).toEqual(['a1', 'a2', 'a4', 'a5']);
  });

  it('país BR ou local em allLocations bastam para a região', async () => {
    const { context } = setup({
      [page(0)]: () =>
        jsonResponse([
          posting('b1', 'Intern', 'Remote', { country: 'BR', categories: { location: 'Remote' } }),
          posting('b2', 'Intern', 'Remote', {
            country: null,
            categories: { location: 'Remote', allLocations: ['Remote', 'São Paulo'] },
          }),
          posting('b3', 'Intern', 'Remote', { country: 'US', categories: { location: 'Remote' } }),
        ]),
    });
    const jobs = await collect(source(), context);
    expect(jobs.map((job) => job.externalId)).toEqual(['b1', 'b2']);
  });

  describe('paginação', () => {
    const many = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) =>
        posting(`${prefix}${i}`, `Estagiário ${i}`, 'São Paulo'),
      );

    it('continua enquanto a página vier cheia e para na última', async () => {
      const { context, calls } = setup({
        [page(0)]: () => jsonResponse(many(100, 'p')),
        [page(100)]: () => jsonResponse(many(50, 'q')),
      });
      const jobs = await collect(source(), context);
      expect(jobs).toHaveLength(150);
      expect(calls.map((c) => c.url).filter((u) => u.includes('/v0/'))).toEqual([
        page(0),
        page(100),
      ]);
    });

    it('uma página incompleta encerra sem pedir a próxima', async () => {
      const { context, callsTo } = setup({ [page(0)]: () => jsonResponse(many(3, 'p')) });
      await collect(source(), context);
      expect(callsTo(page(100))).toHaveLength(0);
    });

    it('respeita o limite de páginas e avisa que ficou parcial', async () => {
      const { context, callsTo } = setup(
        { [page(0)]: () => jsonResponse(many(100, 'p')) },
        { maxPagesPerSource: 1 },
      );
      const s = source();
      expect(await collect(s, context)).toHaveLength(100);
      expect(s.lastRunStats()?.truncated).toBe(true);
      expect(callsTo(page(100))).toHaveLength(0);
    });

    it('respeita o limite de vagas', async () => {
      const { context } = setup(
        { [page(0)]: () => jsonResponse(many(100, 'p')) },
        { maxJobsPerSource: 10 },
      );
      const s = source();
      expect(await collect(s, context)).toHaveLength(10);
      expect(s.lastRunStats()?.truncated).toBe(true);
    });
  });

  it('usa a instância europeia quando configurada', async () => {
    const eu = 'https://api.eu.lever.co/v0/postings/exemplo?mode=json&limit=100&skip=0';
    const { context, callsTo } = setup({ [eu]: () => jsonResponse([]) });
    await collect(source({ instance: 'eu' }), context);
    expect(callsTo(eu)).toHaveLength(1);
  });

  it('só faz GET, sem credenciais', async () => {
    const { context, calls } = setup({ [page(0)]: () => jsonResponse([]) });
    await collect(source(), context);
    for (const call of calls) {
      expect(call.init?.method).toBe('GET');
      expect(call.url).not.toContain('key=');
      expect(call.url).not.toContain('/apply');
    }
  });

  describe('falhas', () => {
    it('site inexistente (404) vira falha de indisponibilidade', async () => {
      const { context } = setup({ [page(0)]: () => textResponse('', { status: 404 }) });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(HttpStatusError);
      expect(toSourceError(s, failure).category).toBe('unavailable');
    });

    it('resposta que não é uma lista é rejeitada', async () => {
      const { context } = setup({ [page(0)]: () => jsonResponse({ ok: false }) });
      await expect(collect(source(), context)).rejects.toBeInstanceOf(ResponseValidationError);
    });

    it('quando nenhum item tem o formato esperado, falha em vez de devolver vazio', async () => {
      const { context } = setup({ [page(0)]: () => jsonResponse([{ a: 1 }, { b: 2 }]) });
      await expect(collect(source(), context)).rejects.toThrow(/nenhuma vaga no formato esperado/);
    });

    it('lista vazia é um resultado válido', async () => {
      const { context } = setup({ [page(0)]: () => jsonResponse([]) });
      expect(await collect(source(), context)).toEqual([]);
    });

    it('403 vira falha de bloqueio e nada é contornado', async () => {
      const { context, callsTo } = setup({ [page(0)]: () => textResponse('', { status: 403 }) });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(toSourceError(s, failure).category).toBe('blocked');
      expect(callsTo(page(0))).toHaveLength(1);
    });
  });
});
