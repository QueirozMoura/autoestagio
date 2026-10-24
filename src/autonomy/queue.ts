import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { rankCandidates } from '../eligibility/ranking.js';
import { classifyOpportunities, type Opportunity } from './opportunities.js';
import type { Policy } from './policy.js';

/**
 * Fila de candidaturas: o PLANO do que o agente faz com cada vaga elegível. Não é candidatura e não autoriza envio.
 *   automatico  o agente conclui sozinho, dentro da concessão (hoje: e-mail de candidatura utilizável);
 *   assistido   exige você (login, CAPTCHA, avaliação, decisão): fica pronta, com tudo preparado, e a execução assistida
 *               para antes de qualquer etapa que dependa de você. Uma vaga assistida nunca bloqueia as demais.
 * A ordem usa as chaves transparentes do ranking (a área não pesa); o fluxo automático vem antes do assistido.
 */
export const QUEUE_STATUSES = [
  'pronta',
  'em_andamento',
  'pendente_humano',
  'concluida',
  'cancelada',
] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

const SYSTEM_CANCEL = 'deixou de ser elegível ou já tem candidatura';

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueError';
  }
}

export interface QueueItem {
  id: number;
  jobId: number;
  flow: 'automatico' | 'assistido';
  status: QueueStatus;
  priority: number;
  connector: string | null;
  cvVariant: string | null;
  salaryExpectation: number | null;
  applyUrl: string | null;
  barriers: string[];
  notes: string | null;
  evidence: string | null;
  company: string | null;
  title: string;
}

export interface QueueBuildResult {
  created: number;
  updated: number;
  cancelled: number;
  ready: { automatico: number; assistido: number };
}

/** Link sem parâmetros de rastreamento (a query e o fragmento podem conter identificadores pessoais). */
export function cleanUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

function ranked(ready: readonly Opportunity[]): Opportunity[] {
  const byFlow = (flow: 'automatico' | 'assistido'): Opportunity[] =>
    rankCandidates(
      ready
        .filter((o) => o.flow === flow)
        .map((o) => ({
          jobId: o.jobId,
          verdict: o.facts.verdict === 'inapto' ? ('revisao_humana' as const) : o.facts.verdict,
          criteria: o.facts.criteria,
          differentialsMatched: o.facts.differentialsMatched,
          differentialsTotal: o.facts.differentialsTotal,
          firstSeenAt: o.facts.firstSeenAt,
          item: o,
        })),
    ).map((r) => r.item.item);
  return [...byFlow('automatico'), ...byFlow('assistido')];
}

/**
 * Atualiza a fila a partir da classificação atual. Idempotente: não duplica (UNIQUE por vaga), preserva o andamento
 * de linhas em andamento/pendentes/concluídas e cancela, com motivo, as "prontas" que deixaram de ser elegíveis.
 */
export function buildQueue(
  db: Db,
  profile: Profile,
  policy: Policy,
  now: Date = new Date(),
): QueueBuildResult {
  const at = now.toISOString();
  const opportunities = classifyOpportunities(db, profile, policy);
  const ready = ranked(
    opportunities.filter((o) => o.bucket === 'automatizavel' || o.bucket === 'manual'),
  );
  const readyIds = new Set(ready.map((o) => o.jobId));
  const result: QueueBuildResult = {
    created: 0,
    updated: 0,
    cancelled: 0,
    ready: { automatico: 0, assistido: 0 },
  };
  db.transaction(() => {
    const existing = new Map(
      (
        db.prepare('SELECT id, job_id, status, closed_reason FROM autonomous_queue').all() as {
          id: number;
          job_id: number;
          status: QueueStatus;
          closed_reason: string | null;
        }[]
      ).map((r) => [r.job_id, r]),
    );
    ready.forEach((item, index) => {
      const flow = item.flow ?? 'assistido';
      const row = {
        job: item.jobId,
        flow,
        priority: index + 1,
        connector: item.connector ?? null,
        cv: item.cvVariant ?? null,
        salary: policy.salaryExpectation.amount,
        url: cleanUrl(item.url),
        barriers: JSON.stringify(item.warnings),
        at,
      };
      const current = existing.get(item.jobId);
      if (current === undefined) {
        db.prepare(
          `INSERT INTO autonomous_queue (job_id, flow, status, priority, connector, cv_variant, salary_expectation,
                                         apply_url, barriers, created_at, updated_at)
           VALUES (@job, @flow, 'pronta', @priority, @connector, @cv, @salary, @url, @barriers, @at, @at)`,
        ).run(row);
        result.created++;
      } else if (
        current.status === 'pronta' ||
        (current.status === 'cancelada' && current.closed_reason === SYSTEM_CANCEL)
      ) {
        db.prepare(
          `UPDATE autonomous_queue SET flow = @flow, status = 'pronta', priority = @priority, connector = @connector,
                  cv_variant = @cv, salary_expectation = @salary, apply_url = @url, barriers = @barriers,
                  closed_reason = NULL, updated_at = @at WHERE job_id = @job`,
        ).run(row);
        result.updated++;
      }
      if (
        current === undefined ||
        current.status === 'pronta' ||
        (current.status === 'cancelada' && current.closed_reason === SYSTEM_CANCEL)
      )
        result.ready[flow]++;
    });
    for (const [jobId, row] of existing) {
      if (readyIds.has(jobId) || row.status !== 'pronta') continue;
      db.prepare(
        `UPDATE autonomous_queue SET status = 'cancelada', closed_reason = ?, updated_at = ? WHERE job_id = ?`,
      ).run(SYSTEM_CANCEL, at, jobId);
      result.cancelled++;
    }
  })();
  return result;
}

interface Row {
  id: number;
  job_id: number;
  flow: 'automatico' | 'assistido';
  status: QueueStatus;
  priority: number;
  connector: string | null;
  cv_variant: string | null;
  salary_expectation: number | null;
  apply_url: string | null;
  barriers: string;
  notes: string | null;
  evidence: string | null;
  company: string | null;
  title: string;
}

export function listQueue(
  db: Db,
  filter: { flow?: 'automatico' | 'assistido'; status?: QueueStatus } = {},
): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.job_id, q.flow, q.status, q.priority, q.connector, q.cv_variant, q.salary_expectation,
              q.apply_url, q.barriers, q.notes, q.evidence, j.company, j.title
         FROM autonomous_queue q JOIN jobs j ON j.id = q.job_id
        WHERE (@flow IS NULL OR q.flow = @flow) AND (@status IS NULL OR q.status = @status)
        ORDER BY CASE q.status WHEN 'cancelada' THEN 1 WHEN 'concluida' THEN 1 ELSE 0 END,
                 CASE q.flow WHEN 'automatico' THEN 0 ELSE 1 END, q.priority`,
    )
    .all({ flow: filter.flow ?? null, status: filter.status ?? null }) as Row[];
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    flow: r.flow,
    status: r.status,
    priority: r.priority,
    connector: r.connector,
    cvVariant: r.cv_variant,
    salaryExpectation: r.salary_expectation,
    applyUrl: r.apply_url,
    barriers: JSON.parse(r.barriers) as string[],
    notes: r.notes,
    evidence: r.evidence,
    company: r.company,
    title: r.title,
  }));
}

/**
 * Atualiza o andamento de uma linha (decisão sua ou da execução assistida). Concluir exige evidência da plataforma
 * (confirmação na tela ou e-mail) e cancelar exige motivo. Uma linha concluída ou cancelada não volta sozinha.
 */
export function setQueueStatus(
  db: Db,
  id: number,
  change: { status: QueueStatus; evidence?: string; reason?: string; notes?: string },
  now: Date = new Date(),
): void {
  const row = db.prepare('SELECT status FROM autonomous_queue WHERE id = ?').get(id) as
    { status: QueueStatus } | undefined;
  if (row === undefined) throw new QueueError(`Item ${id} da fila não encontrado.`);
  if (row.status === 'concluida')
    throw new QueueError('Item já concluído: não é alterado (evita duplicidade).');
  if (change.status === 'concluida' && (change.evidence ?? '').trim() === '')
    throw new QueueError(
      'Concluir exige evidência (confirmação da plataforma ou e-mail recebido).',
    );
  if (change.status === 'cancelada' && (change.reason ?? '').trim() === '')
    throw new QueueError('Cancelar exige o motivo.');
  db.prepare(
    `UPDATE autonomous_queue SET status = @status, evidence = COALESCE(@evidence, evidence),
            closed_reason = COALESCE(@reason, closed_reason), notes = COALESCE(@notes, notes), updated_at = @at
      WHERE id = @id`,
  ).run({
    id,
    status: change.status,
    evidence: change.evidence?.trim().slice(0, 300) ?? null,
    reason: change.reason?.trim().slice(0, 300) ?? null,
    notes: change.notes?.trim().slice(0, 300) ?? null,
    at: now.toISOString(),
  });
}
