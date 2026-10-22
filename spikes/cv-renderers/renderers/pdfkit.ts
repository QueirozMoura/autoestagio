/** Renderizador A: PDFKit (JavaScript puro). Layout imperativo, fonte Lato embutida, PDF "tagged". */
import { createWriteStream } from 'node:fs';
import PDFDocument from 'pdfkit';
import { DESIGN, type Doc, type Link } from '../view.ts';

const FIXED_DATE = new Date('2026-10-22T12:00:00Z');

export interface Result {
  pages: number;
  /** Quanto o conteúdo passou do fim da primeira página (pt); 0 = coube. */
  overflowPt: number;
}

export async function renderPdfkit(
  doc: Doc,
  outFile: string,
  options: {
    linksMode?: 'url' | 'label';
    tagged?: boolean;
    ligatures?: boolean;
    dates?: 'right' | 'inline';
  } = {},
): Promise<Result> {
  const linksMode = options.linksMode ?? 'url';
  const tagged = options.tagged ?? true;
  const ligatures = options.ligatures ?? true;
  const dates = options.dates ?? 'right';
  const { page, margin, size, color } = DESIGN;
  const pdf = new PDFDocument({
    size: 'A4',
    margins: margin,
    bufferPages: true,
    lang: doc.lang,
    displayTitle: true,
    pdfVersion: '1.7',
    tagged,
    info: {
      Title: doc.title,
      Author: doc.name,
      Subject: 'Currículo',
      Producer: 'AutoEstagio',
      Creator: 'AutoEstagio',
      CreationDate: FIXED_DATE,
      ModDate: FIXED_DATE,
    },
  });
  if (!ligatures) {
    // Desliga ligaduras (liga/clig) em toda chamada de texto e de medida.
    const noLiga = { liga: false, clig: false, dlig: false };
    const patch = (name: 'text' | 'heightOfString') => {
      const original = (pdf as any)[name].bind(pdf);
      (pdf as any)[name] = (value: string, ...args: any[]) => {
        const last = args[args.length - 1];
        if (last !== null && typeof last === 'object')
          args[args.length - 1] = { ...last, features: noLiga };
        else args.push({ features: noLiga });
        return original(value, ...args);
      };
    };
    patch('text');
    patch('heightOfString');
  }
  pdf.registerFont('R', DESIGN.fontFiles.regular);
  pdf.registerFont('B', DESIGN.fontFiles.bold);
  pdf.registerFont('I', DESIGN.fontFiles.italic);
  const out = createWriteStream(outFile);
  pdf.pipe(out);

  const left = margin.left;
  const width = page.width - margin.left - margin.right;
  const root = tagged ? pdf.struct('Document') : undefined;
  if (root) pdf.addStructure(root);

  /** Executa `draw` dentro de um elemento de estrutura (PDF tagged), se habilitado. */
  const tag = (type: string, draw: (parent?: unknown) => void, parent: any = root): any => {
    if (!tagged || !parent) {
      draw();
      return undefined;
    }
    const el = pdf.struct(type, {}, () => draw(el));
    parent.add(el);
    return el;
  };

  const text = (
    value: string,
    font: 'R' | 'B' | 'I',
    fontSize: number,
    fill: string,
    opts: Record<string, unknown> = {},
  ): void => {
    pdf.font(font).fontSize(fontSize).fillColor(fill).text(value, left, pdf.y, opts);
  };

  /**
   * Desenha uma lista de links em linhas que quebram sozinhas, com UMA anotação de link por item.
   * (`continued: true` + `link` perde anotações quando há mais de um link: por isso o desenho é manual.)
   */
  const drawLinks = (
    links: Link[],
    fontSize: number,
    prefix = '',
    fill: string = color.accent,
  ): void => {
    const sep = '  |  ';
    let x = left;
    let y = pdf.y;
    const lineH = fontSize * 1.25;
    const draw = (value: string, font: 'R' | 'B', col: string): { w: number } => {
      pdf.font(font).fontSize(fontSize).fillColor(col);
      const w = pdf.widthOfString(value);
      if (x + w > left + width && x > left) {
        x = left;
        y += lineH;
      }
      pdf.text(value, x, y, { lineBreak: false });
      const at = { x, w };
      x += w;
      return at;
    };
    if (prefix !== '') draw(prefix, 'R', color.muted);
    links.forEach((l, i) => {
      if (i > 0) draw(sep, 'R', color.muted);
      const label =
        linksMode === 'url' ? `${l.label}${prefix === '' ? ': ' : ' '}${l.url}` : l.label;
      const startX = x;
      const { w } = draw(label, 'R', fill);
      const placedX = x - w > startX - 0.01 ? x - w : left; // se quebrou de linha, começou em `left`
      pdf.link(placedX, y, w, fontSize * 1.2, l.url);
    });
    pdf.y = y + lineH;
    pdf.x = left;
  };

  // Cabeçalho.
  tag('H1', () => text(doc.name, 'B', size.name, color.text, { width }));
  tag('P', () => text(doc.headline.text, 'R', size.headline, color.accent, { width }));
  tag('P', () =>
    text(doc.contact.map((c) => c.text).join('  |  '), 'R', size.contact, color.muted, { width }),
  );
  tag('P', () => {
    drawLinks(doc.links, size.contact);
  });
  pdf.moveDown(0.5);

  for (const section of doc.sections) {
    pdf.moveDown(0.35);
    tag('H2', () =>
      text(section.heading, 'B', size.heading, color.accent, { width, characterSpacing: 0.3 }),
    );
    const y = pdf.y + 1;
    pdf
      .moveTo(left, y)
      .lineTo(left + width, y)
      .lineWidth(0.6)
      .strokeColor(color.accent)
      .stroke();
    pdf.y = y + 3;

    for (const item of section.items) {
      if (item.type === 'paragraph') {
        tag('P', () =>
          text(item.text, 'R', size.body, color.text, { width, align: 'left', lineGap: 1.2 }),
        );
        pdf.moveDown(0.25);
      } else if (item.type === 'kv') {
        tag('P', () => {
          pdf
            .font('B')
            .fontSize(size.body)
            .fillColor(color.text)
            .text(`${item.label}: `, left, pdf.y, { continued: true, width });
          pdf.font('R').text(item.text, { lineGap: 1.2 });
        });
      } else if (item.type === 'edu') {
        tag('P', () => {
          pdf
            .font('B')
            .fontSize(size.body)
            .fillColor(color.text)
            .text(item.title, left, pdf.y, { continued: true, width });
          pdf.font('R').text(`  |  ${item.status}`);
        });
        pdf.moveDown(0.1);
      } else {
        // Entrada: título (negrito) à esquerda e período à direita, na mesma linha.
        const periodWidth = 70;
        tag('H3', () => {
          if (dates === 'inline') {
            pdf
              .font('B')
              .fontSize(size.body)
              .fillColor(color.text)
              .text(item.title, left, pdf.y, { continued: true, width });
            // Mesma linha, mesmo tamanho de fonte: o Ghostscript inverte a ordem quando os tamanhos diferem.
            pdf.font('R').fontSize(size.body).fillColor(color.muted).text(`  |  ${item.period}`);
            return;
          }
          const y0 = pdf.y;
          pdf
            .font('B')
            .fontSize(size.body)
            .fillColor(color.text)
            .text(item.title, left, y0, { width: width - periodWidth - 8 });
          const y1 = pdf.y;
          pdf
            .font('R')
            .fontSize(size.small)
            .fillColor(color.muted)
            .text(item.period, left, y0, { width, align: 'right' });
          pdf.y = y1;
        });
        if (tagged && root) {
          const list = pdf.struct('L');
          root.add(list);
          for (const b of item.bullets) {
            const li = pdf.struct('LI');
            list.add(li);
            const y0 = pdf.y;
            const h = pdf
              .font('R')
              .fontSize(size.body)
              .heightOfString(b.text, { width: width - 14, lineGap: 1.2 });
            li.add(
              pdf.struct('Lbl', {}, () =>
                pdf
                  .font('R')
                  .fontSize(size.body)
                  .fillColor(color.text)
                  .text('•', left + 4, y0, { lineBreak: false }),
              ),
            );
            li.add(
              pdf.struct('LBody', {}, () =>
                pdf
                  .font('R')
                  .fontSize(size.body)
                  .fillColor(color.text)
                  .text(b.text, left + 14, y0, { width: width - 14, lineGap: 1.2 }),
              ),
            );
            pdf.y = y0 + h + 1.5;
          }
        } else {
          for (const b of item.bullets) {
            const y0 = pdf.y;
            const h = pdf
              .font('R')
              .fontSize(size.body)
              .heightOfString(b.text, { width: width - 14, lineGap: 1.2 });
            pdf
              .font('R')
              .fontSize(size.body)
              .fillColor(color.text)
              .text('•', left + 4, y0, { lineBreak: false });
            pdf.text(b.text, left + 14, y0, { width: width - 14, lineGap: 1.2 });
            pdf.y = y0 + h + 1.5;
          }
        }
        if (item.techs !== '')
          tag('P', () => text(item.techs, 'I', size.small, color.muted, { width, indent: 0 }));
        if (item.links.length > 0)
          tag('P', () => {
            drawLinks(item.links, size.small, 'Links: ');
          });
        pdf.moveDown(0.3);
      }
    }
  }

  const range = pdf.bufferedPageRange();
  const overflow = range.count > 1 ? pdf.y : 0;
  pdf.end();
  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return { pages: range.count, overflowPt: overflow };
}
