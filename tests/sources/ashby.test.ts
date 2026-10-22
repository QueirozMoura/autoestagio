import { describe, expect, it } from 'vitest';
import { HttpStatusError, ResponseValidationError } from '../../src/http/index.js';
import { AshbySource, rawJobSchema, toSourceError } from '../../src/sources/index.js';
import { collect, setup, target } from '../helpers/adapters.js';
import { jsonResponse, textResponse } from '../helpers/mock-fetch.js';

const BOARD = 'https://api.ashbyhq.com/posting-api/job-board/exemplo?includeCompensation=true';

const brAddress = (locality = 'São Paulo') => ({
  postalAddress: {
    addressLocality: locality,
    addressRegion: 'São Paulo',
    addressCountry: 'Brazil',
  },
});

// Formato conforme https://developers.ashbyhq.com/docs/public-job-posting-api (dados fictícios).
const posting = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  department: 'Tecnologia',
  team: 'Plataforma',
  employmentType: 'Intern',
  location: 'São Paulo',
  secondaryLocations: [],
  publishedAt: '2026-09-21T14:13:20.000+00:00',
  isListed: true,
  isRemote: false,
  workplaceType: 'Hybrid',
  address: brAddress(),
  jobUrl: `https://jobs.ashbyhq.com/exemplo/${id}`,
  applyUrl: `https://jobs.ashbyhq.com/exemplo/${id}/application`,
  descriptionHtml: '<p>Descrição da <strong>vaga</strong></p>',
  descriptionPlain: 'Descrição da vaga',
  compensation: {
    compensationTierSummary: null,
    scrapeableCompensationSalarySummary: null,
    compensationTiers: [],
    summaryComponents: [],
  },
  ...extra,
});

const BOARD_BODY = {
  apiVersion: '1',
  jobs: [
    posting('a1', 'Estagiário de Desenvolvimento'),
    posting('a2', 'Software Engineering Intern', {
      workplaceType: 'Remote',
      isRemote: true,
      location: 'Remote - Brazil',
      address: { postalAddress: { addressCountry: 'Brazil' } },
    }),
    // employmentType incorreto no cadastro: o título ainda identifica o estágio.
    posting('a3', 'Product Intern', { employmentType: 'FullTime' }),
    posting('a4', 'Senior Backend Engineer', { employmentType: 'FullTime' }),
    posting('a5', 'Data Intern', {
      location: 'London',
      address: { postalAddress: { addressLocality: 'London', addressCountry: 'United Kingdom' } },
      workplaceType: 'OnSite',
    }),
    // sem employmentType: só o título indica estágio
    posting('a6', 'Estágio em Suporte', { employmentType: undefined, workplaceType: undefined }),
    // vaga oculta da listagem do quadro
    posting('a7', 'Estagiário QA', { isListed: false }),
    { id: 'quebrado' },
  ],
};

describe('AshbySource', () => {
  const source = (overrides: Record<string, unknown> = {}) =>
    new AshbySource(target({ kind: 'ashby', ...overrides }));

  it('coleta só estágios no Brasil e normaliza os campos disponíveis', async () => {
    const { context } = setup({ [BOARD]: () => jsonResponse(BOARD_BODY) });
    const jobs = await collect(source(), context);

    expect(jobs.map((job) => job.externalId)).toEqual(['a1', 'a2', 'a3', 'a6']);
    expect(jobs[0]).toEqual({
      externalId: 'a1',
      url: 'https://jobs.ashbyhq.com/exemplo/a1',
      applyUrl: 'https://jobs.ashbyhq.com/exemplo/a1/application',
      title: 'Estagiário de Desenvolvimento',
      company: 'Empresa Exemplo',
      location: 'São Paulo',
      workMode: 'hibrido',
      description: '<p>Descrição da <strong>vaga</strong></p>',
      postedAt: '2026-09-21T14:13:20.000Z',
    });
    expect(jobs[1]?.workMode).toBe('remoto');
    expect(jobs[3]).not.toHaveProperty('workMode'); // ausente não é presumido
    for (const job of jobs) expect(rawJobSchema.safeParse(job).success).toBe(true);
  });

  it('não usa employmentType como único critério, mas o respeita quando é Intern', async () => {
    const { context } = setup({
      [BOARD]: () =>
        jsonResponse({
          jobs: [posting('i1', 'Analista de Dados Jr', { employmentType: 'Intern' })],
        }),
    });
    expect((await collect(source(), context)).map((j) => j.externalId)).toEqual(['i1']);
  });

  it('não coleta vagas com isListed=false', async () => {
    const { context } = setup({ [BOARD]: () => jsonResponse(BOARD_BODY) });
    const jobs = await collect(source(), context);
    expect(jobs.map((job) => job.externalId)).not.toContain('a7');
  });

  it('isListed ausente não descarta a vaga (o endpoint só devolve vagas publicadas)', async () => {
    const { context } = setup({
      [BOARD]: () => jsonResponse({ jobs: [posting('n1', 'Intern', { isListed: undefined })] }),
    });
    expect(await collect(source(), context)).toHaveLength(1);
  });

  it('registra estatísticas', async () => {
    const { context } = setup({ [BOARD]: () => jsonResponse(BOARD_BODY) });
    const s = source();
    await collect(s, context);
    expect(s.lastRunStats()).toEqual({
      listed: 8,
      internships: 4 + 1, // a1, a2, a3, a5, a6 (a7 está oculta)
      inRegion: 4,
      invalid: 1,
      detailSkipped: 0,
      truncated: false,
    });
  });

  it('brazilOnly=false inclui estágios de outras regiões', async () => {
    const { context } = setup({ [BOARD]: () => jsonResponse(BOARD_BODY) });
    const jobs = await collect(source({ brazilOnly: false }), context);
    expect(jobs.map((job) => job.externalId)).toEqual(['a1', 'a2', 'a3', 'a5', 'a6']);
  });

  it('país, local secundário ou texto do local bastam para a região', async () => {
    const { context } = setup({
      [BOARD]: () =>
        jsonResponse({
          jobs: [
            posting('r1', 'Intern', { location: 'Remote', address: undefined }), // sem região
            posting('r2', 'Intern', {
              location: 'Remote',
              address: undefined,
              secondaryLocations: [{ location: 'Campinas', address: undefined }],
            }),
            posting('r3', 'Intern', {
              location: 'Remote',
              address: { postalAddress: { addressCountry: 'Brazil' } },
            }),
            posting('r4', 'Intern', {
              location: 'Remote',
              address: { postalAddress: { addressCountry: 'United States' } },
            }),
          ],
        }),
    });
    const jobs = await collect(source(), context);
    expect(jobs.map((job) => job.externalId)).toEqual(['r2', 'r3']);
  });

  it('usa isRemote como modalidade só quando verdadeiro', async () => {
    const { context } = setup({
      [BOARD]: () =>
        jsonResponse({
          jobs: [
            posting('m1', 'Intern', { workplaceType: undefined, isRemote: true }),
            posting('m2', 'Intern', { workplaceType: undefined, isRemote: false }),
          ],
        }),
    });
    const jobs = await collect(source(), context);
    expect(jobs[0]?.workMode).toBe('remoto');
    expect(jobs[1]).not.toHaveProperty('workMode');
  });

  it('campos opcionais ausentes não quebram a vaga', async () => {
    const { context } = setup({
      [BOARD]: () =>
        jsonResponse({
          jobs: [
            {
              title: 'Estagiário',
              jobUrl: 'https://jobs.ashbyhq.com/exemplo/x1',
              location: 'São Paulo',
            },
          ],
        }),
    });
    expect(await collect(source(), context)).toEqual([
      {
        url: 'https://jobs.ashbyhq.com/exemplo/x1',
        title: 'Estagiário',
        company: 'Empresa Exemplo',
        location: 'São Paulo',
      },
    ]);
  });

  it('usa descriptionPlain quando não há HTML e traz a remuneração publicada', async () => {
    const { context } = setup({
      [BOARD]: () =>
        jsonResponse({
          jobs: [
            posting('c1', 'Estagiário', {
              descriptionHtml: null,
              compensation: { scrapeableCompensationSalarySummary: 'R$ 1.800 mensais' },
            }),
          ],
        }),
    });
    const [job] = await collect(source(), context);
    expect(job?.description).toBe('Descrição da vaga');
    expect(job?.compensationText).toBe('R$ 1.800 mensais');
  });

  it('respeita o limite de vagas e avisa que ficou parcial', async () => {
    const many = Array.from({ length: 30 }, (_, i) => posting(`p${i}`, `Estagiário ${i}`));
    const { context } = setup(
      { [BOARD]: () => jsonResponse({ jobs: many }) },
      { maxJobsPerSource: 10 },
    );
    const s = source();
    expect(await collect(s, context)).toHaveLength(10);
    expect(s.lastRunStats()?.truncated).toBe(true);
  });

  it('faz uma única requisição GET, sem credenciais nem endpoint de candidatura', async () => {
    const { context, calls } = setup({ [BOARD]: () => jsonResponse(BOARD_BODY) });
    await collect(source(), context);
    const api = calls.filter((call) => call.url.includes('/posting-api/'));
    expect(api).toHaveLength(1);
    expect(api[0]?.init?.method).toBe('GET');
    expect(api[0]?.url).not.toMatch(/key=|apply/i);
  });

  describe('falhas', () => {
    it('quadro inexistente (404) vira indisponibilidade', async () => {
      const { context } = setup({ [BOARD]: () => textResponse('Not Found', { status: 404 }) });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(HttpStatusError);
      expect(toSourceError(s, failure).category).toBe('unavailable');
    });

    it.each([401, 403])('%i vira bloqueio e nada é contornado', async (status) => {
      const { context, callsTo } = setup({ [BOARD]: () => textResponse('', { status }) });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(toSourceError(s, failure).category).toBe('blocked');
      expect(callsTo(BOARD)).toHaveLength(1);
    });

    it('429 vira limite de requisições e não insiste (sem retries no teste)', async () => {
      const { context, callsTo } = setup({
        [BOARD]: () => textResponse('', { status: 429, headers: { 'retry-after': '1' } }),
      });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(toSourceError(s, failure).category).toBe('rate_limited');
      expect(callsTo(BOARD)).toHaveLength(1);
    });

    it('5xx vira indisponibilidade', async () => {
      const { context } = setup({ [BOARD]: () => textResponse('', { status: 503 }) });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(toSourceError(s, failure).category).toBe('unavailable');
    });

    it('resposta fora do formato é rejeitada', async () => {
      const { context } = setup({ [BOARD]: () => jsonResponse([{ jobs: [] }]) });
      await expect(collect(source(), context)).rejects.toBeInstanceOf(ResponseValidationError);
    });

    it('JSON inválido é rejeitado', async () => {
      const { context } = setup({ [BOARD]: () => textResponse('<html>erro</html>') });
      await expect(collect(source(), context)).rejects.toBeInstanceOf(ResponseValidationError);
    });

    it('quando nenhum item tem o formato esperado, falha em vez de devolver vazio', async () => {
      const { context } = setup({ [BOARD]: () => jsonResponse({ jobs: [{ a: 1 }, { b: 2 }] }) });
      await expect(collect(source(), context)).rejects.toThrow(/nenhuma vaga no formato esperado/);
    });

    it('quadro sem vagas é um resultado válido', async () => {
      const { context } = setup({ [BOARD]: () => jsonResponse({ apiVersion: '1', jobs: [] }) });
      expect(await collect(source(), context)).toEqual([]);
    });
  });
});
