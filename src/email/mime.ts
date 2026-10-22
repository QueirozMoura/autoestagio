import { randomBytes } from 'node:crypto';

export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MimeError';
  }
}

export interface MimeInput {
  to: string;
  subject: string;
  body: string;
  date: Date;
  /** `<id@host>` já gerado. */
  messageId: string;
  /** Identificador interno do envio (cabeçalho X-AutoEstagio-Dispatch), sem dados pessoais. */
  dispatchId: string;
  attachment: { filename: string; bytes: Buffer; contentType: 'application/pdf' };
  /** Fronteira fixa só para testes. */
  boundary?: string;
}

const CRLF = '\r\n';

/** Valor de cabeçalho: uma linha só. CR/LF permitiriam injetar cabeçalhos (ex.: Bcc). */
function header(name: string, value: string): string {
  if (value.includes('\r') || value.includes('\n') || value.includes('\0'))
    throw new MimeError(`cabeçalho ${name} contém quebra de linha`);
  return `${name}: ${value}`;
}

const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

export function isValidEmail(value: string): boolean {
  return (
    value.length <= 254 && ADDRESS.test(value) && !value.includes('..') && !value.startsWith('.')
  );
}

/** RFC 2047: assunto com acentos vai em palavras codificadas de no máximo ~45 bytes. */
export function encodeSubject(subject: string): string {
  if (/^[ -~]*$/.test(subject)) return subject;
  const words: string[] = [];
  let current = '';
  for (const char of subject) {
    if (Buffer.byteLength(current + char) > 45) {
      words.push(current);
      current = '';
    }
    current += char;
  }
  if (current !== '') words.push(current);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join(' ');
}

function base64Lines(bytes: Buffer): string {
  return (bytes.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
}

function asciiFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'anexo.pdf';
}

export function newMessageId(host = 'autoestagio.local'): string {
  return `<${randomBytes(16).toString('hex')}@${host}>`;
}

/** Monta a mensagem MIME (multipart/mixed: texto UTF-8 + PDF). Sem From: o Gmail usa a conta autenticada. */
export function buildMime(input: MimeInput): string {
  if (!isValidEmail(input.to)) throw new MimeError('destinatário inválido');
  if (/[\r\n\0]/.test(input.subject)) throw new MimeError('o assunto contém quebra de linha');
  if (!/^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(input.messageId))
    throw new MimeError('Message-ID inválido');
  if (!/^[A-Za-z0-9._-]+$/.test(input.dispatchId))
    throw new MimeError('identificador de envio inválido');
  const boundary = input.boundary ?? `=_autoestagio_${randomBytes(12).toString('hex')}`;
  const filename = input.attachment.filename;
  const body = input.body.replace(/\r?\n/g, CRLF);

  const head = [
    header('Date', input.date.toUTCString().replace('GMT', '+0000')),
    header('To', input.to),
    header('Subject', encodeSubject(input.subject)),
    header('Message-ID', input.messageId),
    header('X-AutoEstagio-Dispatch', input.dispatchId),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(body, 'utf8')),
    `--${boundary}`,
    `Content-Type: ${input.attachment.contentType}; name="${asciiFilename(filename)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    '',
    base64Lines(input.attachment.bytes),
    `--${boundary}--`,
    '',
  ];
  return `${head.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

export function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
