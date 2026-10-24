import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { profileHash, type Criterion } from '../eligibility/index.js';
import { usableRecipient } from '../email/index.js';
import { candidateEmail } from './email-connector.js';

/**
 * Métricas de descoberta: quanto cada fonte entrega de vagas NOVAS e de vagas RELEVANTES. Somente leitura.
 *   relevante      = estágio com área de TI não reprovada (área "atende" ou sem dado) e não inapto por outro motivo;
 *   em TI          = a área não foi reprovada na elegibilidade;
 *   automatizável  = tem destinatário de e-mail verificado ou um único e-mail corporativo na descrição oficial.
 */
export interface SourceMetric {
  source: string;
  jobs: number;
  newInWindow: number;
  inIt: number;
  relevant: number;
  apto: number;
  pendente: number;
  inapto: number;
  automatable: number;
  runsInWindow: number;
  foundInWindow: number;
  errorsInWindow: number;
}

interface JobRow {
  id: number;
  kind: string;
  slug: string;
  description: string | null;
  fresh: number;
  verdict: string | null;
  criteria: string | null;
}

const empty = (source: string): SourceMetric => ({
  source,
  jobs: 0,
  newInWindow: 0,
  inIt: 0,
  relevant: 0,
  apto: 0,
  pendente: 0,
  inapto: 0,
  automatable: 0,
  runsInWindow: 0,
  foundInWindow: 0,
  errorsInWindow: 0,
});

export function classifyFresh(row: Pick<JobRow, 'verdict' | 'criteria'>): {
  inIt: boolean;
  relevant: boolean;
} {
  const criteria = row.criteria === null ? [] : (JSON.parse(row.criteria) as Criterion[]);
  const area = criteria.find((c) => c.id === 'area');
  const inIt = area !== undefined && area.outcome !== 'nao_atende';
  return { inIt, relevant: inIt && row.verdict !== 'inapto' };
}

export function sourceMetrics(
  db: Db,
  profile: Profile,
  windowDays: number,
  now: Date = new Date(),
): SourceMetric[] {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT j.id, s.kind, s.slug, j.description,
              (datetime(j.first_seen_at) >= datetime(@since)) AS fresh, e.verdict, e.criteria
         FROM jobs j JOIN sources s ON s.id = j.source_id
         LEFT JOIN job_eligibility e ON e.job_id = j.id AND e.profile_hash = @hash`,
    )
    .all({ since, hash: profileHash(profile) }) as JobRow[];
  const bySource = new Map<string, SourceMetric>();
  const get = (source: string): SourceMetric => {
    const found = bySource.get(source) ?? empty(source);
    bySource.set(source, found);
    return found;
  };
  for (const row of rows) {
    const metric = get(`${row.kind}:${row.slug}`);
    metric.jobs++;
    if (row.fresh === 1) metric.newInWindow++;
    const { inIt, relevant } = classifyFresh(row);
    if (inIt) metric.inIt++;
    if (row.verdict === 'apto') metric.apto++;
    else if (row.verdict === 'revisao_humana') metric.pendente++;
    else if (row.verdict === 'inapto') metric.inapto++;
    if (relevant) {
      metric.relevant++;
      if (usableRecipient(db, row.id) !== undefined || candidateEmail(row.description).ok)
        metric.automatable++;
    }
  }
  const runs = db
    .prepare(
      `SELECT s.kind, s.slug, COUNT(*) AS runs, COALESCE(SUM(r.jobs_found), 0) AS found,
              SUM(CASE WHEN r.error IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM scan_runs r JOIN sources s ON s.id = r.source_id
        WHERE r.simulated = 0 AND datetime(r.started_at) >= datetime(?)
        GROUP BY s.id`,
    )
    .all(since) as { kind: string; slug: string; runs: number; found: number; errors: number }[];
  for (const run of runs) {
    const metric = get(`${run.kind}:${run.slug}`);
    metric.runsInWindow = run.runs;
    metric.foundInWindow = run.found;
    metric.errorsInWindow = run.errors;
  }
  return [...bySource.values()].sort((a, b) => b.relevant - a.relevant || b.jobs - a.jobs);
}

export interface FreshSummary {
  total: number;
  inIt: number;
  apto: number;
  pendente: number;
  descartada: number;
  automatable: number;
}

/** Vagas vistas pela primeira vez a partir de `since` (início da execução): o que a coleta realmente trouxe de novo. */
export function freshSummary(db: Db, profile: Profile, since: Date): FreshSummary {
  const rows = db
    .prepare(
      `SELECT j.id, j.description, e.verdict, e.criteria
         FROM jobs j LEFT JOIN job_eligibility e ON e.job_id = j.id AND e.profile_hash = @hash
        WHERE datetime(j.first_seen_at) >= datetime(@since)`,
    )
    .all({ since: since.toISOString(), hash: profileHash(profile) }) as JobRow[];
  const out: FreshSummary = {
    total: 0,
    inIt: 0,
    apto: 0,
    pendente: 0,
    descartada: 0,
    automatable: 0,
  };
  for (const row of rows) {
    out.total++;
    const { inIt, relevant } = classifyFresh(row);
    if (inIt) out.inIt++;
    if (row.verdict === 'apto') out.apto++;
    else if (row.verdict === 'revisao_humana') out.pendente++;
    else out.descartada++;
    if (
      relevant &&
      (usableRecipient(db, row.id) !== undefined || candidateEmail(row.description).ok)
    )
      out.automatable++;
  }
  return out;
}
