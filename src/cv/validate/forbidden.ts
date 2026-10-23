import { clip, result, type CheckResult } from './checks.js';
import type { ExtractedPdf } from './extract.js';
import { plainText, stripInvisible } from './normalize.js';

/**
 * H5 — conteúdo proibido e informações retidas.
 *
 * O validador não conhece o modelo mestre: quem monta o `ForbiddenSet` (o chamador) o faz a partir das
 * afirmações rejeitadas, dos links não confirmados e dos campos retidos. Regras para não bloquear dado válido:
 *  - frases e contextos são comparados COM fronteira de palavra (nunca no meio de outra palavra);
 *  - um item curto demais para ser inequívoco ("2026", "IA") é recusado como insuficiente, em vez de banir
 *    esse termo isoladamente em todo o currículo;
 *  - links proibidos são comparados por URL INTEIRA (um perfil não proíbe os repositórios sob ele).
 */
export interface RetainedItem {
  /** Para a mensagem (ex.: "certificação: ano e descrição"). */
  label: string;
  /** Trechos COMPLETOS e autossuficientes (ex.: "Título — Emissor (2026)"), nunca só o ano. */
  contexts: string[];
}

export interface ForbiddenSet {
  /** Frases de afirmações rejeitadas. */
  phrases: string[];
  /** URLs que não podem aparecer (links não confirmados). */
  urls: string[];
  /** Informação retida, com contexto suficiente. */
  retained: RetainedItem[];
  /** Termos que o currículo pode conter apesar de parecerem texto inválido (ex.: "null"). */
  allowTokens?: string[];
}

export const NO_FORBIDDEN: ForbiddenSet = { phrases: [], urls: [], retained: [] };

const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function containsPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(phrase)}${BOUNDARY_AFTER}`, 'u').test(
    haystack,
  );
}

const wordCount = (text: string): number => text.split(' ').filter((w) => w !== '').length;

/** Uma frase proibida precisa ter 2+ palavras ou 10+ caracteres para não banir um termo comum isolado. */
const phraseHasContext = (phrase: string): boolean => wordCount(phrase) >= 2 || phrase.length >= 10;
/** Um contexto retido precisa ter 2+ palavras, 12+ caracteres e uma palavra de verdade (não só um ano). */
const contextHasContext = (context: string): boolean =>
  wordCount(context) >= 2 && context.length >= 12 && /\p{L}{3,}/u.test(context);

/** Textos inválidos de templates ou código que vazaram para o currículo (com fronteira de palavra). */
const word = (token: string): RegExp =>
  new RegExp(
    `${BOUNDARY_BEFORE.replace(')', '|_)')}${token}${BOUNDARY_AFTER.replace(')', '|_)')}`,
    'u',
  );
const INVALID_TEXT: { name: string; pattern: RegExp }[] = [
  { name: 'undefined', pattern: word('undefined') },
  { name: 'null', pattern: word('null') },
  { name: 'NaN', pattern: word('NaN') },
  { name: 'Infinity', pattern: word('Infinity') },
  { name: '[object Object]', pattern: /\[object Object\]/u },
  { name: '{{ }} (template não preenchido)', pattern: /\{\{|\}\}/u },
  { name: '${ } (template não preenchido)', pattern: /\$\{/u },
  { name: 'lorem ipsum', pattern: /lorem ipsum/iu },
];

const URL_IN_TEXT = /https?:\/\/[^\s|]+/gu;

/** URL comparável: esquema e host sem diferenciar maiúsculas, sem barra final. O caminho é exato. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}${parsed.search}${parsed.hash}`;
  } catch {
    return url.trim().replace(/\/+$/u, '');
  }
}

export interface ForbiddenInput {
  extracted: ExtractedPdf;
  /** `undefined` = nenhum conjunto informado: só o texto inválido é verificado. */
  forbidden: ForbiddenSet | undefined;
  /** Textos dos metadados (Info e XMP), quando a estrutura foi lida. */
  metadataTexts: string[];
}

export function checkForbiddenContent(input: ForbiddenInput): CheckResult {
  const { extracted, forbidden, metadataTexts } = input;
  const problems: string[] = [];
  const lines = extracted.streamText.split('\n');

  // Duas leituras do texto: linhas unidas por espaço e linhas unidas SEM espaço depois de hífen no fim da linha
  // ("e-" + "commerce"). Uma frase proibida é procurada nas duas (e nos metadados).
  const joinedSpace = lines.join(' ');
  const joinedHyphen = lines.reduce(
    (acc, line) => (acc === '' ? line : acc.endsWith('-') ? acc + line : `${acc} ${line}`),
    '',
  );
  const haystacks = [joinedSpace, joinedHyphen, ...metadataTexts].map(plainText);

  const set = forbidden ?? NO_FORBIDDEN;
  const phrases = set.phrases
    .map((p) => ({ raw: p, plain: plainText(p) }))
    .filter((p) => p.plain !== '');
  for (const phrase of phrases) {
    if (!phraseHasContext(phrase.plain)) {
      problems.push(
        `frase proibida sem contexto suficiente ("${clip(phrase.raw, 30)}"): compará-la isoladamente poderia bloquear dado válido; informe um trecho mais longo`,
      );
      continue;
    }
    if (haystacks.some((h) => containsPhrase(h, phrase.plain)))
      problems.push(`frase de afirmação rejeitada presente no PDF: "${clip(phrase.raw)}"`);
  }

  for (const item of set.retained) {
    for (const context of item.contexts) {
      const plain = plainText(context);
      if (!contextHasContext(plain)) {
        problems.push(
          `informação retida sem contexto suficiente (${item.label}: "${clip(context, 30)}"): informe o trecho completo, não só um ano ou termo solto`,
        );
        continue;
      }
      if (haystacks.some((h) => containsPhrase(h, plain)))
        problems.push(`informação retida presente no PDF (${item.label}): "${clip(context)}"`);
    }
  }

  if (set.urls.length > 0) {
    const present = new Set(
      [
        ...extracted.annotations.flatMap((a) => (a.url === undefined ? [] : [a.url])),
        ...lines.flatMap((line) => line.match(URL_IN_TEXT) ?? []),
      ].map(normalizeUrl),
    );
    for (const url of set.urls)
      if (present.has(normalizeUrl(url)))
        problems.push(`link não confirmado presente no PDF: ${clip(url, 70)}`);
  }

  // Texto inválido (template, valor nulo): palavras inteiras, respeitando as exceções declaradas.
  let invalidSource = [joinedSpace, ...metadataTexts].map((t) =>
    stripInvisible(t.normalize('NFC')).replace(/[|•]/gu, ' '),
  );
  for (const allowed of set.allowTokens ?? [])
    if (allowed !== '') invalidSource = invalidSource.map((t) => t.split(allowed).join(' '));
  for (const { name, pattern } of INVALID_TEXT)
    if (invalidSource.some((t) => pattern.test(t))) problems.push(`texto inválido no PDF: ${name}`);

  const provided = forbidden !== undefined;
  return result(
    'H5',
    'conteúdo proibido e informações retidas',
    problems,
    provided
      ? `${phrases.length} frase(s), ${set.retained.length} item(ns) retido(s) e ${set.urls.length} link(s) não confirmado(s) ausentes; sem texto inválido`
      : 'nenhum conjunto de proibições informado: só texto inválido (undefined, null, NaN…) foi verificado',
  );
}
