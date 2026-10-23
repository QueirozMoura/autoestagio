import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHistory } from '../../src/applications/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  EmailError,
  MIN_INTERVAL_MIN,
  REPEAT_RECIPIENT_DAYS,
  authorizeSend,
  buildFinalPreview,
  confirmationCode,
  dryRunEmail,
  exportEml,
  formatFinalPreview,
  normalizeRecipient,
  preflight,
  sendEmail,
  type EmailContext,
} from '../../src/email/index.js';
import { NOW } from '../helpers/eligibility.js';
import {
  RECIPIENT,
  authorizeConfirmed,
  confirmFor,
  seedTestEvidence,
  setupApproved,
  type Setup,
} from '../helpers/email.js';

let db: Db;
const dirs: string[] = [];
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const clockAt = (ctx: EmailContext, minutes: number): EmailContext => ({
  ...ctx,
  now: () => at(minutes),
});
const failingIds = (ctx: EmailContext, id: number, kind: 'real' | 'teste' = 'real'): string[] =>
  preflight(ctx, id, kind)
    .checks.filter((c) => !c.ok && c.sendOnly !== true)
    .map((c) => c.id);
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

/** Segunda candidatura (outra vaga, outra empresa) no mesmo banco. */
const second = (
  recipient = 'contato@outra-ficticia.com.br',
  over: Parameters<typeof setupApproved>[1] = {},
): Setup =>
  setupApproved(db, {
    job: { title: 'Estágio em QA Mobile', company: 'Outra Ficticia' },
    recipient,
    testEvidence: false,
    ...over,
  });

describe('código de confirmação do envio real', () => {
  it('é obrigatório e precisa corresponder ao conteúdo atual', () => {
    const s = setupApproved(db);
    const id = s.applicationId;
    expect(() => authorizeSend(s.ctx, id, 'real', 'autorizo')).toThrow(/código de confirmação/);
    expect(() => authorizeSend(s.ctx, id, 'real', 'autorizo', undefined, '00000000')).toThrow(
      EmailError,
    );
    expect(() => authorizeSend(s.ctx, id, 'real', 'autorizo', undefined, '')).toThrow(EmailError);
    const code = confirmFor(s.ctx, id);
    expect(code).toMatch(/^[0-9a-f]{8}$/u);
    expect(
      authorizeSend(s.ctx, id, 'real', 'autorizo', undefined, code.toUpperCase()).id,
    ).toBeGreaterThan(0);
  });

  it('não expõe o bindingHash e muda quando qualquer parte vinculada muda', () => {
    const s = setupApproved(db);
    const plan = preflight(s.ctx, s.applicationId, 'real').plan;
    const binding = plan?.bindingHash ?? '';
    const before = confirmFor(s.ctx, s.applicationId);
    expect(binding.includes(before)).toBe(false);
    expect(before).toBe(confirmationCode(binding));
    // Destinatário.
    db.prepare("UPDATE verified_recipients SET email = 'outro@acme-ficticia.com.br'").run();
    const afterRecipient = confirmFor(s.ctx, s.applicationId);
    expect(afterRecipient).not.toBe(before);
    // Conteúdo (corpo do rascunho) e anexo (currículo mestre).
    db.prepare('UPDATE application_drafts SET content_hash = ?, reviewed_hash = ?').run(
      'c'.repeat(64),
      'c'.repeat(64),
    );
    const afterBody = confirmFor(s.ctx, s.applicationId);
    expect(afterBody).not.toBe(afterRecipient);
    // Um código antigo é recusado (com o teste prévio refeito, para isolar a confirmação).
    seedTestEvidence(s.ctx, s.applicationId);
    expect(() =>
      authorizeSend(s.ctx, s.applicationId, 'real', 'autorizo', undefined, before),
    ).toThrow(/código de confirmação/);
  });

  it('o envio de teste não exige código', () => {
    const s = setupApproved(db);
    expect(authorizeSend(s.ctx, s.applicationId, 'teste', 'autorizo o teste').kind).toBe('teste');
  });
});

describe('prévia final', () => {
  it('mostra destinatário completo, fonte, assunto, corpo, anexo e código, sem gravar nada', () => {
    const s = setupApproved(db);
    const events = getHistory(db, s.applicationId).length;
    const authorizations = count('SELECT COUNT(*) AS n FROM email_authorizations');
    const preview = buildFinalPreview(s.ctx, s.applicationId);
    const text = formatFinalPreview(preview);
    expect(text).toContain(RECIPIENT);
    expect(text).toContain('vaga oficial');
    expect(text).toContain('--- corpo da mensagem ---');
    expect(text).toContain('Segue meu currículo em anexo.');
    expect(text).toContain('currículo mestre aprovado');
    expect(text).toContain(`Código de confirmação: ${confirmFor(s.ctx, s.applicationId)}`);
    expect(preview.attachment?.sha8).toMatch(/^[0-9a-f]{8}$/u);
    expect(text).not.toMatch(/[0-9a-f]{40,}/u);
    expect(getHistory(db, s.applicationId)).toHaveLength(events);
    expect(count('SELECT COUNT(*) AS n FROM email_authorizations')).toBe(authorizations);
    expect(s.transport.calls).toEqual([]);
  });

  it('sem mensagem montada não há código', () => {
    const s = setupApproved(db, { approve: false });
    db.prepare('DELETE FROM verified_recipients').run();
    const preview = buildFinalPreview(s.ctx, s.applicationId);
    expect(preview.code).toBeUndefined();
    expect(formatFinalPreview(preview)).toContain('indisponível');
  });
});

describe('envio de teste obrigatório antes do envio real', () => {
  it('sem teste a autorização real é bloqueada, mas a aprovação, o dry-run e a prévia seguem funcionando', () => {
    const s = setupApproved(db, { testEvidence: false });
    expect(failingIds(s.ctx, s.applicationId)).toEqual(['teste_previo']);
    expect(() => authorizeConfirmed(s.ctx, s.applicationId, 'real', 'autorizo')).toThrow(
      /teste_previo/,
    );
    const report = dryRunEmail(s.ctx, s.applicationId);
    expect(report.message).toBeDefined();
    expect(report.sendReady).toBe(false);
    expect(buildFinalPreview(s.ctx, s.applicationId).code).toBeDefined();
  });

  it('um teste ACEITO grava a evidência ligada ao envio real pretendido e libera a autorização', async () => {
    const s = setupApproved(db, { testEvidence: false });
    const realBinding = preflight(s.ctx, s.applicationId, 'real').plan?.bindingHash;
    const authorization = authorizeConfirmed(s.ctx, s.applicationId, 'teste', 'autorizo o teste');
    const result = await sendEmail(s.ctx, s.applicationId, authorization.id, 'teste');
    expect(result.outcome).toBe('aceito');
    expect(
      db.prepare('SELECT intended_binding_hash AS h, kind FROM email_dispatches').get(),
    ).toEqual({
      h: realBinding,
      kind: 'teste',
    });
    // O teste foi para a caixa de teste, não para o destinatário real.
    expect(Buffer.from(s.transport.calls[0] ?? '', 'base64url').toString('utf8')).not.toContain(
      RECIPIENT,
    );
    expect(failingIds(s.ctx, s.applicationId)).toEqual([]);
    expect(authorizeConfirmed(s.ctx, s.applicationId, 'real', 'autorizo').kind).toBe('real');
  });

  it('dry-run e exportação .eml não contam como teste', () => {
    const s = setupApproved(db, { testEvidence: false });
    dryRunEmail(s.ctx, s.applicationId);
    const dir = mkdtempSync(join(tmpdir(), 'gates-'));
    dirs.push(dir);
    exportEml(s.ctx, s.applicationId, 'real', { dir: join(dir, 'e') });
    expect(failingIds(s.ctx, s.applicationId)).toEqual(['teste_previo']);
    expect(count('SELECT COUNT(*) AS n FROM email_dispatches')).toBe(0);
  });

  it('teste de outra candidatura, ambíguo ou recusado não vale', async () => {
    const a = setupApproved(db, { testEvidence: false });
    const b = second();
    // Teste aceito de A não vale para B.
    await sendEmail(
      a.ctx,
      a.applicationId,
      authorizeConfirmed(a.ctx, a.applicationId, 'teste', 't').id,
      'teste',
    );
    expect(failingIds(b.ctx, b.applicationId)).toContain('teste_previo');
    // Teste ambíguo (resultado desconhecido) e recusado não contam.
    b.transport.next({ kind: 'unknown', category: 'http_503' });
    expect(
      (
        await sendEmail(
          b.ctx,
          b.applicationId,
          authorizeConfirmed(b.ctx, b.applicationId, 'teste', 't').id,
          'teste',
        )
      ).outcome,
    ).toBe('desconhecido');
    expect(failingIds(b.ctx, b.applicationId)).toContain('teste_previo');
    b.transport.next({ kind: 'rejected', category: 'http_403' });
    expect(
      (
        await sendEmail(
          b.ctx,
          b.applicationId,
          authorizeConfirmed(b.ctx, b.applicationId, 'teste', 't').id,
          'teste',
        )
      ).outcome,
    ).toBe('rejeitado');
    expect(failingIds(b.ctx, b.applicationId)).toContain('teste_previo');
  });

  it('a evidência é invalidada se destinatário, conteúdo ou anexo mudarem', async () => {
    const s = setupApproved(db, { testEvidence: false });
    await sendEmail(
      s.ctx,
      s.applicationId,
      authorizeConfirmed(s.ctx, s.applicationId, 'teste', 't').id,
      'teste',
    );
    expect(failingIds(s.ctx, s.applicationId)).toEqual([]);
    // Anexo (mestre alterado no disco).
    s.cv.bytes = Buffer.from('%PDF-1.4 outra versao');
    expect(failingIds(s.ctx, s.applicationId)).toContain('curriculo_confere');
    s.cv.bytes = Buffer.from(s.cv.bytes);
    // Destinatário.
    const fresh = setupApproved(openDb(), { testEvidence: false });
    await sendEmail(
      fresh.ctx,
      fresh.applicationId,
      authorizeConfirmed(fresh.ctx, fresh.applicationId, 'teste', 't').id,
      'teste',
    );
    fresh.db.prepare("UPDATE verified_recipients SET email = 'outro@acme-ficticia.com.br'").run();
    expect(failingIds(fresh.ctx, fresh.applicationId)).toEqual(['teste_previo']);
    // Conteúdo.
    const body = setupApproved(openDb(), { testEvidence: false });
    await sendEmail(
      body.ctx,
      body.applicationId,
      authorizeConfirmed(body.ctx, body.applicationId, 'teste', 't').id,
      'teste',
    );
    body.db
      .prepare('UPDATE application_drafts SET content_hash = ?, reviewed_hash = ?')
      .run('d'.repeat(64), 'd'.repeat(64));
    expect(failingIds(body.ctx, body.applicationId)).toEqual(['teste_previo']);
  });

  it('a evidência é imutável e só existe em envios de teste', async () => {
    const s = setupApproved(db, { testEvidence: false });
    await sendEmail(
      s.ctx,
      s.applicationId,
      authorizeConfirmed(s.ctx, s.applicationId, 'teste', 't').id,
      'teste',
    );
    expect(() =>
      db.prepare('UPDATE email_dispatches SET intended_binding_hash = ?').run('f'.repeat(64)),
    ).toThrow(/imutável/);
    expect(() => db.prepare('UPDATE email_dispatches SET kind = ?').run('real')).toThrow();
    expect(() =>
      db.prepare("UPDATE email_dispatches SET intended_binding_hash = 'zz'").run(),
    ).toThrow();
    const authorization = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'autorizo');
    await sendEmail(s.ctx, s.applicationId, authorization.id, 'real');
    expect(
      db
        .prepare("SELECT intended_binding_hash AS h FROM email_dispatches WHERE kind = 'real'")
        .get(),
    ).toEqual({ h: null });
  });
});

function openDb(): Db {
  const fresh = openDatabase(IN_MEMORY);
  runMigrations(fresh);
  return fresh;
}

describe('intervalo mínimo e destinatário repetido', () => {
  it(`bloqueia um segundo envio real em menos de ${MIN_INTERVAL_MIN} min, sem afetar testes`, async () => {
    const a = setupApproved(db);
    const b = second('contato@outra-ficticia.com.br');
    seedTestEvidence(b.ctx, b.applicationId);
    await sendEmail(
      a.ctx,
      a.applicationId,
      authorizeConfirmed(a.ctx, a.applicationId, 'real', 'a').id,
      'real',
    );
    const soon = clockAt(b.ctx, 10);
    expect(failingIds(soon, b.applicationId)).toEqual(['intervalo_minimo']);
    expect(() => authorizeConfirmed(soon, b.applicationId, 'real', 'b')).toThrow(
      /intervalo_minimo/,
    );
    // Teste não é afetado.
    expect(failingIds(soon, b.applicationId, 'teste')).toEqual([]);
    // Passado o intervalo, libera.
    const later = clockAt(b.ctx, MIN_INTERVAL_MIN + 1);
    seedTestEvidence(later, b.applicationId);
    expect(failingIds(later, b.applicationId)).toEqual([]);
    expect(authorizeConfirmed(later, b.applicationId, 'real', 'b').kind).toBe('real');
  });

  it('um envio de resultado incerto também segura o intervalo (conservador); um recusado não', async () => {
    const a = setupApproved(db);
    a.transport.next({ kind: 'unknown', category: 'http_503' });
    await sendEmail(
      a.ctx,
      a.applicationId,
      authorizeConfirmed(a.ctx, a.applicationId, 'real', 'a').id,
      'real',
    );
    const b = second();
    seedTestEvidence(b.ctx, b.applicationId);
    expect(failingIds(clockAt(b.ctx, 5), b.applicationId)).toContain('intervalo_minimo');
    // Um envio recusado antes de enviar não segura o intervalo.
    const d = openDb();
    const c = setupApproved(d);
    c.transport.next({ kind: 'rejected', category: 'http_403' });
    await sendEmail(
      c.ctx,
      c.applicationId,
      authorizeConfirmed(c.ctx, c.applicationId, 'real', 'c').id,
      'real',
    );
    const e = setupApproved(d, {
      job: { title: 'Estágio em Dados', company: 'Terceira Ficticia' },
      recipient: 'rh@terceira-ficticia.com.br',
    });
    expect(failingIds(clockAt(e.ctx, 5), e.applicationId)).toEqual([]);
  });

  it(`bloqueia o mesmo destinatário (normalizado) em outra candidatura por ${REPEAT_RECIPIENT_DAYS} dias, sem bypass`, async () => {
    const a = setupApproved(db);
    await sendEmail(
      a.ctx,
      a.applicationId,
      authorizeConfirmed(a.ctx, a.applicationId, 'real', 'a').id,
      'real',
    );
    // Mesmo contato escrito de outra forma na outra vaga.
    const b = second('rh+vaga2@acme-ficticia.com.br', {
      job: { title: 'Estágio em QA Mobile', company: 'Outra Ficticia' },
    });
    seedTestEvidence(b.ctx, b.applicationId);
    const day20 = clockAt(b.ctx, 20 * 24 * 60);
    seedTestEvidence(day20, b.applicationId);
    expect(failingIds(day20, b.applicationId)).toEqual(['destinatario_repetido']);
    expect(() => authorizeConfirmed(day20, b.applicationId, 'real', 'b')).toThrow(
      /destinatario_repetido/,
    );
    // Depois da janela, libera.
    const day31 = clockAt(b.ctx, (REPEAT_RECIPIENT_DAYS + 1) * 24 * 60);
    seedTestEvidence(day31, b.applicationId);
    expect(failingIds(day31, b.applicationId)).toEqual([]);
  });

  it('normaliza a identidade do destinatário', () => {
    expect(normalizeRecipient(' RH@Acme.com.br ')).toBe('rh@acme.com.br');
    expect(normalizeRecipient('rh+vaga@acme.com.br')).toBe('rh@acme.com.br');
    expect(normalizeRecipient('a.b.c+x@gmail.com')).toBe('abc@gmail.com');
    expect(normalizeRecipient('a.b@googlemail.com')).toBe('ab@gmail.com');
    expect(normalizeRecipient('a.b@empresa.com')).toBe('a.b@empresa.com');
  });
});
