import { z } from 'zod';
import { OAuthError, type FetchFn, type TokenProvider } from './oauth.js';

const ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/**
 * Resultado de uma tentativa de envio, classificado de forma conservadora:
 *  - `accepted`: o Gmail aceitou e devolveu o id da mensagem.
 *  - `rejected`: o Gmail recusou ANTES de enviar (nada saiu). Pode-se tentar de novo, por uma pessoa.
 *  - `unknown`: não dá para saber se saiu (timeout, erro 5xx, resposta ilegível...). NUNCA reenviar.
 */
export type SendOutcome =
  | { kind: 'accepted'; messageId: string; threadId: string | undefined; labelIds: string[] }
  | { kind: 'rejected'; category: string }
  | { kind: 'unknown'; category: string };

export interface MailTransport {
  /** `raw` é a mensagem MIME em base64url. */
  send(raw: string): Promise<SendOutcome>;
}

/**
 * Únicas respostas HTTP tratadas como "recusado antes de enviar":
 *  - 400 pedido inválido, 401 sem autenticação válida, 403 sem permissão/cota, 413 mensagem grande
 *    demais. Em todas o Gmail rejeita o pedido ANTES de processar a mensagem.
 * Todo o resto é "desconhecido", inclusive 404, 408, 422, 429 e qualquer 5xx: nesses casos não há
 * garantia de que a mensagem não tenha saído, então a candidatura vai para uma pessoa conferir.
 * Mesmo no caso "recusado" nada é reenviado automaticamente: só uma pessoa refaz o preparo.
 */
export const REJECTED_STATUS: ReadonlySet<number> = new Set([400, 401, 403, 413]);

const sendResponse = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

/**
 * Transporte real: POST users.messages.send (escopo gmail.send). Sem retentativa automática (um
 * reenvio poderia duplicar a candidatura) e sem registrar token, corpo ou destinatário.
 */
export class GmailTransport implements MailTransport {
  constructor(
    private readonly tokens: Pick<TokenProvider, 'getAccessToken'>,
    private readonly fetchFn: FetchFn,
    private readonly timeoutMs = 30_000,
  ) {}

  async send(raw: string): Promise<SendOutcome> {
    let accessToken: string;
    try {
      accessToken = await this.tokens.getAccessToken();
    } catch (error) {
      // Falhou antes de chamar a API de envio: nada foi enviado.
      return {
        kind: 'rejected',
        category: error instanceof OAuthError ? `oauth_${error.code}` : 'oauth',
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ raw }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'unknown', category: 'rede_ou_timeout' };
    }

    if (response.ok) {
      const parsed = sendResponse.safeParse(await response.json().catch(() => undefined));
      return parsed.success
        ? {
            kind: 'accepted',
            messageId: parsed.data.id,
            threadId: parsed.data.threadId,
            labelIds: parsed.data.labelIds ?? [],
          }
        : { kind: 'unknown', category: 'resposta_ilegivel' };
    }
    return REJECTED_STATUS.has(response.status)
      ? { kind: 'rejected', category: `http_${response.status}` }
      : { kind: 'unknown', category: `http_${response.status}` };
  }
}
