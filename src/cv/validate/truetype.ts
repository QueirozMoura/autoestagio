/**
 * Leitor TrueType MÍNIMO e defensivo, só para os programas de fonte que o PDFKit embute (subconjuntos da Lato).
 *
 * Nada aqui renderiza ou executa a fonte: lê o diretório de tabelas e confere limites, offsets, tamanhos e a
 * consistência interna entre as tabelas (`head`, `maxp`, `hhea`, `hmtx`, `loca`, `glyf`). Estrutura inesperada
 * vira problema (falha fechada), nunca é ignorada. Os checksums das tabelas NÃO são conferidos: o subconjunto do
 * PDFKit não os preenche (medido), então o diretório traz valores que não batem.
 *
 * A comparação com a fonte original (identidade dos glifos, bytecode) pertence à próxima entrega.
 */
export interface TrueTypeLimits {
  minBytes: number;
  /** Um subconjunto de currículo tem dezenas de KB; a fonte completa passa de 600 KB. */
  maxBytes: number;
  maxTables: number;
  maxGlyphs: number;
  /** Profundidade máxima de glifos compostos que apontam para outros compostos. */
  maxCompositeDepth: number;
  maxComponents: number;
  maxPoints: number;
}

export const DEFAULT_TRUETYPE_LIMITS: TrueTypeLimits = {
  minBytes: 1024,
  maxBytes: 200 * 1024,
  maxTables: 32,
  maxGlyphs: 1500,
  maxCompositeDepth: 8,
  maxComponents: 64,
  maxPoints: 10_000,
};

/** Cabeçalhos `sfnt` aceitos: TrueType ("\0\1\0\0") e o "true" da Apple, que o PDFKit usa. */
export const SFNT_VERSIONS = [0x00010000, 0x74727565] as const;

/** Tabelas que um subconjunto do PDFKit tem (medido). Qualquer outra reprova. */
export const ALLOWED_TABLES = [
  'head',
  'hhea',
  'loca',
  'maxp',
  'cvt ',
  'prep',
  'glyf',
  'hmtx',
  'fpgm',
] as const;
/** Sem estas seis não há como desenhar nem validar glifos. */
export const REQUIRED_TABLES = ['head', 'hhea', 'loca', 'maxp', 'glyf', 'hmtx'] as const;

export const HEAD_MAGIC = 0x5f0f3cf5;
const MAX_PROBLEMS = 20;

export interface TrueTypeTable {
  offset: number;
  length: number;
}

export interface TrueTypeFont {
  sfnt: number;
  tables: Map<string, TrueTypeTable>;
  unitsPerEm: number;
  indexToLocFormat: number;
  numGlyphs: number;
  numberOfHMetrics: number;
  /** Faixa de cada glifo dentro de `glyf` (início, fim). */
  glyphRanges: [number, number][];
  data: Buffer;
}

export interface TrueTypeReading {
  /** Presente quando o diretório e as tabelas principais puderam ser lidos. */
  font?: TrueTypeFont;
  problems: string[];
}

/** Um glifo vazio (comprimento zero em `loca`), como o do espaço. */
export const isEmptyGlyph = (font: TrueTypeFont, glyph: number): boolean => {
  const range = font.glyphRanges[glyph];
  return range === undefined || range[1] === range[0];
};

const u16 = (data: Buffer, at: number): number => data.readUInt16BE(at);
const i16 = (data: Buffer, at: number): number => data.readInt16BE(at);
const u32 = (data: Buffer, at: number): number => data.readUInt32BE(at);

export function readTrueType(
  data: Buffer,
  limitOverrides: Partial<TrueTypeLimits> = {},
): TrueTypeReading {
  const limits = { ...DEFAULT_TRUETYPE_LIMITS, ...limitOverrides };
  const problems: string[] = [];
  const report = (message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };

  if (data.length < limits.minBytes) {
    report(`programa de fonte pequeno demais (${data.length} bytes; mínimo ${limits.minBytes})`);
    return { problems };
  }
  if (data.length > limits.maxBytes) {
    report(
      `programa de fonte grande demais (${data.length} bytes; máximo ${limits.maxBytes}): não é um subconjunto`,
    );
    return { problems };
  }
  const sfnt = u32(data, 0);
  if (!(SFNT_VERSIONS as readonly number[]).includes(sfnt)) {
    report(`cabeçalho sfnt inválido (0x${sfnt.toString(16)})`);
    return { problems };
  }
  const numTables = u16(data, 4);
  if (numTables < 1 || numTables > limits.maxTables) {
    report(`${numTables} tabelas (permitido 1 a ${limits.maxTables})`);
    return { problems };
  }
  const directoryEnd = 12 + numTables * 16;
  if (directoryEnd > data.length) {
    report('diretório de tabelas além do fim do arquivo');
    return { problems };
  }

  // --- diretório: limites, duplicatas, sobreposição, lista de permissão
  const tables = new Map<string, TrueTypeTable>();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const tag = data.toString('latin1', at, at + 4);
    const offset = u32(data, at + 8);
    const length = u32(data, at + 12);
    if (tables.has(tag)) report(`tabela "${tag}" repetida`);
    if (!(ALLOWED_TABLES as readonly string[]).includes(tag))
      report(`tabela não permitida: "${tag}"`);
    if (offset < directoryEnd || offset + length > data.length)
      report(`tabela "${tag}" fora dos limites do arquivo (offset ${offset}, tamanho ${length})`);
    tables.set(tag, { offset, length });
  }
  const ordered = [...tables].sort((a, b) => a[1].offset - b[1].offset);
  for (let i = 1; i < ordered.length; i++) {
    const [prevTag, prev] = ordered[i - 1] ?? ['', { offset: 0, length: 0 }];
    const [tag, current] = ordered[i] ?? ['', { offset: 0, length: 0 }];
    if (prev.offset + prev.length > current.offset)
      report(`tabelas "${prevTag}" e "${tag}" se sobrepõem`);
  }
  for (const required of REQUIRED_TABLES)
    if (!tables.has(required)) report(`tabela obrigatória ausente: "${required}"`);
  const table = (tag: string): TrueTypeTable | undefined => {
    const t = tables.get(tag);
    return t !== undefined && t.offset >= directoryEnd && t.offset + t.length <= data.length
      ? t
      : undefined;
  };

  const head = table('head');
  const maxp = table('maxp');
  const hhea = table('hhea');
  const hmtx = table('hmtx');
  const loca = table('loca');
  const glyf = table('glyf');
  if (
    head === undefined ||
    maxp === undefined ||
    hhea === undefined ||
    hmtx === undefined ||
    loca === undefined ||
    glyf === undefined
  )
    return { problems };

  // --- head
  let unitsPerEm = 0;
  let indexToLocFormat = 0;
  if (head.length < 54) report('tabela "head" curta demais');
  else {
    if (u32(data, head.offset + 12) !== HEAD_MAGIC) report('"head" sem o número mágico 0x5F0F3CF5');
    unitsPerEm = u16(data, head.offset + 18);
    if (unitsPerEm < 1000 || unitsPerEm > 4096)
      report(`unitsPerEm ${unitsPerEm} fora de 1000 a 4096`);
    indexToLocFormat = i16(data, head.offset + 50);
    if (indexToLocFormat !== 0 && indexToLocFormat !== 1)
      report(`indexToLocFormat inválido (${indexToLocFormat})`);
  }

  // --- maxp / hhea / hmtx
  let numGlyphs = 0;
  if (maxp.length < 6) report('tabela "maxp" curta demais');
  else {
    numGlyphs = u16(data, maxp.offset + 4);
    if (numGlyphs < 1 || numGlyphs > limits.maxGlyphs)
      report(`numGlyphs ${numGlyphs} fora de 1 a ${limits.maxGlyphs}`);
  }
  let numberOfHMetrics = 0;
  if (hhea.length < 36) report('tabela "hhea" curta demais');
  else {
    numberOfHMetrics = u16(data, hhea.offset + 34);
    if (numberOfHMetrics < 1 || numberOfHMetrics > numGlyphs)
      report(`numberOfHMetrics ${numberOfHMetrics} incoerente com numGlyphs ${numGlyphs}`);
    else if (hmtx.length !== 4 * numberOfHMetrics + 2 * (numGlyphs - numberOfHMetrics))
      report(
        `tamanho de "hmtx" (${hmtx.length}) incoerente com ${numberOfHMetrics} métricas e ${numGlyphs} glifos`,
      );
  }
  // Sem contagem de glifos ou formato do loca válidos, o resto não pode ser lido com segurança.
  if (
    numGlyphs < 1 ||
    numGlyphs > limits.maxGlyphs ||
    (indexToLocFormat !== 0 && indexToLocFormat !== 1)
  )
    return { problems };

  // --- loca
  const entry = indexToLocFormat === 0 ? 2 : 4;
  if (loca.length !== (numGlyphs + 1) * entry) {
    report(
      `tamanho de "loca" (${loca.length}) incoerente com ${numGlyphs} glifos (esperava ${(numGlyphs + 1) * entry})`,
    );
    return { problems };
  }
  const offsets: number[] = [];
  for (let g = 0; g <= numGlyphs; g++)
    offsets.push(
      indexToLocFormat === 0 ? u16(data, loca.offset + g * 2) * 2 : u32(data, loca.offset + g * 4),
    );
  for (let g = 1; g < offsets.length; g++)
    if ((offsets[g] ?? 0) < (offsets[g - 1] ?? 0)) {
      report(`"loca" não é monotônica no glifo ${g}`);
      break;
    }
  if ((offsets[numGlyphs] ?? 0) > glyf.length)
    report(`"loca" aponta além do fim de "glyf" (${offsets[numGlyphs]} > ${glyf.length})`);
  if (
    offsets.some((o, g) => g > 0 && o < (offsets[g - 1] ?? 0)) ||
    (offsets[numGlyphs] ?? 0) > glyf.length
  )
    return { problems };
  const glyphRanges: [number, number][] = [];
  for (let g = 0; g < numGlyphs; g++) glyphRanges.push([offsets[g] ?? 0, offsets[g + 1] ?? 0]);

  // --- glifos
  const composites = new Map<number, number[]>();
  for (let g = 0; g < numGlyphs; g++) {
    const [start, end] = glyphRanges[g] ?? [0, 0];
    const length = end - start;
    if (length === 0) continue;
    const at = glyf.offset + start;
    if (length < 10) {
      report(`glifo ${g} curto demais (${length} bytes)`);
      continue;
    }
    const contours = i16(data, at);
    if (contours >= 0) {
      const endPts = 10 + 2 * contours;
      if (endPts + 2 > length) {
        report(`glifo ${g}: contornos além do fim dos dados`);
        continue;
      }
      let previous = -1;
      let ordered = true;
      for (let c = 0; c < contours; c++) {
        const point = u16(data, at + 10 + 2 * c);
        if (point <= previous) ordered = false;
        previous = point;
      }
      if (!ordered) report(`glifo ${g}: pontos finais dos contornos fora de ordem`);
      if (previous + 1 > limits.maxPoints)
        report(`glifo ${g}: ${previous + 1} pontos (máximo ${limits.maxPoints})`);
      const instructions = u16(data, at + endPts);
      if (endPts + 2 + instructions > length)
        report(`glifo ${g}: instruções além do fim dos dados`);
    } else {
      const components: number[] = [];
      let cursor = 10;
      let flags = 0x20;
      let ok = true;
      let instructionsFlag = false;
      while ((flags & 0x20) !== 0) {
        if (cursor + 4 > length) {
          report(`glifo composto ${g}: componente além do fim dos dados`);
          ok = false;
          break;
        }
        flags = u16(data, at + cursor);
        const component = u16(data, at + cursor + 2);
        cursor += 4 + ((flags & 0x1) !== 0 ? 4 : 2);
        if ((flags & 0x8) !== 0) cursor += 2;
        else if ((flags & 0x40) !== 0) cursor += 4;
        else if ((flags & 0x80) !== 0) cursor += 8;
        if ((flags & 0x100) !== 0) instructionsFlag = true;
        if (component >= numGlyphs) {
          report(
            `glifo composto ${g}: componente ${component} inexistente (numGlyphs ${numGlyphs})`,
          );
          ok = false;
        }
        components.push(component);
        if (components.length > limits.maxComponents) {
          report(`glifo composto ${g}: mais de ${limits.maxComponents} componentes`);
          ok = false;
          break;
        }
      }
      if (ok && cursor > length) report(`glifo composto ${g}: dados dos componentes passam do fim`);
      if (ok && instructionsFlag && cursor + 2 > length)
        report(`glifo composto ${g}: instruções além do fim dos dados`);
      composites.set(g, components);
    }
  }
  // Compostos que apontam para compostos: profundidade limitada e sem ciclos.
  const depthOf = (glyph: number, trail: Set<number>): number => {
    const children = composites.get(glyph);
    if (children === undefined) return 0;
    if (trail.has(glyph)) return Infinity;
    trail.add(glyph);
    const deepest = Math.max(0, ...children.map((c) => depthOf(c, trail)));
    trail.delete(glyph);
    return deepest + 1;
  };
  for (const glyph of composites.keys()) {
    const depth = depthOf(glyph, new Set());
    if (depth === Infinity) report(`glifo composto ${glyph} faz parte de um ciclo`);
    else if (depth > limits.maxCompositeDepth)
      report(
        `glifo composto ${glyph} com profundidade ${depth} (máximo ${limits.maxCompositeDepth})`,
      );
  }

  return {
    font: {
      sfnt,
      tables,
      unitsPerEm,
      indexToLocFormat,
      numGlyphs,
      numberOfHMetrics,
      glyphRanges,
      data,
    },
    problems,
  };
}
