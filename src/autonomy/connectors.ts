import type { Db } from '../db/index.js';

/**
 * Conectores de envio. Cada um diz se PODE enviar a candidatura de uma vaga e por quê. Nenhum conector deste arquivo
 * envia nada: o envio real é uma etapa à parte e só existe para conectores que implementarem `send` (hoje nenhum).
 * Portais com reCAPTCHA, login ou chave de API da empresa ficam como "indisponíveis" de propósito: não se contorna
 * CAPTCHA, anti-bot, login nem termos das plataformas.
 */
export interface ConnectorJob {
  id: number;
  url: string;
  applyUrl: string | null;
}

export interface Availability {
  available: boolean;
  reason: string;
}

export interface Connector {
  id: string;
  availability(db: Db, job: ConnectorJob): Availability;
  /** Ausente = o conector ainda não envia. O orquestrador trata como "pendente de canal". */
  send?: undefined;
}

interface PortalRule {
  id: string;
  host: RegExp;
  reason: string;
}

const PORTALS: readonly PortalRule[] = [
  {
    id: 'portal-inhire',
    host: /(^|\.)inhire\.app$/,
    reason: 'formulário Inhire com reCAPTCHA Enterprise: não é automatizado (sem burlar anti-bot)',
  },
  {
    id: 'portal-gupy',
    host: /(^|\.)gupy\.io$/,
    reason: 'Gupy exige conta e login do candidato: não é automatizado',
  },
  {
    id: 'portal-greenhouse',
    host: /(^|\.)greenhouse\.io$/,
    reason: 'a candidatura por API do Greenhouse exige chave da empresa; o formulário tem anti-bot',
  },
  {
    id: 'portal-lever',
    host: /(^|\.)lever\.co$/,
    reason: 'a candidatura por API do Lever exige chave da empresa; o formulário tem anti-bot',
  },
  {
    id: 'portal-ashby',
    host: /(^|\.)ashbyhq\.com$/,
    reason: 'o formulário do Ashby tem verificação anti-bot: não é automatizado',
  },
];

const portal = (rule: PortalRule): Connector => ({
  id: rule.id,
  availability: () => ({ available: false, reason: rule.reason }),
});

const unknownPortal: Connector = {
  id: 'portal-desconhecido',
  availability: () => ({
    available: false,
    reason: 'portal sem conector: candidatura manual',
  }),
};

/** Canal de e-mail: só existe se a vaga tem destinatário verificado (nunca deduzido). */
const email: Connector = {
  id: 'email',
  availability(db, job) {
    const row = db
      .prepare(
        `SELECT 1 FROM verified_recipients
          WHERE job_id = ? AND (freemail = 0 OR freemail_confirmed = 1) LIMIT 1`,
      )
      .get(job.id);
    return row === undefined
      ? { available: false, reason: 'sem destinatário de e-mail verificado para esta vaga' }
      : {
          available: true,
          reason:
            'destinatário verificado; o envio segue as travas do canal de e-mail (autorização e trava mestra)',
        };
  },
};

export function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Escolhe o conector da vaga: e-mail verificado primeiro; senão o portal do link de candidatura. */
export function resolveConnector(
  db: Db,
  job: ConnectorJob,
): { connector: Connector } & Availability {
  const byEmail = email.availability(db, job);
  if (byEmail.available) return { connector: email, ...byEmail };
  const host = hostOf(job.applyUrl ?? job.url);
  const rule = host === null ? undefined : PORTALS.find((p) => p.host.test(host));
  const connector = rule === undefined ? unknownPortal : portal(rule);
  return { connector, ...connector.availability(db, job) };
}
