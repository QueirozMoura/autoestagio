import { beforeEach, describe, expect, it } from 'vitest';
import { getApplication, getHistory } from '../../src/applications/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  EmailError,
  approveForSending,
  dryRunEmail,
  listDispatches,
  preflight,
  recordConfirmation,
  recoverEmailDispatches,
  resolveUnknownDispatch,
  sendEmail,
  verifyRecipientFromJob,
} from '../../src/email/index.js';
import { profileHash } from '../../src/eligibility/index.js';
import { seedJob } from '../helpers/applications.js';
import { NOW } from '../helpers/eligibility.js';
import {
  CV_BYTES,
  CV_SHA,
  RECIPIENT,
  authorizeConfirmed,
  seedTestEvidence,
  TEST_MAILBOX,
  decodeRaw,
  parseMime,
  setupApproved,
  type Setup,
} from '../helpers/email.js';

let db: Db;
let s: Setup;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
  s = setupApproved(db);
});

const authorize = (kind: 'real' | 'teste' = 'real', setup = s) =>
  authorizeConfirmed(
    setup.ctx,
    setup.applicationId,
    kind,
    'autorizo este envio específico (teste)',
  );
const status = (setup = s) => getApplication(setup.db, setup.applicationId)?.status;
/** Conta linhas; em `email_dispatches` só as de envio REAL (a evidência de teste da fixture não conta). */
const count = (table: string): number =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table}${table === 'email_dispatches' ? " WHERE kind = 'real'" : ''}`,
      )
      .get() as { n: number }
  ).n;
const failing = (ctx = s.ctx, kind: 'real' | 'teste' = 'real') =>
  preflight(ctx, s.applicationId, kind)
    .checks.filter((c) => !c.ok && c.id !== 'teste_previo')
    .map((c) => c.id);

describe('ensaio (dry-run) — padrão, nunca chama o Gmail', () => {
  it('verifica tudo, monta a mensagem exata e não envia nada nem precisa de token', () => {
    const report = dryRunEmail(s.ctx, s.applicationId);
    expect(report).toMatchObject({ ok: true, sendReady: true });
    expect(report.message).toMatchObject({
      recipientMasked: 'r***@acme-ficticia.com.br',
      attachmentBytes: CV_BYTES.length,
      attachmentSha256Prefix: CV_SHA.slice(0, 12),
    });
    expect(report.message?.subject).toBe(
      'Candidatura - Estágio em Desenvolvimento Backend - Pessoa Exemplo',
    );
    expect(s.transport.calls).toEqual([]);
    expect(status()).toBe('aprovada_para_envio'); // dry-run não muda estado
    expect(count('email_dispatches')).toBe(0);
    expect(getHistory(db, s.applicationId).at(-1)?.reason).toContain('nada foi enviado');
  });

  it('com a trava mestra desligada o ensaio funciona, mas indica que nenhum envio é possível', () => {
    const off = setupApproved(openDb(), { sendEnabled: false });
    const report = dryRunEmail(off.ctx, off.applicationId);
    expect(report).toMatchObject({ ok: true, sendReady: false });
    expect(report.checks.find((c) => c.id === 'envio_habilitado')).toMatchObject({
      ok: false,
      sendOnly: true,
    });
  });

  it('sem nenhuma verificação passando não monta mensagem', () => {
    const bare = setupApproved(openDb(), { approve: false });
    expect(dryRunEmail(bare.ctx, bare.applicationId).sendReady).toBe(false);
  });
});

function openDb(): Db {
  const fresh = openDatabase(IN_MEMORY);
  runMigrations(fresh);
  return fresh;
}

describe('verificações antes de enviar (bloqueios)', () => {
  it('currículo alterado no disco: bloqueia, mesmo com tudo o mais ok', () => {
    s.cv.bytes = Buffer.from('%PDF-1.4 OUTRA VERSAO');
    expect(failing()).toEqual(['curriculo_confere']);
    expect(dryRunEmail(s.ctx, s.applicationId).ok).toBe(false);
    expect(() => authorize()).toThrow(/curriculo_confere/);
  });

  it('arquivo que não é PDF, vazio ou grande demais', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('texto simples')]) {
      s.cv.bytes = bytes;
      expect(failing()).toContain('curriculo_confere');
    }
  });

  it('currículo ilegível (arquivo sumiu)', () => {
    const broken = {
      ...s.ctx,
      readCv: () => {
        throw new Error('ENOENT');
      },
    };
    expect(failing(broken)).toContain('curriculo_confere');
  });

  it('perfil sem aprovação', () => {
    const noApproval = { ...s.ctx, profile: { ...s.ctx.profile, approval: undefined } };
    expect(failing(noApproval)).toContain('perfil_aprovado');
  });

  it('rascunho não revisado, estado errado e modo dry-run', () => {
    const fresh = setupApproved(openDb(), { approve: false });
    expect(
      preflight(fresh.ctx, fresh.applicationId, 'real')
        .checks.filter((c) => !c.ok && c.id !== 'teste_previo')
        .map((c) => c.id),
    ).toEqual(['estado_e_modo']);
    // sem revisão
    const unreviewed = openDb();
    const u = setupApproved(unreviewed, { approve: false });
    unreviewed.prepare('UPDATE application_drafts SET reviewed_hash = NULL').run();
    expect(
      preflight(u.ctx, u.applicationId, 'real')
        .checks.filter((c) => !c.ok)
        .map((c) => c.id),
    ).toContain('rascunho_revisado');
    expect(() => approveForSending(u.ctx, u.applicationId, 'x')).toThrow(/rascunho_revisado/);
  });

  it('sem destinatário verificado (e nunca adivinha um)', () => {
    const other = openDb();
    const o = setupApproved(other, { approve: false });
    other.prepare('DELETE FROM verified_recipients').run();
    expect(
      preflight(o.ctx, o.applicationId, 'real').checks.find(
        (c) => c.id === 'destinatario_verificado',
      )?.ok,
    ).toBe(false);
    expect(() => approveForSending(o.ctx, o.applicationId, 'x')).toThrow(/destinatario_verificado/);
    expect(o.transport.calls).toEqual([]);
  });

  it('endereço fora da vaga não vira destinatário (não há como "adicionar" um chute)', () => {
    expect(() => verifyRecipientFromJob(db, s.jobId, 'vagas@acme-ficticia.com.br')).toThrow(
      /não aparece/,
    );
  });

  it('provedor gratuito não confirmado não serve de destinatário', () => {
    const d = openDb();
    const gm = setupApproved(d, {
      approve: false,
      job: { description: `Requisitos: SQL. Contato: vagas.acme@gmail.com ou ${RECIPIENT}` },
    });
    d.prepare('DELETE FROM verified_recipients').run();
    expect(() => verifyRecipientFromJob(d, gm.jobId, 'vagas.acme@gmail.com')).toThrow(
      /provedor gratuito/,
    );
    expect(
      preflight(gm.ctx, gm.applicationId, 'real').checks.find(
        (c) => c.id === 'destinatario_verificado',
      )?.ok,
    ).toBe(false);
  });

  it('análise de elegibilidade desatualizada (perfil mudou) bloqueia', () => {
    db.prepare("UPDATE job_eligibility SET profile_hash = 'outro'").run();
    expect(failing()).toContain('elegibilidade_atual');
  });

  it('limite diário de envios reais', () => {
    expect(failing({ ...s.ctx, maxPerDay: 0 })).toContain('limite_diario');
  });

  it('trava mestra desligada: sendEmail recusa antes de qualquer coisa', async () => {
    await expect(
      sendEmail({ ...s.ctx, sendEnabled: false }, s.applicationId, 1, 'real'),
    ).rejects.toThrow(/EMAIL_SEND_ENABLED/);
    expect(s.transport.calls).toEqual([]);
    expect(count('email_dispatches')).toBe(0);
  });
});

describe('autorização específica e de uso único', () => {
  it('sem autorização válida não envia nada', async () => {
    await expect(sendEmail(s.ctx, s.applicationId, 999, 'real')).rejects.toThrow(
      /autorização inexistente/,
    );
    expect(s.transport.calls).toEqual([]);
    expect(status()).toBe('aprovada_para_envio');
  });

  it('autorização expirada', async () => {
    const auth = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'ok', 5);
    const later = { ...s.ctx, now: () => new Date(NOW.getTime() + 6 * 60_000) };
    await expect(sendEmail(later, s.applicationId, auth.id, 'real')).rejects.toThrow(/venceu/);
    expect(s.transport.calls).toEqual([]);
  });

  it('autorização de teste não vale para envio real, nem de outra candidatura', async () => {
    const test = authorize('teste');
    await expect(sendEmail(s.ctx, s.applicationId, test.id, 'real')).rejects.toThrow(
      /inexistente para esta candidatura\/tipo/,
    );
    const d2 = openDb();
    const other = setupApproved(d2);
    const foreign = authorize('real', other);
    await expect(sendEmail(s.ctx, s.applicationId, foreign.id, 'real')).rejects.toThrow(EmailError);
    expect(s.transport.calls).toEqual([]);
  });

  it('é amarrada ao conteúdo: se o destinatário mudar depois, não vale mais', async () => {
    const auth = authorize();
    db.prepare("UPDATE verified_recipients SET email = 'outro@acme-ficticia.com.br'").run();
    // Para isolar a vinculação, o teste prévio é refeito para o novo destinatário.
    seedTestEvidence(s.ctx, s.applicationId);
    await expect(sendEmail(s.ctx, s.applicationId, auth.id, 'real')).rejects.toThrow(
      /mudaram depois da autorização/,
    );
    expect(s.transport.calls).toEqual([]);
  });

  it('é amarrada ao currículo: trocar o arquivo entre autorizar e enviar bloqueia', async () => {
    const auth = authorize();
    s.cv.bytes = Buffer.from('%PDF-1.4 versao nova');
    await expect(sendEmail(s.ctx, s.applicationId, auth.id, 'real')).rejects.toThrow(
      /curriculo_confere/,
    );
    expect(s.transport.calls).toEqual([]);
    expect(count('email_dispatches')).toBe(0);
  });

  it('é de uso único', async () => {
    const auth = authorize();
    await sendEmail(s.ctx, s.applicationId, auth.id, 'real');
    await expect(sendEmail(s.ctx, s.applicationId, auth.id, 'real')).rejects.toThrow(EmailError);
    expect(s.transport.calls).toHaveLength(1);
    expect(() => db.prepare('UPDATE email_authorizations SET used_at = NULL').run()).toThrow(
      /já usada/,
    );
  });

  it('exige motivo e validade razoável', () => {
    expect(() => authorizeConfirmed(s.ctx, s.applicationId, 'real', '  ')).toThrow(/motivo/);
    expect(() => authorizeConfirmed(s.ctx, s.applicationId, 'real', 'ok', 0)).toThrow(/validade/);
    expect(() => authorizeConfirmed(s.ctx, s.applicationId, 'real', 'ok', 1000)).toThrow(
      /validade/,
    );
  });
});

describe('envio aceito pelo Gmail', () => {
  it('reserva, chama o Gmail uma vez, registra o id e marca "enviada" (não "entrega confirmada")', async () => {
    const auth = authorize();
    const result = await sendEmail(s.ctx, s.applicationId, auth.id, 'real');
    expect(result).toMatchObject({ outcome: 'aceito', gmailMessageId: 'fake-1' });
    expect(s.transport.calls).toHaveLength(1);

    expect(getApplication(db, s.applicationId)).toMatchObject({
      status: 'enviada',
      channel: 'email',
      appliedAt: NOW.toISOString(),
    });
    const view = listDispatches(db, s.applicationId);
    // A evidência de teste da fixture (kind "teste") não faz parte deste envio real.
    expect(view.dispatches.filter((d) => d.kind === 'real')).toEqual([
      expect.objectContaining({
        status: 'aceito',
        kind: 'real',
        hasGmailMessageId: true,
        recipientMasked: 'r***@acme-ficticia.com.br',
      }),
    ]);
    expect(view.confirmations.map((c) => c.kind)).toEqual(['aceito_pelo_gmail']); // só isto: sem entrega, sem recebimento
    expect(
      db
        .prepare(
          "SELECT gmail_message_id, gmail_thread_id FROM email_dispatches WHERE kind = 'real'",
        )
        .get(),
    ).toEqual({ gmail_message_id: 'fake-1', gmail_thread_id: 'fake-thread' });

    const transitions = getHistory(db, s.applicationId).map((e) => e.toStatus);
    expect(transitions.slice(-2)).toEqual(['enviando', 'enviada']);
  });

  it('a mensagem enviada tem só o destinatário verificado e o PDF aprovado, byte a byte', async () => {
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    const mime = parseMime(decodeRaw(s.transport.calls[0] ?? ''));
    expect(mime.headers.to).toBe(RECIPIENT);
    expect(mime.rawHeaders).not.toMatch(/^(cc|bcc):/im);
    expect(mime.attachment.contentType).toBe('application/pdf');
    expect(mime.attachment.bytes.equals(CV_BYTES)).toBe(true);
    expect(mime.text).toContain('Olá, equipe Acme Ficticia,');
    expect(mime.headers.subject).toMatch(/Candidatura/);
  });

  it('entrega e recebimento são confirmações separadas, informadas por uma pessoa', async () => {
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(() => {
      recordConfirmation(db, s.applicationId, 'entrega', '  ', NOW);
    }).toThrow(/evidência/);

    recordConfirmation(db, s.applicationId, 'recebimento_empresa', 'RH respondeu em 23/10', NOW);
    expect(status()).toBe('enviada'); // recebimento não muda o estado
    recordConfirmation(db, s.applicationId, 'entrega', 'nenhuma devolução em 48 h', NOW);
    expect(status()).toBe('entrega_confirmada');
    expect(
      listDispatches(db, s.applicationId).confirmations.map((c) => `${c.kind}:${c.by}`),
    ).toEqual(['aceito_pelo_gmail:sistema', 'recebimento_empresa:usuario', 'entrega:usuario']);
    expect(() => db.prepare('UPDATE application_confirmations SET evidence = ?').run('x')).toThrow(
      /imutável/,
    );
  });

  it('recebimento só para candidatura enviada', () => {
    expect(() => {
      recordConfirmation(db, s.applicationId, 'recebimento_empresa', 'x', NOW);
    }).toThrow(/enviada/);
  });
});

describe('nunca reenviar', () => {
  it('uma segunda autorização para a mesma candidatura não envia de novo', async () => {
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(() => authorize()).toThrow(/estado_e_modo|sem_envio_anterior/);
    expect(s.transport.calls).toHaveLength(1);
  });

  it('o banco impede dois envios reais ativos para a mesma candidatura', async () => {
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    const insert = () =>
      db
        .prepare(
          `INSERT INTO email_dispatches (application_id, kind, recipient_id, recipient_masked, status, rfc_message_id, cv_sha256, content_hash, authorization_id, reserved_at)
           VALUES (?, 'real', 1, 'x', 'reservado', '<a@b.c>', ?, 'h', 1, 'x')`,
        )
        .run(s.applicationId, CV_SHA);
    expect(insert).toThrow(/UNIQUE/);
  });

  it('vaga equivalente já enviada bloqueia o envio da outra', async () => {
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    db.prepare("UPDATE jobs SET identity_key = 'gemea' WHERE id = ?").run(s.jobId);
    const twinJob = seedJob(db, {
      identityKey: 'gemea',
      company: 'Acme Ficticia',
      description: `Requisitos: SQL.\nEnvie para ${RECIPIENT}`,
      workMode: 'remoto',
      location: 'Remote - Brazil',
      stipend: 1800,
      verdict: null,
    });
    const twin = setupTwin(twinJob);
    expect(twin).toContain('sem_envio_anterior');
  });

  function setupTwin(jobId: number): string[] {
    // prepara a gêmea com reconhecimento explícito e tenta aprovar/enviar
    const { prepareApplication, answerRequirement } = require_preparation();
    const result = prepareApplication(db, {
      profile: s.ctx.profile,
      cv: { sha256: CV_SHA, label: 'c.pdf' },
      jobId,
      channel: 'email',
      acknowledgeEquivalent: { reason: 'teste' },
      now: NOW,
    });
    if (result.outcome === 'recusada') throw new Error(result.reason);
    verifyRecipientFromJob(db, jobId, RECIPIENT, { now: NOW });
    answerRequirement(db, result.applicationId, 'destinatario_verificado', 'ok', NOW);
    preparation.markReviewed(db, result.applicationId, profileHash(s.ctx.profile), NOW);
    return preflight(s.ctx, result.applicationId, 'real')
      .checks.filter((c) => !c.ok)
      .map((c) => c.id);
  }
});

import * as preparation from '../../src/preparation/index.js';
const require_preparation = () => preparation;

describe('recusa do Gmail antes de enviar', () => {
  it('vira "falhou", registra só a categoria e não reenvia sozinho', async () => {
    s.transport.next({ kind: 'rejected', category: 'http_403' });
    const result = await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(result).toEqual({
      outcome: 'rejeitado',
      dispatchId: expect.any(Number) as number,
      category: 'http_403',
    });
    expect(status()).toBe('falhou');
    expect(s.transport.calls).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT status, error_category, gmail_message_id FROM email_dispatches WHERE kind = 'real'",
        )
        .get(),
    ).toEqual({ status: 'rejeitado', error_category: 'http_403', gmail_message_id: null });
    expect(listDispatches(db, s.applicationId).confirmations).toEqual([]);
  });

  it('refazer exige uma pessoa: "falhou" → "preparada" (usuário) → nova revisão/aprovação → nova autorização', async () => {
    s.transport.next({ kind: 'rejected', category: 'http_401' });
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(() => transitionAs('sistema')).toThrow(/só uma pessoa/);
    transitionAs('usuario');
    expect(status()).toBe('preparada');
    expect(() => authorize()).toThrow(/estado_e_modo/);
  });

  function transitionAs(actor: 'sistema' | 'usuario') {
    return transition(db, s.applicationId, { to: 'preparada', reason: 'refazer', actor }, NOW);
  }
});

import { transitionApplication as transition } from '../../src/applications/index.js';

describe('resultado desconhecido: nunca reenviar', () => {
  it.each([
    ['erro 503', { kind: 'unknown', category: 'http_503' } as const],
    ['timeout', { kind: 'unknown', category: 'rede_ou_timeout' } as const],
    ['resposta ilegível', { kind: 'unknown', category: 'resposta_ilegivel' } as const],
  ])('%s → pendente de intervenção humana, sem reenvio', async (_name, outcome) => {
    s.transport.next(outcome);
    const result = await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(result.outcome).toBe('desconhecido');
    expect(status()).toBe('pendente_intervencao_humana');
    expect(s.transport.calls).toHaveLength(1);
    expect(getHistory(db, s.applicationId).at(-1)?.reason).toContain('NÃO reenviar');
    expect(() => authorize()).toThrow(/estado_e_modo|sem_envio_anterior/);
    expect(count('email_dispatches')).toBe(1);
  });

  it('exceção no transporte também é "desconhecido"', async () => {
    s.transport.next(new Error('socket hang up'));
    expect((await sendEmail(s.ctx, s.applicationId, authorize().id, 'real')).outcome).toBe(
      'desconhecido',
    );
    expect(status()).toBe('pendente_intervencao_humana');
  });

  it('o sistema não consegue resolver sozinho; uma pessoa confere a pasta Enviados e decide', async () => {
    s.transport.next({ kind: 'unknown', category: 'http_503' });
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(() =>
      transition(db, s.applicationId, { to: 'enviada', reason: 'x', actor: 'sistema' }, NOW),
    ).toThrow(/só uma pessoa/);

    resolveUnknownDispatch(db, s.applicationId, { sent: true, evidence: 'achei em Enviados' }, NOW);
    expect(status()).toBe('enviada');
    expect(
      db.prepare("SELECT status, error_category FROM email_dispatches WHERE kind = 'real'").get(),
    ).toEqual({
      status: 'aceito',
      error_category: 'confirmado_manualmente',
    });
    expect(listDispatches(db, s.applicationId).confirmations.at(-1)).toMatchObject({
      kind: 'aceito_pelo_gmail',
      by: 'usuario',
    });
  });

  it('se a pessoa confirma que NÃO saiu, vira "falhou" (sem reenvio automático)', async () => {
    s.transport.next({ kind: 'unknown', category: 'http_500' });
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    resolveUnknownDispatch(
      db,
      s.applicationId,
      { sent: false, evidence: 'não está em Enviados' },
      NOW,
    );
    expect(status()).toBe('falhou');
    expect(s.transport.calls).toHaveLength(1);
    expect(() => {
      resolveUnknownDispatch(db, s.applicationId, { sent: true, evidence: 'x' }, NOW);
    }).toThrow(/não há envio/);
  });
});

describe('nenhum resultado permite reenvio automático', () => {
  it.each([
    [
      'aceito',
      { kind: 'accepted', messageId: 'm1', threadId: undefined, labelIds: [] as string[] } as const,
    ],
    ['recusado', { kind: 'rejected', category: 'http_403' } as const],
    ['desconhecido (5xx)', { kind: 'unknown', category: 'http_503' } as const],
    ['desconhecido (429)', { kind: 'unknown', category: 'http_429' } as const],
    ['desconhecido (rede)', { kind: 'unknown', category: 'rede_ou_timeout' } as const],
  ])(
    '%s: depois do envio, nada nem ninguém sem decisão humana consegue chamar o Gmail de novo',
    async (_name, outcome) => {
      s.transport.next(outcome);
      await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
      expect(s.transport.calls).toHaveLength(1);

      // nova autorização: bloqueada (estado e envio anterior)
      expect(() => authorize()).toThrow(EmailError);
      // autorização antiga (já usada) e inventada: recusadas
      await expect(sendEmail(s.ctx, s.applicationId, 1, 'real')).rejects.toThrow(EmailError);
      // recuperação não reenvia
      recoverEmailDispatches(db, { olderThanMs: 0, now: new Date(NOW.getTime() + 3_600_000) });
      expect(s.transport.calls).toHaveLength(1);
      expect(count('email_dispatches')).toBe(1);
    },
  );

  it('mesmo depois de "recusado", só uma pessoa reabre o preparo; o sistema nunca o faz', async () => {
    s.transport.next({ kind: 'rejected', category: 'http_401' });
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');
    expect(() =>
      transition(
        db,
        s.applicationId,
        { to: 'preparada', reason: 'automático', actor: 'sistema' },
        NOW,
      ),
    ).toThrow(/só uma pessoa/);
    expect(() =>
      transition(
        db,
        s.applicationId,
        { to: 'enviando', reason: 'automático', actor: 'sistema' },
        NOW,
      ),
    ).toThrow();
    expect(s.transport.calls).toHaveLength(1);
  });
});

describe('recuperação após falha do processo', () => {
  it('queda depois de reservar: a recuperação marca desconhecido e pede intervenção; nada é reenviado', async () => {
    // O Gmail "aceita", mas o registro do resultado falha (simula o processo caindo antes de gravar).
    db.exec(
      "CREATE TRIGGER falha_ao_registrar BEFORE UPDATE ON email_dispatches WHEN NEW.status = 'aceito' BEGIN SELECT RAISE(ABORT, 'queda simulada'); END",
    );
    await expect(sendEmail(s.ctx, s.applicationId, authorize().id, 'real')).rejects.toThrow(
      /queda simulada/,
    );
    db.exec('DROP TRIGGER falha_ao_registrar');

    expect(s.transport.calls).toHaveLength(1);
    expect(status()).toBe('enviando');
    expect(db.prepare("SELECT status FROM email_dispatches WHERE kind = 'real'").get()).toEqual({
      status: 'reservado',
    });

    // ainda não passou tempo suficiente
    expect(
      recoverEmailDispatches(db, {
        olderThanMs: 10 * 60_000,
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toEqual([]);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(recoverEmailDispatches(db, { olderThanMs: 10 * 60_000, now: later })).toHaveLength(1);
    expect(status()).toBe('pendente_intervencao_humana');
    expect(
      db.prepare("SELECT status, error_category FROM email_dispatches WHERE kind = 'real'").get(),
    ).toEqual({
      status: 'desconhecido',
      error_category: 'processo_interrompido',
    });

    // idempotente e sem reenvio
    expect(recoverEmailDispatches(db, { olderThanMs: 10 * 60_000, now: later })).toEqual([]);
    expect(s.transport.calls).toHaveLength(1);
    expect(() => authorize()).toThrow(/estado_e_modo|sem_envio_anterior/);
  });

  it('o banco continua impedindo um segundo envio enquanto o primeiro está reservado', async () => {
    db.exec(
      "CREATE TRIGGER falha_ao_registrar BEFORE UPDATE ON email_dispatches WHEN NEW.status = 'aceito' BEGIN SELECT RAISE(ABORT, 'queda'); END",
    );
    await expect(sendEmail(s.ctx, s.applicationId, authorize().id, 'real')).rejects.toThrow();
    db.exec('DROP TRIGGER falha_ao_registrar');
    expect(failing()).toContain('sem_envio_anterior');
  });
});

describe('envio de TESTE para a sua caixa', () => {
  it('vai só para a caixa de teste, marcado como teste, e NÃO altera o estado nem confirma nada', async () => {
    const auth = authorize('teste');
    const result = await sendEmail(s.ctx, s.applicationId, auth.id, 'teste');
    expect(result.outcome).toBe('aceito');

    const mime = parseMime(decodeRaw(s.transport.calls[0] ?? ''));
    expect(mime.headers.to).toBe(TEST_MAILBOX);
    expect(mime.headers.to).not.toBe(RECIPIENT);
    expect(mime.headers.subject).toMatch(/^\[TESTE AutoEstagio\]/);
    expect(mime.text).toContain('MENSAGEM DE TESTE');
    expect(mime.attachment.bytes.equals(CV_BYTES)).toBe(true);

    expect(status()).toBe('aprovada_para_envio');
    expect(getApplication(db, s.applicationId)?.appliedAt).toBeNull();
    expect(listDispatches(db, s.applicationId).confirmations).toEqual([]);
    expect(
      db
        .prepare("SELECT kind, status FROM email_dispatches WHERE kind = 'teste' ORDER BY id DESC")
        .get(),
    ).toEqual({
      kind: 'teste',
      status: 'aceito',
    });
  });

  it('o teste não gasta o envio real: depois dele o envio real continua possível', async () => {
    await sendEmail(s.ctx, s.applicationId, authorize('teste').id, 'teste');
    const real = await sendEmail(s.ctx, s.applicationId, authorize('real').id, 'real');
    expect(real.outcome).toBe('aceito');
    expect(s.transport.calls).toHaveLength(2);
    expect(status()).toBe('enviada');
  });

  it('exige caixa de teste configurada e o rascunho em dia', () => {
    expect(() =>
      authorizeConfirmed({ ...s.ctx, testMailbox: undefined }, s.applicationId, 'teste', 'ok'),
    ).toThrow(/caixa_de_teste/);
    expect(() =>
      authorizeConfirmed({ ...s.ctx, testMailbox: 'invalido' }, s.applicationId, 'teste', 'ok'),
    ).toThrow(/caixa_de_teste/);
  });

  it('também exige a trava mestra ligada', async () => {
    const auth = authorize('teste');
    await expect(
      sendEmail({ ...s.ctx, sendEnabled: false }, s.applicationId, auth.id, 'teste'),
    ).rejects.toThrow(/EMAIL_SEND_ENABLED/);
    expect(s.transport.calls).toEqual([]);
  });

  it('pode ser feito antes da aprovação (candidatura só "preparada")', async () => {
    const d = openDb();
    const fresh = setupApproved(d, { approve: false });
    const auth = authorizeConfirmed(fresh.ctx, fresh.applicationId, 'teste', 'ok');
    expect((await sendEmail(fresh.ctx, fresh.applicationId, auth.id, 'teste')).outcome).toBe(
      'aceito',
    );
    expect(getApplication(d, fresh.applicationId)?.status).toBe('preparada');
  });
});

describe('sigilo', () => {
  it('mensagens de erro e o histórico não expõem endereços completos, SHA completo, tokens nem o corpo', async () => {
    const errors: string[] = [];
    const attempt = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (error) {
        errors.push((error as Error).message);
      }
    };
    s.cv.bytes = Buffer.from('%PDF-1.4 outra');
    await attempt(() => authorize());
    s.cv.bytes = CV_BYTES;
    await attempt(() => sendEmail(s.ctx, s.applicationId, 999, 'real'));
    s.transport.next({ kind: 'rejected', category: 'http_403' });
    await sendEmail(s.ctx, s.applicationId, authorize().id, 'real');

    const everything = [
      ...errors,
      JSON.stringify(getHistory(db, s.applicationId)),
      JSON.stringify(listDispatches(db, s.applicationId)),
      JSON.stringify(dryRunEmail(openCtx(), 1)),
    ].join('\n');
    expect(everything).not.toContain(RECIPIENT);
    expect(everything).not.toContain(CV_SHA);
    expect(everything).not.toContain('Olá, equipe');
    expect(everything).not.toMatch(/token|Bearer/i);
  });

  function openCtx() {
    return s.ctx;
  }
});

describe('aprovação para envio', () => {
  it('exige motivo, só vale para "preparada" e não envia nada', () => {
    const d = openDb();
    const fresh = setupApproved(d, { approve: false });
    expect(() => approveForSending(fresh.ctx, fresh.applicationId, ' ')).toThrow(/motivo/);
    const application = approveForSending(fresh.ctx, fresh.applicationId, 'revisei e concordo');
    expect(application).toMatchObject({
      status: 'aprovada_para_envio',
      mode: 'revisao',
      channel: 'email',
    });
    expect(fresh.transport.calls).toEqual([]);
    expect(() => approveForSending(fresh.ctx, fresh.applicationId, 'de novo')).toThrow(/preparada/);
  });

  it('rascunho que mudou depois da revisão precisa ser revisado de novo', () => {
    const d = openDb();
    const fresh = setupApproved(d, { approve: false });
    d.prepare("UPDATE jobs SET content_hash = 'mudou' WHERE id = ?").run(fresh.jobId);
    expect(() => approveForSending(fresh.ctx, fresh.applicationId, 'x')).toThrow(
      /rascunho_revisado|elegibilidade/,
    );
  });
});
