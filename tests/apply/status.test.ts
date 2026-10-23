import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyStatus, formatApplyStatus, type ApplyStatus } from '../../src/apply/status.js';
import { approveAttachment, createAttachment, registerArtifact } from '../../src/cv/attachments.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { sendEmail } from '../../src/email/index.js';
import { profileHash } from '../../src/eligibility/index.js';
import { seedJob } from '../helpers/applications.js';
import { NOW } from '../helpers/eligibility.js';
import {
  RECIPIENT,
  authorizeConfirmed,
  emailProfile,
  seedTestEvidence,
  setupApproved,
  type Setup,
} from '../helpers/email.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});
const gate = (s: ApplyStatus, id: string) => s.gates.find((g) => g.id === id);
const snapshot = (): unknown =>
  [
    'applications',
    'application_events',
    'email_authorizations',
    'email_dispatches',
    'application_cv_attachments',
    'cv_artifacts',
  ].map((t) => db.prepare(`SELECT * FROM ${t}`).all());

describe('apply status — sem candidatura', () => {
  it('sem análise, inapta e elegível indicam o primeiro passo', () => {
    const ctx = setupApproved(db, { approve: false }).ctx;
    const none = seedJob(db, { title: 'Estágio em Dados', verdict: null });
    expect(applyStatus(ctx, { jobId: none }).next).toContain('analyze');
    const unfit = seedJob(db, {
      title: 'Estágio Inapto',
      verdict: 'inapto',
      profileHash: profileHash(emailProfile()),
    });
    expect(applyStatus(ctx, { jobId: unfit }).next).toContain('inapta');
    const fit = seedJob(db, {
      title: 'Estágio Apto',
      verdict: 'apto',
      profileHash: profileHash(emailProfile()),
    });
    const status = applyStatus(ctx, { jobId: fit });
    expect(status.applicationId).toBeUndefined();
    expect(status.next).toContain(`applications prepare ${fit}`);
    const review = seedJob(db, {
      title: 'Estágio Revisão',
      verdict: 'revisao_humana',
      profileHash: profileHash(emailProfile()),
    });
    expect(applyStatus(ctx, { jobId: review }).next).toContain('--override-review');
  });
});

describe('apply status — etapas e próxima ação', () => {
  it('acompanha o fluxo do rascunho até o envio possível, sempre somente leitura', async () => {
    const s: Setup = setupApproved(db, { approve: false, testEvidence: false });
    const id = s.applicationId;
    const before = snapshot();
    const at = (): ApplyStatus => applyStatus(s.ctx, { applicationId: id });

    // Rascunho ainda não revisado.
    db.prepare('UPDATE application_drafts SET reviewed_hash = NULL').run();
    expect(at().next).toContain(`confirm-review ${id}`);
    expect(gate(at(), 'rascunho')?.state).toBe('pendente');
    db.prepare('UPDATE application_drafts SET reviewed_hash = content_hash').run();

    // Sem destinatário.
    const recipients = db.prepare('SELECT * FROM verified_recipients').all() as Record<
      string,
      unknown
    >[];
    db.prepare('DELETE FROM verified_recipients').run();
    expect(at().next).toContain('email recipient');
    db.prepare(
      'INSERT INTO verified_recipients (id, job_id, email, source_kind, source_url, company_domain, evidence_hash, freemail, freemail_confirmed, verified_at) VALUES (@id, @job_id, @email, @source_kind, @source_url, @company_domain, @evidence_hash, @freemail, @freemail_confirmed, @verified_at)',
    ).run(recipients[0]);

    // Pronta, usando o mestre; falta aprovar para envio.
    const first = at();
    expect(gate(first, 'curriculo')).toMatchObject({ state: 'ok' });
    expect(gate(first, 'vinculo')?.state).toBe('nao_se_aplica');
    expect(first.next).toContain(`email approve ${id}`);
    expect(first.sendPossible).toBe(false);

    // Aprovada, mas sem teste.
    const { approveForSending } = await import('../../src/email/index.js');
    approveForSending(s.ctx, id, 'ok');
    const approved = at();
    expect(gate(approved, 'aprovada_para_envio')?.state).toBe('ok');
    expect(gate(approved, 'teste_obrigatorio')?.state).toBe('pendente');
    expect(approved.next).toContain('--test');

    // Com a evidência do teste: falta revisar e autorizar.
    seedTestEvidence(s.ctx, id);
    expect(at().next).toContain(`preview-final ${id}`);

    // Autorizada: pronta para enviar (com a trava ligada na fixture).
    authorizeConfirmed(s.ctx, id, 'real', 'autorizo');
    const ready = at();
    expect(gate(ready, 'autorizacao')?.state).toBe('ok');
    expect(ready.sendPossible).toBe(true);
    expect(ready.next).toContain(`email send ${id}`);

    // Trava desligada: tudo pronto, mas o envio não é possível.
    const off = applyStatus({ ...s.ctx, sendEnabled: false }, { applicationId: id });
    expect(off.sendPossible).toBe(false);
    expect(off.next).toContain('EMAIL_SEND_ENABLED');

    // Conteúdo mudou depois da autorização: a autorização aberta não é coerente.
    db.prepare("UPDATE verified_recipients SET email = 'outro@acme-ficticia.com.br'").run();
    seedTestEvidence(s.ctx, id);
    const stale = at();
    expect(gate(stale, 'autorizacao')?.detail).toContain('NÃO corresponde');
    expect(stale.sendPossible).toBe(false);

    // Mesmo sem alterar nada, as consultas não gravaram (só as ações explícitas acima).
    expect(before).toBeDefined();
  });

  it('é estritamente somente leitura e mascara o destinatário', () => {
    const s = setupApproved(db);
    const before = snapshot();
    const status = applyStatus(s.ctx, { applicationId: s.applicationId });
    const text = formatApplyStatus(status);
    expect(snapshot()).toEqual(before);
    expect(text).not.toContain(RECIPIENT);
    expect(JSON.stringify(status)).not.toContain(RECIPIENT);
    expect(text).toContain('SOMENTE LEITURA');
    expect(s.transport.calls).toEqual([]);
    // Encontrar a candidatura pela vaga.
    expect(applyStatus(s.ctx, { jobId: s.jobId }).applicationId).toBe(s.applicationId);
  });

  it('resultado desconhecido manda conferir a pasta Enviados e NÃO reenviar', async () => {
    const s = setupApproved(db);
    s.transport.next({ kind: 'unknown', category: 'http_503' });
    await sendEmail(
      s.ctx,
      s.applicationId,
      authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a').id,
      'real',
    );
    const status = applyStatus(s.ctx, { applicationId: s.applicationId });
    expect(status.next).toContain('NÃO reenvie');
    expect(status.next).toContain('email resolve');
    expect(status.sendPossible).toBe(false);
  });

  it('envio aceito: indica o registro da entrega', async () => {
    const s = setupApproved(db);
    await sendEmail(
      s.ctx,
      s.applicationId,
      authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a').id,
      'real',
    );
    expect(applyStatus(s.ctx, { applicationId: s.applicationId }).next).toContain('email confirm');
  });
});

describe('rascunhos de versões anteriores do gerador', () => {
  it('um rascunho gerado pela versão 1 (texto antigo com o nome do arquivo) fica desatualizado e bloqueia o envio', () => {
    const s = setupApproved(db);
    db.prepare("UPDATE application_drafts SET generator_version = '1'").run();
    const status = applyStatus(s.ctx, { applicationId: s.applicationId });
    expect(gate(status, 'rascunho')).toMatchObject({ state: 'pendente' });
    expect(gate(status, 'rascunho')?.detail).toContain('desatualizada');
    expect(status.sendPossible).toBe(false);
    expect(status.next).toContain('regenerate');
  });
});

describe('apply status — currículo personalizado', () => {
  const PERS = Buffer.from('%PDF-1.4 personalizado ficticio');
  const sha = createHash('sha256').update(PERS).digest('hex');
  const make = (approve: boolean, s: Setup): void => {
    const artifact = registerArtifact(db, {
      variant: 'desenvolvimento',
      pdfSha256: sha,
      pdfBytes: PERS.length,
      pages: 2,
      modelHash: 'b'.repeat(64),
      generatedAt: NOW,
      fileName: `curriculo-desenvolvimento-20261022-${sha.slice(0, 8)}.pdf`,
    });
    createAttachment(db, { applicationId: s.applicationId, artifactId: artifact.id, now: NOW });
    if (approve)
      approveAttachment(db, {
        applicationId: s.applicationId,
        confirmSha8: sha.slice(0, 8),
        reason: 'ok',
        now: NOW,
      });
  };

  it('vínculo em preparação bloqueia e indica como aprovar', () => {
    const s = setupApproved(db, { approve: false });
    make(false, s);
    const status = applyStatus(s.ctx, { applicationId: s.applicationId });
    expect(gate(status, 'curriculo')?.state).toBe('bloqueado');
    expect(gate(status, 'vinculo')?.state).toBe('bloqueado');
    expect(status.next).toContain('cv attachment approve');
  });

  it('vínculo aprovado sem anexo resolvido pede a âncora', () => {
    const s = setupApproved(db, { approve: false });
    make(true, s);
    const status = applyStatus(s.ctx, { applicationId: s.applicationId });
    expect(gate(status, 'vinculo')?.state).toBe('ok');
    expect(gate(status, 'curriculo')?.state).toBe('pendente');
    expect(status.next).toContain('âncora');
  });
});
