import { existsSync } from 'node:fs';
import type { CvReference, Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import type { EmailContext } from '../email/index.js';
import { analyzeJobs, profileHash } from '../eligibility/index.js';
import { listCandidates } from '../preparation/index.js';
import { attemptEmail, discoverRecipient } from './email-connector.js';
import { decideJob, type DecisionKind, type JobFacts } from './decide.js';
import { latestGrant } from './grant.js';
import { freshSummary, type FreshSummary } from './metrics.js';
import { policyHash, realAuthorization, type GrantFacts, type Policy } from './policy.js';

export type RunMode = 'simulacao' | 'real';
export type RunTrigger = 'manual' | 'timer';
export type RunStatus = 'executando' | 'concluida' | 'interrompida' | 'falhou';
export type StoredDecision =
  DecisionKind | 'ja_candidatada' | 'limite_atingido' | 'enviada' | 'envio_incerto';

export class RunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRefused';
  }
}

export interface DiscoverySummary {
  newJobs: number;
  updatedJobs: number;
  errors: string[];
}

export interface RunOptions {
  db: Db;
  profile: Profile;
  policy: Policy;
  mode: RunMode;
  trigger?: RunTrigger;
  /** Coleta de vagas (injetada). Ausente = não coleta; usa as vagas já gravadas. */
  discover?: () => Promise<DiscoverySummary>;
  /** Arquivo de parada: se existir, a execução termina com segurança. */
  stopFile?: string;
  /** Limite diário do ambiente (MAX_APPLICATIONS_PER_DAY); vale o menor entre ele e o da política. */
  envMaxPerDay?: number;
  /** Contexto do Gmail/e-mail (só necessário no modo real). */
  emailContext?: EmailContext;
  /** Currículo aprovado, já conferido contra o PDF (só no modo real). */
  cv?: CvReference;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface DecisionLine {
  jobId: number;
  company: string | null;
  title: string;
  decision: StoredDecision;
  reasons: string[];
  connector?: string | undefined;
  cvVariant?: string | undefined;
  evidence?: string | undefined;
}

export interface RunReport {
  runId: number;
  mode: RunMode;
  status: RunStatus;
  discovery: DiscoverySummary | null;
  analyzed: number;
  verdicts: Record<string, number>;
  alreadyApplied: number;
  counts: Record<string, number>;
  decisions: DecisionLine[];
  limits: { perRun: number; perDay: number; sentToday: number; effective: number };
  /** Motivos de descarte (elegibilidade e política), com contagem. */
  discards: { reason: string; count: number }[];
  /** Vagas vistas pela primeira vez NESTA execução (o que a coleta trouxe de novo). */
  fresh: FreshSummary;
  grantId: number | null;
  errors: string[];
  stopped: boolean;
  notes: string[];
}

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
  verdict: JobFacts['verdict'];
  criteria: string;
}

const REAL_DONE: readonly string[] = ['enviada', 'envio_incerto'];

function acquire(db: Db, options: RunOptions, now: Date): number {
  const ttl = options.policy.limits.lockTtlMinutes * 60_000;
  return db.transaction(() => {
    db.prepare(
      `UPDATE autonomous_runs SET status = 'interrompida', finished_at = @at
        WHERE status = 'executando' AND started_at < @cutoff`,
    ).run({ at: now.toISOString(), cutoff: new Date(now.getTime() - ttl).toISOString() });
    const busy = db.prepare("SELECT id FROM autonomous_runs WHERE status = 'executando'").get() as
      { id: number } | undefined;
    if (busy !== undefined)
      throw new RunRefused(`Já existe uma execução em andamento (#${busy.id}). Nada foi feito.`);
    return Number(
      db
        .prepare(
          `INSERT INTO autonomous_runs (mode, trigger, status, policy_hash, started_at)
           VALUES (?, ?, 'executando', ?, ?)`,
        )
        .run(
          options.mode,
          options.trigger ?? 'manual',
          policyHash(options.policy),
          now.toISOString(),
        ).lastInsertRowid,
    );
  })();
}

/**
 * Execução autônoma: coleta (opcional) → análise → candidatas em ordem transparente → decisão da política por vaga →
 * registro. No modo simulação NADA é enviado nem se cria candidatura. No modo real, só com autorização válida e
 * conector que envie; hoje nenhum conector envia, então tudo vira "pendente de canal". Duas execuções simultâneas não
 * ocorrem (trava no banco) e cada vaga recebe no máximo uma candidatura (UNIQUE no banco).
 */
export async function runAutonomous(options: RunOptions): Promise<RunReport> {
  const { db, profile, policy, mode } = options;
  const clock = options.now ?? (() => new Date());
  const notes: string[] = [];
  let grant: GrantFacts | null = null;
  if (mode === 'real') {
    const auth = realAuthorization(policy, latestGrant(db), clock());
    if (!auth.ok) throw new RunRefused(`Envio real recusado: ${auth.reason}.`);
    grant = auth.grant;
    if (options.emailContext === undefined || options.cv === undefined)
      throw new RunRefused(
        'Envio real recusado: contexto de e-mail ou currículo aprovado ausente.',
      );
  } else if (!policy.enabled) {
    notes.push('Política desligada (enabled=false): apenas simulação.');
  }
  if (options.stopFile !== undefined && existsSync(options.stopFile))
    throw new RunRefused(
      'Arquivo de parada presente: remova-o com "autonomo resume" para executar.',
    );

  const startedAt = clock();
  const runId = acquire(db, options, startedAt);
  const report: RunReport = {
    runId,
    mode,
    status: 'executando',
    discovery: null,
    analyzed: 0,
    verdicts: {},
    alreadyApplied: 0,
    counts: {},
    decisions: [],
    limits: { perRun: 0, perDay: 0, sentToday: 0, effective: 0 },
    discards: [],
    fresh: { total: 0, inIt: 0, apto: 0, pendente: 0, descartada: 0, automatable: 0 },
    grantId: grant?.id ?? null,
    errors: [],
    stopped: false,
    notes,
  };
  const stopRequested = (): boolean =>
    options.stopFile !== undefined && existsSync(options.stopFile);

  try {
    if (options.discover !== undefined) {
      try {
        report.discovery = await options.discover();
        report.errors.push(...report.discovery.errors);
      } catch (error) {
        report.errors.push(`coleta: ${(error as Error).name}`);
      }
    } else {
      notes.push('Coleta não executada (usando as vagas já gravadas).');
    }

    const analysis = analyzeJobs({ db, profile, save: true, now: clock() });
    report.analyzed = analysis.total;
    report.verdicts = { ...analysis.counts };
    report.fresh = freshSummary(db, profile, new Date(startedAt.getTime() - 1000));
    report.alreadyApplied = (
      db.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number }
    ).n;

    const today = clock().toISOString().slice(0, 10);
    const sentToday = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM autonomous_decisions
            WHERE decision IN (${REAL_DONE.map(() => '?').join(',')}) AND substr(created_at, 1, 10) = ?`,
        )
        .get(...REAL_DONE, today) as { n: number }
    ).n;
    const perDay = Math.min(
      policy.limits.maxPerDay,
      grant?.maxPerDay ?? policy.limits.maxPerDay,
      options.envMaxPerDay ?? policy.limits.maxPerDay,
    );
    const perRun = Math.min(policy.limits.maxPerRun, grant?.maxPerRun ?? policy.limits.maxPerRun);
    const effective = Math.max(0, Math.min(perRun, perDay - sentToday));
    report.limits = { perRun, perDay, sentToday, effective };

    // Candidaturas já iniciadas por esta automação e ainda não enviadas (ex.: aguardavam o intervalo) vêm primeiro.
    const resumable = (
      db
        .prepare(
          `SELECT DISTINCT a.job_id AS id FROM applications a
            WHERE a.channel = 'email' AND a.status IN ('preparada', 'aprovada_para_envio')
              AND EXISTS (SELECT 1 FROM autonomous_decisions d WHERE d.job_id = a.job_id)
              AND NOT EXISTS (SELECT 1 FROM email_dispatches e
                               WHERE e.application_id = a.id AND e.kind = 'real'
                                 AND e.status IN ('reservado', 'aceito', 'desconhecido'))
            ORDER BY a.id`,
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
    const ordered = [
      ...resumable.map((id) => ({ jobId: id })),
      ...listCandidates(db, profileHash(profile)).filter((c) => !resumable.includes(c.jobId)),
    ];
    const byId = new Map(
      (
        db
          .prepare(
            `SELECT j.id, j.title, j.company, j.work_mode, j.stipend_amount, j.description, j.url,
                    j.apply_url, s.kind AS source_kind, e.verdict, e.criteria
               FROM jobs j JOIN sources s ON s.id = j.source_id
               JOIN job_eligibility e ON e.job_id = j.id
              WHERE e.profile_hash = ?`,
          )
          .all(profileHash(profile)) as Row[]
      ).map((row) => [row.id, row]),
    );

    let accepted = 0;
    const insert = db.prepare(
      `INSERT INTO autonomous_decisions
         (run_id, job_id, decision, reasons, connector, cv_variant, salary_expectation, created_at)
       VALUES (@runId, @jobId, @decision, @reasons, @connector, @cv, @salary, @at)`,
    );
    for (const candidate of ordered) {
      if (stopRequested()) {
        report.stopped = true;
        notes.push('Parada solicitada: execução encerrada com segurança.');
        break;
      }
      const row = byId.get(candidate.jobId);
      if (row === undefined) continue;
      // Só endereço escrito na descrição oficial da vaga (um único e-mail corporativo); nada é deduzido.
      discoverRecipient(db, row.id, clock());
      const facts: JobFacts = {
        id: row.id,
        title: row.title,
        company: row.company,
        workMode: row.work_mode,
        stipend: row.stipend_amount,
        description: row.description,
        url: row.url,
        applyUrl: row.apply_url,
        sourceKind: row.source_kind,
        verdict: row.verdict,
        criteria: JSON.parse(row.criteria) as JobFacts['criteria'],
      };
      let decision: StoredDecision;
      let reasons: string[];
      let persisted = false;
      const line: DecisionLine = {
        jobId: row.id,
        company: row.company,
        title: row.title,
        decision: 'pendente',
        reasons: [],
      };
      const base = decideJob(db, policy, facts);
      decision = base.kind;
      reasons = base.reasons;
      if (decision === 'candidatar') {
        if (accepted >= effective) {
          decision = 'limite_atingido';
          reasons = [`limite de candidaturas atingido (${effective} nesta execução)`];
        } else if (mode === 'real') {
          if (base.connector !== 'email' || !policy.real.connectors.includes('email')) {
            decision = 'pendente_canal';
            reasons = ['conector sem envio automático permitido pela concessão'];
          } else {
            // Grava ANTES de tentar: se o processo cair no meio, a vaga fica como "incerta" e nunca é reenviada.
            const decisionId = Number(
              insert.run({
                runId,
                jobId: row.id,
                decision: 'envio_incerto',
                reasons: JSON.stringify(['tentativa de envio em andamento']),
                connector: 'email',
                cv: base.cvVariant ?? null,
                salary: policy.salaryExpectation.amount,
                at: clock().toISOString(),
              }).lastInsertRowid,
            );
            const attempt = await attemptEmail(
              {
                ctx: options.emailContext as EmailContext,
                profile,
                cv: options.cv as CvReference,
                grantId: grant?.id ?? 0,
                sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                now: clock,
                intervalSeconds: Math.max(
                  policy.limits.cooldownSeconds,
                  grant?.minIntervalSeconds ?? 0,
                ),
                maxWaitSeconds: 20 * 60,
              },
              row.id,
            );
            if (attempt.outcome === 'pendente') {
              decision = 'pendente';
              reasons = [attempt.reason];
              db.prepare('DELETE FROM autonomous_decisions WHERE id = ?').run(decisionId);
            } else {
              decision = attempt.outcome;
              reasons =
                attempt.outcome === 'enviada'
                  ? ['enviada pelo canal de e-mail com todos os portões']
                  : ['resultado do envio incerto: confira com "email status"; nunca é reenviada'];
              db.prepare(
                'UPDATE autonomous_decisions SET decision = ?, reasons = ?, evidence = ? WHERE id = ?',
              ).run(decision, JSON.stringify(reasons), attempt.evidence, decisionId);
              line.evidence = attempt.evidence;
              accepted++;
              report.limits.sentToday++;
              persisted = true;
            }
          }
        } else {
          accepted++;
        }
      }
      line.decision = decision;
      line.reasons = reasons;
      line.connector = base.connector;
      line.cvVariant = base.cvVariant;
      report.decisions.push(line);
      report.counts[decision] = (report.counts[decision] ?? 0) + 1;
      if (!persisted)
        insert.run({
          runId,
          jobId: row.id,
          decision,
          reasons: JSON.stringify(reasons),
          connector: base.connector ?? null,
          cv: base.cvVariant ?? null,
          salary: decision === 'candidatar' ? policy.salaryExpectation.amount : null,
          at: clock().toISOString(),
        });
    }
    const discards = new Map<string, number>();
    const bump = (reason: string): void => {
      discards.set(reason, (discards.get(reason) ?? 0) + 1);
    };
    for (const row of db
      .prepare("SELECT reasons FROM job_eligibility WHERE profile_hash = ? AND verdict = 'inapto'")
      .all(profileHash(profile)) as { reasons: string }[]) {
      const first = (JSON.parse(row.reasons) as string[])[0];
      if (first !== undefined) bump(`elegibilidade: ${first}`);
    }
    for (const decision of report.decisions)
      if (decision.decision === 'descartada' && decision.reasons[0] !== undefined)
        bump(`política: ${decision.reasons[0]}`);
    report.discards = [...discards.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((x, y) => y.count - x.count);
    report.status = report.stopped ? 'interrompida' : 'concluida';
  } catch (error) {
    report.status = 'falhou';
    report.errors.push(`execução: ${(error as Error).name}`);
  }

  db.prepare(
    "UPDATE autonomous_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ? AND status = 'executando'",
  ).run(
    report.status,
    clock().toISOString(),
    JSON.stringify({
      analyzed: report.analyzed,
      verdicts: report.verdicts,
      counts: report.counts,
      limits: report.limits,
      grantId: report.grantId,
      fresh: report.fresh,
      discards: report.discards,
      errors: report.errors,
      stopped: report.stopped,
    }),
    runId,
  );
  return report;
}

export interface RunRow {
  id: number;
  mode: RunMode;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
}

export function listRuns(db: Db, limit = 10): RunRow[] {
  return db
    .prepare(
      'SELECT id, mode, trigger, status, started_at, finished_at, summary FROM autonomous_runs ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as RunRow[];
}

export function runDecisions(db: Db, runId: number): DecisionLine[] {
  return (
    db
      .prepare(
        `SELECT d.job_id, j.company, j.title, d.decision, d.reasons, d.connector, d.cv_variant, d.evidence
           FROM autonomous_decisions d JOIN jobs j ON j.id = d.job_id
          WHERE d.run_id = ? ORDER BY d.id`,
      )
      .all(runId) as {
      job_id: number;
      company: string | null;
      title: string;
      decision: StoredDecision;
      reasons: string;
      connector: string | null;
      cv_variant: string | null;
      evidence: string | null;
    }[]
  ).map((row) => ({
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    decision: row.decision,
    reasons: JSON.parse(row.reasons) as string[],
    connector: row.connector ?? undefined,
    cvVariant: row.cv_variant ?? undefined,
    evidence: row.evidence ?? undefined,
  }));
}
