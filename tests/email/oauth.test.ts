import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GMAIL_SEND_SCOPE,
  OAuthError,
  TokenProvider,
  TokenStore,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  handleCallback,
  loadOAuthClient,
  revokeAndDelete,
  startLogin,
  type FetchFn,
  type OAuthClient,
} from '../../src/email/index.js';

const client: OAuthClient = {
  clientId: 'cliente-ficticio.apps.googleusercontent.com',
  clientSecret: 'segredo-ficticio',
};
let dir: string;
let store: TokenStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  store = new TokenStore(join(dir, 'sub', 'token.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  body: URLSearchParams;
}
function fakeFetch(responder: (call: Call) => Response): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = (input, init) => {
    const call = { url: input, body: new URLSearchParams((init?.body ?? '') as string) };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return { fetchFn, calls };
}

describe('PKCE e URL de autorização', () => {
  it('o challenge é o SHA-256 (base64url) do verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(createPkce().verifier).not.toBe(verifier);
  });

  it('pede só o escopo gmail.send, com PKCE S256, state, loopback e acesso offline', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: client.clientId,
        redirectUri: 'http://127.0.0.1:5555/callback',
        state: 'abc',
        challenge: 'xyz',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GMAIL_SEND_SCOPE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('xyz');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('client_id')).toBe(client.clientId);
    expect(url.search).not.toMatch(/readonly|modify|compose|mail\.google\.com/);
  });
});

describe('loadOAuthClient', () => {
  it('lê o JSON de app para computador e recusa outros formatos', () => {
    const ok = join(dir, 'client.json');
    writeFileSync(ok, JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }));
    expect(loadOAuthClient(ok)).toEqual({ clientId: 'id', clientSecret: 's' });
    const web = join(dir, 'web.json');
    writeFileSync(web, JSON.stringify({ web: { client_id: 'id' } }));
    expect(() => loadOAuthClient(web)).toThrow(/App para computador/);
    expect(() => loadOAuthClient(join(dir, 'nao-existe.json'))).toThrow(/não encontrado/);
    writeFileSync(join(dir, 'ruim.json'), '{');
    expect(() => loadOAuthClient(join(dir, 'ruim.json'))).toThrow(/JSON válido/);
  });
});

describe('TokenStore', () => {
  const token = {
    refresh_token: 'refresh-ficticio',
    access_token: 'acesso-ficticio',
    expires_at: 1,
    scope: GMAIL_SEND_SCOPE,
  };

  it('grava com permissão 0600 em pasta 0700 e lê de volta', () => {
    store.write(token);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'sub')).mode & 0o777).toBe(0o700);
    expect(store.read()).toEqual(token);
    expect(store.exists()).toBe(true);
  });

  it('recusa usar um arquivo legível por outros usuários', () => {
    store.write(token);
    chmodSync(store.path, 0o644);
    expect(() => store.read()).toThrow(/permissão 644/);
  });

  it('arquivo corrompido ou ausente', () => {
    expect(store.read()).toBeUndefined();
    store.write(token);
    writeFileSync(store.path, '{"x":1}', { mode: 0o600 });
    expect(() => store.read()).toThrow(/corrompido/);
  });

  it('delete apaga o arquivo', () => {
    store.write(token);
    store.delete();
    expect(store.exists()).toBe(false);
  });
});

describe('exchangeCode', () => {
  const run = (response: Response) => {
    const { fetchFn, calls } = fakeFetch(() => response);
    return {
      promise: exchangeCode(
        fetchFn,
        client,
        { code: 'cod', verifier: 'ver', redirectUri: 'http://127.0.0.1:1/callback' },
        new Date('2026-10-22T12:00:00Z'),
      ),
      calls,
    };
  };

  it('troca o código (com o verifier PKCE) e devolve o token com a expiração', async () => {
    const { promise, calls } = run(
      json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: GMAIL_SEND_SCOPE }),
    );
    expect(await promise).toEqual({
      refresh_token: 'r',
      access_token: 'a',
      expires_at: Date.parse('2026-10-22T13:00:00Z'),
      scope: GMAIL_SEND_SCOPE,
    });
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]?.body.get('code_verifier')).toBe('ver');
    expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
  });

  it('recusa escopos além de gmail.send (e revoga nada: nem chega a salvar)', async () => {
    await expect(
      run(
        json({
          access_token: 'a',
          refresh_token: 'r',
          scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.readonly`,
        }),
      ).promise,
    ).rejects.toThrow(/escopos diferentes/);
    await expect(
      run(
        json({
          access_token: 'a',
          refresh_token: 'r',
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        }),
      ).promise,
    ).rejects.toThrow(OAuthError);
    await expect(run(json({ access_token: 'a', refresh_token: 'r' })).promise).rejects.toThrow(
      /escopos diferentes/,
    );
  });

  it('sem refresh token ou com erro HTTP', async () => {
    await expect(run(json({ access_token: 'a', scope: GMAIL_SEND_SCOPE })).promise).rejects.toThrow(
      /sem refresh token/,
    );
    await expect(run(json({ error: 'invalid_grant' }, 400)).promise).rejects.toThrow(
      /recusou o código \(HTTP 400\)/,
    );
  });

  it('erros nunca incluem o código, o verifier ou tokens', async () => {
    const error = (await run(
      json({ error: 'invalid_grant', access_token: 'SEGREDO' }, 400),
    ).promise.catch((e: unknown) => e)) as Error;
    expect(error.message).not.toMatch(/SEGREDO|cod\b|ver\b/);
  });
});

describe('TokenProvider', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const valid = { refresh_token: 'r', scope: GMAIL_SEND_SCOPE };

  it('usa o access token válido sem chamar a rede', async () => {
    store.write({ ...valid, access_token: 'ainda-valido', expires_at: now.getTime() + 600_000 });
    const { fetchFn, calls } = fakeFetch(() => json({}));
    expect(await new TokenProvider(store, client, fetchFn, () => now).getAccessToken()).toBe(
      'ainda-valido',
    );
    expect(calls).toEqual([]);
  });

  it('renova o vencido com o refresh token e persiste (0600)', async () => {
    store.write({ ...valid, access_token: 'velho', expires_at: now.getTime() - 1 });
    const { fetchFn, calls } = fakeFetch(() => json({ access_token: 'novo', expires_in: 3600 }));
    expect(await new TokenProvider(store, client, fetchFn, () => now).getAccessToken()).toBe(
      'novo',
    );
    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
    expect(store.read()).toMatchObject({ access_token: 'novo', refresh_token: 'r' });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it('refresh token revogado/expirado pede novo login; sem login pede login', async () => {
    store.write({ ...valid, access_token: 'velho', expires_at: 0 });
    const { fetchFn } = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(
      new TokenProvider(store, client, fetchFn, () => now).getAccessToken(),
    ).rejects.toMatchObject({ code: 'reautenticar' });
    store.delete();
    await expect(
      new TokenProvider(store, client, fetchFn, () => now).getAccessToken(),
    ).rejects.toMatchObject({ code: 'token_ausente' });
  });

  it('recusa um token salvo com escopo diferente do mínimo', async () => {
    store.write({
      refresh_token: 'r',
      access_token: 'a',
      expires_at: now.getTime() + 600_000,
      scope: 'https://mail.google.com/',
    });
    const { fetchFn } = fakeFetch(() => json({}));
    await expect(
      new TokenProvider(store, client, fetchFn, () => now).getAccessToken(),
    ).rejects.toMatchObject({ code: 'escopo' });
  });
});

describe('logout', () => {
  it('revoga no Google e apaga o arquivo; sem rede, apaga mesmo assim', async () => {
    store.write({ refresh_token: 'r', scope: GMAIL_SEND_SCOPE });
    const { fetchFn, calls } = fakeFetch(() => json({}));
    expect(await revokeAndDelete(fetchFn, store)).toBe('revogado');
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(store.exists()).toBe(false);

    store.write({ refresh_token: 'r', scope: GMAIL_SEND_SCOPE });
    expect(await revokeAndDelete(() => Promise.reject(new Error('sem rede')), store)).toBe(
      'apenas_local',
    );
    expect(store.exists()).toBe(false);
  });
});

describe('callback do login (loopback)', () => {
  const context = (fetchFn: FetchFn) => ({
    expectedState: 'estado-certo',
    verifier: 'ver',
    redirectUri: 'http://127.0.0.1:1/callback',
    client,
    fetchFn,
    store,
  });
  const ok = () =>
    fakeFetch(() =>
      json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: GMAIL_SEND_SCOPE }),
    );

  it('state errado cancela o login sem trocar nada nem salvar token (CSRF)', async () => {
    const { fetchFn, calls } = ok();
    await expect(
      handleCallback(new URL('http://127.0.0.1:1/callback?state=outro&code=x'), context(fetchFn)),
    ).rejects.toThrow(/state inválido/);
    expect(calls).toEqual([]);
    expect(store.exists()).toBe(false);
  });

  it('erro do Google e ausência de código', async () => {
    const { fetchFn } = ok();
    await expect(
      handleCallback(
        new URL('http://127.0.0.1:1/callback?state=estado-certo&error=access_denied'),
        context(fetchFn),
      ),
    ).rejects.toThrow(/access_denied/);
    await expect(
      handleCallback(new URL('http://127.0.0.1:1/callback?state=estado-certo'), context(fetchFn)),
    ).rejects.toThrow(/não trouxe o código/);
  });

  it('com state e código corretos, salva o token com 0600', async () => {
    const { fetchFn } = ok();
    await handleCallback(
      new URL('http://127.0.0.1:1/callback?state=estado-certo&code=cod'),
      context(fetchFn),
    );
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.path, 'utf8')).toContain('"refresh_token":"r"');
  });

  it('servidor loopback real (127.0.0.1): fluxo completo com Google simulado', async () => {
    const { fetchFn, calls } = ok();
    const flow = await startLogin({ client, store, fetchFn, timeoutMs: 10_000 });
    const auth = new URL(flow.authUrl);
    const redirect = new URL(auth.searchParams.get('redirect_uri') ?? '');
    expect(redirect.hostname).toBe('127.0.0.1');

    const response = await fetch(
      `${redirect.origin}/callback?state=${auth.searchParams.get('state')}&code=codigo-ficticio`,
    );
    expect(response.status).toBe(200);
    await flow.completed;
    expect(store.read()?.scope).toBe(GMAIL_SEND_SCOPE);
    // o verifier enviado na troca corresponde ao challenge da URL
    const verifier = calls[0]?.body.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    );
  });

  it('servidor loopback: state errado responde 400 e o login falha', async () => {
    const { fetchFn } = ok();
    const flow = await startLogin({ client, store, fetchFn, timeoutMs: 10_000 });
    const redirect = new URL(new URL(flow.authUrl).searchParams.get('redirect_uri') ?? '');
    const failure = flow.completed.catch((e: unknown) => e);
    const response = await fetch(`${redirect.origin}/callback?state=errado&code=x`);
    expect(response.status).toBe(400);
    expect(await failure).toBeInstanceOf(OAuthError);
    expect(store.exists()).toBe(false);
  });
});
