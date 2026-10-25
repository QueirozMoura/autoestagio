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
import { classifyAttachment, type ResolvedAttachment } from '../cv/attachments.js';
import type { Db } from '../db/index.js';
import { profileHash as hashProfile } from '../eligibility/index.js';
import { answerRequirement, computeReadiness, getDraftRecord } from '../preparation/index.js';
import type { MailTransport, SendOutcome } from './gmail.js';
import { buildMime, isValidEmail, newMessageId, toBase64Url } from './mime.js';
import { maskEmail, normalizeRecipient, usableRecipient } from './recipients.js';

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
/** Intervalo mínimo entre envios reais (qualquer candidatura). */
export const MIN_INTERVAL_MIN = 15;
/** Janela em que o mesmo destinatário não pode receber de candidaturas diferentes. */
export const REPEAT_RECIPIENT_DAYS = 30;

/**
 * Código de confirmação de 8 caracteres exibido por `email preview-final`. Deriva do bindingHash do envio REAL
 * (candidatura, conteúdo, anexo/vínculo e destinatário), sem expô-lo. Não substitui a autorização de uso único.
 */
export const confirmationCode = (bindingHash: string): string =>
  createHash('sha256').update(`confirmacao-envio-v1|${bindingHash}`).digest('hex').slice(0, 8);

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
  /**
   * Anexo personalizado já resolvido (geração estrita em memória; ver `resolveApprovedAttachment`).
   * Obrigatório quando a candidatura tem vínculo de currículo aprovado; o preflight confere tudo
   * contra o banco e recalcula o SHA-256 dos bytes. Sem vínculo, é ignorado.
   */
  attachment?: ResolvedAttachment | undefined;
  now?: () => Date;
  /** Só para testes de concorrência: executa logo antes da reserva atômica do envio. */
  beforeReserve?: () => void | Promise<void>;
  /** Revalida concessão, manifesto e parada antes da reserva; não produz efeitos externos. */
  automationGuard?: () => string | null;
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
  /**
   * Portões de autorização/envio (teste prévio, intervalo, destinatário repetido): não impedem montar a mensagem,
   * aprovar ou exportar, mas bloqueiam `authorize` e `send` (envio real).
   */
  gate?: boolean;
}

export interface Preflight {
  checks: Check[];
  /** Tudo certo, exceto (talvez) a trava mestra e os portões de envio. */
  ok: boolean;
  /** Portões de envio real (teste prévio, intervalo, destinatário repetido) satisfeitos. */
  gatesOk: boolean;
  /** `ok` e portões satisfeitos: uma autorização pode ser criada. */
  authorizable: boolean;
  /** Tudo certo, inclusive portões e trava mestra: o envio pode ser feito. */
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
  /** No teste: o bindingHash do envio REAL equivalente (evidência persistida). */
  intendedBindingHash?: string;
  /** `mestre`: candidatura sem vínculo; `personalizado`: vínculo de currículo aprovado. */
  attachmentSource: 'mestre' | 'personalizado';
  attachmentVariant: string | null;
  bindingHash: string;
}

/**
 * O que uma autorização cobre: este conteúdo, este currículo e este destinatário. Nada mais.
 * Com anexo personalizado, a identidade do vínculo aprovado (id, variante, PDF e modelo) também entra:
 * trocar ou revogar o vínculo invalida autorizações antigas. Sem `attachment` (currículo mestre) o
 * formato é EXATAMENTE o anterior, então autorizações já emitidas para o mestre continuam coerentes.
 */
export function bindingHashOf(parts: {
  contentHash: string;
  cvSha256: string;
  recipient: string;
  kind: DispatchKind;
  applicationId: number;
  attachment?: { linkId: number; variant: string; pdfSha256: string; modelHash: string };
}): string {
  const base = [
    parts.applicationId,
    parts.kind,
    parts.contentHash,
    parts.cvSha256,
    parts.recipient,
  ];
  return sha256(
    JSON.stringify(
      parts.attachment === undefined
        ? base
        : [
            ...base,
            'anexo-aprovado',
            parts.attachment.linkId,
            parts.attachment.variant,
            parts.attachment.pdfSha256,
            parts.attachment.modelHash,
          ],
    ),
  );
}

/** Validade da evidência de teste. */
export const TEST_EVIDENCE_MAX_HOURS = 24;
/** Tolerância a relógio adiantado entre processos/ajustes de hora; além disso a evidência é tratada como inválida. */
export const TEST_EVIDENCE_FUTURE_TOLERANCE_MIN = 2;

interface RealLimitsInput {
  db: Db;
  now: Date;
  applicationId: number;
  jobId: number;
  recipient: string | undefined;
  realBinding: string | undefined;
  maxPerDay: number;
}

/**
 * Limites e portões do envio REAL. Usada no preflight E, dentro da transação imediata, na reserva do envio:
 * duas execuções simultâneas não passam juntas por limites globais ou de destinatário, pois a reserva
 * (BEGIN IMMEDIATE) serializa os escritores e a segunda enxerga a primeira já gravada. Só leitura.
 */
function evaluateRealLimits(input: RealLimitsInput): Check[] {
  const { db, now, applicationId, jobId, recipient, realBinding, maxPerDay } = input;
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, gate = false): void => {
    checks.push({ id, ok, detail, ...(gate ? { gate: true } : {}) });
  };

  // Nenhum envio real anterior (ou possível) para esta vaga nem para vagas equivalentes.
  const active = db
    .prepare(
      "SELECT COUNT(*) AS n FROM email_dispatches WHERE application_id = ? AND kind = 'real' AND status IN ('reservado','aceito','desconhecido')",
    )
    .get(applicationId) as { n: number };
  const equivalentSent = alreadySentEquivalent(findEquivalent(db, jobId));
  add(
    'sem_envio_anterior',
    active.n === 0 && equivalentSent === undefined,
    active.n > 0
      ? 'já existe envio real aceito, em andamento ou com resultado desconhecido: não será reenviado'
      : equivalentSent === undefined
        ? 'nenhum envio anterior'
        : `vaga equivalente já enviada (candidatura ${equivalentSent.applicationId})`,
  );

  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const today = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real' AND reserved_at >= ?",
      )
      .get(since) as { n: number }
  ).n;
  add(
    'limite_diario',
    today < maxPerDay,
    `${today} envios reais nas últimas 24 h (limite ${maxPerDay})`,
  );

  // Teste prévio: aceito, para exatamente este envio real, e com até 24 h (horário persistido do despacho).
  const rows =
    realBinding === undefined
      ? []
      : (db
          .prepare(
            "SELECT COALESCE(finished_at, reserved_at) AS at FROM email_dispatches WHERE application_id = ? AND kind = 'teste' AND status = 'aceito' AND intended_binding_hash = ?",
          )
          .all(applicationId, realBinding) as { at: string }[]);
  let fresh = false;
  let expired = false;
  let invalid = false;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) invalid = true;
    else if (at - now.getTime() > TEST_EVIDENCE_FUTURE_TOLERANCE_MIN * 60_000) invalid = true;
    else if (now.getTime() - at > TEST_EVIDENCE_MAX_HOURS * 3_600_000) expired = true;
    else fresh = true;
  }
  add(
    'teste_previo',
    fresh,
    fresh
      ? `há um envio de teste aceito, de até ${TEST_EVIDENCE_MAX_HOURS} h, para exatamente este conteúdo, anexo e destinatário`
      : rows.length === 0
        ? 'nenhum envio de teste aceito corresponde ao conteúdo, ao anexo e ao destinatário atuais (dry-run e .eml não contam): faça "email authorize --test" e "email send --test"'
        : invalid && !expired
          ? 'o teste correspondente tem horário inválido ou no futuro: refaça o envio de teste'
          : `o teste correspondente tem mais de ${TEST_EVIDENCE_MAX_HOURS} h: refaça o envio de teste`,
    true,
  );

  const intervalStart = new Date(now.getTime() - MIN_INTERVAL_MIN * 60_000).toISOString();
  const recent = db
    .prepare(
      "SELECT MAX(reserved_at) AS last FROM email_dispatches WHERE kind = 'real' AND status IN ('reservado', 'aceito', 'desconhecido') AND reserved_at > ?",
    )
    .get(intervalStart) as { last: string | null };
  add(
    'intervalo_minimo',
    recent.last === null,
    recent.last === null
      ? `nenhum envio real nos últimos ${MIN_INTERVAL_MIN} min`
      : `houve um envio real (ou de resultado incerto) há menos de ${MIN_INTERVAL_MIN} min; aguarde`,
    true,
  );

  const repeatStart = new Date(
    now.getTime() - REPEAT_RECIPIENT_DAYS * 24 * 3_600_000,
  ).toISOString();
  const previous =
    recipient === undefined
      ? []
      : (
          db
            .prepare(
              `SELECT v.email AS email FROM email_dispatches d JOIN verified_recipients v ON v.id = d.recipient_id
                WHERE d.kind = 'real' AND d.status IN ('reservado', 'aceito', 'desconhecido')
                  AND d.application_id <> ? AND d.reserved_at > ?`,
            )
            .all(applicationId, repeatStart) as { email: string }[]
        ).filter((row) => normalizeRecipient(row.email) === normalizeRecipient(recipient));
  add(
    'destinatario_repetido',
    previous.length === 0,
    previous.length === 0
      ? `este destinatário não recebeu envio real de outra candidatura nos últimos ${REPEAT_RECIPIENT_DAYS} dias`
      : `este destinatário já recebeu (ou pode ter recebido) um envio real de outra candidatura nos últimos ${REPEAT_RECIPIENT_DAYS} dias`,
    true,
  );
  return checks;
}

export function preflight(ctx: EmailContext, applicationId: number, kind: DispatchKind): Preflight {
  const { db, profile } = ctx;
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, flag?: 'sendOnly' | 'gate'): void => {
    checks.push({
      id,
      ok,
      detail,
      ...(flag === 'sendOnly' ? { sendOnly: true } : {}),
      ...(flag === 'gate' ? { gate: true } : {}),
    });
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
    'sendOnly',
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

  // Anexo efetivo: mestre (candidatura sem vínculo) ou o vínculo APROVADO. Com histórico de vínculo
  // sem aprovação utilizável, nunca há fallback para o mestre.
  let attached:
    | {
        bytes: Buffer;
        sha: string;
        name: string;
        source: 'mestre' | 'personalizado';
        variant: string | null;
        binding?: { linkId: number; variant: string; pdfSha256: string; modelHash: string };
      }
    | undefined;
  const classification = classifyAttachment(db, applicationId);
  if (classification.kind === 'mestre') {
    if (cvBytes !== undefined)
      attached = {
        bytes: cvBytes,
        sha: cvSha,
        name: basename(profile.approval?.cvFile ?? application.cvLabel),
        source: 'mestre',
        variant: null,
      };
    add(
      'anexo_selecionado',
      true,
      'currículo mestre aprovado (candidatura sem vínculo de currículo)',
    );
  } else if (classification.kind === 'bloqueado') {
    add(
      'vinculo_curriculo',
      false,
      `há histórico de vínculo de currículo sem vínculo aprovado utilizável (${[...new Set(classification.states)].join(', ')}); o currículo mestre NÃO é usado como substituto: resolva explicitamente`,
    );
  } else {
    const link = classification.link;
    const resolved = ctx.attachment;
    const identity =
      resolved !== undefined &&
      resolved.applicationId === applicationId &&
      link.applicationId === applicationId &&
      resolved.jobId === application.jobId &&
      link.jobId === application.jobId &&
      resolved.linkId === link.id &&
      resolved.variant === link.variant &&
      resolved.modelHash === link.modelHash &&
      resolved.pdfSha256 === link.pdfSha256 &&
      resolved.fileName === link.fileName;
    add(
      'vinculo_curriculo',
      identity,
      resolved === undefined
        ? 'há vínculo de currículo aprovado, mas o anexo não foi resolvido pela geração estrita (informe a âncora com --ancora-sha256)'
        : identity
          ? `vínculo #${link.id} aprovado (variante ${link.variant}) corresponde a esta candidatura, a esta vaga e ao modelo aprovado`
          : 'o anexo resolvido não corresponde ao vínculo aprovado (candidatura, vaga, variante, modelo ou PDF): envio bloqueado',
    );
    if (resolved !== undefined && identity) {
      const actual = sha256(resolved.bytes);
      const intact =
        actual === link.pdfSha256 &&
        resolved.bytes.subarray(0, 5).toString('latin1') === '%PDF-' &&
        resolved.bytes.length > 0 &&
        resolved.bytes.length <= MAX_ATTACHMENT_BYTES;
      add(
        'anexo_integro',
        intact,
        intact
          ? `SHA-256 ${actual.slice(0, 12)}… do anexo personalizado confere com o artefato aprovado`
          : 'os bytes do anexo personalizado não conferem com o artefato aprovado (hash, formato ou limite de 5 MB)',
      );
      if (intact)
        attached = {
          bytes: resolved.bytes,
          sha: actual,
          name: link.fileName,
          source: 'personalizado',
          variant: link.variant,
          binding: {
            linkId: link.id,
            variant: link.variant,
            pdfSha256: link.pdfSha256,
            modelHash: link.modelHash,
          },
        };
    }
  }

  // Candidatura e rascunho.
  const draft = getDraftRecord(db, applicationId);
  /** bindingHash que o envio do tipo `forKind` teria para o destinatário `to` (anexo e conteúdo atuais). */
  const bindingFor = (forKind: DispatchKind, to: string): string | undefined =>
    draft === undefined || attached === undefined
      ? undefined
      : bindingHashOf({
          contentHash: draft.contentHash,
          cvSha256: attached.sha,
          recipient: to,
          kind: forKind,
          applicationId,
          ...(attached.binding === undefined ? {} : { attachment: attached.binding }),
        });
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

  // Limites e portões do envio real: as MESMAS regras são reavaliadas, de forma atômica, na reserva do envio.
  if (kind === 'real') {
    for (const check of evaluateRealLimits({
      db,
      now: clock(ctx),
      applicationId,
      jobId: application.jobId,
      recipient,
      realBinding: recipient === undefined ? undefined : bindingFor('real', recipient),
      maxPerDay: ctx.maxPerDay,
    }))
      checks.push(check);
  }

  // `ok`: tudo que não depende da trava mestra. `sendReady`: inclusive a trava mestra.
  const core = checks
    .filter((check) => check.sendOnly !== true && check.gate !== true)
    .every((check) => check.ok);
  const gatesOk = checks.filter((check) => check.gate === true).every((check) => check.ok);

  let plan: SendPlan | undefined;
  if (core && draft !== undefined && attached !== undefined && recipient !== undefined) {
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
      cvBytes: attached.bytes,
      cvSha256: attached.sha,
      cvName: attached.name,
      attachmentSource: attached.source,
      attachmentVariant: attached.variant,
      ...(kind === 'teste'
        ? (() => {
            const intended = usableRecipient(db, application.jobId);
            const hash = intended === undefined ? undefined : bindingFor('real', intended.email);
            return hash === undefined ? {} : { intendedBindingHash: hash };
          })()
        : {}),
      bindingHash: bindingHashOf({
        contentHash: draft.contentHash,
        cvSha256: attached.sha,
        recipient,
        kind,
        applicationId,
        ...(attached.binding === undefined ? {} : { attachment: attached.binding }),
      }),
    };
  }
  return {
    checks,
    ok: core,
    gatesOk,
    authorizable: core && gatesOk,
    sendReady: core && gatesOk && ctx.sendEnabled,
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
    (check) =>
      !check.ok && check.sendOnly !== true && check.gate !== true && check.id !== 'estado_e_modo',
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
    /** `mestre` ou `personalizado` (vínculo aprovado). */
    attachmentSource: 'mestre' | 'personalizado';
    attachmentVariant: string | null;
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
      attachmentSource: plan.attachmentSource,
      attachmentVariant: plan.attachmentVariant,
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
  confirmation?: string,
): Authorization {
  if (reason.trim() === '')
    throw new EmailError('entrada_invalida', 'informe o motivo/confirmação da autorização');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 240) {
    throw new EmailError('entrada_invalida', 'a validade deve ficar entre 1 e 240 minutos');
  }
  const result = preflight(ctx, applicationId, kind);
  if (!result.authorizable || result.plan === undefined) {
    const failed = result.checks
      .filter((check) => !check.ok && check.sendOnly !== true)
      .map((check) => check.id);
    throw new EmailError(
      'bloqueado',
      `não dá para autorizar: verificações falhando (${failed.join(', ')})`,
    );
  }
  // Envio real: o código de "email preview-final" precisa corresponder ao conteúdo ATUAL
  // (destinatário, corpo, anexo e vínculo). Não substitui a autorização de uso único nem as demais travas.
  if (
    kind === 'real' &&
    (confirmation === undefined ||
      confirmation.trim().toLowerCase() !== confirmationCode(result.plan.bindingHash))
  ) {
    throw new EmailError(
      'autorizacao',
      'código de confirmação ausente ou diferente do conteúdo atual; rode "email preview-final" e confira a mensagem',
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

  await ctx.beforeReserve?.();
  const guardFailure = ctx.automationGuard?.();
  if (guardFailure) throw new EmailError('autorizacao', guardFailure);
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
      // Revalidação ATÓMICA dos limites e portões do envio real: o preflight acima pode estar defasado se outra
      // execução reservou um envio nesse meio-tempo. Esta transação já detém o lock de escrita do SQLite.
      if (kind === 'real') {
        const failed = evaluateRealLimits({
          db: ctx.db,
          now: startedAt,
          applicationId,
          jobId: plan.application.jobId,
          recipient: plan.recipient,
          realBinding: plan.bindingHash,
          maxPerDay: ctx.maxPerDay,
        })
          .filter((check) => !check.ok)
          .map((check) => check.id);
        if (failed.length > 0)
          throw new EmailError(
            'bloqueado',
            `envio bloqueado na reserva: verificações falhando (${failed.join(', ')})`,
          );
      }
      ctx.db
        .prepare('UPDATE email_authorizations SET used_at = ? WHERE id = ?')
        .run(startedAt.toISOString(), authorizationId);

      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO email_dispatches (application_id, kind, recipient_id, recipient_masked, status, rfc_message_id,
               cv_sha256, content_hash, authorization_id, reserved_at, intended_binding_hash)
             VALUES (?, ?, ?, ?, 'reservado', ?, ?, ?, ?, ?, ?)`,
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
            kind === 'teste' ? (plan.intendedBindingHash ?? null) : null,
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
