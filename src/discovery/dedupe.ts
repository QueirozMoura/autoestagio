import { jaccard, tokenSet } from './text.js';

/** Títulos só são "compatíveis" com URL igual se forem quase idênticos. */
export const TITLE_SIMILARITY_MIN = 0.8;
/** Descrições só corroboram a identidade se forem praticamente o mesmo texto. */
export const DESCRIPTION_SIMILARITY_MIN = 0.85;
/** Descrições curtas demais não servem de prova. */
export const DESCRIPTION_MIN_TOKENS = 30;

export interface DedupeIncoming {
  sourceId: number;
  externalId: string | null;
  canonicalUrl: string;
  titleKey: string;
  identityKey: string | null;
  description: string | null;
}

export interface DedupeCandidate {
  jobId: number;
  /** URL canônica da vaga e de todas as suas aparições em outras fontes. */
  canonicalUrls: string[];
  titleKey: string;
  identityKey: string | null;
  description: string | null;
  sightings: { sourceId: number; externalId: string | null }[];
}

export type DuplicateReason = 'canonical_url' | 'identity_and_description';

export type Verdict =
  | { kind: 'duplicate'; reason: DuplicateReason; score: number }
  | { kind: 'possible'; reason: string; score: number }
  | { kind: 'distinct' };

export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenSet(a, 1), tokenSet(b, 1));
}

/** Retorna 0 se alguma das descrições for curta demais para comparar. */
export function descriptionSimilarity(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  const left = tokenSet(a, 3);
  const right = tokenSet(b, 3);
  if (left.size < DESCRIPTION_MIN_TOKENS || right.size < DESCRIPTION_MIN_TOKENS) return 0;
  return jaccard(left, right);
}

/**
 * Compara uma vaga recebida com uma vaga já guardada.
 *
 * Regras, da mais forte para a mais fraca:
 *  1. Dentro da mesma fonte, o identificador externo é a palavra final: ids diferentes são vagas
 *     diferentes, mesmo com título e URL parecidos. (Ids iguais já foram tratados antes.)
 *  2. URL canônica igual + título quase idêntico → duplicada.
 *  3. Identidade normalizada igual (empresa + título + local) só prova duplicidade se a descrição
 *     também for praticamente idêntica. Sem essa corroboração vira apenas "possível duplicata".
 */
export function judge(incoming: DedupeIncoming, candidate: DedupeCandidate): Verdict {
  const knownInSameSource = candidate.sightings.some(
    (sighting) => sighting.sourceId === incoming.sourceId && sighting.externalId !== null,
  );
  if (incoming.externalId !== null && knownInSameSource) return { kind: 'distinct' };

  if (candidate.canonicalUrls.includes(incoming.canonicalUrl)) {
    const score = titleSimilarity(incoming.titleKey, candidate.titleKey);
    return score >= TITLE_SIMILARITY_MIN
      ? { kind: 'duplicate', reason: 'canonical_url', score }
      : { kind: 'possible', reason: 'canonical_url_title_differs', score };
  }

  if (incoming.identityKey !== null && incoming.identityKey === candidate.identityKey) {
    const score = descriptionSimilarity(incoming.description, candidate.description);
    return score >= DESCRIPTION_SIMILARITY_MIN
      ? { kind: 'duplicate', reason: 'identity_and_description', score }
      : { kind: 'possible', reason: 'identity_only', score };
  }

  return { kind: 'distinct' };
}
