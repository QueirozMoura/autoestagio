import { clip, result, type CheckResult } from './checks.js';
import type { Expected } from './expected.js';
import type { ExtractedPdf, LinkAnnotation, TextRun } from './extract.js';
import { squash } from './normalize.js';
import type { PageInfo } from './pdf-objects.js';
import type { LayoutConfig } from '../render/layout.js';
import { MIN_BODY_PT } from '../render/layout.js';

/**
 * H9 — geometria e conteúdo fora das margens.
 *
 * As tolerâncias são pequenas e existem por motivos concretos (documentados aqui e no relatório):
 *  - `TOLERANCE_PT` (2 pt): o pdfjs mede a altura do texto pela fonte (ascendente), que passa cerca de 0,2 pt da
 *    margem sem que nada saia da área útil;
 *  - `PAGE_SIZE_PT` (0,1 pt): o PDFKit grava 595.28 × 841.89 (A4) com arredondamento;
 *  - `FONT_TOLERANCE_PT` (0,1 pt): a escala de fonte é uma multiplicação em ponto flutuante;
 *  - `SAME_LINE_OVERLAP_PT` (4 pt): o pdfjs parte o texto de uma linha em trechos que se tocam ou se sobrepõem
 *    um pouco ("https:/" + "/www…"), o que não é sobreposição visual;
 *  - `LINK_VERTICAL_TOLERANCE_PT` (4 pt): a área clicável desce um pouco abaixo da linha de base, onde ficam as
 *    letras com cauda, e pode tocar a margem inferior;
 *  - `MAX_LINK_HEIGHT_PT` (30 pt): uma área clicável maior que duas linhas de texto é suspeita (link "invisível"
 *    sobre o conteúdo).
 */
export const GEOMETRY = {
  TOLERANCE_PT: 2,
  PAGE_SIZE_PT: 0.1,
  FONT_TOLERANCE_PT: 0.1,
  SAME_LINE_OVERLAP_PT: 4,
  LINK_VERTICAL_TOLERANCE_PT: 4,
  MAX_LINK_HEIGHT_PT: 30,
  MIN_LINK_WIDTH_PT: 8,
  MIN_LINK_HEIGHT_PT: 6,
} as const;

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

export interface GeometryInput {
  extracted: ExtractedPdf;
  expected: Expected;
  layout: LayoutConfig;
  /** Páginas lidas da estrutura; ausente quando `structureError` explica por quê (falha fechada). */
  pages: PageInfo[] | undefined;
  structureError: string | undefined;
}

export function checkGeometry(input: GeometryInput): CheckResult {
  const { extracted, expected, layout, pages, structureError } = input;
  const problems: string[] = [];
  const { page: size, margin } = layout;
  const left = margin.left;
  const right = size.width - margin.right;
  const bottom = margin.bottom;
  const top = size.height - margin.top;
  const tol = GEOMETRY.TOLERANCE_PT;

  // --- Formato de cada página (pdfjs e estrutura)
  extracted.pageViews.forEach((p, i) => {
    const [x1, y1, x2, y2] = p.view;
    if (
      !near(x1, 0, GEOMETRY.PAGE_SIZE_PT) ||
      !near(y1, 0, GEOMETRY.PAGE_SIZE_PT) ||
      !near(x2 - x1, size.width, GEOMETRY.PAGE_SIZE_PT) ||
      !near(y2 - y1, size.height, GEOMETRY.PAGE_SIZE_PT)
    )
      problems.push(
        `página ${i + 1}: ${(x2 - x1).toFixed(2)} × ${(y2 - y1).toFixed(2)} pt em vez de ${size.width} × ${size.height} (A4)`,
      );
    if (p.rotate !== 0) problems.push(`página ${i + 1} rotacionada em ${p.rotate}°`);
    if (p.userUnit !== 1) problems.push(`página ${i + 1} com UserUnit ${p.userUnit}`);
  });
  if (pages === undefined)
    problems.push(
      `não foi possível conferir MediaBox e demais caixas: ${structureError ?? 'estrutura ilegível'}`,
    );
  else {
    if (pages.length !== extracted.pages)
      problems.push(`a estrutura tem ${pages.length} página(s) e o pdfjs ${extracted.pages}`);
    pages.forEach((p, i) => {
      const box = p.mediaBox;
      if (box === undefined || box.length !== 4) problems.push(`página ${i + 1} sem MediaBox`);
      else {
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = box;
        if (
          !near(x1, 0, GEOMETRY.PAGE_SIZE_PT) ||
          !near(y1, 0, GEOMETRY.PAGE_SIZE_PT) ||
          !near(x2, size.width, GEOMETRY.PAGE_SIZE_PT) ||
          !near(y2, size.height, GEOMETRY.PAGE_SIZE_PT)
        )
          problems.push(
            `página ${i + 1}: MediaBox [${box.join(' ')}] diferente de [0 0 ${size.width} ${size.height}]`,
          );
      }
      if (
        p.cropBox !== undefined &&
        (p.mediaBox === undefined ||
          p.cropBox.some((v, k) => !near(v, p.mediaBox?.[k] ?? NaN, GEOMETRY.PAGE_SIZE_PT)))
      )
        problems.push(
          `página ${i + 1}: CropBox diferente do MediaBox (esconderia parte do conteúdo)`,
        );
      if (p.extraBoxes.length > 0)
        problems.push(`página ${i + 1}: caixas extras (${p.extraBoxes.join(', ')})`);
    });
  }

  // --- Texto dentro das margens e com tamanho legível
  const outside: string[] = [];
  const small: string[] = [];
  const offender = (run: TextRun, what: string): string =>
    `p.${run.page} "${clip(run.text, 28)}" ${what}`;
  for (const run of extracted.runs) {
    if (run.x < left - tol)
      outside.push(offender(run, `${(left - run.x).toFixed(1)} pt além da margem esquerda`));
    if (run.x + run.width > right + tol)
      outside.push(
        offender(run, `${(run.x + run.width - right).toFixed(1)} pt além da margem direita`),
      );
    if (run.y < bottom - tol)
      outside.push(offender(run, `${(bottom - run.y).toFixed(1)} pt abaixo da margem inferior`));
    if (run.y + run.height > top + tol)
      outside.push(
        offender(run, `${(run.y + run.height - top).toFixed(1)} pt acima da margem superior`),
      );
    if (run.height < MIN_BODY_PT - GEOMETRY.FONT_TOLERANCE_PT)
      small.push(
        offender(run, `com fonte de ${run.height.toFixed(2)} pt (mínimo ${MIN_BODY_PT} pt)`),
      );
  }
  if (outside.length > 0)
    problems.push(
      `${outside.length} trecho(s) fora das margens (tolerância ${tol} pt): ${outside.slice(0, 4).join('; ')}`,
    );
  if (small.length > 0)
    problems.push(
      `${small.length} trecho(s) com fonte pequena demais: ${small.slice(0, 4).join('; ')}`,
    );

  // --- Sobreposição de texto (linhas diferentes que se cobrem)
  const overlapping: string[] = [];
  for (let i = 0; i < extracted.runs.length; i++) {
    const a = extracted.runs[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < extracted.runs.length; j++) {
      const b = extracted.runs[j];
      if (b === undefined || b.page !== a.page) continue;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      if (overlapX <= GEOMETRY.SAME_LINE_OVERLAP_PT) continue;
      const aBox: [number, number] = [a.y - 0.2 * a.height, a.y + 0.8 * a.height];
      const bBox: [number, number] = [b.y - 0.2 * b.height, b.y + 0.8 * b.height];
      const overlapY = Math.min(aBox[1], bBox[1]) - Math.max(aBox[0], bBox[0]);
      if (overlapY > 0.3 * Math.min(a.height, b.height))
        overlapping.push(`p.${a.page} "${clip(a.text, 22)}" sobre "${clip(b.text, 22)}"`);
    }
  }
  if (overlapping.length > 0)
    problems.push(
      `${overlapping.length} sobreposição(ões) de texto: ${overlapping.slice(0, 3).join('; ')}`,
    );

  // --- Título órfão: a última linha de uma página nunca é título de seção ou de entrada
  const headings = new Set(
    expected.blocks.filter((b) => b.kind === 'heading').map((b) => squash(b.text)),
  );
  const entryTitles = new Set<string>();
  expected.blocks.forEach((b, i) => {
    if (b.kind !== 'entry-title') return;
    entryTitles.add(squash(b.text));
    const next = expected.blocks[i + 1];
    if (next?.kind === 'period') entryTitles.add(squash(b.text) + squash(next.text));
  });
  for (let page = 1; page <= extracted.pages; page++) {
    const last = extracted.pageLines.filter((l) => l.page === page).at(-1);
    if (last === undefined) continue;
    const text = squash(last.text);
    if (headings.has(text))
      problems.push(`título de seção órfão no fim da página ${page}: "${clip(last.text)}"`);
    else if (entryTitles.has(text))
      problems.push(`título de entrada órfão no fim da página ${page}: "${clip(last.text)}"`);
  }

  // --- Áreas clicáveis
  const byPage = new Map<number, LinkAnnotation[]>();
  for (const a of extracted.annotations) byPage.set(a.page, [...(byPage.get(a.page) ?? []), a]);
  for (const a of extracted.annotations) {
    const [x1, y1, x2, y2] = a.rect;
    const label = clip(a.url ?? '(sem endereço)', 40);
    const vertical = GEOMETRY.LINK_VERTICAL_TOLERANCE_PT;
    if (x1 < left - tol || x2 > right + tol || y1 < bottom - vertical || y2 > top + tol)
      problems.push(
        `área clicável de ${label} fora das margens (x ${x1.toFixed(0)}–${x2.toFixed(0)}, y ${y1.toFixed(0)}–${y2.toFixed(0)})`,
      );
    if (x2 - x1 < GEOMETRY.MIN_LINK_WIDTH_PT || y2 - y1 < GEOMETRY.MIN_LINK_HEIGHT_PT)
      problems.push(
        `área clicável de ${label} pequena demais (${(x2 - x1).toFixed(1)} × ${(y2 - y1).toFixed(1)} pt)`,
      );
    if (y2 - y1 > GEOMETRY.MAX_LINK_HEIGHT_PT || x2 - x1 > right - left + tol)
      problems.push(
        `área clicável de ${label} grande demais (${(x2 - x1).toFixed(0)} × ${(y2 - y1).toFixed(0)} pt): suspeita de link invisível sobre o conteúdo`,
      );
    const hasText = extracted.runs.some(
      (r) => r.page === a.page && r.y >= y1 - 2 && r.y <= y2 + 2 && r.x < x2 && r.x + r.width > x1,
    );
    if (!hasText) problems.push(`área clicável de ${label} sem texto por baixo`);
  }
  for (const [page, list] of byPage) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a === undefined || b === undefined) continue;
        const w = Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0]);
        const h = Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]);
        if (w > 1 && h > 1)
          problems.push(
            `áreas clicáveis sobrepostas na página ${page}: ${clip(a.url ?? '?', 30)} e ${clip(b.url ?? '?', 30)}`,
          );
      }
    }
  }

  return result(
    'H9',
    'geometria e conteúdo fora das margens',
    problems,
    `${extracted.pages} página(s) A4, texto dentro das margens (±${tol} pt), fontes ≥ ${MIN_BODY_PT} pt, sem sobreposição nem título órfão, ${extracted.annotations.length} área(s) clicável(is) válidas`,
  );
}
