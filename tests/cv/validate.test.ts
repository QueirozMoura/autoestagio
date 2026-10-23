import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NORMALIZATION_RULES,
  expectedContent,
  renderResume,
  resolveResume,
  validateRenderedPdf,
  type CheckId,
  type ResolvedResume,
  type ValidateOptions,
  type ValidationReport,
} from '../../src/cv/index.js';
import {
  dropLineEndHyphens,
  extractForValidation,
  firstDifference,
  squash,
  type PopplerRunner,
} from '../../src/cv/validate/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { approvedModel } from '../helpers/cv-approved.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { fictionalResume } from '../helpers/cv-resume.js';

// Renderizar e validar PDFs (pdfjs, Poppler) é mais lento com a suíte inteira rodando em paralelo.
vi.setConfig({ testTimeout: 30_000 });

const hasPoppler = spawnSync('pdftotext', ['-v']).status === 0;

const render = async (resume: ResolvedResume): Promise<Buffer> =>
  (await renderResume(resume)).bytes;
const check = (report: ValidationReport, id: CheckId) => {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`sem ${id}`);
  return found;
};
const text = (report: ValidationReport, id: CheckId): string =>
  check(report, id).details.join('\n');
/** Valida o PDF de `actual` contra o conteúdo esperado de `expected` (adulteração: PDF ≠ esperado). */
const validateAgainst = (
  actual: ResolvedResume,
  expected: ResolvedResume,
  options: ValidateOptions = { poppler: 'off' },
): Promise<ValidationReport> =>
  render(actual).then((bytes) => validateRenderedPdf(bytes, expected, options));

function fakePoppler(options: {
  raw?: string;
  reading?: string;
  missing?: boolean;
  failRead?: boolean;
}): PopplerRunner {
  return (_command, args) => {
    if (options.missing === true) return { status: null, stdout: '', stderr: '' };
    if (args.includes('-v')) return { status: 0, stdout: '', stderr: 'pdftotext version 9.9.9' };
    if (options.failRead === true) return { status: 1, stdout: '', stderr: 'Syntax Error: teste' };
    return {
      status: 0,
      stdout: args.includes('-raw') ? (options.raw ?? '') : (options.reading ?? ''),
      stderr: '',
    };
  };
}

/** PDF montado à mão (Helvetica padrão) para casos que o renderizador nunca produz. */
function craftPdf(draw: (pdf: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 46, right: 46 },
    info: { CreationDate: new Date('2026-01-01T00:00:00Z') },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
  draw(pdf);
  pdf.end();
  return done;
}

/** Currículo mínimo com UM link no cabeçalho, para os PDFs montados à mão. */
function oneLinkResume(url = 'https://x.example.com/a'): ResolvedResume {
  const resume = fictionalResume({ links: false });
  resume.header.links = [{ id: 'link-x', label: 'GitHub', url }];
  return resume;
}

describe('normalização: só diferenças de extração justificadas', () => {
  it('toda regra tem justificativa, e nada semântico é alterado', () => {
    expect(NORMALIZATION_RULES.length).toBeGreaterThanOrEqual(4);
    for (const rule of NORMALIZATION_RULES) expect(rule.why.length).toBeGreaterThan(20);
    // Espaços, quebras e separadores estruturais somem…
    expect(squash('a  b\n c | d •e')).toBe('abcde');
    // …mas palavras, números, URLs, hífens e maiúsculas continuam diferentes.
    expect(squash('e-commerce')).toBe('e-commerce');
    expect(squash('e-commerce')).not.toBe(squash('ecommerce'));
    expect(squash('2025')).not.toBe(squash('2026'));
    expect(squash('https://a.com/x-')).toBe('https://a.com/x-');
    expect(squash('Docker')).not.toBe(squash('DOCKER'));
    // NFC (não NFKC): a ligadura "ﬁ" não vira "fi" em silêncio.
    expect(squash('ﬁnal')).not.toBe(squash('final'));
    expect(squash('é')).toBe(squash('é'));
  });

  it('o hífen só é ignorado no FIM da linha (e só na comparação com o Poppler)', () => {
    expect(dropLineEndHyphens('e-\ncommerce')).toBe('e\ncommerce');
    expect(dropLineEndHyphens('e-commerce\nfim')).toBe('e-commerce\nfim');
    expect(dropLineEndHyphens('termina-')).toBe('termina');
    expect(firstDifference('abc', 'abc')).toBeUndefined();
    expect(firstDifference('abcd', 'abxd')?.at).toBe(2);
  });
});

describe('H1 a H4: PDFs válidos', () => {
  it('uma página: todas as verificações implementadas passam; o relatório não finge ser a validação completa', async () => {
    const resume = fictionalResume();
    const result = await renderResume(resume);
    const report = await validateRenderedPdf(result.bytes, resume, { poppler: 'off' });
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.implemented).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H8', 'H9']);
    expect(report.pending).toEqual(['H6', 'H7', 'H10']);
    expect(report.forbiddenProvided).toBe(false);
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['H1', 'pass'],
      ['H2', 'pass'],
      ['H3', 'pass'],
      ['H4', 'pass'],
      ['H5', 'pass'],
      ['H8', 'pass'],
      ['H9', 'pass'],
    ]);
    expect(report.pages).toBe(1);
    expect(report.pdfSha256).toBe(result.pdfSha256);
    expect(report.extractors[0]).toMatchObject({ name: 'pdfjs-dist', status: 'used' });
    expect(report.extractors[1]).toMatchObject({ status: 'skipped' });
  });

  it('duas páginas: passa, com bullets e links de todas as entradas', async () => {
    const resume = fictionalResume({ extraBullets: 2, extraEntries: 2 });
    const report = await validateRenderedPdf(await render(resume), resume, { poppler: 'off' });
    expect(report.ok).toBe(true);
    expect(report.pages).toBe(2);
    expect(check(report, 'H2').summary).toMatch(/20 bullets/);
  });

  it.skipIf(!hasPoppler)(
    'com o Poppler real (auto): concorda em conteúdo e em ordem de leitura',
    async () => {
      const resume = fictionalResume({ extraBullets: 2, extraEntries: 2 });
      const report = await validateRenderedPdf(await render(resume), resume);
      expect(report.ok).toBe(true);
      expect(report.extractors[1]).toMatchObject({ name: 'poppler (pdftotext)', status: 'used' });
      expect(text(report, 'H2')).toMatch(/Poppler .* concorda/);
      expect(text(report, 'H3')).toMatch(/Poppler .* concorda/);
    },
  );

  it('palavra quebrada no hífen ("e-" + "commerce") continua exata no pdfjs e aceita no Poppler', async () => {
    let found: { resume: ResolvedResume; bytes: Buffer } | undefined;
    for (let words = 6; words < 60 && found === undefined; words++) {
      const resume = fictionalResume();
      const entry = resume.experience.entries[0];
      if (entry === undefined) throw new Error('sem entrada');
      entry.bullets[0] = `${'palavra '.repeat(words)}e-commerce completo com testes automatizados.`;
      const bytes = await render(resume);
      const lines = (await extractForValidation(bytes)).streamText.split('\n');
      if (lines.some((line) => line.endsWith('e-'))) found = { resume, bytes };
    }
    if (found === undefined) throw new Error('não consegui provocar a quebra no hífen');
    const report = await validateRenderedPdf(found.bytes, found.resume);
    expect(report.ok).toBe(true);
    // O hífen é exato: o mesmo PDF contra "ecommerce" (sem hífen) é recusado.
    const altered = structuredClone(found.resume);
    const bullet = altered.experience.entries[0]?.bullets[0];
    if (altered.experience.entries[0] !== undefined && bullet !== undefined)
      altered.experience.entries[0].bullets[0] = bullet.replace('e-commerce', 'ecommerce');
    const wrong = await validateRenderedPdf(found.bytes, altered, { poppler: 'off' });
    expect(check(wrong, 'H2').status).toBe('fail');
  });

  it('integração: modelo aprovado → resolvedor → renderizador → validador', async () => {
    const L: Loaded = await loadFictional();
    const resume = resolveResume(approvedModel(L), { extraction: L.extraction, area: 'qa' });
    const report = await validateRenderedPdf(await render(resume), resume);
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('o texto esperado vem da mesma descrição de conteúdo do renderizador', () => {
    const resume = fictionalResume();
    const expected = expectedContent(resume);
    expect(expected.blocks[0]).toMatchObject({ id: 'header.name', kind: 'name' });
    expect(expected.blocks.some((b) => b.text === 'EXPERIÊNCIA EM PROJETOS')).toBe(true);
    expect(expected.blocks.some((b) => b.text === 'Tecnologias:')).toBe(true);
    expect(expected.links).toHaveLength(8);
    expect(expected.bullets).toBe(6);
    expect(expected.maxPages).toBe(2);
  });
});

describe('H1: integridade e páginas (negativos)', () => {
  let resume: ResolvedResume;
  let bytes: Buffer;
  beforeAll(async () => {
    resume = fictionalResume();
    bytes = await render(resume);
  });

  it('arquivo que não é PDF: H1 falha e as demais ficam ignoradas', async () => {
    const report = await validateRenderedPdf(Buffer.from('isto não é um pdf'), resume, {
      poppler: 'off',
    });
    expect(report.ok).toBe(false);
    expect(check(report, 'H1').status).toBe('fail');
    expect(check(report, 'H1').details.join(' ')).toMatch(/%PDF-/);
    for (const id of ['H2', 'H3', 'H4', 'H5', 'H8', 'H9'] as const)
      expect(check(report, id).status).toBe('skipped');
    expect(report.pages).toBeNull();
    expect(report.extractors[0]?.status).toBe('error');
  });

  it('arquivo vazio e PDF truncado', async () => {
    expect(
      check(await validateRenderedPdf(Buffer.alloc(0), resume, { poppler: 'off' }), 'H1').status,
    ).toBe('fail');
    const cut = bytes.subarray(0, Math.floor(bytes.length / 2));
    const report = await validateRenderedPdf(cut, resume, { poppler: 'off' });
    expect(report.ok).toBe(false);
    expect(check(report, 'H1').status).toBe('fail');
    expect(check(report, 'H1').details.join(' ')).toMatch(/%%EOF|ler o PDF/);
  });

  it('número de páginas diferente do esperado ou acima do limite do layout', async () => {
    const wrongCount = await validateRenderedPdf(bytes, resume, {
      poppler: 'off',
      expectedPages: 2,
    });
    expect(check(wrongCount, 'H1').details.join(' ')).toMatch(/1 páginas; o esperado era 2/);

    const two = fictionalResume({ extraBullets: 2, extraEntries: 2 });
    const twoPages = await render(two);
    const overLimit = await validateRenderedPdf(twoPages, two, {
      poppler: 'off',
      layout: { pages: { preferred: 1, max: 1 } },
    });
    expect(check(overLimit, 'H1').status).toBe('fail');
    expect(check(overLimit, 'H1').details.join(' ')).toMatch(/2 páginas; o limite é 1/);
  });

  it('página em branco no meio ou no fim é recusada', async () => {
    const withBlank = await craftPdf((pdf) => {
      pdf.text('Primeira página com texto');
      pdf.addPage();
    });
    const report = await validateRenderedPdf(withBlank, resume, { poppler: 'off' });
    expect(check(report, 'H1').status).toBe('fail');
    expect(check(report, 'H1').details.join(' ')).toMatch(/página 2 está em branco/);
  });
});

describe('H2: conteúdo bidirecional (negativos)', () => {
  const original = fictionalResume();

  it('bullet a mais no PDF: texto extra e contagem de "•" divergente', async () => {
    const more = structuredClone(original);
    more.experience.entries[0]?.bullets.push(
      'Bullet acrescentado que não está no currículo resolvido.',
    );
    const report = await validateAgainst(more, original);
    expect(check(report, 'H2').status).toBe('fail');
    expect(text(report, 'H2')).toMatch(/não pertence ao currículo resolvido/);
    expect(text(report, 'H2')).toMatch(/7 marcador\(es\) "•" no PDF; o esperado eram 6/);
  });

  it('bullet a menos no PDF: bloco esperado ausente', async () => {
    const fewer = structuredClone(original);
    fewer.experience.entries[1]?.bullets.pop();
    const report = await validateAgainst(fewer, original);
    expect(check(report, 'H2').status).toBe('fail');
    expect(text(report, 'H2')).toMatch(/ausente\(s\) ou alterado\(s\).*agenda\.bullet\.1/);
  });

  it('número alterado ("2026" → "2027") é detectado', async () => {
    const changed = structuredClone(original);
    const entry = changed.experience.entries[0];
    if (entry !== undefined) entry.period = '2025 – 2027';
    const report = await validateAgainst(changed, original);
    expect(check(report, 'H2').status).toBe('fail');
    // Os períodos do fixture se repetem, então o bloco apontado como ausente pode ser de outra entrada;
    // o que importa é que o texto alterado aparece como conteúdo que não pertence ao currículo.
    expect(text(report, 'H2')).toMatch(/\.period/);
    expect(text(report, 'H2')).toContain('2025–2027');
  });

  it('hífen e maiúsculas contam: "e-commerce" ≠ "ecommerce", "Docker" ≠ "DOCKER"', async () => {
    const base = structuredClone(original);
    const entry = base.experience.entries[0];
    if (entry !== undefined) entry.bullets[0] = 'Plataforma de e-commerce com Docker.';
    const bytes = await render(base);
    expect(check(await validateRenderedPdf(bytes, base, { poppler: 'off' }), 'H2').status).toBe(
      'pass',
    );

    for (const swap of [
      ['e-commerce', 'ecommerce'],
      ['Docker', 'DOCKER'],
      ['Plataforma', 'Plataformas'],
    ] as const) {
      const expected = structuredClone(base);
      const e = expected.experience.entries[0];
      if (e?.bullets[0] !== undefined) e.bullets[0] = e.bullets[0].replace(swap[0], swap[1]);
      const report = await validateRenderedPdf(bytes, expected, { poppler: 'off' });
      expect(check(report, 'H2').status, `${swap[0]} → ${swap[1]}`).toBe('fail');
    }
  });

  it('URL diferente no texto impresso falha em H2 e em H4', async () => {
    const other = structuredClone(original);
    const link = other.header.links[0];
    if (link !== undefined) link.url = 'https://www.example.com/outra-pessoa';
    const report = await validateAgainst(other, original);
    expect(check(report, 'H2').status).toBe('fail');
    expect(check(report, 'H4').status).toBe('fail');
  });

  it('o Poppler diverge do pdfjs: falha; com o Poppler desligado, passa', async () => {
    const bytes = await render(original);
    const extracted = await extractForValidation(bytes);
    const runner = fakePoppler({
      raw: extracted.streamText.replace('Desenvolvi o módulo 1', 'Desenvolvi o módulo 9'),
      reading: extracted.geometryText,
    });
    const report = await validateRenderedPdf(bytes, original, { popplerRunner: runner });
    expect(check(report, 'H2').status).toBe('fail');
    expect(text(report, 'H2')).toMatch(/o Poppler diverge do pdfjs/);
    expect(report.ok).toBe(false);
    expect(check(await validateRenderedPdf(bytes, original, { poppler: 'off' }), 'H2').status).toBe(
      'pass',
    );
  });

  it('diferenças JUSTIFICADAS do Poppler são aceitas; hífen no meio da linha, não', async () => {
    const bytes = await render(original);
    const extracted = await extractForValidation(bytes);
    // Poppler junta a palavra quebrada no hífen e separa "https:/ /": diferenças de extração conhecidas.
    const poppler = extracted.streamText.replaceAll('https://', 'https:/ /').replace(/-\n/g, '\n');
    const ok = await validateRenderedPdf(bytes, original, {
      popplerRunner: fakePoppler({ raw: poppler, reading: extracted.geometryText }),
    });
    expect(ok.ok).toBe(true);
    // Um hífen do MEIO da linha alterado não é diferença de extração.
    const tampered = extracted.streamText.replace('90000-0000', '900000000');
    const bad = await validateRenderedPdf(bytes, original, {
      popplerRunner: fakePoppler({ raw: tampered, reading: extracted.geometryText }),
    });
    expect(check(bad, 'H2').status).toBe('fail');
  });

  it('Poppler: "require" sem o executável falha; "auto" ignora com aviso; erro de leitura falha', async () => {
    const bytes = await render(original);
    const missing = fakePoppler({ missing: true });
    const required = await validateRenderedPdf(bytes, original, {
      poppler: 'require',
      popplerRunner: missing,
    });
    expect(check(required, 'H2').status).toBe('fail');
    expect(check(required, 'H3').status).toBe('fail');
    expect(text(required, 'H2')).toMatch(/Poppler exigido/);
    expect(required.extractors[1]?.status).toBe('missing');

    const auto = await validateRenderedPdf(bytes, original, {
      poppler: 'auto',
      popplerRunner: missing,
    });
    expect(auto.ok).toBe(true);
    expect(text(auto, 'H2')).toMatch(/Poppler indisponível/);

    const broken = await validateRenderedPdf(bytes, original, {
      popplerRunner: fakePoppler({ failRead: true }),
    });
    expect(check(broken, 'H2').status).toBe('fail');
    expect(broken.extractors[1]?.status).toBe('error');
  });
});

describe('H3: ordem de leitura (negativos; o conteúdo continua igual)', () => {
  const original = fictionalResume();

  it('seções trocadas de lugar: H2 passa (mesmo conteúdo), H3 falha', async () => {
    const swapped = structuredClone(original);
    [swapped.experience, swapped.projects] = [swapped.projects, swapped.experience];
    const report = await validateAgainst(swapped, original);
    expect(check(report, 'H2').status).toBe('pass');
    expect(check(report, 'H3').status).toBe('fail');
    expect(text(report, 'H3')).toMatch(/fora da ordem esperada/);
  });

  it('bullets de uma entrada em outra ordem', async () => {
    const reordered = structuredClone(original);
    reordered.experience.entries[0]?.bullets.reverse();
    const report = await validateAgainst(reordered, original);
    expect(check(report, 'H2').status).toBe('pass');
    expect(check(report, 'H3').status).toBe('fail');
  });

  it('contatos em outra ordem no cabeçalho', async () => {
    const reordered = structuredClone(original);
    reordered.header.contacts.reverse();
    const report = await validateAgainst(reordered, original);
    expect(check(report, 'H3').status).toBe('fail');
  });

  it('o Poppler lê em outra ordem que o pdfjs: falha em H3', async () => {
    const bytes = await render(original);
    const extracted = await extractForValidation(bytes);
    const lines = extracted.geometryText.split('\n');
    const [first, second] = [lines[3], lines[4]];
    if (first === undefined || second === undefined) throw new Error('poucas linhas');
    lines[3] = second;
    lines[4] = first;
    const report = await validateRenderedPdf(bytes, original, {
      popplerRunner: fakePoppler({ raw: extracted.streamText, reading: lines.join('\n') }),
    });
    expect(check(report, 'H2').status).toBe('pass');
    expect(check(report, 'H3').status).toBe('fail');
    expect(text(report, 'H3')).toMatch(/Poppler diverge/);
  });
});

describe('H4: links (negativos)', () => {
  const original = fictionalResume();

  it('URI da anotação trocada nos bytes (mesmo tamanho): link esperado sem anotação e anotação sem URL visível', async () => {
    const bytes = await render(original);
    const raw = bytes.toString('latin1');
    expect(raw).toContain('/URI (https://oficina.example.com/)');
    const tampered = Buffer.from(
      raw.replace('(https://oficina.example.com/)', '(https://oficinb.example.com/)'),
      'latin1',
    );
    const report = await validateRenderedPdf(tampered, original, { poppler: 'off' });
    expect(check(report, 'H4').status).toBe('fail');
    expect(text(report, 'H4')).toMatch(/link esperado sem anotação clicável.*oficina\.example/);
    expect(text(report, 'H4')).toMatch(/oficinb\.example/);
    expect(check(report, 'H2').status).toBe('pass'); // o texto visível continua igual
  });

  it('links removidos do PDF: sem anotação e sem URL visível', async () => {
    const report = await validateAgainst(fictionalResume({ links: false }), original);
    expect(check(report, 'H4').status).toBe('fail');
    expect(text(report, 'H4')).toMatch(/sem anotação clicável/);
    expect(text(report, 'H4')).toMatch(/não está visível/);
  });

  it('link extra no PDF', async () => {
    const extra = structuredClone(original);
    extra.header.links.push({ id: 'extra', label: 'Extra', url: 'https://extra.example.com/' });
    const report = await validateAgainst(extra, original);
    expect(check(report, 'H4').status).toBe('fail');
    expect(text(report, 'H4')).toMatch(/a mais/);
    expect(text(report, 'H4')).toMatch(/extra\.example/);
  });

  it('URL impressa sem área clicável', async () => {
    const resume = oneLinkResume();
    const bytes = await craftPdf((pdf) => {
      pdf.text('GitHub: https://x.example.com/a');
    });
    const report = await validateRenderedPdf(bytes, resume, { poppler: 'off' });
    expect(check(report, 'H4').status).toBe('fail');
    expect(text(report, 'H4')).toMatch(/URL visível sem anotação clicável/);
    expect(text(report, 'H4')).toMatch(/link esperado sem anotação clicável/);
  });

  it('área clicável sobre o lugar certo passa; deslocada para outro lugar falha', async () => {
    const resume = oneLinkResume();
    const draw =
      (linkX: number) =>
      (pdf: PDFKit.PDFDocument): void => {
        pdf.fontSize(10).text('GitHub: https://x.example.com/a', 46, 100, { lineBreak: false });
        const width = pdf.widthOfString('GitHub: https://x.example.com/a');
        pdf.link(linkX, 98, width, 14, 'https://x.example.com/a');
      };
    const good = await validateRenderedPdf(await craftPdf(draw(46)), resume, { poppler: 'off' });
    expect(check(good, 'H4').status).toBe('pass');
    const shifted = await validateRenderedPdf(await craftPdf(draw(300)), resume, {
      poppler: 'off',
    });
    expect(check(shifted, 'H4').status).toBe('fail');
    expect(text(shifted, 'H4')).toMatch(/não coincide com onde o texto do link está/);
  });

  it('área clicável sobre outra linha: o texto do link não está lá', async () => {
    const resume = oneLinkResume();
    const bytes = await craftPdf((pdf) => {
      pdf.fontSize(10).text('GitHub: https://x.example.com/a', 46, 100, { lineBreak: false });
      pdf.text('Outra linha qualquer', 46, 300, { lineBreak: false });
      pdf.link(46, 298, 150, 14, 'https://x.example.com/a');
    });
    const report = await validateRenderedPdf(bytes, resume, { poppler: 'off' });
    expect(check(report, 'H4').status).toBe('fail');
    expect(text(report, 'H4')).toMatch(/não está na linha onde a área clicável foi desenhada/);
  });

  it('endereço fora de http(s) e anotação duplicada', async () => {
    const resume = oneLinkResume();
    const js = await craftPdf((pdf) => {
      pdf.text('GitHub: https://x.example.com/a', 46, 100, { lineBreak: false });
      pdf.link(46, 98, 150, 14, 'javascript:alert(1)');
    });
    const jsReport = await validateRenderedPdf(js, resume, { poppler: 'off' });
    expect(check(jsReport, 'H4').status).toBe('fail');
    expect(text(jsReport, 'H4')).toMatch(/fora de http\(s\)/);

    const twice = await craftPdf((pdf) => {
      pdf.text('GitHub: https://x.example.com/a', 46, 100, { lineBreak: false });
      pdf.link(46, 98, 150, 14, 'https://x.example.com/a');
      pdf.link(46, 98, 150, 14, 'https://x.example.com/a');
    });
    const dup = await validateRenderedPdf(twice, resume, { poppler: 'off' });
    expect(check(dup, 'H4').status).toBe('fail');
    expect(text(dup, 'H4')).toMatch(/a mais/);
  });
});

describe('o validador é independente e só trabalha em memória', () => {
  const dir = join(PROJECT_ROOT, 'src', 'cv', 'validate');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const sources = files.map((f) => ({ file: f, source: readFileSync(join(dir, f), 'utf8') }));

  it('tem os módulos previstos', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'extract.ts',
        'poppler.ts',
        'normalize.ts',
        'expected.ts',
        'checks.ts',
        'index.ts',
      ]),
    );
  });

  it('não importa o modelo mestre nem o renderizador que desenha (só a descrição de conteúdo)', () => {
    const allowed = new Set([
      'node:crypto',
      'node:child_process',
      'node:zlib',
      '../pdf.js',
      '../render/content.js',
      '../render/layout.js',
      '../resolve.js',
    ]);
    for (const { file, source } of sources) {
      for (const m of source.matchAll(
        /(?:import|export)\s+(type\s+)?(?:[\s\S]*?)\s+from\s+'([^']+)'/g,
      )) {
        const spec = m[2] ?? '';
        expect(allowed.has(spec) || spec.startsWith('./'), `${file} importa "${spec}"`).toBe(true);
        if (spec === '../resolve.js')
          expect(m[1], `${file}: import do resolvido deve ser "import type"`).toBeTruthy();
      }
    }
  });

  it('não grava arquivo, não usa rede, relógio, aleatoriedade nem shell', () => {
    const forbidden = [
      /CvMaster|cvMasterSchema|loadModel|saveModel|fidelityReport|bannedPhrases/,
      /node:fs|writeFile|createWriteStream|appendFile|mkdtemp|tmpdir|mkdirSync/,
      /better-sqlite3|\.db['"]/,
      /fetch\(|node:http|node:https|node:net/,
      /process\.env|process\.cwd\(/,
      /Date\.now|new Date\(\)|Math\.random|randomUUID|randomBytes/,
      /child_process['"]\)?[^;]*\bexec\b|execSync|execFile|shell:\s*true/,
    ];
    for (const { file, source } of sources)
      for (const pattern of forbidden)
        expect(pattern.test(source), `${file} casa ${String(pattern)}`).toBe(false);
  });

  it('o Poppler só roda o pdftotext, com o PDF pela entrada padrão', () => {
    const poppler = sources.find((s) => s.file === 'poppler.ts')?.source ?? '';
    expect(poppler).toContain("command: 'pdftotext'");
    expect(poppler).toContain('input');
    expect(poppler).not.toMatch(/'(sh|bash|pdftoppm|pdftocairo)'/);
  });
});
