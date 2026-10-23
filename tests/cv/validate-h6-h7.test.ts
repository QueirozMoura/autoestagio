import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  loadFonts,
  renderResume,
  validateRenderedPdf,
  type CheckId,
  type ResolvedResume,
  type ValidateOptions,
  type ValidationReport,
} from '../../src/cv/index.js';
import {
  analyzePages,
  classifyMapping,
  collectFonts,
  extractForValidation,
  parsePdffonts,
  readPdfStructure,
  suspiciousInText,
  type PopplerRunner,
} from '../../src/cv/validate/index.js';
import { checkLigatures } from '../../src/cv/validate/fonts.js';
import {
  cmapText,
  fontPdf,
  mutateTtf,
  realFont,
  runFontChecks,
  showCids,
} from '../helpers/cv-fonts.js';
import { craftLatoPdf, craftPdf, tamperSameLength } from '../helpers/cv-pdf-tamper.js';
import { fictionalResume } from '../helpers/cv-resume.js';

// Renderizar e validar PDFs é mais lento com a suíte inteira rodando em paralelo.
vi.setConfig({ testTimeout: 30_000 });

const hasPoppler = spawnSync('pdffonts', ['-v']).status === 0;
const OFF: ValidateOptions = { poppler: 'off' };
const check = (report: ValidationReport, id: CheckId) => {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`sem ${id}`);
  return found;
};
const text = (report: ValidationReport, id: CheckId): string =>
  check(report, id).details.join('\n');

let resume: ResolvedResume;
let bytes: Buffer;
let regular: ReturnType<typeof realFont>;
let program: Buffer;
let cmap: Map<number, string>;
beforeAll(async () => {
  resume = fictionalResume();
  bytes = (await renderResume(resume)).bytes;
  regular = realFont(bytes, 'Regular');
  program = regular.program ?? Buffer.alloc(0);
  cmap = regular.toUnicode?.map ?? new Map<number, string>();
});

/** CIDs de letras comuns, para os PDFs sintéticos. */
const cidOf = (char: string): number => {
  for (const [cid, value] of cmap) if (value === char) return cid;
  throw new Error(`sem CID para "${char}"`);
};
const goodPdf = (overrides: Partial<Parameters<typeof fontPdf>[0]> = {}): Buffer =>
  fontPdf({
    program,
    toUnicode: cmapText(cmap),
    content: showCids([cidOf('a'), cidOf('b')]),
    ...overrides,
  });

describe('H6 e H7: PDFs válidos do renderizador', () => {
  it('uma e duas páginas, com e sem o pdffonts do Poppler', async () => {
    for (const options of [OFF, {}] as ValidateOptions[]) {
      for (const input of [
        fictionalResume(),
        fictionalResume({ extraBullets: 2, extraEntries: 2 }),
      ]) {
        const report = await validateRenderedPdf((await renderResume(input)).bytes, input, options);
        expect(check(report, 'H6').status, text(report, 'H6')).toBe('pass');
        expect(check(report, 'H7').status, text(report, 'H7')).toBe('pass');
        expect(report.ok).toBe(true);
      }
    }
  });

  it('o relatório lista todas as dez verificações, `pending` vazio e complete:false', async () => {
    const report = await validateRenderedPdf(bytes, resume, OFF);
    expect(report.implemented).toEqual([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'H7',
      'H8',
      'H9',
      'H10',
    ]);
    expect(report.pending).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.checks.map((c) => c.id)).toEqual(report.implemented);
    expect(check(report, 'H6').summary).toMatch(/2 fonte\(s\) Type0\/Identity-H.*todos cobertos/);
    expect(check(report, 'H7').summary).toMatch(
      /entrada\(s\) do ToUnicode com um único caractere válido/,
    );
  });

  it.skipIf(!hasPoppler)('o pdffonts real concorda (nomes, emb, sub e uni)', async () => {
    const report = await validateRenderedPdf(bytes, resume, {});
    expect(text(report, 'H6')).toMatch(
      /pdffonts .* concorda: 2 fonte\(s\) embutida\(s\), em subconjunto e com ToUnicode/,
    );
  });

  it('um PDF com acentos e travessões passa (cada glifo mapeia para um único caractere)', async () => {
    const accented = fictionalResume();
    const entry = accented.experience.entries[0];
    if (entry === undefined) throw new Error('sem entrada');
    entry.bullets[0] =
      'Atuação em integração contínua — gestão de produção, ação e coração; “aspas” e ‘apóstrofos’.';
    const report = await validateRenderedPdf((await renderResume(accented)).bytes, accented, OFF);
    expect(check(report, 'H6').status).toBe('pass');
    expect(check(report, 'H7').status).toBe('pass');
  });

  it('coleta as fontes sem repetir a mesma em várias páginas', async () => {
    const two = (await renderResume(fictionalResume({ extraBullets: 2, extraEntries: 2 }))).bytes;
    const structure = readPdfStructure(two);
    const fonts = collectFonts(structure, analyzePages(structure).pages);
    expect(fonts).toHaveLength(2);
    expect(fonts.map((f) => f.resourceNames.join()).sort()).toEqual(['F2', 'F3']);
    expect(fonts.every((f) => f.truetype?.problems.length === 0)).toBe(true);
  });

  it('o PDF sintético com a fonte real passa (controle dos casos negativos)', () => {
    const { h6, h7 } = runFontChecks(goodPdf());
    expect(h6.status, h6.details.join('\n')).toBe('pass');
    expect(h7.status, h7.details.join('\n')).toBe('pass');
  });
});

describe('H6: nomes, estrutura e programa embutido (PDF real adulterado, mesmo tamanho)', () => {
  it.each([
    [
      'nome fora do padrão (nas três declarações)',
      () => bytes.toString('latin1').replaceAll('+Lato-Regular', '+Lato-Regulax'),
      /nome fora do padrão permitido/,
    ],
    [
      'nomes inconsistentes (só na fonte Type0)',
      () => tamperSameLength(bytes, '+Lato-Regular', '+Lato-Regulax', 0),
      /nomes inconsistentes/,
    ],
    [
      'programa removido (/FontFile2)',
      () => tamperSameLength(bytes, '/FontFile2', '/FontFile9'),
      /sem programa de fonte embutido \(\/FontFile2\)/,
    ],
    [
      'programa que não é TrueType (/FontFile3)',
      () => tamperSameLength(bytes, '/FontFile2', '/FontFile3'),
      /programa de fonte que não é TrueType \(\/FontFile3\)/,
    ],
    ['sem ToUnicode', () => tamperSameLength(bytes, '/ToUnicode', '/ToUnicodx'), /sem \/ToUnicode/],
    [
      'codificação diferente de Identity-H',
      () => tamperSameLength(bytes, '/Identity-H', '/Identity-V'),
      /codificação Identity-V em vez de Identity-H/,
    ],
    [
      'CIDToGIDMap diferente de Identity',
      () => tamperSameLength(bytes, '/CIDToGIDMap /Identity', '/CIDToGIDMap /Identitx'),
      /CIDToGIDMap Identitx em vez de \/Identity/,
    ],
    [
      'descendente que não é CIDFontType2',
      () => tamperSameLength(bytes, '/CIDFontType2', '/CIDFontType0'),
      /descendente \/CIDFontType0 em vez de \/CIDFontType2/,
    ],
  ])('%s', async (_name, make, message) => {
    const tampered =
      typeof make() === 'string' ? Buffer.from(make() as string, 'latin1') : (make() as Buffer);
    const report = await validateRenderedPdf(tampered, resume, OFF);
    expect(check(report, 'H6').status).toBe('fail');
    expect(text(report, 'H6')).toMatch(message);
    expect(report.ok).toBe(false);
  });

  it('fonte padrão do PDF (Helvetica, não embutida)', async () => {
    const helvetica = await craftPdf((pdf) => {
      pdf.fontSize(10).text('Texto em fonte padrão', 46, 100, { lineBreak: false });
    });
    const report = await validateRenderedPdf(helvetica, resume, OFF);
    expect(check(report, 'H6').status).toBe('fail');
    expect(text(report, 'H6')).toMatch(/é uma das 14 fontes padrão do PDF \(não embutida\)/);
    expect(text(report, 'H6')).toMatch(/sem programa de fonte embutido/);
  });
});

describe('H6: estrutura da fonte (PDF sintético)', () => {
  const failing = (overrides: Partial<Parameters<typeof fontPdf>[0]>) =>
    runFontChecks(goodPdf(overrides)).h6.details.join('\n');

  it('duas fontes descendentes, Type1 em vez de Type0 e nome padrão de subconjunto', () => {
    expect(failing({ descendants: 2 })).toMatch(/2 fontes descendentes \(esperava 1\)/);
    expect(failing({ subtype: 'Type1' })).toMatch(/\/Subtype \/Type1 em vez de \/Type0/);
    expect(
      failing({ baseFont: 'Helvetica', cidBaseFont: 'Helvetica', descriptorName: 'Helvetica' }),
    ).toMatch(/14 fontes padrão/);
    expect(
      failing({
        baseFont: 'Lato-Regular',
        cidBaseFont: 'Lato-Regular',
        descriptorName: 'Lato-Regular',
      }),
    ).toMatch(/nome fora do padrão/);
    expect(failing({ cidBaseFont: 'ABCDEF+Lato-Bold' })).toMatch(/nomes inconsistentes/);
  });

  it('o padrão de nome é configurável', () => {
    const pdf = goodPdf({
      baseFont: 'ABCDEF+Outra-Fonte',
      cidBaseFont: 'ABCDEF+Outra-Fonte',
      descriptorName: 'ABCDEF+Outra-Fonte',
    });
    expect(runFontChecks(pdf).h6.details.join()).toMatch(/nome fora do padrão/);
    expect(runFontChecks(pdf, { allowedFonts: [/^[A-Z]{6}\+Outra-Fonte$/u] }).h6.status).toBe(
      'pass',
    );
  });

  it('programa TrueType ruim aparece na fonte certa (tabela extra, glifos demais, limites do chamador)', () => {
    const extra = mutateTtf(program, (p) => p.tables.set('GSUB', Buffer.alloc(16)));
    expect(runFontChecks(goodPdf({ program: extra })).h6.details.join()).toMatch(
      /fonte ABCDEF\+Lato-Regular: tabela não permitida: "GSUB"/,
    );
    expect(runFontChecks(goodPdf(), { limits: { maxGlyphs: 10 } }).h6.details.join()).toMatch(
      /numGlyphs \d+ fora de 1 a 10/,
    );
    const truncated = program.subarray(0, 700);
    expect(runFontChecks(goodPdf({ program: truncated })).h6.details.join()).toMatch(
      /programa de fonte pequeno demais/,
    );
  });

  it('ToUnicode ilegível', () => {
    const broken = runFontChecks(goodPdf({ toUnicode: 'beginbfchar <0001> endbfchar' }));
    expect(broken.h6.details.join()).toMatch(
      /ToUnicode ilegível \(bfchar com número ímpar de valores\)/,
    );
  });
});

describe('H6: cobertura dos CIDs usados', () => {
  const run = (content: string, entries: Map<number, string> = cmap) =>
    runFontChecks(goodPdf({ content, toUnicode: cmapText(entries) })).h6;

  it('todos os glifos desenhados têm texto no ToUnicode (controle)', () => {
    const h6 = run(showCids([cidOf('a'), cidOf('b'), cidOf(' ')]));
    expect(h6.status, h6.details.join()).toBe('pass');
  });

  it('CID usado sem mapeamento', () => {
    const without = new Map(cmap);
    const cid = cidOf('a');
    without.delete(cid);
    const h6 = run(showCids([cid, cidOf('b')]), without);
    expect(h6.status).toBe('fail');
    expect(h6.details.join()).toMatch(
      new RegExp(`1 CID\\(s\\) usado\\(s\\) sem mapeamento no ToUnicode: ${cid}`),
    );
  });

  it('CID além dos glifos do programa', () => {
    const entries = new Map(cmap).set(5000, 'x');
    expect(run(showCids([5000]), entries).details.join()).toMatch(
      /CID\(s\) além dos glifos do programa: 5000/,
    );
  });

  it('o glifo .notdef (CID 0) desenhado', () => {
    expect(run(showCids([0, cidOf('a')])).details.join()).toMatch(
      /o glifo \.notdef \(CID 0\) é desenhado/,
    );
  });

  it('glifo vazio mapeado para letra visível (texto invisível); o espaço continua permitido', () => {
    const space = [...cmap].find(([, value]) => value === ' ')?.[0];
    if (space === undefined) throw new Error('sem CID de espaço');
    expect(run(showCids([space, cidOf('a')])).status).toBe('pass');
    const spoofed = new Map(cmap).set(space, 'A');
    const h6 = run(showCids([space]), spoofed);
    expect(h6.status).toBe('fail');
    expect(h6.details.join()).toMatch(
      /glifo vazio para caractere visível \(texto invisível\): CID \d+ → "A"/,
    );
  });
});

describe('H6: pdffonts do Poppler (executor injetável)', () => {
  const runner =
    (
      fonts: string | undefined,
      options: { missing?: boolean; fontsFail?: boolean } = {},
    ): PopplerRunner =>
    (command, args, input) => {
      if (options.missing === true) return { status: null, stdout: '', stderr: '' };
      if (args.includes('-v')) return { status: 0, stdout: '', stderr: 'pdftotext version 9.9.9' };
      if (command === 'pdffonts')
        return options.fontsFail === true
          ? { status: 1, stdout: '', stderr: 'Syntax Error' }
          : { status: 0, stdout: fonts ?? '', stderr: '' };
      const text = spawnSync(
        'pdftotext',
        ['-enc', 'UTF-8', ...(args.includes('-raw') ? ['-raw'] : []), '-', '-'],
        { input, encoding: 'utf8' },
      );
      return { status: 0, stdout: text.stdout, stderr: '' };
    };
  const table = (rows: string[]): string =>
    [
      'name type encoding emb sub uni object ID',
      '---- ---- -------- --- --- --- ---------',
      ...rows,
      '',
    ].join('\n');
  const good = [
    'CZZZZZ+Lato-Bold  CID TrueType  Identity-H  yes yes yes  13 0',
    'DZZZZZ+Lato-Regular  CID TrueType  Identity-H  yes yes yes  15 0',
  ];
  const h6 = async (
    fonts: string,
    options: Parameters<typeof runner>[1] = {},
    mode: ValidateOptions['poppler'] = 'auto',
  ) =>
    check(
      await validateRenderedPdf(bytes, resume, {
        poppler: mode,
        popplerRunner: runner(fonts, options),
      }),
      'H6',
    );

  it.skipIf(!hasPoppler)('uma tabela coerente com as fontes do PDF concorda', async () => {
    const result = await h6(table(good));
    expect(result.status, result.details.join()).toBe('pass');
    expect(result.details.join()).toMatch(/concorda: 2 fonte\(s\)/);
  });

  it.skipIf(!hasPoppler)(
    'divergências: não embutida, sem subconjunto, sem ToUnicode, tipo e codificação',
    async () => {
      const cases: [string, string, RegExp][] = [
        [
          'emb no',
          'CZZZZZ+Lato-Bold  CID TrueType  Identity-H  no yes yes  13 0',
          /fonte não embutida \(emb no\)/,
        ],
        [
          'sub no',
          'CZZZZZ+Lato-Bold  CID TrueType  Identity-H  yes no yes  13 0',
          /não é um subconjunto \(sub no\)/,
        ],
        [
          'uni no',
          'CZZZZZ+Lato-Bold  CID TrueType  Identity-H  yes yes no  13 0',
          /sem ToUnicode \(uni no\)/,
        ],
        [
          'tipo',
          'CZZZZZ+Lato-Bold  Type 1  Identity-H  yes yes yes  13 0',
          /tipo "Type 1" em vez de CID TrueType/,
        ],
        [
          'codificação',
          'CZZZZZ+Lato-Bold  CID TrueType  WinAnsi  yes yes yes  13 0',
          /codificação WinAnsi em vez de Identity-H/,
        ],
      ];
      for (const [name, row, message] of cases) {
        const result = await h6(table([row, good[1] ?? '']));
        expect(result.status, name).toBe('fail');
        expect(result.details.join(), name).toMatch(message);
      }
    },
  );

  it.skipIf(!hasPoppler)('fonte a menos, fonte a mais e nome diferente', async () => {
    const missing = await h6(table([good[1] ?? '']));
    expect(missing.details.join()).toMatch(/pdffonts não lista a fonte CZZZZZ\+Lato-Bold/);
    const extra = await h6(
      table([...good, 'ZZZZZZ+Intrusa  CID TrueType  Identity-H  yes yes yes  99 0']),
    );
    expect(extra.details.join()).toMatch(/pdffonts lista uma fonte a mais: ZZZZZZ\+Intrusa/);
    const renamed = await h6(table(good.map((row) => row.replace('Lato-Bold', 'Lato-Bolx'))));
    expect(renamed.status).toBe('fail');
  });

  it('saída ilegível, erro do pdffonts e Poppler ausente (auto ignora, require reprova)', async () => {
    expect((await h6('lixo sem tabela')).details.join()).toMatch(
      /saída do pdffonts sem a tabela esperada/,
    );
    expect((await h6(table(['linha quebrada']))).details.join()).toMatch(
      /linha do pdffonts ilegível/,
    );
    expect((await h6('', { fontsFail: true })).details.join()).toMatch(
      /pdffonts terminou com erro/,
    );
    const auto = await h6('', { missing: true });
    expect(auto.status).toBe('pass');
    expect(auto.details.join()).toMatch(/pdffonts ignorado \(mode "auto"\)/);
    const required = await h6('', { missing: true }, 'require');
    expect(required.status).toBe('fail');
    expect(required.details.join()).toMatch(/Poppler exigido \(mode "require"\).*pdffonts/);
    const off = await h6('', {}, 'off');
    expect(off.details.join()).toMatch(/pdffonts desligado/);
  });

  it('parsePdffonts: tabela real, tipos com espaço e erros', () => {
    const parsed = parsePdffonts(table(good));
    expect(parsed.problems).toEqual([]);
    expect(
      parsed.rows.map((r) => [r.name, r.type, r.encoding, r.emb, r.sub, r.uni, r.object]),
    ).toEqual([
      ['CZZZZZ+Lato-Bold', 'CID TrueType', 'Identity-H', true, true, true, 13],
      ['DZZZZZ+Lato-Regular', 'CID TrueType', 'Identity-H', true, true, true, 15],
    ]);
    expect(parsePdffonts('').problems[0]).toMatch(/sem a tabela esperada/);
    expect(parsePdffonts(table(['x y z'])).problems[0]).toMatch(/ilegível/);
  });
});

describe('H7: ligaduras e mapeamentos Unicode compostos', () => {
  it('PDF montado com ligaduras LIGADAS na Lato: o texto continua igual, mas o ToUnicode é composto', async () => {
    const fonts = loadFonts();
    const withLigatures = await craftLatoPdf((p) => {
      p.fontSize(10).text('official fine floor difícil final', 46, 100, { lineBreak: false });
    }, fonts);
    const report = await validateRenderedPdf(withLigatures, resume, OFF);
    expect(check(report, 'H7').status).toBe('fail');
    expect(text(report, 'H7')).toMatch(
      /mapeamento composto \(\d pontos de código: U\+0066 U\+0066 U\+0069\)/,
    );
    expect(text(report, 'H7')).toMatch(
      /mapeamento composto \(2 pontos de código: U\+0066 U\+006C\)/,
    );
    // O texto extraído pelo pdfjs é o mesmo ("fi" sai como duas letras): só o H7 percebe.
    expect((await extractForValidation(withLigatures)).streamText).toContain('official fine floor');
  });

  describe('ToUnicode sintético (a fonte real, com uma entrada adulterada)', () => {
    const withEntry = (cid: number, value: string) => {
      const entries = new Map(cmap).set(cid, value);
      return runFontChecks(goodPdf({ toUnicode: cmapText(entries) })).h7;
    };
    const cid = 7;

    it.each([
      ['ligadura fi (U+FB01)', 'ﬁ', /ligadura ou forma de apresentação \(U\+FB01\)/],
      ['ligadura ffl (U+FB04)', 'ﬄ', /U\+FB04/],
      ['ligadura st (U+FB06)', 'ﬆ', /U\+FB06/],
      ['forma de apresentação árabe (lam-alef)', 'ﻻ', /U\+FEFB/],
      ['ligadura armênia', 'ﬓ', /U\+FB13/],
      ['ligadura hebraica', 'שׁ', /U\+FB2A/],
      ['dígrafo IJ (U+0132)', 'Ĳ', /U\+0132/],
      ['dígrafo DŽ (U+01C4)', 'Ǆ', /U\+01C4/],
      [
        'dois pontos de código ("fi")',
        'fi',
        /mapeamento composto \(2 pontos de código: U\+0066 U\+0069\)/,
      ],
      [
        'acento decomposto (e + U+0301)',
        'é',
        /mapeamento composto \(2 pontos de código: U\+0065 U\+0301\)/,
      ],
      ['três pontos de código', 'ffi', /3 pontos de código/],
      ['controle (U+0001)', '\u0001', /caractere inválido \(U\+0001\)/],
      ['NUL em um CID comum', '\u0000', /caractere inválido \(U\+0000\)/],
      ['caractere de controle C1 (U+0085)', '\u0085', /U\+0085/],
      ['caractere de substituição (U+FFFD)', '�', /caractere inválido \(U\+FFFD\)/],
      ['uso privado (U+E000)', '', /caractere inválido \(U\+E000\)/],
      ['não caractere (U+FDD0)', '﷐', /caractere inválido \(U\+FDD0\)/],
      ['não caractere (U+FFFF)', '￿', /caractere inválido \(U\+FFFF\)/],
      ['substituto solto', '\uD800', /caractere inválido \(U\+D800\)/],
      ['espaço de largura zero', '​', /caractere invisível ou de formatação \(U\+200B\)/],
      ['hífen suave', '­', /caractere invisível ou de formatação \(U\+00AD\)/],
      ['marca bidirecional', '‮', /U\+202E/],
      ['BOM', '﻿', /U\+FEFF/],
    ])('recusa %s', (_name, value, message) => {
      const h7 = withEntry(cid, value);
      expect(h7.status, h7.details.join()).toBe('fail');
      expect(h7.details.join()).toMatch(message);
      expect(h7.details.join()).toMatch(/entrada\(s\) do ToUnicode recusada\(s\)/);
    });

    it.each([
      ['letra acentuada', 'é'],
      ['cê-cedilha', 'ç'],
      ['travessão', '—'],
      ['aspas curvas', '“'],
      ['espaço', ' '],
      ['espaço não separável', ' '],
      ['caractere fora do plano básico (par substituto válido)', '😀'],
      ['sinal de euro', '€'],
    ])('aceita %s', (_name, value) => {
      const h7 = withEntry(cid, value);
      expect(h7.status, h7.details.join()).toBe('pass');
    });

    it('exceção específica: o .notdef (CID 0) mapeado para U+0000, como o PDFKit grava; qualquer outro CID não', () => {
      expect(withEntry(0, '\u0000').status).toBe('pass');
      expect(withEntry(1, '\u0000').status).toBe('fail');
      expect(withEntry(0, 'ﬁ').status).toBe('fail'); // a exceção é só para U+0000
    });

    it('todas as entradas são examinadas, não só as usadas (a ligadura em CID não usado reprova)', () => {
      const pdf = goodPdf({ toUnicode: cmapText(new Map(cmap).set(40, 'ﬁ')) });
      expect(runFontChecks(pdf).h7.status).toBe('fail');
    });
  });

  describe('texto extraído', () => {
    it('suspiciousInText: ligaduras, invisíveis e inválidos; quebras e acentos não', () => {
      expect(suspiciousInText('ação\n\tcom\r\nacentos — “aspas” 😀\f')).toEqual([]);
      expect(suspiciousInText('ofﬁcial')).toEqual(['U+FB01']);
      expect(suspiciousInText('a​b�c')).toEqual(['U+200B', 'U+FFFD']);
    });

    it('classifyMapping: casos limite', () => {
      expect(classifyMapping('a')).toBeUndefined();
      expect(classifyMapping('')).toMatch(/0 pontos de código/);
      expect(classifyMapping('😀')).toBeUndefined();
    });

    it('ligadura no texto do Poppler (executor falso) ou dos operadores reprova', async () => {
      const runner: PopplerRunner = (command, args, input) => {
        if (args.includes('-v'))
          return { status: 0, stdout: '', stderr: 'pdftotext version 9.9.9' };
        if (command === 'pdffonts') {
          const names = [
            ...new Set(
              [...input.toString('latin1').matchAll(/\/BaseFont \/(\S+)/g)].map((m) => m[1] ?? ''),
            ),
          ];
          return {
            status: 0,
            stdout: [
              'name type encoding emb sub uni object ID',
              '--- --- --- --- --- --- ---',
              ...names.map((n) => `${n}  CID TrueType  Identity-H  yes yes yes  1 0`),
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        return { status: 0, stdout: 'texto com ofﬁcial\n', stderr: '' };
      };
      const report = await validateRenderedPdf(bytes, resume, { popplerRunner: runner });
      expect(check(report, 'H7').status).toBe('fail');
      expect(text(report, 'H7')).toMatch(
        /texto extraído \(Poppler\) com ligadura, invisível ou inválido: U\+FB01/,
      );
    });

    it('estrutura ilegível: H6 e H7 falham fechados (os demais checks seguem)', async () => {
      const report = await validateRenderedPdf(bytes, resume, {
        ...OFF,
        structureLimits: { maxObjects: 10 },
      });
      expect(text(report, 'H6')).toMatch(/TOO_MANY_OBJECTS/);
      expect(text(report, 'H7')).toMatch(/TOO_MANY_OBJECTS/);
      for (const id of ['H1', 'H2', 'H3', 'H4'] as const)
        expect(check(report, id).status).toBe('pass');
    });

    it('checkLigatures: sem estrutura falha fechado', () => {
      const result = checkLigatures({
        structure: undefined,
        structureError: 'x',
        fonts: [],
        texts: [],
      });
      expect(result.status).toBe('fail');
    });
  });
});
