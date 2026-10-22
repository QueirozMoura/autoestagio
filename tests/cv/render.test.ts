import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LAYOUT,
  FONT_DIR,
  FONT_FILES,
  FONT_LICENSE_FILE,
  MIN_BODY_PT,
  RenderError,
  extractPdfBytes,
  layoutProblems,
  mergeLayout,
  renderResume,
  resolveResume,
  type LayoutOverrides,
  type PdfExtraction,
  type ResolvedResume,
} from '../../src/cv/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import {
  GENERIC,
  SENTINEL_DRAFT,
  SENTINEL_REJECTED,
  approvedModel,
  must,
} from '../helpers/cv-approved.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { fictionalResume } from '../helpers/cv-resume.js';

const read = (bytes: Buffer): Promise<PdfExtraction> => extractPdfBytes(bytes, 'gerado.pdf');
const squash = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/[\s|]+/g, '')
    .toLowerCase();

/** Todo texto que o PDF pode conter: o resolvido + os rótulos estruturais do layout. */
function allowedTexts(resume: ResolvedResume): string[] {
  const l = DEFAULT_LAYOUT.labels;
  const entries = [...resume.experience.entries, ...resume.projects.entries];
  return [
    '•',
    resume.header.name,
    resume.header.headline,
    resume.header.location,
    ...resume.header.contacts.map((c) => c.value),
    ...resume.header.links.map((k) => `${k.label}: ${k.url}`),
    l.summary,
    resume.summary,
    resume.experience.title,
    resume.projects.title,
    ...entries.flatMap((e) => [
      e.title,
      e.period ?? '',
      ...e.bullets,
      `${l.technologies}: ${e.technologies.join(', ')}`,
      `${l.links}:`,
      ...e.links.map((k) => `${k.label}: ${k.url}`),
    ]),
    l.skills,
    ...resume.skills.map((s) => s.text),
    l.education,
    ...resume.education,
    l.languages,
    ...resume.languages,
    l.certifications,
    ...resume.certifications,
  ];
}

describe('renderização de um ResolvedResume (modelo fictício)', () => {
  it('uma página A4 com todas as seções, na ordem de leitura lógica', async () => {
    const result = await renderResume(fictionalResume());
    expect(result.pages).toBe(1);
    expect(result.fit).toMatchObject({ stepIndex: 0, attempts: 1 });
    expect(result.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await read(result.bytes);
    expect(pdf.pages).toBe(1);
    const text = pdf.lines.map((l) => l.text);
    const at = (needle: string): number => text.findIndex((t) => t.includes(needle));
    const order = [
      'Maria Exemplo da Silva',
      'Estágio em Tecnologia',
      'São Paulo, SP',
      'RESUMO PROFISSIONAL',
      'EXPERIÊNCIA EM PROJETOS',
      'Projeto oficina',
      'Projeto agenda',
      'OUTROS PROJETOS',
      'Projeto notas',
      'COMPETÊNCIAS TÉCNICAS',
      'FORMAÇÃO ACADÊMICA',
      'IDIOMAS',
      'CERTIFICAÇÕES',
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('a linha de contato fica inteira (telefone e e-mail sem quebra no meio)', async () => {
    const pdf = await read((await renderResume(fictionalResume())).bytes);
    const contact = pdf.lines.find((l) => l.text.includes('maria.exemplo@example.com'));
    expect(contact?.text).toContain('(11) 90000-0000');
    expect(contact?.text).toContain('São Paulo, SP');
  });

  it('bullets com "•" real, título e período na mesma linha com "|"', async () => {
    const pdf = await read((await renderResume(fictionalResume())).bytes);
    expect(pdf.lines.filter((l) => l.text.startsWith('•')).length).toBe(6);
    const title = pdf.lines.find((l) => l.text.startsWith('Projeto oficina'));
    expect(title?.text).toMatch(/Desenvolvedora Full Stack\s*\|\s*2025 – 2026$/);
  });

  it('URLs visíveis E clicáveis (uma anotação por link)', async () => {
    const resume = fictionalResume();
    const pdf = await read((await renderResume(resume)).bytes);
    const urls = [
      ...resume.header.links.map((l) => l.url),
      ...[...resume.experience.entries, ...resume.projects.entries].flatMap((e) =>
        e.links.map((l) => l.url),
      ),
    ];
    const visible = pdf.lines.map((l) => l.text).join('\n');
    for (const url of urls) expect(visible).toContain(url);
    expect(pdf.links.map((l) => l.url).sort()).toEqual([...urls].sort());
  });

  it('sem links no currículo: nenhuma anotação nem linha de links', async () => {
    const pdf = await read((await renderResume(fictionalResume({ links: false }))).bytes);
    expect(pdf.links).toEqual([]);
    expect(pdf.lines.some((l) => l.text.startsWith('Links:'))).toBe(false);
  });

  it('sem certificação: a seção não aparece', async () => {
    const pdf = await read((await renderResume(fictionalResume({ certifications: [] }))).bytes);
    expect(pdf.lines.some((l) => l.text.includes('CERTIFICAÇÕES'))).toBe(false);
  });

  it('nenhuma informação vem de fora do ResolvedResume, e nada do resolvido some', async () => {
    const resume = fictionalResume({ extraBullets: 2, extraEntries: 2 });
    const pdf = await read((await renderResume(resume)).bytes);
    const corpus = squash(allowedTexts(resume).join(''));
    // O "•" é o marcador de bullet do próprio renderizador (permitido); o resto da linha precisa vir do resolvido.
    const extra = pdf.lines.filter((l) => !corpus.includes(squash(l.text.replace(/^•/, ''))));
    expect(extra.map((l) => l.text)).toEqual([]);
    const rendered = squash(pdf.lines.map((l) => l.text).join(''));
    const missing = allowedTexts(resume).filter((t) => !rendered.includes(squash(t)));
    expect(missing).toEqual([]);
  });

  it('não modifica o currículo resolvido recebido', async () => {
    const resume = fictionalResume();
    const before = JSON.stringify(resume);
    await renderResume(resume);
    expect(JSON.stringify(resume)).toBe(before);
  });
});

describe('PDF: fontes, metadados e estrutura', () => {
  it('Lato embutida (subset com ToUnicode), PDF tagged, A4, metadados fixos e sem caminhos locais', async () => {
    const { bytes } = await renderResume(fictionalResume());
    const raw = bytes.toString('latin1');
    expect(raw).toMatch(/BaseFont\s*\/[A-Z]{6}\+Lato-Regular/);
    expect(raw).toMatch(/BaseFont\s*\/[A-Z]{6}\+Lato-Bold/);
    expect(raw).toContain('/ToUnicode');
    expect(raw).toContain('/FontFile2');
    expect(raw).not.toMatch(/Helvetica|Times-Roman|Courier/);
    expect(raw).toContain('/StructTreeRoot');
    expect(raw).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(raw).toContain('(AutoEstagio)');
    expect(raw).toContain('D:20260101000000Z');
    expect(raw).not.toContain('/home/');
    expect(raw).not.toContain(PROJECT_ROOT);
  });

  it('a Lato e a licença OFL-1.1 estão no repositório', () => {
    for (const file of Object.values(FONT_FILES))
      expect(readFileSync(join(FONT_DIR, file)).length).toBeGreaterThan(100_000);
    const license = readFileSync(FONT_LICENSE_FILE, 'utf8');
    expect(license).toMatch(/SIL Open Font License, Version 1\.1/i);
    expect(license).toContain('PERMISSION & CONDITIONS');
    expect(license).toMatch(/Dziedzic/);
  });
});

describe('determinismo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a mesma entrada gera exatamente os mesmos bytes, independentemente do relógio', async () => {
    const resume = fictionalResume();
    const a = await renderResume(resume);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-07-07T07:07:07Z'));
    const b = await renderResume(resume);
    vi.useRealTimers();
    const c = await renderResume(structuredClone(resume));
    expect(b.bytes.equals(a.bytes)).toBe(true);
    expect(c.bytes.equals(a.bytes)).toBe(true);
    expect(b.pdfSha256).toBe(a.pdfSha256);
    expect(a.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('conteúdo diferente gera PDF diferente; a data de metadados é configurável e fixa', async () => {
    const a = await renderResume(fictionalResume());
    const b = await renderResume(fictionalResume({ extraBullets: 1 }));
    expect(b.pdfSha256).not.toBe(a.pdfSha256);
    const other = await renderResume(fictionalResume(), {
      layout: { metadata: { date: new Date('2027-02-03T04:05:06Z') } },
    });
    expect(other.bytes.toString('latin1')).toContain('D:20270203040506Z');
  });

  it('liga o PDF ao conteúdo de origem pelo contentSha256 do currículo resolvido', async () => {
    const resume = fictionalResume();
    expect((await renderResume(resume)).sourceContentSha256).toBe(resume.manifest.contentSha256);
  });
});

describe('uma página, duas páginas e overflow', () => {
  it('conteúdo que não cabe no layout declarado: ajusta espaçamento/fonte e fecha em UMA página', async () => {
    const resume = fictionalResume({ extraBullets: 2 });
    const result = await renderResume(resume);
    expect(result.pages).toBe(1);
    expect(result.fit.stepIndex).toBeGreaterThan(0);
    expect(result.fit.step.font * DEFAULT_LAYOUT.size.body).toBeGreaterThanOrEqual(MIN_BODY_PT);
    // Nada foi removido nem resumido para caber.
    const pdf = await read(result.bytes);
    const rendered = squash(pdf.lines.map((l) => l.text).join(''));
    for (const entry of [...resume.experience.entries, ...resume.projects.entries])
      for (const bullet of entry.bullets) expect(rendered).toContain(squash(bullet));
  });

  it('o ajuste usa o maior degrau que cabe (não reduz mais que o necessário)', async () => {
    const resume = fictionalResume({ extraBullets: 2 });
    const used = await renderResume(resume);
    const larger = await renderResume(resume, {
      layout: { fit: DEFAULT_LAYOUT.fit.slice(0, used.fit.stepIndex), pages: { max: 3 } },
    });
    expect(larger.pages).toBeGreaterThan(1); // o degrau anterior não cabia em uma página
  });

  it('não cabe em uma página nem com ajustes: usa DUAS páginas sem reduzir o layout', async () => {
    const resume = fictionalResume({ extraBullets: 2, extraEntries: 2 });
    const result = await renderResume(resume);
    expect(result.pages).toBe(2);
    expect(result.fit.stepIndex).toBe(0);
    const pdf = await read(result.bytes);
    expect(pdf.pages).toBe(2);
    const rendered = squash(pdf.lines.map((l) => l.text).join(''));
    for (const text of allowedTexts(resume)) expect(rendered).toContain(squash(text));
  });

  it('nunca deixa título de seção ou de entrada órfão no fim da página', async () => {
    const pdf = await read(
      (await renderResume(fictionalResume({ extraBullets: 2, extraEntries: 2 }))).bytes,
    );
    const headings = new Set([
      'EXPERIÊNCIA EM PROJETOS',
      'OUTROS PROJETOS',
      'COMPETÊNCIAS TÉCNICAS',
      'FORMAÇÃO ACADÊMICA',
      'IDIOMAS',
      'CERTIFICAÇÕES',
      'RESUMO PROFISSIONAL',
    ]);
    pdf.lines.forEach((line, i) => {
      const next = pdf.lines[i + 1];
      const isHeading = headings.has(line.text);
      const isEntryTitle = line.text.startsWith('Projeto ') && line.text.includes('|');
      if ((isHeading || isEntryTitle) && next !== undefined) expect(next.page).toBe(line.page);
      if (isHeading) expect(next).toBeDefined();
    });
  });

  it('mais que duas páginas mesmo com os ajustes seguros: erro controlado, sem PDF parcial', async () => {
    const resume = fictionalResume({ extraBullets: 6, extraEntries: 3 });
    const before = JSON.stringify(resume);
    const error = await renderResume(resume).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).code).toBe('OVERFLOW');
    expect((error as RenderError).details.join(' ')).toMatch(/limite: 2/);
    expect((error as RenderError).message).toMatch(/nada foi removido nem resumido/);
    expect(JSON.stringify(resume)).toBe(before);
  });

  it('respeita o limite configurado: com máximo de 1 página, o excesso é erro', async () => {
    const error = await renderResume(fictionalResume({ extraBullets: 2, extraEntries: 2 }), {
      layout: { pages: { preferred: 1, max: 1 } },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as RenderError).code).toBe('OVERFLOW');
  });
});

describe('layout declarativo', () => {
  it('é configurável por sobreposição parcial', async () => {
    const small = await renderResume(fictionalResume(), {
      layout: {
        size: { body: 9 },
        margin: { left: 60, right: 60 },
        color: { accent: '#000000' },
      },
    });
    const normal = await renderResume(fictionalResume());
    expect(small.pdfSha256).not.toBe(normal.pdfSha256);
    expect(mergeLayout({ size: { body: 9 } }).size.name).toBe(DEFAULT_LAYOUT.size.name);
    expect(layoutProblems(DEFAULT_LAYOUT)).toEqual([]);
  });

  it('layout inválido falha antes de renderizar', async () => {
    const bad = async (layout: LayoutOverrides): Promise<RenderError> => {
      const error = await renderResume(fictionalResume(), { layout }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe('INVALID_LAYOUT');
      return error as RenderError;
    };
    const tooSmall = await bad({ fit: [{ font: 0.5, space: 1 }] });
    expect(tooSmall.details.join(' ')).toMatch(/mínimo 8 pt/);
    await bad({ pages: { preferred: 2, max: 1 } });
    await bad({ pages: { preferred: 0, max: 2 } });
    await bad({ margin: { left: 400, right: 400 } });
    await bad({ fit: [] });
    await bad({ fit: [{ font: 1.2, space: 1 }] });
    await bad({ size: { body: 0 } });
  });

  it('item de linha mais largo que a página: erro controlado (nada de texto cortado)', async () => {
    const resume = fictionalResume();
    resume.header.links = [
      { id: 'longo', label: 'Longo', url: `https://example.com/${'a'.repeat(400)}` },
    ];
    const error = await renderResume(resume).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as RenderError).code).toBe('UNBREAKABLE_SEGMENT');
  });
});

describe('integração: modelo aprovado → resolvedor → PDFKit', () => {
  let L: Loaded;
  beforeAll(async () => {
    L = await loadFictional();
  });

  it('o PDF contém só o conteúdo resolvido (sem rascunho, rejeitado, link não confirmado, ano ou descrição)', async () => {
    const model = approvedModel(L);
    const resume = resolveResume(model, { extraction: L.extraction });
    const result = await renderResume(resume);
    expect(result.pages).toBeLessThanOrEqual(2);
    expect(result.sourceContentSha256).toBe(resume.manifest.contentSha256);

    const pdf = await read(result.bytes);
    const text = pdf.lines.map((l) => l.text).join('\n');
    expect(squash(text)).toContain(squash(GENERIC));
    expect(text).not.toContain(SENTINEL_DRAFT);
    expect(text).not.toContain(SENTINEL_REJECTED);
    expect(text).not.toContain('cerca de 90 pessoas'); // texto superado do PDF mestre
    expect(text).toContain('aproximadamente 40 pessoas');
    const cert = must(model.certifications[0]);
    expect(text).toContain('Fundamentos de APIs REST — Instituto Exemplo');
    expect(text).not.toContain(String(cert.description));
    expect(text).not.toContain(`(${cert.year})`);
    // LinkedIn não confirmado: nem texto nem anotação.
    expect(text).not.toContain('maria-exemplo-');
    expect(pdf.links.some((l) => l.url.endsWith('maria-exemplo-'))).toBe(false);
    // Links confirmados: clicáveis.
    expect(pdf.links.map((l) => l.url)).toEqual(
      expect.arrayContaining(resume.header.links.map((l) => l.url)),
    );
  });

  it('cada área aprovada renderiza o seu resumo; área bloqueada nem chega ao renderizador', async () => {
    const model = approvedModel(L);
    const qa = await renderResume(resolveResume(model, { extraction: L.extraction, area: 'qa' }));
    expect(squash((await read(qa.bytes)).lines.map((l) => l.text).join(''))).toContain(
      squash('Resumo aprovado de QA.'),
    );
    expect(() => resolveResume(model, { extraction: L.extraction, area: 'suporte' })).toThrow(
      /Blocos obrigatórios sem variante aprovada/,
    );
  });
});

describe('o renderizador só conhece o ResolvedResume', () => {
  const dir = join(PROJECT_ROOT, 'src', 'cv', 'render');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const sources = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('importa apenas pdfkit, módulos do próprio renderizador, utilitários neutros e TIPOS do resolvido', () => {
    expect(files).toEqual(
      expect.arrayContaining(['pdfkit.ts', 'layout.ts', 'fonts.ts', 'index.ts']),
    );
    const allowed = new Set([
      'node:crypto',
      'node:fs',
      'node:path',
      'pdfkit',
      '../../utils/paths.js',
      '../resolve.js',
    ]);
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/import\s+(type\s+)?(?:[\s\S]*?)\s+from\s+'([^']+)'/g)) {
        const spec = m[2] ?? '';
        const ok = allowed.has(spec) || spec.startsWith('./');
        expect(ok, `${file} importa "${spec}"`).toBe(true);
        if (spec === '../resolve.js')
          expect(m[1], `${file}: import do resolvido deve ser "import type"`).toBeTruthy();
      }
    }
  });

  it('não lê o modelo/PDF mestre, não acessa banco ou rede, não grava arquivo e não usa o relógio', () => {
    const forbidden = [
      /CvMaster|cvMasterSchema|loadModel|saveModel|extractPdf|fidelityReport/,
      /better-sqlite3|openDatabase|\.db['"]/,
      /fetch\(|node:http|node:https|node:net/,
      /writeFile|createWriteStream|appendFile|mkdirSync|renameSync|unlinkSync/,
      /process\.env|process\.cwd\(/,
      /Date\.now|new Date\(\)|Math\.random|randomUUID|randomBytes/,
    ];
    for (const { file, text } of sources)
      for (const pattern of forbidden)
        expect(pattern.test(text), `${file} casa ${String(pattern)}`).toBe(false);
  });
});
