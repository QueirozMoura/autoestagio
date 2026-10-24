import { getApplication } from '../applications/index.js';
import type { CvReference, Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import {
  EmailError,
  MIN_INTERVAL_MIN,
  RecipientError,
  approveForSending,
  authorizeSend,
  confirmationCode,
  extractEmails,
  isFreemail,
  preflight,
  resolveRecipientRequirement,
  sendEmail,
  usableRecipient,
  verifyRecipientFromJob,
  type EmailContext,
} from '../email/index.js';
import { profileHash } from '../eligibility/index.js';
import {
  READINESS_LABELS,
  computeReadiness,
  markReviewed,
  prepareApplication,
} from '../preparation/index.js';

/**
 * Conector de e-mail do modo autônomo. Percorre os MESMOS passos e portões do envio manual (rascunho, destinatário
 * verificado, revisão, aprovação, teste prévio, código de confirmação, autorização de uso único, reserva antes do
 * Gmail), em nome da concessão vigente. Nada é contornado: se qualquer portão falhar, a vaga fica pendente com o
 * motivo; se o resultado for incerto, nunca há nova tentativa.
 */
export type EmailAttempt =
  | { outcome: 'enviada'; applicationId: number; dispatchId: number; evidence: string }
  | { outcome: 'envio_incerto'; applicationId: number; dispatchId?: number; evidence: string }
  | { outcome: 'pendente'; reason: string };

export interface EmailAttemptDeps {
  ctx: EmailContext;
  profile: Profile;
  cv: CvReference;
  grantId: number;
  /** Aguarda (injetável nos testes). */
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Intervalo mínimo entre envios reais em segundos (nunca abaixo do piso do canal de e-mail). */
  intervalSeconds: number;
  /** Espera máxima por execução para respeitar o intervalo; acima disso a vaga fica para a próxima execução. */
  maxWaitSeconds: number;
}

const NO_REPLY =
  /^(no-?reply|nao-?responda|do-?not-?reply|privacidade|privacy|dpo|lgpd|abuse|postmaster|accommodations?|acessibilidade|press|imprensa|ouvidoria|support|suporte|compliance|denuncia|security|seguranca)@/i;
/** O endereço só serve se estiver escrito junto de um pedido de candidatura... */
const APPLY_CUE =
  /(candidat|curr[ií]cul|\bcv\b|envi(?:e|ar|em)|encaminh|mande|mandar|inscri|interessad|apply|send (?:your|an?) (?:resume|cv|application)|resume to)/i;
/** ...e não de acessibilidade, privacidade, imprensa, suporte ou alerta de golpe. */
const NOT_APPLY_CUE =
  /(accommodat|acessibilid|privacy|privacidade|lgpd|imprensa|ouvidoria|compliance|den[uú]ncia|scam|fraud|golpe|unsubscribe|descadastr)/i;
const EMAIL_AT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** E-mail de candidatura escrito na descrição: exatamente um, corporativo, em contexto de candidatura. */
export function candidateEmail(
  description: string | null,
): { ok: true; email: string } | { ok: false; reason: string } {
  const text = description ?? '';
  const found = new Set<string>();
  for (const match of text.matchAll(EMAIL_AT)) {
    const email = extractEmails(match[0])[0];
    if (email === undefined || NO_REPLY.test(email)) continue;
    const at = match.index;
    const context = text.slice(Math.max(0, at - 160), at + match[0].length + 80);
    if (APPLY_CUE.test(context) && !NOT_APPLY_CUE.test(context)) found.add(email);
  }
  const emails = [...found];
  if (emails.length === 0)
    return {
      ok: false,
      reason: 'a vaga não traz e-mail de candidatura em contexto de candidatura',
    };
  if (emails.length > 1)
    return { ok: false, reason: 'a vaga traz vários e-mails: escolha o destinatário manualmente' };
  const email = emails[0] ?? '';
  if (isFreemail(email))
    return { ok: false, reason: 'o e-mail é de provedor gratuito: exige confirmação manual' };
  return { ok: true, email };
}

/** Descobre o destinatário SÓ quando há exatamente um e-mail corporativo escrito na descrição oficial da vaga. */
export function discoverRecipient(
  db: Db,
  jobId: number,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (usableRecipient(db, jobId) !== undefined) return { ok: true };
  const job = db.prepare('SELECT description FROM jobs WHERE id = ?').get(jobId) as
    { description: string | null } | undefined;
  const found = candidateEmail(job?.description ?? null);
  if (!found.ok) return found;
  try {
    verifyRecipientFromJob(db, jobId, found.email, { now });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof RecipientError
          ? `destinatário recusado (${error.code})`
          : 'destinatário recusado',
    };
  }
}

const pending = (reason: string): EmailAttempt => ({ outcome: 'pendente', reason });

function waitMs(db: Db, now: Date, intervalSeconds: number): number {
  const last = db
    .prepare(
      "SELECT MAX(reserved_at) AS last FROM email_dispatches WHERE kind = 'real' AND status IN ('reservado', 'aceito', 'desconhecido')",
    )
    .get() as { last: string | null };
  if (last.last === null) return 0;
  const floor = Math.max(intervalSeconds, MIN_INTERVAL_MIN * 60) * 1000;
  return Math.max(0, Date.parse(last.last) + floor + 5000 - now.getTime());
}

export async function attemptEmail(deps: EmailAttemptDeps, jobId: number): Promise<EmailAttempt> {
  const { ctx, profile, cv, grantId } = deps;
  const { db } = ctx;
  const reason = `autorização permanente #${grantId} (modo autônomo)`;
  let applicationId: number | undefined;
  let reserved = false;
  try {
    if (ctx.testMailbox === undefined)
      return pending(
        'sem caixa de teste configurada (config/email.json): o teste prévio é obrigatório',
      );
    const recipient = discoverRecipient(db, jobId, deps.now());
    if (!recipient.ok) return pending(recipient.reason);

    const prepared = prepareApplication(db, {
      profile,
      cv,
      jobId,
      channel: 'email',
      now: deps.now(),
    });
    if (prepared.outcome === 'recusada') return pending(`preparo recusado: ${prepared.reason}`);
    applicationId = prepared.applicationId;
    const application = getApplication(db, applicationId);
    if (application === undefined) return pending('candidatura não encontrada após o preparo');
    if (!['preparada', 'aprovada_para_envio'].includes(application.status))
      return pending(`a candidatura já está em "${application.status}": não é reenviada`);

    resolveRecipientRequirement(db, applicationId, deps.now());
    const hash = profileHash(profile);
    let readiness = computeReadiness(db, applicationId, hash);
    if (readiness === 'pronta_para_revisao') {
      markReviewed(db, applicationId, hash, deps.now());
      readiness = computeReadiness(db, applicationId, hash);
    }
    if (readiness !== 'revisada' && application.status === 'preparada')
      return pending(
        `rascunho não está pronto: ${READINESS_LABELS[readiness]} (nada é respondido por você)`,
      );
    if (application.status === 'preparada') approveForSending(ctx, applicationId, reason);

    // Teste prévio obrigatório para este conteúdo (vai só para a sua caixa de teste).
    let check = preflight(ctx, applicationId, 'real');
    const hardFails = check.checks.filter(
      (c) => !c.ok && c.sendOnly !== true && c.gate !== true && c.id !== 'estado_e_modo',
    );
    if (hardFails.length > 0)
      return pending(`verificações falhando: ${hardFails.map((c) => c.id).join(', ')}`);
    if (check.checks.some((c) => c.id === 'teste_previo' && !c.ok)) {
      const test = authorizeSend(ctx, applicationId, 'teste', `${reason}: teste prévio`);
      const sentTest = await sendEmail(ctx, applicationId, test.id, 'teste');
      if (sentTest.outcome !== 'aceito') return pending('o teste prévio não foi aceito');
    }

    const wait = waitMs(db, deps.now(), deps.intervalSeconds);
    if (wait > deps.maxWaitSeconds * 1000)
      return pending('aguardando o intervalo mínimo entre envios: fica para a próxima execução');
    if (wait > 0) await deps.sleep(wait);

    check = preflight(ctx, applicationId, 'real');
    if (!check.authorizable || check.plan === undefined) {
      const failed = check.checks.filter((c) => !c.ok && c.sendOnly !== true).map((c) => c.id);
      return pending(`portões de envio falhando: ${failed.join(', ')}`);
    }
    const authorization = authorizeSend(
      ctx,
      applicationId,
      'real',
      reason,
      10,
      confirmationCode(check.plan.bindingHash),
    );
    reserved = true;
    const result = await sendEmail(ctx, applicationId, authorization.id, 'real');
    const evidence = `candidatura:${applicationId};envio:${result.dispatchId}`;
    if (result.outcome === 'aceito')
      return { outcome: 'enviada', applicationId, dispatchId: result.dispatchId, evidence };
    if (result.outcome === 'desconhecido')
      return { outcome: 'envio_incerto', applicationId, dispatchId: result.dispatchId, evidence };
    return pending(`o Gmail recusou o envio (${result.category})`);
  } catch (error) {
    // `sendEmail` só lança EmailError ANTES de reservar o envio (nada saiu); depois da reserva devolve um resultado.
    // Qualquer outra exceção depois de pedir o envio real é tratada como incerta: nunca há nova tentativa.
    if (error instanceof EmailError)
      return pending(`bloqueado (${error.code}): ${error.message.slice(0, 160)}`);
    if (reserved && applicationId !== undefined)
      return { outcome: 'envio_incerto', applicationId, evidence: `candidatura:${applicationId}` };
    return pending(`erro inesperado (${(error as Error).name})`);
  }
}
