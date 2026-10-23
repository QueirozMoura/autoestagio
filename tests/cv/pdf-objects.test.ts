import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderResume } from '../../src/cv/index.js';
import {
  DEFAULT_LIMITS,
  PdfStructureError,
  decodeText,
  deref,
  dictOf,
  isDict,
  isPdfString,
  metadataSurfaces,
  nameOf,
  objectOf,
  readPages,
  readPdfStructure,
  streamBytes,
  type StructureErrorCode,
} from '../../src/cv/validate/pdf-objects.js';
import { buildPdf, tamperSameLength } from '../helpers/cv-pdf-tamper.js';
import { fictionalResume } from '../helpers/cv-resume.js';

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const PAGES = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>';
const PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>';
const base = (extra: (string | Buffer)[] = []): (string | Buffer)[] => [
  CATALOG,
  PAGES,
  PAGE,
  ...extra,
];

const code = (fn: () => unknown): StructureErrorCode | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PdfStructureError) return error.code;
    throw error;
  }
  return undefined;
};

describe('leitor estrutural: PDF real do renderizador', () => {
  let bytes: Buffer;
  beforeAll(async () => {
    bytes = (await renderResume(fictionalResume({ extraBullets: 2, extraEntries: 2 }))).bytes;
  });

  it('lê objetos, catálogo, Info (UTF-16), páginas, XMP e /ID', () => {
    const s = readPdfStructure(bytes);
    expect(s.objects.size).toBeGreaterThan(100);
    const catalog = dictOf(s, s.trailer.map.get('Root'));
    expect([...(catalog?.map.keys() ?? [])]).toEqual(
      expect.arrayContaining(['Type', 'Pages', 'Lang', 'MarkInfo', 'StructTreeRoot', 'Metadata']),
    );
    const info = dictOf(s, s.trailer.map.get('Info'));
    const title = deref(s, info?.map.get('Title'));
    expect(isPdfString(title) ? decodeText(title) : '').toBe('Maria Exemplo da Silva — Currículo');
    const pages = readPages(s);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      mediaBox: [0, 0, 595.28, 841.89],
      rotate: 0,
      userUnit: 1,
      extraBoxes: [],
    });
    const xmp = objectOf(s, catalog?.map.get('Metadata'));
    expect(xmp && streamBytes(s, xmp).toString('utf8')).toContain(
      '<xmp:CreatorTool>AutoEstagio</xmp:CreatorTool>',
    );
    const id = deref(s, s.trailer.map.get('ID'));
    expect(Array.isArray(id) && id.length).toBe(2);
  });

  it('metadataSurfaces cobre strings e nomes, mas não os endereços /URI nem o conteúdo das páginas', () => {
    const surfaces = metadataSurfaces(readPdfStructure(bytes)).map((x) => x.text);
    expect(surfaces).toContain('AutoEstagio');
    expect(surfaces).toContain('Maria Exemplo da Silva');
    expect(surfaces.some((t) => t.startsWith('https://'))).toBe(false);
    expect(surfaces.some((t) => t.includes('Desenvolvi o módulo'))).toBe(false);
  });

  it('é determinístico e não altera os bytes recebidos', () => {
    const copy = Buffer.from(bytes);
    const a = readPdfStructure(bytes);
    const b = readPdfStructure(bytes);
    expect([...a.objects.keys()]).toEqual([...b.objects.keys()]);
    expect(bytes.equals(copy)).toBe(true);
  });
});

describe('leitor estrutural: sintaxe', () => {
  it('lê strings (escapes, octal, aninhamento, hexadecimal), nomes, números, booleanos, null e referências', () => {
    const s = readPdfStructure(
      buildPdf(
        base([
          '<< /A (a\\(b\\)c\\\\d\\101 (aninhada)) /B <48656c6c6f> /C /Nome#20Com#23 /D [1 -2 3.5 .25 true false null] /E 4 0 R /F << /G [ (x) ] >> >>',
        ]),
      ),
    );
    const dict = dictOf(s, { kind: 'ref', num: 4, gen: 0 });
    const get = (key: string) => dict?.map.get(key);
    const str = (v: unknown): string => (isPdfString(v as never) ? decodeText(v as never) : '');
    expect(str(get('A'))).toBe('a(b)c\\dA (aninhada)');
    expect(str(get('B'))).toBe('Hello');
    expect(nameOf(get('C'))).toBe('Nome Com#');
    expect(get('D')).toEqual([1, -2, 3.5, 0.25, true, false, null]);
    expect(get('E')).toEqual({ kind: 'ref', num: 4, gen: 0 });
    expect(isDict(get('F'))).toBe(true);
  });

  it('decodeText: UTF-16BE com BOM e PDFDocEncoding (Latin-1)', () => {
    expect(
      decodeText({ kind: 'string', bytes: Buffer.from([0xfe, 0xff, 0x00, 0x43, 0x00, 0xe9]) }),
    ).toBe('Cé');
    expect(decodeText({ kind: 'string', bytes: Buffer.from('Currículo', 'latin1') })).toBe(
      'Currículo',
    );
  });

  it('fluxo: usa /Length, descomprime FlateDecode e entrega bytes crus sem filtro', () => {
    const plain = 'conteúdo do fluxo';
    const flate = deflateSync(Buffer.from(plain, 'utf8'));
    const s = readPdfStructure(
      buildPdf(
        base([
          Buffer.concat([
            Buffer.from(`<< /Length ${flate.length} /Filter /FlateDecode >>\nstream\n`),
            flate,
            Buffer.from('\nendstream'),
          ]),
          '<< /Length 3 >>\nstream\nabc\nendstream',
        ]),
      ),
    );
    const flated = s.objects.get(4);
    const raw = s.objects.get(5);
    expect(flated && streamBytes(s, flated).toString('utf8')).toBe(plain);
    expect(raw && streamBytes(s, raw).toString('latin1')).toBe('abc');
  });
});

describe('leitor estrutural: limites defensivos', () => {
  it('arquivo grande demais', () => {
    expect(code(() => readPdfStructure(buildPdf(base()), { maxBytes: 100 }))).toBe('TOO_LARGE');
  });

  it('objetos demais', () => {
    expect(code(() => readPdfStructure(buildPdf(base()), { maxObjects: 2 }))).toBe(
      'TOO_MANY_OBJECTS',
    );
  });

  it('aninhamento fundo demais (dicionários e arrays)', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`;
    expect(code(() => readPdfStructure(buildPdf(base([deep]))))).toBe('TOO_DEEP');
    expect(
      code(() => readPdfStructure(buildPdf(base([`<< /K ${deep} >>`])), { maxDepth: 4 })),
    ).toBe('TOO_DEEP');
  });

  it('tokens demais em um único objeto', () => {
    const many = `[${'1 '.repeat(500)}]`;
    expect(code(() => readPdfStructure(buildPdf(base([many])), { maxTokensPerObject: 100 }))).toBe(
      'TOO_LARGE',
    );
  });

  it('fluxo que descomprime além do limite (bomba de compressão) é recusado', () => {
    const bomb = deflateSync(Buffer.alloc(3 * 1024 * 1024, 0));
    const pdf = buildPdf(
      base([
        Buffer.concat([
          Buffer.from(`<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`),
          bomb,
          Buffer.from('\nendstream'),
        ]),
      ]),
    );
    const s = readPdfStructure(pdf, { maxDecodedStreamBytes: 1024 * 1024 });
    const object = s.objects.get(4);
    expect(code(() => object && streamBytes(s, object))).toBe('MALFORMED');
    expect(DEFAULT_LIMITS.maxDecodedStreamBytes).toBeGreaterThan(1024 * 1024);
  });
});

describe('leitor estrutural: estrutura inesperada falha de forma controlada (falha fechada)', () => {
  const cases: [string, () => Buffer, StructureErrorCode][] = [
    ['sem cabeçalho %PDF-', () => Buffer.from('nada aqui'), 'MALFORMED'],
    [
      'PDF criptografado (/Encrypt)',
      () => buildPdf(base(), { trailerExtra: '/Encrypt 3 0 R' }),
      'UNSUPPORTED',
    ],
    [
      'atualização incremental (/Prev)',
      () => buildPdf(base(), { trailerExtra: '/Prev 9' }),
      'UNSUPPORTED',
    ],
    [
      'object stream (/ObjStm)',
      () => buildPdf(base(['<< /Type /ObjStm /N 1 /First 4 /Length 0 >>\nstream\n\nendstream'])),
      'UNSUPPORTED',
    ],
    [
      'fluxo de referências cruzadas (/XRef)',
      () => buildPdf(base(['<< /Type /XRef /Length 0 >>\nstream\n\nendstream'])),
      'UNSUPPORTED',
    ],
    [
      'dados depois do %%EOF',
      () => buildPdf(base(), { afterEof: '1 0 obj << /Foo /Bar >> endobj\n' }),
      'UNSUPPORTED',
    ],
    [
      'segundo startxref (atualização incremental)',
      () =>
        Buffer.concat([
          buildPdf(base()),
          Buffer.from('xref\n0 0\ntrailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n'),
        ]),
      'UNSUPPORTED',
    ],
    [
      'startxref que não aponta para a tabela',
      () => buildPdf(base(), { startxrefDelta: 3 }),
      'MALFORMED',
    ],
    ['chave duplicada no dicionário', () => buildPdf(base(['<< /A 1 /A 2 >>'])), 'MALFORMED'],
    [
      'objeto repetido',
      () =>
        Buffer.from(
          buildPdf(base()).toString('latin1').replace('\n3 0 obj', '\n2 0 obj'),
          'latin1',
        ),
      'MALFORMED',
    ],
    ['string não fechada', () => buildPdf(base(['<< /A (sem fim >>'])), 'MALFORMED'],
    ['dicionário não fechado', () => buildPdf(base(['<< /A 1 '])), 'MALFORMED'],
    [
      'objeto sem endobj',
      () => Buffer.from(buildPdf(base()).toString('latin1').replace('endobj', 'endob_'), 'latin1'),
      'MALFORMED',
    ],
    ['fluxo sem endstream', () => buildPdf(base(['<< /Length 3 >>\nstream\nabc'])), 'MALFORMED'],
    ['token inválido', () => buildPdf(base(['<< /A @@ >>'])), 'MALFORMED'],
  ];
  it.each(cases)('%s', (_name, make, expected) => {
    expect(code(() => readPdfStructure(make()))).toBe(expected);
  });

  it('um PDF mínimo válido é aceito (controle dos casos acima)', () => {
    expect(readPdfStructure(buildPdf(base())).objects.size).toBe(3);
    expect(readPages(readPdfStructure(buildPdf(base())))).toHaveLength(1);
  });

  it('páginas: MediaBox herdado e árvore com ciclo ou funda demais', () => {
    const inherited = buildPdf([
      CATALOG,
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 300] /Rotate 90 >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]);
    expect(readPages(readPdfStructure(inherited))[0]).toMatchObject({
      mediaBox: [0, 0, 200, 300],
      rotate: 90,
    });
    const cycle = buildPdf([CATALOG, '<< /Type /Pages /Count 1 /Kids [2 0 R] >>']);
    expect(code(() => readPages(readPdfStructure(cycle)))).toBe('TOO_DEEP');
    expect(tamperSameLength(Buffer.from('abc'), 'b', 'c').toString()).toBe('acc');
  });
});
