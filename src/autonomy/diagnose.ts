import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { profileHash, type Criterion } from '../eligibility/index.js';

/**
 * Por que as vagas não são "aptas": separa FALTA DE DADOS (critério obrigatório indeterminado) de INCOMPATIBILIDADE
 * REAL (critério obrigatório reprovado). Somente leitura; nada é relaxado nem presumido. A pergunta "e se bolsa
 * desconhecida fosse tolerada?" é só uma simulação para a decisão ser sua.
 */
export type JobClass = 'apta' | 'incompativel' | 'dados_ausentes';

export interface Blocker {
  id: string;
  outcome: 'nao_atende' | 'indeterminado';
  detail: string;
}

export interface JobDiagnosis {
  jobId: number;
  company: string | null;
  title: string;
  verdict: string;
  class: JobClass;
  blockers: Blocker[];
}

export interface Diagnosis {
  total: number;
  byClass: Record<JobClass, number>;
  /** Quantas vagas têm cada critério obrigatório reprovado / sem dados. */
  byCriterion: Record<string, { nao_atende: number; indeterminado: number }>;
  /** Vagas só com dados ausentes, agrupadas pelo conjunto exato do que falta. */
  missingSets: { missing: string[]; jobs: number }[];
  /** Quantas vagas seriam aptas se os critérios listados fossem tolerados quando desconhecidos. */
  whatIf: { tolerate: string[]; wouldBeApto: number }[];
  jobs: JobDiagnosis[];
}

interface Row {
  job_id: number;
  company: string | null;
  title: string;
  verdict: string;
  criteria: string;
}

export function diagnose(db: Db, profile: Profile): Diagnosis {
  const rows = db
    .prepare(
      `SELECT e.job_id, j.company, j.title, e.verdict, e.criteria
         FROM job_eligibility e JOIN jobs j ON j.id = e.job_id
        WHERE e.profile_hash = ? ORDER BY e.job_id`,
    )
    .all(profileHash(profile)) as Row[];

  const jobs: JobDiagnosis[] = rows.map((row) => {
    const criteria = JSON.parse(row.criteria) as Criterion[];
    const blockers: Blocker[] = criteria
      .filter((c) => c.kind === 'obrigatorio' && c.outcome !== 'atende')
      .map((c) => ({
        id: c.id,
        outcome: c.outcome === 'nao_atende' ? 'nao_atende' : 'indeterminado',
        detail: c.detail,
      }));
    const klass: JobClass = blockers.some((b) => b.outcome === 'nao_atende')
      ? 'incompativel'
      : blockers.length > 0
        ? 'dados_ausentes'
        : 'apta';
    return {
      jobId: row.job_id,
      company: row.company,
      title: row.title,
      verdict: row.verdict,
      class: klass,
      blockers,
    };
  });

  const byClass: Record<JobClass, number> = { apta: 0, incompativel: 0, dados_ausentes: 0 };
  const byCriterion: Diagnosis['byCriterion'] = {};
  const sets = new Map<string, { missing: string[]; jobs: number }>();
  for (const job of jobs) {
    byClass[job.class]++;
    for (const blocker of job.blockers) {
      const entry = (byCriterion[blocker.id] ??= { nao_atende: 0, indeterminado: 0 });
      entry[blocker.outcome]++;
    }
    if (job.class === 'dados_ausentes') {
      const missing = job.blockers.map((b) => b.id).sort();
      const key = missing.join('+');
      const set = sets.get(key) ?? { missing, jobs: 0 };
      set.jobs++;
      sets.set(key, set);
    }
  }
  const missingOnly = (job: JobDiagnosis, allowed: readonly string[]): boolean =>
    job.class === 'dados_ausentes' && job.blockers.every((b) => allowed.includes(b.id));
  return {
    total: jobs.length,
    byClass,
    byCriterion,
    missingSets: [...sets.values()].sort((a, b) => b.jobs - a.jobs),
    whatIf: [
      {
        tolerate: ['bolsa'],
        wouldBeApto: byClass.apta + jobs.filter((j) => missingOnly(j, ['bolsa'])).length,
      },
    ],
    jobs,
  };
}

/**
 * Causa das pendências de área, modalidade e bolsa: o anúncio é genérico (nada a extrair) ou há menção que o extrator
 * deliberadamente não trata como regra da vaga (para você conferir se vale ampliar o extrator). Somente leitura.
 */
export interface ExtractionCause {
  criterion: 'area' | 'modalidade' | 'bolsa';
  pending: number;
  /** Nenhuma menção no texto: o anúncio não informa. */
  generic: number;
  /** Há menção, mas não declarativa/numérica (condicional, genérica, só a categoria); o extrator não presume. */
  mentioned: number;
  samples: { jobId: number; snippet: string }[];
}

const MENTION: Record<ExtractionCause['criterion'], RegExp> = {
  modalidade:
    /(h[ií]brid\w*|presencial\w*|remot[oa]s?|home ?office|on-?site|hybrid|escrit[oó]rio)/i,
  bolsa: /(bolsa|R\$\s?\d|sal[aá]rio|remunera[cç][aã]o|stipend|compensation)/i,
  area: /(tecnologia|\bTI\b|software|dados|data|desenvolvimento|sistemas|infraestrutura|seguran[cç]a da informa)/i,
};

export function extractionCauses(db: Db, profile: Profile): ExtractionCause[] {
  const rows = db
    .prepare(
      `SELECT e.job_id, j.description, e.criteria
         FROM job_eligibility e JOIN jobs j ON j.id = e.job_id
        WHERE e.profile_hash = ? AND e.verdict = 'revisao_humana'`,
    )
    .all(profileHash(profile)) as {
    job_id: number;
    description: string | null;
    criteria: string;
  }[];
  const out: ExtractionCause[] = (['area', 'modalidade', 'bolsa'] as const).map((criterion) => ({
    criterion,
    pending: 0,
    generic: 0,
    mentioned: 0,
    samples: [],
  }));
  for (const row of rows) {
    const criteria = JSON.parse(row.criteria) as Criterion[];
    const text = (row.description ?? '').replace(/\s+/g, ' ');
    for (const cause of out) {
      const criterion = criteria.find((c) => c.id === cause.criterion);
      if (criterion?.outcome !== 'indeterminado') continue;
      cause.pending++;
      const match = MENTION[cause.criterion].exec(text);
      if (match === null) cause.generic++;
      else {
        cause.mentioned++;
        if (cause.samples.length < 3)
          cause.samples.push({
            jobId: row.job_id,
            snippet: text.slice(Math.max(0, match.index - 50), match.index + 70),
          });
      }
    }
  }
  return out;
}
