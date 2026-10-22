import type { Db } from '../db/index.js';
import {
  rawJobSchema,
  sourceKey,
  toSourceError,
  type JobSource,
  type SourceContext,
  type SourceErrorCategory,
} from '../sources/index.js';
import { ingestJob } from './ingest.js';
import { NormalizationError, normalizeJob } from './normalize.js';
import { JobStore, type RunCounters } from './store.js';

export interface SourceScanReport extends RunCounters {
  source: string;
  /** Falha que interrompeu esta fonte; as demais continuam. */
  error: string | null;
  errorCategory: SourceErrorCategory | null;
  /** Mensagens das vagas que falharam na persistência (limitadas). */
  failures: string[];
}

export interface ScanReport {
  startedAt: string;
  finishedAt: string;
  simulated: boolean;
  sources: SourceScanReport[];
  totals: RunCounters;
}

export interface ScanOptions {
  db: Db;
  sources: JobSource[];
  context: SourceContext;
  simulated?: boolean;
  now?: () => Date;
  /** Falhas seguidas de persistência que interrompem a fonte (evita insistir num banco quebrado). */
  maxConsecutiveFailures?: number;
}

const MAX_RECORDED_FAILURES = 10;

function emptyCounters(): RunCounters {
  return {
    found: 0,
    new: 0,
    updated: 0,
    duplicates: 0,
    possibleDuplicates: 0,
    invalid: 0,
    failed: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Percorre as fontes em sequência, normaliza cada vaga e a grava. Cada vaga é gravada em sua
 * própria transação e cada fonte é isolada: uma falha não derruba as demais.
 */
export async function runScan(options: ScanOptions): Promise<ScanReport> {
  const { db, sources, context } = options;
  const simulated = options.simulated ?? false;
  const clock = options.now ?? (() => new Date());
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
  const store = new JobStore(db);
  const startedAt = clock().toISOString();
  const reports: SourceScanReport[] = [];

  for (const source of sources) {
    const sourceId = store.upsertSource(source.kind, source.slug, source.name);
    const runId = store.startRun(sourceId, clock().toISOString(), simulated);
    const report: SourceScanReport = {
      source: sourceKey(source),
      ...emptyCounters(),
      error: null,
      errorCategory: null,
      failures: [],
    };
    let consecutiveFailures = 0;

    try {
      for await (const item of source.fetchJobs(context)) {
        context.signal?.throwIfAborted();
        if (report.found >= context.limits.maxJobs) break;
        report.found++;

        const parsed = rawJobSchema.safeParse(item);
        if (!parsed.success) {
          report.invalid++;
          continue;
        }

        let normalized;
        try {
          normalized = normalizeJob(parsed.data);
        } catch (error) {
          if (error instanceof NormalizationError) {
            report.invalid++;
            continue;
          }
          throw error;
        }

        try {
          const result = ingestJob(store, sourceId, normalized, clock().toISOString());
          consecutiveFailures = 0;
          if (result.action === 'new') report.new++;
          else report.duplicates++;
          if (result.action === 'updated') report.updated++;
          report.possibleDuplicates += result.possibleDuplicates;
        } catch (error) {
          report.failed++;
          consecutiveFailures++;
          if (report.failures.length < MAX_RECORDED_FAILURES) {
            report.failures.push(errorMessage(error));
          }
          if (consecutiveFailures >= maxConsecutiveFailures) {
            throw new Error(
              `Fonte interrompida após ${consecutiveFailures} falhas seguidas ao gravar: ${errorMessage(error)}`,
              { cause: error },
            );
          }
        }
      }
    } catch (error) {
      const sourceError = toSourceError(source, error);
      report.error = sourceError.message;
      report.errorCategory = sourceError.category;
    }

    const runError = report.error ?? report.failures[0] ?? null;
    store.finishRun(runId, clock().toISOString(), report, runError);
    reports.push(report);
  }

  const totals = reports.reduce<RunCounters>((sum, report) => {
    sum.found += report.found;
    sum.new += report.new;
    sum.updated += report.updated;
    sum.duplicates += report.duplicates;
    sum.possibleDuplicates += report.possibleDuplicates;
    sum.invalid += report.invalid;
    sum.failed += report.failed;
    return sum;
  }, emptyCounters());

  return { startedAt, finishedAt: clock().toISOString(), simulated, sources: reports, totals };
}
