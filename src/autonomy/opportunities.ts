import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { profileHash, type Criterion } from '../eligibility/index.js';
import { decideJob, type JobFacts } from './decide.js';
import type { Policy } from './policy.js';

/**
 * Carrega as vagas já analisadas (perfil atual) no formato que a política entende. Somente leitura.
 */
interface Row {
  id: number;
  title: string;
  company: string | null;
  work_mode: JobFacts['workMode'];
  stipend_amount: number | null;
  description: string | null;
  url: string;
  apply_url: string | null;
  source_kind: string;
  source_slug: string;
  verdict: JobFacts['verdict'];
  criteria: string;
  differentials_matched: number;
  differentials_total: number;
  first_seen_at: string;
}

export interface FactsWithSource extends JobFacts {
  source: string;
  differentialsMatched: number;
  differentialsTotal: number;
  firstSeenAt: string;
}

export function loadFacts(db: Db, profile: Profile): Map<number, FactsWithSource> {
  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.company, j.work_mode, j.stipend_amount, j.description, j.url,
              j.apply_url, s.kind AS source_kind, s.slug AS source_slug, e.verdict, e.criteria,
              e.differentials_matched, e.differentials_total, j.first_seen_at
         FROM jobs j JOIN sources s ON s.id = j.source_id
         JOIN job_eligibility e ON e.job_id = j.id
        WHERE e.profile_hash = ?`,
    )
    .all(profileHash(profile)) as Row[];
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title,
        company: row.company,
        workMode: row.work_mode,
        stipend: row.stipend_amount,
        description: row.description,
        url: row.url,
        applyUrl: row.apply_url,
        sourceKind: row.source_kind,
        source: `${row.source_kind}:${row.source_slug}`,
        verdict: row.verdict,
        criteria: JSON.parse(row.criteria) as Criterion[],
        differentialsMatched: row.differentials_matched,
        differentialsTotal: row.differentials_total,
        firstSeenAt: row.first_seen_at,
      },
    ]),
  );
}

/**
 * As quatro categorias que importam para a automação:
 *   automatizavel  elegível E com canal que o agente pode usar sozinho (e-mail de candidatura utilizável);
 *   manual         elegível, mas o canal exige você (formulário, portal com reCAPTCHA ou login);
 *   insuficiente   faltam dados comprovados (área, local, bolsa não tolerada, afirmativa...) ou há revisão humana;
 *   incompativel   comprovadamente fora do perfil ou da política.
 */
export type Bucket = 'automatizavel' | 'manual' | 'insuficiente' | 'incompativel';

export interface Opportunity {
  jobId: number;
  source: string;
  company: string | null;
  title: string;
  bucket: Bucket;
  reasons: string[];
  connector: string | undefined;
  /** Link de candidatura (ou da vaga) para quem for candidatar manualmente. */
  url: string;
  flow: 'automatico' | 'assistido' | undefined;
  cvVariant: string | undefined;
  /** Barreiras do canal e avisos para quem executa a candidatura. */
  warnings: string[];
  facts: FactsWithSource;
  /** Critérios obrigatórios ainda sem dado (para medir os bloqueios). */
  missing: string[];
}

const BUCKET_OF = {
  candidatar: 'automatizavel',
  pendente_canal: 'manual',
  pendente: 'insuficiente',
  descartada: 'incompativel',
} as const;

export function classifyOpportunities(db: Db, profile: Profile, policy: Policy): Opportunity[] {
  const applied = new Set(
    (db.prepare('SELECT job_id FROM applications').all() as { job_id: number }[]).map(
      (r) => r.job_id,
    ),
  );
  const out: Opportunity[] = [];
  for (const facts of loadFacts(db, profile).values()) {
    if (applied.has(facts.id)) continue;
    const decision = decideJob(db, policy, facts);
    const tolerated = new Set<string>(policy.rules.tolerateUnknown);
    out.push({
      jobId: facts.id,
      source: facts.source,
      company: facts.company,
      title: facts.title,
      bucket: BUCKET_OF[decision.kind],
      reasons: decision.reasons,
      connector: decision.connector,
      url: facts.applyUrl ?? facts.url,
      flow: decision.flow,
      cvVariant: decision.cvVariant,
      warnings: decision.warnings ?? [],
      facts,
      missing: facts.criteria
        .filter(
          (c) => c.kind === 'obrigatorio' && c.outcome === 'indeterminado' && !tolerated.has(c.id),
        )
        .map((c) => c.id),
    });
  }
  return out;
}

export interface OpportunitySummary {
  total: number;
  buckets: Record<Bucket, number>;
  /** Eligível = automatizável + manual. */
  eligible: number;
  /** Bloqueios das vagas com informação insuficiente, por critério. */
  blockers: { id: string; count: number }[];
  /** Motivos de incompatibilidade, agrupados. */
  incompatible: { reason: string; count: number }[];
  bySource: { source: string; total: number; buckets: Record<Bucket, number> }[];
}

const zero = (): Record<Bucket, number> => ({
  automatizavel: 0,
  manual: 0,
  insuficiente: 0,
  incompativel: 0,
});

export function summarizeOpportunities(list: readonly Opportunity[]): OpportunitySummary {
  const buckets = zero();
  const blockers = new Map<string, number>();
  const incompatible = new Map<string, number>();
  const bySource = new Map<
    string,
    { source: string; total: number; buckets: Record<Bucket, number> }
  >();
  for (const item of list) {
    buckets[item.bucket]++;
    const source = bySource.get(item.source) ?? { source: item.source, total: 0, buckets: zero() };
    source.total++;
    source.buckets[item.bucket]++;
    bySource.set(item.source, source);
    if (item.bucket === 'insuficiente')
      for (const id of item.missing.length > 0 ? item.missing : ['revisão humana'])
        blockers.set(id, (blockers.get(id) ?? 0) + 1);
    if (item.bucket === 'incompativel') {
      const reason = item.reasons[0] ?? 'incompatível';
      incompatible.set(reason, (incompatible.get(reason) ?? 0) + 1);
    }
  }
  const sorted = <T extends { count: number }>(rows: T[]): T[] =>
    rows.sort((a, b) => b.count - a.count);
  return {
    total: list.length,
    buckets,
    eligible: buckets.automatizavel + buckets.manual,
    blockers: sorted([...blockers].map(([id, count]) => ({ id, count }))),
    incompatible: sorted([...incompatible].map(([reason, count]) => ({ reason, count }))),
    bySource: [...bySource.values()].sort(
      (a, b) =>
        b.buckets.automatizavel - a.buckets.automatizavel ||
        b.buckets.manual - a.buckets.manual ||
        b.total - a.total,
    ),
  };
}
