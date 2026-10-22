import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type * as Pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Uma linha visual do PDF, já com os espaços reconstruídos. */
export interface PdfLine {
  /** Número da linha na extração (1-based, páginas em sequência). */
  n: number;
  page: number;
  y: number;
  x: number;
  /** Maior altura de fonte na linha. */
  size: number;
  /** A 1ª parte da linha usa a fonte em negrito (a fonte do nome/títulos). */
  startsBold: boolean;
  /** A linha inteira está em negrito. */
  allBold: boolean;
  text: string;
}

export interface PdfLink {
  page: number;
  url: string;
  /** Texto sob o retângulo do link (o rótulo visível). */
  label: string;
}

export interface PdfExtraction {
  sha256: string;
  /** Só o nome do arquivo. */
  label: string;
  bytes: number;
  pages: number;
  lines: PdfLine[];
  links: PdfLink[];
  extractor: { name: string; version: string };
}

interface PdfAnnotation {
  subtype?: string;
  url?: string;
  rect?: number[];
}

interface TextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
}

export async function loadPdfjs(): Promise<typeof Pdfjs> {
  // O pdf.js avisa que não achou o canvas opcional (usado só para desenhar). Não precisamos dele.
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } finally {
    console.warn = warn;
  }
}

const isText = (item: unknown): item is TextItem =>
  typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
const isPdfjsText = (item: unknown): item is TextItem => isText(item);

/**
 * Lê o PDF (somente leitura: o arquivo nunca é aberto para escrita) e devolve linhas com fonte e
 * posição, mais os hiperlinks (anotações) com o texto visível de cada um.
 */
export async function extractPdfBytes(bytes: Uint8Array, label: string): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const lines: PdfLine[] = [];
  const links: PdfLink[] = [];
  let counter = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const raw of content.items) if (isPdfjsText(raw) && raw.str !== '') items.push(raw);
    const visible = items.filter((item) => item.str.trim() !== '');
    const boldFont = visible.reduce<TextItem | undefined>(
      (best, item) => (best === undefined || item.height > best.height ? item : best),
      undefined,
    )?.fontName;

    // Agrupa por linha (mesmo y, com tolerância), da de cima para a de baixo.
    const groups: { y: number; items: TextItem[] }[] = [];
    for (const item of items) {
      const y = item.transform[5] ?? 0;
      const group = groups.find((g) => Math.abs(g.y - y) < 2);
      if (group === undefined) groups.push({ y, items: [item] });
      else group.items.push(item);
    }
    groups.sort((a, b) => b.y - a.y);

    for (const group of groups) {
      const ordered = group.items.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
      let text = '';
      let previousEnd: number | undefined;
      let previousSize = 0;
      for (const item of ordered) {
        const x = item.transform[4] ?? 0;
        const size = item.height || previousSize || 9;
        if (
          previousEnd !== undefined &&
          x - previousEnd > 0.18 * size &&
          !text.endsWith(' ') &&
          !item.str.startsWith(' ')
        )
          text += ' ';
        text += item.str;
        previousEnd = x + item.width;
        previousSize = item.height || previousSize;
      }
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean === '') continue;
      const real = ordered.filter((item) => item.str.trim() !== '');
      counter += 1;
      lines.push({
        n: counter,
        page: pageNumber,
        y: group.y,
        x: Math.min(...real.map((item) => item.transform[4] ?? 0)),
        size: Math.max(...real.map((item) => item.height)),
        startsBold: real[0]?.fontName === boldFont,
        allBold: real.every((item) => item.fontName === boldFont),
        text: clean,
      });
    }

    for (const annotation of (await page.getAnnotations()) as unknown as PdfAnnotation[]) {
      if (annotation.subtype !== 'Link' || typeof annotation.url !== 'string') continue;
      const [ax = 0, ay = 0, bx = 0, by = 0] = annotation.rect ?? [];
      const [x0, x1, y0, y1] = [
        Math.min(ax, bx),
        Math.max(ax, bx),
        Math.min(ay, by),
        Math.max(ay, by),
      ];
      // Um item de texto pode conter várias palavras (o link é só uma delas): recorta pela posição
      // horizontal do link e alarga até as fronteiras de palavra.
      const labelParts: { x: number; text: string }[] = [];
      for (const item of visible) {
        const ix = item.transform[4] ?? 0;
        const cy = (item.transform[5] ?? 0) + item.height / 2;
        if (
          cy < y0 - 1 ||
          cy > y1 + 1 ||
          ix + item.width < x0 - 1 ||
          ix > x1 + 1 ||
          item.width <= 0
        )
          continue;
        // Palavras do item cujo CENTRO (posição proporcional) cai dentro do retângulo do link.
        const length = item.str.length;
        const inside: string[] = [];
        for (const word of item.str.matchAll(/[^\s|]+/g)) {
          const center = ix + ((word.index + word[0].length / 2) / length) * item.width;
          if (center >= x0 - 1 && center <= x1 + 1) inside.push(word[0]);
        }
        if (inside.length > 0) labelParts.push({ x: ix, text: inside.join(' ') });
      }
      const under = labelParts.sort((a, b) => a.x - b.x);
      links.push({
        page: pageNumber,
        url: annotation.url,
        label: under
          .map((item) => item.text)
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
      });
    }
  }

  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    label,
    bytes: bytes.length,
    pages: doc.numPages,
    lines,
    links,
    extractor: { name: 'pdfjs-dist', version: pdfjs.version },
  };
}

export async function extractPdf(path: string): Promise<PdfExtraction> {
  return extractPdfBytes(readFileSync(path), basename(path));
}
