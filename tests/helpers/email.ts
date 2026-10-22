import { createHash } from 'node:crypto';
import { setApplicationMode } from '../../src/applications/index.js';
import type { Db } from '../../src/db/index.js';
import type { EmailContext, MailTransport, SendOutcome } from '../../src/email/index.js';
import {
  approveForSending,
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
  options: { job?: SeedJob; approve?: boolean; sendEnabled?: boolean } = {},
): Setup {
  const profile = emailProfile();
  const jobId = seedJob(db, {
    title: 'Estágio em Desenvolvimento Backend',
    company: 'Acme Ficticia',
    description: `Requisitos: TypeScript e SQL.\nEnvie sua candidatura para ${RECIPIENT}.`,
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

  verifyRecipientFromJob(db, jobId, RECIPIENT, { now: NOW });
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
  if (options.approve !== false) approveForSending(ctx, applicationId, 'teste');
  return { db, applicationId, jobId, transport, cv, ctx };
}

export { setApplicationMode };

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
