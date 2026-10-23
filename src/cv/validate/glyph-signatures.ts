import { createHash } from 'node:crypto';
import { glyphBytes, glyphMetrics, isCompositeGlyph, type TrueTypeFont } from './truetype.js';

export class FontProofError extends Error {}

/** Limites absolutos da prova, mesmo que o chamador amplie os limites do leitor estrutural. */
export const PROOF_LIMITS = {
  glyphs: 6000,
  bytes: 2 * 1024 * 1024,
  depth: 8,
  components: 64,
  edges: 100_000,
} as const;

/** Hashes de tamanho fixo e memoização evitam expandir árvores de componentes repetidos. */
export function glyphSignatures(font: TrueTypeFont): string[] {
  if (
    !Number.isSafeInteger(font.numGlyphs) ||
    font.numGlyphs < 1 ||
    font.numGlyphs > PROOF_LIMITS.glyphs ||
    font.data.length > PROOF_LIMITS.bytes
  )
    throw new FontProofError('limite de glifos ou bytes da prova de identidade excedido');
  const memo = new Map<number, { key: string; depth: number }>();
  const visiting = new Set<number>();
  let edges = 0;
  const visit = (gid: number, level: number): { key: string; depth: number } => {
    if (level > PROOF_LIMITS.depth)
      throw new FontProofError('limite de profundidade dos compostos');
    if (visiting.has(gid)) throw new FontProofError('ciclo nos componentes do glifo composto');
    const cached = memo.get(gid);
    if (cached !== undefined) {
      if (level + cached.depth > PROOF_LIMITS.depth)
        throw new FontProofError('limite de profundidade dos compostos');
      return cached;
    }
    const metrics = glyphMetrics(font, gid);
    const range = font.glyphRanges[gid];
    const glyf = font.tables.get('glyf');
    if (
      metrics === undefined ||
      range === undefined ||
      glyf === undefined ||
      range[0] < 0 ||
      range[1] < range[0] ||
      range[1] > glyf.length ||
      glyf.offset + range[1] > font.data.length
    )
      throw new FontProofError('glifo ou métricas fora dos limites da prova');
    const bytes = glyphBytes(font, gid);
    if (bytes.length > 0 && bytes.length < 10)
      throw new FontProofError('cabeçalho do glifo truncado');
    const normalized = Buffer.from(bytes);
    const children: string[] = [];
    let depth = 0;
    visiting.add(gid);
    if (isCompositeGlyph(bytes)) {
      if (bytes.length < 10) throw new FontProofError('cabeçalho do composto truncado');
      let cursor = 10;
      let flags = 0x20;
      let instructions = false;
      while ((flags & 0x20) !== 0) {
        if (cursor + 4 > bytes.length) throw new FontProofError('componente truncado');
        flags = bytes.readUInt16BE(cursor);
        const child = bytes.readUInt16BE(cursor + 2);
        if ((flags & ~0x1fef) !== 0) throw new FontProofError('flags reservadas no composto');
        const scales = [0x8, 0x40, 0x80].filter((bit) => (flags & bit) !== 0);
        if (scales.length > 1 || (flags & 0x1800) === 0x1800)
          throw new FontProofError('flags de transformação conflitantes no composto');
        normalized.writeUInt16BE(0, cursor + 2); // Apenas o índice reescrito pelo PDFKit.
        cursor += 4 + ((flags & 1) !== 0 ? 4 : 2);
        cursor += (flags & 8) !== 0 ? 2 : (flags & 0x40) !== 0 ? 4 : (flags & 0x80) !== 0 ? 8 : 0;
        if (cursor > bytes.length)
          throw new FontProofError('argumentos ou transformação truncados');
        if (++edges > PROOF_LIMITS.edges || children.length >= PROOF_LIMITS.components)
          throw new FontProofError('limite de componentes/processamento da prova excedido');
        const proof = visit(child, level + 1);
        children.push(proof.key);
        depth = Math.max(depth, proof.depth + 1);
        instructions ||= (flags & 0x100) !== 0;
      }
      if (instructions) {
        if (cursor + 2 > bytes.length)
          throw new FontProofError('comprimento das instruções truncado');
        const length = bytes.readUInt16BE(cursor);
        if (cursor + 2 + length > bytes.length) throw new FontProofError('instruções truncadas');
      }
    }
    const key = createHash('sha256')
      .update(`${metrics.advance}:${metrics.lsb}:${bytes.length}:`)
      .update(normalized)
      .update(children.join(''))
      .digest('hex');
    visiting.delete(gid);
    const proof = { key, depth };
    memo.set(gid, proof);
    return proof;
  };
  return Array.from({ length: font.numGlyphs }, (_, gid) => visit(gid, 0).key);
}
