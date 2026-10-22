import { judge, type DedupeIncoming, type DuplicateReason } from './dedupe.js';
import type { NormalizedJob } from './normalize.js';
import type { JobStore } from './store.js';

export type IngestAction =
  /** Vaga nunca vista: inserida. */
  | 'new'
  /** Mesma vaga, mesma fonte, mas a fonte alterou o conteúdo: atualizada. */
  | 'updated'
  /** Mesma vaga, mesma fonte, nada mudou: apenas `last_seen_at` avançou. */
  | 'unchanged'
  /** Mesma vaga já conhecida por outra fonte: nova aparição registrada, sem criar outra vaga. */
  | 'merged';

export interface IngestResult {
  action: IngestAction;
  jobId: number;
  matchedBy?: DuplicateReason | 'source_external_id' | 'source_url';
  /** Pares marcados como "possível duplicata" (não unificados) nesta chamada. */
  possibleDuplicates: number;
}

/** Aplica ao banco uma vaga normalizada, de forma atômica: em caso de falha nada é gravado. */
export function ingestJob(
  store: JobStore,
  sourceId: number,
  job: NormalizedJob,
  now: string,
): IngestResult {
  return store.transaction(() => {
    // 1. A fonte já nos mostrou esta vaga (mesmo identificador externo).
    if (job.externalId !== null) {
      const known = store.findSighting(sourceId, job.externalId);
      if (known) {
        store.touchSighting(known.sightingId, now);
        return refresh(store, sourceId, known.jobId, job, now, 'source_external_id');
      }
    }

    // 2. Procura candidatas por URL canônica e identidade, e julga uma a uma.
    const incoming: DedupeIncoming = {
      sourceId,
      externalId: job.externalId,
      canonicalUrl: job.canonicalUrl,
      titleKey: job.titleKey,
      identityKey: job.identityKey,
      description: job.description,
    };

    const possible: { jobId: number; reason: string; score: number }[] = [];
    const duplicates: { jobId: number; reason: DuplicateReason }[] = [];

    for (const candidate of store.findCandidates(job.canonicalUrl, job.identityKey)) {
      const verdict = judge(incoming, candidate);
      if (verdict.kind === 'duplicate') {
        duplicates.push({ jobId: candidate.jobId, reason: verdict.reason });
      } else if (verdict.kind === 'possible') {
        possible.push({ jobId: candidate.jobId, reason: verdict.reason, score: verdict.score });
      }
    }

    // URL igual é prova mais forte que identidade + descrição; em empate vale a vaga mais antiga.
    const duplicate = duplicates.find((d) => d.reason === 'canonical_url') ?? duplicates[0];

    if (duplicate) {
      const alreadySeenHere = store.hasSightingFromSource(duplicate.jobId, sourceId);
      store.recordSighting(duplicate.jobId, sourceId, job, now);
      if (alreadySeenHere) {
        return refresh(store, sourceId, duplicate.jobId, job, now, 'source_url');
      }
      store.fillMissing(duplicate.jobId, job, now);

      // A vaga recebida liga duas ou mais vagas que já estavam separadas. Unir linhas existentes
      // poderia quebrar análises e candidaturas que as referenciam, então só sinalizamos.
      const others = duplicates.filter((d) => d.jobId !== duplicate.jobId);
      for (const other of others) {
        store.addPossibleDuplicate(duplicate.jobId, other.jobId, 'linked_by_same_listing', 1, now);
      }
      return {
        action: 'merged',
        jobId: duplicate.jobId,
        matchedBy: duplicate.reason,
        possibleDuplicates: others.length,
      };
    }

    // 3. Vaga nova. Semelhantes sem prova suficiente ficam apenas sinalizadas.
    const jobId = store.insertJob(sourceId, job, now);
    store.recordSighting(jobId, sourceId, job, now);
    for (const item of possible) {
      store.addPossibleDuplicate(jobId, item.jobId, item.reason, item.score, now);
    }
    return { action: 'new', jobId, possibleDuplicates: possible.length };
  });
}

/**
 * Uma fonte reapresentou uma vaga que já conhecemos. Só a fonte que originou a vaga pode alterar
 * o conteúdo dela, e apenas se ele mudou; as demais só renovam `last_seen_at`.
 */
function refresh(
  store: JobStore,
  sourceId: number,
  jobId: number,
  job: NormalizedJob,
  now: string,
  matchedBy: 'source_external_id' | 'source_url',
): IngestResult {
  const isOwner = store.ownerSourceOf(jobId) === sourceId;
  if (isOwner && store.contentHashOf(jobId) !== job.contentHash) {
    store.updateJobContent(jobId, job, now);
    return { action: 'updated', jobId, matchedBy, possibleDuplicates: 0 };
  }
  store.touchJob(jobId, now);
  return { action: 'unchanged', jobId, matchedBy, possibleDuplicates: 0 };
}
