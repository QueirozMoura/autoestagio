import { HttpClient } from '../http/index.js';
import type { SourcesConfig, SourceTarget } from './config.js';
import type { JobSource, SourceContext, SourceLimits } from './types.js';

/** Cria o adaptador de um alvo. Cada tipo de fonte registra a sua fábrica. */
export type SourceFactory = (target: SourceTarget) => JobSource;

export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

export class SourceRegistry {
  private readonly factories = new Map<string, SourceFactory>();

  register(kind: string, factory: SourceFactory): this {
    if (this.factories.has(kind)) {
      throw new SourceConfigError(`Já existe um adaptador registrado para "${kind}"`);
    }
    this.factories.set(kind, factory);
    return this;
  }

  kinds(): string[] {
    return [...this.factories.keys()].sort();
  }

  /**
   * Instancia os alvos habilitados. Se algum usar um tipo sem adaptador, falha antes de
   * qualquer requisição, listando todos os problemas de uma vez.
   */
  create(config: Pick<SourcesConfig, 'targets'>): JobSource[] {
    const sources: JobSource[] = [];
    const problems: string[] = [];

    for (const target of config.targets) {
      if (!target.enabled) continue;
      const factory = this.factories.get(target.kind);
      if (!factory) {
        problems.push(`${target.kind}:${target.slug}: adaptador "${target.kind}" não disponível`);
        continue;
      }
      sources.push(factory(target));
    }

    if (problems.length > 0) {
      const available = this.kinds().join(', ') || 'nenhum';
      throw new SourceConfigError(
        `Fontes não puderam ser criadas (adaptadores disponíveis: ${available}):\n  - ${problems.join('\n  - ')}`,
      );
    }
    return sources;
  }
}

export function createHttpClient(config: Pick<SourcesConfig, 'http'>): HttpClient {
  const { http } = config;
  return new HttpClient({
    userAgent: http.userAgent,
    timeoutMs: http.timeoutMs,
    maxRetries: http.maxRetries,
    minIntervalMs: http.minIntervalMs,
    maxRetryAfterMs: http.maxRetryAfterMs,
    maxResponseBytes: http.maxResponseBytes,
    respectRobots: http.respectRobots,
  });
}

export function createSourceContext(
  config: Pick<SourcesConfig, 'http' | 'limits'>,
  overrides: { http?: HttpClient; signal?: AbortSignal } = {},
): SourceContext {
  const limits: SourceLimits = {
    maxJobs: config.limits.maxJobsPerSource,
    maxPages: config.limits.maxPagesPerSource,
  };
  return {
    http: overrides.http ?? createHttpClient(config),
    limits,
    signal: overrides.signal,
  };
}
