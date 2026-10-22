/** Renderizador B: HTML semântico + CSS, convertido por WeasyPrint (Python). Mesmo design, mesma fonte. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { DESIGN, type Doc, type Link } from '../view.ts';

const esc = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function buildHtml(doc: Doc, linksMode: 'url' | 'label', ligatures = true, dates: 'right' | 'inline' = 'right'): string {
  const { size, color, margin, fontFiles } = DESIGN;
  const link = (l: Link, sep: string): string =>
    `<a href="${esc(l.url)}">${esc(linksMode === 'url' ? `${l.label}${sep}${l.url}` : l.label)}</a>`;
  const body = doc.sections
    .map((section) => {
      const items = section.items
        .map((item) => {
          if (item.type === 'paragraph') return `<p class="par">${esc(item.text)}</p>`;
          if (item.type === 'kv') return `<p class="kv"><strong>${esc(item.label)}:</strong> ${esc(item.text)}</p>`;
          if (item.type === 'edu') return `<p class="kv"><strong>${esc(item.title)}</strong> &nbsp;|&nbsp; ${esc(item.status)}</p>`;
          return `<article class="entry">
  <h3 class="${dates}"><span class="t">${esc(item.title)}</span>${dates === 'inline' ? ' <span class="sep">|</span> ' : ''}<span class="period">${esc(item.period)}</span></h3>
  <ul>${item.bullets.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>
  ${item.techs === '' ? '' : `<p class="techs">${esc(item.techs)}</p>`}
  ${item.links.length === 0 ? '' : `<p class="links">Links: ${item.links.map((l) => link(l, ' ')).join(' &nbsp;|&nbsp; ')}</p>`}
</article>`;
        })
        .join('\n');
      return `<section><h2>${esc(section.heading)}</h2>\n${items}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="${doc.lang}"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<meta name="author" content="${esc(doc.name)}">
<style>
@font-face { font-family: 'LatoCV'; src: url('file://${fontFiles.regular}'); font-weight: 400; font-style: normal; }
@font-face { font-family: 'LatoCV'; src: url('file://${fontFiles.bold}'); font-weight: 700; font-style: normal; }
@font-face { font-family: 'LatoCV'; src: url('file://${fontFiles.italic}'); font-weight: 400; font-style: italic; }
@page { size: A4; margin: ${margin.top}pt ${margin.right}pt ${margin.bottom}pt ${margin.left}pt; }
html { font-family: 'LatoCV', sans-serif; font-size: ${size.body}pt; color: ${color.text}; line-height: 1.22; }
body { margin: 0; }
${ligatures ? '' : 'html { font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "dlig" 0; }'}
h1 { font-size: ${size.name}pt; margin: 0; line-height: 1.15; }
.headline { color: ${color.accent}; font-size: ${size.headline}pt; margin: 2pt 0 0; }
.contact, .toplinks { color: ${color.muted}; font-size: ${size.contact}pt; margin: 1pt 0 0; }
.toplinks a { color: ${color.accent}; }
section { margin-top: 7.5pt; }
h2 { font-size: ${size.heading}pt; color: ${color.accent}; letter-spacing: .3pt; border-bottom: .6pt solid ${color.accent}; margin: 0 0 3pt; padding-bottom: 1pt; }
a { color: ${color.accent}; text-decoration: none; }
.par { margin: 0 0 3pt; }
.kv { margin: 0; }
.entry { margin-bottom: 3pt; }
h3 { display: flex; justify-content: space-between; align-items: baseline; font-size: ${size.body}pt; margin: 0; }
h3 .t { font-weight: 700; padding-right: 8pt; }
h3.inline { display: block; }
h3.inline .t { padding-right: 0; }
h3.inline .sep, h3.inline .period { font-weight: 400; color: ${color.muted}; font-size: inherit; }
h3 .period { font-weight: 400; color: ${color.muted}; font-size: ${size.small}pt; white-space: nowrap; }
ul { margin: 0; padding-left: 0; list-style: none; }
li { margin: 0 0 1.5pt; padding-left: 9pt; text-indent: -9pt; }
li::before { content: '•\\00a0\\00a0'; }
.techs { font-style: italic; color: ${color.muted}; font-size: ${size.small}pt; margin: 0; }
.links { color: ${color.muted}; font-size: ${size.small}pt; margin: 0; }
</style></head><body>
<header>
<h1>${esc(doc.name)}</h1>
<p class="headline">${esc(doc.headline.text)}</p>
<p class="contact">${doc.contact.map((c) => esc(c.text)).join(' &nbsp;|&nbsp; ')}</p>
<p class="toplinks">${doc.links.map((l) => link(l, ': ')).join(' &nbsp;|&nbsp; ')}</p>
</header>
${body}
</body></html>`;
}

export function renderWeasyprint(doc: Doc, outFile: string, options: { linksMode?: 'url' | 'label'; tagged?: boolean; ligatures?: boolean; dates?: 'right' | 'inline' } = {}): void {
  const htmlFile = outFile.replace(/\.pdf$/, '.html');
  writeFileSync(htmlFile, buildHtml(doc, options.linksMode ?? 'url', options.ligatures ?? true, options.dates ?? 'right'));
  const py = new URL('../.venv/bin/python', import.meta.url).pathname;
  const script = `
import sys, weasyprint
html, out, tagged = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
kwargs = {'pdf_variant': 'pdf/ua-1'} if tagged else {}
weasyprint.HTML(filename=html).write_pdf(out, **kwargs)
`;
  execFileSync(py, ['-I', '-c', script, htmlFile, outFile, options.tagged === false ? '0' : '1'], {
    env: { ...process.env, SOURCE_DATE_EPOCH: '1792670400' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
