import { beforeAll, describe, expect, it } from 'vitest';
import { loadFonts } from '../../src/cv/index.js';
import { glyphSignatures } from '../../src/cv/validate/glyph-signatures.js';
import { readTrueType, type TrueTypeFont } from '../../src/cv/validate/truetype.js';

let reference: TrueTypeFont;
beforeAll(() => {
  const font = readTrueType(loadFonts().regular, {}, { reference: true }).font;
  if (font === undefined) throw new Error('sem fonte');
  reference = font;
});
const simple = () => Buffer.alloc(12); // zero contornos e zero instruções
function composite(ids: number[], flags = 2, instructions?: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeInt16BE(-1, 0);
  const parts: Buffer[] = ids.map((gid, i) => {
    const last = i === ids.length - 1;
    const size =
      4 +
      ((flags & 1) !== 0 ? 4 : 2) +
      ((flags & 8) !== 0 ? 2 : (flags & 0x40) !== 0 ? 4 : (flags & 0x80) !== 0 ? 8 : 0);
    const part = Buffer.alloc(size);
    part.writeUInt16BE(
      flags | (last ? 0 : 0x20) | (last && instructions !== undefined ? 0x100 : 0),
      0,
    );
    part.writeUInt16BE(gid, 2);
    return part;
  });
  if (instructions !== undefined) {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(instructions.length, 0);
    parts.push(size, instructions);
  }
  return Buffer.concat([head, ...parts]);
}
function fontOf(glyphs: Buffer[]): TrueTypeFont {
  let offset = 0;
  const glyphRanges: [number, number][] = glyphs.map((g) => {
    const start = offset;
    offset += g.length;
    return [start, offset];
  });
  const hmtx = Buffer.alloc(glyphs.length * 4);
  for (let g = 0; g < glyphs.length; g++) hmtx.writeUInt16BE(500, g * 4);
  const glyf = Buffer.concat(glyphs);
  return {
    ...reference,
    numGlyphs: glyphs.length,
    numberOfHMetrics: glyphs.length,
    glyphRanges,
    data: Buffer.concat([glyf, hmtx]),
    tables: new Map([
      ['glyf', { offset: 0, length: glyf.length }],
      ['hmtx', { offset: glyf.length, length: hmtx.length }],
    ]),
  };
}

describe('assinaturas recursivas dos glifos', () => {
  it('tolera somente a reindexação dos componentes, inclusive compostos aninhados', () => {
    const a = glyphSignatures(fontOf([simple(), composite([0]), composite([1, 0])]));
    const b = glyphSignatures(fontOf([composite([2, 1]), simple(), composite([1])]));
    expect(a[0]).toBe(b[1]);
    expect(a[1]).toBe(b[2]);
    expect(a[2]).toBe(b[0]);
  });
  it.each([2, 3, 0xa, 0x42, 0x82])(
    'argumentos e transformações das flags %i fazem parte da prova',
    (flags) => {
      const original = composite([0], flags);
      const changed = Buffer.from(original);
      changed[changed.length - 1] = 1;
      expect(glyphSignatures(fontOf([simple(), original]))[1]).not.toBe(
        glyphSignatures(fontOf([simple(), changed]))[1],
      );
    },
  );
  it('flags, contorno filho, métricas do pai e do filho e instruções fazem parte da prova', () => {
    const original = fontOf([simple(), composite([0], 2, Buffer.from([1, 2]))]);
    const key = glyphSignatures(original)[1];
    for (const at of [0, 22, 30, 35, 37]) {
      const data = Buffer.from(original.data);
      data[at] = (data[at] ?? 0) ^ 1;
      expect(glyphSignatures({ ...original, data })[1]).not.toBe(key);
    }
  });
  it('a ordem dos componentes e seus desenhos não são intercambiáveis', () => {
    const other = simple();
    other[2] = 1;
    const keys = glyphSignatures(fontOf([simple(), other, composite([0, 1]), composite([1, 0])]));
    expect(keys[2]).not.toBe(keys[3]);
  });
  it('glifos vazios são comprovados com suas métricas', () => {
    const a = fontOf([Buffer.alloc(0)]);
    const b = { ...a, data: Buffer.from(a.data) };
    b.data.writeUInt16BE(501, 0);
    expect(glyphSignatures(a)[0]).not.toBe(glyphSignatures(b)[0]);
  });
  it.each([1, 9, 11, 13, 15])('composto truncado em %i bytes é recusado', (length) => {
    expect(() =>
      glyphSignatures(fontOf([simple(), composite([0], 3).subarray(0, length)])),
    ).toThrow(/truncado/);
  });
  it('instruções truncadas e índices inexistentes são recusados', () => {
    const b = composite([0], 2, Buffer.from([1, 2]));
    expect(() => glyphSignatures(fontOf([simple(), b.subarray(0, -1)]))).toThrow(
      /instruções truncadas/,
    );
    expect(() => glyphSignatures(fontOf([simple(), b.subarray(0, 17)]))).toThrow(
      /comprimento.*truncado/,
    );
    expect(() => glyphSignatures(fontOf([simple(), composite([4])]))).toThrow(/fora dos limites/);
  });
  it.each([0x12, 0x4a, 0x1802])('flags reservadas/conflitantes %i são recusadas', (flags) => {
    expect(() => glyphSignatures(fontOf([simple(), composite([0], flags)]))).toThrow(/flags/);
  });
  it('ciclos e profundidade excessiva são recusados durante a travessia', () => {
    expect(() => glyphSignatures(fontOf([composite([0])]))).toThrow(/ciclo/);
    const chain = [simple(), ...Array.from({ length: 9 }, (_, i) => composite([i]))];
    expect(() => glyphSignatures(fontOf(chain))).toThrow(/profundidade/);
  });
  it('limita componentes, processamento, glifos e bytes', () => {
    expect(() => glyphSignatures(fontOf([simple(), composite(Array<number>(65).fill(0))]))).toThrow(
      /componentes/,
    );
    const fanout = composite(Array<number>(64).fill(0));
    expect(() =>
      glyphSignatures(fontOf([simple(), ...Array.from({ length: 1600 }, () => fanout)])),
    ).toThrow(/processamento/);
    expect(() => glyphSignatures({ ...reference, numGlyphs: 6001 })).toThrow(/limite/);
    expect(() =>
      glyphSignatures({ ...reference, data: Buffer.alloc(2 * 1024 * 1024 + 1) }),
    ).toThrow(/limite/);
  });
  it('estrutura parcial com hmtx truncada não chega às leituras', () => {
    const font = fontOf([simple()]);
    expect(() => glyphSignatures({ ...font, data: font.data.subarray(0, -1) })).toThrow(/métricas/);
  });
});
