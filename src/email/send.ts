import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  annotateApplication,
  findEquivalent,
  getApplication,
  setApplicationMode,
  transitionApplication,
  type Application,
} from '../applications/index.js';
import { alreadySentEquivalent } from '../applications/equivalence.js';
import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { profileHash as hashProfile } from '../eligibility/index.js';
import { answerRequirement, computeReadiness, getDraftRecord } from '../preparation/index.js';
import type { MailTransport, SendOutcome } from './gmail.js';
import { buildMime, isValidEmail, newMessageId, toBase64Url } from './mime.js';
import { maskEmail, usableRecipient } from './recipients.js';

export class EmailError extends Error {
  constructor(
    readonly code: 'bloqueado' | 'autorizacao' | 'nao_encontrada' | 'entrada_invalida',
    message: string,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export type DispatchKind = 'real' | 'teste';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const AUTHORIZATION_TTL_MIN = 30;

/** Tudo de que o envio depende. Injetável: os testes usam um Gmail simulado e um PDF fictício. */
export interface EmailContext {
  db: Db;
  profile: Profile;
  transport: MailTransport;
  /** Trava mestra (EMAIL_SEND_ENABLED). Desligada = nenhuma chamada ao Gmail. */
  sendEnabled: boolean;
  maxPerDay: number;
  /** Sua caixa de teste (config/email.json), usada nos envios de teste. */
  testMailbox?: string | undefined;
  /** Lê o PDF aprovado AGORA. Os bytes lidos são os mesmos que seguem em anexo. */
  readCv?: () => Buffer;
  now?: () => Date;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const clock = (ctx: EmailContext): Date => (ctx.now ?? (() => new Date()))();

function defaultReadCv(profile: Profile): () => Buffer {
  return () => {
    if (profile.approval === undefined) throw new EmailError('bloqueado', 'perfil sem aprovação');
    return readFileSync(profile.approval.cvFile);
  };
}

// ------------------------------------------------------------------ verificações

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  /** Verificações que só valem para o envio de fato (ex.: trava mestra). */
  sendOnly?: boolean;
}

export interface Preflight {
  checks: Check[];
  /** Tudo certo, exceto (talvez) a trava mestra. */
  ok: boolean;
  /** Tudo certo, inclusive a trava mestra: o envio pode ser feito. */
  sendReady: boolean;
  /** Presente quando dá para montar a mensagem. */
  plan?: SendPlan;
}

interface SendPlan {
  application: Application;
  kind: DispatchKind;
  recipient: string;
  recipientId: number | null;
  subject: string;
  body: string;
  contentHash: string;
  cvBytes: Buffer;
  cvSha256: string;
  cvName: string;
  bindingHash: string;
}

/** O que uma autorização cobre: este conteúdo, este currículo e este destinatário. Nada mais. */
export function bindingHashOf(parts: {
  contentHash: string;
  cvSha256: string;
  recipient: string;
  kind: DispatchKind;
  applicationId: number;
}): string {
  return sha256(
    JSON.stringify([
      parts.applicationId,
      parts.kind,
      parts.contentHash,
      parts.cvSha256,
      parts.recipient,
    ]),
  );
}

export function preflight(ctx: EmailContext, applicationId: number, kind: DispatchKind): Preflight {
  const { db, profile } = ctx;
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, sendOnly = false): void => {
    checks.push({ id, ok, detail, ...(sendOnly ? { sendOnly } : {}) });
  };

  const application = getApplication(db, applicationId);
  if (application === undefined)
    throw new EmailError('nao_encontrada', `candidatura ${applicationId} não existe`);

  add(
    'envio_habilitado',
    ctx.sendEnabled,
    ctx.sendEnabled
      ? 'EMAIL_SEND_ENABLED=true'
      : 'EMAIL_SEND_ENABLED=false (trava mestra desligada)',
    true,
  );
  add(
    'perfil_aprovado',
    profile.approval !== undefined,
    profile.approval === undefined
      ? 'perfil sem aprovação'
      : `aprovado em ${profile.approval.approvedAt}`,
  );

  // Currículo: lido agora e conferido contra a aprovação e contra a candidatura.
  let cvBytes: Buffer | undefined;
  try {
    cvBytes = (ctx.readCv ?? defaultReadCv(profile))();
  } catch {
    cvBytes = undefined;
  }
  let cvSha = '';
  if (cvBytes === undefined) {
    add('curriculo_confere', false, 'não foi possível ler o currículo aprovado');
  } else {
    cvSha = sha256(cvBytes);
    const approved = profile.approval?.cvSha256;
    const matches = approved === cvSha && application.cvSha256 === cvSha;
    const pdf = cvBytes.subarray(0, 5).toString('latin1') === '%PDF-';
    const small = cvBytes.length > 0 && cvBytes.length <= MAX_ATTACHMENT_BYTES;
    add(
      'curriculo_confere',
      matches && pdf && small,
      !matches
        ? 'o SHA-256 do currículo no disco não é o aprovado/registrado na candidatura: envio bloqueado'
        : !pdf
          ? 'o arquivo aprovado não é um PDF'
          : !small
            ? 'o currículo passa do limite de 5 MB'
            : `SHA-256 ${cvSha.slice(0, 12)}… confere com a aprovação e com a candidatura`,
    );
  }

  // Candidatura e rascunho.
  const draft = getDraftRecord(db, applicationId);
  const currentHash = hashProfile(profile);
  const readiness = computeReadiness(db, applicationId, currentHash);
  if (kind === 'real') {
    add(
      'estado_e_modo',
      application.status === 'aprovada_para_envio' && application.mode === 'revisao',
      `estado "${application.status}", modo "${application.mode}" (exige aprovada_para_envio em modo revisao; o modo auto não existe nesta fase)`,
    );
    add('rascunho_revisado', readiness === 'revisada', `situação do rascunho: ${readiness}`);
  } else {
    add(
      'estado_e_modo',
      application.status === 'preparada' || application.status === 'aprovada_para_envio',
      `estado "${application.status}" (teste só em preparada ou aprovada_para_envio)`,
    );
    add(
      'rascunho_pronto',
      draft !== undefined && readiness !== 'desatualizada' && readiness !== 'sem_rascunho',
      `situação do rascunho: ${readiness}`,
    );
  }

  const eligibility = db
    .prepare('SELECT verdict, profile_hash FROM job_eligibility WHERE job_id = ?')
    .get(application.jobId) as { verdict: string; profile_hash: string } | undefined;
  add(
    'elegibilidade_atual',
    eligibility !== undefined &&
      eligibility.verdict !== 'inapto' &&
      eligibility.profile_hash === currentHash,
    eligibility === undefined
      ? 'sem análise de elegibilidade'
      : eligibility.verdict === 'inapto'
        ? 'vaga inapta'
        : eligibility.profile_hash === currentHash
          ? 'análise feita com o perfil atual'
          : 'análise feita com outro perfil; rode "analyze"',
  );

  // Destinatário.
  let recipient: string | undefined;
  let recipientId: number | null = null;
  if (kind === 'real') {
    const verified = usableRecipient(db, application.jobId);
    if (verified === undefined) {
      add(
        'destinatario_verificado',
        false,
        'nenhum destinatário verificado na vaga oficial ou em página oficial da empresa',
      );
    } else {
      recipient = verified.email;
      recipientId = verified.id;
      add(
        'destinatario_verificado',
        true,
        `${maskEmail(verified.email)} (fonte: ${verified.sourceKind === 'vaga_oficial' ? 'vaga oficial' : 'página oficial da empresa'})`,
      );
    }
  } else {
    const mailbox = ctx.testMailbox?.trim().toLowerCase();
    if (mailbox === undefined || !isValidEmail(mailbox)) {
      add(
        'caixa_de_teste',
        false,
        'configure sua caixa de teste em config/email.json ({"testMailbox": "..."})',
      );
    } else {
      recipient = mailbox;
      add(
        'caixa_de_teste',
        true,
        `${maskEmail(mailbox)} (sua caixa de teste; a empresa NÃO recebe nada)`,
      );
    }
  }

  // Nenhum envio real anterior (ou possível) para esta vaga nem para vagas equivalentes.
  if (kind === 'real') {
    const active = db
      .prepare(
        "SELECT COUNT(*) AS n FROM email_dispatches WHERE application_id = ? AND kind = 'real' AND status IN ('reservado','aceito','desconhecido')",
      )
      .get(applicationId) as { n: number };
    const equivalentSent = alreadySentEquivalent(findEquivalent(db, application.jobId));
    add(
      'sem_envio_anterior',
      active.n === 0 && equivalentSent === undefined,
      active.n > 0
        ? 'já existe envio real aceito, em andamento ou com resultado desconhecido: não será reenviado'
        : equivalentSent === undefined
          ? 'nenhum envio anterior'
          : `vaga equivalente já enviada (candidatura ${equivalentSent.applicationId})`,
    );

    const since = new Date(clock(ctx).getTime() - 24 * 3_600_000).toISOString();
    const today = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real' AND reserved_at >= ?",
        )
        .get(since) as { n: number }
    ).n;
    add(
      'limite_diario',
      today < ctx.maxPerDay,
      `${today} envios reais nas últimas 24 h (limite ${ctx.maxPerDay})`,
    );
  }

  // `ok`: tudo que não depende da trava mestra. `sendReady`: inclusive a trava mestra.
  const core = checks.filter((check) => check.sendOnly !== true).every((check) => check.ok);

  let plan: SendPlan | undefined;
  if (core && draft !== undefined && cvBytes !== undefined && recipient !== undefined) {
    const subject = kind === 'teste' ? `[TESTE AutoEstagio] ${draft.subject}` : draft.subject;
    const body =
      kind === 'teste'
        ? `[MENSAGEM DE TESTE do AutoEstágio: a empresa não recebeu nada.]\n\n${draft.body}`
        : draft.body;
    plan = {
      application,
      kind,
      recipient,
      recipientId,
      subject,
      body,
      contentHash: draft.contentHash,
      cvBytes,
      cvSha256: cvSha,
      cvName: basename(profile.approval?.cvFile ?? application.cvLabel),
      bindingHash: bindingHashOf({
        contentHash: draft.contentHash,
        cvSha256: cvSha,
        recipient,
        kind,
        applicationId,
      }),
    };
  }
  return {
    checks,
    ok: core,
    sendReady: core && ctx.sendEnabled,
    ...(plan === undefined ? {} : { plan }),
  };
}

/**
 * Depois de verificar um destinatário, a pendência "destinatario_verificado" do preparo está
 * resolvida. A resposta registrada é só o fato (a fonte), nunca o endereço.
 */
export function resolveRecipientRequirement(
  db: Db,
  applicationId: number,
  now: Date = new Date(),
): boolean {
  const pending = db
    .prepare(
      "SELECT 1 FROM application_requirements WHERE application_id = ? AND key = 'destinatario_verificado' AND answer IS NULL",
    )
    .get(applicationId);
  if (pending === undefined) return false;
  answerRequirement(
    db,
    applicationId,
    'destinatario_verificado',
    'destinatário verificado em fonte oficial (ver "email recipient list")',
    now,
  );
  return true;
}

// ------------------------------------------------------------------ aprovação para envio

/**
 * Decisão sua de aprovar ESTA candidatura para envio real: passa para o modo "revisao" e o estado
 * "aprovada_para_envio". Só com o rascunho revisado, destinatário verificado e currículo conferido.
 * Aprovar não envia nada: o envio ainda exige uma autorização específica e a trava mestra.
 */
export function approveForSending(
  ctx: EmailContext,
  applicationId: number,
  reason: string,
): Application {
  if (reason.trim() === '')
    throw new EmailError('entrada_invalida', 'informe o motivo da aprovação');
  const application = getApplication(ctx.db, applicationId);
  if (application === undefined)
    throw new EmailError('nao_encontrada', `candidatura ${applicationId} não existe`);
  if (application.status !== 'preparada') {
    throw new EmailError(
      'bloqueado',
      `só candidaturas "preparada" podem ser aprovadas (está "${application.status}")`,
    );
  }
  const result = preflight(ctx, applicationId, 'real');
  const failed = result.checks.filter(
    (check) => !check.ok && check.sendOnly !== true && check.id !== 'estado_e_modo',
  );
  if (failed.length > 0) {
    throw new EmailError(
      'bloqueado',
      `não dá para aprovar: verificações falhando (${failed.map((check) => check.id).join(', ')})`,
    );
  }
  const now = clock(ctx);
  return ctx.db
    .transaction((): Application => {
      setApplicationMode(
        ctx.db,
        applicationId,
        'revisao',
        { reason: `aprovação para envio: ${reason.trim()}`, actor: 'usuario' },
        now,
      );
      return transitionApplication(
        ctx.db,
        applicationId,
        {
          to: 'aprovada_para_envio',
          reason: `aprovada para envio pelo usuário: ${reason.trim()}`,
          actor: 'usuario',
          channel: 'email',
        },
        now,
      ).application;
    })
    .immediate();
}

// ------------------------------------------------------------------ dry-run

export interface DryRunReport {
  ok: boolean;
  sendReady: boolean;
  checks: Check[];
  /** Presente quando a mensagem pôde ser montada. */
  message?: {
    recipientMasked: string;
    subject: string;
    attachmentName: string;
    attachmentBytes: number;
    attachmentSha256Prefix: string;
    mimeBytes: number;
  };
}

/**
 * Ensaio completo do envio: roda todas as verificações e monta a mensagem MIME exata, mas NUNCA
 * chama o Gmail (nem precisa de token). É o comportamento padrão.
 */
export function dryRunEmail(
  ctx: EmailContext,
  applicationId: number,
  kind: DispatchKind = 'real',
): DryRunReport {
  const result = preflight(ctx, applicationId, kind);
  let message: DryRunReport['message'];
  if (result.plan !== undefined) {
    const plan = result.plan;
    const mime = buildMime({
      to: plan.recipient,
      subject: plan.subject,
      body: plan.body,
      date: clock(ctx),
      messageId: newMessageId(),
      dispatchId: 'dry-run',
      attachment: { filename: plan.cvName, bytes: plan.cvBytes, contentType: 'application/pdf' },
    });
    message = {
      recipientMasked: maskEmail(plan.recipient),
      subject: plan.subject,
      attachmentName: plan.cvName,
      attachmentBytes: plan.cvBytes.length,
      attachmentSha256Prefix: plan.cvSha256.slice(0, 12),
      mimeBytes: Buffer.byteLength(mime),
    };
  }
  annotateApplication(
    ctx.db,
    applicationId,
    {
      reason: `ensaio de envio por e-mail (${kind}) executado: ${result.ok ? 'verificações ok' : 'há verificações falhando'}; nada foi enviado`,
      actor: 'sistema',
    },
    clock(ctx),
  );
  return {
    ok: result.ok,
    sendReady: result.sendReady,
    checks: result.checks,
    ...(message === undefined ? {} : { message }),
  };
}

// ------------------------------------------------------------------ autorização

export interface Authorization {
  id: number;
  kind: DispatchKind;
  expiresAt: string;
}

/**
 * Cria a autorização explícita de UM envio (uso único, vence em 30 min), amarrada ao conteúdo, ao
 * currículo e ao destinatário atuais. Só é criada se todas as verificações (menos a trava mestra) passam.
 */
export function authorizeSend(
  ctx: EmailContext,
  applicationId: number,
  kind: DispatchKind,
  reason: string,
  ttlMinutes: number = AUTHORIZATION_TTL_MIN,
): Authorization {
  if (reason.trim() === '')
    throw new EmailError('entrada_invalida', 'informe o motivo/confirmação da autorização');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 240) {
    throw new EmailError('entrada_invalida', 'a validade deve ficar entre 1 e 240 minutos');
  }
  const result = preflight(ctx, applicationId, kind);
  if (!result.ok || result.plan === undefined) {
    const failed = result.checks
      .filter((check) => !check.ok && check.sendOnly !== true)
      .map((check) => check.id);
    throw new EmailError(
      'bloqueado',
      `não dá para autorizar: verificações falhando (${failed.join(', ')})`,
    );
  }
  const now = clock(ctx);
  const expires = new Date(now.getTime() + ttlMinutes * 60_000);
  const id = Number(
    ctx.db
      .prepare(
        'INSERT INTO email_authorizations (application_id, kind, binding_hash, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        applicationId,
        kind,
        result.plan.bindingHash,
        reason.trim().slice(0, 300),
        now.toISOString(),
        expires.toISOString(),
      ).lastInsertRowid,
  );
  annotateApplication(
    ctx.db,
    applicationId,
    {
      reason: `autorização de envio (${kind}) criada pelo usuário; vale ${ttlMinutes} min e 1 envio`,
      actor: 'usuario',
    },
    now,
  );
  return { id, kind, expiresAt: expires.toISOString() };
}

// ------------------------------------------------------------------ envio

export type SendResult =
  | { outcome: 'aceito'; dispatchId: number; gmailMessageId: string }
  | { outcome: 'rejeitado'; dispatchId: number; category: string }
  | { outcome: 'desconhecido'; dispatchId: number; category: string };

/**
 * Envia UMA mensagem, com todas as travas:
 *  1. trava mestra ligada e todas as verificações ok (inclusive o SHA-256 do currículo, lido agora);
 *  2. autorização única e específica, ainda válida e amarrada ao conteúdo atual;
 *  3. RESERVA gravada antes de chamar o Gmail (estado "enviando" + dispatch "reservado");
 *  4. chamada ao Gmail sem retentativa;
 *  5. resultado gravado: aceito → "enviada"; recusado antes de enviar → "falhou"; qualquer dúvida →
 *     "pendente de intervenção humana" (NUNCA reenvia sozinho).
 * No envio de teste a mensagem vai só para a sua caixa e o estado da candidatura não muda.
 */
export async function sendEmail(
  ctx: EmailContext,
  applicationId: number,
  authorizationId: number,
  kind: DispatchKind,
): Promise<SendResult> {
  if (!ctx.sendEnabled) {
    throw new EmailError('bloqueado', 'envio desligado: EMAIL_SEND_ENABLED=false (trava mestra)');
  }
  const result = preflight(ctx, applicationId, kind);
  if (!result.sendReady || result.plan === undefined) {
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    throw new EmailError(
      'bloqueado',
      `envio bloqueado: verificações falhando (${failed.join(', ')})`,
    );
  }
  const plan = result.plan;
  const rfcMessageId = newMessageId();
  const startedAt = clock(ctx);

  // 1) Reserva atômica: consome a autorização e grava a intenção ANTES de tocar no Gmail.
  const dispatchId = ctx.db
    .transaction((): number => {
      const authorization = ctx.db
        .prepare(
          'SELECT id, kind, binding_hash, expires_at, used_at, application_id FROM email_authorizations WHERE id = ?',
        )
        .get(authorizationId) as
        | {
            id: number;
            kind: string;
            binding_hash: string;
            expires_at: string;
            used_at: string | null;
            application_id: number;
          }
        | undefined;
      if (
        authorization === undefined ||
        authorization.application_id !== applicationId ||
        authorization.kind !== kind
      ) {
        throw new EmailError(
          'autorizacao',
          'autorização inexistente para esta candidatura/tipo de envio',
        );
      }
      if (authorization.used_at !== null)
        throw new EmailError('autorizacao', 'esta autorização já foi usada');
      if (authorization.expires_at <= startedAt.toISOString())
        throw new EmailError('autorizacao', 'a autorização venceu');
      if (authorization.binding_hash !== plan.bindingHash) {
        throw new EmailError(
          'autorizacao',
          'o conteúdo, o currículo ou o destinatário mudaram depois da autorização; autorize de novo',
        );
      }
      ctx.db
        .prepare('UPDATE email_authorizations SET used_at = ? WHERE id = ?')
        .run(startedAt.toISOString(), authorizationId);

      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO email_dispatches (application_id, kind, recipient_id, recipient_masked, status, rfc_message_id,
               cv_sha256, content_hash, authorization_id, reserved_at)
             VALUES (?, ?, ?, ?, 'reservado', ?, ?, ?, ?, ?)`,
          )
          .run(
            applicationId,
            kind,
            plan.recipientId,
            maskEmail(plan.recipient),
            rfcMessageId,
            plan.cvSha256,
            plan.contentHash,
            authorizationId,
            startedAt.toISOString(),
          ).lastInsertRowid,
      );
      if (kind === 'real') {
        transitionApplication(
          ctx.db,
          applicationId,
          {
            to: 'enviando',
            reason: `envio por e-mail reservado (envio ${id}); nenhuma retentativa automática`,
            actor: 'sistema',
            channel: 'email',
            idempotencyKey: `reserva:${id}`,
          },
          startedAt,
        );
      } else {
        annotateApplication(
          ctx.db,
          applicationId,
          {
            reason: `envio de TESTE reservado (envio ${id}) para a sua caixa de teste`,
            actor: 'sistema',
          },
          startedAt,
        );
      }
      return id;
    })
    .immediate();

  // 2) Chamada ao Gmail. Qualquer exceção significa "não sei se saiu".
  let outcome: SendOutcome;
  try {
    const mime = buildMime({
      to: plan.recipient,
      subject: plan.subject,
      body: plan.body,
      date: startedAt,
      messageId: rfcMessageId,
      dispatchId: `d${dispatchId}`,
      attachment: { filename: plan.cvName, bytes: plan.cvBytes, contentType: 'application/pdf' },
    });
    outcome = await ctx.transport.send(toBase64Url(mime));
  } catch {
    outcome = { kind: 'unknown', category: 'excecao_no_envio' };
  }

  // 3) Registro do resultado.
  const finishedAt = clock(ctx);
  ctx.db
    .transaction(() => {
      const finish = ctx.db.prepare(
        `UPDATE email_dispatches SET status = @status, gmail_message_id = @gmailId, gmail_thread_id = @threadId,
           error_category = @category, finished_at = @at WHERE id = @id`,
      );
      if (outcome.kind === 'accepted') {
        finish.run({
          id: dispatchId,
          status: 'aceito',
          gmailId: outcome.messageId,
          threadId: outcome.threadId ?? null,
          category: null,
          at: finishedAt.toISOString(),
        });
        if (kind === 'real') {
          ctx.db
            .prepare(
              "INSERT INTO application_confirmations (application_id, kind, evidence, recorded_by, created_at) VALUES (?, 'aceito_pelo_gmail', ?, 'sistema', ?)",
            )
            .run(applicationId, `gmail_message_id=${outcome.messageId}`, finishedAt.toISOString());
          transitionApplication(
            ctx.db,
            applicationId,
            {
              to: 'enviada',
              reason:
                'aceito pelo Gmail (id da mensagem registrado); entrega e recebimento ainda NÃO confirmados',
              actor: 'sistema',
              idempotencyKey: `aceito:${dispatchId}`,
            },
            finishedAt,
          );
        } else {
          annotateApplication(
            ctx.db,
            applicationId,
            { reason: `envio de TESTE aceito pelo Gmail (envio ${dispatchId})`, actor: 'sistema' },
            finishedAt,
          );
        }
      } else if (outcome.kind === 'rejected') {
        finish.run({
          id: dispatchId,
          status: 'rejeitado',
          gmailId: null,
          threadId: null,
          category: outcome.category,
          at: finishedAt.toISOString(),
        });
        if (kind === 'real') {
          transitionApplication(
            ctx.db,
            applicationId,
            {
              to: 'falhou',
              reason: `o Gmail recusou o envio antes de enviar (${outcome.category}); nada foi enviado`,
              actor: 'sistema',
              idempotencyKey: `rejeitado:${dispatchId}`,
            },
            finishedAt,
          );
        } else {
          annotateApplication(
            ctx.db,
            applicationId,
            {
              reason: `envio de TESTE recusado (${outcome.category}); nada foi enviado`,
              actor: 'sistema',
            },
            finishedAt,
          );
        }
      } else {
        finish.run({
          id: dispatchId,
          status: 'desconhecido',
          gmailId: null,
          threadId: null,
          category: outcome.category,
          at: finishedAt.toISOString(),
        });
        if (kind === 'real') {
          transitionApplication(
            ctx.db,
            applicationId,
            {
              to: 'pendente_intervencao_humana',
              reason: `resultado do envio desconhecido (${outcome.category}); NÃO reenviar; confira a pasta Enviados do Gmail`,
              actor: 'sistema',
              idempotencyKey: `desconhecido:${dispatchId}`,
            },
            finishedAt,
          );
        } else {
          annotateApplication(
            ctx.db,
            applicationId,
            {
              reason: `resultado do envio de TESTE desconhecido (${outcome.category}); confira a sua caixa`,
              actor: 'sistema',
            },
            finishedAt,
          );
        }
      }
    })
    .immediate();

  if (outcome.kind === 'accepted')
    return { outcome: 'aceito', dispatchId, gmailMessageId: outcome.messageId };
  if (outcome.kind === 'rejected')
    return { outcome: 'rejeitado', dispatchId, category: outcome.category };
  return { outcome: 'desconhecido', dispatchId, category: outcome.category };
}

// ------------------------------------------------------------------ recuperação e resolução

/**
 * Envios reservados que nunca receberam resultado (o processo caiu) viram "desconhecido" e a
 * candidatura vai para intervenção humana. Nunca reenvia.
 */
export function recoverEmailDispatches(
  db: Db,
  options: { olderThanMs: number; now?: Date },
): number[] {
  const now = options.now ?? new Date();
  const limit = new Date(now.getTime() - options.olderThanMs).toISOString();
  const stuck = db
    .prepare(
      "SELECT id, application_id, kind FROM email_dispatches WHERE status = 'reservado' AND reserved_at <= ?",
    )
    .all(limit) as { id: number; application_id: number; kind: DispatchKind }[];
  const recovered: number[] = [];
  for (const row of stuck) {
    db.transaction(() => {
      const changed = db
        .prepare(
          "UPDATE email_dispatches SET status = 'desconhecido', error_category = 'processo_interrompido', finished_at = ? WHERE id = ? AND status = 'reservado'",
        )
        .run(now.toISOString(), row.id).changes;
      if (changed !== 1) return;
      recovered.push(row.id);
      const application = getApplication(db, row.application_id);
      if (row.kind === 'real' && application?.status === 'enviando') {
        transitionApplication(
          db,
          row.application_id,
          {
            to: 'pendente_intervencao_humana',
            reason:
              'envio interrompido antes de registrar o resultado; NÃO reenviar; confira a pasta Enviados do Gmail',
            actor: 'sistema',
            idempotencyKey: `recuperacao-email:${row.id}`,
          },
          now,
        );
      } else {
        annotateApplication(
          db,
          row.application_id,
          { reason: `envio ${row.id} interrompido; resultado desconhecido`, actor: 'sistema' },
          now,
        );
      }
    }).immediate();
  }
  return recovered;
}

/** Uma pessoa resolve um envio de resultado desconhecido, depois de conferir a pasta Enviados. */
export function resolveUnknownDispatch(
  db: Db,
  applicationId: number,
  resolution:
    { sent: true; evidence: string; gmailMessageId?: string } | { sent: false; evidence: string },
  now: Date = new Date(),
): void {
  if (resolution.evidence.trim() === '')
    throw new EmailError('entrada_invalida', 'informe a evidência da conferência');
  db.transaction(() => {
    const dispatch = db
      .prepare(
        "SELECT id FROM email_dispatches WHERE application_id = ? AND kind = 'real' AND status IN ('desconhecido','reservado') ORDER BY id DESC LIMIT 1",
      )
      .get(applicationId) as { id: number } | undefined;
    if (dispatch === undefined)
      throw new EmailError(
        'nao_encontrada',
        'não há envio com resultado desconhecido para esta candidatura',
      );
    const at = now.toISOString();
    if (resolution.sent) {
      db.prepare(
        "UPDATE email_dispatches SET status = 'aceito', gmail_message_id = COALESCE(?, gmail_message_id), error_category = 'confirmado_manualmente', finished_at = ? WHERE id = ?",
      ).run(resolution.gmailMessageId ?? null, at, dispatch.id);
      db.prepare(
        "INSERT INTO application_confirmations (application_id, kind, evidence, recorded_by, created_at) VALUES (?, 'aceito_pelo_gmail', ?, 'usuario', ?)",
      ).run(applicationId, resolution.evidence.trim().slice(0, 500), at);
      transitionApplication(
        db,
        applicationId,
        {
          to: 'enviada',
          reason: 'usuário conferiu a pasta Enviados e confirmou que a mensagem saiu',
          actor: 'usuario',
          idempotencyKey: `resolvido:${dispatch.id}`,
        },
        now,
      );
    } else {
      db.prepare(
        "UPDATE email_dispatches SET status = 'rejeitado', error_category = 'confirmado_nao_enviado', finished_at = ? WHERE id = ?",
      ).run(at, dispatch.id);
      transitionApplication(
        db,
        applicationId,
        {
          to: 'falhou',
          reason: 'usuário conferiu a pasta Enviados e confirmou que a mensagem NÃO saiu',
          actor: 'usuario',
          idempotencyKey: `resolvido:${dispatch.id}`,
        },
        now,
      );
    }
  }).immediate();
}

/**
 * Confirmações que o escopo gmail.send não permite ver sozinho: a entrega (ex.: nenhuma devolução) e
 * o recebimento pela empresa (ex.: resposta dela). Sempre informadas por uma pessoa, com evidência.
 */
export function recordConfirmation(
  db: Db,
  applicationId: number,
  kind: 'entrega' | 'recebimento_empresa',
  evidence: string,
  now: Date = new Date(),
): void {
  if (evidence.trim() === '') throw new EmailError('entrada_invalida', 'informe a evidência');
  db.transaction(() => {
    const application = getApplication(db, applicationId);
    if (application === undefined)
      throw new EmailError('nao_encontrada', `candidatura ${applicationId} não existe`);
    const at = now.toISOString();
    if (kind === 'entrega') {
      transitionApplication(
        db,
        applicationId,
        {
          to: 'entrega_confirmada',
          reason: 'entrega confirmada pelo usuário',
          actor: 'usuario',
          confirmation: evidence.trim(),
        },
        now,
      );
    } else {
      if (application.status !== 'enviada' && application.status !== 'entrega_confirmada') {
        throw new EmailError(
          'bloqueado',
          'só dá para registrar o recebimento de uma candidatura enviada',
        );
      }
      annotateApplication(
        db,
        applicationId,
        { reason: 'recebimento pela empresa confirmado pelo usuário', actor: 'usuario' },
        now,
      );
    }
    db.prepare(
      'INSERT INTO application_confirmations (application_id, kind, evidence, recorded_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(applicationId, kind, evidence.trim().slice(0, 500), 'usuario', at);
  }).immediate();
}

export interface DispatchView {
  id: number;
  kind: DispatchKind;
  status: 'reservado' | 'aceito' | 'rejeitado' | 'desconhecido';
  recipientMasked: string;
  hasGmailMessageId: boolean;
  errorCategory: string | null;
  reservedAt: string;
  finishedAt: string | null;
}

export function listDispatches(
  db: Db,
  applicationId: number,
): { dispatches: DispatchView[]; confirmations: { kind: string; by: string; at: string }[] } {
  const rows = db
    .prepare('SELECT * FROM email_dispatches WHERE application_id = ? ORDER BY id')
    .all(applicationId) as {
    id: number;
    kind: DispatchKind;
    status: DispatchView['status'];
    recipient_masked: string;
    gmail_message_id: string | null;
    error_category: string | null;
    reserved_at: string;
    finished_at: string | null;
  }[];
  const confirmations = db
    .prepare(
      'SELECT kind, recorded_by, created_at FROM application_confirmations WHERE application_id = ? ORDER BY id',
    )
    .all(applicationId) as {
    kind: string;
    recorded_by: string;
    created_at: string;
  }[];
  return {
    dispatches: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      recipientMasked: row.recipient_masked,
      hasGmailMessageId: row.gmail_message_id !== null,
      errorCategory: row.error_category,
      reservedAt: row.reserved_at,
      finishedAt: row.finished_at,
    })),
    confirmations: confirmations.map((row) => ({
      kind: row.kind,
      by: row.recorded_by,
      at: row.created_at,
    })),
  };
}
