import { FontProofError } from './glyph-signatures.js';
import { tableBytes, type TrueTypeFont } from './truetype.js';

const MAX_RECORDS = 32;
const MAX_SEGMENTS = 8192;
const MAX_ENTRIES = 65_536;
const MAX_WORK = 262_144;

/** Unicode cmap da referência; formatos 4 e 12. Mapas Unicode redundantes precisam concordar. */
export function referenceCmap(font: TrueTypeFont): Map<number, number> {
  const data = tableBytes(font, 'cmap');
  const fail = (message: string): never => {
    throw new FontProofError(`cmap de referência: ${message}`);
  };
  if (data === undefined || data.length < 4) return fail('ausente ou truncado');
  if (data.readUInt16BE(0) !== 0) return fail('versão inválida');
  const records = data.readUInt16BE(2);
  const headerEnd = 4 + records * 8;
  if (records < 1 || records > MAX_RECORDS || headerEnd > data.length)
    return fail('diretório inválido ou limite de registros excedido');
  const map = new Map<number, number>();
  const seen = new Set<number>();
  const ranges: [number, number][] = [];
  const encodings = new Set<string>();
  let work = 0;
  const put = (code: number, glyph: number): void => {
    if (++work > MAX_WORK) fail('limite de processamento excedido');
    if (
      (glyph !== 0 && (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) ||
      glyph >= font.numGlyphs
    )
      fail('Unicode ou índice de glifo fora dos limites');
    const previous = map.get(code);
    if (previous !== undefined && previous !== glyph) fail('subtabelas Unicode conflitantes');
    if (map.size >= MAX_ENTRIES && previous === undefined) fail('limite de entradas excedido');
    map.set(code, glyph);
  };
  for (let r = 0; r < records; r++) {
    const at = 4 + r * 8;
    const platform = data.readUInt16BE(at);
    const encoding = data.readUInt16BE(at + 2);
    const offset = data.readUInt32BE(at + 4);
    if (offset < headerEnd || offset + 2 > data.length) return fail('offset de subtabela inválido');
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    if (platform === 0 && encoding > 6) return fail('codificação Unicode desconhecida');
    const encodingKey = `${platform}:${encoding}`;
    if (encodings.has(encodingKey)) return fail('registro Unicode repetido');
    encodings.add(encodingKey);
    if (seen.has(offset)) continue;
    seen.add(offset);
    const format = data.readUInt16BE(offset);
    if (format !== 4 && format !== 12) return fail(`formato Unicode não suportado: ${format}`);
    if (offset + (format === 4 ? 14 : 16) > data.length) return fail('cabeçalho truncado');
    const length = format === 4 ? data.readUInt16BE(offset + 2) : data.readUInt32BE(offset + 4);
    if (length < 16 || offset + length > data.length)
      return fail('comprimento de subtabela inválido');
    if (ranges.some(([start, end]) => offset < end && offset + length > start))
      return fail('subtabelas Unicode sobrepostas');
    ranges.push([offset, offset + length]);
    const sub = data.subarray(offset, offset + length);
    if (format === 4) {
      if (sub.readUInt16BE(4) !== 0) return fail('linguagem Unicode não suportada');
      const countX2 = sub.readUInt16BE(6);
      const n = countX2 / 2;
      if (countX2 % 2 !== 0 || n < 1 || n > MAX_SEGMENTS || 16 + n * 8 > length)
        return fail('segmentos inválidos ou truncados');
      if (sub.readUInt16BE(14 + 2 * n) !== 0) return fail('reservedPad inválido');
      let previousEnd = -1;
      for (let s = 0; s < n; s++) {
        const end = sub.readUInt16BE(14 + 2 * s);
        const start = sub.readUInt16BE(16 + 2 * n + 2 * s);
        const delta = sub.readInt16BE(16 + 4 * n + 2 * s);
        const rangeAt = 16 + 6 * n + 2 * s;
        const range = sub.readUInt16BE(rangeAt);
        if (start > end || start <= previousEnd || range % 2 !== 0)
          return fail('segmentos sobrepostos, fora de ordem ou offset ímpar');
        if (
          range !== 0 &&
          (rangeAt + range < 16 + 8 * n || rangeAt + range + 2 * (end - start) + 2 > length)
        )
          return fail('glyphIdArray fora dos limites');
        for (let code = start; code <= end; code++) {
          const raw = range === 0 ? code : sub.readUInt16BE(rangeAt + range + 2 * (code - start));
          put(code, range !== 0 && raw === 0 ? 0 : (raw + delta) & 0xffff);
        }
        previousEnd = end;
      }
      if (previousEnd !== 0xffff) return fail('sentinela final ausente');
    } else {
      if (sub.readUInt16BE(2) !== 0) return fail('campo reservado inválido');
      if (sub.readUInt32BE(8) !== 0) return fail('linguagem Unicode não suportada');
      const groups = sub.readUInt32BE(12);
      if (groups > MAX_SEGMENTS || 16 + groups * 12 !== length) return fail('grupos inválidos');
      let previousEnd = -1;
      for (let g = 0; g < groups; g++) {
        const at = 16 + g * 12;
        const start = sub.readUInt32BE(at);
        const end = sub.readUInt32BE(at + 4);
        const first = sub.readUInt32BE(at + 8);
        if (start > end || start <= previousEnd || end > 0x10ffff || end - start >= MAX_ENTRIES)
          return fail('intervalo de grupo inválido');
        for (let code = start; code <= end; code++) put(code, first + code - start);
        previousEnd = end;
      }
    }
  }
  const covered = new Map([...map].filter(([, glyph]) => glyph !== 0));
  if (covered.size === 0) return fail('nenhum mapeamento Unicode utilizável');
  return covered;
}
