/** Estresse: caracteres especiais, variante QA, e conteúdo longo demais (detecção de estouro de página). */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cvModelSchema } from '../model.schema.ts';
import { buildDoc, type Doc } from '../view.ts';
import { renderLibreOffice } from '../renderers/libreoffice.ts';
import { renderPdfkit } from '../renderers/pdfkit.ts';
import { renderWeasyprint } from '../renderers/weasyprint.ts';

const root = new URL('../', import.meta.url).pathname;
const out = `${root}out/`;
const model = cvModelSchema.parse(JSON.parse(readFileSync(`${root}fixtures/cv-fixture.json`, 'utf8')));
const OPTS = { ligatures: false, dates: 'inline' as const };
const py = `${root}.venv/bin/python`;

const SPECIAL = [
  'C# e .NET; Node.js/TypeScript; CI/CD; E2E; R$ 1.200,00; 50% de cobertura; João & Maria; “aspas” e ‘simples’;',
  'ção ãõ ñ ü ç À É Ô; offline, official, affect, fluxo, financeiro; <tag> "x" 1 < 2 > 0; email: a.b+c@example.com;',
  'travessão — meia-risca – hífen-minus; reticências…; 24/7; (11) 90000-0000; SQLite/WASM; AES-256-GCM; OAuth 2.0.',
].join(' ');

function withSpecial(): Doc {
  const doc = buildDoc(model, { area: 'desenvolvimento' });
  const resumo = doc.sections[0];
  if (resumo?.items[0]?.type === 'paragraph') resumo.items[0] = { type: 'paragraph', id: 'resumo-especial', text: SPECIAL };
  return doc;
}

function longDoc(): Doc {
  const doc = buildDoc(model, { area: 'desenvolvimento' });
  const exp = doc.sections.find((s) => s.id === 'experiencia');
  if (exp) exp.items = [...exp.items, ...exp.items.map((i) => ({ ...i, id: `${i.id}-dup` }))];
  return doc;
}

const renderers: Record<string, (d: Doc, f: string) => Promise<unknown> | unknown> = {
  pdfkit: (d, f) => renderPdfkit(d, f, OPTS),
  weasyprint: (d, f) => renderWeasyprint(d, f, OPTS),
  libreoffice: (d, f) => renderLibreOffice(d, f, OPTS),
};
const extract = (file: string, engine: 'poppler' | 'gs' | 'pdfminer'): string => {
  if (engine === 'poppler') return execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
  if (engine === 'gs') return execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', '-sOutputFile=-', file], { encoding: 'utf8' });
  return execFileSync(py, ['-I', '-c', 'import sys;from pdfminer.high_level import extract_text;print(extract_text(sys.argv[1]))', file], { encoding: 'utf8' });
};
const sq = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '').replace(/\|/g, '').toLowerCase();
const pages = (file: string): number => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))?.[1]);

const report: Record<string, unknown> = {};
for (const [name, render] of Object.entries(renderers)) {
  const special = `${out}stress-special.${name}.pdf`;
  await render(withSpecial(), special);
  const want = sq(SPECIAL);
  const specialResult: Record<string, string> = {};
  for (const engine of ['poppler', 'gs', 'pdfminer'] as const) {
    const got = sq(extract(special, engine));
    const idx = got.indexOf(want);
    if (idx >= 0) specialResult[engine] = 'idêntico';
    else {
      // primeiro ponto de divergência, para diagnosticar
      let i = 0;
      const start = got.indexOf(want.slice(0, 20));
      while (start >= 0 && i < want.length && got[start + i] === want[i]) i++;
      specialResult[engine] = `diverge em "${want.slice(Math.max(0, i - 6), i + 10)}" → "${got.slice(start + Math.max(0, i - 6), start + i + 10)}"`;
    }
  }
  const qa = `${out}variant-qa.${name}.pdf`;
  await render(buildDoc(model, { area: 'qa' }), qa);
  const long = `${out}stress-long.${name}.pdf`;
  const longResult = await render(longDoc(), long);
  report[name] = { special: specialResult, qaPages: pages(qa), longPages: pages(long), longRenderInfo: longResult ?? null };
}
console.log(JSON.stringify(report, null, 2));
