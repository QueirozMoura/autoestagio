import { readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/applications/index.js';
import {
  approveResumeLink,
  attachResume,
  formatAttachment,
  formatAttachmentList,
  regenerateStrict,
  revokeResumeLink,
  suggestVariant,
  type AttachOutcome,
  type DecisionOutcome,
} from '../../src/cli/cv-attach.js';
import { registerCvCommands } from '../../src/cli/cv-commands.js';
import {
  AttachmentError,
  approveAttachment,
  createAttachment,
  listAttachments,
  registerArtifact,
} from '../../src/cv/attachments.js';
import { modelHash } from '../../src/cv/schema.js';
import { loadStrictInputs } from '../../src/cv/strict-inputs.js';
import { renderAndValidateResume, type StrictResumeResult } from '../../src/cv/strict.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { Command } from 'commander';
import { CV, PROFILE_HASH, T0, seedJob } from '../helpers/applications.js';
import { GENERIC, must } from '../helpers/cv-approved.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { makeProject, sha, writePrivate, type Project } from '../helpers/cv-strict-project.js';

vi.setConfig({ testTimeout: 120_000 });
const nn = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('valor ausente no teste');
  return value;
};
let L: Loaded;
let proj: Project;
let real: StrictResumeResult;
beforeAll(async () => {
  L = await loadFictional();
  proj = makeProject(L);
  real = await renderAndValidateResume(loadStrictInputs(proj.options).inputFor('generico'));
  expect(real.report.issues).toEqual([]);
});
const extra: Project[] = [];
afterEach(() => {
  for (const p of extra.splice(0)) rmSync(p.root, { recursive: true, force: true });
});

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const fakeBytes = (tag: string): Buffer => Buffer.from(`%PDF-1.7 sintetico ${tag}`);
/** Resultado estrito sintético derivado do real, com bytes fixos. */
function stub(tag = 'a', edit: (r: StrictResumeResult) => void = () => undefined) {
  return () => {
    const result = structuredClone({ report: real.report }) as StrictResumeResult;
    const bytes = fakeBytes(tag);
    const digest = sha(bytes);
    nn(result.report.bindings).pdfSha256 = digest;
    nn(result.report.diagnostic).pdfSha256 = digest;
    result.artifact = {
      pdfSha256: digest,
      pages: nn(real.artifact).pages,
      readBytes: () => Buffer.from(bytes),
    };
    edit(result);
    return Promise.resolve(result);
  };
}
const NOW = () => new Date('2026-10-23T15:00:00.000Z');
function newApp(title = 'Estágio em Desenvolvimento de Software'): {
  applicationId: number;
  jobId: number;
} {
  const jobId = seedJob(db, { title });
  const made = createApplication(db, { jobId, cv: CV, profileHash: PROFILE_HASH }, T0);
  if (!made.created) throw new Error('falha ao criar candidatura');
  return { applicationId: made.application.id, jobId };
}
const attach = (
  app: { applicationId: number },
  over: Partial<Parameters<typeof attachResume>[0]> = {},
  render = stub(),
) =>
  attachResume(
    { db, applicationId: app.applicationId, variant: 'generico', inputs: proj.options, ...over },
    { render, now: NOW },
  );
const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const failed = <T extends { ok: boolean }>(o: T): Extract<T, { ok: false }> => {
  if (o.ok) throw new Error('deveria falhar');
  return o as Extract<T, { ok: false }>;
};
const succeeded = (o: AttachOutcome): Extract<AttachOutcome, { ok: true }> => {
  if (!o.ok) throw new Error(`falhou: ${o.code}`);
  return o;
};
const sha8Of = (tag: string): string => sha(fakeBytes(tag)).slice(0, 8);
const status = (id: number) =>
  db.prepare('SELECT status, mode, cv_sha256, cv_label FROM applications WHERE id = ?').get(id);

describe('cv attach: consulta e entradas', () => {
  it('candidatura inexistente, vaga errada e vaga inexistente', async () => {
    expect(failed(await attach({ applicationId: 999 })).code).toBe('APPLICATION_NOT_FOUND');
    const app = newApp();
    expect(failed(await attach(app, { jobId: app.jobId + 100 })).code).toBe('JOB_MISMATCH');
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM jobs WHERE id = ?').run(app.jobId);
    db.pragma('foreign_keys = ON');
    expect(failed(await attach(app)).code).toBe('JOB_NOT_FOUND');
    expect(count('cv_artifacts')).toBe(0);
  });

  it('exige candidatura preparada', async () => {
    const app = newApp();
    db.prepare("UPDATE applications SET mode = 'revisao' WHERE id = ?").run(app.applicationId);
    db.prepare("UPDATE applications SET status = 'enviada' WHERE id = ?").run(app.applicationId);
    expect(failed(await attach(app)).code).toBe('APPLICATION_NOT_PREPARED');
  });

  it('exige --variant: a área da vaga só gera sugestão, nunca seleção', async () => {
    const app = newApp('Estágio em Desenvolvimento de Software');
    const none = failed(await attach(app, { variant: undefined }));
    expect(none).toMatchObject({ stage: 'entrada', code: 'VARIANT_REQUIRED' });
    expect(none.suggestion?.variant).toBe('desenvolvimento');
    expect(formatAttachment(none)).toContain('NÃO é aplicada');
    expect(failed(await attach(app, { variant: 'suporte' })).code).toBe('VARIANT_UNKNOWN');
    expect(count('cv_artifacts')).toBe(0);
    expect(count('application_cv_attachments')).toBe(0);
  });

  it('sugestões: uma área com variante, ambígua ou sem variante', () => {
    expect(suggestVariant('Estágio em QA', null).variant).toBe('qa');
    expect(suggestVariant('Estágio em Infraestrutura', null).variant).toBe('infraestrutura');
    expect(suggestVariant('Estágio em Suporte Técnico', null).variant).toBe('generico');
    expect(suggestVariant('Estágio em TI', null).variant).toBe('generico');
    expect(suggestVariant('Estágio em Desenvolvimento e QA', null).variant).toBe('generico');
    // Áreas novas não têm currículo próprio: a sugestão inicial é o genérico (a escolha continua explícita).
    for (const title of [
      'Estágio em Segurança da Informação',
      'Estágio em Governança de TI',
      'Estágio em ERP / Protheus',
      'Estágio em Automação de Processos (RPA)',
      'Estágio em Operações de TI',
    ])
      expect(suggestVariant(title, null).variant).toBe('generico');
  });

  it('variante não aprovada, âncora ausente/incorreta e aprovação editorial obsoleta', async () => {
    const app = newApp();
    const never = vi.fn(() => Promise.reject(new Error('não deveria renderizar')));
    expect(failed(await attach(app, { variant: 'infraestrutura' }, never)).code).toBe(
      'VARIANT_NOT_ELIGIBLE',
    );
    expect(
      failed(await attach(app, { inputs: { ...proj.options, anchorSha256: undefined } }, never))
        .code,
    ).toBe('ANCHOR_REFERENCE_MISSING');
    expect(
      failed(await attach(app, { inputs: { ...proj.options, anchorSha256: sha('errada') } }, never))
        .code,
    ).toBe('ANCHOR_MISMATCH');
    const stale = makeProject(L, (m) => {
      must(m.summary.variants.find((v) => v.id === 'resumo-geral')).text += ' reaprovado';
    });
    extra.push(stale);
    writePrivate(stale.paths.model, readFileSync(proj.paths.model));
    expect(failed(await attach(app, { inputs: stale.options }, never)).code).toBe('APPROVAL_STALE');
    expect(never).not.toHaveBeenCalled();
    expect(count('cv_artifacts')).toBe(0);
  });

  it('geração estrita incompleta não registra nada', async () => {
    const app = newApp();
    const incomplete = stub('a', (r) => {
      r.report.complete = false;
      delete r.artifact;
    });
    expect(failed(await attach(app, {}, incomplete)).code).toBe('VALIDATION_FAILED');
    const noPoppler = stub('a', (r) => {
      nn(r.report.diagnostic).extractors = nn(r.report.diagnostic).extractors.filter(
        (e) => !e.name.includes('poppler'),
      );
    });
    expect(failed(await attach(app, {}, noPoppler)).code).toBe('VALIDATION_FAILED');
    const tampered = stub('a', (r) => {
      nn(r.artifact).readBytes = () => Buffer.from('adulterado');
    });
    expect(failed(await attach(app, {}, tampered)).code).toBe('ARTIFACT_HASH_MISMATCH');
    expect(count('cv_artifacts')).toBe(0);
    expect(count('application_cv_attachments')).toBe(0);
  });
});

describe('cv attach: registro e vínculo em preparação (geração estrita real)', () => {
  it('registra o artefato validado e cria o vínculo SEM aprovar nem enviar', async () => {
    const app = newApp();
    const before = status(app.applicationId);
    const out = succeeded(
      await attach(app, {}, () =>
        renderAndValidateResume(loadStrictInputs(proj.options).inputFor('generico')),
      ),
    );
    expect(out).toMatchObject({
      state: 'em_preparacao',
      variant: 'generico',
      artifactRegistered: true,
      replaced: false,
    });
    const art = db.prepare('SELECT * FROM cv_artifacts').get() as Record<string, unknown>;
    expect(art).toMatchObject({
      variant: 'generico',
      pdf_sha256: nn(real.artifact).pdfSha256,
      pages: nn(real.artifact).pages,
      model_hash: modelHash(proj.model),
      validation: 'estrita-completa',
      generated_at: '2026-10-23T15:00:00.000Z',
    });
    expect(art.file_name).toBe(
      `curriculo-generico-20261023-${nn(real.artifact).pdfSha256.slice(0, 8)}.pdf`,
    );
    // Estados distintos: vínculo em preparação ≠ aprovado ≠ candidatura aprovada ≠ enviado.
    expect(listAttachments(db, app.applicationId).map((v) => v.state)).toEqual(['em_preparacao']);
    expect(status(app.applicationId)).toEqual(before);
    expect(
      db.prepare('SELECT status FROM applications WHERE id = ?').get(app.applicationId),
    ).toEqual({ status: 'preparada' });
    for (const table of ['email_dispatches', 'email_authorizations']) expect(count(table)).toBe(0);
  });

  it('bloqueia vínculo vivo duplicado; --replace só troca vínculo em preparação', async () => {
    const app = newApp();
    succeeded(await attach(app, {}, stub('a')));
    expect(failed(await attach(app, {}, stub('a'))).code).toBe('LIVE_LINK_EXISTS');
    const replaced = succeeded(await attach(app, { replace: true }, stub('a')));
    expect(replaced.replaced).toBe(true);
    expect(listAttachments(db, app.applicationId).map((v) => v.state)).toEqual([
      'substituido',
      'em_preparacao',
    ]);
    expect(count('cv_artifacts')).toBe(1);
  });

  it('o mesmo artefato validado é reaproveitado em outra candidatura (sem registro duplicado)', async () => {
    succeeded(await attach(newApp(), {}, stub('a')));
    const second = succeeded(await attach(newApp(), {}, stub('a')));
    expect(second.artifactRegistered).toBe(false);
    expect(count('cv_artifacts')).toBe(1);
    expect(count('application_cv_attachments')).toBe(2);
  });

  it('hash divergente para a mesma variante e modelo: bloqueia, não atualiza e não escolhe outro', async () => {
    const app = newApp();
    succeeded(await attach(app, {}, stub('a')));
    const other = newApp();
    const out = failed(await attach(other, {}, stub('b')));
    expect(out).toMatchObject({ stage: 'registro', code: 'ARTIFACT_HASH_DIVERGENT' });
    expect(count('cv_artifacts')).toBe(1);
    expect(db.prepare('SELECT pdf_sha256 FROM cv_artifacts').get()).toEqual({
      pdf_sha256: sha(fakeBytes('a')),
    });
    expect(listAttachments(db, other.applicationId)).toEqual([]);
  });

  it('candidatura antiga sem vínculo continua como estava', () => {
    const app = newApp();
    expect(listAttachments(db, app.applicationId)).toEqual([]);
    expect(formatAttachmentList([], app.applicationId)).toContain('currículo mestre');
    expect(
      db
        .prepare('SELECT cv_sha256, cv_label FROM applications WHERE id = ?')
        .get(app.applicationId),
    ).toEqual({
      cv_sha256: CV.sha256,
      cv_label: CV.label,
    });
  });
});

describe('atomicidade e inequivocidade da confirmação', () => {
  it('registro do artefato e vínculo são atômicos: se o vínculo falha, nada fica gravado', async () => {
    const app = newApp();
    db.exec(
      "CREATE TRIGGER teste_falha BEFORE INSERT ON application_cv_attachments BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;",
    );
    const out = failed(await attach(app, {}, stub('a')));
    expect(out).toMatchObject({ stage: 'registro', code: 'STATE_NOT_ALLOWED' });
    expect(count('cv_artifacts')).toBe(0);
    expect(count('application_cv_attachments')).toBe(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM application_events WHERE reason LIKE '%vínculo de currículo%'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('falha de gatilho na aprovação ou na revogação não deixa estado parcial', async () => {
    const app = newApp();
    succeeded(await attach(app, {}, stub('a')));
    db.exec(
      "CREATE TRIGGER teste_falha BEFORE UPDATE ON application_cv_attachments BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;",
    );
    const events = count('application_events');
    const out = await approveResumeLink(
      {
        db,
        applicationId: app.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'ok',
        inputs: proj.options,
      },
      { render: stub('a'), now: NOW },
    );
    expect(failed(out).code).toBe('STATE_NOT_ALLOWED');
    expect(listAttachments(db, app.applicationId)[0]?.state).toBe('em_preparacao');
    expect(count('application_events')).toBe(events);
  });

  it('o --sha8 só vale para o vínculo vivo da própria candidatura: outro registro não é afetado', async () => {
    const first = newApp();
    const second = newApp();
    succeeded(await attach(first, {}, stub('a')));
    succeeded(await attach(second, {}, stub('a')));
    // Aprovar a primeira não toca o vínculo da segunda, ainda que o PDF seja o mesmo.
    const done = await approveResumeLink(
      {
        db,
        applicationId: first.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'ok',
        inputs: proj.options,
      },
      { render: stub('a'), now: NOW },
    );
    expect(done.ok).toBe(true);
    expect(listAttachments(db, second.applicationId)[0]?.state).toBe('em_preparacao');
    // sha8 de outro PDF, mesmo que existisse em outro registro, não aprova este.
    expect(
      approveAttachment(db, {
        applicationId: second.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'ok',
      }).state,
    ).toBe('aprovado');
  });

  it('se o vínculo vivo mudou depois da reverificação, a aprovação falha sem alterar nada', async () => {
    const app = newApp();
    succeeded(await attach(app, {}, stub('a')));
    const live = nn(listAttachments(db, app.applicationId)[0]);
    expect(() =>
      approveAttachment(db, {
        applicationId: app.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'ok',
        expected: { linkId: live.id + 1, pdfSha256: sha(fakeBytes('a')) },
      }),
    ).toThrow(AttachmentError);
    expect(() =>
      approveAttachment(db, {
        applicationId: app.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'ok',
        expected: { linkId: live.id, pdfSha256: sha(fakeBytes('b')) },
      }),
    ).toThrow(AttachmentError);
    expect(listAttachments(db, app.applicationId)[0]?.state).toBe('em_preparacao');
  });

  it('dois artefatos de hashes diferentes com o mesmo sha8 e nome falham sem alterar dados', () => {
    const base = {
      variant: 'generico',
      pdfBytes: 10,
      pages: 2,
      modelHash: 'd'.repeat(64),
      generatedAt: NOW(),
      fileName: `curriculo-generico-20261023-${'a'.repeat(8)}.pdf`,
    };
    registerArtifact(db, { ...base, pdfSha256: 'a'.repeat(64) });
    expect(() =>
      registerArtifact(db, { ...base, pdfSha256: 'a'.repeat(8) + 'b'.repeat(56) }),
    ).toThrow();
    expect(count('cv_artifacts')).toBe(1);
  });
});

describe('aprovação e revogação explícitas', () => {
  async function linked(tag = 'a') {
    const app = newApp();
    succeeded(await attach(app, {}, stub(tag)));
    return app;
  }
  const approve = (
    app: { applicationId: number },
    over: Partial<Parameters<typeof approveResumeLink>[0]> = {},
    render = stub(),
  ) =>
    approveResumeLink(
      {
        db,
        applicationId: app.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'conferi o PDF',
        inputs: proj.options,
        ...over,
      },
      { render, now: NOW },
    );
  const revoke = (
    app: { applicationId: number },
    over: Partial<Parameters<typeof revokeResumeLink>[0]> = {},
  ) =>
    revokeResumeLink(
      {
        db,
        applicationId: app.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'trocar o currículo',
        ...over,
      },
      { now: NOW },
    );
  const ok = (o: DecisionOutcome) => {
    if (!o.ok) throw new Error(`falhou: ${o.code}`);
    return o;
  };

  it('aprova só com a confirmação do artefato, motivo e reverificação estrita; não aprova envio', async () => {
    const app = await linked();
    expect(failed(await approve(app, { confirmSha8: '00000000' })).code).toBe(
      'CONFIRMATION_MISMATCH',
    );
    expect(failed(await approve(app, { confirmSha8: 'xyz' })).code).toBe('CONFIRMATION_MISMATCH');
    expect(failed(await approve(app, { reason: '   ' })).code).toBe('REASON_REQUIRED');
    expect(
      failed(await approve(app, { inputs: { ...proj.options, anchorSha256: undefined } })).code,
    ).toBe('ANCHOR_REFERENCE_MISSING');
    expect(listAttachments(db, app.applicationId)[0]?.state).toBe('em_preparacao');

    const done = ok(await approve(app));
    expect(done.view).toMatchObject({ state: 'aprovado', approvedAt: '2026-10-23T15:00:00.000Z' });
    expect(formatAttachment(done)).toContain('NÃO aprova a candidatura para envio');
    // Aprovar o currículo não muda a candidatura nem toca o envio.
    expect(
      db.prepare('SELECT status, mode FROM applications WHERE id = ?').get(app.applicationId),
    ).toEqual({ status: 'preparada', mode: 'dry-run' });
    for (const table of ['email_dispatches', 'email_authorizations']) expect(count(table)).toBe(0);
    expect(failed(await approve(app)).code).toBe('NO_PREPARING_LINK');
  });

  it('PDF regenerado com hash diferente bloqueia a aprovação sem atualizar o registro', async () => {
    const app = await linked('a');
    const out = failed(await approve(app, {}, stub('b')));
    expect(out.code).toBe('ARTIFACT_HASH_DIVERGENT');
    expect(listAttachments(db, app.applicationId)[0]).toMatchObject({
      state: 'em_preparacao',
      pdfSha8: sha8Of('a'),
    });
    expect(count('cv_artifacts')).toBe(1);
  });

  it('revogação explícita preserva o histórico, é terminal e exige nova seleção e nova aprovação', async () => {
    const app = await linked();
    ok(await approve(app));
    expect(revoke(app, { confirmSha8: '11111111' })).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_MISMATCH',
    });
    expect(revoke(app, { reason: '' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    const revoked = ok(revoke(app));
    expect(revoked.view.state).toBe('revogado');
    expect(formatAttachment(revoked)).toContain('nova seleção e nova aprovação');
    // Sem reativação nem nova revogação.
    expect(revoke(app)).toMatchObject({ ok: false, code: 'NO_APPROVED_LINK' });
    expect(failed(await approve(app)).code).toBe('NO_PREPARING_LINK');
    expect(() =>
      db.prepare("UPDATE application_cv_attachments SET state = 'aprovado'").run(),
    ).toThrow(/definitivo/);
    expect(() => db.prepare('DELETE FROM application_cv_attachments').run()).toThrow(/apagado/);
    // Histórico preservado, com a aprovação anterior e o motivo.
    expect(
      db
        .prepare('SELECT state, approval_reason, revocation_reason FROM application_cv_attachments')
        .all(),
    ).toEqual([
      {
        state: 'revogado',
        approval_reason: 'conferi o PDF',
        revocation_reason: 'trocar o currículo',
      },
    ]);
    // Novo vínculo: nova seleção, em preparação, e precisa ser aprovado de novo.
    const again = succeeded(await attach(app, {}, stub('a')));
    expect(again.state).toBe('em_preparacao');
    expect(listAttachments(db, app.applicationId).map((v) => v.state)).toEqual([
      'revogado',
      'em_preparacao',
    ]);
  });

  it('não há troca silenciosa de um currículo aprovado', async () => {
    const app = await linked();
    ok(await approve(app));
    expect(failed(await attach(app, { replace: true }, stub('a'))).code).toBe('LIVE_LINK_EXISTS');
    expect(failed(await attach(app, {}, stub('a'))).code).toBe('LIVE_LINK_EXISTS');
    const art = registerArtifact(db, {
      variant: 'qa',
      pdfSha256: 'c'.repeat(64),
      pdfBytes: 10,
      pages: 2,
      modelHash: 'd'.repeat(64),
      generatedAt: NOW(),
      fileName: `curriculo-qa-20261023-${'c'.repeat(8)}.pdf`,
    });
    expect(() =>
      createAttachment(db, { applicationId: app.applicationId, artifactId: art.id, replace: true }),
    ).toThrow(AttachmentError);
    expect(listAttachments(db, app.applicationId).map((v) => v.state)).toEqual(['aprovado']);
  });

  it('não revoga o vínculo de candidatura já enviada', async () => {
    const app = await linked();
    ok(await approve(app));
    db.prepare("UPDATE applications SET mode = 'revisao' WHERE id = ?").run(app.applicationId);
    db.prepare("UPDATE applications SET status = 'enviada' WHERE id = ?").run(app.applicationId);
    expect(revoke(app)).toMatchObject({ ok: false, code: 'STATE_NOT_ALLOWED' });
    expect(listAttachments(db, app.applicationId)[0]?.state).toBe('aprovado');
  });

  it('aprovar ou revogar invalida as autorizações de envio ainda não usadas', async () => {
    const app = await linked();
    const authorize = (): number =>
      Number(
        db
          .prepare(
            "INSERT INTO email_authorizations (application_id, kind, binding_hash, reason, created_at, expires_at) VALUES (?, 'real', ?, 'teste', ?, '2099-01-01T00:00:00.000Z')",
          )
          .run(app.applicationId, 'f'.repeat(64), '2026-10-23T14:00:00.000Z').lastInsertRowid,
      );
    const expiry = (id: number): string =>
      (
        db.prepare('SELECT expires_at FROM email_authorizations WHERE id = ?').get(id) as {
          expires_at: string;
        }
      ).expires_at;
    const first = authorize();
    ok(await approve(app));
    expect(expiry(first)).toBe('2026-10-23T15:00:00.000Z');
    const second = authorize();
    ok(revoke(app));
    expect(expiry(second)).toBe('2026-10-23T15:00:00.000Z');
    // Nenhum envio foi feito.
    expect(count('email_dispatches')).toBe(0);
  });
});

describe('privacidade e ausência de envio', () => {
  it('as saídas não vazam hashes completos, caminhos nem conteúdo do currículo', async () => {
    const app = newApp();
    const attached = await attach(app, {}, stub('a'));
    const approved = await approveResumeLink(
      {
        db,
        applicationId: app.applicationId,
        confirmSha8: sha8Of('a'),
        reason: 'ok',
        inputs: proj.options,
      },
      { render: stub('a'), now: NOW },
    );
    const text = [
      formatAttachment(attached),
      formatAttachment(approved),
      formatAttachmentList(listAttachments(db, app.applicationId), app.applicationId),
      JSON.stringify(attached),
      JSON.stringify(approved),
      JSON.stringify(listAttachments(db, app.applicationId)),
    ].join('\n');
    expect(text).not.toMatch(/[a-f0-9]{16,}/u);
    for (const secret of [
      proj.root,
      GENERIC,
      proj.anchorSha256,
      proj.model.master.sha256,
      sha(fakeBytes('a')),
    ])
      expect(text).not.toContain(secret);
    const events = db.prepare('SELECT reason FROM application_events').all() as {
      reason: string;
    }[];
    expect(events.map((e) => e.reason).join('\n')).not.toMatch(/[a-f0-9]{16,}/u);
  });

  it('o código do vínculo não importa nem usa o canal de e-mail', () => {
    for (const file of [
      'src/cli/cv-attach.ts',
      'src/cli/cv-attach-commands.ts',
      'src/cv/attachments.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from '\.\.\/email|gmail|sendEmail|EMAIL_SEND_ENABLED/u);
    }
  });

  it('regenerateStrict não lê nem grava PDFs em disco', async () => {
    const out = await regenerateStrict(proj.options, 'generico', { render: stub('a') });
    expect(out.ok).toBe(true);
    expect(createHash('sha256').update(fakeBytes('a')).digest('hex')).toBe(
      out.ok ? out.artifact.pdfSha256 : '',
    );
  });

  it('registra os subcomandos attach e attachment', () => {
    const program = new Command();
    registerCvCommands(program);
    const cv = nn(program.commands.find((c) => c.name() === 'cv'));
    const attachCmd = nn(cv.commands.find((c) => c.name() === 'attach'));
    expect(attachCmd.options.map((o) => o.long)).toEqual([
      '--application',
      '--job',
      '--variant',
      '--ancora-sha256',
      '--replace',
      '--json',
    ]);
    const sub = nn(cv.commands.find((c) => c.name() === 'attachment'));
    expect(sub.commands.map((c) => c.name())).toEqual(['list', 'approve', 'revoke']);
    // cv generate continua sem acesso ao banco.
    expect(readFileSync('src/cli/cv-generate.ts', 'utf8')).not.toMatch(
      /better-sqlite3|openDatabase|cv_artifacts/u,
    );
  });
});
