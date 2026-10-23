import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  loadFonts,
  renderResume,
  validateRenderedPdf,
  type CheckId,
  type ResolvedResume,
  type ValidationReport,
} from '../../src/cv/index.js';
import {
  checkFontIdentity,
  prepareReferences,
  readTrueType,
  type ReferenceFontInput,
} from '../../src/cv/validate/index.js';
import {
  buildTtf,
  cmapText,
  fontPdf,
  mutateTtf,
  parseTtf,
  realFont,
  runFontChecks,
  showCids,
} from '../helpers/cv-fonts.js';
import { fictionalResume } from '../helpers/cv-resume.js';

// Renderizar e validar PDFs é mais lento com a suíte inteira rodando em paralelo.
vi.setConfig({ testTimeout: 30_000 });

const check = (report: ValidationReport, id: CheckId) => {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`sem ${id}`);
  return found;
};

let resume: ResolvedResume;
let bytes: Buffer;
let references: ReferenceFontInput[];
let regular: Buffer;
let bold: Buffer;
let cmap: Map<number, string>;
beforeAll(async () => {
  resume = fictionalResume();
  bytes = (await renderResume(resume)).bytes;
  const fonts = loadFonts();
  references = [
    { name: 'Lato-Regular', bytes: new Uint8Array(fonts.regular) },
    { name: 'Lato-Bold', bytes: new Uint8Array(fonts.bold) },
  ];
  const facts = realFont(bytes, 'Regular');
  regular = facts.program ?? Buffer.alloc(0);
  bold = realFont(bytes, 'Bold').program ?? Buffer.alloc(0);
  cmap = facts.toUnicode?.map ?? new Map<number, string>();
});

const cidOf = (char: string): number => {
  for (const [cid, value] of cmap) if (value === char) return cid;
  throw new Error(`sem CID para "${char}"`);
};
/** PDF sintético com a fonte Regular (ou o programa dado) e as referências reais. */
const identityOf = (program: Buffer, extra: Partial<Parameters<typeof fontPdf>[0]> = {}) =>
  runFontChecks(
    fontPdf({
      program,
      toUnicode: cmapText(cmap),
      content: showCids([cidOf('a'), cidOf('b')]),
      ...extra,
    }),
    { references },
  );
const problems = (program: Buffer, extra: Partial<Parameters<typeof fontPdf>[0]> = {}): string =>
  identityOf(program, extra).h6.details.join('\n');

/** Faixa de um glifo dentro do arquivo do subconjunto. */
function glyphAt(program: Buffer, glyph: number): { start: number; end: number } {
  const font = readTrueType(program).font;
  const glyf = font?.tables.get('glyf');
  const range = font?.glyphRanges[glyph];
  if (glyf === undefined || range === undefined) throw new Error('sem glifo');
  return { start: glyf.offset + range[0], end: glyf.offset + range[1] };
}
/** Primeiro glifo simples não vazio com mais de 12 bytes, depois do .notdef. */
function simpleGlyph(program: Buffer): number {
  const font = readTrueType(program).font;
  if (font === undefined) throw new Error('programa ilegível');
  for (let g = 1; g < font.numGlyphs; g++) {
    const { start, end } = glyphAt(program, g);
    if (end - start > 12 && program.readInt16BE(start) >= 0) return g;
  }
  throw new Error('sem glifo simples');
}
const flipAt = (buffer: Buffer, at: number): void => {
  buffer[at] = (buffer[at] ?? 0) ^ 0x01;
};
const flip = (program: Buffer, at: number): Buffer => {
  const copy = Buffer.from(program);
  copy[at] = (copy[at] ?? 0) ^ 0xff;
  return copy;
};

describe('2b-ii-b1: identidade com a Lato original (positivos)', () => {
  it('os PDFs do renderizador passam no H6 com identidade PARCIAL, nunca verificada', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      poppler: 'off',
      referenceFonts: references,
    });
    expect(check(report, 'H6').status, check(report, 'H6').details.join('\n')).toBe('pass');
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.fontIdentity.status).toBe('partial');
    expect(report.fontIdentity.pending.join(' ')).toMatch(/compostos/);
    expect(report.fontIdentity.pending.join(' ')).toMatch(/ToUnicode/);
    expect(report.fontIdentity.proven.join(' ')).toMatch(/fpgm, prep e cvt/);
    expect(check(report, 'H6').details.join('\n')).toMatch(
      /identidade com a Lato original: PARCIAL/,
    );
  });

  it('as duas variantes são comparadas com a referência certa e as contas fecham', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      poppler: 'off',
      referenceFonts: references,
    });
    const fonts = report.fontIdentity.fonts;
    expect(fonts.map((f) => f.variant).sort()).toEqual(['Lato-Bold', 'Lato-Regular']);
    for (const f of fonts) {
      expect(f.tablesIdentical).toBe(true);
      expect(f.simpleMatched).toBeGreaterThan(20);
      expect(f.composite).toBeGreaterThan(0); // compostos NÃO são comprovados nesta versão
      expect(f.simpleMatched + f.composite + f.empty).toBe(f.glyphs);
    }
  });

  it('sem referências o H6 segue estrutural e o relatório diz que a identidade não foi verificada', async () => {
    const report = await validateRenderedPdf(bytes, resume, { poppler: 'off' });
    expect(report.fontIdentity.status).toBe('not-supplied');
    expect(report.fontIdentity.proven).toEqual([]);
    expect(report.fontIdentity.fonts).toEqual([]);
    expect(check(report, 'H6').status).toBe('pass');
    expect(check(report, 'H6').details.join('\n')).toMatch(/NÃO foi verificada/);
  });

  it('PDF ilegível: a identidade fica "not-run" (H6 não rodou)', async () => {
    const report = await validateRenderedPdf(Buffer.from('não é um PDF'), resume, {
      poppler: 'off',
      referenceFonts: references,
    });
    expect(report.fontIdentity.status).toBe('not-run');
    expect(report.ok).toBe(false);
  });

  it('o subconjunto real passa direto pelo comparador, sem problemas', () => {
    const prepared = prepareReferences(references);
    expect(prepared?.problems).toEqual([]);
    const font = readTrueType(regular).font;
    const result = checkFontIdentity(
      'ABCDEF+Lato-Regular',
      font,
      prepared ?? { byName: new Map(), problems: [] },
    );
    expect(result.problems).toEqual([]);
    expect(result.summary.tablesIdentical).toBe(true);
  });

  it('aceita as referências como Uint8Array com deslocamento (sem copiar nem abrir arquivo)', () => {
    const fonts = loadFonts();
    const padded = new Uint8Array(fonts.regular.length + 100);
    padded.set(fonts.regular, 100);
    const prepared = prepareReferences([
      { name: 'Lato-Regular', bytes: padded.subarray(100) },
      { name: 'Lato-Bold', bytes: new Uint8Array(fonts.bold) },
    ]);
    expect(prepared?.problems).toEqual([]);
  });
});

describe('2b-ii-b1: adulteração das fontes do PDF (negativos)', () => {
  it('o PDF sintético sem adulteração passa', () => {
    const { h6, identity } = identityOf(regular);
    expect(h6.status, h6.details.join('\n')).toBe('pass');
    expect(identity.status).toBe('partial');
  });

  it.each([
    ['fpgm', 'fpgm'],
    ['prep', 'prep'],
    ['cvt ', 'cvt'],
  ])('um byte alterado em %s', (tag, label) => {
    const tampered = mutateTtf(regular, (parts) => {
      const table = parts.tables.get(tag);
      if (table === undefined) throw new Error('sem tabela');
      flipAt(table, Math.floor(table.length / 2));
    });
    const { h6, identity } = identityOf(tampered);
    expect(h6.status).toBe('fail');
    expect(identity.status).toBe('failed');
    expect(h6.details.join('\n')).toMatch(new RegExp(`tabela "${label}[ "]`));
  });

  it('tabela de hinting removida', () => {
    const tampered = mutateTtf(regular, (parts) => {
      parts.tables.delete('prep');
    });
    expect(problems(tampered)).toMatch(/tabela "prep" ausente/);
  });

  it.each([
    ['head', 4, /tabela "head" difere/],
    ['hhea', 4, /tabela "hhea" difere/],
    ['maxp', 6, /tabela "maxp" difere/],
  ])('campo fixo alterado em %s', (tag, at, pattern) => {
    const tampered = mutateTtf(regular, (parts) => {
      const table = parts.tables.get(tag);
      if (table === undefined) throw new Error('sem tabela');
      flipAt(table, at);
    });
    expect(problems(tampered)).toMatch(pattern);
  });

  it('glifo simples modificado (um byte do contorno)', () => {
    const g = simpleGlyph(regular);
    const { end } = glyphAt(regular, g);
    const { h6, identity } = identityOf(flip(regular, end - 1));
    expect(h6.status).toBe('fail');
    expect(identity.status).toBe('failed');
    expect(h6.details.join('\n')).toMatch(/glifo\(s\) simples sem correspondente.*adulterado/);
  });

  it('.notdef modificado', () => {
    const { end } = glyphAt(regular, 0);
    expect(problems(flip(regular, end - 1))).toMatch(/glifo\(s\) simples sem correspondente/);
  });

  it('fonte "estrangeira": todos os glifos simples com contorno alterado', () => {
    let tampered = regular;
    const font = readTrueType(regular).font;
    for (let g = 0; g < (font?.numGlyphs ?? 0); g++) {
      const { start, end } = glyphAt(regular, g);
      if (end - start > 12 && regular.readInt16BE(start) >= 0) tampered = flip(tampered, end - 1);
    }
    expect(problems(tampered)).toMatch(/\d{2} glifo\(s\) simples sem correspondente/);
  });

  it('largura (hmtx) alterada num glifo simples', () => {
    const g = simpleGlyph(regular);
    const tampered = mutateTtf(regular, (parts) => {
      const hmtx = parts.tables.get('hmtx');
      if (hmtx === undefined) throw new Error('sem hmtx');
      hmtx.writeUInt16BE(hmtx.readUInt16BE(4 * g) + 1, 4 * g);
    });
    expect(problems(tampered)).toMatch(/glifo\(s\) simples com métricas hmtx diferentes/);
  });

  it('lado esquerdo (lsb) alterado num glifo simples', () => {
    const g = simpleGlyph(regular);
    const tampered = mutateTtf(regular, (parts) => {
      const hmtx = parts.tables.get('hmtx');
      if (hmtx === undefined) throw new Error('sem hmtx');
      hmtx.writeInt16BE(hmtx.readInt16BE(4 * g + 2) + 3, 4 * g + 2);
    });
    expect(problems(tampered)).toMatch(/métricas hmtx diferentes/);
  });

  it('largura implausível num glifo vazio (espaço)', () => {
    const font = readTrueType(regular).font;
    if (font === undefined) throw new Error('sem fonte');
    const empty = font.glyphRanges.findIndex(([a, b]) => a === b);
    expect(empty).toBeGreaterThan(0);
    const tampered = mutateTtf(regular, (parts) => {
      const hmtx = parts.tables.get('hmtx');
      if (hmtx === undefined) throw new Error('sem hmtx');
      hmtx.writeUInt16BE(1999, 4 * empty);
    });
    expect(problems(tampered)).toMatch(/glifo\(s\) vazio\(s\) com métricas/);
  });

  it('variante incorreta: programa Bold com nome Regular', () => {
    const text = problems(bold, { baseFont: 'ABCDEF+Lato-Regular' });
    expect(text).toMatch(/identidade/);
    expect(identityOf(bold, { baseFont: 'ABCDEF+Lato-Regular' }).identity.status).toBe('failed');
  });

  it('variante incorreta: programa Regular com nome Bold', () => {
    expect(identityOf(regular, { baseFont: 'ABCDEF+Lato-Bold' }).identity.status).toBe('failed');
  });

  it('nome que não indica a variante (padrão de nome ampliado pelo chamador)', () => {
    const result = runFontChecks(
      fontPdf({
        program: regular,
        toUnicode: cmapText(cmap),
        content: showCids([cidOf('a')]),
        baseFont: 'ABCDEF+Outra',
      }),
      { references, allowedFonts: [/^[A-Z]{6}\+Outra$/u] },
    );
    expect(result.identity.status).toBe('failed');
    expect(result.h6.details.join('\n')).toMatch(/o nome não indica Lato-Regular nem Lato-Bold/);
  });

  it('programa TrueType ilegível não passa por "sem referência"', () => {
    const { identity, h6 } = identityOf(Buffer.alloc(4000));
    expect(h6.status).toBe('fail');
    expect(identity.status).toBe('failed');
  });

  it('o PDF inteiro falha no H6 e o relatório fica "failed" (não "partial")', async () => {
    const tampered = mutateTtf(regular, (parts) => {
      const table = parts.tables.get('fpgm');
      if (table === undefined) throw new Error('sem fpgm');
      flipAt(table, 0);
    });
    const report = await validateRenderedPdf(
      fontPdf({
        program: tampered,
        toUnicode: cmapText(cmap),
        content: showCids([cidOf('a')]),
      }),
      resume,
      { poppler: 'off', referenceFonts: references },
    );
    expect(report.ok).toBe(false);
    expect(report.fontIdentity.status).toBe('failed');
    expect(report.complete).toBe(false);
  });
});

describe('2b-ii-b1: erros estruturais impedem a comparação de identidade', () => {
  it.each([
    ['hmtx', 0],
    ['hmtx', 1],
    ['hmtx', 3],
    ['hmtx', -1], // falta só o último byte de uma métrica
    ['hhea', 0],
    ['hhea', 35],
    ['maxp', 5],
    ['head', 20],
    ['loca', 0],
  ] as const)('tabela %s truncada para %i: H6 e identidade falham sem exceção', (tag, size) => {
    const tampered = mutateTtf(regular, (parts) => {
      const table = parts.tables.get(tag);
      if (table === undefined) throw new Error('sem tabela');
      parts.tables.set(tag, table.subarray(0, size));
    });
    const { h6, identity } = identityOf(tampered);
    expect(h6.status).toBe('fail');
    expect(identity.status).toBe('failed');
    expect(identity.proven).toEqual([]);
    expect(identity.fonts[0]?.simpleMatched).toBe(0);
    expect(h6.details.join('\n')).toMatch(new RegExp(`"${tag}"`));
  });

  it.each([
    ['hhea', 34, 0],
    ['hhea', 34, 9999],
    ['hhea', 34, 1], // exigiria outra organização de hmtx
    ['maxp', 4, 0],
    ['maxp', 4, 9999],
  ] as const)('contagem inválida em %s (%i → %i) reprova sem exceção', (tag, at, count) => {
    const tampered = mutateTtf(regular, (parts) => {
      const table = parts.tables.get(tag);
      if (table === undefined) throw new Error('sem tabela');
      table.writeUInt16BE(count, at);
    });
    const { h6, identity } = identityOf(tampered);
    expect(h6.status).toBe('fail');
    expect(identity.status).toBe('failed');
    expect(identity.fonts[0]?.simpleMatched).toBe(0);
    expect(h6.details.join('\n')).toMatch(/incoerente|numGlyphs .* fora/);
  });

  it('tabela não permitida impede identidade parcial, mesmo com contornos e métricas intactos', () => {
    const tampered = mutateTtf(regular, (parts) => parts.tables.set('GSUB', Buffer.alloc(16)));
    const { h6, identity } = identityOf(tampered);
    expect(h6.status).toBe('fail');
    expect(h6.details.join('\n')).toMatch(/tabela não permitida: "GSUB"/);
    expect(identity.status).toBe('failed');
    expect(identity.fonts[0]?.simpleMatched).toBe(0);
  });

  it('hmtx vazia no PDF inteiro retorna relatório reprovado, preservando complete = false', async () => {
    const tampered = mutateTtf(regular, (parts) => parts.tables.set('hmtx', Buffer.alloc(0)));
    const report = await validateRenderedPdf(
      fontPdf({ program: tampered, toUnicode: cmapText(cmap), content: showCids([cidOf('a')]) }),
      resume,
      { poppler: 'off', referenceFonts: references },
    );
    expect(report.ok).toBe(false);
    expect(check(report, 'H6').status).toBe('fail');
    expect(check(report, 'H6').details.join('\n')).toMatch(/tamanho de "hmtx".*incoerente/);
    expect(report.fontIdentity.status).toBe('failed');
    expect(report.complete).toBe(false);
  });
});

describe('2b-ii-b1: referências inválidas', () => {
  const ok = (name: 'Lato-Regular' | 'Lato-Bold'): ReferenceFontInput => {
    const found = references.find((r) => r.name === name);
    if (found === undefined) throw new Error('sem referência');
    return found;
  };
  const withRefs = (refs: ReferenceFontInput[]) =>
    runFontChecks(
      fontPdf({ program: regular, toUnicode: cmapText(cmap), content: showCids([cidOf('a')]) }),
      { references: refs },
    );
  const failed = (refs: ReferenceFontInput[], pattern: RegExp): void => {
    const { h6, identity } = withRefs(refs);
    expect(h6.status).toBe('fail');
    expect(identity.status).toBe('failed');
    expect(h6.details.join('\n')).toMatch(pattern);
  };

  it('lista vazia', () => {
    failed([], /nenhuma informada/);
  });
  it('bytes que não são TrueType', () => {
    failed(
      [{ name: 'Lato-Regular', bytes: new Uint8Array(100_000).fill(7) }, ok('Lato-Bold')],
      /referência Lato-Regular: cabeçalho sfnt inválido/,
    );
  });
  it('referência truncada', () => {
    failed(
      [
        { name: 'Lato-Regular', bytes: ok('Lato-Regular').bytes.subarray(0, 60_000) },
        ok('Lato-Bold'),
      ],
      /referência Lato-Regular/,
    );
  });
  it('o próprio subconjunto usado como referência (pequeno demais)', () => {
    failed(
      [{ name: 'Lato-Regular', bytes: new Uint8Array(regular) }, ok('Lato-Bold')],
      /referência Lato-Regular: programa de fonte pequeno demais/,
    );
  });
  it('nomes trocados (o Bold entregue como Regular)', () => {
    failed(
      [
        { name: 'Lato-Regular', bytes: ok('Lato-Bold').bytes },
        { name: 'Lato-Bold', bytes: ok('Lato-Regular').bytes },
      ],
      /variante trocada/,
    );
  });
  it('a mesma variante duas vezes', () => {
    failed([ok('Lato-Regular'), ok('Lato-Regular'), ok('Lato-Bold')], /informada mais de uma vez/);
  });
  it('os mesmos bytes nas duas variantes', () => {
    failed(
      [ok('Lato-Regular'), { name: 'Lato-Bold', bytes: ok('Lato-Regular').bytes }],
      /mesmos bytes|variante trocada/,
    );
  });
  it('nome inválido', () => {
    failed(
      [
        ok('Lato-Regular'),
        ok('Lato-Bold'),
        { name: 'Lato-Italic' as 'Lato-Bold', bytes: ok('Lato-Bold').bytes },
      ],
      /nome inválido/,
    );
  });
  it('bytes que não são Uint8Array', () => {
    failed(
      [{ name: 'Lato-Regular', bytes: 'texto' as unknown as Uint8Array }, ok('Lato-Bold')],
      /não são um Uint8Array/,
    );
  });
  it('sem a variante usada pelo PDF', () => {
    failed([ok('Lato-Bold')], /sem referência válida para Lato-Regular/);
  });
  it('referência sem fpgm/prep/cvt (não é a Lato completa)', () => {
    const stripped = buildTtf({
      ...parseTtf(Buffer.from(ok('Lato-Regular').bytes)),
      tables: (() => {
        const parts = parseTtf(Buffer.from(ok('Lato-Regular').bytes));
        parts.tables.delete('fpgm');
        return parts.tables;
      })(),
    });
    failed(
      [{ name: 'Lato-Regular', bytes: new Uint8Array(stripped) }, ok('Lato-Bold')],
      /sem fpgm, prep ou cvt/,
    );
  });
  it('referência adulterada: um glifo diferente da original faz o subconjunto não casar', () => {
    const parts = parseTtf(Buffer.from(ok('Lato-Regular').bytes));
    const font = readTrueType(Buffer.from(ok('Lato-Regular').bytes), {}, { reference: true }).font;
    const probe = glyphAt(regular, simpleGlyph(regular));
    const glyphBytesOfSubset = regular.subarray(probe.start, probe.end);
    const glyf = parts.tables.get('glyf');
    if (glyf === undefined || font === undefined) throw new Error('sem glyf');
    const at = glyf.indexOf(glyphBytesOfSubset);
    expect(at).toBeGreaterThan(0);
    flipAt(glyf, at + glyphBytesOfSubset.length - 1);
    failed(
      [{ name: 'Lato-Regular', bytes: new Uint8Array(buildTtf(parts)) }, ok('Lato-Bold')],
      /glifo\(s\) simples sem correspondente/,
    );
  });
  it('referências não informadas: nada falha por isso', () => {
    const { h6, identity } = runFontChecks(
      fontPdf({ program: regular, toUnicode: cmapText(cmap), content: showCids([cidOf('a')]) }),
    );
    expect(h6.status).toBe('pass');
    expect(identity.status).toBe('not-supplied');
  });
});
