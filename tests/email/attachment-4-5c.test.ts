import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync as realLink,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApplication, getHistory, transitionApplication } from '../../src/applications/index.js';
import {
  approveResumeLink,
  attachResume,
  resolveApprovedAttachment,
} from '../../src/cli/cv-attach.js';
import { formatDryRun } from '../../src/cli/email.js';
import {
  approveAttachment,
  classifyAttachment,
  createAttachment,
  registerArtifact,
  revokeAttachment,
  type ResolvedAttachment,
} from '../../src/cv/attachments.js';
import { loadStrictInputs } from '../../src/cv/strict-inputs.js';
import { renderAndValidateResume, type StrictResumeResult } from '../../src/cv/strict.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  EmailError,
  approveForSending,
  bindingHashOf,
  dryRunEmail,
  exportEml,
  preflight,
  sendEmail,
  verifyMime,
  type EmailContext,
} from '../../src/email/index.js';
import { buildMime } from '../../src/email/mime.js';
import { SafeWriteError } from '../../src/utils/safe-write.js';
import { NOW } from '../helpers/eligibility.js';
import {
  CV_BYTES,
  CV_SHA,
  RECIPIENT,
  TEST_MAILBOX,
  authorizeConfirmed,
  parseMime,
  seedTestEvidence,
  setupApproved,
  type Setup,
} from '../helpers/email.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { makeProject, sha, type Project } from '../helpers/cv-strict-project.js';

vi.setConfig({ testTimeout: 120_000 });
const nn = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('valor ausente no teste');
  return value;
};
const hash = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const PERS = Buffer.from('%PDF-1.4\n% curriculo personalizado ficticio\n%%EOF\n');
const PERS_SHA = hash(PERS);
const MODEL = 'b'.repeat(64);
const FILE = `curriculo-desenvolvimento-20261023-${PERS_SHA.slice(0, 8)}.pdf`;
const AT = new Date('2026-10-23T12:00:00.000Z');

let db: Db;
let s: Setup;
const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'eml-'));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
  s = setupApproved(db, { approve: false });
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Conta linhas; em `email_dispatches` só as de envio REAL (a evidência de teste da fixture não conta). */
const count = (table: string): number =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table}${table === 'email_dispatches' ? " WHERE kind = 'real'" : ''}`,
      )
      .get() as { n: number }
  ).n;
const failing = (ctx: EmailContext = s.ctx, kind: 'real' | 'teste' = 'real'): string[] =>
  preflight(ctx, s.applicationId, kind)
    .checks.filter(
      (c) => !c.ok && c.sendOnly !== true && c.id !== 'estado_e_modo' && c.id !== 'teste_previo',
    )
    .map((c) => c.id);

/** Banco novo, migrado, com candidatura preparada (e aprovada para envio, se pedido). */
function freshSetup(options: { approve?: boolean; sendEnabled?: boolean } = {}): Setup {
  const fresh = openDatabase(IN_MEMORY);
  runMigrations(fresh);
  return setupApproved(fresh, options);
}

function artifactFor(bytes: Buffer = PERS, variant = 'desenvolvimento', model = MODEL): number {
  const digest = hash(bytes);
  return registerArtifact(db, {
    variant,
    pdfSha256: digest,
    pdfBytes: bytes.length,
    pages: 2,
    modelHash: model,
    generatedAt: AT,
    fileName: `curriculo-${variant}-20261023-${digest.slice(0, 8)}.pdf`,
  }).id;
}
/** Cria o vínculo (em preparação) e, opcionalmente, aprova. A candidatura precisa estar preparada. */
function link(approve: boolean, bytes: Buffer = PERS): number {
  const artifactId = artifactFor(bytes);
  createAttachment(db, { applicationId: s.applicationId, artifactId, now: AT });
  if (approve)
    approveAttachment(db, {
      applicationId: s.applicationId,
      confirmSha8: hash(bytes).slice(0, 8),
      reason: 'conferi',
      now: AT,
    });
  return artifactId;
}
function resolved(over: Partial<ResolvedAttachment> = {}): ResolvedAttachment {
  const c = classifyAttachment(db, s.applicationId);
  if (c.kind !== 'aprovado') throw new Error('sem vínculo aprovado');
  return {
    applicationId: s.applicationId,
    jobId: s.jobId,
    linkId: c.link.id,
    variant: c.link.variant,
    pdfSha256: c.link.pdfSha256,
    modelHash: c.link.modelHash,
    fileName: c.link.fileName,
    bytes: Buffer.from(PERS),
    ...over,
  };
}
const withAttachment = (att?: ResolvedAttachment): EmailContext => ({ ...s.ctx, attachment: att });
/** Candidatura pronta para envio com vínculo aprovado e anexo resolvido. */
function personalized(): EmailContext {
  link(true);
  const ctx = withAttachment(resolved());
  approveForSending(ctx, s.applicationId, 'teste');
  seedTestEvidence(ctx, s.applicationId);
  s.ctx = ctx;
  return ctx;
}

describe('seleção do anexo no preflight', () => {
  it('candidatura sem vínculo continua usando o currículo mestre, com o formato de vínculo anterior', () => {
    approveForSending(s.ctx, s.applicationId, 'teste');
    const result = preflight(s.ctx, s.applicationId, 'real');
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === 'anexo_selecionado')?.ok).toBe(true);
    const plan = nn(result.plan);
    expect(plan).toMatchObject({
      attachmentSource: 'mestre',
      attachmentVariant: null,
      cvSha256: CV_SHA,
    });
    // Compatibilidade: o hash de vinculação sem anexo personalizado é EXATAMENTE o formato anterior.
    expect(plan.bindingHash).toBe(
      hash(
        Buffer.from(JSON.stringify([s.applicationId, 'real', plan.contentHash, CV_SHA, RECIPIENT])),
      ),
    );
    expect(plan.bindingHash).toBe(
      bindingHashOf({
        applicationId: s.applicationId,
        kind: 'real',
        contentHash: plan.contentHash,
        cvSha256: CV_SHA,
        recipient: RECIPIENT,
      }),
    );
  });

  it('com vínculo aprovado, o anexo personalizado é a fonte obrigatória', () => {
    const ctx = personalized();
    const plan = nn(preflight(ctx, s.applicationId, 'real').plan);
    expect(plan).toMatchObject({
      attachmentSource: 'personalizado',
      attachmentVariant: 'desenvolvimento',
      cvSha256: PERS_SHA,
      cvName: FILE,
    });
    expect(plan.cvBytes.equals(PERS)).toBe(true);
    expect(plan.cvBytes.equals(CV_BYTES)).toBe(false);
    // O hash de vinculação agora cobre a identidade do vínculo.
    const legacy = bindingHashOf({
      applicationId: s.applicationId,
      kind: 'real',
      contentHash: plan.contentHash,
      cvSha256: PERS_SHA,
      recipient: RECIPIENT,
    });
    expect(plan.bindingHash).not.toBe(legacy);
    // As verificações anteriores continuam: o mestre ainda é conferido.
    s.cv.bytes = Buffer.from('%PDF-1.4 mestre alterado');
    expect(failing(ctx)).toContain('curriculo_confere');
  });

  it('vínculo aprovado sem anexo resolvido bloqueia (sem fallback para o mestre)', () => {
    link(true);
    expect(failing(withAttachment(undefined))).toEqual(['vinculo_curriculo']);
    expect(preflight(withAttachment(undefined), s.applicationId, 'real').plan).toBeUndefined();
    expect(dryRunEmail(withAttachment(undefined), s.applicationId).message).toBeUndefined();
  });

  it.each(['em_preparacao', 'revogado', 'substituido'])(
    'histórico de vínculo %s, sem vínculo aprovado utilizável: bloqueia sem usar o mestre',
    (state) => {
      link(false);
      if (state === 'revogado') {
        approveAttachment(db, {
          applicationId: s.applicationId,
          confirmSha8: PERS_SHA.slice(0, 8),
          reason: 'x',
          now: AT,
        });
        revokeAttachment(db, {
          applicationId: s.applicationId,
          confirmSha8: PERS_SHA.slice(0, 8),
          reason: 'x',
          now: AT,
        });
      } else if (state === 'substituido') {
        db.prepare(
          "UPDATE application_cv_attachments SET state = 'substituido', superseded_at = ?",
        ).run(AT.toISOString());
      }
      const forged: ResolvedAttachment = {
        applicationId: s.applicationId,
        jobId: s.jobId,
        linkId: 1,
        variant: 'desenvolvimento',
        pdfSha256: PERS_SHA,
        modelHash: MODEL,
        fileName: FILE,
        bytes: PERS,
      };
      for (const ctx of [withAttachment(undefined), withAttachment(forged)]) {
        const result = preflight(ctx, s.applicationId, 'real');
        expect(
          result.checks.filter((c) => !c.ok && c.sendOnly !== true).map((c) => c.id),
        ).toContain('vinculo_curriculo');
        expect(result.plan).toBeUndefined();
        expect(() => authorizeConfirmed(ctx, s.applicationId, 'real', 'autorizo')).toThrow(
          EmailError,
        );
      }
      expect(() => approveForSending(withAttachment(undefined), s.applicationId, 'x')).toThrow(
        /vinculo_curriculo/,
      );
    },
  );

  it.each([
    ['PDF de outro hash', () => ({ pdfSha256: 'e'.repeat(64) })],
    ['variante incorreta', () => ({ variant: 'qa' })],
    ['vaga incorreta', () => ({ jobId: s.jobId + 1 })],
    ['vínculo incorreto', () => ({ linkId: 999 })],
    ['modelo editorial divergente', () => ({ modelHash: 'c'.repeat(64) })],
    ['candidatura incorreta', () => ({ applicationId: s.applicationId + 1 })],
    ['nome divergente', () => ({ fileName: 'curriculo-qa-20261023-aaaaaaaa.pdf' })],
  ])('anexo resolvido que não corresponde ao vínculo: %s', (_name, over) => {
    link(true);
    expect(failing(withAttachment(resolved(over())))).toEqual(['vinculo_curriculo']);
  });

  it('bytes adulterados, que não são PDF ou grandes demais: anexo_integro falha', () => {
    link(true);
    for (const bytes of [
      Buffer.from('%PDF-1.4 outra coisa'),
      Buffer.from('nao e pdf'),
      Buffer.alloc(0),
    ])
      expect(failing(withAttachment(resolved({ bytes })))).toEqual(['anexo_integro']);
  });
});

describe('autorizações de envio e vínculo', () => {
  it('envia (com Gmail simulado) o PDF personalizado, e só ele', async () => {
    const ctx = personalized();
    const authorization = authorizeConfirmed(
      ctx,
      s.applicationId,
      'real',
      'autorizo este envio específico',
    );
    const result = await sendEmail(ctx, s.applicationId, authorization.id, 'real');
    expect(result.outcome).toBe('aceito');
    const mime = parseMime(Buffer.from(nn(s.transport.calls[0]), 'base64url').toString('utf8'));
    expect(hash(mime.attachment.bytes)).toBe(PERS_SHA);
    expect(mime.attachment.filename).toBe(FILE);
    expect(db.prepare('SELECT cv_sha256 FROM email_dispatches').get()).toEqual({
      cv_sha256: PERS_SHA,
    });
  });

  it('autorização emitida antes do vínculo (currículo mestre) não vale depois dele', async () => {
    const master = freshSetup({ approve: true });
    const LT = new Date(NOW.getTime() + 5 * 60_000);
    const old = authorizeConfirmed(master.ctx, master.applicationId, 'real', 'autorizo (antigo)');
    // Volta a "preparada", cria e aprova o vínculo e aprova de novo para envio.
    transitionApplication(
      master.db,
      master.applicationId,
      { to: 'preparada', reason: 'reabrir para trocar o currículo', actor: 'usuario' },
      NOW,
    );
    const artifactId = registerArtifact(master.db, {
      variant: 'desenvolvimento',
      pdfSha256: PERS_SHA,
      pdfBytes: PERS.length,
      pages: 2,
      modelHash: MODEL,
      generatedAt: AT,
      fileName: FILE,
    }).id;
    createAttachment(master.db, { applicationId: master.applicationId, artifactId, now: LT });
    approveAttachment(master.db, {
      applicationId: master.applicationId,
      confirmSha8: PERS_SHA.slice(0, 8),
      reason: 'ok',
      now: AT,
    });
    const c = classifyAttachment(master.db, master.applicationId);
    if (c.kind !== 'aprovado') throw new Error('sem vínculo');
    const ctx: EmailContext = {
      ...master.ctx,
      attachment: {
        applicationId: master.applicationId,
        jobId: master.jobId,
        linkId: c.link.id,
        variant: c.link.variant,
        pdfSha256: PERS_SHA,
        modelHash: MODEL,
        fileName: FILE,
        bytes: PERS,
      },
    };
    approveForSending(ctx, master.applicationId, 'de novo');
    seedTestEvidence(ctx, master.applicationId);
    // O gatilho do banco venceu a autorização antiga...
    const later: EmailContext = { ...ctx, now: () => new Date(LT.getTime() + 1000) };
    await expect(sendEmail(later, master.applicationId, old.id, 'real')).rejects.toThrow(/venceu/);
    // ...e, mesmo se alguém a reabrisse, o hash de vinculação já não confere.
    master.db
      .prepare('UPDATE email_authorizations SET expires_at = ? WHERE id = ?')
      .run('2099-01-01T00:00:00.000Z', old.id);
    await expect(sendEmail(later, master.applicationId, old.id, 'real')).rejects.toThrow(
      /mudaram depois da autorização/,
    );
    expect(master.transport.calls).toEqual([]);
    expect(
      (
        master.db
          .prepare("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind = 'real'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it('autorização vencida não envia', async () => {
    const ctx = personalized();
    const authorization = authorizeConfirmed(ctx, s.applicationId, 'real', 'autorizo', 1);
    const later: EmailContext = { ...ctx, now: () => new Date(NOW.getTime() + 2 * 60_000) };
    await expect(sendEmail(later, s.applicationId, authorization.id, 'real')).rejects.toThrow(
      /venceu/,
    );
    expect(s.transport.calls).toEqual([]);
  });

  it('alteração do vínculo depois da autorização a invalida (revogação e troca)', async () => {
    const ctx = personalized();
    const authorization = authorizeConfirmed(ctx, s.applicationId, 'real', 'autorizo');
    const revokedAt = new Date(NOW.getTime() + 5 * 60_000);
    revokeAttachment(db, {
      applicationId: s.applicationId,
      confirmSha8: PERS_SHA.slice(0, 8),
      reason: 'trocar',
      now: revokedAt,
    });
    const expires = (
      db
        .prepare('SELECT expires_at FROM email_authorizations WHERE id = ?')
        .get(authorization.id) as { expires_at: string }
    ).expires_at;
    expect(expires).toBe(revokedAt.toISOString());
    await expect(sendEmail(ctx, s.applicationId, authorization.id, 'real')).rejects.toThrow(
      EmailError,
    );
    expect(failing(ctx)).toContain('vinculo_curriculo');
    expect(s.transport.calls).toEqual([]);
    expect(getApplication(db, s.applicationId)?.status).toBe('aprovada_para_envio');
  });

  it('a trava mestra desligada continua bloqueando o envio', async () => {
    const off = freshSetup({ approve: true, sendEnabled: false });
    await expect(sendEmail(off.ctx, off.applicationId, 1, 'real')).rejects.toThrow(
      /EMAIL_SEND_ENABLED/,
    );
    expect(off.transport.calls).toEqual([]);
  });
});

describe('resolução segura do anexo (geração estrita em memória)', () => {
  let L: Loaded;
  let proj: Project;
  let real: StrictResumeResult;
  beforeAll(async () => {
    L = await loadFictional();
    proj = makeProject(L);
    real = await renderAndValidateResume(loadStrictInputs(proj.options).inputFor('generico'));
  });
  const stub =
    (tag = 'a') =>
    () => {
      const result = structuredClone({ report: real.report }) as StrictResumeResult;
      const bytes = Buffer.from(`%PDF-1.7 sintetico ${tag}`);
      nn(result.report.bindings).pdfSha256 = hash(bytes);
      nn(result.report.diagnostic).pdfSha256 = hash(bytes);
      result.artifact = {
        pdfSha256: hash(bytes),
        pages: nn(real.artifact).pages,
        readBytes: () => Buffer.from(bytes),
      };
      return Promise.resolve(result);
    };
  async function linkedApproved(): Promise<void> {
    const out = await attachResume(
      { db, applicationId: s.applicationId, variant: 'generico', inputs: proj.options },
      { render: stub('a'), now: () => AT },
    );
    if (!out.ok) throw new Error(out.code);
    const ok = await approveResumeLink(
      {
        db,
        applicationId: s.applicationId,
        confirmSha8: out.pdfSha8,
        reason: 'conferi',
        inputs: proj.options,
      },
      { render: stub('a'), now: () => AT },
    );
    if (!ok.ok) throw new Error(ok.code);
  }
  const resolve = (inputs = proj.options, render = stub('a')) =>
    resolveApprovedAttachment({ db, applicationId: s.applicationId, inputs }, { render });

  it('candidatura sem vínculo: usa o mestre e nem renderiza', async () => {
    const render = vi.fn(() => Promise.reject(new Error('não deveria renderizar')));
    const out = await resolve({ ...proj.options, anchorSha256: undefined }, render);
    expect(out).toEqual({ ok: true, attachment: undefined });
    expect(render).not.toHaveBeenCalled();
  });

  it('vínculo aprovado: regenera, confere variante, modelo e SHA-256 completo e usa só os bytes validados', async () => {
    await linkedApproved();
    const out = await resolve();
    if (!out.ok || out.attachment === undefined) throw new Error('deveria resolver');
    expect(out.attachment).toMatchObject({
      applicationId: s.applicationId,
      jobId: s.jobId,
      variant: 'generico',
    });
    expect(hash(out.attachment.bytes)).toBe(out.attachment.pdfSha256);
    // O anexo resolvido passa no preflight de ponta a ponta.
    approveForSending({ ...s.ctx, attachment: out.attachment }, s.applicationId, 'ok');
    expect(
      preflight({ ...s.ctx, attachment: out.attachment }, s.applicationId, 'real').plan
        ?.attachmentSource,
    ).toBe('personalizado');
  });

  it('âncora ausente ou incorreta bloqueia sem regenerar', async () => {
    await linkedApproved();
    const render = vi.fn(() => Promise.reject(new Error('não deveria renderizar')));
    for (const [anchor, code] of [
      [undefined, 'ANCHOR_REFERENCE_MISSING'],
      [sha('errada'), 'ANCHOR_MISMATCH'],
    ] as const) {
      const out = await resolve({ ...proj.options, anchorSha256: anchor }, render);
      expect(out).toMatchObject({ ok: false, code });
    }
    expect(render).not.toHaveBeenCalled();
  });

  it('PDF regenerado com hash diferente: bloqueia e não atualiza nenhum registro', async () => {
    await linkedApproved();
    const before = db.prepare('SELECT * FROM cv_artifacts').all();
    const out = await resolve(proj.options, stub('b'));
    expect(out).toMatchObject({ ok: false, code: 'ARTIFACT_HASH_DIVERGENT' });
    expect(db.prepare('SELECT * FROM cv_artifacts').all()).toEqual(before);
    expect(classifyAttachment(db, s.applicationId).kind).toBe('aprovado');
  });

  it('modelo editorial divergente: bloqueia', async () => {
    await linkedApproved();
    const other = makeProject(L, (m) => {
      nn(m.summary.variants.find((v) => v.id === 'resumo-geral')).text += ' editado e reaprovado';
    });
    dirs.push(other.root);
    const out = await resolve(other.options);
    expect(out).toMatchObject({ ok: false, code: 'MODEL_DIVERGENT' });
  });

  it('com histórico sem vínculo aprovado: bloqueio explícito', async () => {
    const out = await attachResume(
      { db, applicationId: s.applicationId, variant: 'generico', inputs: proj.options },
      { render: stub('a'), now: () => AT },
    );
    expect(out.ok).toBe(true);
    expect(await resolve()).toMatchObject({ ok: false, code: 'NO_APPROVED_LINK_USABLE' });
  });
});

describe('exportação .eml local', () => {
  const gmailCalls = (): number => s.transport.calls.length;

  it('exporta um .eml válido com o PDF correto, privado e sem enviar nada', () => {
    const ctx = personalized();
    const dir = join(tmp(), 'rascunhos');
    const before = getApplication(db, s.applicationId)?.status;
    const result = exportEml(ctx, s.applicationId, 'real', { dir });
    expect(result.path.startsWith(`${dir}/candidatura-${s.applicationId}-real-`)).toBe(true);
    expect(result.path).toMatch(/-[a-f0-9]{8}\.eml$/u);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const parsed = parseMime(readFileSync(result.path, 'utf8'));
    expect(parsed.headers.to).toBe(RECIPIENT);
    expect(parsed.headers.subject).toContain('Candidatura');
    expect(parsed.attachment.bytes.equals(PERS)).toBe(true);
    expect(result).toMatchObject({
      attachmentSource: 'personalizado',
      attachmentVariant: 'desenvolvimento',
      durable: true,
      tempCleanup: 'removed',
    });
    expect(readdirSync(dir)).toHaveLength(1);
    // Nada enviado: sem Gmail, sem dispatch, estado igual; o evento registra a exportação.
    expect(gmailCalls()).toBe(0);
    expect(count('email_dispatches')).toBe(0);
    expect(getApplication(db, s.applicationId)?.status).toBe(before);
    expect(getHistory(db, s.applicationId).at(-1)?.reason).toContain('nada foi enviado');
  });

  it('candidatura antiga sem vínculo exporta o currículo mestre; funciona com a trava mestra desligada', () => {
    approveForSending(s.ctx, s.applicationId, 'teste');
    const result = exportEml({ ...s.ctx, sendEnabled: false }, s.applicationId, 'real', {
      dir: join(tmp(), 'x'),
    });
    expect(result.attachmentSource).toBe('mestre');
    expect(parseMime(readFileSync(result.path, 'utf8')).attachment.bytes.equals(CV_BYTES)).toBe(
      true,
    );
  });

  it('versão de teste vai para a caixa de teste; dry-run comum nunca cria .eml', () => {
    approveForSending(s.ctx, s.applicationId, 'teste');
    const dir = join(tmp(), 'testes');
    dryRunEmail(s.ctx, s.applicationId, 'real');
    dryRunEmail(s.ctx, s.applicationId, 'teste');
    expect(existsSync(dir)).toBe(false);
    const result = exportEml(s.ctx, s.applicationId, 'teste', { dir });
    expect(parseMime(readFileSync(result.path, 'utf8')).headers.to).toBe(TEST_MAILBOX);
  });

  it('exige email approve: preparada é bloqueada tanto na exportação normal quanto em --test, sem criar arquivo', () => {
    const dir = join(tmp(), 'preparada');
    expect(getApplication(db, s.applicationId)?.status).toBe('preparada');
    for (const kind of ['real', 'teste'] as const) {
      expect(() => exportEml(s.ctx, s.applicationId, kind, { dir })).toThrow(EmailError);
    }
    expect(() => exportEml(s.ctx, s.applicationId, 'teste', { dir })).toThrow(
      /aprovada para envio/,
    );
    expect(existsSync(dir)).toBe(false);
    expect(gmailCalls()).toBe(0);
    expect(getHistory(db, s.applicationId).filter((e) => e.reason.includes('.eml'))).toEqual([]);
  });

  it('aprovada para envio: ambas as exportações funcionam, e --test vai só para a caixa de teste', () => {
    approveForSending(s.ctx, s.applicationId, 'teste');
    const real = exportEml(s.ctx, s.applicationId, 'real', { dir: join(tmp(), 'a') });
    const test = exportEml(s.ctx, s.applicationId, 'teste', { dir: join(tmp(), 'b') });
    expect(parseMime(readFileSync(real.path, 'utf8')).headers.to).toBe(RECIPIENT);
    const parsed = parseMime(readFileSync(test.path, 'utf8'));
    expect(parsed.headers.to).toBe(TEST_MAILBOX);
    expect(parsed.headers.subject).toContain('[TESTE AutoEstagio]');
    expect(gmailCalls()).toBe(0);
    expect(count('email_dispatches')).toBe(0);
  });

  it('o preflight geral não mudou: o envio de teste continua aceitando candidatura preparada', async () => {
    expect(getApplication(db, s.applicationId)?.status).toBe('preparada');
    expect(failing(s.ctx, 'teste')).toEqual([]);
    const authorization = authorizeConfirmed(s.ctx, s.applicationId, 'teste', 'autorizo o teste');
    const result = await sendEmail(s.ctx, s.applicationId, authorization.id, 'teste');
    expect(result.outcome).toBe('aceito');
    expect(s.transport.calls).toHaveLength(1);
    expect(
      parseMime(Buffer.from(nn(s.transport.calls[0]), 'base64url').toString('utf8')).headers.to,
    ).toBe(TEST_MAILBOX);
    expect(getApplication(db, s.applicationId)?.status).toBe('preparada');
  });

  it('bloqueia destinatário ausente/não verificado, anexo não resolvido e candidatura não aprovada, sem criar arquivo', () => {
    const dir = join(tmp(), 'bloqueios');
    // Candidatura não aprovada para envio.
    expect(() => exportEml(s.ctx, s.applicationId, 'real', { dir })).toThrow(/estado_e_modo/);
    // Destinatário não verificado.
    db.prepare('DELETE FROM verified_recipients').run();
    expect(() => exportEml(s.ctx, s.applicationId, 'real', { dir })).toThrow(
      /destinatario_verificado/,
    );
    // Caixa de teste inválida.
    expect(() =>
      exportEml({ ...s.ctx, testMailbox: 'invalido' }, s.applicationId, 'teste', { dir }),
    ).toThrow(/caixa_de_teste/);
    expect(existsSync(dir)).toBe(false);
  });

  it('bloqueia quando o vínculo aprovado não teve o anexo resolvido', () => {
    const ctx = personalized();
    const dir = join(tmp(), 'sem-anexo');
    expect(() =>
      exportEml({ ...ctx, attachment: undefined }, s.applicationId, 'real', { dir }),
    ).toThrow(/vinculo_curriculo/);
    expect(existsSync(dir)).toBe(false);
  });

  it('nunca sobrescreve um .eml existente (corrida de publicação) nem deixa temporários', () => {
    const ctx = personalized();
    const dir = join(tmp(), 'corrida');
    const events = getHistory(db, s.applicationId).length;
    let victim = '';
    expect(() =>
      exportEml(ctx, s.applicationId, 'real', {
        dir,
        writeFs: {
          linkSync: (from, to) => {
            victim = join(dir, String(to).split('/').pop() ?? '');
            writeFileSync(victim, 'do outro escritor');
            realLink(from, to);
          },
        },
      }),
    ).toThrow(/já existe/);
    expect(readFileSync(victim, 'utf8')).toBe('do outro escritor');
    expect(readdirSync(dir)).toEqual([victim.split('/').pop()]);
    expect(getHistory(db, s.applicationId)).toHaveLength(events);
    expect(count('email_dispatches')).toBe(0);
  });

  it('falha de escrita: nada é publicado, o temporário some e o evento não é registrado', () => {
    const ctx = personalized();
    const dir = join(tmp(), 'falha');
    const events = getHistory(db, s.applicationId).length;
    expect(() =>
      exportEml(ctx, s.applicationId, 'real', {
        dir,
        writeFs: {
          writeSync: () => {
            throw new Error('disco cheio');
          },
        },
      }),
    ).toThrow(SafeWriteError);
    expect(readdirSync(dir)).toEqual([]);
    expect(getHistory(db, s.applicationId)).toHaveLength(events);
  });

  it('valida o MIME: anexo, destinatário, fronteira e cabeçalhos extras', () => {
    const input = {
      to: RECIPIENT,
      subject: 'Assunto',
      body: 'Corpo\nlinha 2',
      date: AT,
      messageId: '<abc@autoestagio.local>',
      dispatchId: 'eml-export',
      attachment: { filename: FILE, bytes: PERS, contentType: 'application/pdf' as const },
    };
    const expected = {
      to: RECIPIENT,
      body: input.body,
      attachmentSha256: PERS_SHA,
      attachmentBytes: PERS.length,
    };
    const mime = buildMime(input);
    expect(() => {
      verifyMime(mime, expected);
    }).not.toThrow();
    expect(() => {
      verifyMime(mime, { ...expected, attachmentSha256: sha('x') });
    }).toThrow(/MIME/);
    expect(() => {
      verifyMime(mime, { ...expected, to: 'outro@acme-ficticia.com.br' });
    }).toThrow(/MIME/);
    expect(() => {
      verifyMime(mime.replace(/--=_autoestagio_[a-f0-9]+--\r\n$/u, ''), expected);
    }).toThrow(/MIME/);
    expect(() => {
      verifyMime(mime.replace('MIME-Version: 1.0', 'Bcc: x@y.com\r\nMIME-Version: 1.0'), expected);
    }).toThrow(/MIME/);
    expect(() => {
      verifyMime(mime.replace(/\r\n\r\n/u, '\r\nsem-dois-pontos\r\n\r\n'), expected);
    }).toThrow(/MIME/);
    expect(() => buildMime({ ...input, subject: 'a\r\nBcc: x@y.com' })).toThrow(/quebra de linha/);
    expect(() => buildMime({ ...input, to: 'sem-arroba' })).toThrow(/destinatário/);
  });
});

describe('privacidade e ausência de envio', () => {
  it('ensaio e exportação não registram dados pessoais nem chamam o Gmail', () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const ctx = personalized();
    const report = dryRunEmail(ctx, s.applicationId);
    const text = formatDryRun(report, s.applicationId, 'real');
    const result = exportEml(ctx, s.applicationId, 'real', { dir: join(tmp(), 'priv') });
    const logged = spies
      .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
      .join('\n');
    const visible = [text, logged, JSON.stringify(report)].join('\n');
    expect(visible).not.toContain(RECIPIENT);
    expect(visible).not.toContain(PERS_SHA);
    expect(visible).not.toContain(PERS.toString('latin1'));
    expect(visible).toContain('currículo personalizado aprovado');
    expect(result.recipientMasked).toBe('r***@acme-ficticia.com.br');
    expect(s.transport.calls).toEqual([]);
    expect(count('email_dispatches')).toBe(0);
    // Nenhuma autorização nova (a única é a evidência usada da fixture).
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM email_authorizations WHERE used_at IS NULL')
          .get() as { n: number }
      ).n,
    ).toBe(0);
    for (const row of getHistory(db, s.applicationId))
      expect(row.reason).not.toMatch(/[a-f0-9]{16,}/u);
  });

  it('os módulos novos não importam o transporte do Gmail nem chamam a rede', () => {
    for (const file of ['src/email/eml.ts', 'src/cv/attachments.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/GmailTransport|from '\.\/gmail|fetch\(|googleapis/u);
    }
  });
});
