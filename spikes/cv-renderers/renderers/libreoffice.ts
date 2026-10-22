/** Renderizador C: documento ODT (XML plano, .fodt) convertido por LibreOffice headless. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { DESIGN, type Doc, type Link } from '../view.ts';

const esc = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function buildFodt(doc: Doc, linksMode: 'url' | 'label', ligatures = true, dates: 'right' | 'inline' = 'right'): string {
  const { size, color, margin, page } = DESIGN;
  const contentWidth = (page.width - margin.left - margin.right).toFixed(2);
  const link = (l: Link, sep: string): string =>
    `<text:a xlink:type="simple" xlink:href="${esc(l.url)}" text:style-name="Lk" text:visited-style-name="Lk">${esc(linksMode === 'url' ? `${l.label}${sep}${l.url}` : l.label)}</text:a>`;
  const sepGap = '<text:s text:c="2"/>|<text:s text:c="2"/>';

  const body: string[] = [];
  body.push(`<text:h text:style-name="Name" text:outline-level="1">${esc(doc.name)}</text:h>`);
  body.push(`<text:p text:style-name="Headline">${esc(doc.headline.text)}</text:p>`);
  body.push(`<text:p text:style-name="Contact">${doc.contact.map((c) => esc(c.text)).join(sepGap)}</text:p>`);
  body.push(`<text:p text:style-name="ContactLinks">${doc.links.map((l) => link(l, ': ')).join(sepGap)}</text:p>`);
  for (const section of doc.sections) {
    body.push(`<text:h text:style-name="H2" text:outline-level="2">${esc(section.heading)}</text:h>`);
    for (const item of section.items) {
      if (item.type === 'paragraph') body.push(`<text:p text:style-name="Par">${esc(item.text)}</text:p>`);
      else if (item.type === 'kv') {
        body.push(`<text:p text:style-name="Kv"><text:span text:style-name="B">${esc(item.label)}: </text:span>${esc(item.text)}</text:p>`);
      } else if (item.type === 'edu') {
        body.push(`<text:p text:style-name="Kv"><text:span text:style-name="B">${esc(item.title)}</text:span><text:s text:c="2"/>|<text:s text:c="2"/>${esc(item.status)}</text:p>`);
      } else {
        body.push(`<text:p text:style-name="EntryTitle"><text:span text:style-name="B">${esc(item.title)}</text:span>${dates === 'inline' ? '<text:s text:c="2"/>|<text:s text:c="2"/>' : '<text:tab/>'}<text:span text:style-name="Period">${esc(item.period)}</text:span></text:p>`);
        body.push(
          `<text:list text:style-name="Bul">${item.bullets.map((b) => `<text:list-item><text:p text:style-name="BulletP">${esc(b.text)}</text:p></text:list-item>`).join('')}</text:list>`,
        );
        if (item.techs !== '') body.push(`<text:p text:style-name="Techs">${esc(item.techs)}</text:p>`);
        if (item.links.length > 0) {
          body.push(`<text:p text:style-name="LinksP">Links: ${item.links.map((l) => link(l, ' ')).join(sepGap)}</text:p>`);
        }
      }
    }
  }

  const para = (name: string, props: string, text: string): string =>
    `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Base"><style:paragraph-properties ${props}/><style:text-properties ${text}/></style:style>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><dc:title>${esc(doc.title)}</dc:title><dc:creator>${esc(doc.name)}</dc:creator><dc:language>${doc.lang}</dc:language><meta:creation-date>2026-10-22T12:00:00</meta:creation-date></office:meta>
<office:font-face-decls><style:font-face style:name="Lato" svg:font-family="${ligatures ? 'Lato' : 'Lato:-liga'}"/></office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties style:font-name="Lato" fo:language="pt" fo:country="BR"/></style:default-style>
<style:style style:name="Base" style:family="paragraph"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:line-height="100%"/><style:text-properties style:font-name="Lato" fo:font-size="${size.body}pt" fo:color="${color.text}"/></style:style>
${para('Name', 'fo:margin-bottom="1pt"', `fo:font-size="${size.name}pt" fo:font-weight="bold"`)}
${para('Headline', 'fo:margin-top="1pt"', `fo:font-size="${size.headline}pt" fo:color="${color.accent}"`)}
${para('Contact', 'fo:margin-top="1pt"', `fo:font-size="${size.contact}pt" fo:color="${color.muted}"`)}
${para('ContactLinks', 'fo:margin-top="0pt"', `fo:font-size="${size.contact}pt" fo:color="${color.muted}"`)}
<style:style style:name="H2" style:family="paragraph" style:parent-style-name="Base" style:default-outline-level="2"><style:paragraph-properties fo:margin-top="5pt" fo:margin-bottom="2pt" fo:padding-bottom="1pt" fo:border-bottom="0.6pt solid ${color.accent}" fo:keep-with-next="always"/><style:text-properties fo:font-size="${size.heading}pt" fo:font-weight="bold" fo:color="${color.accent}" fo:letter-spacing="0.3pt"/></style:style>
${para('Par', 'fo:margin-bottom="3pt"', '')}
${para('Kv', '', '')}
<style:style style:name="EntryTitle" style:family="paragraph" style:parent-style-name="Base"><style:paragraph-properties fo:margin-top="3pt" fo:keep-with-next="always"><style:tab-stops><style:tab-stop style:position="${contentWidth}pt" style:type="right"/></style:tab-stops></style:paragraph-properties></style:style>
${para('BulletP', 'fo:margin-bottom="1.5pt"', '')}
${para('Techs', '', `fo:font-size="${size.small}pt" fo:font-style="italic" fo:color="${color.muted}"`)}
${para('LinksP', '', `fo:font-size="${size.small}pt" fo:color="${color.muted}"`)}
<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Period" style:family="text"><style:text-properties ${dates === 'inline' ? '' : `fo:font-size="${size.small}pt" `}fo:color="${color.muted}"/></style:style>
<style:style style:name="Lk" style:family="text"><style:text-properties fo:color="${color.accent}" style:text-underline-style="none"/></style:style>
<text:list-style style:name="Bul"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="10pt" fo:text-indent="-8pt" fo:margin-left="10pt"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>
</office:styles>
<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="${page.width}pt" fo:page-height="${page.height}pt" fo:margin-top="${margin.top}pt" fo:margin-bottom="${margin.bottom}pt" fo:margin-left="${margin.left}pt" fo:margin-right="${margin.right}pt"/></style:page-layout></office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
<office:body><office:text>
${body.join('\n')}
</office:text></office:body></office:document>`;
}

export function renderLibreOffice(doc: Doc, outFile: string, options: { linksMode?: 'url' | 'label'; tagged?: boolean; ligatures?: boolean; dates?: 'right' | 'inline' } = {}): void {
  const fodt = outFile.replace(/\.pdf$/, '.fodt');
  writeFileSync(fodt, buildFodt(doc, options.linksMode ?? 'url', options.ligatures ?? true, options.dates ?? 'right'));
  const profile = `/tmp/claude-1000/-home-gustavo-Documents-projects-autoestagio/8885e76d-ebc6-45db-a89c-ce05ece4cafa/scratchpad/lo-profile`;
  mkdirSync(profile, { recursive: true });
  const tmpDir = `${dirname(outFile)}/.lo-tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const filter = `pdf:writer_pdf_Export:${JSON.stringify({ UseTaggedPDF: { type: 'boolean', value: options.tagged === false ? 'false' : 'true' }, ExportBookmarks: { type: 'boolean', value: 'false' } })}`;
  execFileSync('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore', '--convert-to', filter, '--outdir', tmpDir, fodt], {
    env: { ...process.env, SOURCE_DATE_EPOCH: '1792670400', HOME: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  renameSync(`${tmpDir}/${basename(fodt, '.fodt')}.pdf`, outFile);
  rmSync(tmpDir, { recursive: true, force: true });
}
