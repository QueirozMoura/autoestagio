import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpClient, type HttpClientOptions } from '../../src/http/client.js';
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
} from '../../src/http/errors.js';
import {
  FakeClock,
  jsonResponse,
  mockFetch,
  textResponse,
  type Handler,
} from '../helpers/mock-fetch.js';

const URL_A = 'https://empresa.com/vagas';
const ROBOTS_A = 'https://empresa.com/robots.txt';
const noRobots: Handler = () => textResponse('', { status: 404 });

function setup(routes: Record<string, Handler | Handler[]>, options: HttpClientOptions = {}) {
  const clock = new FakeClock();
  const mock = mockFetch(routes);
  const client = new HttpClient({
    fetch: mock.fetch,
    clock,
    random: () => 1,
    minIntervalMs: 0,
    backoffBaseMs: 1000,
    ...options,
  });
  return { client, clock, ...mock };
}

describe('HttpClient — requisições básicas', () => {
  it('devolve o texto e envia User-Agent e Accept', async () => {
    const { client, callsTo } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: textResponse('olá') },
      { userAgent: 'TesteBot/1.0' },
    );
    expect(await client.getText(URL_A)).toBe('olá');

    const headers = callsTo(URL_A)[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('TesteBot/1.0');
    expect(headers.Accept).toContain('text/html');
  });

  it('valida JSON com o schema', async () => {
    const { client } = setup({ [ROBOTS_A]: noRobots, [URL_A]: jsonResponse({ jobs: [1, 2] }) });
    const data = await client.getJson(URL_A, z.object({ jobs: z.array(z.number()) }));
    expect(data.jobs).toEqual([1, 2]);
  });

  it('JSON fora do formato vira ResponseValidationError com os campos', async () => {
    const { client } = setup({ [ROBOTS_A]: noRobots, [URL_A]: jsonResponse({ jobs: 'x' }) });
    const promise = client.getJson(URL_A, z.object({ jobs: z.array(z.number()) }));
    await expect(promise).rejects.toBeInstanceOf(ResponseValidationError);
    await expect(promise).rejects.toThrow(/jobs/);
  });

  it('corpo que não é JSON vira ResponseValidationError', async () => {
    const { client } = setup({ [ROBOTS_A]: noRobots, [URL_A]: textResponse('<html>') });
    await expect(client.getJson(URL_A, z.unknown())).rejects.toBeInstanceOf(
      ResponseValidationError,
    );
  });

  it('rejeita URL inválida, http e credenciais, sem fazer requisição', async () => {
    const { client, calls } = setup({});
    await expect(client.getText('isso não é url')).rejects.toBeInstanceOf(InvalidUrlError);
    await expect(client.getText('http://empresa.com/x')).rejects.toBeInstanceOf(InvalidUrlError);
    await expect(client.getText('https://user:pw@empresa.com/x')).rejects.toBeInstanceOf(
      InvalidUrlError,
    );
    expect(calls).toHaveLength(0);
  });

  it('rejeita resposta maior que o limite', async () => {
    const { client } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: textResponse('x'.repeat(200)) },
      { maxResponseBytes: 100 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('HttpClient — erros e retry', () => {
  it('repete após 503 e usa backoff', async () => {
    const { client, clock, callsTo } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: [textResponse('', { status: 503 }), textResponse('ok')],
    });
    expect(await client.getText(URL_A)).toBe('ok');
    expect(callsTo(URL_A)).toHaveLength(2);
    expect(clock.sleeps).toEqual([1000]); // random=1 → valor cheio do backoff
  });

  it('o backoff cresce a cada tentativa', async () => {
    const { client, clock } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: [
        textResponse('', { status: 502 }),
        textResponse('', { status: 502 }),
        textResponse('', { status: 502 }),
        textResponse('ok'),
      ],
    });
    await client.getText(URL_A);
    expect(clock.sleeps).toEqual([1000, 2000, 4000]);
  });

  it('desiste depois de maxRetries e lança HttpStatusError', async () => {
    const { client, callsTo } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: textResponse('', { status: 500 }) },
      { maxRetries: 2 },
    );
    const promise = client.getText(URL_A);
    await expect(promise).rejects.toBeInstanceOf(HttpStatusError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
    expect(callsTo(URL_A)).toHaveLength(3); // 1 inicial + 2 retries
  });

  it('maxRetries=0 não repete', async () => {
    const { client, callsTo } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: textResponse('', { status: 503 }) },
      { maxRetries: 0 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(HttpStatusError);
    expect(callsTo(URL_A)).toHaveLength(1);
  });

  it.each([404, 410, 400])('não repete HTTP %i', async (status) => {
    const { client, callsTo } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: textResponse('', { status }),
    });
    await expect(client.getText(URL_A)).rejects.toMatchObject({ status });
    expect(callsTo(URL_A)).toHaveLength(1);
  });

  it.each([401, 403])('HTTP %i vira BlockedError e nunca é repetido', async (status) => {
    const { client, callsTo } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: textResponse('', { status }),
    });
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(BlockedError);
    expect(callsTo(URL_A)).toHaveLength(1);
  });

  it('repete após falha de rede', async () => {
    const { client, callsTo } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: [new TypeError('fetch failed'), textResponse('ok')],
    });
    expect(await client.getText(URL_A)).toBe('ok');
    expect(callsTo(URL_A)).toHaveLength(2);
  });

  it('falha de rede persistente vira NetworkError', async () => {
    const { client } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: new TypeError('fetch failed') },
      { maxRetries: 1 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(NetworkError);
  });

  it('estoura o timeout e lança TimeoutError', async () => {
    const hang: Handler = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const { client, callsTo } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: hang },
      { timeoutMs: 20, maxRetries: 1 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(TimeoutError);
    expect(callsTo(URL_A)).toHaveLength(2); // timeout é repetido
  });

  it('cancelamento do usuário não é repetido nem convertido', async () => {
    const controller = new AbortController();
    const hang: Handler = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const { client, callsTo } = setup({ [ROBOTS_A]: noRobots, [URL_A]: hang });
    const promise = client.getText(URL_A, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('parar'));
    await expect(promise).rejects.toThrow('parar');
    expect(callsTo(URL_A)).toHaveLength(1);
  });
});

describe('HttpClient — Retry-After', () => {
  it('respeita Retry-After em segundos no 429', async () => {
    const { client, clock } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: [
        textResponse('', { status: 429, headers: { 'retry-after': '7' } }),
        textResponse('ok'),
      ],
    });
    expect(await client.getText(URL_A)).toBe('ok');
    expect(clock.sleeps).toEqual([7000]);
  });

  it('respeita Retry-After em data HTTP', async () => {
    const clock = new FakeClock();
    const date = new Date(clock.now() + 12_000).toUTCString();
    const { client } = setup(
      {
        [ROBOTS_A]: noRobots,
        [URL_A]: [
          textResponse('', { status: 503, headers: { 'retry-after': date } }),
          textResponse('ok'),
        ],
      },
      { clock },
    );
    await client.getText(URL_A);
    // A data HTTP tem precisão de segundos, então a espera fica entre 11s e 12s.
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(11_000);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(12_000);
  });

  it('Retry-After acima do limite não é aguardado e lança RateLimitedError', async () => {
    const { client, clock, callsTo } = setup(
      {
        [ROBOTS_A]: noRobots,
        [URL_A]: textResponse('', { status: 429, headers: { 'retry-after': '3600' } }),
      },
      { maxRetryAfterMs: 60_000 },
    );
    const promise = client.getText(URL_A);
    await expect(promise).rejects.toBeInstanceOf(RateLimitedError);
    await expect(promise).rejects.toMatchObject({ status: 429, retryAfterMs: 3_600_000 });
    expect(clock.sleeps).toEqual([]);
    expect(callsTo(URL_A)).toHaveLength(1);
  });

  it('429 persistente vira RateLimitedError depois dos retries', async () => {
    const { client, callsTo } = setup(
      { [ROBOTS_A]: noRobots, [URL_A]: textResponse('', { status: 429 }) },
      { maxRetries: 2 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(RateLimitedError);
    expect(callsTo(URL_A)).toHaveLength(3);
  });

  it('o Retry-After também atrasa outras requisições ao mesmo host', async () => {
    const other = 'https://empresa.com/outra';
    const { client, clock } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: [
        textResponse('', { status: 429, headers: { 'retry-after': '5' } }),
        textResponse('ok'),
      ],
      [other]: textResponse('outra'),
    });
    await client.getText(URL_A);
    clock.sleeps.length = 0;
    await client.getText(other); // 5s já foram aguardados; nada a esperar de novo
    expect(clock.sleeps).toEqual([]);
  });
});

describe('HttpClient — rate limit por host', () => {
  it('espaça requisições ao mesmo host, mas não a hosts diferentes', async () => {
    const { client, clock } = setup(
      {
        [ROBOTS_A]: noRobots,
        'https://empresa.com/a': textResponse('a'),
        'https://empresa.com/b': textResponse('b'),
        'https://outra.com/robots.txt': noRobots,
        'https://outra.com/c': textResponse('c'),
      },
      { minIntervalMs: 2000 },
    );
    await client.getText('https://empresa.com/a'); // inclui o robots.txt (1ª ao host)
    clock.sleeps.length = 0;

    await client.getText('https://empresa.com/b');
    expect(clock.sleeps).toEqual([2000]);

    clock.sleeps.length = 0;
    // Host novo: só o intervalo entre o robots.txt e a página dele; nada herdado de empresa.com.
    await client.getText('https://outra.com/c');
    expect(clock.sleeps).toEqual([2000]);
  });
});

describe('HttpClient — robots.txt', () => {
  it('não acessa caminho bloqueado e não chega a fazer a requisição', async () => {
    const { client, callsTo } = setup({
      [ROBOTS_A]: textResponse('User-agent: *\nDisallow: /vagas'),
      [URL_A]: textResponse('não deveria ser pedido'),
    });
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(callsTo(URL_A)).toHaveLength(0);
  });

  it('busca o robots.txt só uma vez por origem', async () => {
    const { client, callsTo } = setup({
      [ROBOTS_A]: textResponse('User-agent: *\nDisallow: /privado'),
      [URL_A]: textResponse('ok'),
      'https://empresa.com/outra': textResponse('ok2'),
    });
    await client.getText(URL_A);
    await client.getText('https://empresa.com/outra');
    expect(callsTo(ROBOTS_A)).toHaveLength(1);
  });

  it('robots.txt indisponível (500) bloqueia por precaução', async () => {
    const { client, callsTo } = setup(
      { [ROBOTS_A]: textResponse('', { status: 500 }), [URL_A]: textResponse('ok') },
      { maxRetries: 0 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(callsTo(URL_A)).toHaveLength(0);
  });

  it('respectRobots=false (global ou por requisição) dispensa a verificação', async () => {
    const globalOff = setup({ [URL_A]: textResponse('ok') }, { respectRobots: false });
    expect(await globalOff.client.getText(URL_A)).toBe('ok');
    expect(globalOff.callsTo(ROBOTS_A)).toHaveLength(0);

    const perRequest = setup({ [URL_A]: textResponse('ok') });
    expect(await perRequest.client.getText(URL_A, { respectRobots: false })).toBe('ok');
    expect(perRequest.callsTo(ROBOTS_A)).toHaveLength(0);
  });

  it('aplica o Crawl-delay como intervalo do host', async () => {
    const { client, clock } = setup({
      [ROBOTS_A]: textResponse('User-agent: *\nCrawl-delay: 4'),
      'https://empresa.com/a': textResponse('a'),
      'https://empresa.com/b': textResponse('b'),
    });
    await client.getText('https://empresa.com/a');
    clock.sleeps.length = 0;
    await client.getText('https://empresa.com/b');
    expect(clock.sleeps).toEqual([4000]);
  });

  it('Crawl-delay acima do limite aceito bloqueia', async () => {
    const { client } = setup(
      {
        [ROBOTS_A]: textResponse('User-agent: *\nCrawl-delay: 120'),
        [URL_A]: textResponse('ok'),
      },
      { maxCrawlDelayMs: 30_000 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(RobotsDisallowedError);
  });
});

describe('HttpClient — redirecionamentos', () => {
  it('segue o redirecionamento e devolve a URL final', async () => {
    const final = 'https://empresa.com/novo';
    const { client } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: textResponse('', { status: 301, headers: { location: '/novo' } }),
      [final]: textResponse('destino'),
    });
    const response = await client.request(URL_A);
    expect(response.text).toBe('destino');
    expect(response.url).toBe(final);
  });

  it('verifica o robots.txt do host de destino', async () => {
    const destino = 'https://outra.com/vaga';
    const { client, callsTo } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: textResponse('', { status: 302, headers: { location: destino } }),
      'https://outra.com/robots.txt': textResponse('User-agent: *\nDisallow: /'),
      [destino]: textResponse('não deveria ser pedido'),
    });
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(callsTo(destino)).toHaveLength(0);
  });

  it('recusa redirecionamento para http', async () => {
    const { client } = setup({
      [ROBOTS_A]: noRobots,
      [URL_A]: textResponse('', { status: 301, headers: { location: 'http://empresa.com/x' } }),
    });
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(InvalidUrlError);
  });

  it('limita o número de redirecionamentos', async () => {
    const { client } = setup(
      {
        [ROBOTS_A]: noRobots,
        [URL_A]: textResponse('', { status: 302, headers: { location: URL_A } }),
      },
      { maxRedirects: 2 },
    );
    await expect(client.getText(URL_A)).rejects.toBeInstanceOf(TooManyRedirectsError);
  });
});
