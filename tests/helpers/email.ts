import { createHash } from 'node:crypto';
import { setApplicationMode } from '../../src/applications/index.js';
import type { Db } from '../../src/db/index.js';
import type { EmailContext, MailTransport, SendOutcome } from '../../src/email/index.js';
import {
  approveForSending,
  authorizeSend,
  confirmationCode,
  preflight,
  resolveRecipientRequirement,
  verifyRecipientFromJob,
} from '../../src/email/index.js';
import { markReviewed, prepareApplication } from '../../src/preparation/index.js';
import { profileHash } from '../../src/eligibility/index.js';
import { seedJob, type SeedJob } from './applications.js';
import { NOW, profile as baseProfile } from './eligibility.js';

/** PDF FICTÍCIO (só o cabeçalho, para os testes). */
export const CV_BYTES = Buffer.from('%PDF-1.4\n% curriculo ficticio para testes\n%%EOF\n');
export const CV_SHA = createHash('sha256').update(CV_BYTES).digest('hex');
export const RECIPIENT = 'rh@acme-ficticia.com.br';
export const TEST_MAILBOX = 'minha.caixa.de.teste@exemplo.org';

export const emailProfile = () =>
  baseProfile({
    approval: { cvFile: '/tmp/curriculo-ficticio.pdf', cvSha256: CV_SHA, approvedAt: '2026-10-22' },
  });

/** Gmail SIMULADO: registra cada chamada e devolve resultados programados. Nunca usa a rede. */
export class FakeTransport implements MailTransport {
  readonly calls: string[] = [];
  private readonly queue: (SendOutcome | Error | (() => SendOutcome | Promise<SendOutcome>))[] = [];

  next(...outcomes: (SendOutcome | Error | (() => SendOutcome | Promise<SendOutcome>))[]): this {
    this.queue.push(...outcomes);
    return this;
  }

  async send(raw: string): Promise<SendOutcome> {
    this.calls.push(raw);
    const item = this.queue.shift() ?? {
      kind: 'accepted',
      messageId: `fake-${this.calls.length}`,
      threadId: 'fake-thread',
      labelIds: ['SENT'],
    };
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item() : item;
  }
}

export interface Setup {
  db: Db;
  applicationId: number;
  jobId: number;
  transport: FakeTransport;
  cv: { bytes: Buffer };
  ctx: EmailContext;
}

export const decodeRaw = (raw: string): string => Buffer.from(raw, 'base64url').toString('utf8');

/** Candidatura fictícia pronta, revisada, com destinatário verificado e aprovada para envio. */
export function setupApproved(
  db: Db,
  options: {
    job?: SeedJob;
    approve?: boolean;
    sendEnabled?: boolean;
    testEvidence?: boolean;
    /** Endereço escrito na vaga e verificado (padrão: RECIPIENT). */
    recipient?: string;
  } = {},
): Setup {
  const profile = emailProfile();
  const jobId = seedJob(db, {
    title: 'Estágio em Desenvolvimento Backend',
    company: 'Acme Ficticia',
    description: `Requisitos: TypeScript e SQL.\nEnvie sua candidatura para ${options.recipient ?? RECIPIENT}.`,
    workMode: 'remoto',
    location: 'Remote - Brazil',
    stipend: 1800,
    verdict: null,
    ...options.job,
  });
  const result = prepareApplication(db, {
    profile,
    cv: { sha256: CV_SHA, label: 'curriculo-ficticio.pdf' },
    jobId,
    channel: 'email',
    now: NOW,
  });
  if (result.outcome === 'recusada') throw new Error(`preparo recusado: ${result.reason}`);
  const applicationId = result.applicationId;

  verifyRecipientFromJob(db, jobId, options.recipient ?? RECIPIENT, { now: NOW });
  resolveRecipientRequirement(db, applicationId, NOW);
  markReviewed(db, applicationId, profileHash(profile), NOW);

  const transport = new FakeTransport();
  const cv = { bytes: CV_BYTES };
  const ctx: EmailContext = {
    db,
    profile,
    transport,
    sendEnabled: options.sendEnabled ?? true,
    maxPerDay: 10,
    testMailbox: TEST_MAILBOX,
    readCv: () => cv.bytes,
    now: () => NOW,
  };
  if (options.approve !== false) {
    approveForSending(ctx, applicationId, 'teste');
    if (options.testEvidence !== false) seedTestEvidence(ctx, applicationId);
  }
  return { db, applicationId, jobId, transport, cv, ctx };
}

export { setApplicationMode };

/** Código de confirmação do envio real, como o mostraria "email preview-final". */
export function confirmFor(ctx: EmailContext, applicationId: number): string {
  const plan = preflight(ctx, applicationId, 'real').plan;
  // Sem mensagem montada não há código: devolve um inválido para que `authorizeSend` falhe pelo seu próprio motivo.
  return plan === undefined ? 'xxxxxxxx' : confirmationCode(plan.bindingHash);
}

/** `authorizeSend` com o código de confirmação do conteúdo atual (envio real), como faria o operador. */
export function authorizeConfirmed(
  ctx: EmailContext,
  applicationId: number,
  kind: 'real' | 'teste',
  reason: string,
  ttlMinutes?: number,
) {
  return authorizeSend(
    ctx,
    applicationId,
    kind,
    reason,
    ttlMinutes,
    kind === 'real' ? confirmFor(ctx, applicationId) : undefined,
  );
}

/**
 * Evidência de um envio de TESTE aceito para o conteúdo, o anexo e o destinatário reais atuais (a mesma linha que
 * `sendEmail(..., 'teste')` grava), sem chamar nenhum transporte. Só para montar cenários de teste.
 */
export function seedTestEvidence(ctx: EmailContext, applicationId: number): void {
  const plan = preflight(ctx, applicationId, 'real').plan;
  if (plan === undefined)
    throw new Error('a mensagem não pôde ser montada: sem evidência de teste');
  const at = (ctx.now ?? (() => new Date()))().toISOString();
  const auth = Number(
    ctx.db
      .prepare(
        "INSERT INTO email_authorizations (application_id, kind, binding_hash, reason, created_at, expires_at, used_at) VALUES (?, 'teste', ?, 'evidência de teste (fixture)', ?, ?, ?)",
      )
      .run(applicationId, 'e'.repeat(64), at, at, at).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO email_dispatches (application_id, kind, recipient_masked, status, rfc_message_id, cv_sha256, content_hash,
         authorization_id, reserved_at, finished_at, intended_binding_hash)
       VALUES (?, 'teste', 'm***@exemplo.org', 'aceito', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      applicationId,
      `<fixture-${auth}@autoestagio.local>`,
      plan.cvSha256,
      plan.contentHash,
      auth,
      at,
      at,
      plan.bindingHash,
    );
}

/** Decodifica uma mensagem MIME multipart/mixed simples (a que o projeto gera). */
export function parseMime(mime: string): {
  headers: Record<string, string>;
  text: string;
  attachment: { filename: string; contentType: string; bytes: Buffer };
  rawHeaders: string;
} {
  const [rawHeaders = '', ...rest] = mime.split('\r\n\r\n');
  const bodyPart = rest.join('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type'] ?? '')?.[1] ?? '';
  const parts = bodyPart
    .split(`--${boundary}`)
    .map((part) => part.replace(/^\r\n/, ''))
    .filter((part) => part !== '' && !part.startsWith('--'));
  const decode = (part: string) => {
    const [head = '', ...body] = part.split('\r\n\r\n');
    return { head, bytes: Buffer.from(body.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64') };
  };
  const text = decode(parts[0] ?? '');
  const file = decode(parts[1] ?? '');
  // Assunto com palavras codificadas (RFC 2047) volta ao texto original.
  headers.subject = (headers.subject ?? '').replace(
    /=\?UTF-8\?B\?([^?]+)\?=\s*/g,
    (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'),
  );
  return {
    headers,
    rawHeaders,
    text: text.bytes.toString('utf8'),
    attachment: {
      filename: /filename="([^"]+)"/.exec(file.head)?.[1] ?? '',
      contentType: /Content-Type: ([^;]+)/.exec(file.head)?.[1] ?? '',
      bytes: file.bytes,
    },
  };
}
