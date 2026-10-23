import { createHash } from 'node:crypto';
import { annotateApplication, getApplication } from '../applications/index.js';
import {
  writePrivateExclusive,
  type SafeWriteFs,
  type SafeWriteOptions,
  type SafeWriteResult,
} from '../utils/safe-write.js';
import { buildMime, newMessageId } from './mime.js';
import { maskEmail } from './recipients.js';
import { EmailError, preflight, type DispatchKind, type EmailContext } from './send.js';

/**
 * Exportação de um rascunho LOCAL em formato .eml. Nunca chama o Gmail, nunca envia nada e não muda o
 * estado da candidatura. Usa as mesmas verificações do envio (menos a trava mestra), o mesmo construtor
 * MIME e a escrita privada e exclusiva da etapa 4.4 (diretório 0700, arquivo 0600, sem sobrescrita).
 * O arquivo contém dados pessoais (destinatário, mensagem e currículo): trate-o como privado.
 */

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const pad = (n: number): string => String(n).padStart(2, '0');

/** Confere que o MIME gerado é bem formado e carrega exatamente o destinatário, o corpo e o anexo esperados. */
export function verifyMime(
  mime: string,
  expected: { to: string; body: string; attachmentSha256: string; attachmentBytes: number },
): void {
  const fail = (): never => {
    throw new EmailError('bloqueado', 'a mensagem MIME gerada é inválida; nada foi gravado');
  };
  const [rawHeaders = '', ...rest] = mime.split('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of rawHeaders.replace(/\r\n[ \t]+/gu, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) return fail();
    headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const boundary = /boundary="([^"]+)"/u.exec(headers.get('content-type') ?? '')?.[1];
  if (
    boundary === undefined ||
    headers.get('to') !== expected.to ||
    headers.get('mime-version') !== '1.0' ||
    !mime.endsWith(`--${boundary}--\r\n`) ||
    /\r\n(?:bcc|cc):/iu.test(`\r\n${rawHeaders}`)
  )
    return fail();
  const parts = rest
    .join('\r\n\r\n')
    .split(`--${boundary}`)
    .map((part) => part.replace(/^\r\n/u, ''))
    .filter((part) => part !== '' && !part.startsWith('--'));
  if (parts.length !== 2) return fail();
  const decode = (part: string): { head: string; bytes: Buffer } => {
    const [head = '', ...body] = part.split('\r\n\r\n');
    return { head, bytes: Buffer.from(body.join('\r\n\r\n').replace(/\r\n/gu, ''), 'base64') };
  };
  const text = decode(parts[0] ?? '');
  const file = decode(parts[1] ?? '');
  if (
    text.bytes.toString('utf8') !== expected.body.replace(/\r?\n/gu, '\r\n') ||
    !/application\/pdf/u.test(file.head) ||
    !/Content-Disposition: attachment/u.test(file.head) ||
    file.bytes.length !== expected.attachmentBytes ||
    sha256(file.bytes) !== expected.attachmentSha256
  )
    return fail();
}

export interface EmlExportResult extends SafeWriteResult {
  recipientMasked: string;
  attachmentSource: 'mestre' | 'personalizado';
  attachmentVariant: string | null;
}

export interface EmlExportOptions {
  /** Diretório de saída; o NOME do arquivo é sempre definido aqui. */
  dir: string;
  /** Injeção só para testes. */
  write?: (options: SafeWriteOptions) => SafeWriteResult;
  writeFs?: Partial<SafeWriteFs>;
}

/**
 * Exporta o rascunho local. Exige as mesmas verificações do envio (candidatura SEMPRE aprovada para envio, inclusive em teste,
 * rascunho revisado, destinatário verificado, anexo correto e íntegro), exceto a trava mestra, que
 * não se aplica a um arquivo local. Lança `EmailError`/`SafeWriteError`; só devolve o caminho depois
 * da publicação.
 */
export function exportEml(
  ctx: EmailContext,
  applicationId: number,
  kind: DispatchKind,
  options: EmlExportOptions,
): EmlExportResult {
  const result = preflight(ctx, applicationId, kind);
  if (!result.ok || result.plan === undefined) {
    const failed = result.checks
      .filter((check) => !check.ok && check.sendOnly !== true)
      .map((check) => check.id);
    throw new EmailError(
      'bloqueado',
      `não dá para exportar: verificações falhando (${failed.join(', ')})`,
    );
  }
  // Vale também para --test: exportar exige `email approve` antes (o preflight de teste aceita "preparada",
  // por causa do `send --test`, mas um arquivo .eml sempre exige a candidatura aprovada para envio).
  if (getApplication(ctx.db, applicationId)?.status !== 'aprovada_para_envio')
    throw new EmailError(
      'bloqueado',
      'não dá para exportar: a candidatura precisa estar aprovada para envio (email approve) — vale também para --test',
    );
  const plan = result.plan;
  const now = (ctx.now ?? (() => new Date()))();
  const mime = buildMime({
    to: plan.recipient,
    subject: plan.subject,
    body: plan.body,
    date: now,
    messageId: newMessageId(),
    dispatchId: 'eml-export',
    attachment: { filename: plan.cvName, bytes: plan.cvBytes, contentType: 'application/pdf' },
  });
  verifyMime(mime, {
    to: plan.recipient,
    body: plan.body,
    attachmentSha256: plan.cvSha256,
    attachmentBytes: plan.cvBytes.length,
  });
  const bytes = Buffer.from(mime, 'utf8');
  const digest = sha256(bytes);
  const name = `candidatura-${applicationId}-${kind}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${digest.slice(0, 8)}.eml`;
  const write = options.write ?? writePrivateExclusive;
  const written = write({
    dir: options.dir,
    name,
    bytes,
    sha256: digest,
    ...(options.writeFs === undefined ? {} : { fs: options.writeFs }),
  });
  annotateApplication(
    ctx.db,
    applicationId,
    {
      reason: `rascunho local .eml exportado (${kind}, anexo ${plan.attachmentSource}); nada foi enviado e o estado da candidatura não mudou`,
      actor: 'usuario',
    },
    now,
  );
  return {
    ...written,
    recipientMasked: maskEmail(plan.recipient),
    attachmentSource: plan.attachmentSource,
    attachmentVariant: plan.attachmentVariant,
  };
}
