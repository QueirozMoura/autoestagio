import { loadPdfjs } from '../pdf.js';

/**
 * Extração para validação: lê o PDF gerado (só bytes em memória, nenhum arquivo) com o pdfjs-dist e devolve
 * os trechos de texto NA ORDEM EM QUE O PDF OS DESENHA (fluxo de conteúdo), as linhas por geometria
 * (de cima para baixo) e as anotações de link com o retângulo clicável.
 */
export interface TextRun {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface LinkAnnotation {
  page: number;
  /** Ausente quando a anotação não é um link com endereço (ex.: destino interno). */
  url?: string;
  /** [x1, y1, x2, y2] em pontos, origem no canto inferior esquerdo. */
  rect: [number, number, number, number];
}

export interface ExtractedPdf {
  pages: number;
  extractor: { name: string; version: string };
  /** Trechos na ordem do fluxo de conteúdo. */
  runs: TextRun[];
  /** Texto na ordem do fluxo de conteúdo, uma linha visual por `\n`. */
  streamText: string;
  /** Texto na ordem de leitura geométrica (de cima para baixo, da esquerda para a direita). */
  geometryText: string;
  annotations: LinkAnnotation[];
  /** Quantidade de trechos de texto por página (página sem texto = página em branco). */
  runsPerPage: number[];
  /** Linhas na ordem geométrica, com a página de cada uma. */
  pageLines: { page: number; text: string }[];
  /** Caixa visível, rotação e unidade de cada página, como o pdfjs as vê. */
  pageViews: { view: [number, number, number, number]; rotate: number; userUnit: number }[];
  /** Dicionário Info decodificado pelo pdfjs (só valores de texto). */
  info: Record<string, string>;
  /** O que o pdfjs enxerga de perigoso ou inesperado (segunda opinião para o H10). */
  security: {
    jsActions: boolean;
    attachments: boolean;
    formFields: boolean;
    xfa: boolean;
    /** Anotações que não são links, e anotações com ação ou destino. */
    nonLinkAnnotations: string[];
    annotationsWithActions: number;
  };
}

export class PdfReadError extends Error {
  constructor(cause: unknown) {
    super(`Não foi possível ler o PDF: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PdfReadError';
  }
}

interface RawItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
}
interface RawAnnotation {
  subtype?: string;
  url?: string;
  unsafeUrl?: string;
  rect?: number[];
  action?: unknown;
  dest?: unknown;
  actions?: unknown;
  attachment?: unknown;
  jsAction?: unknown;
}

const isRawItem = (value: unknown): value is RawItem =>
  typeof value === 'object' && value !== null && 'str' in value && 'transform' in value;

const LINE_TOLERANCE = 2;

export async function extractForValidation(bytes: Uint8Array): Promise<ExtractedPdf> {
  const pdfjs = await loadPdfjs();
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch (error) {
    throw new PdfReadError(error);
  }

  const runs: TextRun[] = [];
  const annotations: LinkAnnotation[] = [];
  const runsPerPage: number[] = [];
  const pageViews: ExtractedPdf['pageViews'] = [];
  let info: Record<string, string>;
  const nonLinkAnnotations: string[] = [];
  let annotationsWithActions = 0;
  let jsActions: boolean;
  let attachments: boolean;
  let formFields: boolean;
  let xfa: boolean;
  try {
    jsActions =
      Boolean(await doc.getJSActions()) && Object.keys((await doc.getJSActions()) ?? {}).length > 0;
    attachments = Boolean(await doc.getAttachments());
    formFields = Boolean(await doc.getFieldObjects());
    xfa = doc.isPureXfa;
    const metadata = await doc.getMetadata();
    info = Object.fromEntries(
      Object.entries(metadata.info as unknown as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const [vx1 = 0, vy1 = 0, vx2 = 0, vy2 = 0] = page.view;
      pageViews.push({ view: [vx1, vy1, vx2, vy2], rotate: page.rotate, userUnit: page.userUnit });
      const content = await page.getTextContent();
      let count = 0;
      for (const raw of content.items as unknown[]) {
        if (!isRawItem(raw) || raw.str.trim() === '') continue;
        count += 1;
        runs.push({
          page: pageNumber,
          text: raw.str,
          x: raw.transform[4] ?? 0,
          y: raw.transform[5] ?? 0,
          width: raw.width,
          height: raw.height,
          fontName: raw.fontName,
        });
      }
      runsPerPage.push(count);
      for (const a of (await page.getAnnotations()) as unknown as RawAnnotation[]) {
        if (a.subtype !== 'Link') nonLinkAnnotations.push(a.subtype ?? '(sem subtipo)');
        if (
          a.action !== undefined ||
          a.dest !== undefined ||
          a.actions !== undefined ||
          a.attachment !== undefined ||
          a.jsAction !== undefined
        )
          annotationsWithActions += 1;
        if (a.subtype !== 'Link' || a.rect === undefined || a.rect.length < 4) continue;
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = a.rect;
        const url = a.url ?? a.unsafeUrl;
        annotations.push({
          page: pageNumber,
          ...(url === undefined ? {} : { url }),
          rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
        });
      }
    }
  } catch (error) {
    throw new PdfReadError(error);
  }

  const pageLines = geometryLines(runs);
  return {
    pages: doc.numPages,
    extractor: { name: 'pdfjs-dist', version: pdfjs.version },
    runs,
    streamText: streamLines(runs).join('\n'),
    geometryText: pageLines.map((l) => l.text).join('\n'),
    annotations,
    runsPerPage,
    pageLines,
    pageViews,
    info,
    security: {
      jsActions,
      attachments,
      formFields,
      xfa,
      nonLinkAnnotations,
      annotationsWithActions,
    },
  };
}

/** Linhas na ordem do fluxo: uma nova linha começa quando muda a página ou a altura. */
function streamLines(runs: TextRun[]): string[] {
  const lines: string[] = [];
  let current = '';
  let last: TextRun | undefined;
  for (const run of runs) {
    const sameLine =
      last !== undefined && last.page === run.page && Math.abs(last.y - run.y) <= LINE_TOLERANCE;
    if (!sameLine && last !== undefined) {
      lines.push(current);
      current = '';
    }
    current += run.text;
    last = run;
  }
  if (last !== undefined) lines.push(current);
  return lines;
}

/** Linhas na ordem geométrica: por página, de cima para baixo e, na linha, da esquerda para a direita. */
function geometryLines(runs: TextRun[]): { page: number; text: string }[] {
  const out: { page: number; text: string }[] = [];
  const pages = [...new Set(runs.map((r) => r.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const groups: { y: number; runs: TextRun[] }[] = [];
    for (const run of runs.filter((r) => r.page === page)) {
      const group = groups.find((g) => Math.abs(g.y - run.y) <= LINE_TOLERANCE);
      if (group === undefined) groups.push({ y: run.y, runs: [run] });
      else group.runs.push(run);
    }
    groups.sort((a, b) => b.y - a.y);
    for (const group of groups)
      out.push({
        page,
        text: group.runs
          .sort((a, b) => a.x - b.x)
          .map((r) => r.text)
          .join(''),
      });
  }
  return out;
}
