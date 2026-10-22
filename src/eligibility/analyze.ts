import { createHash } from 'node:crypto';
import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import type { WorkMode } from '../discovery/normalize.js';
import { evaluateJob } from './evaluate.js';
import type { EligibilityResult, Verdict } from './types.js';

interface JobRow {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  work_mode: WorkMode | null;
  description: string | null;
  stipend_amount: number | null;
  stipend_max: number | null;
  stipend_currency: string | null;
  stipend_text: string | null;
  url: string;
}

export interface AnalyzedJob {
  jobId: number;
  title: string;
  company: string | null;
  url: string;
  result: EligibilityResult;
}

export interface AnalysisReport {
  total: number;
  counts: Record<Verdict, number>;
  jobs: AnalyzedJob[];
  saved: boolean;
}

export interface AnalyzeOptions {
  db: Db;
  profile: Profile;
  /** Restringe a análise a estas vagas (padrão: todas). */
  jobIds?: readonly number[];
  /** Grava o resultado em `job_eligibility` (padrão: sim). */
  save?: boolean;
  now?: Date;
}

/** Identifica o perfil usado; não é reversível para os dados. */
export function profileHash(profile: Profile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 16);
}

/**
 * Analisa as vagas já descobertas. Não altera `jobs` (nem o status): só lê as vagas e grava o
 * resultado em `job_eligibility`. Repetir com o mesmo perfil e as mesmas vagas dá o mesmo resultado.
 */
export function analyzeJobs(options: AnalyzeOptions): AnalysisReport {
  const { db, profile, save = true, jobIds } = options;
  const now = options.now ?? new Date();
  const hash = profileHash(profile);
  const rows = db
    .prepare(
      `SELECT id, title, company, location, work_mode, description, stipend_amount, stipend_max,
              stipend_currency, stipend_text, url
         FROM jobs ORDER BY id`,
    )
    .all() as JobRow[];
  const selected = jobIds === undefined ? rows : rows.filter((row) => jobIds.includes(row.id));

  const upsert = db.prepare(
    `INSERT INTO job_eligibility (
       job_id, verdict, reasons, criteria, differentials_matched, differentials_total,
       profile_hash, evaluated_at
     ) VALUES (@jobId, @verdict, @reasons, @criteria, @matched, @total, @hash, @now)
     ON CONFLICT (job_id) DO UPDATE SET
       verdict = excluded.verdict, reasons = excluded.reasons, criteria = excluded.criteria,
       differentials_matched = excluded.differentials_matched,
       differentials_total = excluded.differentials_total,
       profile_hash = excluded.profile_hash, evaluated_at = excluded.evaluated_at`,
  );

  const counts: Record<Verdict, number> = { apto: 0, inapto: 0, revisao_humana: 0 };
  const jobs: AnalyzedJob[] = [];
  const run = db.transaction(() => {
    for (const row of selected) {
      const result = evaluateJob(
        profile,
        {
          title: row.title,
          company: row.company,
          location: row.location,
          workMode: row.work_mode,
          description: row.description,
          stipendMin: row.stipend_amount,
          stipendMax: row.stipend_max,
          stipendCurrency: row.stipend_currency,
          stipendText: row.stipend_text,
        },
        { now },
      );
      counts[result.verdict]++;
      jobs.push({ jobId: row.id, title: row.title, company: row.company, url: row.url, result });
      if (save) {
        upsert.run({
          jobId: row.id,
          verdict: result.verdict,
          reasons: JSON.stringify(result.reasons),
          criteria: JSON.stringify(result.criteria),
          matched: result.differentials.matched,
          total: result.differentials.total,
          hash,
          now: now.toISOString(),
        });
      }
    }
  });
  run();

  return { total: selected.length, counts, jobs, saved: save };
}
