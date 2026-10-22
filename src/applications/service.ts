import type { CvReference } from '../config/cv.js';
import type { Db } from '../db/index.js';
import {
  OVERRIDABLE,
  alreadySentEquivalent,
  findEquivalent,
  type Equivalent,
  type EquivalenceReport,
} from './equivalence.js';
import {
  CHANNELS,
  MODES,
  SENT_STATES,
  STATUSES,
  TRANSITIONS,
  type Actor,
  type Channel,
  type Mode,
  type Status,
} from './states.js';

export class ApplicationError extends Error {
  constructor(
    readonly code:
      'nao_encontrada' | 'transicao_invalida' | 'guarda' | 'modo_invalido' | 'entrada_invalida',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export interface Application {
  id: number;
  jobId: number;
  mode: Mode;
  status: Status;
  channel: Channel | null;
  cvSha256: string;
  cvLabel: string;
  eligibilityVerdict: 'apto' | 'revisao_humana';
  eligibilityOverrideReason: string | null;
  profileHash: string;
  hasConfirmation: boolean;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationEvent {
  id: number;
  applicationId: number;
  fromStatus: Status | null;
  toStatus: Status;
  mode: Mode;
  channel: Channel | null;
  actor: Actor;
  reason: string;
  createdAt: string;
}

interface AppRow {
  id: number;
  job_id: number;
  mode: Mode;
  status: Status;
  channel: Channel | null;
  cv_sha256: string;
  cv_label: string;
  eligibility_verdict: 'apto' | 'revisao_humana';
  eligibility_override_reason: string | null;
  profile_hash: string;
  confirmation: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_TEXT = 500;
const clip = (value: string): string =>
  value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 3)}...` : value;

function toApplication(row: AppRow): Application {
  return {
    id: row.id,
    jobId: row.job_id,
    mode: row.mode,
    status: row.status,
    channel: row.channel,
    cvSha256: row.cv_sha256,
    cvLabel: row.cv_label,
    eligibilityVerdict: row.eligibility_verdict,
    eligibilityOverrideReason: row.eligibility_override_reason,
    profileHash: row.profile_hash,
    hasConfirmation: row.confirmation !== null && row.confirmation !== '',
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new ApplicationError('entrada_invalida', 'o motivo é obrigatório');
  return clip(trimmed);
}

function loadRow(db: Db, id: number): AppRow {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as AppRow | undefined;
  if (row === undefined)
    throw new ApplicationError('nao_encontrada', `candidatura ${id} não existe`);
  return row;
}

function insertEvent(
  db: Db,
  event: {
    applicationId: number;
    from: Status | null;
    to: Status;
    mode: Mode;
    channel: Channel | null;
    actor: Actor;
    reason: string;
    key?: string | undefined;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO application_events (
       application_id, from_status, to_status, mode, channel, actor, reason, idempotency_key, created_at
     ) VALUES (@applicationId, @from, @to, @mode, @channel, @actor, @reason, @key, @now)`,
  ).run({ ...event, key: event.key ?? null });
}

// ------------------------------------------------------------------ criação

export interface CreateInput {
  jobId: number;
  /** Versão exata do currículo (já conferida contra o perfil aprovado). */
  cv: CvReference;
  /** Hash do perfil atual: a análise de elegibilidade precisa ter sido feita com ele. */
  profileHash: string;
  channel?: Channel;
  /** Pessoa decidiu seguir com uma vaga em "revisão humana". */
  reviewOverride?: { reason: string };
  /** Pessoa aceitou que a vaga equivalente (identidade/possível duplicata) é outra vaga. */
  acknowledgeEquivalent?: { reason: string };
}

export type CreateResult =
  | { created: true; application: Application; warnings: EquivalenceReport['sameCompany'] }
  | { created: false; reason: 'ja_existe'; application: Application }
  | {
      created: false;
      reason:
        | 'vaga_inexistente'
        | 'sem_analise'
        | 'inapta'
        | 'analise_desatualizada'
        | 'revisao_sem_autorizacao';
      detail: string;
    }
  | { created: false; reason: 'vaga_equivalente'; detail: string; equivalents: Equivalent[] };

/**
 * Cria a candidatura (sempre em dry-run, status `preparada`). Atômico: duas chamadas
 * simultâneas para a mesma vaga resultam em uma só candidatura; a outra recebe `ja_existe`.
 */
export function createApplication(
  db: Db,
  input: CreateInput,
  now: Date = new Date(),
): CreateResult {
  const run = db.transaction((): CreateResult => {
    const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(input.jobId);
    if (job === undefined) {
      return {
        created: false,
        reason: 'vaga_inexistente',
        detail: `vaga ${input.jobId} não existe`,
      };
    }

    const existing = db.prepare('SELECT * FROM applications WHERE job_id = ?').get(input.jobId) as
      AppRow | undefined;
    if (existing !== undefined) {
      return { created: false, reason: 'ja_existe', application: toApplication(existing) };
    }

    const eligibility = db
      .prepare('SELECT verdict, profile_hash FROM job_eligibility WHERE job_id = ?')
      .get(input.jobId) as { verdict: string; profile_hash: string } | undefined;
    if (eligibility === undefined) {
      return {
        created: false,
        reason: 'sem_analise',
        detail: 'a vaga ainda não passou pela análise de elegibilidade',
      };
    }
    if (eligibility.verdict === 'inapto') {
      return {
        created: false,
        reason: 'inapta',
        detail: 'vaga inapta: não pode virar candidatura',
      };
    }
    if (eligibility.profile_hash !== input.profileHash) {
      return {
        created: false,
        reason: 'analise_desatualizada',
        detail: 'a análise foi feita com outro perfil; rode "analyze" de novo',
      };
    }
    let overrideReason: string | null = null;
    if (eligibility.verdict === 'revisao_humana') {
      if (input.reviewOverride === undefined) {
        return {
          created: false,
          reason: 'revisao_sem_autorizacao',
          detail: 'vaga em revisão humana: precisa da decisão explícita de uma pessoa',
        };
      }
      overrideReason = requireReason(input.reviewOverride.reason);
    }

    const equivalence = findEquivalent(db, input.jobId);
    if (equivalence.blocking.length > 0) {
      const hard = equivalence.blocking.filter((item) => !OVERRIDABLE.has(item.kind));
      const acknowledged = input.acknowledgeEquivalent !== undefined && hard.length === 0;
      if (!acknowledged) {
        return {
          created: false,
          reason: 'vaga_equivalente',
          detail:
            hard.length > 0
              ? 'já existe candidatura à mesma vaga (mesma URL ou identificador): não pode ser liberado'
              : 'já existe candidatura a uma vaga que parece a mesma: confirme explicitamente que é outra',
          equivalents: equivalence.blocking,
        };
      }
    }

    const at = now.toISOString();
    const id = Number(
      db
        .prepare(
          `INSERT INTO applications (
             job_id, mode, status, channel, cv_sha256, cv_label, eligibility_verdict,
             eligibility_override_reason, profile_hash, created_at, updated_at
           ) VALUES (@jobId, 'dry-run', 'preparada', @channel, @sha, @label, @verdict,
                     @override, @profileHash, @at, @at)`,
        )
        .run({
          jobId: input.jobId,
          channel: input.channel ?? null,
          sha: input.cv.sha256,
          label: input.cv.label,
          verdict: eligibility.verdict,
          override: overrideReason,
          profileHash: input.profileHash,
          at,
        }).lastInsertRowid,
    );
    const notes = [
      'candidatura criada em dry-run (nada é enviado)',
      overrideReason === null ? null : `revisão humana liberada: ${overrideReason}`,
      input.acknowledgeEquivalent === undefined
        ? null
        : `vaga equivalente reconhecida como outra: ${requireReason(input.acknowledgeEquivalent.reason)}`,
    ].filter((part): part is string => part !== null);
    insertEvent(db, {
      applicationId: id,
      from: null,
      to: 'preparada',
      mode: 'dry-run',
      channel: input.channel ?? null,
      actor: overrideReason === null ? 'sistema' : 'usuario',
      reason: clip(notes.join('; ')),
      now: at,
    });
    return {
      created: true,
      application: toApplication(loadRow(db, id)),
      warnings: equivalence.sameCompany,
    };
  });
  return run.immediate();
}

// ------------------------------------------------------------------ transições

export interface TransitionInput {
  to: Status;
  reason: string;
  actor?: Actor;
  channel?: Channel;
  /** Repetir a mesma operação com a mesma chave não faz nada (seguro para retentativas). */
  idempotencyKey?: string;
  /** Evidência da entrega (id de mensagem, protocolo...). Guardada, nunca exibida pela CLI. */
  confirmation?: string;
}

export interface TransitionResult {
  changed: boolean;
  application: Application;
}

function history(db: Db, applicationId: number): { ever: Set<Status> } {
  const rows = db
    .prepare('SELECT DISTINCT to_status FROM application_events WHERE application_id = ?')
    .all(applicationId) as { to_status: Status }[];
  return { ever: new Set(rows.map((row) => row.to_status)) };
}

export function transitionApplication(
  db: Db,
  applicationId: number,
  input: TransitionInput,
  now: Date = new Date(),
): TransitionResult {
  const reason = requireReason(input.reason);
  const actor: Actor = input.actor ?? 'sistema';
  if (!STATUSES.includes(input.to)) {
    throw new ApplicationError('entrada_invalida', `estado desconhecido: ${input.to}`);
  }
  if (input.channel !== undefined && !CHANNELS.includes(input.channel)) {
    throw new ApplicationError('entrada_invalida', `canal desconhecido: ${input.channel}`);
  }

  const run = db.transaction((): TransitionResult => {
    const row = loadRow(db, applicationId);

    if (input.idempotencyKey !== undefined) {
      const done = db
        .prepare(
          'SELECT 1 FROM application_events WHERE application_id = ? AND idempotency_key = ?',
        )
        .get(applicationId, input.idempotencyKey);
      if (done !== undefined) return { changed: false, application: toApplication(row) };
    }

    const from = row.status;
    if (!TRANSITIONS[from].includes(input.to)) {
      throw new ApplicationError(
        'transicao_invalida',
        `de "${from}" não se pode ir para "${input.to}"`,
      );
    }
    const { ever } = history(db, applicationId);
    const channel = input.channel ?? row.channel;

    if (input.to === 'aprovada_para_envio' && row.mode === 'dry-run') {
      throw new ApplicationError(
        'guarda',
        'em dry-run a candidatura não pode ser aprovada para envio',
      );
    }
    if (input.to === 'enviando') {
      if (row.mode === 'dry-run') {
        throw new ApplicationError('guarda', 'em dry-run nada é enviado');
      }
      if (channel === null) {
        throw new ApplicationError('guarda', 'defina o canal antes de enviar');
      }
      const sent = alreadySentEquivalent(findEquivalent(db, row.job_id));
      if (sent !== undefined) {
        throw new ApplicationError(
          'guarda',
          `candidatura equivalente já enviada (candidatura ${sent.applicationId}); envio bloqueado`,
        );
      }
    }
    if (input.to === 'preparada' && (from === 'falhou' || from === 'pendente_intervencao_humana')) {
      if (ever.has('enviada') || ever.has('entrega_confirmada')) {
        throw new ApplicationError('guarda', 'já foi enviada: não pode voltar a "preparada"');
      }
      if (ever.has('enviando') && actor !== 'usuario') {
        throw new ApplicationError(
          'guarda',
          'houve tentativa de envio: só uma pessoa pode refazer o preparo',
        );
      }
    }
    if (from === 'pendente_intervencao_humana' && input.to !== 'preparada' && actor !== 'usuario') {
      throw new ApplicationError(
        'guarda',
        'só uma pessoa resolve uma pendência de intervenção humana',
      );
    }
    if (input.to === 'entrega_confirmada' && (input.confirmation ?? '').trim() === '') {
      throw new ApplicationError('guarda', 'entrega confirmada exige a evidência da confirmação');
    }

    const at = now.toISOString();
    const changed = db
      .prepare(
        `UPDATE applications SET
           status = @to,
           channel = COALESCE(@channel, channel),
           confirmation = COALESCE(@confirmation, confirmation),
           applied_at = CASE WHEN @to = 'enviada' THEN COALESCE(applied_at, @at) ELSE applied_at END,
           updated_at = @at
         WHERE id = @id AND status = @from`,
      )
      .run({
        id: applicationId,
        from,
        to: input.to,
        channel: input.channel ?? null,
        confirmation: input.confirmation === undefined ? null : clip(input.confirmation),
        at,
      }).changes;
    if (changed !== 1) {
      throw new ApplicationError(
        'transicao_invalida',
        'o estado mudou durante a operação; tente de novo',
      );
    }
    insertEvent(db, {
      applicationId,
      from,
      to: input.to,
      mode: row.mode,
      channel,
      actor,
      reason,
      key: input.idempotencyKey,
      now: at,
    });
    return { changed: true, application: toApplication(loadRow(db, applicationId)) };
  });
  return run.immediate();
}

// ------------------------------------------------------------------ modo

export function setApplicationMode(
  db: Db,
  applicationId: number,
  mode: Mode,
  options: { reason: string; actor: Actor; authorizeAuto?: boolean },
  now: Date = new Date(),
): Application {
  const reason = requireReason(options.reason);
  if (!MODES.includes(mode))
    throw new ApplicationError('modo_invalido', `modo desconhecido: ${mode}`);
  if (options.actor !== 'usuario') {
    throw new ApplicationError('guarda', 'só uma pessoa pode mudar o modo de uma candidatura');
  }
  if (mode === 'auto' && options.authorizeAuto !== true) {
    throw new ApplicationError('guarda', 'o modo auto exige autorização explícita do usuário');
  }

  const run = db.transaction((): Application => {
    const row = loadRow(db, applicationId);
    if (SENT_STATES.has(row.status)) {
      throw new ApplicationError('guarda', 'candidatura em envio ou já enviada: o modo não muda');
    }
    if (row.mode === mode) return toApplication(row);
    const at = now.toISOString();
    // Voltar para dry-run cancela uma aprovação de envio.
    const nextStatus: Status =
      mode === 'dry-run' && row.status === 'aprovada_para_envio' ? 'preparada' : row.status;
    db.prepare(
      'UPDATE applications SET mode = @mode, status = @status, updated_at = @at WHERE id = @id',
    ).run({
      id: applicationId,
      mode,
      status: nextStatus,
      at,
    });
    insertEvent(db, {
      applicationId,
      from: row.status,
      to: nextStatus,
      mode,
      channel: row.channel,
      actor: options.actor,
      reason: clip(`modo ${row.mode} → ${mode}: ${reason}`),
      now: at,
    });
    return toApplication(loadRow(db, applicationId));
  });
  return run.immediate();
}

// ------------------------------------------------------------------ recuperação

/**
 * Candidaturas presas em `enviando` (o processo caiu no meio do envio) vão para intervenção
 * humana. Nunca são reenviadas sozinhas: não há como saber se a mensagem saiu.
 */
export function recoverInterrupted(db: Db, options: { olderThanMs: number; now?: Date }): number[] {
  const now = options.now ?? new Date();
  const limit = new Date(now.getTime() - options.olderThanMs).toISOString();
  const stuck = db
    .prepare("SELECT id FROM applications WHERE status = 'enviando' AND updated_at <= ?")
    .all(limit) as { id: number }[];
  const recovered: number[] = [];
  for (const { id } of stuck) {
    const result = transitionApplication(
      db,
      id,
      {
        to: 'pendente_intervencao_humana',
        reason: 'envio interrompido antes de registrar o resultado; verifique se foi enviado',
        actor: 'sistema',
        idempotencyKey: `recuperacao:${limit.slice(0, 10)}:${id}`,
      },
      now,
    );
    if (result.changed) recovered.push(id);
  }
  return recovered;
}

// ------------------------------------------------------------------ consultas

export interface ApplicationSummary extends Application {
  title: string;
  company: string | null;
  jobUrl: string;
}

export function getApplication(db: Db, id: number): Application | undefined {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as AppRow | undefined;
  return row === undefined ? undefined : toApplication(row);
}

export function listApplications(
  db: Db,
  options: { status?: Status; limit?: number } = {},
): ApplicationSummary[] {
  const rows = db
    .prepare(
      `SELECT a.*, j.title AS title, j.company AS company, j.url AS job_url
         FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE (@status IS NULL OR a.status = @status)
        ORDER BY a.id DESC LIMIT @limit`,
    )
    .all({ status: options.status ?? null, limit: options.limit ?? 100 }) as (AppRow & {
    title: string;
    company: string | null;
    job_url: string;
  })[];
  return rows.map((row) => ({
    ...toApplication(row),
    title: row.title,
    company: row.company,
    jobUrl: row.job_url,
  }));
}

export function getHistory(db: Db, applicationId: number): ApplicationEvent[] {
  const rows = db
    .prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id')
    .all(applicationId) as {
    id: number;
    application_id: number;
    from_status: Status | null;
    to_status: Status;
    mode: Mode;
    channel: Channel | null;
    actor: Actor;
    reason: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    applicationId: row.application_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    mode: row.mode,
    channel: row.channel,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export function countByStatus(db: Db): Record<Status, number> {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')
    .all() as {
    status: Status;
    n: number;
  }[];
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}
