import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadFonts, renderResume } from '../../src/cv/index.js';
import {
  checkFontIdentity,
  prepareReferences,
  type ReferenceFontInput,
} from '../../src/cv/validate/font-identity.js';
import {
  glyphBytes,
  glyphMetrics,
  isCompositeGlyph,
  type TrueTypeFont,
} from '../../src/cv/validate/truetype.js';
import {
  cmapText,
  fontPdf,
  mutateTtf,
  realFont,
  runFontChecks,
  showCids,
} from '../helpers/cv-fonts.js';
import { fictionalResume } from '../helpers/cv-resume.js';

vi.setConfig({ testTimeout: 30_000 });
let program: Buffer;
let cmap: Map<number, string>;
let font: TrueTypeFont;
let references: ReferenceFontInput[];
beforeAll(async () => {
  const resume = fictionalResume();
  resume.summary += ' A B á ã ç é ü.';
  const facts = realFont((await renderResume(resume)).bytes, 'Regular');
  if (
    facts.program === undefined ||
    facts.toUnicode === undefined ||
    facts.truetype?.font === undefined
  )
    throw new Error('sem fonte');
  program = facts.program;
  cmap = facts.toUnicode.map;
  font = facts.truetype.font;
  const f = loadFonts();
  references = [
    { name: 'Lato-Regular', bytes: f.regular },
    { name: 'Lato-Bold', bytes: f.bold },
  ];
});
const cid = (char: string) => {
  const entry = [...cmap].find(([, value]) => value === char);
  if (entry === undefined) throw new Error(`sem CID de ${char}`);
  return entry[0];
};
const run = (bytes = program, map = cmap, used = [cid('A')], refs = references, extra = {}) =>
  runFontChecks(
    fontPdf({ program: bytes, toUnicode: cmapText(map), content: showCids(used), ...extra }),
    { references: refs },
  );
const compositeId = () =>
  font.glyphRanges.findIndex((_, g) => isCompositeGlyph(glyphBytes(font, g)));
const mutateGlyph = (gid: number, mutate: (bytes: Buffer) => void) =>
  mutateTtf(program, (parts) => {
    const glyf = parts.tables.get('glyf');
    const range = font.glyphRanges[gid];
    if (glyf === undefined || range === undefined) throw new Error('sem glyf');
    mutate(glyf.subarray(range[0], range[1]));
  });

describe('b2: identidade e Unicode independentes do texto extraído', () => {
  it('prova compostos, vazios e Unicode no subconjunto real de fonte', () => {
    const result = run(program, cmap, [cid('A'), cid('á'), cid('ã'), cid(' ')]);
    expect(result.h6.status, result.h6.details.join('\n')).toBe('pass');
    expect(result.identity.status).toBe('verified');
    expect(result.identity.pending).toEqual([]);
    const summary = result.identity.fonts[0];
    expect(summary?.compositeMatched).toBeGreaterThan(0);
    expect(summary?.compositeMatched).toBe(summary?.composite);
    expect(summary?.emptyMatched).toBe(summary?.empty);
  });
  it.each([
    ['A', 'B'],
    ['á', 'ã'],
    ['A', 'á'],
    [' ', 'A'],
    ['A', ' '],
  ])('desenha %s, declara %s: reprova mesmo com Unicode válido no H7', (drawn, declared) => {
    const map = new Map(cmap);
    map.set(cid(drawn), declared);
    const result = run(program, map, [cid(drawn)]);
    expect(result.h6.status).toBe('fail');
    expect(result.identity.status).toBe('failed');
    expect(result.h6.details.join('\n')).toMatch(/ToUnicode\/cmap/);
    expect(result.h7.status).toBe('pass');
  });
  it('confere também mapeamentos declarados que não são desenhados', () => {
    const map = new Map(cmap);
    map.set(cid('B'), 'A');
    expect(run(program, map, [cid('A')]).identity.status).toBe('failed');
  });
  it('espaço e NBSP com o mesmo glifo original não criam uma falsa divergência', () => {
    const map = new Map(cmap);
    map.set(cid(' '), '\u00a0');
    expect(run(program, map, [cid(' ')]).identity.status).toBe('verified');
  });
  it.each(['', 'AB', '\ud800', '\u{10ffff}'])(
    'Unicode vazio, múltiplo ou sem cobertura: %j',
    (text) => {
      const prepared = prepareReferences(references);
      if (prepared === undefined) throw new Error('sem referências');
      const map = new Map(cmap);
      map.set(cid('A'), text);
      const result = checkFontIdentity('ABCDEF+Lato-Regular', font, prepared, {
        toUnicode: { map, codespace: [[0, 65535]] },
        used: new Set([cid('A')]),
        usageComplete: true,
      });
      expect(result.problems.join(' ')).toMatch(/ToUnicode\/cmap/);
      expect(result.summary.verified).toBe(false);
    },
  );
  it('não promove sem ToUnicode ou com análise incompleta dos usos', () => {
    const prepared = prepareReferences(references);
    if (prepared === undefined) throw new Error('sem referências');
    const missing = checkFontIdentity('ABCDEF+Lato-Regular', font, prepared);
    expect(missing.problems).toEqual([]);
    expect(missing.summary.verified).toBe(false);
    expect(missing.summary.pending.join(' ')).toMatch(/ToUnicode/);
    const incomplete = checkFontIdentity('ABCDEF+Lato-Regular', font, prepared, {
      toUnicode: { map: cmap, codespace: [] },
      used: new Set(),
      usageComplete: false,
    });
    expect(incomplete.summary.verified).toBe(false);
  });
  it('problemas nos operadores impedem verified mesmo quando uma análise parcial foi devolvida', () => {
    const result = run(program, cmap, [cid('A')], references, {
      content: `${showCids([cid('A')])}\n1 Tr`,
    });
    expect(result.identity.status).toBe('partial');
    expect(result.identity.pending.join(' ')).toMatch(/análise completa/);
  });
  it('contornos duplicados sem Unicode ficam parciais; o cmap resolve a identidade quando informado', () => {
    const prepared = prepareReferences(references);
    const ref = prepared?.byName.get('Lato-Regular');
    if (ref === undefined) throw new Error('sem referência');
    // O glifo 10 da Lato tem três candidatos idênticos, inclusive métricas.
    const replacement = glyphBytes(ref.font, 10);
    const metrics = glyphMetrics(ref.font, 10);
    const target = cid('B');
    const range = font.glyphRanges[target];
    if (metrics === undefined || range === undefined) throw new Error('sem glifo');
    const changed = mutateTtf(program, (parts) => {
      const glyf = parts.tables.get('glyf');
      const loca = parts.tables.get('loca');
      const hmtx = parts.tables.get('hmtx');
      if (glyf === undefined || loca === undefined || hmtx === undefined)
        throw new Error('sem tabelas');
      parts.tables.set(
        'glyf',
        Buffer.concat([glyf.subarray(0, range[0]), replacement, glyf.subarray(range[1])]),
      );
      const delta = replacement.length - (range[1] - range[0]);
      for (let g = target + 1; g <= font.numGlyphs; g++)
        loca.writeUInt32BE(loca.readUInt32BE(g * 4) + delta, g * 4);
      hmtx.writeUInt16BE(metrics.advance, target * 4);
      hmtx.writeInt16BE(metrics.lsb, target * 4 + 2);
    });
    const map = new Map(cmap);
    map.delete(target);
    const partial = run(changed, map);
    expect(partial.h6.status, partial.h6.details.join('\n')).toBe('pass');
    expect(partial.identity.status).toBe('partial');
    expect(partial.identity.pending.join(' ')).toMatch(/ambígua/);
    const code = [...ref.cmap].find(([, gid]) => gid === 10)?.[0];
    if (code === undefined) throw new Error('sem Unicode');
    map.set(target, String.fromCodePoint(code));
    expect(run(changed, map).identity.status).toBe('verified');
  });
  it('glifo usado sem mapa e .notdef desenhado reprovam', () => {
    const map = new Map(cmap);
    map.delete(cid('A'));
    expect(run(program, map).identity.status).toBe('failed');
    expect(run(program, cmap, [0]).identity.status).toBe('failed');
    const wrongNotdef = new Map(cmap);
    wrongNotdef.set(0, 'A');
    expect(run(program, wrongNotdef).identity.status).toBe('failed');
  });
  it('CID fora do programa, mesmo sem uso, reprova', () => {
    const map = new Map(cmap);
    map.set(font.numGlyphs, 'A');
    expect(run(program, map).identity.status).toBe('failed');
  });
  it.each(['0041', '0042'])('CID repetido no ToUnicode (%s) nunca é aceito como prova', (hex) => {
    const duplicate = `${cmapText(cmap)}\n1 beginbfchar <${cid('A').toString(16).padStart(4, '0')}> <${hex}> endbfchar`;
    const result = run(program, cmap, [cid('A')], references, { toUnicode: duplicate });
    expect(result.h6.status).toBe('fail');
    expect(result.identity.status).toBe('failed');
    expect(result.h6.details.join('\n')).toMatch(/CID repetido/);
  });
  it('sobreposição entre bfchar e bfrange é recusada', () => {
    const hex = cid('A').toString(16).padStart(4, '0');
    const duplicate = `${cmapText(cmap)}\n1 beginbfrange <${hex}> <${hex}> <0042> endbfrange`;
    expect(
      run(program, cmap, [cid('A')], references, { toUnicode: duplicate }).identity.status,
    ).toBe('failed');
  });
  it('troca do componente por outro existente é detectada', () => {
    const tampered = mutateGlyph(compositeId(), (b) => b.writeUInt16BE(cid('B'), 12));
    const result = run(tampered);
    expect(result.h6.status).toBe('fail');
    expect(result.identity.status).toBe('failed');
    expect(result.h6.details.join('\n')).toMatch(/glifo composto .*difere/);
  });
  it.each([10, 14])('flags/argumentos alterados no composto (byte %i)', (at) => {
    const tampered = mutateGlyph(compositeId(), (b) => {
      b[at] = (b[at] ?? 0) ^ 1;
    });
    expect(run(tampered).identity.status).toBe('failed');
  });
  it('métricas do composto alteradas reprovam', () => {
    const tampered = mutateTtf(program, (parts) => {
      const metrics = parts.tables.get('hmtx');
      const g = compositeId();
      if (metrics === undefined) throw new Error('sem métricas');
      metrics.writeUInt16BE(metrics.readUInt16BE(g * 4) + 1, g * 4);
    });
    expect(run(tampered).h6.details.join('\n')).toMatch(/glifo composto .*difere/);
  });
  it('métrica de vazio com aparência plausível, mas pertencente a outro glifo, não passa', () => {
    const tampered = mutateTtf(program, (parts) => {
      const metrics = parts.tables.get('hmtx');
      if (metrics === undefined) throw new Error('sem métricas');
      metrics.writeUInt16BE(0, cid(' ') * 4);
    });
    expect(run(tampered).identity.status).toBe('failed');
  });
  it('sem referência mantém not-supplied e com referência ausente/inválida nunca verifica', () => {
    const pdf = fontPdf({ program, toUnicode: cmapText(cmap), content: showCids([cid('A')]) });
    expect(runFontChecks(pdf).identity.status).toBe('not-supplied');
    expect(run(program, cmap, [cid('A')], []).identity.status).toBe('failed');
    expect(run(program, cmap, [cid('A')], references.slice(1)).identity.status).toBe('failed');
  });
  it('CIDToGIDMap diferente de Identity não permite provar a correspondência', () => {
    const result = run(program, cmap, [cid('A')], references, { cidToGid: 'Outro' });
    expect(result.h6.status).toBe('fail');
    expect(result.identity.status).toBe('failed');
  });
  it('cmap de referência adulterado troca a interpretação, mas não o desenho do PDF', () => {
    const changed = mutateTtf(Buffer.from(references[0]?.bytes ?? []), (parts) => {
      const map = parts.tables.get('cmap');
      if (map === undefined) throw new Error('sem cmap');
      // Muda o idDelta do segmento que cobre A, sem alterar contornos ou métricas.
      const offset = map.readUInt32BE(8);
      const n = map.readUInt16BE(offset + 6) / 2;
      for (let i = 0; i < n; i++) {
        const start = map.readUInt16BE(offset + 16 + n * 2 + i * 2);
        const end = map.readUInt16BE(offset + 14 + i * 2);
        if (start <= 65 && end >= 65) {
          const at = offset + 16 + n * 4 + i * 2;
          map.writeInt16BE(map.readInt16BE(at) + 1, at);
          return;
        }
      }
      throw new Error('sem segmento A');
    });
    const refs: ReferenceFontInput[] = [
      { name: 'Lato-Regular', bytes: changed },
      ...references.slice(1),
    ];
    expect(run(program, cmap, [cid('A')], refs).identity.status).toBe('failed');
  });
  it('composto adulterado na referência não comprova o composto original do PDF', () => {
    const ref = prepareReferences(references)?.byName.get('Lato-Regular');
    if (ref === undefined) throw new Error('sem referência');
    const gid = ref.cmap.get('á'.codePointAt(0) ?? 0);
    const range = gid === undefined ? undefined : ref.font.glyphRanges[gid];
    if (gid === undefined || range === undefined || !isCompositeGlyph(glyphBytes(ref.font, gid)))
      throw new Error('sem composto');
    const changed = mutateTtf(Buffer.from(references[0]?.bytes ?? []), (parts) => {
      const glyf = parts.tables.get('glyf');
      if (glyf === undefined) throw new Error('sem glyf');
      const at = range[0] + 14;
      glyf[at] = (glyf[at] ?? 0) ^ 1;
    });
    const result = run(
      program,
      cmap,
      [cid('á')],
      [{ name: 'Lato-Regular', bytes: changed }, ...references.slice(1)],
    );
    expect(result.identity.status).toBe('failed');
    expect(result.h6.details.join('\n')).toMatch(/glifo composto .*difere/);
  });
  it('.notdef substituído por vazio com métricas plausíveis continua reprovado', () => {
    const range = font.glyphRanges[0];
    if (range === undefined) throw new Error('sem .notdef');
    const changed = mutateTtf(program, (parts) => {
      const glyf = parts.tables.get('glyf');
      const loca = parts.tables.get('loca');
      const hmtx = parts.tables.get('hmtx');
      if (glyf === undefined || loca === undefined || hmtx === undefined)
        throw new Error('sem tabelas');
      parts.tables.set('glyf', glyf.subarray(range[1]));
      for (let g = 1; g <= font.numGlyphs; g++)
        loca.writeUInt32BE(loca.readUInt32BE(g * 4) - range[1], g * 4);
      hmtx.copy(hmtx, 0, cid(' ') * 4, cid(' ') * 4 + 4);
    });
    const result = run(changed);
    expect(result.identity.status).toBe('failed');
    expect(result.h6.details.join('\n')).toMatch(/\.notdef/);
  });
  it.each(['cmap', 'glyf'])('referência %s truncada é recusada', (tag) => {
    const changed = mutateTtf(Buffer.from(references[0]?.bytes ?? []), (parts) =>
      parts.tables.set(tag, Buffer.alloc(1)),
    );
    expect(
      run(
        program,
        cmap,
        [cid('A')],
        [{ name: 'Lato-Regular', bytes: changed }, ...references.slice(1)],
      ).identity.status,
    ).toBe('failed');
  });
});
