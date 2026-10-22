import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { runRealScan } from '../../src/discovery/index.js';
import { SourceConfigError, parseSourcesConfig } from '../../src/sources/index.js';
import { setup } from '../helpers/adapters.js';
import { jsonResponse, textResponse } from '../helpers/mock-fetch.js';

const GH_BOARD = 'https://boards-api.greenhouse.io/v1/boards/alfa/jobs';
const GH_OTHER = 'https://boards-api.greenhouse.io/v1/boards/beta/jobs';
const LV = 'https://api.lever.co/v0/postings/gama?mode=json&limit=100&skip=0';

// Mesmo texto publicado nas duas plataformas (≥ 30 palavras, para valer como corroboração).
const DESCRIPTION =
  'Equipe de plataforma procura estagiário para desenvolver APIs em Node.js e TypeScript, escrever testes automatizados, participar de revisões de código, aprender arquitetura de serviços, observabilidade, integração contínua, entrega contínua, boas práticas de versionamento e documentação técnica junto de pessoas mais experientes do time, acompanhando incidentes, melhorando monitoramento, desenhando contratos de API e discutindo decisões de desenho com a equipe de produto semanalmente.';

const ghListed = (id: number, title: string, location: string) => ({
  id,
  title,
  absolute_url: `https://job-boards.greenhouse.io/alfa/jobs/${id}`,
  location: { name: location },
});

const config = parseSourcesConfig({
  limits: { maxJobsPerSource: 50, maxPagesPerSource: 3 },
  targets: [
    { kind: 'greenhouse', slug: 'alfa', name: 'Empresa Alfa' },
    { kind: 'greenhouse', slug: 'beta', name: 'Empresa Beta' },
    { kind: 'lever', slug: 'gama', name: 'Empresa Alfa' }, // mesma empresa em outra plataforma
  ],
});

function routes(overrides: Record<string, () => Response> = {}) {
  return {
    [GH_BOARD]: () =>
      jsonResponse({
        jobs: [
          ghListed(1, 'Estagiário(a) de Desenvolvimento Backend', 'São Paulo, SP'),
          ghListed(2, 'Estágio em Marketing', 'São Paulo, SP'),
          ghListed(3, 'Senior Engineer', 'São Paulo, SP'),
        ],
      }),
    [`${GH_BOARD}/1`]: () =>
      jsonResponse({
        ...ghListed(1, 'Estagiário(a) de Desenvolvimento Backend', 'São Paulo, SP'),
        content: `&lt;p&gt;${DESCRIPTION}&lt;/p&gt;`,
        first_published: '2026-10-01T09:00:00-03:00',
      }),
    [`${GH_BOARD}/2`]: () =>
      jsonResponse({
        ...ghListed(2, 'Estágio em Marketing', 'São Paulo, SP'),
        content: '&lt;p&gt;Campanhas e redes sociais da marca.&lt;/p&gt;',
      }),
    [GH_OTHER]: () => jsonResponse({ jobs: [ghListed(9, 'Estagiário QA', 'São Paulo')] }),
    'https://boards-api.greenhouse.io/v1/boards/beta/jobs/9': () =>
      jsonResponse({ ...ghListed(9, 'Estagiário QA', 'São Paulo'), content: 'Testes' }),
    // A mesma vaga de Backend, publicada também no Lever pela mesma empresa.
    [LV]: () =>
      jsonResponse([
        {
          id: 'lv-1',
          text: 'Estagiário de Desenvolvimento Backend',
          hostedUrl: 'https://jobs.lever.co/gama/lv-1',
          country: 'BR',
          workplaceType: 'hybrid',
          categories: { location: 'São Paulo, SP' },
          description: `<div>${DESCRIPTION}</div>`,
          createdAt: 1_790_000_000_000,
        },
      ]),
    ...overrides,
  };
}

describe('runRealScan — integração com SQLite e dedup', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  it('grava os estágios de várias plataformas e relata as estatísticas por fonte', async () => {
    const { client } = setup(routes());
    const report = await runRealScan({ db, config, http: client });

    expect(report.simulated).toBe(false);
    expect(report.sources.map((s) => s.source)).toEqual([
      'greenhouse:alfa',
      'greenhouse:beta',
      'lever:gama',
    ]);
    expect(report.sources[0]?.stats).toMatchObject({ listed: 3, internships: 2, inRegion: 2 });
    expect(report.sources.map((s) => s.error)).toEqual([null, null, null]);

    // 4 estágios coletados; o do Lever é a mesma vaga do Greenhouse (identidade + descrição).
    expect(report.totals).toMatchObject({ found: 4, new: 3, duplicates: 1, failed: 0 });
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM job_sightings')).toBe(4);
    expect(
      db.prepare("SELECT work_mode, posted_at FROM jobs WHERE external_id = '1'").get(),
    ).toEqual({
      // O Greenhouse não informa modalidade; o Lever (mesma vaga) completa o campo vazio.
      work_mode: 'hibrido',
      posted_at: '2026-10-01T12:00:00.000Z',
    });
  });

  it('falha em uma fonte não afeta as demais', async () => {
    const { client } = setup(routes({ [GH_OTHER]: () => textResponse('', { status: 403 }) }));
    const report = await runRealScan({ db, config, http: client });

    expect(report.sources.map((s) => s.errorCategory)).toEqual([null, 'blocked', null]);
    expect(report.sources[1]?.error).toContain('greenhouse:beta');
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(2);
    expect(
      db.prepare('SELECT error IS NOT NULL AS has_error FROM scan_runs ORDER BY id').all(),
    ).toEqual([{ has_error: 0 }, { has_error: 1 }, { has_error: 0 }]);
  });

  it('repetir a coleta não duplica nem altera nada', async () => {
    const first = await runRealScan({ db, config, http: setup(routes()).client });
    const snapshot = db
      .prepare('SELECT id, content_hash, first_seen_at FROM jobs ORDER BY id')
      .all();

    const second = await runRealScan({ db, config, http: setup(routes()).client });
    expect(first.totals.new).toBe(3);
    expect(second.totals).toMatchObject({ new: 0, updated: 0, duplicates: 4 });
    expect(
      db.prepare('SELECT id, content_hash, first_seen_at FROM jobs ORDER BY id').all(),
    ).toEqual(snapshot);
    expect(count('SELECT COUNT(*) AS n FROM job_sightings')).toBe(4);
  });

  it('uma vaga alterada pela própria fonte é atualizada, sem criar outra', async () => {
    await runRealScan({ db, config, http: setup(routes()).client });
    const changed = routes({
      [`${GH_BOARD}/2`]: () =>
        jsonResponse({
          ...ghListed(2, 'Estágio em Marketing', 'São Paulo, SP'),
          content: '&lt;p&gt;Texto novo da vaga.&lt;/p&gt;',
        }),
    });
    const report = await runRealScan({ db, config, http: setup(changed).client });

    expect(report.totals).toMatchObject({ new: 0, updated: 1 });
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(3);
    expect(db.prepare("SELECT description FROM jobs WHERE external_id = '2'").get()).toEqual({
      description: 'Texto novo da vaga.',
    });
  });

  it('só faz GET: nada é enviado às plataformas', async () => {
    const { client, calls } = setup(routes());
    await runRealScan({ db, config, http: client });
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.init?.method))).toEqual(new Set(['GET']));
  });

  describe('seleção de fontes', () => {
    it('--source limita a coleta (sem diferenciar maiúsculas)', async () => {
      const { client, calls } = setup(routes());
      const report = await runRealScan({ db, config, http: client, only: ['Lever:Gama'] });
      expect(report.sources.map((s) => s.source)).toEqual(['lever:gama']);
      expect(calls.some((c) => c.url.includes('/boards/'))).toBe(false);
    });

    it('fonte inexistente na configuração é erro', async () => {
      await expect(
        runRealScan({ db, config, http: setup(routes()).client, only: ['greenhouse:nao-existe'] }),
      ).rejects.toThrow(/não encontrada/);
    });

    it('sem nenhum alvo habilitado é erro explicativo', async () => {
      await expect(
        runRealScan({ db, config: parseSourcesConfig({}), http: setup(routes()).client }),
      ).rejects.toBeInstanceOf(SourceConfigError);
    });

    it('alvos desabilitados são ignorados', async () => {
      const disabled = parseSourcesConfig({
        targets: [
          { kind: 'greenhouse', slug: 'alfa', name: 'Alfa' },
          { kind: 'greenhouse', slug: 'beta', name: 'Beta', enabled: false },
        ],
      });
      const { client, callsTo } = setup(routes());
      await runRealScan({ db, config: disabled, http: client });
      expect(callsTo(GH_OTHER)).toHaveLength(0);
    });
  });
});

describe('runRealScan — Ashby (SQLite, idempotência e isolamento)', () => {
  const AB = 'https://api.ashbyhq.com/posting-api/job-board/delta?includeCompensation=true';
  const abConfig = parseSourcesConfig({
    targets: [
      { kind: 'ashby', slug: 'delta', name: 'Empresa Delta' },
      { kind: 'greenhouse', slug: 'beta', name: 'Empresa Beta' },
    ],
  });
  const abJob = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    employmentType: 'Intern',
    location: 'São Paulo',
    isListed: true,
    workplaceType: 'Remote',
    publishedAt: '2026-10-01T09:00:00.000+00:00',
    jobUrl: `https://jobs.ashbyhq.com/delta/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/delta/${id}/application`,
    descriptionPlain: 'Estágio em desenvolvimento de software.',
    ...extra,
  });
  const abRoutes = (jobs: unknown[]) => ({
    [AB]: () => jsonResponse({ apiVersion: '1', jobs }),
    [GH_OTHER]: () => jsonResponse({ jobs: [ghListed(9, 'Estagiário QA', 'São Paulo')] }),
    'https://boards-api.greenhouse.io/v1/boards/beta/jobs/9': () =>
      jsonResponse({ ...ghListed(9, 'Estagiário QA', 'São Paulo'), content: 'Testes' }),
  });

  let db: Db;
  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  it('grava a vaga com a URL de candidatura e é idempotente', async () => {
    const jobs = [
      abJob('j1', 'Estagiário Dev'),
      abJob('j2', 'Estágio em Dados', { isListed: false }),
    ];
    const first = await runRealScan({ db, config: abConfig, http: setup(abRoutes(jobs)).client });
    expect(first.totals).toMatchObject({ found: 2, new: 2, failed: 0 }); // 1 Ashby + 1 Greenhouse
    expect(
      db.prepare("SELECT url, apply_url, work_mode FROM jobs WHERE external_id = 'j1'").get(),
    ).toEqual({
      url: 'https://jobs.ashbyhq.com/delta/j1',
      apply_url: 'https://jobs.ashbyhq.com/delta/j1/application',
      work_mode: 'remoto',
    });
    expect(count("SELECT COUNT(*) AS n FROM jobs WHERE external_id = 'j2'")).toBe(0); // oculta

    const second = await runRealScan({ db, config: abConfig, http: setup(abRoutes(jobs)).client });
    expect(second.totals).toMatchObject({ new: 0, updated: 0, duplicates: 2 });
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(2);
  });

  it('a mesma vaga repetida no quadro não duplica', async () => {
    const dup = abJob('j1', 'Estagiário Dev');
    const report = await runRealScan({
      db,
      config: abConfig,
      http: setup(abRoutes([dup, dup])).client,
    });
    expect(report.totals.new).toBe(2); // Ashby (1) + Greenhouse (1)
    expect(count("SELECT COUNT(*) AS n FROM jobs WHERE external_id = 'j1'")).toBe(1);
  });

  it('403 na Ashby não impede as demais fontes', async () => {
    const report = await runRealScan({
      db,
      config: abConfig,
      http: setup({ ...abRoutes([]), [AB]: () => textResponse('', { status: 403 }) }).client,
    });
    expect(report.sources.map((s) => s.errorCategory)).toEqual(['blocked', null]);
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(1);
  });
});
