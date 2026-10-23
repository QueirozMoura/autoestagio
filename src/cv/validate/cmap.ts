/**
 * Leitor de CMaps `ToUnicode` (somente leitura): mapeia o código de cada glifo (CID de 2 bytes, `Identity-H`)
 * para o texto Unicode que ele representa. A entrada é o texto do fluxo já descomprimido.
 *
 * Aqui só se interpreta o mapa: as verificações sobre ele (cobertura, ligaduras…) ficam em H6 e H7.
 */
export class CMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CMapError';
  }
}

export interface CMap {
  /** CID → texto (pode ter mais de um ponto de código; é o que o H7 vai examinar). */
  map: Map<number, string>;
  /** Intervalos de códigos declarados (`begincodespacerange`). */
  codespace: [number, number][];
}

export const MAX_CMAP_ENTRIES = 70_000;

const HEX = /<([0-9a-fA-F\s]*)>/gu;

/** UTF-16BE em hexadecimal → texto (aceita pares substitutos). */
function utf16Hex(hex: string): string {
  const clean = hex.replace(/\s+/gu, '');
  if (clean.length === 0 || clean.length % 4 !== 0)
    throw new CMapError(`destino Unicode inválido: <${hex}>`);
  const units: number[] = [];
  for (let i = 0; i < clean.length; i += 4) units.push(parseInt(clean.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

const codeOf = (hex: string): number => {
  const clean = hex.replace(/\s+/gu, '');
  if (!/^[0-9a-fA-F]{1,8}$/u.test(clean)) throw new CMapError(`código inválido: <${hex}>`);
  return parseInt(clean, 16);
};

export function parseToUnicode(text: string, maxEntries = MAX_CMAP_ENTRIES): CMap {
  const map = new Map<number, string>();
  const codespace: [number, number][] = [];
  const put = (code: number, value: string): void => {
    if (map.size >= maxEntries) throw new CMapError(`mais de ${maxEntries} entradas no ToUnicode`);
    map.set(code, value);
  };

  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/gu)) {
    const pairs = [...(block[1] ?? '').matchAll(HEX)].map((m) => codeOf(m[1] ?? ''));
    for (let i = 0; i + 1 < pairs.length; i += 2)
      codespace.push([pairs[i] ?? 0, pairs[i + 1] ?? 0]);
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    const hexes = [...(block[1] ?? '').matchAll(HEX)].map((m) => m[1] ?? '');
    if (hexes.length % 2 !== 0) throw new CMapError('bfchar com número ímpar de valores');
    for (let i = 0; i < hexes.length; i += 2)
      put(codeOf(hexes[i] ?? ''), utf16Hex(hexes[i + 1] ?? ''));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = block[1] ?? '';
    // Cada entrada: <lo> <hi> <destino>   ou   <lo> <hi> [<d1> <d2> …]
    const entry = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]*>)/gu;
    for (const m of body.matchAll(entry)) {
      const lo = codeOf(m[1] ?? '');
      const hi = codeOf(m[2] ?? '');
      if (hi < lo || hi - lo > 0xffff)
        throw new CMapError(`intervalo inválido <${m[1]}> <${m[2]}>`);
      const target = m[3] ?? '';
      if (target.startsWith('[')) {
        const dests = [...target.matchAll(HEX)].map((d) => d[1] ?? '');
        if (dests.length !== hi - lo + 1)
          throw new CMapError(`array com ${dests.length} destinos para ${hi - lo + 1} códigos`);
        dests.forEach((d, i) => {
          put(lo + i, utf16Hex(d));
        });
      } else {
        const first = utf16Hex(target.slice(1, -1));
        for (let code = lo; code <= hi; code++) {
          const units = Array.from(first);
          const last = units.pop() ?? '';
          put(
            code,
            units.join('') + String.fromCodePoint((last.codePointAt(0) ?? 0) + (code - lo)),
          );
        }
      }
    }
  }
  return { map, codespace };
}
