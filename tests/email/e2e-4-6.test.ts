import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApplication } from '../../src/applications/index.js';
import { formatApplyStatus, applyStatus } from '../../src/apply/status.js';
import {
  approveResumeLink,
  attachResume,
  resolveApprovedAttachment,
} from '../../src/cli/cv-attach.js';
import { formatDryRun } from '../../src/cli/email.js';
import { revokeAttachment } from '../../src/cv/attachments.js';
import { loadStrictInputs } from '../../src/cv/strict-inputs.js';
import { renderAndValidateResume, type StrictResumeResult } from '../../src/cv/strict.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  EmailError,
  approveForSending,
  authorizeSend,
  buildFinalPreview,
  confirmationCode,
  dryRunEmail,
  formatFinalPreview,
  listDispatches,
  preflight,
  recoverEmailDispatches,
  sendEmail,
  type EmailContext,
} from '../../src/email/index.js';
import { NOW } from '../helpers/eligibility.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { makeProject, type Project } from '../helpers/cv-strict-project.js';
import {
  CV_BYTES,
  RECIPIENT,
  TEST_MAILBOX,
  decodeRaw,
  parseMime,
  setupApproved,
  type Setup,
} from '../helpers/email.js';

vi.setConfig({ testTimeout: 120_000 });
const nn = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('valor ausente no teste');
  return value;
};
const hash = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

let L: Loaded;
let proj: Project;
let real: StrictResumeResult;
beforeAll(async () => {
  L = await loadFictional();
  proj = makeProject(L);
  real = await renderAndValidateResume(loadStrictInputs(proj.options).inputFor('generico'));
});
afterAll(() => {
  rmSync(proj.root, { recursive: true, force: true });
});

const PDF = Buffer.from('%PDF-1.7 pdf personalizado do fluxo de ponta a ponta');
const stubRender = () => {
  const result = structuredClone({ report: real.report }) as StrictResumeResult;
  nn(result.report.bindings).pdfSha256 = hash(PDF);
  nn(result.report.diagnostic).pdfSha256 = hash(PDF);
  result.artifact = {
    pdfSha256: hash(PDF),
    pages: nn(real.artifact).pages,
    readBytes: () => Buffer.from(PDF),
  };
  return Promise.resolve(result);
};
const deps = { render: stubRender, now: () => NOW };

let db: Db;
let s: Setup;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
  s = setupApproved(db, { approve: false, testEvidence: false });
});

const code = (ctx: EmailContext): string =>
  confirmationCode(nn(preflight(ctx, s.applicationId, 'real').plan).bindingHash);
const realSends = (): number =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real'").get() as {
      n: number;
    }
  ).n;

/** vaga → preparação → revisão → currículo → aprovação do vínculo → aprovação para envio (personalizado). */
async function approvedPersonalized(): Promise<EmailContext> {
  const attached = await attachResume(
    { db, applicationId: s.applicationId, variant: 'generico', inputs: proj.options },
    deps,
  );
  if (!attached.ok) throw new Error(attached.code);
  const approved = await approveResumeLink(
    {
      db,
      applicationId: s.applicationId,
      confirmSha8: attached.pdfSha8,
      reason: 'conferi o PDF',
      inputs: proj.options,
    },
    deps,
  );
  if (!approved.ok) throw new Error(approved.code);
  const resolved = await resolveApprovedAttachment(
    { db, applicationId: s.applicationId, inputs: proj.options },
    deps,
  );
  if (!resolved.ok) throw new Error(resolved.code);
  const ctx: EmailContext = { ...s.ctx, attachment: resolved.attachment };
  approveForSending(ctx, s.applicationId, 'aprovo o envio');
  return ctx;
}
async function sendTest(ctx: EmailContext): Promise<void> {
  const authorization = authorizeSend(ctx, s.applicationId, 'teste', 'autorizo o teste');
  const result = await sendEmail(ctx, s.applicationId, authorization.id, 'teste');
  expect(result.outcome).toBe('aceito');
}

describe('fluxo completo com Gmail falso (currículo personalizado)', () => {
  it('vaga → preparação → revisão → currículo → aprovações → prévia → teste → autorização → envio → registro', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    // Vaga analisada e candidatura preparada, revisada, com destinatário verificado (fixture).
    expect(
      db.prepare('SELECT verdict FROM job_eligibility WHERE job_id = ?').get(s.jobId),
    ).toBeDefined();
    expect(getApplication(db, s.applicationId)?.status).toBe('preparada');

    const ctx = await approvedPersonalized();
    expect(getApplication(db, s.applicationId)?.status).toBe('aprovada_para_envio');

    // Dry-run: monta o MIME com o PDF personalizado, sem Gmail; ainda sem teste prévio.
    const report = dryRunEmail(ctx, s.applicationId);
    expect(report.message).toMatchObject({
      attachmentSource: 'personalizado',
      attachmentVariant: 'generico',
    });
    expect(report.sendReady).toBe(false);
    expect(s.transport.calls).toEqual([]);

    // Prévia final e código; sem teste, a autorização real é recusada.
    const preview = buildFinalPreview(ctx, s.applicationId);
    expect(preview.recipient?.email).toBe(RECIPIENT);
    expect(preview.attachment).toMatchObject({
      source: 'personalizado',
      variant: 'generico',
      sha8: hash(PDF).slice(0, 8),
    });
    expect(() =>
      authorizeSend(ctx, s.applicationId, 'real', 'autorizo', undefined, preview.code),
    ).toThrow(/teste_previo/);

    // Teste controlado: vai só para a caixa de teste, com o PDF personalizado.
    await sendTest(ctx);
    const testMail = parseMime(decodeRaw(nn(s.transport.calls[0])));
    expect(testMail.headers.to).toBe(TEST_MAILBOX);
    expect(hash(testMail.attachment.bytes)).toBe(hash(PDF));
    expect(realSends()).toBe(0);
    expect(getApplication(db, s.applicationId)?.status).toBe('aprovada_para_envio');

    // Código incorreto é recusado; o correto autoriza UM envio.
    expect(() =>
      authorizeSend(ctx, s.applicationId, 'real', 'autorizo', undefined, 'deadbeef'),
    ).toThrow(EmailError);
    expect(() => authorizeSend(ctx, s.applicationId, 'real', 'autorizo')).toThrow(
      /código de confirmação/,
    );
    const authorization = authorizeSend(
      ctx,
      s.applicationId,
      'real',
      'autorizo este envio',
      undefined,
      code(ctx),
    );
    expect(applyStatus(ctx, { applicationId: s.applicationId }).sendPossible).toBe(true);

    // Com a trava desligada nada sai.
    await expect(
      sendEmail({ ...ctx, sendEnabled: false }, s.applicationId, authorization.id, 'real'),
    ).rejects.toThrow(/EMAIL_SEND_ENABLED/);
    expect(s.transport.calls).toHaveLength(1);

    // Envio simulado (trava ligada na fixture): aceito, registrado, PDF personalizado para o destinatário real.
    const result = await sendEmail(ctx, s.applicationId, authorization.id, 'real');
    expect(result.outcome).toBe('aceito');
    expect(s.transport.calls).toHaveLength(2);
    const sent = parseMime(decodeRaw(nn(s.transport.calls[1])));
    expect(sent.headers.to).toBe(RECIPIENT);
    expect(hash(sent.attachment.bytes)).toBe(hash(PDF));
    expect(sent.text).not.toMatch(/\.pdf/u);
    expect(getApplication(db, s.applicationId)?.status).toBe('enviada');
    expect(
      db.prepare("SELECT cv_sha256 AS sha FROM email_dispatches WHERE kind = 'real'").get(),
    ).toEqual({ sha: hash(PDF) });

    // Nunca reutiliza a autorização nem reenvia.
    await expect(sendEmail(ctx, s.applicationId, authorization.id, 'real')).rejects.toThrow(
      EmailError,
    );
    expect(() =>
      authorizeSend(ctx, s.applicationId, 'real', 'de novo', undefined, 'deadbeef'),
    ).toThrow(EmailError);
    expect(s.transport.calls).toHaveLength(2);

    // Sem dados pessoais nos logs e nas telas de acompanhamento.
    const visible = [
      formatDryRun(report, s.applicationId, 'real'),
      formatApplyStatus(applyStatus(ctx, { applicationId: s.applicationId })),
      JSON.stringify(listDispatches(db, s.applicationId)),
      spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' '))).join('\n'),
    ].join('\n');
    expect(visible).not.toContain(RECIPIENT);
    expect(visible).not.toContain(hash(PDF));
    expect(formatFinalPreview(preview)).toContain(RECIPIENT); // só na prévia explícita
    vi.restoreAllMocks();
  });
});

describe('cenários de falha com Gmail falso', () => {
  async function ready(): Promise<{ ctx: EmailContext; authorizationId: number }> {
    const ctx = await approvedPersonalized();
    await sendTest(ctx);
    const calls = s.transport.calls.length;
    const authorization = authorizeSend(
      ctx,
      s.applicationId,
      'real',
      'autorizo',
      undefined,
      code(ctx),
    );
    expect(s.transport.calls).toHaveLength(calls);
    return { ctx, authorizationId: authorization.id };
  }

  it('currículo revogado depois da autorização: nada sai', async () => {
    const { ctx, authorizationId } = await ready();
    revokeAttachment(db, {
      applicationId: s.applicationId,
      confirmSha8: hash(PDF).slice(0, 8),
      reason: 'trocar',
      now: new Date(NOW.getTime() + 60_000),
    });
    await expect(
      sendEmail(
        { ...ctx, now: () => new Date(NOW.getTime() + 120_000) },
        s.applicationId,
        authorizationId,
        'real',
      ),
    ).rejects.toThrow(EmailError);
    expect(realSends()).toBe(0);
    expect(s.transport.calls).toHaveLength(1); // só o teste
    expect(
      preflight(ctx, s.applicationId, 'real').checks.find((c) => c.id === 'vinculo_curriculo')?.ok,
    ).toBe(false);
  });

  it('autorização vencida ou conteúdo alterado: nada sai', async () => {
    const { ctx, authorizationId } = await ready();
    await expect(
      sendEmail(
        { ...ctx, now: () => new Date(NOW.getTime() + 31 * 60_000) },
        s.applicationId,
        authorizationId,
        'real',
      ),
    ).rejects.toThrow(/venceu/);
    db.prepare("UPDATE verified_recipients SET email = 'outro@acme-ficticia.com.br'").run();
    await expect(sendEmail(ctx, s.applicationId, authorizationId, 'real')).rejects.toThrow(
      EmailError,
    );
    expect(realSends()).toBe(0);
    expect(s.transport.calls).toHaveLength(1);
  });

  it('currículo regenerado com hash diferente: o anexo não é resolvido e o envio é bloqueado', async () => {
    const { ctx } = await ready();
    const other = Buffer.from('%PDF-1.7 outro conteudo');
    const divergent = () => {
      const result = structuredClone({ report: real.report }) as StrictResumeResult;
      nn(result.report.bindings).pdfSha256 = hash(other);
      nn(result.report.diagnostic).pdfSha256 = hash(other);
      result.artifact = {
        pdfSha256: hash(other),
        pages: nn(real.artifact).pages,
        readBytes: () => Buffer.from(other),
      };
      return Promise.resolve(result);
    };
    const out = await resolveApprovedAttachment(
      { db, applicationId: s.applicationId, inputs: proj.options },
      { render: divergent },
    );
    expect(out).toMatchObject({ ok: false, code: 'ARTIFACT_HASH_DIVERGENT' });
    expect(preflight({ ...ctx, attachment: undefined }, s.applicationId, 'real').sendReady).toBe(
      false,
    );
  });

  it('resultado ambíguo: intervenção humana, recuperação sem reenvio e bloqueio dos próximos', async () => {
    const { ctx, authorizationId } = await ready();
    s.transport.next({ kind: 'unknown', category: 'http_503' });
    const result = await sendEmail(ctx, s.applicationId, authorizationId, 'real');
    expect(result.outcome).toBe('desconhecido');
    expect(getApplication(db, s.applicationId)?.status).toBe('pendente_intervencao_humana');
    const calls = s.transport.calls.length;
    expect(
      recoverEmailDispatches(db, {
        olderThanMs: 10 * 60_000,
        now: new Date(NOW.getTime() + 3_600_000),
      }),
    ).toEqual([]);
    expect(() =>
      authorizeSend(ctx, s.applicationId, 'real', 'de novo', undefined, 'deadbeef'),
    ).toThrow(EmailError);
    await expect(sendEmail(ctx, s.applicationId, authorizationId, 'real')).rejects.toThrow(
      EmailError,
    );
    expect(s.transport.calls).toHaveLength(calls);
    expect(applyStatus(ctx, { applicationId: s.applicationId }).next).toContain('NÃO reenvie');
  });

  it('queda depois de reservar: a recuperação marca incerto e nada é reenviado', async () => {
    const { ctx, authorizationId } = await ready();
    s.transport.next(() => {
      throw new Error('processo caiu');
    });
    const result = await sendEmail(ctx, s.applicationId, authorizationId, 'real');
    expect(result.outcome).toBe('desconhecido');
    expect(realSends()).toBe(1);
  });
});

describe('compatibilidade com o currículo mestre', () => {
  it('candidatura sem vínculo percorre o mesmo fluxo com o mestre e as mesmas travas', async () => {
    const plain = setupApproved(db, {
      job: { title: 'Estágio em Dados', company: 'Mestre Ficticia' },
      recipient: 'rh@mestre-ficticia.com.br',
      testEvidence: false,
    });
    const ctx = plain.ctx;
    expect(preflight(ctx, plain.applicationId, 'real').plan?.attachmentSource).toBe('mestre');
    const t = authorizeSend(ctx, plain.applicationId, 'teste', 'teste');
    expect((await sendEmail(ctx, plain.applicationId, t.id, 'teste')).outcome).toBe('aceito');
    const plan = nn(preflight(ctx, plain.applicationId, 'real').plan);
    const a = authorizeSend(
      ctx,
      plain.applicationId,
      'real',
      'autorizo',
      undefined,
      confirmationCode(plan.bindingHash),
    );
    expect((await sendEmail(ctx, plain.applicationId, a.id, 'real')).outcome).toBe('aceito');
    const sent = parseMime(decodeRaw(nn(plain.transport.calls[1])));
    expect(sent.attachment.bytes.equals(CV_BYTES)).toBe(true);
    expect(getApplication(db, plain.applicationId)?.status).toBe('enviada');
  });
});
