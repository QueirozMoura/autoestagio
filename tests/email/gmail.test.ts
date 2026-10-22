import { describe, expect, it } from 'vitest';
import { GmailTransport, OAuthError, type FetchFn } from '../../src/email/index.js';
import { REJECTED_STATUS } from '../../src/email/gmail.js';

const tokens = { getAccessToken: () => Promise.resolve('token-ficticio') };

function transport(responder: () => Response | Promise<Response> | Error, token = tokens) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    calls.push({ url: input, init });
    const result = responder();
    if (result instanceof Error) throw result;
    return result;
  };
  return { gmail: new GmailTransport(token, fetchFn, 1000), calls };
}
const body = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });

describe('GmailTransport — o que é "aceito", "recusado" e "desconhecido"', () => {
  it('200 com id: aceito, com thread e labels', async () => {
    const { gmail } = transport(() => body({ id: 'msg-1', threadId: 'th-1', labelIds: ['SENT'] }));
    expect(await gmail.send('cmF3')).toEqual({
      kind: 'accepted',
      messageId: 'msg-1',
      threadId: 'th-1',
      labelIds: ['SENT'],
    });
  });

  it('faz um único POST em users.messages.send com Bearer e {raw}, sem seguir redirecionamentos', async () => {
    const { gmail, calls } = transport(() => body({ id: 'm' }));
    await gmail.send('cmF3');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ raw: 'cmF3' });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer token-ficticio',
    );
  });

  it.each([400, 401, 403, 413])('HTTP %i: recusado antes de enviar', async (status) => {
    const { gmail } = transport(() => body({ error: 'x' }, status));
    expect(await gmail.send('x')).toEqual({ kind: 'rejected', category: `http_${status}` });
  });

  it.each([404, 408, 422, 429, 500, 502, 503, 504, 307])(
    'HTTP %i: resultado DESCONHECIDO (pode ter saído)',
    async (status) => {
      const { gmail } = transport(() => body({}, status));
      expect(await gmail.send('x')).toEqual({ kind: 'unknown', category: `http_${status}` });
    },
  );

  it('200 com resposta ilegível ou sem id: desconhecido (o Gmail pode ter enviado)', async () => {
    expect((await transport(() => new Response('<html>')).gmail.send('x')).kind).toBe('unknown');
    expect((await transport(() => body({ semId: true })).gmail.send('x')).kind).toBe('unknown');
  });

  it('rede/timeout: desconhecido, e nunca tenta de novo', async () => {
    const { gmail, calls } = transport(() => new Error('ECONNRESET'));
    expect(await gmail.send('x')).toEqual({ kind: 'unknown', category: 'rede_ou_timeout' });
    expect(calls).toHaveLength(1);
  });

  it('falha ao obter o token: recusado, e a API de envio nem é chamada', async () => {
    const { gmail, calls } = transport(() => body({ id: 'm' }), {
      getAccessToken: () => Promise.reject(new OAuthError('reautenticar', 'x')),
    });
    expect(await gmail.send('x')).toEqual({ kind: 'rejected', category: 'oauth_reautenticar' });
    expect(calls).toEqual([]);
  });

  it('o resultado nunca carrega o token, o corpo da resposta nem a mensagem', async () => {
    const { gmail } = transport(() =>
      body({ error: { message: 'token-ficticio rejeitado' } }, 401),
    );
    expect(JSON.stringify(await gmail.send('mensagem-secreta'))).not.toMatch(
      /token-ficticio|mensagem-secreta/,
    );
  });

  it('varredura de TODOS os códigos 100–599: só 400/401/403/413 são "recusado"; 200 com id é aceito; o resto é desconhecido', async () => {
    expect([...REJECTED_STATUS].sort()).toEqual([400, 401, 403, 413]);
    for (let status = 200; status <= 599; status++) {
      if (status === 204 || status === 205 || status === 304) continue; // sem corpo: o construtor de Response não aceita
      const { gmail } = transport(
        () =>
          new Response(status >= 200 && status < 300 ? JSON.stringify({ id: 'm' }) : '{}', {
            status,
          }),
      );
      const outcome = await gmail.send('x');
      const expected =
        status >= 200 && status < 300
          ? 'accepted'
          : REJECTED_STATUS.has(status)
            ? 'rejected'
            : 'unknown';
      expect(outcome.kind, `HTTP ${status}`).toBe(expected);
    }
  });

  it('2xx sem corpo útil (204, JSON sem id, texto) nunca é "recusado": é desconhecido', async () => {
    for (const make of [
      () => new Response(null, { status: 204 }),
      () => new Response('{}', { status: 200 }),
      () => new Response('ok', { status: 202 }),
    ]) {
      expect((await transport(make).gmail.send('x')).kind).toBe('unknown');
    }
  });

  it('nenhum caminho do transporte repete a chamada (sempre exatamente uma requisição)', async () => {
    for (const status of [200, 400, 429, 500, 503]) {
      const { gmail, calls } = transport(() => body({ id: 'm' }, status));
      await gmail.send('x');
      expect(calls, `HTTP ${status}`).toHaveLength(1);
    }
    const { gmail, calls } = transport(() => new Error('reset'));
    await gmail.send('x');
    expect(calls).toHaveLength(1);
  });
});
