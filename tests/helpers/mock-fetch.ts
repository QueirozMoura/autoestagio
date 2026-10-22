import type { Clock } from '../../src/http/rate-limit.js';
import type { FetchLike } from '../../src/http/client.js';

export type Handler = Response | Error | ((init?: RequestInit) => Response | Promise<Response>);

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Fetch simulado. Cada URL tem uma fila de respostas, consumidas em ordem; a última se repete.
 * URL sem rota lança erro, então nenhum teste consegue sair para a rede de verdade.
 */
export function mockFetch(routes: Record<string, Handler | Handler[]>): {
  fetch: FetchLike;
  calls: Call[];
  callsTo: (url: string) => Call[];
} {
  const queues = new Map(
    Object.entries(routes).map(([url, handlers]) => [
      url,
      Array.isArray(handlers) ? [...handlers] : [handlers],
    ]),
  );
  const calls: Call[] = [];

  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const queue = queues.get(input);
    if (!queue || queue.length === 0) {
      throw new Error(`requisição não prevista no teste: ${input}`);
    }
    const handler = queue.length > 1 ? queue.shift() : queue[0];
    if (handler instanceof Error) throw handler;
    const response = typeof handler === 'function' ? await handler(init) : handler;
    if (!response) return new Response(null, { status: 500 });
    return fresh(response);
  };

  // Uma Response só pode ter o corpo lido uma vez, e `clone()` divide o fluxo em dois (tee),
  // o que faz `body.cancel()` ficar pendente. Por isso cada chamada recebe uma Response nova.
  const bodies = new WeakMap<Response, string>();
  async function fresh(source: Response): Promise<Response> {
    let text = bodies.get(source);
    if (text === undefined) {
      text = await source.text();
      bodies.set(source, text);
    }
    return new Response(text === '' ? null : text, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    });
  }

  return { fetch, calls, callsTo: (url) => calls.filter((call) => call.url === url) };
}

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
};

export const textResponse = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, init);

/** Relógio falso: `sleep` avança o tempo na hora e registra as esperas. */
export class FakeClock implements Clock {
  time = 1_000_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.time;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
    return Promise.resolve();
  }
}
