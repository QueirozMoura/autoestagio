import type { Criterion } from './types.js';

/**
 * Ordenação TRANSPARENTE das vagas candidatas, sem pontuação opaca: uma sequência de chaves comparadas em ordem.
 * A área da vaga NÃO entra: todas as áreas de tecnologia têm a mesma prioridade.
 *   1. elegibilidade   apta antes de "revisão humana";
 *   2. deslocamento    viável (remoto ou ≤ limite confirmado) > pendente/desconhecido > limítrofe (revisão manual);
 *   3. bolsa           conhecida e ≥ mínimo > não informada/indeterminada;
 *   4. requisitos      menos requisitos obrigatórios pendentes primeiro;
 *   5. diferenciais    maior fração atendida primeiro;
 *   6. recência        coletada mais recentemente primeiro (desempate final: número da vaga).
 */
export interface RankInput {
  jobId: number;
  verdict: 'apto' | 'revisao_humana';
  criteria: readonly Criterion[];
  differentialsMatched: number;
  differentialsTotal: number;
  /** ISO 8601 (ou "AAAA-MM-DD hh:mm:ss") da primeira coleta. */
  firstSeenAt: string;
}

export interface RankKeys {
  verdict: 0 | 1;
  commute: 0 | 1 | 2;
  stipend: 0 | 1;
  pendingRequirements: number;
  differentialsRatio: number;
  recencyMs: number;
}

export interface Ranked<T extends RankInput> {
  item: T;
  position: number;
  keys: RankKeys;
  explanation: string[];
}

const find = (criteria: readonly Criterion[], id: string): Criterion | undefined =>
  criteria.find((c) => c.id === id);

function commuteKey(criteria: readonly Criterion[]): { key: 0 | 1 | 2; why: string } {
  const commute = find(criteria, 'deslocamento');
  if (commute !== undefined) {
    if (commute.outcome === 'atende')
      return { key: 0, why: 'deslocamento viável (tempo confirmado dentro do limite)' };
    if (commute.detail.includes('limítrofe'))
      return { key: 2, why: 'deslocamento limítrofe (revisão manual)' };
    return { key: 1, why: 'deslocamento pendente de confirmação' };
  }
  const mode = find(criteria, 'modalidade');
  const place = find(criteria, 'localizacao');
  if (mode?.outcome === 'atende' && place?.outcome === 'atende')
    return { key: 0, why: 'remoto (sem deslocamento) e sem restrição de local' };
  return { key: 1, why: 'modalidade ou local pendentes de confirmação' };
}

export function rankKeys(input: RankInput): { keys: RankKeys; explanation: string[] } {
  const commute = commuteKey(input.criteria);
  const stipend = find(input.criteria, 'bolsa')?.outcome === 'atende' ? 0 : 1;
  const pending = input.criteria.filter(
    (c) => c.kind === 'obrigatorio' && c.outcome === 'indeterminado',
  ).length;
  const ratio =
    input.differentialsTotal > 0 ? input.differentialsMatched / input.differentialsTotal : 0;
  const seen = Date.parse(
    input.firstSeenAt.includes('T') ? input.firstSeenAt : `${input.firstSeenAt.replace(' ', 'T')}Z`,
  );
  const keys: RankKeys = {
    verdict: input.verdict === 'apto' ? 0 : 1,
    commute: commute.key,
    stipend,
    pendingRequirements: pending,
    differentialsRatio: ratio,
    recencyMs: Number.isFinite(seen) ? seen : 0,
  };
  const explanation = [
    `1. elegibilidade: ${input.verdict === 'apto' ? 'apta' : 'revisão humana'}`,
    `2. ${commute.why}`,
    `3. bolsa: ${stipend === 0 ? 'conhecida e acima do mínimo' : 'não informada ou a confirmar'}`,
    `4. requisitos obrigatórios pendentes: ${pending}`,
    `5. diferenciais atendidos: ${input.differentialsMatched}/${input.differentialsTotal}`,
    `6. coletada em ${Number.isFinite(seen) ? new Date(seen).toISOString().slice(0, 10) : 'data desconhecida'}`,
  ];
  return { keys, explanation };
}

export function rankCandidates<T extends RankInput>(items: readonly T[]): Ranked<T>[] {
  const scored = items.map((item) => ({ item, ...rankKeys(item) }));
  scored.sort(
    (a, b) =>
      a.keys.verdict - b.keys.verdict ||
      a.keys.commute - b.keys.commute ||
      a.keys.stipend - b.keys.stipend ||
      a.keys.pendingRequirements - b.keys.pendingRequirements ||
      b.keys.differentialsRatio - a.keys.differentialsRatio ||
      b.keys.recencyMs - a.keys.recencyMs ||
      a.item.jobId - b.item.jobId,
  );
  return scored.map((entry, index) => ({ ...entry, position: index + 1 }));
}
