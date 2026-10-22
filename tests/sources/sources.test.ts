import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/index.js';
import { HttpClient } from '../../src/http/index.js';
import {
  BlockedError,
  HttpStatusError,
  RateLimitedError,
  ResponseValidationError,
  RobotsDisallowedError,
} from '../../src/http/errors.js';
import {
  SourceConfigError,
  SourceError,
  SourceRegistry,
  createSourceContext,
  loadSourcesConfig,
  parseSourcesConfig,
  rawJobSchema,
  toSourceError,
  type JobSource,
  type SourceTarget,
} from '../../src/sources/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { mockFetch, jsonResponse, textResponse } from '../helpers/mock-fetch.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('configuração de fontes', () => {
  it('aplica padrões seguros', () => {
    const config = parseSourcesConfig({});
    expect(config.targets).toEqual([]);
    expect(config.http.respectRobots).toBe(true);
    expect(config.http.minIntervalMs).toBe(2000);
    expect(config.http.maxRetries).toBe(3);
    expect(config.limits.maxJobsPerSource).toBe(500);
  });

  it('o arquivo de exemplo é válido e não contém alvos inventados', () => {
    const config = loadSourcesConfig(join(PROJECT_ROOT, 'config', 'sources.example.json'));
    expect(config.targets).toEqual([]);
  });

  it('sem arquivo, usa o padrão', () => {
    expect(loadSourcesConfig('/caminho/inexistente.json').targets).toEqual([]);
  });

  it('lê alvos de um arquivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
    tempDirs.push(dir);
    const file = join(dir, 'sources.json');
    writeFileSync(
      file,
      JSON.stringify({ targets: [{ kind: 'greenhouse', slug: 'exemplo', name: 'Exemplo' }] }),
    );
    const [target] = loadSourcesConfig(file).targets;
    expect(target).toMatchObject({ kind: 'greenhouse', slug: 'exemplo', enabled: true });
  });

  it('rejeita tipo desconhecido, slug inválido e limites fora da faixa', () => {
    expect(() =>
      parseSourcesConfig({ targets: [{ kind: 'linkedin', slug: 'x', name: 'X' }] }),
    ).toThrow(ConfigError);
    expect(() =>
      parseSourcesConfig({ targets: [{ kind: 'lever', slug: '../etc', name: 'X' }] }),
    ).toThrow(/slug/);
    expect(() => parseSourcesConfig({ http: { minIntervalMs: 10 } })).toThrow(ConfigError);
    expect(() => parseSourcesConfig({ http: { maxRetries: 50 } })).toThrow(ConfigError);
  });

  it('rejeita alvos duplicados', () => {
    const target = { kind: 'lever', slug: 'Acme', name: 'Acme' };
    expect(() => parseSourcesConfig({ targets: [target, { ...target, slug: 'acme' }] })).toThrow(
      /duplicado/,
    );
  });
});

describe('SourceRegistry', () => {
  const fakeSource = (target: SourceTarget): JobSource => ({
    kind: target.kind,
    slug: target.slug,
    name: target.name,
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *fetchJobs() {
      return;
    },
  });

  const config = parseSourcesConfig({
    targets: [
      { kind: 'greenhouse', slug: 'a', name: 'A' },
      { kind: 'greenhouse', slug: 'b', name: 'B', enabled: false },
      { kind: 'lever', slug: 'c', name: 'C' },
    ],
  });

  it('cria só os alvos habilitados', () => {
    const registry = new SourceRegistry()
      .register('greenhouse', fakeSource)
      .register('lever', fakeSource);
    expect(registry.create(config).map((s) => `${s.kind}:${s.slug}`)).toEqual([
      'greenhouse:a',
      'lever:c',
    ]);
  });

  it('falha antes de qualquer requisição se faltar adaptador, listando todos os problemas', () => {
    const registry = new SourceRegistry();
    expect(() => registry.create(config)).toThrow(SourceConfigError);
    expect(() => registry.create(config)).toThrow(/greenhouse:a[\s\S]*lever:c/);
  });

  it('alvos desabilitados não exigem adaptador', () => {
    const registry = new SourceRegistry().register('greenhouse', fakeSource);
    const onlyDisabled = parseSourcesConfig({
      targets: [{ kind: 'lever', slug: 'z', name: 'Z', enabled: false }],
    });
    expect(registry.create(onlyDisabled)).toEqual([]);
  });

  it('não permite registrar o mesmo tipo duas vezes', () => {
    const registry = new SourceRegistry().register('lever', fakeSource);
    expect(() => registry.register('lever', fakeSource)).toThrow(SourceConfigError);
  });
});

describe('contrato do adaptador (fonte simulada)', () => {
  const schemaOfFeed = rawJobSchema.array();

  /** Adaptador mínimo que usa o contexto como um adaptador real usaria. */
  const feedSource: JobSource = {
    kind: 'greenhouse',
    slug: 'exemplo',
    name: 'Exemplo',
    async *fetchJobs(ctx) {
      const jobs = await ctx.http.getJson('https://exemplo.test/feed', schemaOfFeed, {
        signal: ctx.signal,
      });
      yield* jobs.slice(0, ctx.limits.maxJobs);
    },
  };

  const job = (n: number) => ({
    externalId: String(n),
    url: `https://exemplo.test/${n}`,
    title: `Vaga ${n}`,
  });

  async function collect(source: JobSource, client: HttpClient, maxJobs = 500) {
    const config = parseSourcesConfig({ limits: { maxJobsPerSource: maxJobs } });
    const ctx = createSourceContext(config, { http: client });
    const jobs = [];
    for await (const item of source.fetchJobs(ctx)) jobs.push(item);
    return jobs;
  }

  const client = (routes: Parameters<typeof mockFetch>[0]) =>
    new HttpClient({ fetch: mockFetch(routes).fetch, minIntervalMs: 0, maxRetries: 0 });
  const robotsOk = { 'https://exemplo.test/robots.txt': () => textResponse('', { status: 404 }) };

  it('entrega as vagas e respeita o limite do contexto', async () => {
    const http = client({
      ...robotsOk,
      'https://exemplo.test/feed': jsonResponse([job(1), job(2), job(3)]),
    });
    expect(await collect(feedSource, http, 2)).toHaveLength(2);
  });

  it('vaga fora do contrato é rejeitada pela validação', async () => {
    const http = client({
      ...robotsOk,
      'https://exemplo.test/feed': jsonResponse([{ url: 'não é url', title: '' }]),
    });
    await expect(collect(feedSource, http)).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it('erros do cliente viram SourceError com categoria', async () => {
    const http = client({
      ...robotsOk,
      'https://exemplo.test/feed': textResponse('', { status: 403 }),
    });
    const error = await collect(feedSource, http).then(
      () => {
        throw new Error('deveria ter falhado');
      },
      (e: unknown) => toSourceError(feedSource, e),
    );
    expect(error).toBeInstanceOf(SourceError);
    expect(error.category).toBe('blocked');
    expect(error.message).toContain('[greenhouse:exemplo]');
  });
});

describe('toSourceError', () => {
  const source = { kind: 'lever', slug: 'acme' };
  const details = { status: 429, url: 'https://x.test/' };

  it.each([
    [new BlockedError('x', { ...details, status: 403 }), 'blocked'],
    [new RateLimitedError('x', details), 'rate_limited'],
    [new RobotsDisallowedError('https://x.test/', 'caminho bloqueado'), 'robots'],
    [new ResponseValidationError('https://x.test/', ['campo']), 'invalid_response'],
    [new HttpStatusError('x', { ...details, status: 500 }), 'unavailable'],
    [new Error('qualquer'), 'unavailable'],
  ])('classifica %s', (error, category) => {
    expect(toSourceError(source, error).category).toBe(category);
  });

  it('preserva um SourceError existente', () => {
    const original = new SourceError('lever:acme', 'blocked', 'já classificado');
    expect(toSourceError(source, original)).toBe(original);
  });
});
