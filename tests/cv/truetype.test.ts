import { beforeAll, describe, expect, it } from 'vitest';
import { renderResume } from '../../src/cv/index.js';
import {
  ALLOWED_TABLES,
  DEFAULT_TRUETYPE_LIMITS,
  REQUIRED_TABLES,
  readTrueType,
} from '../../src/cv/validate/index.js';
import { isEmptyGlyph } from '../../src/cv/validate/truetype.js';
import { mutateTtf, parseTtf, realFont } from '../helpers/cv-fonts.js';
import { fictionalResume } from '../helpers/cv-resume.js';

let program: Buffer;
let bold: Buffer;
beforeAll(async () => {
  const bytes = (await renderResume(fictionalResume())).bytes;
  program = realFont(bytes, 'Regular').program ?? Buffer.alloc(0);
  bold = realFont(bytes, 'Bold').program ?? Buffer.alloc(0);
});

const problems = (data: Buffer, limits = {}): string =>
  readTrueType(data, limits).problems.join('\n');

describe('leitor TrueType: subconjuntos reais do PDFKit', () => {
  it('lê o diretório, os números e as faixas de glifos (Regular e Bold), sem problemas', () => {
    for (const data of [program, bold]) {
      const reading = readTrueType(data);
      expect(reading.problems).toEqual([]);
      const font = reading.font;
      expect(font?.sfnt).toBe(0x74727565);
      expect([...(font?.tables.keys() ?? [])].sort()).toEqual([...ALLOWED_TABLES].sort());
      expect(font?.unitsPerEm).toBe(2000);
      expect(font?.indexToLocFormat).toBe(1);
      expect(font?.numGlyphs).toBeGreaterThan(40);
      expect(font?.numberOfHMetrics).toBe(font?.numGlyphs);
      expect(font?.glyphRanges).toHaveLength(font?.numGlyphs ?? -1);
    }
  });

  it('existe um glifo vazio (o do espaço) e os demais têm contorno', () => {
    const font = readTrueType(program).font;
    if (font === undefined) throw new Error('sem fonte');
    const empty = font.glyphRanges.map((_, g) => g).filter((g) => isEmptyGlyph(font, g));
    expect(empty.length).toBeGreaterThanOrEqual(1);
    expect(empty.length).toBeLessThan(5);
    expect(isEmptyGlyph(font, 999_999)).toBe(true);
  });

  it('é determinístico e não altera os bytes recebidos', () => {
    const copy = Buffer.from(program);
    expect(readTrueType(program).font?.numGlyphs).toBe(readTrueType(program).font?.numGlyphs);
    expect(program.equals(copy)).toBe(true);
  });

  it('as seis tabelas obrigatórias fazem parte da lista permitida', () => {
    for (const tag of REQUIRED_TABLES) expect(ALLOWED_TABLES).toContain(tag);
    expect(DEFAULT_TRUETYPE_LIMITS.maxBytes).toBeLessThan(657_212); // a fonte completa não é um subconjunto
  });
});

describe('leitor TrueType: diretório e tabelas (falha fechada)', () => {
  it('tamanho: pequeno demais e grande demais (a fonte completa não passa)', () => {
    expect(problems(program.subarray(0, 600))).toMatch(/pequeno demais/);
    expect(problems(Buffer.concat([program, Buffer.alloc(300 * 1024)]))).toMatch(
      /grande demais.*não é um subconjunto/,
    );
    expect(problems(program, { maxBytes: 5000 })).toMatch(/grande demais/);
  });

  it('cabeçalho sfnt e número de tabelas', () => {
    const bad = Buffer.from(program);
    bad.writeUInt32BE(0x4f54544f, 0); // "OTTO" (CFF)
    expect(problems(bad)).toMatch(/cabeçalho sfnt inválido/);
    for (const count of [0, 33]) {
      const many = Buffer.from(program);
      many.writeUInt16BE(count, 4);
      expect(problems(many)).toMatch(/tabelas \(permitido 1 a 32\)/);
    }
    const huge = Buffer.from(program);
    huge.writeUInt16BE(32, 4);
    const short = huge.subarray(0, 1100);
    expect(problems(short)).toMatch(
      /diretório de tabelas além do fim|pequeno demais|fora dos limites/,
    );
  });

  it.each(['GSUB', 'GPOS', 'cmap', 'name', 'post', 'OS/2', 'CFF ', 'SVG ', 'COLR', 'DSIG'])(
    'tabela extra "%s" não é permitida',
    (tag) => {
      const mutated = mutateTtf(program, (p) => p.tables.set(tag, Buffer.alloc(16)));
      expect(problems(mutated)).toMatch(
        new RegExp(`tabela não permitida: "${tag.replace('/', '\\/')}"`),
      );
    },
  );

  it('tabela obrigatória ausente', () => {
    for (const tag of REQUIRED_TABLES) {
      const mutated = mutateTtf(program, (p) => p.tables.delete(tag));
      expect(problems(mutated), tag).toMatch(new RegExp(`tabela obrigatória ausente: "${tag}"`));
    }
  });

  it('tabela fora dos limites do arquivo e tabelas sobrepostas', () => {
    const outside = Buffer.from(program);
    outside.writeUInt32BE(program.length - 4, 12 + 16 * 2 + 8); // offset da 3ª tabela quase no fim
    expect(problems(outside)).toMatch(/fora dos limites do arquivo/);
    const overlap = Buffer.from(program);
    overlap.writeUInt32BE(overlap.readUInt32BE(12 + 8), 12 + 16 + 8); // 2ª tabela começa onde a 1ª começa
    expect(problems(overlap)).toMatch(/se sobrepõem/);
    const insideDirectory = Buffer.from(program);
    insideDirectory.writeUInt32BE(8, 12 + 8);
    expect(problems(insideDirectory)).toMatch(/fora dos limites do arquivo/);
  });

  it('tabela repetida no diretório', () => {
    const dup = Buffer.from(program);
    program.copy(dup, 12 + 16, 12, 12 + 16); // a 2ª entrada vira cópia da 1ª
    expect(problems(dup)).toMatch(/repetida/);
  });
});

describe('leitor TrueType: números e consistência interna', () => {
  const patch = (tag: string, at: number, write: (b: Buffer, offset: number) => void): Buffer =>
    mutateTtf(program, (p) => {
      const table = Buffer.from(p.tables.get(tag) ?? Buffer.alloc(0));
      write(table, at);
      p.tables.set(tag, table);
    });

  it('head: número mágico, unitsPerEm e indexToLocFormat', () => {
    expect(problems(patch('head', 12, (b, o) => b.writeUInt32BE(0xdeadbeef, o)))).toMatch(
      /número mágico/,
    );
    expect(problems(patch('head', 18, (b, o) => b.writeUInt16BE(10, o)))).toMatch(
      /unitsPerEm 10 fora de 1000 a 4096/,
    );
    expect(problems(patch('head', 18, (b, o) => b.writeUInt16BE(9000, o)))).toMatch(
      /unitsPerEm 9000/,
    );
    expect(problems(patch('head', 50, (b, o) => b.writeInt16BE(5, o)))).toMatch(
      /indexToLocFormat inválido \(5\)/,
    );
  });

  it('maxp: numGlyphs zero ou absurdo', () => {
    expect(problems(patch('maxp', 4, (b, o) => b.writeUInt16BE(0, o)))).toMatch(
      /numGlyphs 0 fora de 1 a 1500/,
    );
    expect(problems(patch('maxp', 4, (b, o) => b.writeUInt16BE(60_000, o)))).toMatch(
      /numGlyphs 60000 fora de 1 a 1500/,
    );
  });

  it('hhea e hmtx: contagens incoerentes', () => {
    expect(problems(patch('hhea', 34, (b, o) => b.writeUInt16BE(9999, o)))).toMatch(
      /numberOfHMetrics 9999 incoerente/,
    );
    expect(problems(patch('hhea', 34, (b, o) => b.writeUInt16BE(0, o)))).toMatch(
      /numberOfHMetrics 0 incoerente/,
    );
    const shortHmtx = mutateTtf(program, (p) =>
      p.tables.set('hmtx', (p.tables.get('hmtx') ?? Buffer.alloc(0)).subarray(4)),
    );
    expect(problems(shortHmtx)).toMatch(/tamanho de "hmtx".*incoerente/);
  });

  it('loca: tamanho, ordem e limite em relação a glyf', () => {
    const shortLoca = mutateTtf(program, (p) =>
      p.tables.set('loca', (p.tables.get('loca') ?? Buffer.alloc(0)).subarray(4)),
    );
    expect(problems(shortLoca)).toMatch(/tamanho de "loca".*incoerente/);
    const backwards = patch('loca', 8, (b, o) => b.writeUInt32BE(0xfffff, o)); // glifo 2 começa depois do glifo 3
    expect(problems(backwards)).toMatch(/"loca" não é monotônica|além do fim de "glyf"/);
    const beyond = mutateTtf(program, (p) => {
      const loca = Buffer.from(p.tables.get('loca') ?? Buffer.alloc(0));
      loca.writeUInt32BE(loca.readUInt32BE(loca.length - 4) + 100_000, loca.length - 4);
      p.tables.set('loca', loca);
    });
    expect(problems(beyond)).toMatch(/aponta além do fim de "glyf"/);
  });

  it('o número de glifos pode ser limitado pelo chamador', () => {
    expect(problems(program, { maxGlyphs: 10 })).toMatch(/numGlyphs \d+ fora de 1 a 10/);
  });
});

describe('leitor TrueType: glifos', () => {
  /** Troca o glifo `g` (formato de loca longo) por `bytes`, ajustando loca e glyf. */
  const withGlyph = (g: number, bytes: Buffer): Buffer =>
    mutateTtf(program, (p) => {
      const loca = Buffer.from(p.tables.get('loca') ?? Buffer.alloc(0));
      const glyf = p.tables.get('glyf') ?? Buffer.alloc(0);
      const start = loca.readUInt32BE(g * 4);
      const end = loca.readUInt32BE(g * 4 + 4);
      const delta = bytes.length - (end - start);
      p.tables.set('glyf', Buffer.concat([glyf.subarray(0, start), bytes, glyf.subarray(end)]));
      for (let i = g + 1; i < loca.length / 4; i++)
        loca.writeUInt32BE(loca.readUInt32BE(i * 4) + delta, i * 4);
      p.tables.set('loca', loca);
    });
  const simple = (contours: number, tail: number[]): Buffer => {
    const head = Buffer.alloc(10);
    head.writeInt16BE(contours, 0);
    return Buffer.concat([head, Buffer.from(tail)]);
  };
  const composite = (components: [number, number][]): Buffer => {
    const parts: Buffer[] = [Buffer.alloc(10)];
    parts[0]?.writeInt16BE(-1, 0);
    components.forEach(([glyph, flags], i) => {
      const last = i === components.length - 1;
      const piece = Buffer.alloc(6);
      piece.writeUInt16BE(last ? flags & ~0x20 : flags | 0x20, 0);
      piece.writeUInt16BE(glyph, 2);
      parts.push(piece);
    });
    return Buffer.concat(parts);
  };

  it('glifo curto demais', () => {
    expect(problems(withGlyph(1, Buffer.from([0, 1, 2, 3])))).toMatch(
      /glifo 1 curto demais \(4 bytes\)/,
    );
  });

  it('glifo simples: contornos, ordem dos pontos finais, pontos e instruções fora dos limites', () => {
    expect(problems(withGlyph(1, simple(50, [0, 0])))).toMatch(
      /glifo 1: contornos além do fim dos dados/,
    );
    const unordered = Buffer.concat([simple(2, []), Buffer.from([0, 9, 0, 3, 0, 0])]); // finais 9 e 3
    expect(problems(withGlyph(1, unordered))).toMatch(
      /glifo 1: pontos finais dos contornos fora de ordem/,
    );
    const manyPoints = Buffer.concat([simple(1, []), Buffer.from([0xff, 0xff, 0, 0])]);
    expect(problems(withGlyph(1, manyPoints))).toMatch(/glifo 1: 65536 pontos/);
    const instructions = Buffer.concat([simple(1, []), Buffer.from([0, 3, 0x7f, 0xff])]);
    expect(problems(withGlyph(1, instructions))).toMatch(
      /glifo 1: instruções além do fim dos dados/,
    );
  });

  it('glifo composto: componente inexistente, além do fim e componentes demais', () => {
    expect(problems(withGlyph(1, composite([[60_000, 0]])))).toMatch(
      /glifo composto 1: componente 60000 inexistente/,
    );
    const truncated = composite([[2, 0]]).subarray(0, 12);
    expect(problems(withGlyph(1, truncated))).toMatch(
      /glifo composto 1: componente além do fim dos dados/,
    );
    const many = composite(Array.from({ length: 70 }, () => [2, 0] as [number, number]));
    expect(problems(withGlyph(1, many))).toMatch(/glifo composto 1: mais de 64 componentes/);
  });

  it('glifo composto: ciclo (aponta para si mesmo) e profundidade', () => {
    expect(problems(withGlyph(1, composite([[1, 0]])))).toMatch(
      /glifo composto 1 faz parte de um ciclo/,
    );
    const a = withGlyph(1, composite([[2, 0]]));
    const mutual = mutateTtf(a, (p) => {
      // glifo 2 passa a apontar para o 1: 1 → 2 → 1
      const loca = Buffer.from(p.tables.get('loca') ?? Buffer.alloc(0));
      const glyf = p.tables.get('glyf') ?? Buffer.alloc(0);
      const start = loca.readUInt32BE(2 * 4);
      const end = loca.readUInt32BE(3 * 4);
      const body = composite([[1, 0]]);
      p.tables.set('glyf', Buffer.concat([glyf.subarray(0, start), body, glyf.subarray(end)]));
      const delta = body.length - (end - start);
      for (let i = 3; i < loca.length / 4; i++)
        loca.writeUInt32BE(loca.readUInt32BE(i * 4) + delta, i * 4);
      p.tables.set('loca', loca);
    });
    expect(problems(mutual)).toMatch(/faz parte de um ciclo/);
    expect(problems(program, { maxCompositeDepth: 0 })).toMatch(/com profundidade 1 \(máximo 0\)/);
  });

  it('os glifos compostos reais do PDFKit (acentos) estão dentro dos limites', () => {
    expect(problems(program)).toBe('');
    expect(problems(bold)).toBe('');
    expect(parseTtf(program).tables.size).toBe(9);
  });
});
