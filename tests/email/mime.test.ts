import { describe, expect, it } from 'vitest';
import {
  MimeError,
  buildMime,
  encodeSubject,
  isValidEmail,
  newMessageId,
  toBase64Url,
} from '../../src/email/index.js';
import { parseMime } from '../helpers/email.js';

const base = {
  to: 'rh@acme-ficticia.com.br',
  subject: 'Candidatura - Estágio em Desenvolvimento - Pessoa Exemplo',
  body: 'Olá, equipe Acme,\nlinha 2 com acentuação: ção.',
  date: new Date('2026-10-22T12:00:00Z'),
  messageId: '<abc123@autoestagio.local>',
  dispatchId: 'd7',
  attachment: {
    filename: 'Curriculo_Ficticio.pdf',
    bytes: Buffer.from('%PDF-1.4\n\x00\x01\x02binário\n'),
    contentType: 'application/pdf' as const,
  },
  boundary: '=_teste',
};

describe('buildMime', () => {
  it('gera multipart/mixed com texto UTF-8 e o PDF idêntico, sem Cc/Bcc/From', () => {
    const parsed = parseMime(buildMime(base));
    expect(parsed.headers.to).toBe('rh@acme-ficticia.com.br');
    expect(parsed.headers['message-id']).toBe('<abc123@autoestagio.local>');
    expect(parsed.headers['x-autoestagio-dispatch']).toBe('d7');
    expect(parsed.headers['mime-version']).toBe('1.0');
    expect(parsed.headers.date).toBe('Thu, 22 Oct 2026 12:00:00 +0000');
    expect(parsed.rawHeaders).not.toMatch(/^(bcc|cc|from):/im);
    expect(parsed.text).toBe('Olá, equipe Acme,\r\nlinha 2 com acentuação: ção.');
    expect(parsed.attachment.contentType).toBe('application/pdf');
    expect(parsed.attachment.filename).toBe('Curriculo_Ficticio.pdf');
    expect(parsed.attachment.bytes.equals(base.attachment.bytes)).toBe(true);
  });

  it('assunto com acentos vai em palavras codificadas (RFC 2047) e volta idêntico', () => {
    const encoded = encodeSubject(base.subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    expect(encoded).not.toMatch(/[^ -~\r\n]/);
    const decoded = encoded
      .split(' ')
      .map((word) =>
        Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(word)?.[1] ?? '', 'base64').toString('utf8'),
      )
      .join('');
    expect(decoded).toBe(base.subject);
    expect(encodeSubject('Assunto simples')).toBe('Assunto simples');
  });

  it('nome de arquivo com acento tem alternativa ASCII e a forma UTF-8 (RFC 2231)', () => {
    const mime = buildMime({
      ...base,
      attachment: { ...base.attachment, filename: 'Currículo João.pdf' },
    });
    expect(mime).toContain('filename="Curr_culo_Jo_o.pdf"');
    expect(mime).toContain("filename*=UTF-8''Curr%C3%ADculo%20Jo%C3%A3o.pdf");
  });

  it('recusa injeção de cabeçalhos (quebra de linha) e endereços inválidos', () => {
    expect(() => buildMime({ ...base, subject: 'oi\r\nBcc: espiao@exemplo.com' })).toThrow(
      MimeError,
    );
    expect(() => buildMime({ ...base, to: 'a@b.com\r\nBcc: x@y.com' })).toThrow(/inválido/);
    expect(() => buildMime({ ...base, to: 'sem-arroba' })).toThrow(MimeError);
    expect(() => buildMime({ ...base, to: 'a@b.com, c@d.com' })).toThrow(MimeError);
    expect(() => buildMime({ ...base, messageId: 'sem-colchetes' })).toThrow(MimeError);
    expect(() => buildMime({ ...base, dispatchId: 'x y' })).toThrow(MimeError);
  });

  it('texto do corpo com "Bcc:" fica no corpo, nunca vira cabeçalho', () => {
    const parsed = parseMime(buildMime({ ...base, body: 'Olá\r\nBcc: espiao@exemplo.com' }));
    expect(parsed.rawHeaders).not.toMatch(/bcc/i);
    expect(parsed.text).toContain('Bcc: espiao@exemplo.com');
  });

  it('base64url sem preenchimento e Message-ID únicos', () => {
    expect(toBase64Url('???>>>')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newMessageId()).toMatch(/^<[0-9a-f]{32}@autoestagio\.local>$/);
    expect(newMessageId()).not.toBe(newMessageId());
  });
});

describe('isValidEmail', () => {
  it.each(['rh@acme.com.br', 'a.b+c@sub.dominio.org'])('aceita %s', (value) => {
    expect(isValidEmail(value)).toBe(true);
  });
  it.each([
    '',
    'a@b',
    'a b@c.com',
    '@c.com',
    'a@@c.com',
    'a..b@c.com',
    '.a@c.com',
    'a@c..com',
    'a@c.com.',
    'ação@c.com',
    `${'x'.repeat(65)}@c.com`,
  ])('recusa %j', (value) => {
    expect(isValidEmail(value)).toBe(false);
  });
});
