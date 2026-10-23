import { clip, result, type CheckResult } from './checks.js';
import type { ExtractedPdf } from './extract.js';
import {
  decodeText,
  deref,
  dictOf,
  isDict,
  isPdfString,
  metadataSurfaces,
  nameOf,
  objectOf,
  streamBytes,
  type PdfDict,
  type PdfStructure,
} from './pdf-objects.js';

/**
 * H8 — metadados e informação local indevida.
 *
 * Confere o dicionário Info e o XMP (campo a campo, sem chaves ou propriedades a mais), o idioma, a estrutura
 * marcada, as datas determinísticas e a ausência de caminhos locais e de marcadores do ambiente nos METADADOS
 * (Info, XMP, nomes e strings estruturais). O conteúdo visível e os endereços dos links ficam de fora desta
 * varredura: neles um nome de usuário pode ser, legitimamente, parte de uma URL ou do nome da pessoa.
 */
export interface MetadataExpectation {
  title: string;
  author: string;
  subject: string;
  producer: string;
  creator: string;
  /** Data fixa de criação e modificação. */
  date: Date;
  language: string;
}

const pad = (n: number, size = 2): string => String(n).padStart(size, '0');

/** Data no formato do dicionário Info: `D:YYYYMMDDHHmmSSZ` (UTC). */
export const pdfDate = (d: Date): string =>
  `D:${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Data no formato do XMP: `YYYY-MM-DDTHH:mm:ssZ` (UTC, sem milissegundos). */
export const xmpDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/u, 'Z');

const INFO_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Producer',
  'Creator',
  'CreationDate',
  'ModDate',
] as const;

/** Caminhos e marcadores que não podem aparecer nos metadados (padrões genéricos, sem dados de ninguém). */
const PATH_PATTERNS: { name: string; pattern: RegExp }[] = [
  {
    name: 'caminho Unix absoluto',
    pattern:
      /(?:^|[\s"'(=:;,>])\/(?:home|Users|root|tmp|var|mnt|opt|etc|usr|private|Volumes)\/\S*/u,
  },
  { name: 'caminho Windows', pattern: /\b[A-Za-z]:\\\S*/u },
  { name: 'caminho de rede (UNC)', pattern: /\\\\[\w.$-]+\\\S*/u },
  { name: 'URL file://', pattern: /\bfile:\/\//iu },
  { name: 'caminho do usuário (~/)', pattern: /(?:^|[\s"'(=:;,>])~\/\S*/u },
  { name: 'node_modules', pattern: /node_modules/iu },
];
export const ENVIRONMENT_MARKERS = ['PDFKit', 'Node.js', 'nodejs'] as const;
/** Um marcador local menor que isto casaria com qualquer coisa: é recusado em vez de ignorado. */
export const MIN_MARKER_LENGTH = 3;

const XMP_NAMESPACES: Record<string, string> = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
};
const XMP_ELEMENTS = new Set([
  'x:xmpmeta',
  'rdf:RDF',
  'rdf:Description',
  'rdf:Alt',
  'rdf:Seq',
  'rdf:li',
  'xmp:CreateDate',
  'xmp:CreatorTool',
  'dc:title',
  'dc:creator',
  'dc:description',
  'pdf:Producer',
]);

const decodeEntities = (text: string): string =>
  text
    .replace(/&#x([0-9a-fA-F]+);/gu, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');

interface XmpValues {
  createDate?: string;
  creatorTool?: string;
  producer?: string;
  title?: string;
  creator?: string;
  description?: string;
}

export function parseXmp(xml: string): { problems: string[]; values: XmpValues } {
  const problems: string[] = [];
  const withoutBom = xml.charCodeAt(0) === 0xfeff ? xml.slice(1).trimStart() : xml.trimStart();
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml))
    problems.push('XMP com DOCTYPE ou ENTITY (declarações externas não são permitidas)');
  if (!/^<\?xpacket begin=/u.test(withoutBom) || !/<\?xpacket end=/u.test(withoutBom))
    problems.push('XMP sem o envelope <?xpacket …?>');
  for (const m of xml.matchAll(/xmlns:([A-Za-z][\w-]*)="([^"]*)"/gu)) {
    const [, prefix = '', uri = ''] = m;
    if (XMP_NAMESPACES[prefix] !== uri)
      problems.push(`espaço de nomes XMP inesperado: ${prefix}="${clip(uri, 50)}"`);
  }
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<([A-Za-z][\w-]*:[\w-]+)/gu)) {
    const tag = m[1] ?? '';
    if (!XMP_ELEMENTS.has(tag)) seen.add(tag);
  }
  for (const tag of seen) problems.push(`propriedade XMP inesperada: <${tag}>`);
  for (const m of xml.matchAll(/<rdf:Description\b([^>]*)>/gu)) {
    const attributes = (m[1] ?? '')
      .replace(/xmlns:[\w-]+="[^"]*"/gu, '')
      .replace(/rdf:about=""/u, '')
      .trim();
    if (attributes !== '')
      problems.push(`atributo inesperado em rdf:Description: ${clip(attributes, 50)}`);
  }
  const single = (pattern: RegExp, label: string): string | undefined => {
    const all = [...xml.matchAll(pattern)];
    if (all.length !== 1) {
      problems.push(all.length === 0 ? `XMP sem ${label}` : `XMP com ${label} repetido`);
      return undefined;
    }
    return decodeEntities(all[0]?.[1] ?? '');
  };
  const alt = (tag: string): RegExp =>
    new RegExp(
      `<${tag}>\\s*<rdf:Alt>\\s*<rdf:li xml:lang="x-default">([^<]*)</rdf:li>\\s*</rdf:Alt>\\s*</${tag}>`,
      'gu',
    );
  const raw: Record<keyof XmpValues, string | undefined> = {
    createDate: single(/<xmp:CreateDate>([^<]*)<\/xmp:CreateDate>/gu, 'xmp:CreateDate'),
    creatorTool: single(/<xmp:CreatorTool>([^<]*)<\/xmp:CreatorTool>/gu, 'xmp:CreatorTool'),
    producer: single(/<pdf:Producer>([^<]*)<\/pdf:Producer>/gu, 'pdf:Producer'),
    title: single(alt('dc:title'), 'dc:title'),
    description: single(alt('dc:description'), 'dc:description'),
    creator: single(
      /<dc:creator>\s*<rdf:Seq>\s*<rdf:li>([^<]*)<\/rdf:li>\s*<\/rdf:Seq>\s*<\/dc:creator>/gu,
      'dc:creator',
    ),
  };
  const values: XmpValues = {};
  for (const key of Object.keys(raw) as (keyof XmpValues)[]) {
    const value = raw[key];
    if (value !== undefined) values[key] = value;
  }
  return { problems, values };
}

const textOf = (structure: PdfStructure, dict: PdfDict, key: string): string | undefined => {
  const value = deref(structure, dict.map.get(key));
  return isPdfString(value) ? decodeText(value) : undefined;
};

export interface MetadataInput {
  /** Estrutura lida; ausente quando `structureError` explica por quê (falha fechada). */
  structure: PdfStructure | undefined;
  structureError: string | undefined;
  extracted: ExtractedPdf;
  expectation: MetadataExpectation;
  /** Marcadores do ambiente do chamador (raiz do projeto, usuário, host…). */
  localMarkers: string[];
}

/** O que a verificação leu (para o H5 reaproveitar os textos dos metadados). */
export interface MetadataReading {
  check: CheckResult;
  texts: string[];
}

export function checkMetadata(input: MetadataInput): MetadataReading {
  const { structure, structureError, extracted, expectation } = input;
  const name = 'metadados e informação local';
  if (structure === undefined)
    return {
      check: result(
        'H8',
        name,
        [`não foi possível ler a estrutura do PDF: ${structureError ?? 'motivo desconhecido'}`],
        '',
      ),
      texts: [],
    };
  const problems: string[] = [];
  const texts: string[] = [];

  // --- Info
  const info = dictOf(structure, structure.trailer.map.get('Info'));
  if (info === undefined) problems.push('sem dicionário Info');
  else {
    const wanted: Record<(typeof INFO_KEYS)[number], string> = {
      Title: expectation.title,
      Author: expectation.author,
      Subject: expectation.subject,
      Producer: expectation.producer,
      Creator: expectation.creator,
      CreationDate: pdfDate(expectation.date),
      ModDate: pdfDate(expectation.date),
    };
    for (const key of info.map.keys())
      if (!(INFO_KEYS as readonly string[]).includes(key))
        problems.push(`metadado inesperado no Info: /${key}`);
    for (const key of INFO_KEYS) {
      const got = textOf(structure, info, key);
      if (got === undefined) problems.push(`Info sem /${key}`);
      else {
        texts.push(got);
        if (got !== wanted[key])
          problems.push(`Info /${key} diverge: "${clip(got)}" em vez de "${clip(wanted[key])}"`);
        const viaPdfjs = extracted.info[key];
        if (viaPdfjs !== got)
          problems.push(
            `os extratores discordam em /${key}: estrutura "${clip(got)}" × pdfjs "${clip(viaPdfjs ?? '(ausente)')}"`,
          );
      }
    }
  }

  // --- Catálogo: idioma, estrutura marcada, título na janela
  const catalog = dictOf(structure, structure.trailer.map.get('Root'));
  if (catalog === undefined) problems.push('sem catálogo (/Root)');
  else {
    const lang = textOf(structure, catalog, 'Lang');
    if (lang !== expectation.language)
      problems.push(`idioma (/Lang) "${lang ?? '(ausente)'}" em vez de "${expectation.language}"`);
    const mark = dictOf(structure, catalog.map.get('MarkInfo'));
    if (deref(structure, mark?.map.get('Marked')) !== true)
      problems.push('PDF sem estrutura marcada (/MarkInfo /Marked true)');
    const tree = dictOf(structure, catalog.map.get('StructTreeRoot'));
    if (
      tree === undefined ||
      nameOf(tree.map.get('Type')) !== 'StructTreeRoot' ||
      !tree.map.has('K')
    )
      problems.push('sem árvore de estrutura (/StructTreeRoot com /K)');
    const viewer = dictOf(structure, catalog.map.get('ViewerPreferences'));
    if (deref(structure, viewer?.map.get('DisplayDocTitle')) !== true)
      problems.push('/ViewerPreferences /DisplayDocTitle não é true');

    // --- XMP
    const meta = objectOf(structure, catalog.map.get('Metadata'));
    if (
      meta === undefined ||
      !isDict(meta.value) ||
      nameOf(meta.value.map.get('Subtype')) !== 'XML'
    )
      problems.push('sem fluxo XMP (/Metadata /Subtype /XML)');
    else {
      let xml: string | undefined;
      try {
        xml = streamBytes(structure, meta).toString('utf8');
      } catch (error) {
        problems.push(`XMP ilegível: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (xml !== undefined) {
        texts.push(xml);
        const xmp = parseXmp(xml);
        problems.push(...xmp.problems);
        const compare = (label: string, got: string | undefined, want: string): void => {
          if (got !== undefined && got !== want)
            problems.push(`XMP ${label} diverge: "${clip(got)}" em vez de "${clip(want)}"`);
        };
        compare('xmp:CreateDate', xmp.values.createDate, xmpDate(expectation.date));
        compare('xmp:CreatorTool', xmp.values.creatorTool, expectation.creator);
        compare('pdf:Producer', xmp.values.producer, expectation.producer);
        compare('dc:title', xmp.values.title, expectation.title);
        compare('dc:creator', xmp.values.creator, expectation.author);
        compare('dc:description', xmp.values.description, expectation.subject);
      }
    }
  }

  // --- /ID: presente e inalterado (as duas metades iguais)
  const id = deref(structure, structure.trailer.map.get('ID'));
  if (!Array.isArray(id) || id.length !== 2 || !id.every(isPdfString))
    problems.push('trailer sem /ID de duas partes');
  else if (!(id[0] as { bytes: Buffer }).bytes.equals((id[1] as { bytes: Buffer }).bytes))
    problems.push('as duas metades do /ID diferem (documento modificado depois de gerado)');

  // --- Informação local nos metadados
  for (const marker of input.localMarkers)
    if (marker.length < MIN_MARKER_LENGTH)
      problems.push(
        `marcador local curto demais ("${marker}"): ignorá-lo seria inseguro; use ao menos ${MIN_MARKER_LENGTH} caracteres`,
      );
  // Os valores ESPERADOS (nome, título, produtor…) já foram conferidos campo a campo: saem da varredura, para um
  // marcador como o primeiro nome do usuário não acusar o nome legítimo da pessoa nos metadados.
  const expectedValues = [
    expectation.title,
    expectation.author,
    expectation.subject,
    expectation.producer,
    expectation.creator,
    pdfDate(expectation.date),
    xmpDate(expectation.date),
  ]
    .filter((v) => v !== '')
    .sort((a, b) => b.length - a.length);
  const mask = (text: string): string =>
    expectedValues.reduce((t, v) => t.split(v).join(' '), text);
  const surfaces = [
    ...metadataSurfaces(structure),
    ...texts.map((text) => ({ where: 'metadados', text })),
  ].map((surface) => ({ ...surface, text: mask(surface.text) }));
  const environment = [
    ...ENVIRONMENT_MARKERS,
    ...input.localMarkers.filter((m) => m.length >= MIN_MARKER_LENGTH),
  ];
  const reported = new Set<string>();
  for (const { where, text } of surfaces) {
    for (const { name: label, pattern } of PATH_PATTERNS)
      if (pattern.test(text))
        reported.add(`${label} nos metadados (${where}): "${clip(text, 50)}"`);
    for (const marker of environment)
      if (text.toLowerCase().includes(marker.toLowerCase()))
        reported.add(`marcador do ambiente "${clip(marker, 30)}" nos metadados (${where})`);
  }
  problems.push(...[...reported].slice(0, 8));

  return {
    check: result(
      'H8',
      name,
      problems,
      'Info e XMP exatos e coerentes, idioma, estrutura marcada, datas fixas e nenhum caminho local',
    ),
    texts,
  };
}
