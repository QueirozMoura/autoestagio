import { clip, result, type CheckResult, type PopplerInput } from './checks.js';
import { CMapError, parseToUnicode, type CMap } from './cmap.js';
import type { PageAnalysis } from './content-stream.js';
import {
  PdfStructureError,
  deref,
  dictOf,
  isRef,
  nameOf,
  objectOf,
  streamBytes,
  type PdfDict,
  type PdfStructure,
} from './pdf-objects.js';
import {
  isEmptyGlyph,
  readTrueType,
  type TrueTypeLimits,
  type TrueTypeReading,
} from './truetype.js';

/**
 * H6 — fontes embutidas, subconjuntos, programas TrueType e cobertura do ToUnicode.
 * H7 — ligaduras e mapeamentos Unicode compostos ou inválidos.
 *
 * Entrega 2b-ii-a: a verificação é ESTRUTURAL e de cobertura. A comparação do programa com a fonte original
 * (identidade dos glifos, bytecode) e a coerência entre a forma do glifo e o Unicode declarado ficam para a
 * 2b-ii-b: por isso este H6 sozinho não prova que os glifos são os da Lato.
 */

/** Padrão do nome de uma fonte em subconjunto da Lato, como o PDFKit a nomeia. */
export const DEFAULT_ALLOWED_FONTS: readonly RegExp[] = [/^[A-Z]{6}\+Lato-(Regular|Bold)$/u];

/** As 14 fontes padrão do PDF: nunca são embutidas, então nunca valem. */
export const STANDARD_14 = new Set([
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
]);

const MAX_LISTED = 5;

// ------------------------------------------------------------------ coleta das fontes

export interface FontFacts {
  /** Número do objeto da fonte Type0 (-1 se for um dicionário direto). */
  objectNum: number;
  resourceNames: string[];
  subtype?: string;
  baseFont?: string;
  encoding?: string;
  descendantCount: number;
  cidSubtype?: string;
  cidBaseFont?: string;
  cidToGid?: string;
  descriptorName?: string;
  /** Quais chaves de programa o descritor tem (FontFile, FontFile2, FontFile3). */
  fontFileKeys: string[];
  program?: Buffer;
  programError?: string;
  hasToUnicode: boolean;
  toUnicode?: CMap;
  toUnicodeError?: string;
  truetype?: TrueTypeReading;
}

function describeProgramProblem(error: unknown): string {
  return error instanceof PdfStructureError ? error.message : String(error);
}

function factsOf(
  structure: PdfStructure,
  font: PdfDict,
  objectNum: number,
  limits: Partial<TrueTypeLimits>,
): FontFacts {
  const descendants = deref(structure, font.map.get('DescendantFonts'));
  const cid = Array.isArray(descendants) ? dictOf(structure, descendants[0]) : undefined;
  const descriptor = dictOf(structure, cid?.map.get('FontDescriptor'));
  const facts: FontFacts = {
    objectNum,
    resourceNames: [],
    descendantCount: Array.isArray(descendants) ? descendants.length : 0,
    fontFileKeys: ['FontFile', 'FontFile2', 'FontFile3'].filter((k) => descriptor?.map.has(k)),
    hasToUnicode: font.map.has('ToUnicode'),
  };
  const names = {
    subtype: nameOf(font.map.get('Subtype')),
    baseFont: nameOf(font.map.get('BaseFont')),
    encoding: nameOf(deref(structure, font.map.get('Encoding'))),
    cidSubtype: nameOf(cid?.map.get('Subtype')),
    cidBaseFont: nameOf(cid?.map.get('BaseFont')),
    cidToGid: nameOf(deref(structure, cid?.map.get('CIDToGIDMap'))),
    descriptorName: nameOf(descriptor?.map.get('FontName')),
  };
  for (const [key, value] of Object.entries(names) as [keyof typeof names, string | undefined][])
    if (value !== undefined) facts[key] = value;

  const programObject = objectOf(structure, descriptor?.map.get('FontFile2'));
  if (programObject !== undefined) {
    try {
      facts.program = streamBytes(structure, programObject);
      facts.truetype = readTrueType(facts.program, limits);
    } catch (error) {
      facts.programError = describeProgramProblem(error);
    }
  }
  const cmapObject = objectOf(structure, font.map.get('ToUnicode'));
  if (cmapObject !== undefined) {
    try {
      facts.toUnicode = parseToUnicode(streamBytes(structure, cmapObject).toString('latin1'));
    } catch (error) {
      facts.toUnicodeError =
        error instanceof CMapError ? error.message : describeProgramProblem(error);
    }
  }
  return facts;
}

/** Fontes usadas pelas páginas (sem repetir a mesma fonte), com programa e ToUnicode já lidos. */
export function collectFonts(
  structure: PdfStructure,
  pages: PageAnalysis[],
  limits: Partial<TrueTypeLimits> = {},
): FontFacts[] {
  const byObject = new Map<number, FontFacts>();
  for (const page of pages) {
    const dict = dictOf(structure, page.node.resources?.map.get('Font'));
    for (const [name, ref] of dict?.map ?? []) {
      const font = dictOf(structure, ref);
      if (font === undefined) continue;
      const key = isRef(ref) ? ref.num : -1 - byObject.size;
      let facts = byObject.get(key);
      if (facts === undefined) {
        facts = factsOf(structure, font, isRef(ref) ? ref.num : -1, limits);
        byObject.set(key, facts);
      }
      if (!facts.resourceNames.includes(name)) facts.resourceNames.push(name);
    }
  }
  return [...byObject.values()];
}

// ------------------------------------------------------------------ pdffonts

export interface PdffontsRow {
  name: string;
  type: string;
  encoding: string;
  emb: boolean;
  sub: boolean;
  uni: boolean;
  object: number;
}

/** Lê a tabela do `pdffonts` (colunas: nome, tipo, codificação, emb, sub, uni, objeto e geração). */
export function parsePdffonts(text: string): { rows: PdffontsRow[]; problems: string[] } {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const header = lines.findIndex((l) => /^name\s+type\s+encoding\s+emb\s+sub\s+uni/u.test(l));
  if (header < 0) return { rows: [], problems: ['saída do pdffonts sem a tabela esperada'] };
  const rows: PdffontsRow[] = [];
  const problems: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line === '' || /^-+(\s+-+)*$/u.test(line)) continue;
    const m = /^(\S+)\s+(.+?)\s+(\S+)\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+(\d+)\s+(\d+)$/u.exec(
      line,
    );
    if (m === null) {
      problems.push(`linha do pdffonts ilegível: "${clip(line, 60)}"`);
      continue;
    }
    rows.push({
      name: m[1] ?? '',
      type: m[2] ?? '',
      encoding: m[3] ?? '',
      emb: m[4] === 'yes',
      sub: m[5] === 'yes',
      uni: m[6] === 'yes',
      object: Number(m[7]),
    });
  }
  return { rows, problems };
}

// ------------------------------------------------------------------ H6

export interface FontsInput {
  structure: PdfStructure | undefined;
  structureError: string | undefined;
  pages: PageAnalysis[];
  poppler: PopplerInput;
  allowedFonts: readonly RegExp[];
  limits?: Partial<TrueTypeLimits>;
}

export interface FontsReading {
  check: CheckResult;
  fonts: FontFacts[];
}

const NAME = 'fontes embutidas, subconjuntos e ToUnicode';

export function checkFonts(input: FontsInput): FontsReading {
  const { structure, structureError, pages } = input;
  if (structure === undefined)
    return {
      check: result(
        'H6',
        NAME,
        [`não foi possível ler a estrutura do PDF: ${structureError ?? 'motivo desconhecido'}`],
        '',
      ),
      fonts: [],
    };
  const problems: string[] = [];
  const notes: string[] = [];
  const fonts = collectFonts(structure, pages, input.limits);
  if (fonts.length === 0) problems.push('o PDF não declara nenhuma fonte nos recursos das páginas');

  for (const font of fonts) {
    const label = `fonte ${font.baseFont ?? `(objeto ${font.objectNum})`}`;
    if (font.subtype !== 'Type0')
      problems.push(`${label}: /Subtype /${font.subtype ?? '?'} em vez de /Type0`);
    if (font.encoding !== 'Identity-H')
      problems.push(`${label}: codificação ${font.encoding ?? '(ausente)'} em vez de Identity-H`);
    if (font.descendantCount !== 1)
      problems.push(`${label}: ${font.descendantCount} fontes descendentes (esperava 1)`);
    if (font.cidSubtype !== 'CIDFontType2')
      problems.push(`${label}: descendente /${font.cidSubtype ?? '?'} em vez de /CIDFontType2`);
    if (font.cidToGid !== 'Identity')
      problems.push(`${label}: /CIDToGIDMap ${font.cidToGid ?? '(ausente)'} em vez de /Identity`);

    // Nome: padrão do subconjunto, igual nas três declarações, e nunca uma fonte padrão (não embutida).
    if (font.baseFont === undefined) problems.push(`${label}: sem /BaseFont`);
    else {
      if (STANDARD_14.has(font.baseFont))
        problems.push(`${label}: é uma das 14 fontes padrão do PDF (não embutida)`);
      else if (!input.allowedFonts.some((pattern) => pattern.test(font.baseFont ?? '')))
        problems.push(
          `${label}: nome fora do padrão permitido de subconjunto (${input.allowedFonts.map(String).join(' ou ')})`,
        );
      if (font.cidBaseFont !== font.baseFont || font.descriptorName !== font.baseFont)
        problems.push(
          `${label}: nomes inconsistentes (Type0 ${font.baseFont}, descendente ${font.cidBaseFont ?? '?'}, descritor ${font.descriptorName ?? '?'})`,
        );
    }

    // Programa embutido: só FontFile2 (TrueType).
    if (font.fontFileKeys.length === 0)
      problems.push(`${label}: sem programa de fonte embutido (/FontFile2)`);
    else if (font.fontFileKeys.join() !== 'FontFile2')
      problems.push(
        `${label}: programa de fonte que não é TrueType (${font.fontFileKeys.map((k) => `/${k}`).join(', ')})`,
      );
    if (font.programError !== undefined)
      problems.push(`${label}: programa ilegível (${font.programError})`);
    for (const p of font.truetype?.problems ?? []) problems.push(`${label}: ${p}`);

    if (!font.hasToUnicode) problems.push(`${label}: sem /ToUnicode`);
    else if (font.toUnicodeError !== undefined)
      problems.push(`${label}: ToUnicode ilegível (${font.toUnicodeError})`);
  }

  // Cobertura: todo glifo desenhado precisa existir no programa e ter texto no ToUnicode.
  let used = 0;
  for (const page of pages) {
    const fontDict = dictOf(structure, page.node.resources?.map.get('Font'));
    for (const [resourceName, cids] of page.analysis?.usage ?? []) {
      const ref = fontDict?.map.get(resourceName);
      const facts = fonts.find((f) => isRef(ref) && f.objectNum === ref.num);
      if (facts === undefined) continue;
      const label = `fonte ${facts.baseFont ?? `(objeto ${facts.objectNum})`} (página ${page.number})`;
      const unmapped: number[] = [];
      const beyond: number[] = [];
      const blank: string[] = [];
      for (const cid of cids) {
        used += 1;
        if (cid === 0)
          problems.push(
            `${label}: o glifo .notdef (CID 0) é desenhado (caractere sem glifo na fonte)`,
          );
        const text = facts.toUnicode?.map.get(cid);
        if (text === undefined && facts.toUnicode !== undefined) unmapped.push(cid);
        const font = facts.truetype?.font;
        if (font !== undefined) {
          if (cid >= font.numGlyphs) beyond.push(cid);
          else if (text !== undefined && isEmptyGlyph(font, cid) && text.trim() !== '')
            blank.push(`CID ${cid} → "${clip(text, 10)}"`);
        }
      }
      const listed = (list: (number | string)[]): string =>
        list.slice(0, MAX_LISTED).join(', ') + (list.length > MAX_LISTED ? '…' : '');
      if (unmapped.length > 0)
        problems.push(
          `${label}: ${unmapped.length} CID(s) usado(s) sem mapeamento no ToUnicode: ${listed(unmapped)}`,
        );
      if (beyond.length > 0)
        problems.push(`${label}: CID(s) além dos glifos do programa: ${listed(beyond)}`);
      if (blank.length > 0)
        problems.push(
          `${label}: glifo vazio para caractere visível (texto invisível): ${listed(blank)}`,
        );
    }
  }

  // Poppler (pdffonts) como verificação independente.
  const { mode, text: poppler } = input.poppler;
  if (mode === 'off') notes.push('pdffonts desligado (mode "off")');
  else if (poppler === undefined || !poppler.available) {
    if (mode === 'require')
      problems.push('Poppler exigido (mode "require"), mas não está disponível: sem o pdffonts');
    else notes.push('Poppler indisponível: pdffonts ignorado (mode "auto")');
  } else if (poppler.fontsError !== undefined) problems.push(poppler.fontsError);
  else if (poppler.fonts === undefined) problems.push('o Poppler não devolveu a lista de fontes');
  else {
    const table = parsePdffonts(poppler.fonts);
    problems.push(...table.problems);
    if (table.problems.length === 0) {
      const before = problems.length;
      const wanted = new Set(fonts.map((f) => f.baseFont ?? ''));
      const got = new Set(table.rows.map((r) => r.name));
      for (const name of wanted)
        if (!got.has(name)) problems.push(`pdffonts não lista a fonte ${clip(name, 40)}`);
      for (const name of got)
        if (!wanted.has(name)) problems.push(`pdffonts lista uma fonte a mais: ${clip(name, 40)}`);
      for (const row of table.rows) {
        const label = `pdffonts ${clip(row.name, 40)}`;
        if (!row.emb) problems.push(`${label}: fonte não embutida (emb no)`);
        if (!row.sub) problems.push(`${label}: fonte não é um subconjunto (sub no)`);
        if (!row.uni) problems.push(`${label}: sem ToUnicode (uni no)`);
        if (!/CID TrueType/u.test(row.type))
          problems.push(`${label}: tipo "${row.type}" em vez de CID TrueType`);
        if (row.encoding !== 'Identity-H')
          problems.push(`${label}: codificação ${row.encoding} em vez de Identity-H`);
      }
      if (problems.length === before)
        notes.push(
          `pdffonts ${poppler.version ?? ''} concorda: ${table.rows.length} fonte(s) embutida(s), em subconjunto e com ToUnicode`,
        );
    }
  }

  return {
    check: result(
      'H6',
      NAME,
      problems,
      `${fonts.length} fonte(s) Type0/Identity-H com programa TrueType em subconjunto e ToUnicode; ${used} uso(s) de glifo, todos cobertos`,
      notes,
    ),
    fonts,
  };
}

// ------------------------------------------------------------------ H7

/** Ligaduras e formas de apresentação: um glifo que carrega mais de uma letra, ou uma letra "pronta". */
const LIGATURE_RANGES: [number, number][] = [
  [0xfb00, 0xfb06],
  [0xfb13, 0xfb17],
  [0xfb1d, 0xfb4f],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfefe],
  [0x0132, 0x0133],
  [0x01c4, 0x01cc],
  [0x01f1, 0x01f3],
];
/** Caracteres invisíveis ou de formatação: um glifo mapeado para eles esconde texto. */
const INVISIBLE_RANGES: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];

const inRanges = (cp: number, ranges: [number, number][]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** Por que este texto de ToUnicode não é aceito (ou `undefined` se for um único caractere válido). */
export function classifyMapping(value: string): string | undefined {
  const points = Array.from(value).map((c) => c.codePointAt(0) ?? 0);
  if (points.length !== 1)
    return `mapeamento composto (${points.length} pontos de código: ${points.map(hex).join(' ')})`;
  const cp = points[0] ?? 0;
  // Inválidos primeiro: os não caracteres FDD0 a FDEF caem dentro do bloco de formas árabes.
  if (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xfffd ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    cp >= 0xf0000 ||
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    (cp & 0xfffe) === 0xfffe
  )
    return `caractere inválido (${hex(cp)})`;
  if (inRanges(cp, LIGATURE_RANGES)) return `ligadura ou forma de apresentação (${hex(cp)})`;
  if (inRanges(cp, INVISIBLE_RANGES)) return `caractere invisível ou de formatação (${hex(cp)})`;
  return undefined;
}

/** Procura, em texto já extraído, pontos de código de ligadura, invisíveis ou inválidos. */
export function suspiciousInText(text: string): string[] {
  const found = new Set<string>();
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    // Quebras de linha, tabulação e o separador de página (\f) do Poppler não são texto do currículo.
    if (cp === 0x0a || cp === 0x0d || cp === 0x09 || cp === 0x0c) continue;
    if (cp === 0xfffd) found.add(hex(cp));
    else if (classifyMapping(char) !== undefined) found.add(hex(cp));
  }
  return [...found];
}

export interface LigaturesInput {
  structure: PdfStructure | undefined;
  structureError: string | undefined;
  fonts: FontFacts[];
  /** Textos já extraídos (pdfjs, Poppler, operadores) para a segunda conferência. */
  texts: { source: string; text: string }[];
}

export function checkLigatures(input: LigaturesInput): CheckResult {
  const name = 'ligaduras e mapeamentos Unicode compostos';
  if (input.structure === undefined)
    return result(
      'H7',
      name,
      [`não foi possível ler os ToUnicode: ${input.structureError ?? 'estrutura ilegível'}`],
      '',
    );
  const problems: string[] = [];
  let entries = 0;
  for (const font of input.fonts) {
    const label = `fonte ${font.baseFont ?? `(objeto ${font.objectNum})`}`;
    if (font.toUnicode === undefined) continue; // o H6 já reprova ToUnicode ausente ou ilegível
    const bad: string[] = [];
    for (const [cid, value] of font.toUnicode.map) {
      entries += 1;
      // Exceção ESPECÍFICA: o glifo .notdef (CID 0) mapeado para U+0000, como o PDFKit sempre grava. Ele nunca
      // pode ser desenhado (o H6 reprova o uso do CID 0), então não chega ao texto.
      if (cid === 0 && value === '\u0000') continue;
      const why = classifyMapping(value);
      if (why !== undefined) bad.push(`CID ${cid} → "${clip(value, 12)}": ${why}`);
    }
    if (bad.length > 0)
      problems.push(
        `${label}: ${bad.length} entrada(s) do ToUnicode recusada(s): ${bad.slice(0, MAX_LISTED).join('; ')}${bad.length > MAX_LISTED ? '…' : ''}`,
      );
  }
  for (const { source, text } of input.texts) {
    const found = suspiciousInText(text);
    if (found.length > 0)
      problems.push(
        `texto extraído (${source}) com ligadura, invisível ou inválido: ${found.slice(0, MAX_LISTED).join(' ')}`,
      );
  }
  return result(
    'H7',
    name,
    problems,
    `${entries} entrada(s) do ToUnicode com um único caractere válido; nenhuma ligadura nos textos extraídos`,
  );
}
