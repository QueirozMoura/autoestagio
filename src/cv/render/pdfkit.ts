import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { ResolvedEntry, ResolvedLink, ResolvedResume, ResolvedSection } from '../resolve.js';
import {
  headingText,
  linkText,
  linksLabel,
  skillParts,
  technologiesLabel,
  technologiesText,
  tidyResume,
} from './content.js';
import { FontLoadError, loadFonts, type FontSet } from './fonts.js';
import {
  layoutProblems,
  mergeLayout,
  type FitStep,
  type LayoutConfig,
  type LayoutOverrides,
} from './layout.js';

/**
 * Etapa 4.3 (fatia 1) — renderização do currículo resolvido com PDFKit.
 *
 * Entrada ÚNICA: um `ResolvedResume`. Este módulo não importa o modelo mestre, não lê o PDF mestre, não acessa
 * banco nem rede e não grava arquivo: devolve os bytes em memória. Todo texto do PDF vem do `ResolvedResume`
 * (mais os rótulos estruturais do layout, como "Tecnologias:" e os títulos de seção fixos).
 *
 * Regras de leitura por ATS (docs/CV_RENDERER_SPIKE.md §4): uma coluna, sem tabelas nem imagens, fonte Lato
 * embutida, sem ligaduras, `•` real, data na linha do título com `|`, mesmo tamanho de fonte na mesma linha,
 * URLs visíveis e clicáveis, PDF "tagged" e metadados fixos. Nunca remove, resume ou inventa conteúdo para
 * caber: só reduz tipografia e espaçamento dentro de limites seguros; se não couber, falha de forma controlada.
 */

export type RenderErrorCode =
  'INVALID_LAYOUT' | 'FONT_MISSING' | 'OVERFLOW' | 'UNBREAKABLE_SEGMENT';

/** Falha controlada: nenhum PDF parcial é devolvido. */
export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface RenderOptions {
  layout?: LayoutOverrides;
}

export interface RenderResult {
  /** O PDF, em memória. Nada é gravado em disco. */
  bytes: Buffer;
  pdfSha256: string;
  pages: number;
  fit: {
    /** Índice do degrau de ajuste usado (0 = layout declarado, sem redução). */
    stepIndex: number;
    step: FitStep;
    /** Quantas renderizações de teste foram feitas para escolher o degrau. */
    attempts: number;
  };
  /** `manifest.contentSha256` do currículo resolvido: liga o PDF ao conteúdo de origem. */
  sourceContentSha256: string;
}

// ------------------------------------------------------------------ utilidades

type FontKey = 'R' | 'B';
type TextOptions = PDFKit.Mixins.TextOptions;

/** Desliga ligaduras (a fonte Lato tem "fi", "fl"…): evita glifos que alguns extratores não decompõem. */
const NO_LIGATURES = {
  liga: false,
  clig: false,
  dlig: false,
} as unknown as TextOptions['features'];

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

interface Pass {
  pages: number;
  bytes: Buffer;
}

interface Unit {
  /** Separador antes do item (omitido quando o item abre uma linha). */
  separator?: string;
  text: string;
  font: FontKey;
  color: string;
  url?: string;
}

// ------------------------------------------------------------------ uma renderização

async function renderPass(
  resume: ResolvedResume,
  layout: LayoutConfig,
  step: FitStep,
  fonts: FontSet,
): Promise<Pass> {
  const fs = (pt: number): number => pt * step.font;
  const sp = (pt: number): number => pt * step.space;
  const size = {
    name: fs(layout.size.name),
    headline: fs(layout.size.headline),
    contact: fs(layout.size.contact),
    heading: fs(layout.size.heading),
    body: fs(layout.size.body),
  };
  const gap = {
    section: sp(layout.spacing.section),
    afterHeading: sp(layout.spacing.afterHeading),
    line: sp(layout.spacing.line),
    bullet: sp(layout.spacing.bullet),
    entry: sp(layout.spacing.entry),
    paragraph: sp(layout.spacing.paragraph),
  };
  const { page, margin, color } = layout;
  const left = margin.left;
  const width = page.width - margin.left - margin.right;
  const right = left + width;
  const bottom = page.height - margin.bottom;
  const title = `${resume.header.name} — ${layout.metadata.subject}`;

  const pdf = new PDFDocument({
    size: [page.width, page.height],
    // Margem inferior 0: a quebra de página é feita por nós (ensure), nunca automática no meio de um bloco.
    margins: { top: margin.top, bottom: 0, left: margin.left, right: margin.right },
    bufferPages: true,
    lang: resume.language,
    displayTitle: true,
    pdfVersion: '1.7',
    tagged: true,
    info: {
      Title: title,
      Author: resume.header.name,
      Subject: layout.metadata.subject,
      Producer: layout.metadata.producer,
      Creator: layout.metadata.creator,
      CreationDate: layout.metadata.date,
      ModDate: layout.metadata.date,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  pdf.registerFont('R', fonts.regular);
  pdf.registerFont('B', fonts.bold);

  const root = pdf.struct('Document');
  pdf.addStructure(root);
  /** Desenha dentro de um elemento de estrutura (PDF tagged). */
  const tag = (type: string, draw: () => void, parent: PDFKit.PDFStructureElement = root): void => {
    parent.add(pdf.struct(type, {}, draw));
  };

  const measure = (text: string, font: FontKey, pt: number, w: number): number =>
    pdf
      .font(font)
      .fontSize(pt)
      .heightOfString(text, { width: w, lineGap: gap.line, features: NO_LIGATURES });
  /** Garante `h` pt livres na página; senão abre outra (nunca parte um bloco no meio). */
  const ensure = (h: number): void => {
    if (pdf.y + h > bottom) pdf.addPage();
  };

  const paragraph = (
    type: string,
    text: string,
    font: FontKey,
    pt: number,
    fill: string,
    after = gap.paragraph,
  ): void => {
    ensure(measure(text, font, pt, width));
    tag(type, () => {
      pdf
        .font(font)
        .fontSize(pt)
        .fillColor(fill)
        .text(text, left, pdf.y, { width, lineGap: gap.line, features: NO_LIGATURES });
    });
    pdf.y += after;
  };

  /** "Rótulo: texto" com o rótulo em negrito. */
  const labelled = (label: string, text: string): void => {
    const full = `${label} ${text}`;
    ensure(measure(full, 'B', size.body, width));
    tag('P', () => {
      pdf
        .font('B')
        .fontSize(size.body)
        .fillColor(color.text)
        .text(label, left, pdf.y, { continued: true, width, features: NO_LIGATURES });
      pdf
        .font('R')
        .fontSize(size.body)
        .text(` ${text}`, { lineGap: gap.line, features: NO_LIGATURES });
    });
    pdf.y += gap.paragraph;
  };

  /**
   * Linha de itens que quebra entre itens, nunca dentro deles (e-mail, telefone e URL ficam inteiros).
   * Cada item pode ser um link clicável (uma anotação por item).
   */
  const inline = (units: Unit[], pt: number): void => {
    const lineH = pt * 1.25;
    interface Placed {
      unit: Unit;
      x: number;
      line: number;
      withSeparator: boolean;
    }
    const placed: Placed[] = [];
    let x = left;
    let line = 0;
    const widthOf = (text: string, font: FontKey): number =>
      pdf.font(font).fontSize(pt).widthOfString(text, { features: NO_LIGATURES });
    units.forEach((unit, index) => {
      const itemW = widthOf(unit.text, unit.font);
      if (itemW > width)
        throw new RenderError(
          'UNBREAKABLE_SEGMENT',
          'Um item da linha é mais largo que a área útil da página.',
          [unit.text.slice(0, 60)],
        );
      const sepW = index > 0 && unit.separator !== undefined ? widthOf(unit.separator, 'R') : 0;
      if (x + sepW + itemW > right && x > left) {
        x = left;
        line += 1;
        placed.push({ unit, x, line, withSeparator: false });
        x += itemW;
        return;
      }
      placed.push({ unit, x, line, withSeparator: sepW > 0 });
      x += sepW + itemW;
    });
    ensure((line + 1) * lineH);
    const y0 = pdf.y;
    tag('P', () => {
      for (const p of placed) {
        const y = y0 + p.line * lineH;
        let at = p.x;
        if (p.withSeparator && p.unit.separator !== undefined) {
          pdf
            .font('R')
            .fontSize(pt)
            .fillColor(color.muted)
            .text(p.unit.separator, at, y, { lineBreak: false, features: NO_LIGATURES });
          at += widthOf(p.unit.separator, 'R');
        }
        pdf
          .font(p.unit.font)
          .fontSize(pt)
          .fillColor(p.unit.color)
          .text(p.unit.text, at, y, { lineBreak: false, features: NO_LIGATURES });
        if (p.unit.url !== undefined)
          pdf.link(at, y, widthOf(p.unit.text, p.unit.font), pt * 1.2, p.unit.url);
      }
    });
    pdf.y = y0 + (line + 1) * lineH;
    pdf.x = left;
  };

  const linkUnits = (links: ResolvedLink[]): Unit[] =>
    links.map((l) => ({
      separator: '  |  ',
      text: linkText(l),
      font: 'R',
      color: color.accent,
      url: l.url,
    }));

  const heading = (label: string, firstBlockHeight: number): void => {
    const text = headingText(label);
    const h = measure(text, 'B', size.heading, width) + gap.afterHeading + 3;
    // Título nunca fica sozinho no fim da página: leva junto o primeiro bloco.
    ensure(h + firstBlockHeight);
    if (pdf.y > margin.top + 1) pdf.y += gap.section;
    tag('H2', () => {
      pdf
        .font('B')
        .fontSize(size.heading)
        .fillColor(color.accent)
        .text(text, left, pdf.y, { width, characterSpacing: 0.3, features: NO_LIGATURES });
    });
    if (layout.headingRule) {
      const y = pdf.y + 1;
      pdf.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(color.accent).stroke();
      pdf.y = y;
    }
    pdf.y += gap.afterHeading;
  };

  const bulletHeight = (text: string): number =>
    measure(text, 'R', size.body, width - layout.bulletIndent);

  const entry = (item: ResolvedEntry): void => {
    const heading3 = item.period === undefined ? item.title : `${item.title}  |  ${item.period}`;
    const firstBullet = item.bullets[0];
    // Título da entrada leva junto o primeiro bullet.
    ensure(
      measure(heading3, 'B', size.body, width) + (firstBullet ? bulletHeight(firstBullet) : 0),
    );
    tag('H3', () => {
      pdf
        .font('B')
        .fontSize(size.body)
        .fillColor(color.text)
        .text(item.title, left, pdf.y, {
          continued: item.period !== undefined,
          width,
          features: NO_LIGATURES,
        });
      // Mesma linha, mesmo tamanho de fonte (evita inversão de ordem em alguns extratores).
      if (item.period !== undefined)
        pdf
          .font('R')
          .fontSize(size.body)
          .fillColor(color.muted)
          .text(`  |  ${item.period}`, { features: NO_LIGATURES });
    });
    pdf.y += gap.bullet;

    const list = pdf.struct('L');
    root.add(list);
    for (const text of item.bullets) {
      const h = bulletHeight(text);
      ensure(h);
      const y0 = pdf.y;
      const li = pdf.struct('LI');
      list.add(li);
      li.add(
        pdf.struct('Lbl', {}, () => {
          pdf
            .font('R')
            .fontSize(size.body)
            .fillColor(color.text)
            .text('•', left + 4, y0, { lineBreak: false, features: NO_LIGATURES });
        }),
      );
      li.add(
        pdf.struct('LBody', {}, () => {
          pdf
            .font('R')
            .fontSize(size.body)
            .fillColor(color.text)
            .text(text, left + layout.bulletIndent, y0, {
              width: width - layout.bulletIndent,
              lineGap: gap.line,
              features: NO_LIGATURES,
            });
        }),
      );
      pdf.y = y0 + h + gap.bullet;
    }
    if (item.technologies.length > 0)
      labelled(technologiesLabel(layout.labels), technologiesText(item));
    if (item.links.length > 0) {
      const units = linkUnits(item.links);
      const [first, ...rest] = units;
      if (first !== undefined)
        inline(
          [
            { text: linksLabel(layout.labels), font: 'B', color: color.text },
            { ...first, separator: ' ' },
            ...rest,
          ],
          size.body,
        );
    }
    pdf.y += gap.entry;
  };

  const section = (data: ResolvedSection): void => {
    const first = data.entries[0];
    if (first === undefined) return;
    // O título da seção leva junto o título da primeira entrada E o primeiro bullet (nunca fica órfão).
    const firstBullet = first.bullets[0];
    heading(
      data.title,
      measure(first.title, 'B', size.body, width) +
        (firstBullet === undefined ? 0 : bulletHeight(firstBullet)),
    );
    for (const item of data.entries) entry(item);
  };

  // ---------------------------------------------------------------- cabeçalho
  tag('H1', () => {
    pdf
      .font('B')
      .fontSize(size.name)
      .fillColor(color.text)
      .text(resume.header.name, left, margin.top, { width, features: NO_LIGATURES });
  });
  paragraph('P', resume.header.headline, 'R', size.headline, color.accent, gap.paragraph);
  const contact: Unit[] = [
    { text: resume.header.location, font: 'R', color: color.muted },
    ...resume.header.contacts.map<Unit>((c) => ({
      separator: '  |  ',
      text: c.value,
      font: 'R',
      color: color.muted,
    })),
  ];
  inline(contact, size.contact);
  if (resume.header.links.length > 0) inline(linkUnits(resume.header.links), size.contact);

  // ---------------------------------------------------------------- corpo
  heading(layout.labels.summary, measure(resume.summary, 'R', size.body, width));
  paragraph('P', resume.summary, 'R', size.body, color.text);

  section(resume.experience);
  section(resume.projects);

  if (resume.skills.length > 0) {
    const first = resume.skills[0];
    heading(layout.labels.skills, first ? measure(first.text, 'B', size.body, width) : 0);
    for (const skill of resume.skills) {
      const parts = skillParts(skill);
      if (parts.label !== undefined) labelled(parts.label, parts.body);
      else paragraph('P', parts.body, 'R', size.body, color.text);
    }
  }
  const plainSection = (label: string, lines: string[]): void => {
    const first = lines[0];
    if (first === undefined) return;
    heading(label, measure(first, 'R', size.body, width));
    for (const text of lines) paragraph('P', text, 'R', size.body, color.text);
  };
  plainSection(layout.labels.education, resume.education);
  plainSection(layout.labels.languages, resume.languages);
  plainSection(layout.labels.certifications, resume.certifications);

  const pages = pdf.bufferedPageRange().count;
  pdf.end();
  return { pages, bytes: await done };
}

// ------------------------------------------------------------------ API

/**
 * Renderiza o currículo resolvido. Escolhe o maior degrau de ajuste que cabe em `pages.preferred` páginas;
 * se nenhum couber, usa o maior degrau que caiba em `pages.max`; se nem esse existir, falha com `OVERFLOW`.
 * O texto nunca muda: só tipografia e espaçamento.
 */
export async function renderResume(
  input: ResolvedResume,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const resume = tidyResume(input);
  const layout = mergeLayout(options.layout);
  const problems = layoutProblems(layout);
  if (problems.length > 0) throw new RenderError('INVALID_LAYOUT', 'Layout inválido.', problems);
  let fonts: FontSet;
  try {
    fonts = loadFonts();
  } catch (error) {
    if (error instanceof FontLoadError) throw new RenderError('FONT_MISSING', error.message);
    throw error;
  }

  const passes: { index: number; step: FitStep; pass: Pass }[] = [];
  for (const [index, step] of layout.fit.entries()) {
    const pass = await renderPass(resume, layout, step, fonts);
    passes.push({ index, step, pass });
    if (pass.pages <= layout.pages.preferred)
      return result(resume, pass, index, step, passes.length);
  }
  const acceptable = passes.find((p) => p.pass.pages <= layout.pages.max);
  if (acceptable !== undefined)
    return result(resume, acceptable.pass, acceptable.index, acceptable.step, passes.length);

  const smallest = passes[passes.length - 1];
  throw new RenderError(
    'OVERFLOW',
    `O conteúdo não cabe em ${layout.pages.max} página(s) mesmo com os ajustes seguros de tipografia e espaçamento; nada foi removido nem resumido.`,
    [
      `páginas no menor degrau de ajuste: ${smallest?.pass.pages ?? 'n/d'}`,
      `limite: ${layout.pages.max}`,
      `tamanho mínimo do corpo: ${(layout.size.body * (smallest?.step.font ?? 1)).toFixed(2)} pt`,
    ],
  );
}

function result(
  resume: ResolvedResume,
  pass: Pass,
  stepIndex: number,
  step: FitStep,
  attempts: number,
): RenderResult {
  return {
    bytes: pass.bytes,
    pdfSha256: sha256(pass.bytes),
    pages: pass.pages,
    fit: { stepIndex, step, attempts },
    sourceContentSha256: resume.manifest.contentSha256,
  };
}
