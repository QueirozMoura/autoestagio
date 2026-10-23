import {
  analyzePages,
  collectFonts,
  readPdfStructure,
  type FontFacts,
  type PopplerMode,
} from '../../src/cv/validate/index.js';
import { checkFonts, checkLigatures, DEFAULT_ALLOWED_FONTS } from '../../src/cv/validate/fonts.js';
import type { PopplerText } from '../../src/cv/validate/poppler.js';
import type { TrueTypeLimits } from '../../src/cv/validate/truetype.js';
import { buildPdf } from './cv-pdf-tamper.js';

/** Programa TrueType decomposto em tabelas, para montar variações hostis. */
export interface TtfParts {
  sfnt: number;
  tables: Map<string, Buffer>;
}

export function parseTtf(buf: Buffer): TtfParts {
  const n = buf.readUInt16BE(4);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const offset = buf.readUInt32BE(at + 8);
    const length = buf.readUInt32BE(at + 12);
    tables.set(
      buf.toString('latin1', at, at + 4),
      Buffer.from(buf.subarray(offset, offset + length)),
    );
  }
  return { sfnt: buf.readUInt32BE(0), tables };
}

/** Monta um sfnt (tabelas alinhadas em 4 bytes; checksums zerados, como o subconjunto do PDFKit). */
export function buildTtf(parts: TtfParts): Buffer {
  const tags = [...parts.tables.keys()];
  const header = Buffer.alloc(12 + tags.length * 16);
  header.writeUInt32BE(parts.sfnt, 0);
  header.writeUInt16BE(tags.length, 4);
  let offset = header.length;
  const bodies: Buffer[] = [];
  tags.forEach((tag, i) => {
    const body = parts.tables.get(tag) ?? Buffer.alloc(0);
    header.write(tag, 12 + i * 16, 'latin1');
    header.writeUInt32BE(offset, 12 + i * 16 + 8);
    header.writeUInt32BE(body.length, 12 + i * 16 + 12);
    const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
    bodies.push(body, pad);
    offset += body.length + pad.length;
  });
  return Buffer.concat([header, ...bodies]);
}

export const mutateTtf = (program: Buffer, change: (parts: TtfParts) => void): Buffer => {
  const parts = parseTtf(program);
  change(parts);
  return buildTtf(parts);
};

/** Texto de um CMap `ToUnicode` com as entradas dadas (CID → texto), em blocos `bfchar`. */
export function cmapText(entries: Iterable<[number, string]>): string {
  const hex4 = (n: number): string => n.toString(16).padStart(4, '0');
  const utf16 = (text: string): string =>
    Array.from({ length: text.length }, (_, i) => hex4(text.charCodeAt(i))).join('');
  const all = [...entries];
  const blocks: string[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    blocks.push(
      `${chunk.length} beginbfchar\n${chunk.map(([cid, text]) => `<${hex4(cid)}> <${utf16(text)}>`).join('\n')}\nendbfchar`,
    );
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <ffff>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/** Conteúdo de página que desenha os CIDs dados com a fonte /F1. */
export const showCids = (cids: number[], size = 10, x = 100, y = 700): string =>
  `q\nBT\n1 0 0 1 ${x} ${y} Tm\n/F1 ${size} Tf\n[<${cids.map((c) => c.toString(16).padStart(4, '0')).join('')}>] TJ\nET\nQ`;

export interface FontPdfOptions {
  program: Buffer;
  toUnicode: string;
  content: string;
  subtype?: string;
  baseFont?: string;
  cidBaseFont?: string;
  descriptorName?: string;
  encoding?: string;
  cidSubtype?: string;
  cidToGid?: string;
  fontFileKey?: string;
  omitToUnicode?: boolean;
  descendants?: number;
}

const stream = (dict: string, data: Buffer | string): Buffer => {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream', 'latin1'),
  ]);
};

/** PDF sintético de uma página com UMA fonte Type0, no formato do PDFKit, mas com os campos controlados. */
export function fontPdf(o: FontPdfOptions): Buffer {
  const base = o.baseFont ?? 'ABCDEF+Lato-Regular';
  const descendants = Array.from({ length: o.descendants ?? 1 }, () => '6 0 R').join(' ');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /ProcSet [/PDF /Text] /Font << /F1 5 0 R >> /ColorSpace << >> >> >>',
    stream('', o.content),
    `<< /Type /Font /Subtype /${o.subtype ?? 'Type0'} /BaseFont /${base} /Encoding /${o.encoding ?? 'Identity-H'} /DescendantFonts [${descendants}] ${o.omitToUnicode === true ? '' : '/ToUnicode 9 0 R'} >>`,
    `<< /Type /Font /Subtype /${o.cidSubtype ?? 'CIDFontType2'} /BaseFont /${o.cidBaseFont ?? base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /W [0 [500 500]] /CIDToGIDMap /${o.cidToGid ?? 'Identity'} >>`,
    `<< /Type /FontDescriptor /FontName /${o.descriptorName ?? base} /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /XHeight 500 /StemV 0 /${o.fontFileKey ?? 'FontFile2'} 8 0 R >>`,
    stream('', o.program),
    stream('', o.toUnicode),
  ]);
}

/** O programa e o ToUnicode reais de uma fonte do PDF do renderizador (`Regular` ou `Bold`). */
export function realFont(rendered: Buffer, style: 'Regular' | 'Bold'): FontFacts {
  const structure = readPdfStructure(rendered);
  const fonts = collectFonts(structure, analyzePages(structure).pages);
  const found = fonts.find((f) => f.baseFont?.endsWith(`Lato-${style}`) === true);
  if (found?.program === undefined || found.toUnicode === undefined)
    throw new Error(`sem a fonte ${style}`);
  return found;
}

/** Roda H6 e H7 direto sobre os bytes (sem o pdfjs): serve a PDFs sintéticos cujo texto o pdfjs não lê. */
export function runFontChecks(
  pdf: Buffer,
  options: {
    mode?: PopplerMode;
    poppler?: PopplerText;
    limits?: Partial<TrueTypeLimits>;
    texts?: { source: string; text: string }[];
    allowedFonts?: readonly RegExp[];
  } = {},
) {
  const structure = readPdfStructure(pdf);
  const analyzed = analyzePages(structure);
  const reading = checkFonts({
    structure,
    structureError: undefined,
    pages: analyzed.pages,
    poppler: { mode: options.mode ?? 'off', text: options.poppler },
    allowedFonts: options.allowedFonts ?? DEFAULT_ALLOWED_FONTS,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const h7 = checkLigatures({
    structure,
    structureError: undefined,
    fonts: reading.fonts,
    texts: options.texts ?? [],
  });
  return { h6: reading.check, h7, fonts: reading.fonts };
}
