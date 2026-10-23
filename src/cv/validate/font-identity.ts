import { createHash } from 'node:crypto';
import { clip } from './checks.js';
import {
  glyphBytes,
  glyphMetrics,
  isCompositeGlyph,
  readTrueType,
  tableBytes,
  type TrueTypeFont,
  type TrueTypeLimits,
} from './truetype.js';

/**
 * Identidade dos subconjuntos de fonte do PDF com a Lato original (Etapa 4.3, fatia 2, entrega 2b-ii-b1).
 *
 * As fontes de referência chegam COMO BYTES: este módulo não abre arquivo nenhum. O que se prova aqui, medido
 * contra a saída do PDFKit:
 *  - `fpgm`, `prep` e `cvt ` são cópias byte a byte das tabelas da fonte original;
 *  - `head`, `hhea` e `maxp` são cópias exceto os campos que dependem da contagem de glifos do subconjunto
 *    (`numberOfHMetrics` e `numGlyphs`) e o formato do `loca` (estrutural, conferido pelo leitor);
 *  - cada glifo SIMPLES do subconjunto é idêntico (SHA-256) a um glifo da fonte original e tem as mesmas
 *    métricas (`hmtx`) do glifo que o comprova.
 *
 * NÃO se prova aqui (2b-ii-b2): os glifos COMPOSTOS (o PDFKit reindexa os componentes) e a coerência entre o
 * desenho e o caractere declarado em `ToUnicode`. Por isso o resultado nunca passa de `partial`: um glifo
 * composto ou vazio não comprovado é contado e listado, jamais aceito em silêncio como `verified`.
 */

export type ReferenceName = 'Lato-Regular' | 'Lato-Bold';
export const REFERENCE_NAMES: readonly ReferenceName[] = ['Lato-Regular', 'Lato-Bold'];

export interface ReferenceFontInput {
  name: ReferenceName;
  bytes: Uint8Array;
}

export type FontIdentityStatus =
  /** Nenhuma referência foi informada: só a verificação estrutural do H6 vale. */
  | 'not-supplied'
  /** Referências informadas, mas o H6 não rodou (PDF ilegível). */
  | 'not-run'
  /** Referência inválida ou alguma fonte do PDF não confere com a original. */
  | 'failed'
  /** O que a 2b-ii-b1 prova conferiu; compostos e coerência com o Unicode ainda NÃO foram provados. */
  | 'partial'
  /** Tudo provado (compostos e coerência com o Unicode incluídos): só a 2b-ii-b2 poderá produzir isto. */
  | 'verified';

export interface FontIdentitySummary {
  font: string;
  variant: ReferenceName | null;
  glyphs: number;
  /** Glifos simples idênticos a um glifo da original (com as mesmas métricas). */
  simpleMatched: number;
  /** Destes, quantos têm mais de um glifo candidato na original (contornos duplicados). */
  ambiguous: number;
  /** Glifos sem contorno (espaço): só a plausibilidade das métricas é conferida. */
  empty: number;
  /** Glifos compostos: NÃO comprovados nesta versão. */
  composite: number;
  tablesIdentical: boolean;
}

export interface FontIdentityReport {
  status: FontIdentityStatus;
  /** O que esta versão do validador comprova quando o status é `partial`. */
  proven: string[];
  /** O que ainda NÃO é comprovado. */
  pending: string[];
  fonts: FontIdentitySummary[];
}

export const PROVEN_B1 = [
  'fpgm, prep e cvt idênticos, byte a byte, aos da fonte original',
  'head, hhea e maxp iguais aos da original (exceto as contagens do subconjunto)',
  'glifos simples idênticos aos da original (SHA-256), com as mesmas métricas hmtx',
];
export const PENDING_B1 = [
  'glifos compostos (índices dos componentes reindexados pelo subconjunto)',
  'coerência entre o desenho do glifo e o caractere declarado em ToUnicode',
  'glifos vazios: só a plausibilidade das métricas é conferida',
];

export const identityReport = (
  status: FontIdentityStatus,
  fonts: FontIdentitySummary[] = [],
): FontIdentityReport => ({
  status,
  proven: status === 'partial' || status === 'verified' ? [...PROVEN_B1] : [],
  pending: status === 'verified' ? [] : [...PENDING_B1],
  fonts,
});

// ------------------------------------------------------------------ referências

export interface PreparedReference {
  name: ReferenceName;
  font: TrueTypeFont;
  fpgm: Buffer;
  prep: Buffer;
  cvt: Buffer;
  /** SHA-256 do contorno → glifos da original com esse contorno (só glifos simples). */
  simple: Map<string, number[]>;
  /** `avanço:lsb` dos glifos sem contorno da original. */
  emptyMetrics: Set<string>;
}

export interface PreparedReferences {
  byName: Map<ReferenceName, PreparedReference>;
  problems: string[];
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const MAX_LISTED = 5;
const listed = (items: (number | string)[]): string =>
  items.slice(0, MAX_LISTED).join(', ') + (items.length > MAX_LISTED ? '…' : '');

const isReferenceName = (value: unknown): value is ReferenceName =>
  typeof value === 'string' && (REFERENCE_NAMES as readonly string[]).includes(value);

/**
 * Lê e valida as referências. Qualquer defeito é problema (as referências são a âncora da confiança: uma
 * referência ruim nunca é ignorada). Pede as duas variantes distintas apenas se forem informadas as duas.
 */
export function prepareReferences(
  inputs: readonly ReferenceFontInput[] | undefined,
  limits: Partial<TrueTypeLimits> = {},
): PreparedReferences | undefined {
  if (inputs === undefined) return undefined;
  const byName = new Map<ReferenceName, PreparedReference>();
  const problems: string[] = [];
  if (!Array.isArray(inputs) || inputs.length === 0) {
    problems.push('referências de fonte: nenhuma informada (esperava Lato-Regular e Lato-Bold)');
    return { byName, problems };
  }
  const raw = new Map<ReferenceName, Buffer>();
  for (const input of inputs as readonly Partial<ReferenceFontInput>[]) {
    const name: unknown = input.name;
    if (!isReferenceName(name)) {
      problems.push(`referência de fonte com nome inválido: ${clip(String(name), 30)}`);
      continue;
    }
    const label = `referência ${name}`;
    if (byName.has(name) || raw.has(name)) {
      problems.push(`${label}: informada mais de uma vez`);
      continue;
    }
    if (!(input.bytes instanceof Uint8Array)) {
      problems.push(`${label}: os bytes não são um Uint8Array`);
      continue;
    }
    const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    raw.set(name, bytes);
    const reading = readTrueType(bytes, limits, { reference: true });
    for (const p of reading.problems) problems.push(`${label}: ${p}`);
    const font = reading.font;
    if (font === undefined || reading.problems.length > 0) continue;

    const fpgm = tableBytes(font, 'fpgm');
    const prep = tableBytes(font, 'prep');
    const cvt = tableBytes(font, 'cvt ');
    if (fpgm === undefined || prep === undefined || cvt === undefined) {
      problems.push(`${label}: sem fpgm, prep ou cvt (não é a Lato completa)`);
      continue;
    }
    // A variante é conferida pelo cabeçalho (macStyle, bit 0 = negrito), não só pelo nome informado.
    const head = tableBytes(font, 'head');
    const bold = head !== undefined && (head.readUInt16BE(44) & 1) === 1;
    if (bold !== (name === 'Lato-Bold'))
      problems.push(
        `${label}: o cabeçalho (macStyle) diz ${bold ? 'negrito' : 'regular'}: variante trocada`,
      );

    const simple = new Map<string, number[]>();
    const emptyMetrics = new Set<string>();
    for (let g = 0; g < font.numGlyphs; g++) {
      const glyph = glyphBytes(font, g);
      if (glyph.length === 0) {
        const m = glyphMetrics(font, g);
        if (m !== undefined) emptyMetrics.add(`${m.advance}:${m.lsb}`);
      } else if (!isCompositeGlyph(glyph)) {
        const key = sha256(glyph);
        simple.set(key, [...(simple.get(key) ?? []), g]);
      }
    }
    byName.set(name, { name, font, fpgm, prep, cvt, simple, emptyMetrics });
  }
  const regular = raw.get('Lato-Regular');
  const boldBytes = raw.get('Lato-Bold');
  if (regular !== undefined && boldBytes !== undefined && regular.equals(boldBytes))
    problems.push('referências Lato-Regular e Lato-Bold com os mesmos bytes');
  return { byName, problems };
}

// ------------------------------------------------------------------ comparação

/** Compara dois buffers ignorando as faixas de bytes `[início, fim)`; devolve o primeiro byte que difere. */
function firstDifference(
  a: Buffer,
  b: Buffer,
  ignore: [number, number][] = [],
): number | undefined {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (ignore.some(([from, to]) => i >= from && i < to)) continue;
    if (a[i] !== b[i]) return i;
  }
  return undefined;
}

/** Campos que o subconjunto muda de propósito (contagens); todo o resto é cópia da fonte original. */
const HEADER_TABLES: { tag: string; ignore: [number, number][]; why: string }[] = [
  { tag: 'head', ignore: [[50, 52]], why: 'indexToLocFormat' },
  { tag: 'hhea', ignore: [[34, 36]], why: 'numberOfHMetrics' },
  { tag: 'maxp', ignore: [[4, 6]], why: 'numGlyphs' },
];

export interface IdentityOfFont {
  problems: string[];
  summary: FontIdentitySummary;
}

/** Confere um subconjunto do PDF contra a referência da sua variante (pelo sufixo do nome da fonte). */
export function checkFontIdentity(
  baseFont: string | undefined,
  font: TrueTypeFont | undefined,
  references: PreparedReferences,
): IdentityOfFont {
  const variantMatch = /\+(Lato-(?:Regular|Bold))$/u.exec(baseFont ?? '');
  const variant = variantMatch === null ? null : (variantMatch[1] as ReferenceName);
  const summary: FontIdentitySummary = {
    font: baseFont ?? '(sem nome)',
    variant,
    glyphs: font?.numGlyphs ?? 0,
    simpleMatched: 0,
    ambiguous: 0,
    empty: 0,
    composite: 0,
    tablesIdentical: false,
  };
  const problems: string[] = [];
  if (font === undefined) {
    problems.push('identidade não verificável: programa TrueType ilegível');
    return { problems, summary };
  }
  if (variant === null) {
    problems.push('identidade não verificável: o nome não indica Lato-Regular nem Lato-Bold');
    return { problems, summary };
  }
  const reference = references.byName.get(variant);
  if (reference === undefined) {
    problems.push(`identidade não verificável: sem referência válida para ${variant}`);
    return { problems, summary };
  }

  // 1. Programas de hinting: byte a byte.
  const tablesBefore = problems.length;
  for (const [tag, expected] of [
    ['fpgm', reference.fpgm],
    ['prep', reference.prep],
    ['cvt ', reference.cvt],
  ] as const) {
    const actual = tableBytes(font, tag);
    if (actual === undefined) problems.push(`tabela "${tag}" ausente (a original tem)`);
    else {
      const at = firstDifference(actual, expected);
      if (at !== undefined)
        problems.push(
          `tabela "${tag}" difere da ${variant} original (${actual.length} × ${expected.length} bytes; primeira diferença no byte ${at})`,
        );
    }
  }

  // 2. Cabeçalhos: tudo igual, exceto as contagens do subconjunto.
  for (const { tag, ignore } of HEADER_TABLES) {
    const actual = tableBytes(font, tag);
    const expected = tableBytes(reference.font, tag);
    if (actual === undefined || expected === undefined) {
      problems.push(`tabela "${tag}" ausente`);
      continue;
    }
    const at = firstDifference(actual, expected, ignore);
    if (at !== undefined)
      problems.push(`tabela "${tag}" difere da ${variant} original (byte ${at})`);
  }
  summary.tablesIdentical = problems.length === tablesBefore;

  // 3. Glifos simples (SHA-256) e métricas; compostos e vazios apenas contados.
  const unmatched: number[] = [];
  const wrongMetrics: number[] = [];
  const emptyOdd: number[] = [];
  for (let g = 0; g < font.numGlyphs; g++) {
    const glyph = glyphBytes(font, g);
    const metrics = glyphMetrics(font, g);
    if (glyph.length === 0) {
      summary.empty += 1;
      if (metrics === undefined || !reference.emptyMetrics.has(`${metrics.advance}:${metrics.lsb}`))
        emptyOdd.push(g);
      continue;
    }
    if (isCompositeGlyph(glyph)) {
      summary.composite += 1;
      continue;
    }
    const candidates = reference.simple.get(sha256(glyph));
    if (candidates === undefined) {
      unmatched.push(g);
      continue;
    }
    // Só vale o candidato que também confere as métricas.
    const proven = candidates.filter((c) => {
      const m = glyphMetrics(reference.font, c);
      return (
        m !== undefined &&
        metrics !== undefined &&
        m.advance === metrics.advance &&
        m.lsb === metrics.lsb
      );
    });
    if (proven.length === 0) {
      wrongMetrics.push(g);
      continue;
    }
    // O .notdef (glifo 0) tem de ser o .notdef da original.
    if (g === 0 && !proven.includes(0)) {
      problems.push('o glifo 0 (.notdef) não é o .notdef da original');
      continue;
    }
    summary.simpleMatched += 1;
    if (proven.length > 1) summary.ambiguous += 1;
  }
  if (unmatched.length > 0)
    problems.push(
      `${unmatched.length} glifo(s) simples sem correspondente na ${variant} original (contorno diferente ou adulterado): ${listed(unmatched)}`,
    );
  if (wrongMetrics.length > 0)
    problems.push(
      `${wrongMetrics.length} glifo(s) simples com métricas hmtx diferentes das da original: ${listed(wrongMetrics)}`,
    );
  if (emptyOdd.length > 0)
    problems.push(
      `${emptyOdd.length} glifo(s) vazio(s) com métricas que nenhum glifo vazio da original tem: ${listed(emptyOdd)}`,
    );
  return { problems, summary };
}
