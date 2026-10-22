import { HttpClient } from '../../src/http/index.js';
import {
  createSourceContext,
  parseSourcesConfig,
  type JobSource,
  type RawJob,
  type SourceTarget,
} from '../../src/sources/index.js';
import { FakeClock, mockFetch, textResponse, type Handler } from './mock-fetch.js';

export const GH_ROBOTS = 'https://boards-api.greenhouse.io/robots.txt';
export const LV_ROBOTS = 'https://api.lever.co/robots.txt';

/** robots.txt reais das duas plataformas (verificados em 2026-10-22), para os testes. */
export const robotsRoutes: Record<string, Handler> = {
  [GH_ROBOTS]: () => textResponse('User-agent: *\nDisallow: /embed/'),
  [LV_ROBOTS]: () => textResponse('User-agent: *\nAllow: /\nCrawl-delay: 1'),
  'https://api.eu.lever.co/robots.txt': () =>
    textResponse('User-agent: *\nAllow: /\nCrawl-delay: 1'),
};

export function target(overrides: Record<string, unknown> = {}): SourceTarget {
  const config = parseSourcesConfig({
    targets: [{ kind: 'greenhouse', slug: 'exemplo', name: 'Empresa Exemplo', ...overrides }],
  });
  const [first] = config.targets;
  if (!first) throw new Error('alvo inválido no teste');
  return first;
}

export function setup(
  routes: Record<string, Handler | Handler[]>,
  limits: { maxJobsPerSource?: number; maxPagesPerSource?: number } = {},
  http: { minIntervalMs?: number } = {},
) {
  const clock = new FakeClock();
  const mock = mockFetch({ ...robotsRoutes, ...routes });
  const client = new HttpClient({
    fetch: mock.fetch,
    clock,
    random: () => 1,
    minIntervalMs: http.minIntervalMs ?? 0,
    maxRetries: 0,
  });
  const context = createSourceContext(parseSourcesConfig({ limits }), { http: client });
  return { clock, client, context, ...mock };
}

export async function collect(
  source: JobSource,
  context: ReturnType<typeof setup>['context'],
): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  for await (const job of source.fetchJobs(context)) jobs.push(job);
  return jobs;
}
