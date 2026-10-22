import type { z } from 'zod';
import {
  BlockedError,
  HttpStatusError,
  InvalidUrlError,
  NetworkError,
  RateLimitedError,
  ResponseTooLargeError,
  ResponseValidationError,
  RobotsDisallowedError,
  TimeoutError,
  TooManyRedirectsError,
} from './errors.js';
import { HostRateLimiter, systemClock, type Clock } from './rate-limit.js';
import { RobotsChecker } from './robots.js';
import { RETRYABLE_STATUS, backoffDelay, parseRetryAfter } from './retry.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_USER_AGENT = 'AutoEstagio/0.1 (uso pessoal; coleta com limite de requisições)';

export interface HttpClientOptions {
  fetch?: FetchLike;
  userAgent?: string;
  timeoutMs?: number;
  /** Número de novas tentativas após a primeira (0 desativa retry). */
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** `Retry-After` acima deste valor não é aguardado: a requisição falha com `RateLimitedError`. */
  maxRetryAfterMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  respectRobots?: boolean;
  /** `Crawl-delay` acima deste valor é tratado como bloqueio. */
  maxCrawlDelayMs?: number;
  minIntervalMs?: number;
  perHostIntervalMs?: Record<string, number>;
  clock?: Clock;
  random?: () => number;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Sobrescreve a configuração do cliente para esta requisição. */
  respectRobots?: boolean | undefined;
  accept?: string | undefined;
}

export interface HttpResponse {
  /** URL final, depois de redirecionamentos. */
  url: string;
  status: number;
  headers: Headers;
  text: string;
}

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export class HttpClient {
  private readonly fetchFn: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly respectRobots: boolean;
  private readonly maxCrawlDelayMs: number;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly limiter: HostRateLimiter;
  private readonly robots: RobotsChecker;

  constructor(options: HttpClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
    this.respectRobots = options.respectRobots ?? true;
    this.maxCrawlDelayMs = options.maxCrawlDelayMs ?? 30_000;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.limiter = new HostRateLimiter({
      defaultIntervalMs: options.minIntervalMs ?? 2_000,
      clock: this.clock,
      ...(options.perHostIntervalMs && { perHostIntervalMs: options.perHostIntervalMs }),
    });
    this.robots = new RobotsChecker({
      userAgent: this.userAgent,
      clock: this.clock,
      load: (robotsUrl, signal) => this.loadRobots(robotsUrl, signal),
    });
  }

  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.request(url, options);
    return response.text;
  }

  /** Obtém JSON e o valida com o schema: respostas fora do formato viram `ResponseValidationError`. */
  async getJson<T>(url: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(url, {
      ...options,
      accept: options.accept ?? 'application/json',
    });
    let data: unknown;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new ResponseValidationError(response.url, ['o corpo não é um JSON válido']);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ResponseValidationError(
        response.url,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`),
      );
    }
    return parsed.data;
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const respectRobots = options.respectRobots ?? this.respectRobots;
    let current = parseUrl(url);

    for (let redirects = 0; ; redirects++) {
      const response = await this.fetchWithRetry(current, respectRobots, options);
      if (!REDIRECT_STATUS.has(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) {
        throw new HttpStatusError(`Redirecionamento sem Location em ${current.href}`, {
          status: response.status,
          url: current.href,
        });
      }
      if (redirects >= this.maxRedirects) {
        throw new TooManyRedirectsError(`Mais de ${this.maxRedirects} redirecionamentos`);
      }
      current = parseUrl(new URL(location, current).href);
    }
  }

  private async fetchWithRetry(
    url: URL,
    respectRobots: boolean,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    const { signal } = options;

    for (let attempt = 0; ; attempt++) {
      if (respectRobots) await this.assertRobotsAllows(url, signal);

      const release = await this.limiter.acquire(url.host, signal);
      let response: HttpResponse;
      try {
        response = await this.attempt(url, options);
      } catch (error) {
        release();
        if (!isRetryableFailure(error) || attempt >= this.maxRetries) throw error;
        this.limiter.delayHost(url.host, this.backoff(attempt));
        continue;
      }
      release();

      if (response.status < 400) return response;

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.clock.now());
      const details = { status: response.status, url: url.href, retryAfterMs };

      if (response.status === 401 || response.status === 403) {
        throw new BlockedError(`Acesso recusado (HTTP ${response.status}) em ${url.href}`, details);
      }
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new HttpStatusError(`HTTP ${response.status} em ${url.href}`, details);
      }

      const failure = (): HttpStatusError =>
        response.status === 429
          ? new RateLimitedError(`Limite de requisições atingido em ${url.host}`, details)
          : new HttpStatusError(`HTTP ${response.status} em ${url.href}`, details);

      if (retryAfterMs !== undefined && retryAfterMs > this.maxRetryAfterMs) throw failure();

      const wait = retryAfterMs ?? this.backoff(attempt);
      // O atraso vale para o host inteiro, inclusive para as próximas requisições.
      this.limiter.delayHost(url.host, wait);
      if (attempt >= this.maxRetries) throw failure();
    }
  }

  /** Uma tentativa: sem retry, sem seguir redirecionamentos. */
  private async attempt(url: URL, options: RequestOptions): Promise<HttpResponse> {
    const userSignal = options.signal;
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(userSignal ? [userSignal] : [])];

    try {
      const response = await this.fetchFn(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        headers: {
          'User-Agent': this.userAgent,
          Accept: options.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });

      let text = '';
      if (response.status >= 200 && response.status < 300) {
        const declared = Number(response.headers.get('content-length'));
        if (declared > this.maxResponseBytes) {
          await response.body?.cancel();
          throw new ResponseTooLargeError(`Resposta de ${url.href} excede o limite`);
        }
        text = await response.text();
        if (Buffer.byteLength(text) > this.maxResponseBytes) {
          throw new ResponseTooLargeError(`Resposta de ${url.href} excede o limite`);
        }
      } else {
        await response.body?.cancel();
      }
      return { url: url.href, status: response.status, headers: response.headers, text };
    } catch (error) {
      if (userSignal?.aborted) throw error;
      if (error instanceof ResponseTooLargeError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new TimeoutError(`Tempo esgotado (${this.timeoutMs} ms) em ${url.href}`, {
          cause: error,
        });
      }
      throw new NetworkError(`Falha de rede em ${url.href}: ${describe(error)}`, { cause: error });
    }
  }

  private backoff(attempt: number): number {
    return backoffDelay(attempt, {
      baseMs: this.backoffBaseMs,
      maxMs: this.backoffMaxMs,
      random: this.random,
    });
  }

  private async assertRobotsAllows(url: URL, signal: AbortSignal | undefined): Promise<void> {
    const decision = await this.robots.check(url, signal);
    if (!decision.allowed) {
      throw new RobotsDisallowedError(url.href, decision.reason ?? 'bloqueado');
    }
    if (decision.crawlDelayMs !== undefined) {
      if (decision.crawlDelayMs > this.maxCrawlDelayMs) {
        throw new RobotsDisallowedError(
          url.href,
          `Crawl-delay de ${decision.crawlDelayMs / 1000}s excede o limite aceito`,
        );
      }
      this.limiter.raiseInterval(url.host, decision.crawlDelayMs);
    }
  }

  private async loadRobots(
    robotsUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; body: string }> {
    try {
      const response = await this.request(robotsUrl, { respectRobots: false, signal });
      return { status: response.status, body: response.text };
    } catch (error) {
      if (error instanceof HttpStatusError) return { status: error.status, body: '' };
      throw error;
    }
  }
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new InvalidUrlError(`URL inválida: ${value}`, { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new InvalidUrlError(`Somente HTTPS é permitido: ${url.href}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidUrlError('URLs com credenciais não são permitidas');
  }
  return url;
}

function isRetryableFailure(error: unknown): boolean {
  return error instanceof NetworkError || error instanceof TimeoutError;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
