import { z } from 'zod';
import type { HttpClient } from '../http/index.js';
import {
  BlockedError,
  RateLimitedError,
  ResponseValidationError,
  RobotsDisallowedError,
} from '../http/index.js';

/**
 * Vaga como veio da fonte, antes da normalização. Os adaptadores só traduzem o formato da
 * fonte para este; não gravam no banco nem decidem se a vaga serve para o perfil.
 */
export const rawJobSchema = z.object({
  /** Identificador estável da vaga na fonte, quando existir. */
  externalId: z.string().min(1).optional(),
  url: z.url(),
  title: z.string().min(1),
  company: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  description: z.string().optional(),
  /** Texto livre sobre bolsa/remuneração, exatamente como publicado. */
  compensationText: z.string().optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
});

export type RawJob = z.infer<typeof rawJobSchema>;

export interface SourceLimits {
  /** Teto de vagas por fonte em cada execução. */
  maxJobs: number;
  /** Teto de páginas/requisições de listagem por fonte em cada execução. */
  maxPages: number;
}

export interface SourceContext {
  http: HttpClient;
  limits: SourceLimits;
  signal?: AbortSignal | undefined;
}

export interface JobSource {
  /** Tipo do adaptador, por exemplo "greenhouse". */
  readonly kind: string;
  /** Identificador do alvo dentro do tipo (slug da empresa). */
  readonly slug: string;
  /** Nome amigável. */
  readonly name: string;
  /** Lista as vagas. Deve respeitar `ctx.limits` e `ctx.signal`. */
  fetchJobs(ctx: SourceContext): AsyncIterable<RawJob>;
}

export type SourceErrorCategory =
  'blocked' | 'rate_limited' | 'robots' | 'invalid_response' | 'unavailable';

/** Falha de uma fonte. Isolada: o scan registra e segue para as demais. */
export class SourceError extends Error {
  readonly category: SourceErrorCategory;
  readonly sourceKey: string;

  constructor(sourceKey: string, category: SourceErrorCategory, message: string, cause?: unknown) {
    super(`[${sourceKey}] ${message}`, { cause });
    this.name = 'SourceError';
    this.category = category;
    this.sourceKey = sourceKey;
  }
}

export function sourceKey(source: Pick<JobSource, 'kind' | 'slug'>): string {
  return `${source.kind}:${source.slug}`;
}

/** Converte um erro qualquer (normalmente do cliente HTTP) em `SourceError`. */
export function toSourceError(
  source: Pick<JobSource, 'kind' | 'slug'>,
  error: unknown,
): SourceError {
  const key = sourceKey(source);
  if (error instanceof SourceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BlockedError) return new SourceError(key, 'blocked', message, error);
  if (error instanceof RateLimitedError)
    return new SourceError(key, 'rate_limited', message, error);
  if (error instanceof RobotsDisallowedError) return new SourceError(key, 'robots', message, error);
  if (error instanceof ResponseValidationError) {
    return new SourceError(key, 'invalid_response', message, error);
  }
  return new SourceError(key, 'unavailable', message, error);
}
