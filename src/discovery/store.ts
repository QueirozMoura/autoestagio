import type { Db } from '../db/index.js';
import type { DedupeCandidate } from './dedupe.js';
import type { NormalizedJob } from './normalize.js';
import { titleKeyOf } from './normalize.js';

interface JobRow {
  id: number;
  canonical_url: string;
  title: string;
  identity_key: string | null;
  description: string | null;
  content_hash: string;
}

interface SightingRow {
  id: number;
  job_id: number;
  source_id: number;
  external_id: string | null;
  canonical_url: string;
}

export interface RunCounters {
  found: number;
  new: number;
  updated: number;
  duplicates: number;
  possibleDuplicates: number;
  invalid: number;
  failed: number;
}

const CANDIDATE_LIMIT = 50;

/** Acesso ao SQLite para vagas. Exige que as migrações já tenham sido aplicadas. */
export class JobStore {
  constructor(private readonly db: Db) {}

  /** Executa `fn` em uma transação: qualquer falha desfaz tudo o que `fn` gravou. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  upsertSource(kind: string, slug: string, name: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO sources (kind, slug, name) VALUES (?, ?, ?)
         ON CONFLICT (kind, slug) DO UPDATE SET name = excluded.name
         RETURNING id`,
      )
      .get(kind, slug, name) as { id: number };
    return row.id;
  }

  findSighting(
    sourceId: number,
    externalId: string,
  ): { sightingId: number; jobId: number } | undefined {
    const row = this.db
      .prepare('SELECT id, job_id FROM job_sightings WHERE source_id = ? AND external_id = ?')
      .get(sourceId, externalId) as { id: number; job_id: number } | undefined;
    return row && { sightingId: row.id, jobId: row.job_id };
  }

  /** Vagas que compartilham URL canônica ou identidade com a recebida. */
  findCandidates(canonicalUrl: string, identityKey: string | null): DedupeCandidate[] {
    const ids = this.db
      .prepare(
        `SELECT DISTINCT j.id AS id
           FROM jobs j
           LEFT JOIN job_sightings s ON s.job_id = j.id
          WHERE j.canonical_url = @url
             OR s.canonical_url = @url
             OR (@identity IS NOT NULL AND j.identity_key = @identity)
          ORDER BY j.id
          LIMIT ${CANDIDATE_LIMIT}`,
      )
      .all({ url: canonicalUrl, identity: identityKey }) as { id: number }[];

    const getJob = this.db.prepare(
      'SELECT id, canonical_url, title, identity_key, description, content_hash FROM jobs WHERE id = ?',
    );
    const getSightings = this.db.prepare(
      'SELECT id, job_id, source_id, external_id, canonical_url FROM job_sightings WHERE job_id = ?',
    );

    return ids.map(({ id }) => {
      const job = getJob.get(id) as JobRow;
      const sightings = getSightings.all(id) as SightingRow[];
      return {
        jobId: job.id,
        canonicalUrls: [job.canonical_url, ...sightings.map((s) => s.canonical_url)],
        titleKey: titleKeyOf(job.title),
        identityKey: job.identity_key,
        description: job.description,
        sightings: sightings.map((s) => ({ sourceId: s.source_id, externalId: s.external_id })),
      };
    });
  }

  contentHashOf(jobId: number): string | undefined {
    const row = this.db.prepare('SELECT content_hash FROM jobs WHERE id = ?').get(jobId) as
      { content_hash: string } | undefined;
    return row?.content_hash;
  }

  /** Fonte que originou a vaga (a única autorizada a alterar o seu conteúdo). */
  ownerSourceOf(jobId: number): number | undefined {
    const row = this.db.prepare('SELECT source_id FROM jobs WHERE id = ?').get(jobId) as
      { source_id: number } | undefined;
    return row?.source_id;
  }

  hasSightingFromSource(jobId: number, sourceId: number): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM job_sightings WHERE job_id = ? AND source_id = ?')
        .get(jobId, sourceId) !== undefined
    );
  }

  insertJob(sourceId: number, job: NormalizedJob, now: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO jobs (
           source_id, external_id, url, canonical_url, apply_url, title, company, location, work_mode,
           stipend_amount, stipend_max, stipend_currency, stipend_text, description, posted_at,
           content_hash, identity_key, first_seen_at, last_seen_at, updated_at
         ) VALUES (
           @sourceId, @externalId, @url, @canonicalUrl, @applyUrl, @title, @company, @location, @workMode,
           @stipendMin, @stipendMax, @stipendCurrency, @stipendText, @description, @postedAt,
           @contentHash, @identityKey, @now, @now, @now
         )`,
      )
      .run({ sourceId, now, ...job });
    return Number(result.lastInsertRowid);
  }

  /** Registra (ou renova) a aparição da vaga em uma fonte. */
  recordSighting(jobId: number, sourceId: number, job: NormalizedJob, now: string): void {
    this.db
      .prepare(
        `INSERT INTO job_sightings (
           job_id, source_id, external_id, url, canonical_url, first_seen_at, last_seen_at
         ) VALUES (@jobId, @sourceId, @externalId, @url, @canonicalUrl, @now, @now)
         ON CONFLICT (job_id, source_id, canonical_url) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           external_id = COALESCE(job_sightings.external_id, excluded.external_id)`,
      )
      .run({
        jobId,
        sourceId,
        externalId: job.externalId,
        url: job.url,
        canonicalUrl: job.canonicalUrl,
        now,
      });
  }

  touchSighting(sightingId: number, now: string): void {
    this.db.prepare('UPDATE job_sightings SET last_seen_at = ? WHERE id = ?').run(now, sightingId);
  }

  touchJob(jobId: number, now: string): void {
    this.db.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?').run(now, jobId);
  }

  /** A própria fonte alterou a vaga: atualiza o conteúdo (mantém `first_seen_at` e `status`). */
  updateJobContent(jobId: number, job: NormalizedJob, now: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET
           url = @url, canonical_url = @canonicalUrl, apply_url = @applyUrl, title = @title, company = @company,
           location = @location, work_mode = @workMode, stipend_amount = @stipendMin,
           stipend_max = @stipendMax, stipend_currency = @stipendCurrency,
           stipend_text = @stipendText, description = @description, posted_at = @postedAt,
           content_hash = @contentHash, identity_key = @identityKey,
           last_seen_at = @now, updated_at = @now
         WHERE id = @jobId`,
      )
      .run({ jobId, now, ...job });
  }

  /** Outra fonte viu a mesma vaga: só preenche o que faltava, sem sobrescrever nada. */
  fillMissing(jobId: number, job: NormalizedJob, now: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET
           apply_url = COALESCE(apply_url, @applyUrl),
           company = COALESCE(company, @company),
           location = COALESCE(location, @location),
           work_mode = COALESCE(work_mode, @workMode),
           description = COALESCE(description, @description),
           posted_at = COALESCE(posted_at, @postedAt),
           stipend_amount = COALESCE(stipend_amount, @stipendMin),
           stipend_max = COALESCE(stipend_max, @stipendMax),
           stipend_currency = COALESCE(stipend_currency, @stipendCurrency),
           stipend_text = COALESCE(stipend_text, @stipendText),
           last_seen_at = @now
         WHERE id = @jobId`,
      )
      .run({ jobId, now, ...job });
  }

  /**
   * Marca duas vagas como possível duplicata. O par é guardado ordenado por id (uma única linha por
   * par) e, se já existia, a evidência mais forte prevalece.
   */
  addPossibleDuplicate(
    jobId: number,
    otherJobId: number,
    reason: string,
    score: number,
    now: string,
  ): void {
    const [low, high] = jobId < otherJobId ? [jobId, otherJobId] : [otherJobId, jobId];
    this.db
      .prepare(
        `INSERT INTO job_possible_duplicates (job_id, other_job_id, reason, score, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (job_id, other_job_id) DO UPDATE SET
           reason = excluded.reason,
           score = excluded.score
         WHERE excluded.score > job_possible_duplicates.score`,
      )
      .run(low, high, reason, score, now);
  }

  startRun(sourceId: number, now: string, simulated: boolean): number {
    const result = this.db
      .prepare('INSERT INTO scan_runs (source_id, started_at, simulated) VALUES (?, ?, ?)')
      .run(sourceId, now, simulated ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  finishRun(runId: number, now: string, counters: RunCounters, error: string | null): void {
    this.db
      .prepare(
        `UPDATE scan_runs SET
           finished_at = @now, jobs_found = @found, jobs_new = @new, jobs_updated = @updated,
           jobs_duplicate = @duplicates, jobs_possible_duplicate = @possibleDuplicates,
           jobs_invalid = @invalid, jobs_failed = @failed, error = @error
         WHERE id = @runId`,
      )
      .run({
        runId,
        now,
        error,
        found: counters.found,
        new: counters.new,
        updated: counters.updated,
        duplicates: counters.duplicates,
        possibleDuplicates: counters.possibleDuplicates,
        invalid: counters.invalid,
        failed: counters.failed,
      });
  }
}
