import type { Db } from '../db/index.js';
import { candidateEmail } from './email-connector.js';

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
  /** Descrição da vaga: permite reconhecer, sem gravar nada, um e-mail de candidatura utilizável. */
  description?: string | null;
}

export interface Availability {
  available: boolean;
  reason: string;
}

export interface Connector {
  id: string;
  /** automatico = o agente conclui sozinho; assistido = exige você (login, CAPTCHA, avaliação ou decisão). */
  flow: 'automatico' | 'assistido';
  /** Barreiras técnicas verificadas (ex.: "recaptcha-enterprise", "login"). */
  barriers: readonly string[];
  availability(db: Db, job: ConnectorJob): Availability;
  /** Ausente = o conector ainda não envia. O orquestrador trata como "pendente de canal". */
  send?: undefined;
}

/**
 * Plataformas de candidatura, verificadas separadamente em 2026-10-24 (páginas reais, somente leitura):
 *  - Greenhouse: API pública só LISTA vagas; enviar por API exige chave da empresa; o formulário usa reCAPTCHA Enterprise.
 *  - Lever: idem (chave da empresa); o formulário usa hCaptcha.
 *  - Ashby: API pública só lista; o formulário usa reCAPTCHA Enterprise.
 *  - Inhire: sem login; reCAPTCHA Enterprise invisível (passa em navegador real, sob a sua autorização por vaga).
 *  - Gupy: exige conta de candidato (e-mail/CPF e senha, Google ou LinkedIn); termos de automação não verificados.
 * Nada disso é contornado: o agente prepara tudo e a candidatura segue o fluxo ASSISTIDO, no seu navegador.
 */
interface PortalRule {
  id: string;
  host: RegExp;
  barriers: readonly string[];
  reason: string;
}

const PORTALS: readonly PortalRule[] = [
  {
    id: 'portal-inhire',
    host: /(^|\.)inhire\.app$/,
    barriers: ['recaptcha-enterprise'],
    reason:
      'Inhire: formulário sem login, com reCAPTCHA Enterprise invisível; envio no seu navegador, sob autorização',
  },
  {
    id: 'portal-gupy',
    host: /(^|\.)gupy\.io$/,
    barriers: ['login'],
    reason:
      'Gupy: exige a sua conta de candidato (login); candidatura no seu navegador, já autenticado por você',
  },
  {
    id: 'portal-greenhouse',
    host: /(^|\.)greenhouse\.io$/,
    barriers: ['recaptcha-enterprise', 'api-key-da-empresa'],
    reason: 'Greenhouse: reCAPTCHA Enterprise no formulário; a API de envio exige chave da empresa',
  },
  {
    id: 'portal-lever',
    host: /(^|\.)lever\.co$/,
    barriers: ['hcaptcha', 'api-key-da-empresa'],
    reason: 'Lever: hCaptcha no formulário; a API de envio exige chave da empresa',
  },
  {
    id: 'portal-ashby',
    host: /(^|\.)ashbyhq\.com$/,
    barriers: ['recaptcha-enterprise'],
    reason: 'Ashby: reCAPTCHA Enterprise no formulário',
  },
];

const portal = (rule: PortalRule): Connector => ({
  id: rule.id,
  flow: 'assistido',
  barriers: rule.barriers,
  availability: () => ({ available: false, reason: rule.reason }),
});

const unknownPortal: Connector = {
  id: 'portal-desconhecido',
  flow: 'assistido',
  barriers: [],
  availability: () => ({
    available: false,
    reason: 'portal sem conector: candidatura assistida (barreiras não verificadas)',
  }),
};

/** Canal de e-mail: só existe se a vaga tem destinatário verificado (nunca deduzido). */
const email: Connector = {
  id: 'email',
  flow: 'automatico',
  barriers: [],
  availability(db, job) {
    const row = db
      .prepare(
        `SELECT 1 FROM verified_recipients
          WHERE job_id = ? AND (freemail = 0 OR freemail_confirmed = 1) LIMIT 1`,
      )
      .get(job.id);
    if (row === undefined) {
      const found = candidateEmail(job.description ?? null);
      return found.ok
        ? {
            available: true,
            reason:
              'e-mail de candidatura escrito na vaga (será verificado antes do envio, com todas as travas do canal)',
          }
        : { available: false, reason: found.reason };
    }
    return {
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
