import { beforeAll, describe, expect, it } from 'vitest';
import { loadFonts } from '../../src/cv/index.js';
import { referenceCmap } from '../../src/cv/validate/reference-cmap.js';
import { readTrueType, type TrueTypeFont } from '../../src/cv/validate/truetype.js';

let font: TrueTypeFont;
beforeAll(() => {
  const reading = readTrueType(loadFonts().regular, {}, { reference: true });
  if (reading.font === undefined) throw new Error('sem referência');
  font = reading.font;
});

function format4(indirect = false): Buffer {
  const b = Buffer.alloc(indirect ? 36 : 32);
  b.writeUInt16BE(4, 0);
  b.writeUInt16BE(b.length, 2);
  b.writeUInt16BE(4, 6);
  b.writeUInt16BE(0x42, 14);
  b.writeUInt16BE(0xffff, 16);
  b.writeUInt16BE(0x41, 20);
  b.writeUInt16BE(0xffff, 22);
  b.writeInt16BE(indirect ? 3 : 10 - 0x41, 24);
  b.writeInt16BE(1, 26);
  if (indirect) {
    b.writeUInt16BE(4, 28);
    b.writeUInt16BE(10, 32);
  }
  return b;
}
function format12(): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt16BE(12, 0);
  b.writeUInt32BE(28, 4);
  b.writeUInt32BE(1, 12);
  b.writeUInt32BE(0x1f600, 16);
  b.writeUInt32BE(0x1f601, 20);
  b.writeUInt32BE(10, 24);
  return b;
}
function table(subtables: Buffer[]): Buffer {
  const header = Buffer.alloc(4 + 8 * subtables.length);
  header.writeUInt16BE(subtables.length, 2);
  let offset = header.length;
  subtables.forEach((sub, i) => {
    header.writeUInt16BE(i === 0 ? 0 : 3, 4 + i * 8);
    header.writeUInt16BE(i === 0 ? 3 : 1, 6 + i * 8);
    header.writeUInt32BE(offset, 8 + i * 8);
    offset += sub.length;
  });
  return Buffer.concat([header, ...subtables]);
}
const read = (data: Buffer) =>
  referenceCmap({ ...font, data, tables: new Map([['cmap', { offset: 0, length: data.length }]]) });

describe('cmap Unicode de referência (defensivo)', () => {
  it('lê a Lato real e os registros Unicode que compartilham a mesma subtabela', () => {
    const map = referenceCmap(font);
    expect(map.get(0x41)).toBeDefined();
    expect(map.get(0xe3)).toBeDefined();
    expect(map.get(32)).toBe(map.get(160));
    expect(map.size).toBeGreaterThan(2000);
  });
  it('formato 4: idDelta e sentinela .notdef', () => {
    expect([...read(table([format4()]))]).toEqual([
      [65, 10],
      [66, 11],
    ]);
  });
  it('formato 4: idRangeOffset relativo, delta posterior e glyph zero sem delta', () => {
    expect([...read(table([format4(true)]))]).toEqual([[65, 13]]);
  });
  it('formato 12: inclui Unicode suplementar', () => {
    expect([...read(table([format12()]))]).toEqual([
      [0x1f600, 10],
      [0x1f601, 11],
    ]);
  });
  it('subtabelas redundantes precisam concordar', () => {
    expect(read(table([format4(), format4()])).get(65)).toBe(10);
    const other = format4();
    other.writeInt16BE(11 - 65, 24);
    expect(() => read(table([format4(), other]))).toThrow(/conflitantes/);
  });
  it('ausência explícita de cobertura não pode conflitar com um glifo em outra subtabela', () => {
    const direct = format4();
    direct.writeInt16BE(13 - 65, 24);
    expect(() => read(table([direct, format4(true)]))).toThrow(/conflitantes/);
  });
  it.each([0, 1, 3, 8, 12])('cmap truncado: %i bytes', (length) => {
    expect(() => read(table([format4()]).subarray(0, length))).toThrow(/cmap/);
  });
  it('ausente, sem Unicode e formato Unicode não suportado falham', () => {
    expect(() => referenceCmap({ ...font, tables: new Map() })).toThrow(/ausente/);
    const mac = table([format4()]);
    mac.writeUInt16BE(1, 4);
    expect(() => read(mac)).toThrow(/nenhum mapeamento/);
    const unsupported = format4();
    unsupported.writeUInt16BE(6, 0);
    expect(() => read(table([unsupported]))).toThrow(/não suportado/);
  });
  it.each([
    [0, 1, /versão/],
    [2, 33, /diretório/],
  ] as const)('cabeçalho/registro inválido em %i', (offset, value, pattern) => {
    const data = table([format4()]);
    data.writeUInt16BE(value, offset);
    expect(() => read(data)).toThrow(pattern);
  });
  it.each([0, 4, 0xffffffff])('offset de subtabela inválido: %i', (offset) => {
    const data = table([format4()]);
    data.writeUInt32BE(offset, 8);
    expect(() => read(data)).toThrow(/offset/);
  });
  it.each([
    [2, 15],
    [2, 65535],
    [6, 3],
    [6, 0],
    [18, 1],
    [20, 0x43],
    [22, 0x42],
    [28, 1],
    [28, 2],
    [28, 1000],
  ])('formato 4: campo inválido em %i → %i', (offset, value) => {
    const sub = format4();
    sub.writeUInt16BE(value, offset);
    expect(() => read(table([sub]))).toThrow(/cmap/);
  });
  it('glifo fora de maxp e escalar substituto são recusados', () => {
    const glyph = format4();
    glyph.writeInt16BE(6000, 24);
    expect(() => read(table([glyph]))).toThrow(/fora dos limites/);
    const unicode = format12();
    unicode.writeUInt32BE(0xd800, 16);
    unicode.writeUInt32BE(0xd801, 20);
    expect(() => read(table([unicode]))).toThrow(/fora dos limites/);
  });
  it.each([
    [2, 1],
    [4, 27],
    [4, 29],
    [12, 8193],
    [16, 0x1f602],
    [20, 0x110000],
    [24, 6000],
  ])('formato 12: campo inválido em %i → %i', (offset, value) => {
    const sub = format12();
    if (offset === 2) sub.writeUInt16BE(value, offset);
    else sub.writeUInt32BE(value, offset);
    expect(() => read(table([sub]))).toThrow(/cmap/);
  });
  it('limita intervalos e registros duplicados', () => {
    const huge = format12();
    huge.writeUInt32BE(0, 16);
    huge.writeUInt32BE(65536, 20);
    expect(() => read(table([huge]))).toThrow(/intervalo/);
    const dup = table([format4(), format4()]);
    dup.writeUInt16BE(0, 12);
    dup.writeUInt16BE(3, 14);
    expect(() => read(dup)).toThrow(/repetido/);
  });
});
