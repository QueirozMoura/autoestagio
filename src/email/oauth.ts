import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * OAuth 2.0 para app de computador (Google): redirecionamento loopback + PKCE (S256). Sem senha do
 * Gmail e sem automação de navegador. Só o escopo gmail.send (enviar; não lê nem apaga nada).
 * Documentação: https://developers.google.com/identity/protocols/oauth2/native-app
 */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class OAuthError extends Error {
  constructor(
    readonly code:
      | 'cliente_invalido'
      | 'permissao'
      | 'estado'
      | 'troca'
      | 'token_ausente'
      | 'reautenticar'
      | 'rede'
      | 'escopo',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

// ------------------------------------------------------------------ cliente

const clientFileSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1).optional(),
  }),
});

export interface OAuthClient {
  clientId: string;
  /** Em app de computador o "secret" não é confidencial; vai no arquivo baixado do Google. */
  clientSecret: string | undefined;
}

/** Lê o JSON baixado do Google Cloud Console (tipo "App para computador"). */
export function loadOAuthClient(path: string): OAuthClient {
  if (!existsSync(path)) {
    throw new OAuthError(
      'cliente_invalido',
      'arquivo de credencial OAuth não encontrado (veja docs/EMAIL.md)',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new OAuthError('cliente_invalido', 'o arquivo de credencial OAuth não é um JSON válido');
  }
  const parsed = clientFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OAuthError(
      'cliente_invalido',
      'a credencial precisa ser do tipo "App para computador" (chave "installed")',
    );
  }
  return {
    clientId: parsed.data.installed.client_id,
    clientSecret: parsed.data.installed.client_secret,
  };
}

// ------------------------------------------------------------------ armazenamento do token

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  /** Epoch em ms em que o access_token expira. */
  expires_at?: number;
  scope: string;
}

const tokenSchema = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().min(1).exactOptional(),
  expires_at: z.number().exactOptional(),
  scope: z.string().min(1),
});

/**
 * Token em arquivo local com permissão 0600 (pasta 0700), fora do Git. Um arquivo legível por
 * outros usuários é recusado. O conteúdo nunca é exibido nem registrado.
 */
export class TokenStore {
  constructor(readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): StoredToken | undefined {
    if (!existsSync(this.path)) return undefined;
    const mode = statSync(this.path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new OAuthError(
        'permissao',
        `o arquivo de token está com permissão ${mode.toString(8)}; restrinja com "chmod 600" ou refaça o login`,
      );
    }
    const parsed = tokenSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
    if (!parsed.success)
      throw new OAuthError('token_ausente', 'o arquivo de token está corrompido; refaça o login');
    return parsed.data;
  }

  write(token: StoredToken): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(token), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }

  delete(): void {
    rmSync(this.path, { force: true });
  }
}

// ------------------------------------------------------------------ PKCE e troca de código

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function buildAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GMAIL_SEND_SCOPE,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.href;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

async function postForm(
  fetchFn: FetchFn,
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new OAuthError('rede', 'falha de rede ao falar com o Google');
  }
}

/** O token só pode ter o escopo mínimo. Qualquer escopo a mais é recusado. */
function assertMinimalScope(scope: string | undefined): string {
  const granted = (scope ?? '').split(/\s+/).filter(Boolean);
  if (!granted.includes(GMAIL_SEND_SCOPE) || granted.some((item) => item !== GMAIL_SEND_SCOPE)) {
    throw new OAuthError(
      'escopo',
      'o Google concedeu escopos diferentes de gmail.send; por segurança o token foi recusado',
    );
  }
  return GMAIL_SEND_SCOPE;
}

export async function exchangeCode(
  fetchFn: FetchFn,
  client: OAuthClient,
  options: { code: string; verifier: string; redirectUri: string },
  now: Date = new Date(),
): Promise<StoredToken> {
  const response = await postForm(fetchFn, TOKEN_ENDPOINT, {
    client_id: client.clientId,
    ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
    code: options.code,
    code_verifier: options.verifier,
    grant_type: 'authorization_code',
    redirect_uri: options.redirectUri,
  });
  if (!response.ok)
    throw new OAuthError('troca', `o Google recusou o código (HTTP ${response.status})`);
  const parsed = tokenResponse.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success || parsed.data.refresh_token === undefined) {
    throw new OAuthError('troca', 'resposta do Google sem refresh token; refaça o login');
  }
  return {
    refresh_token: parsed.data.refresh_token,
    access_token: parsed.data.access_token,
    ...(parsed.data.expires_in === undefined
      ? {}
      : { expires_at: now.getTime() + parsed.data.expires_in * 1000 }),
    scope: assertMinimalScope(parsed.data.scope),
  };
}

/** Access token válido (renova com o refresh token e persiste). Nunca registra o conteúdo. */
export class TokenProvider {
  constructor(
    private readonly store: TokenStore,
    private readonly client: OAuthClient,
    private readonly fetchFn: FetchFn,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAccessToken(): Promise<string> {
    const token = this.store.read();
    if (token === undefined)
      throw new OAuthError('token_ausente', 'não há login do Gmail; rode "email auth login"');
    assertMinimalScope(token.scope);
    if (
      token.access_token !== undefined &&
      (token.expires_at ?? 0) - this.now().getTime() > 60_000
    ) {
      return token.access_token;
    }
    const response = await postForm(this.fetchFn, TOKEN_ENDPOINT, {
      client_id: this.client.clientId,
      ...(this.client.clientSecret === undefined
        ? {}
        : { client_secret: this.client.clientSecret }),
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    });
    if (!response.ok) {
      throw new OAuthError(
        response.status === 400 || response.status === 401 ? 'reautenticar' : 'rede',
        'não foi possível renovar o acesso ao Gmail; rode "email auth login" de novo',
      );
    }
    const parsed = tokenResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success)
      throw new OAuthError('troca', 'resposta inválida do Google ao renovar o acesso');
    const next: StoredToken = {
      refresh_token: parsed.data.refresh_token ?? token.refresh_token,
      access_token: parsed.data.access_token,
      ...(parsed.data.expires_in === undefined
        ? {}
        : { expires_at: this.now().getTime() + parsed.data.expires_in * 1000 }),
      scope: assertMinimalScope(parsed.data.scope ?? token.scope),
    };
    this.store.write(next);
    return next.access_token ?? '';
  }
}

/** Revoga o token no Google e apaga o arquivo local. */
export async function revokeAndDelete(
  fetchFn: FetchFn,
  store: TokenStore,
): Promise<'revogado' | 'apenas_local'> {
  const token = store.read();
  if (token === undefined) return 'apenas_local';
  let revoked: boolean;
  try {
    revoked = (await postForm(fetchFn, REVOKE_ENDPOINT, { token: token.refresh_token })).ok;
  } catch {
    revoked = false;
  }
  store.delete();
  return revoked ? 'revogado' : 'apenas_local';
}

// ------------------------------------------------------------------ login (loopback)

export interface LoginFlow {
  authUrl: string;
  /** Resolve quando o Google redireciona de volta e o token foi salvo. */
  completed: Promise<void>;
  close: () => void;
}

/** Trata a volta do navegador: confere o `state`, troca o código e guarda o token. */
export async function handleCallback(
  callbackUrl: URL,
  context: {
    expectedState: string;
    verifier: string;
    redirectUri: string;
    client: OAuthClient;
    fetchFn: FetchFn;
    store: TokenStore;
    now?: Date;
  },
): Promise<void> {
  if (callbackUrl.searchParams.get('state') !== context.expectedState) {
    throw new OAuthError('estado', 'parâmetro state inválido; login cancelado');
  }
  const error = callbackUrl.searchParams.get('error');
  if (error !== null)
    throw new OAuthError('troca', `o Google devolveu o erro "${error.slice(0, 40)}"`);
  const code = callbackUrl.searchParams.get('code');
  if (code === null) throw new OAuthError('troca', 'a resposta do Google não trouxe o código');
  const token = await exchangeCode(
    context.fetchFn,
    context.client,
    { code, verifier: context.verifier, redirectUri: context.redirectUri },
    context.now,
  );
  context.store.write(token);
}

/** Sobe um servidor só em 127.0.0.1, em porta aleatória, para receber o redirecionamento do Google. */
export async function startLogin(options: {
  client: OAuthClient;
  store: TokenStore;
  fetchFn: FetchFn;
  timeoutMs?: number;
}): Promise<LoginFlow> {
  const { verifier, challenge } = createPkce();
  const state = randomBytes(24).toString('base64url');
  let server: Server | undefined;
  let finish: (error?: Error) => void = () => undefined;
  const completed = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (error === undefined) resolve();
      else reject(error);
    };
  });

  const port = await new Promise<number>((resolve, reject) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const redirectUri = `http://127.0.0.1:${(server?.address() as { port: number }).port}/callback`;
      handleCallback(url, {
        expectedState: state,
        verifier,
        redirectUri,
        client: options.client,
        fetchFn: options.fetchFn,
        store: options.store,
      })
        .then(() => {
          response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end('<p>Login concluído. Pode fechar esta aba e voltar ao terminal.</p>');
          finish();
        })
        .catch((error: unknown) => {
          response
            .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
            .end('<p>Login não concluído. Veja o terminal.</p>');
          finish(error instanceof Error ? error : new Error('login falhou'));
        });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server?.address() as { port: number }).port);
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => {
    finish(new OAuthError('estado', 'tempo esgotado esperando o login'));
  }, options.timeoutMs ?? 300_000);
  const close = (): void => {
    clearTimeout(timer);
    server?.close();
  };
  void completed.then(close, close);
  return {
    authUrl: buildAuthUrl({ clientId: options.client.clientId, redirectUri, state, challenge }),
    completed,
    close,
  };
}
