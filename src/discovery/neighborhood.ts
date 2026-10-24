/**
 * Bairro, região ou rua escritos NA DESCRIÇÃO da vaga (ex.: "na região dos Jardins, em São Paulo"). Só copia o
 * trecho literal que uma frase explícita informa; nunca deduz bairro a partir da cidade ou da empresa.
 */
const NAME = String.raw`[A-ZÀ-Ú][\p{L}'’-]+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ú][\p{L}'’-]+){0,2}`;
const AREA_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bregi[aã]o\s+(?:d[aeo]s?\s+)(${NAME})`, 'u'),
  new RegExp(String.raw`\b[Bb]airro\s+(?:d[aeo]s?\s+)?(${NAME})`, 'u'),
  new RegExp(
    String.raw`\b(?:escrit[oó]rio|unidade|sede)\s+(?:localizad[oa]\s+)?n[oa]s?\s+(?:regi[aã]o\s+d[aeo]s?\s+)?(${NAME})`,
    'u',
  ),
];
const STREET = /\b(?:Av\.?|Avenida|Rua|R\.|Alameda|Al\.)\s+([A-ZÀ-Ú][^,\n.;()]{2,60})/u;
/** Capturas que são cidade/país/orientação, não bairro. */
const GENERIC =
  /^(?:s[aã]o paulo|brasil|brazil|sul|norte|leste|oeste|centro|capital|grande s[aã]o paulo)$/i;

export interface Neighborhood {
  /** Bairro ou região, como escrito. */
  area?: string;
  /** Logradouro, como escrito. */
  street?: string;
}

export function extractNeighborhood(description: string | null | undefined): Neighborhood {
  const text = (description ?? '').replace(/\s+/g, ' ');
  const result: Neighborhood = {};
  for (const pattern of AREA_PATTERNS) {
    const found = pattern.exec(text)?.[1]?.trim();
    if (found !== undefined && !GENERIC.test(found)) {
      result.area = found;
      break;
    }
  }
  const street = STREET.exec(text)?.[1]?.trim();
  if (street !== undefined && !GENERIC.test(street)) result.street = street;
  return result;
}

/** Texto do local detalhado para exibição e para casar com os tempos confirmados no perfil. */
export function neighborhoodText(description: string | null | undefined): string {
  const { area, street } = extractNeighborhood(description);
  return [area, street].filter((part): part is string => part !== undefined).join(' | ');
}
