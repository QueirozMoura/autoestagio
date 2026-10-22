import { describe, expect, it } from 'vitest';
import {
  BlockedError,
  ResponseValidationError,
  RobotsDisallowedError,
} from '../../src/http/index.js';
import { GreenhouseSource, rawJobSchema, toSourceError } from '../../src/sources/index.js';
import { GH_ROBOTS, collect, setup, target } from '../helpers/adapters.js';
import { jsonResponse, textResponse } from '../helpers/mock-fetch.js';

const BOARD = 'https://boards-api.greenhouse.io/v1/boards/exemplo/jobs';
const url = (id: number) => `https://job-boards.greenhouse.io/exemplo/jobs/${id}`;

// Formato conforme https://docs.greenhouse.io/job-board.html (dados fictícios).
const listed = (id: number, title: string, location: string | null) => ({
  id,
  internal_job_id: id + 1000,
  title,
  updated_at: '2026-10-20T10:00:00-04:00',
  absolute_url: url(id),
  language: 'pt',
  location: location === null ? null : { name: location },
  metadata: null,
  requisition_id: null,
});

const detail = (id: number, title: string, location: string | null, content: string) => ({
  ...listed(id, title, location),
  first_published: '2026-10-01T09:00:00-03:00',
  content,
  departments: [{ id: 1, name: 'Engenharia', parent_id: null, child_ids: [] }],
  offices: [],
});

const BOARD_JSON = {
  jobs: [
    listed(101, 'Estagiário(a) de Desenvolvimento Backend', 'São Paulo, SP'),
    listed(102, 'Software Engineer Intern', 'Remote - Brazil'),
    listed(103, 'Estágio em Marketing', 'São Paulo'),
    listed(104, 'Senior Software Engineer', 'São Paulo'),
    listed(105, 'Data Intern', 'New York, NY'),
    listed(106, 'Estagiário QA', null),
    { foo: 'item fora do formato' },
  ],
  meta: { total: 7 },
};

const DETAIL_ROUTES = {
  [`${BOARD}/101`]: () =>
    jsonResponse(
      detail(
        101,
        'Estagiário(a) de Desenvolvimento Backend',
        'São Paulo, SP',
        '&lt;p&gt;Atuar com Node.js &amp;amp; TypeScript&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;',
      ),
    ),
  [`${BOARD}/102`]: () =>
    jsonResponse(
      detail(102, 'Software Engineer Intern', 'Remote - Brazil', '&lt;p&gt;Remote&lt;/p&gt;'),
    ),
  [`${BOARD}/103`]: () =>
    jsonResponse(detail(103, 'Estágio em Marketing', 'São Paulo', '&lt;p&gt;Marketing&lt;/p&gt;')),
};

describe('GreenhouseSource', () => {
  const source = (overrides: Record<string, unknown> = {}) =>
    new GreenhouseSource(target(overrides));

  it('coleta só estágios no Brasil e busca o detalhe apenas deles', async () => {
    const { context, calls } = setup({ [BOARD]: () => jsonResponse(BOARD_JSON), ...DETAIL_ROUTES });
    const jobs = await collect(source(), context);

    expect(jobs.map((job) => job.externalId)).toEqual(['101', '102', '103']);
    // Lista + 3 detalhes (+ robots.txt); nenhuma vaga fora do filtro é baixada em detalhe.
    expect(calls.map((call) => call.url).filter((u) => u.includes('/jobs'))).toEqual([
      BOARD,
      `${BOARD}/101`,
      `${BOARD}/102`,
      `${BOARD}/103`,
    ]);
  });

  it('mapeia os campos e os valida contra o contrato de RawJob', async () => {
    const { context } = setup({ [BOARD]: () => jsonResponse(BOARD_JSON), ...DETAIL_ROUTES });
    const [first] = await collect(source(), context);

    expect(first).toEqual({
      externalId: '101',
      url: url(101),
      title: 'Estagiário(a) de Desenvolvimento Backend',
      company: 'Empresa Exemplo',
      location: 'São Paulo, SP',
      // O HTML escapado da API volta a ser HTML (uma camada de escape a menos).
      description: '<p>Atuar com Node.js &amp; TypeScript</p><ul><li>SQL</li></ul>',
      postedAt: '2026-10-01T12:00:00.000Z',
    });
    expect(rawJobSchema.safeParse(first).success).toBe(true);
  });

  it('registra estatísticas da execução', async () => {
    const { context } = setup({ [BOARD]: () => jsonResponse(BOARD_JSON), ...DETAIL_ROUTES });
    const s = source();
    expect(s.lastRunStats()).toBeUndefined();
    await collect(s, context);
    expect(s.lastRunStats()).toEqual({
      listed: 7,
      internships: 5,
      inRegion: 3,
      invalid: 1,
      detailSkipped: 0,
      truncated: false,
    });
  });

  it('brazilOnly=false inclui estágios de outras regiões', async () => {
    const { context } = setup({
      [BOARD]: () => jsonResponse(BOARD_JSON),
      ...DETAIL_ROUTES,
      [`${BOARD}/105`]: () => jsonResponse(detail(105, 'Data Intern', 'New York, NY', 'x')),
      [`${BOARD}/106`]: () => jsonResponse(detail(106, 'Estagiário QA', null, 'x')),
    });
    const jobs = await collect(source({ brazilOnly: false }), context);
    expect(jobs.map((job) => job.externalId)).toEqual(['101', '102', '103', '105', '106']);
    expect(jobs.find((job) => job.externalId === '106')).not.toHaveProperty('location');
  });

  it('só faz GET, sem credenciais, com User-Agent identificado', async () => {
    const { context, calls } = setup({ [BOARD]: () => jsonResponse(BOARD_JSON), ...DETAIL_ROUTES });
    await collect(source(), context);

    for (const call of calls) {
      expect(call.init?.method).toBe('GET');
      const headers = call.init?.headers as Record<string, string>;
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toEqual(
        expect.arrayContaining(['authorization']),
      );
      expect(headers).not.toHaveProperty('Cookie');
      expect(headers['User-Agent']).toContain('AutoEstagio');
    }
  });

  it('escapa o slug na URL', async () => {
    // O schema de configuração já barra caracteres perigosos; o adaptador também se defende.
    const s = new GreenhouseSource({ ...target(), slug: 'a/b c' });
    const { context } = setup({
      'https://boards-api.greenhouse.io/v1/boards/a%2Fb%20c/jobs': () => jsonResponse({ jobs: [] }),
    });
    expect(await collect(s, context)).toEqual([]);
  });

  describe('falhas', () => {
    it('vaga que saiu do ar entre a lista e o detalhe é pulada, sem derrubar a fonte', async () => {
      const { context } = setup({
        [BOARD]: () => jsonResponse(BOARD_JSON),
        ...DETAIL_ROUTES,
        [`${BOARD}/102`]: () => textResponse('', { status: 404 }),
      });
      const s = source();
      const jobs = await collect(s, context);
      expect(jobs.map((job) => job.externalId)).toEqual(['101', '103']);
      expect(s.lastRunStats()?.detailSkipped).toBe(1);
    });

    it('403 no detalhe interrompe a fonte (nunca é contornado)', async () => {
      const { context } = setup({
        [BOARD]: () => jsonResponse(BOARD_JSON),
        ...DETAIL_ROUTES,
        [`${BOARD}/102`]: () => textResponse('', { status: 403 }),
      });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(BlockedError);
      expect(toSourceError(s, failure).category).toBe('blocked');
    });

    it('quadro inexistente (404) vira falha de indisponibilidade', async () => {
      const { context } = setup({ [BOARD]: () => textResponse('', { status: 404 }) });
      const s = source();
      const failure = await collect(s, context).catch((e: unknown) => e);
      expect(toSourceError(s, failure).category).toBe('unavailable');
    });

    it('resposta fora do formato é rejeitada com erro claro', async () => {
      const { context } = setup({ [BOARD]: () => jsonResponse({ vagas: [] }) });
      await expect(collect(source(), context)).rejects.toBeInstanceOf(ResponseValidationError);
    });

    it('quando nenhum item tem o formato esperado, falha em vez de devolver vazio', async () => {
      const { context } = setup({ [BOARD]: () => jsonResponse({ jobs: [{ x: 1 }, { y: 2 }] }) });
      await expect(collect(source(), context)).rejects.toThrow(/nenhuma vaga no formato esperado/);
    });

    it('quadro vazio é um resultado válido', async () => {
      const { context } = setup({ [BOARD]: () => jsonResponse({ jobs: [] }) });
      const s = source();
      expect(await collect(s, context)).toEqual([]);
      expect(s.lastRunStats()).toMatchObject({ listed: 0, internships: 0, inRegion: 0 });
    });
  });

  describe('regras de acesso', () => {
    it('respeita o robots.txt: nenhuma requisição à API se o caminho for bloqueado', async () => {
      const { context, callsTo } = setup({
        [GH_ROBOTS]: () => textResponse('User-agent: *\nDisallow: /v1/'),
        [BOARD]: () => jsonResponse(BOARD_JSON),
      });
      await expect(collect(source(), context)).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(callsTo(BOARD)).toHaveLength(0);
    });

    it('espaça as requisições ao mesmo host pelo intervalo configurado', async () => {
      const { context, clock } = setup(
        { [BOARD]: () => jsonResponse(BOARD_JSON), ...DETAIL_ROUTES },
        {},
        { minIntervalMs: 2000 },
      );
      await collect(source(), context);
      // robots + lista + 3 detalhes = 5 requisições ao mesmo host → 4 esperas de 2 s.
      expect(clock.sleeps).toEqual([2000, 2000, 2000, 2000]);
    });

    it('respeita o limite de vagas por fonte', async () => {
      const { context, callsTo } = setup(
        { [BOARD]: () => jsonResponse(BOARD_JSON), ...DETAIL_ROUTES },
        { maxJobsPerSource: 2 },
      );
      const s = source();
      expect(await collect(s, context)).toHaveLength(2);
      expect(s.lastRunStats()?.truncated).toBe(true);
      expect(callsTo(`${BOARD}/103`)).toHaveLength(0); // não baixa o que não vai usar
    });
  });
});
