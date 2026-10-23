import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { htmlToText } from '../discovery/text.js';
import type { HttpClient } from '../http/index.js';
import { isValidEmail } from './mime.js';

export class RecipientError extends Error {
  constructor(
    readonly code:
      'nao_encontrado_na_fonte' | 'dominio_invalido' | 'freemail' | 'invalido' | 'fonte_invalida',
    message: string,
  ) {
    super(message);
    this.name = 'RecipientError';
  }
}

const FREEMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.com.br',
  'icloud.com',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'ig.com.br',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'aol.com',
]);

/** Plataformas que hospedam páginas de MUITAS empresas: não provam que o endereço é da empresa. */
const NOT_A_COMPANY_DOMAIN = new Set([
  'ashbyhq.com',
  'greenhouse.io',
  'lever.co',
  'gupy.io',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'github.com',
  'github.io',
  'notion.site',
  'notion.so',
  'google.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'medium.com',
  'wordpress.com',
  'wixsite.com',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'onrender.com',
  'bit.ly',
]);

/** Sufixos públicos comuns: não são o domínio de uma empresa. */
const PUBLIC_SUFFIXES = new Set([
  'com.br',
  'org.br',
  'net.br',
  'gov.br',
  'edu.br',
  'co.uk',
  'com.au',
  'com.ar',
  'com.pt',
]);

const CANDIDATE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

/**
 * Endereços escritos literalmente no texto (ou em links mailto:). Endereços "disfarçados"
 * ("nome [arroba] empresa") não são reconstruídos: nada é deduzido.
 */
export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  const decoded = text.replace(/mailto:/gi, ' ');
  for (const match of decoded.matchAll(CANDIDATE)) {
    const email = match[0].toLowerCase().replace(/[.]+$/, '');
    if (isValidEmail(email)) found.add(email);
  }
  return [...found];
}

export const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf('@') + 1).toLowerCase();
export const isFreemail = (email: string): boolean => FREEMAIL.has(domainOf(email));

/**
 * Identidade normalizada do destinatário, para detectar o mesmo contato por escritas diferentes:
 * minúsculas, sem "+etiqueta" e, em Gmail, sem pontos no nome (googlemail.com = gmail.com).
 */
export function normalizeRecipient(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./gu, '');
  return `${local}@${domain}`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface VerifiedRecipient {
  id: number;
  jobId: number;
  email: string;
  sourceKind: 'vaga_oficial' | 'pagina_oficial_empresa';
  sourceUrl: string;
  companyDomain: string | null;
  freemail: boolean;
  freemailConfirmed: boolean;
  verifiedAt: string;
}

interface RecipientRow {
  id: number;
  job_id: number;
  email: string;
  source_kind: VerifiedRecipient['sourceKind'];
  source_url: string;
  company_domain: string | null;
  freemail: number;
  freemail_confirmed: number;
  verified_at: string;
}

const toRecipient = (row: RecipientRow): VerifiedRecipient => ({
  id: row.id,
  jobId: row.job_id,
  email: row.email,
  sourceKind: row.source_kind,
  sourceUrl: row.source_url,
  companyDomain: row.company_domain,
  freemail: row.freemail === 1,
  freemailConfirmed: row.freemail_confirmed === 1,
  verifiedAt: row.verified_at,
});

function insert(
  db: Db,
  recipient: {
    jobId: number;
    email: string;
    kind: VerifiedRecipient['sourceKind'];
    url: string;
    domain: string | null;
    evidence: string;
    confirmFreemail: boolean;
    now: Date;
  },
): VerifiedRecipient {
  const freemail = isFreemail(recipient.email);
  if (freemail && !recipient.confirmFreemail) {
    throw new RecipientError(
      'freemail',
      'o endereço é de provedor gratuito (gmail, outlook...): confirme explicitamente que é o contato oficial da vaga',
    );
  }
  db.prepare(
    `INSERT OR IGNORE INTO verified_recipients
       (job_id, email, source_kind, source_url, company_domain, evidence_hash, freemail, freemail_confirmed, verified_at)
     VALUES (@jobId, @email, @kind, @url, @domain, @hash, @freemail, @confirmed, @at)`,
  ).run({
    jobId: recipient.jobId,
    email: recipient.email,
    kind: recipient.kind,
    url: recipient.url,
    domain: recipient.domain,
    hash: sha256(recipient.evidence),
    freemail: freemail ? 1 : 0,
    confirmed: freemail && recipient.confirmFreemail ? 1 : 0,
    at: recipient.now.toISOString(),
  });
  const row = db
    .prepare('SELECT * FROM verified_recipients WHERE job_id = ? AND email = ?')
    .get(recipient.jobId, recipient.email) as RecipientRow;
  return toRecipient(row);
}

/** O endereço precisa estar escrito na descrição da vaga oficial (a que coletamos da fonte). */
export function verifyRecipientFromJob(
  db: Db,
  jobId: number,
  email: string,
  options: { confirmFreemail?: boolean; now?: Date } = {},
): VerifiedRecipient {
  const target = email.trim().toLowerCase();
  if (!isValidEmail(target)) throw new RecipientError('invalido', 'endereço de e-mail inválido');
  const job = db.prepare('SELECT url, description FROM jobs WHERE id = ?').get(jobId) as
    { url: string; description: string | null } | undefined;
  if (job === undefined) throw new RecipientError('fonte_invalida', `vaga ${jobId} não existe`);
  if (!extractEmails(job.description ?? '').includes(target)) {
    throw new RecipientError(
      'nao_encontrado_na_fonte',
      'o endereço não aparece na descrição da vaga oficial; nenhum e-mail é presumido',
    );
  }
  return insert(db, {
    jobId,
    email: target,
    kind: 'vaga_oficial',
    url: job.url,
    domain: null,
    evidence: job.description ?? '',
    confirmFreemail: options.confirmFreemail === true,
    now: options.now ?? new Date(),
  });
}

function belongsTo(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * O endereço precisa estar escrito em uma página HTTPS do domínio oficial da empresa (informado por
 * você), e o próprio endereço precisa ser desse domínio. A página é lida com o cliente HTTP do
 * projeto (robots.txt, ritmo limitado, só GET).
 */
export async function verifyRecipientFromPage(
  db: Db,
  http: HttpClient,
  options: {
    jobId: number;
    email: string;
    pageUrl: string;
    companyDomain: string;
    confirmFreemail?: boolean;
    now?: Date;
    signal?: AbortSignal;
  },
): Promise<VerifiedRecipient> {
  const email = options.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw new RecipientError('invalido', 'endereço de e-mail inválido');
  const domain = options.companyDomain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/.test(domain) ||
    FREEMAIL.has(domain) ||
    PUBLIC_SUFFIXES.has(domain) ||
    [...NOT_A_COMPANY_DOMAIN].some((d) => belongsTo(domain, d))
  ) {
    throw new RecipientError(
      'dominio_invalido',
      'informe o domínio próprio da empresa (não um provedor, rede social ou plataforma de vagas)',
    );
  }
  let url: URL;
  try {
    url = new URL(options.pageUrl);
  } catch {
    throw new RecipientError('fonte_invalida', 'URL da página inválida');
  }
  if (url.protocol !== 'https:' || !belongsTo(url.hostname.toLowerCase(), domain)) {
    throw new RecipientError('fonte_invalida', `a página precisa ser HTTPS e do domínio ${domain}`);
  }
  if (!belongsTo(domainOf(email), domain)) {
    throw new RecipientError('dominio_invalido', `o endereço não é do domínio ${domain}`);
  }
  const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(options.jobId);
  if (job === undefined)
    throw new RecipientError('fonte_invalida', `vaga ${options.jobId} não existe`);

  const html = await http.getText(
    url.href,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const visible = `${htmlToText(html)}\n${[...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => m[1]).join('\n')}`;
  if (!extractEmails(visible).includes(email)) {
    throw new RecipientError(
      'nao_encontrado_na_fonte',
      'o endereço não aparece na página informada',
    );
  }
  return insert(db, {
    jobId: options.jobId,
    email,
    kind: 'pagina_oficial_empresa',
    url: url.href,
    domain,
    evidence: visible,
    confirmFreemail: false,
    now: options.now ?? new Date(),
  });
}

export function listRecipients(db: Db, jobId: number): VerifiedRecipient[] {
  return (
    db
      .prepare('SELECT * FROM verified_recipients WHERE job_id = ? ORDER BY id')
      .all(jobId) as RecipientRow[]
  ).map(toRecipient);
}

/** Destinatário apto a receber o envio: verificado e, se for provedor gratuito, confirmado. */
export function usableRecipient(db: Db, jobId: number): VerifiedRecipient | undefined {
  return listRecipients(db, jobId).find(
    (recipient) => !recipient.freemail || recipient.freemailConfirmed,
  );
}
