export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Chave de comparação: minúsculas, sem acentos e sem pontuação (preserva "+" e "#": C++ ≠ C#). */
export function toKey(value: string): string {
  return collapseWhitespace(
    stripAccents(value)
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, ' '),
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Converte HTML em texto simples. Nada é renderizado; tags e scripts são descartados. */
export function htmlToText(input: string): string {
  const text = input
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(?:br|\/p|\/div|\/ul|\/ol|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .split(/\r?\n/)
    .map(collapseWhitespace)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function tokenSet(value: string, minLength: number): Set<string> {
  return new Set(
    toKey(value)
      .split(' ')
      .filter((token) => token.length >= minLength),
  );
}

/** Similaridade de Jaccard entre dois conjuntos. Conjuntos vazios nunca são "similares". */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
