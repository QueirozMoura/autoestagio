import { createHash } from 'node:crypto';
import type { RawJob } from '../sources/types.js';
import { collapseWhitespace, htmlToText, toKey } from './text.js';
import { InvalidJobUrlError, canonicalizeUrl } from './url.js';
import { extractStipend } from './stipend.js';
import { detectWorkMode, type WorkMode } from './work-mode.js';

export type { WorkMode } from './work-mode.js';

export class NormalizationError extends Error {}

export interface NormalizedJob {
  externalId: string | null;
  /** URL como veio da fonte. */
  url: string;
  canonicalUrl: string;
  title: string;
  titleKey: string;
  company: string | null;
  companyKey: string | null;
  location: string | null;
  locationKey: string | null;
  /** `null` = desconhecida (nunca presumida). */
  workMode: WorkMode | null;
  description: string | null;
  stipendMin: number | null;
  stipendMax: number | null;
  stipendCurrency: 'BRL' | null;
  /** Texto de remuneração como publicado. */
  stipendText: string | null;
  /** ISO 8601 em UTC. */
  postedAt: string | null;
  /**
   * Identidade normalizada (empresa + título + local). É apenas um indício: sozinha nunca
   * prova que duas vagas são a mesma.
   */
  identityKey: string | null;
  /** Hash do conteúdo, para detectar vagas alteradas pela fonte. */
  contentHash: string;
}

const MAX_TITLE = 300;
const MAX_FIELD = 200;
const MAX_DESCRIPTION = 50_000;

const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'ltda',
  'eireli',
  'inc',
  'llc',
  'ltd',
  'corp',
  'sa',
  'me',
  'epp',
]);
const LOCATION_NOISE: ReadonlySet<string> = new Set([
  'hibrido',
  'hibrida',
  'remoto',
  'remota',
  'presencial',
  'hybrid',
  'remote',
  'brasil',
  'brazil',
]);

function plainText(value: string): string {
  return collapseWhitespace(htmlToText(value));
}

function optionalText(value: string | undefined, max = MAX_FIELD): string | null {
  if (value === undefined) return null;
  const text = plainText(value).slice(0, max);
  return text === '' ? null : text;
}

/** Chave do título: ignora marcas de gênero como "Estagiário(a)" e "Estagiário/a". */
export function titleKeyOf(title: string): string {
  return toKey(title.replace(/\((?:a|o|as|os)\)/gi, '').replace(/\/(?:a|as)\b/gi, ''));
}

export function companyKeyOf(company: string): string {
  const tokens = toKey(company).split(' ').filter(Boolean);
  const kept: string[] = [];
  for (const [index, token] of tokens.entries()) {
    // "S.A." e "S/A" viram os tokens "s" "a" no fim do nome.
    if (token === 's' && tokens[index + 1] === 'a' && index + 2 === tokens.length) break;
    if (!LEGAL_SUFFIXES.has(token)) kept.push(token);
  }
  return kept.length > 0 ? kept.join(' ') : tokens.join(' ');
}

export function locationKeyOf(location: string): string {
  return toKey(location)
    .split(' ')
    .filter((token) => !LOCATION_NOISE.has(token))
    .join(' ');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Converte a vaga bruta de uma fonte no formato interno. Lança `NormalizationError` para vagas
 * que não podem ser aproveitadas (sem título ou com URL que não seja HTTP/HTTPS).
 */
export function normalizeJob(raw: RawJob): NormalizedJob {
  const title = plainText(raw.title).slice(0, MAX_TITLE);
  if (title === '') throw new NormalizationError('título vazio');

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(raw.url);
  } catch (error) {
    if (error instanceof InvalidJobUrlError) throw new NormalizationError(error.message);
    throw error;
  }

  const company = optionalText(raw.company);
  const location = optionalText(raw.location);
  const descriptionText =
    raw.description === undefined ? '' : htmlToText(raw.description).slice(0, MAX_DESCRIPTION);
  const description = descriptionText === '' ? null : descriptionText;

  const titleKey = titleKeyOf(title);
  const companyKey = company === null ? null : companyKeyOf(company);
  const locationKey = location === null ? null : locationKeyOf(location);
  const workMode = detectWorkMode({ title, location, description });
  const { text: stipendText, stipend } = extractStipend(raw.compensationText, description);
  const postedAt = toIso(raw.postedAt);

  const identityKey =
    companyKey !== null && companyKey !== '' && titleKey !== ''
      ? sha256(`${companyKey}|${titleKey}|${locationKey ?? ''}`).slice(0, 32)
      : null;

  const contentHash = sha256(
    JSON.stringify([
      title,
      company,
      location,
      workMode,
      description,
      stipend?.min ?? null,
      stipend?.max ?? null,
      stipendText,
      postedAt,
    ]),
  );

  return {
    externalId: raw.externalId ?? null,
    url: raw.url.trim(),
    canonicalUrl,
    title,
    titleKey,
    company,
    companyKey,
    location,
    locationKey,
    workMode,
    description,
    stipendMin: stipend?.min ?? null,
    stipendMax: stipend?.max ?? null,
    stipendCurrency: stipend?.currency ?? null,
    stipendText,
    postedAt,
    identityKey,
    contentHash,
  };
}
