/**
 * Orquestra o spike: gera o mesmo documento fictício com os três renderizadores, em 4 configurações
 * (ligaduras ligadas/desligadas × datas à direita/na linha do título), duas vezes cada (determinismo
 * e tempo), roda a análise e grava out/results.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cvModelSchema } from '../model.schema.ts';
import { buildDoc, expectedText } from '../view.ts';
import { renderLibreOffice } from '../renderers/libreoffice.ts';
import { renderPdfkit } from '../renderers/pdfkit.ts';
import { renderWeasyprint } from '../renderers/weasyprint.ts';

const root = new URL('../', import.meta.url).pathname;
const out = `${root}out/`;
mkdirSync(out, { recursive: true });
const model = cvModelSchema.parse(JSON.parse(readFileSync(`${root}fixtures/cv-fixture.json`, 'utf8')));
const py = `${root}.venv/bin/python`;
const doc = buildDoc(model, { area: 'desenvolvimento' });

const expectedFile = `${out}expected.json`;
writeFileSync(
  expectedFile,
  JSON.stringify({
    blocks: expectedText(doc),
    links: doc.links,
    entry_links: doc.sections.flatMap((s) => s.items.flatMap((i) => (i.type === 'entry' ? i.links : []))),
    headings: doc.sections.map((s) => s.heading),
    email: model.identity.contacts.find((c) => c.kind === 'email')?.value,
    phone: model.identity.contacts.find((c) => c.kind === 'telefone')?.value,
  }),
);

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const analyze = (file: string): Record<string, unknown> =>
  JSON.parse(execFileSync(py, ['-I', `${root}tools/analyze.py`, file, expectedFile], { encoding: 'utf8', maxBuffer: 20_000_000 })) as Record<string, unknown>;

type Opts = { ligatures: boolean; dates: 'right' | 'inline' };
const configs: Record<string, Opts> = {
  base: { ligatures: true, dates: 'right' },
  'sem-liga': { ligatures: false, dates: 'right' },
  'datas-inline': { ligatures: true, dates: 'inline' },
  recomendado: { ligatures: false, dates: 'inline' },
};
const renderers: Record<string, (file: string, o: Opts) => Promise<unknown> | unknown> = {
  pdfkit: (f, o) => renderPdfkit(doc, f, o),
  weasyprint: (f, o) => renderWeasyprint(doc, f, o),
  libreoffice: (f, o) => renderLibreOffice(doc, f, o),
};

const results: Record<string, Record<string, unknown>> = {};
for (const [rKey, render] of Object.entries(renderers)) {
  results[rKey] = {};
  for (const [cKey, opts] of Object.entries(configs)) {
    const file = `${out}${rKey}.${cKey}.pdf`;
    const twin = `${out}${rKey}.${cKey}.2.pdf`;
    const timings: number[] = [];
    for (const target of [file, twin]) {
      const t0 = performance.now();
      await render(target, opts);
      timings.push(Math.round(performance.now() - t0));
    }
    results[rKey][cKey] = { ...analyze(file), render_ms: timings, deterministic: sha(file) === sha(twin), sha256: sha(file), size_bytes: statSync(file).size };
  }
}
writeFileSync(`${out}results.json`, JSON.stringify(results, null, 2));
console.log('ok: out/results.json');
