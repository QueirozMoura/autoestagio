import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/applications/index.js';
import {
  ARTIFACT_VALIDATION,
  attachmentRowSchema,
  cvArtifactRowSchema,
} from '../../src/cv/artifacts.js';
import { CV_VARIANTS } from '../../src/cv/strict-inputs.js';
import {
  DEFAULT_MIGRATIONS_DIR,
  IN_MEMORY,
  getMigrationStatus,
  openDatabase,
  runMigrations,
  type Db,
} from '../../src/db/index.js';
import { CV, PROFILE_HASH, T0, seedJob } from '../helpers/applications.js';

const HASH = 'a'.repeat(64);
const MODEL = 'b'.repeat(64);
const AT = '2026-10-23T12:00:00.000Z';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Diretório só com as migrações anteriores à 0008: um banco como estava antes da 4.5a. */
function before0008(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
  dirs.push(dir);
  for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR))
    if (name < '0008') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(dir, name));
  return dir;
}

interface ArtifactInput {
  variant?: string;
  sha?: string;
  model?: string;
  fileName?: string;
  pages?: number;
  bytes?: number;
  at?: string;
  validation?: string;
}
const fileFor = (variant: string, sha: string): string =>
  `curriculo-${variant}-20261023-${sha.slice(0, 8)}.pdf`;
function artifact(db: Db, input: ArtifactInput = {}): number {
  const variant = input.variant ?? 'generico';
  const sha = input.sha ?? HASH;
  return Number(
    db
      .prepare(
        `INSERT INTO cv_artifacts (variant, pdf_sha256, pdf_bytes, pages, model_hash, generated_at, validation, file_name)
         VALUES (@variant, @sha, @bytes, @pages, @model, @at, @validation, @file)`,
      )
      .run({
        variant,
        sha,
        bytes: input.bytes ?? 43_000,
        pages: input.pages ?? 2,
        model: input.model ?? MODEL,
        at: input.at ?? AT,
        validation: input.validation ?? ARTIFACT_VALIDATION,
        file: input.fileName ?? fileFor(variant, sha),
      }).lastInsertRowid,
  );
}
function appFor(db: Db): { applicationId: number; jobId: number } {
  const jobId = seedJob(db);
  const result = createApplication(db, { jobId, cv: CV, profileHash: PROFILE_HASH }, T0);
  if (!result.created) throw new Error('falha ao criar a candidatura de teste');
  return { applicationId: result.application.id, jobId };
}
function link(
  db: Db,
  over: {
    applicationId: number;
    jobId: number;
    artifactId: number;
    variant?: string;
    state?: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO application_cv_attachments (application_id, job_id, artifact_id, variant, state, created_at, approved_at)
         VALUES (@applicationId, @jobId, @artifactId, @variant, @state, @at, NULL)`,
      )
      .run({ variant: 'generico', state: 'em_preparacao', at: AT, ...over }).lastInsertRowid,
  );
}
const setState = (db: Db, id: number, state: string): void => {
  db.prepare(
    `UPDATE application_cv_attachments SET state = @state,
       approved_at = CASE WHEN @state = 'aprovado' THEN @at ELSE approved_at END,
       approval_reason = CASE WHEN @state = 'aprovado' THEN 'teste' ELSE approval_reason END,
       revoked_at = CASE WHEN @state = 'revogado' THEN @at END,
       revocation_reason = CASE WHEN @state = 'revogado' THEN 'motivo de teste' END,
       superseded_at = CASE WHEN @state = 'substituido' THEN @at END WHERE id = @id`,
  ).run({ id, state, at: AT });
};
const setAppStatus = (db: Db, id: number, status: string): void => {
  db.prepare("UPDATE applications SET mode = 'revisao' WHERE id = ?").run(id);
  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, id);
};

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

describe('migração 0008: aplicação e compatibilidade', () => {
  it('aplica em banco vazio, sem violar chaves estrangeiras, e é idempotente', () => {
    const empty = openDatabase(IN_MEMORY);
    expect(runMigrations(empty)).toContain('0008_cv_artifacts.sql');
    expect(empty.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(empty)).toEqual([]);
    expect(getMigrationStatus(empty).pending).toEqual([]);
    for (const table of ['cv_artifacts', 'application_cv_attachments'])
      expect((empty.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(
        0,
      );
    empty.close();
  });

  it('preserva candidaturas existentes e NÃO preenche as tabelas novas', () => {
    const old = openDatabase(IN_MEMORY);
    runMigrations(old, before0008());
    const jobId = seedJob(old);
    const created = createApplication(old, { jobId, cv: CV, profileHash: PROFILE_HASH }, T0);
    if (!created.created) throw new Error('falha');
    const snapshot = (): unknown[] => [
      old.prepare('SELECT * FROM applications ORDER BY id').all(),
      old.prepare('SELECT * FROM application_events ORDER BY id').all(),
      old.prepare('SELECT * FROM jobs ORDER BY id').all(),
    ];
    const before = snapshot();
    expect(runMigrations(old)).toEqual([
      '0008_cv_artifacts.sql',
      '0009_email_test_evidence.sql',
      '0010_job_leads.sql',
      '0011_autonomous_runs.sql',
      '0012_autonomous_grants.sql',
    ]);
    expect(snapshot()).toEqual(before);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect((old.prepare('SELECT COUNT(*) AS n FROM cv_artifacts').get() as { n: number }).n).toBe(
      0,
    );
    expect(
      (old.prepare('SELECT COUNT(*) AS n FROM application_cv_attachments').get() as { n: number })
        .n,
    ).toBe(0);
    // A identidade original (currículo mestre) continua imutável.
    expect(() =>
      old
        .prepare('UPDATE applications SET cv_sha256 = ? WHERE id = ?')
        .run('d'.repeat(64), created.application.id),
    ).toThrow(/imutáveis/);
    old.close();
  });

  it('não altera as migrações anteriores nem emite saída', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = openDatabase(IN_MEMORY);
    runMigrations(fresh);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    fresh.close();
    const names = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.slice(0, 7)).toEqual([
      '0001_initial_schema.sql',
      '0002_jobs_persistence.sql',
      '0003_jobs_apply_url.sql',
      '0004_job_eligibility.sql',
      '0005_applications_history.sql',
      '0006_application_drafts.sql',
      '0007_email_channel.sql',
    ]);
  });

  it('não guarda bytes do PDF nem dados pessoais: colunas e gatilhos esperados', () => {
    const cols = (t: string): string[] =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('cv_artifacts')).toEqual([
      'id',
      'variant',
      'pdf_sha256',
      'pdf_bytes',
      'pages',
      'model_hash',
      'generated_at',
      'validation',
      'file_name',
    ]);
    expect(cols('application_cv_attachments')).toEqual([
      'id',
      'application_id',
      'job_id',
      'artifact_id',
      'variant',
      'state',
      'created_at',
      'approved_at',
      'approval_reason',
      'revoked_at',
      'revocation_reason',
      'superseded_at',
    ]);
    const types = (db.prepare('PRAGMA table_info(cv_artifacts)').all() as { type: string }[]).map(
      (c) => c.type,
    );
    expect(types).not.toContain('BLOB');
  });
});

describe('cv_artifacts', () => {
  it('aceita as cinco variantes e rejeita qualquer outra', () => {
    for (const [i, v] of CV_VARIANTS.entries())
      artifact(db, { variant: v.id, sha: String(i).repeat(64) });
    for (const bad of ['suporte', 'dados', 'GENERICO', '', 'qa ']) {
      expect(() =>
        artifact(db, { variant: bad, fileName: `curriculo-${bad}-20261023-aaaaaaaa.pdf` }),
      ).toThrow(/CHECK/);
    }
  });

  it.each([
    ['curto', 'a'.repeat(63)],
    ['longo', 'a'.repeat(65)],
    ['maiúsculas', 'A'.repeat(64)],
    ['não hexadecimal', 'g'.repeat(64)],
    ['vazio', ''],
  ])('rejeita SHA-256 malformado (%s)', (_n, sha) => {
    expect(() =>
      artifact(db, { sha, fileName: 'curriculo-generico-20261023-aaaaaaaa.pdf' }),
    ).toThrow(/CHECK/);
  });

  it('rejeita hash do modelo malformado, páginas, tamanho, data e validação inválidos', () => {
    expect(() => artifact(db, { model: 'x'.repeat(64) })).toThrow(/CHECK/);
    expect(() => artifact(db, { model: 'b'.repeat(10) })).toThrow(/CHECK/);
    expect(() => artifact(db, { pages: 0 })).toThrow(/CHECK/);
    expect(() => artifact(db, { pages: 11 })).toThrow(/CHECK/);
    expect(() => artifact(db, { bytes: 0 })).toThrow(/CHECK/);
    expect(() => artifact(db, { bytes: 17 * 1024 * 1024 })).toThrow(/CHECK/);
    expect(() => artifact(db, { at: '23/10/2026' })).toThrow(/CHECK/);
    expect(() => artifact(db, { validation: 'pendente' })).toThrow(/CHECK/);
    expect(() => artifact(db, { validation: 'diagnostico' })).toThrow(/CHECK/);
  });

  it.each([
    ['caminho absoluto', '/home/x/curriculo-generico-20261023-aaaaaaaa.pdf'],
    ['travessia', '../curriculo-generico-20261023-aaaaaaaa.pdf'],
    ['subdiretório', 'a/curriculo-generico-20261023-aaaaaaaa.pdf'],
    ['variante diferente', 'curriculo-qa-20261023-aaaaaaaa.pdf'],
    ['sha8 diferente', 'curriculo-generico-20261023-bbbbbbbb.pdf'],
    ['data inválida', 'curriculo-generico-2026-aaaaaaaa.pdf'],
    ['extensão', 'curriculo-generico-20261023-aaaaaaaa.exe'],
    ['nome livre', 'meu-curriculo.pdf'],
  ])('rejeita nome de arquivo inseguro ou fora do padrão (%s)', (_n, fileName) => {
    expect(() => artifact(db, { fileName })).toThrow(/CHECK/);
  });

  it('impede duplicação e preserva PDFs idênticos de variantes diferentes', () => {
    artifact(db);
    expect(() => artifact(db)).toThrow(/UNIQUE/);
    // Mesmo PDF em outra variante (ex.: genérico = desenvolvimento) é um artefato distinto e válido.
    expect(artifact(db, { variant: 'desenvolvimento' })).toBeGreaterThan(0);
    // Mesma variante e PDF com outro modelo aprovado: outro registro.
    expect(
      artifact(db, { model: 'c'.repeat(64), fileName: 'curriculo-generico-20261024-aaaaaaaa.pdf' }),
    ).toBeGreaterThan(0);
  });

  it('é imutável: sem UPDATE nem DELETE', () => {
    const id = artifact(db);
    expect(() => db.prepare('UPDATE cv_artifacts SET pages = 1 WHERE id = ?').run(id)).toThrow(
      /imutável/,
    );
    expect(() =>
      db.prepare('UPDATE cv_artifacts SET pdf_sha256 = ? WHERE id = ?').run('c'.repeat(64), id),
    ).toThrow(/imutável/);
    expect(() => db.prepare('DELETE FROM cv_artifacts WHERE id = ?').run(id)).toThrow(/imutável/);
  });

  it('o contrato TypeScript descreve as linhas reais', () => {
    const id = artifact(db);
    expect(
      cvArtifactRowSchema.safeParse(db.prepare('SELECT * FROM cv_artifacts WHERE id = ?').get(id))
        .success,
    ).toBe(true);
    expect(
      cvArtifactRowSchema.safeParse({
        ...(db.prepare('SELECT * FROM cv_artifacts').get() as object),
        pdf_bytes_blob: 1,
      }).success,
    ).toBe(false);
  });
});

describe('application_cv_attachments', () => {
  it('cria vínculo provisório válido (candidatura preparada, mesma vaga, mesma variante)', () => {
    const app = appFor(db);
    const artifactId = artifact(db);
    const id = link(db, { ...app, artifactId });
    const row = db.prepare('SELECT * FROM application_cv_attachments WHERE id = ?').get(id);
    expect(attachmentRowSchema.parse(row)).toMatchObject({
      state: 'em_preparacao',
      approved_at: null,
      superseded_at: null,
    });
  });

  it('rejeita referências inexistentes e inconsistentes', () => {
    const app = appFor(db);
    const artifactId = artifact(db);
    expect(() => link(db, { ...app, applicationId: 9999, artifactId })).toThrow(
      /FOREIGN KEY|candidatura inexistente/,
    );
    expect(() => link(db, { ...app, jobId: 9999, artifactId })).toThrow(/FOREIGN KEY|outra vaga/);
    expect(() => link(db, { ...app, artifactId: 9999 })).toThrow(
      /FOREIGN KEY|artefato inexistente/,
    );
    // Vaga de outra candidatura.
    const other = appFor(db);
    expect(() => link(db, { ...app, jobId: other.jobId, artifactId })).toThrow(/outra vaga/);
    // Variante do vínculo diferente da do artefato.
    expect(() => link(db, { ...app, artifactId, variant: 'qa' })).toThrow(/outra variante/);
    // Variante inexistente.
    expect(() => link(db, { ...app, artifactId, variant: 'suporte' })).toThrow(
      /CHECK|outra variante/,
    );
  });

  it('nasce sempre em_preparacao e só para candidatura preparada', () => {
    const app = appFor(db);
    const artifactId = artifact(db);
    expect(() => link(db, { ...app, artifactId, state: 'aprovado' })).toThrow();
    for (const status of [
      'aprovada_para_envio',
      'enviada',
      'falhou',
      'pendente_intervencao_humana',
    ]) {
      const other = appFor(db);
      setAppStatus(db, other.applicationId, status);
      expect(() => link(db, { ...other, artifactId })).toThrow(/preparada/);
    }
  });

  it('impede mais de um vínculo vivo por candidatura, mas permite o mesmo artefato em outra vaga', () => {
    const app = appFor(db);
    const first = artifact(db);
    const second = artifact(db, { variant: 'qa', sha: 'c'.repeat(64) });
    link(db, { ...app, artifactId: first });
    expect(() => link(db, { ...app, artifactId: second, variant: 'qa' })).toThrow(/UNIQUE/);
    const other = appFor(db);
    expect(link(db, { ...other, artifactId: first })).toBeGreaterThan(0);
  });

  it('permite substituir o vínculo provisório, mantendo o histórico', () => {
    const app = appFor(db);
    const first = artifact(db);
    const second = artifact(db, { variant: 'qa', sha: 'c'.repeat(64) });
    const one = link(db, { ...app, artifactId: first });
    setState(db, one, 'substituido');
    const two = link(db, { ...app, artifactId: second, variant: 'qa' });
    const states = db.prepare('SELECT id, state FROM application_cv_attachments ORDER BY id').all();
    expect(states).toEqual([
      { id: one, state: 'substituido' },
      { id: two, state: 'em_preparacao' },
    ]);
  });

  it('o vínculo aprovado só admite revogação: sem troca, sem retorno e sem exclusão', () => {
    const app = appFor(db);
    const first = artifact(db);
    const second = artifact(db, { variant: 'qa', sha: 'c'.repeat(64) });
    const id = link(db, { ...app, artifactId: first });
    setState(db, id, 'aprovado');
    expect(() => {
      setState(db, id, 'substituido');
    }).toThrow(/só pode ser revogado/);
    expect(() => {
      setState(db, id, 'em_preparacao');
    }).toThrow(/só pode ser revogado/);
    expect(() =>
      db
        .prepare('UPDATE application_cv_attachments SET artifact_id = ? WHERE id = ?')
        .run(second, id),
    ).toThrow(/imutáveis|só pode ser/);
    expect(() =>
      db.prepare("UPDATE application_cv_attachments SET variant = 'qa' WHERE id = ?").run(id),
    ).toThrow(/imutáveis|só pode ser/);
    expect(() =>
      db
        .prepare(
          "UPDATE application_cv_attachments SET approved_at = ?, state = 'revogado', revoked_at = ?, revocation_reason = 'x' WHERE id = ?",
        )
        .run('2027-01-01T00:00:00.000Z', AT, id),
    ).toThrow(/aprovação do vínculo/);
    expect(() => db.prepare('DELETE FROM application_cv_attachments WHERE id = ?').run(id)).toThrow(
      /não pode ser apagado/,
    );
    // Nenhum segundo vínculo vivo substitui o aprovado em silêncio.
    expect(() => link(db, { ...app, artifactId: second, variant: 'qa' })).toThrow(/UNIQUE/);
  });

  it('revogação explícita: preserva o histórico, é terminal e exige nova seleção e aprovação', () => {
    const app = appFor(db);
    const first = artifact(db);
    const second = artifact(db, { variant: 'qa', sha: 'c'.repeat(64) });
    const id = link(db, { ...app, artifactId: first });
    setState(db, id, 'aprovado');
    setState(db, id, 'revogado');
    const row = db.prepare('SELECT * FROM application_cv_attachments WHERE id = ?').get(id);
    expect(attachmentRowSchema.parse(row)).toMatchObject({
      state: 'revogado',
      approved_at: AT,
      approval_reason: 'teste',
      revoked_at: AT,
      revocation_reason: 'motivo de teste',
      artifact_id: first,
    });
    // Não reativa, não aprova de novo, não altera nada, não apaga.
    for (const state of ['em_preparacao', 'aprovado', 'substituido', 'revogado'])
      expect(() => {
        setState(db, id, state);
      }).toThrow(/definitivo/);
    expect(() =>
      db
        .prepare('UPDATE application_cv_attachments SET revocation_reason = ? WHERE id = ?')
        .run('outro', id),
    ).toThrow(/definitivo/);
    expect(() => db.prepare('DELETE FROM application_cv_attachments WHERE id = ?').run(id)).toThrow(
      /não pode ser apagado/,
    );
    // Um novo vínculo é uma nova linha, que nasce em preparação e precisa ser aprovada de novo.
    const fresh = link(db, { ...app, artifactId: second, variant: 'qa' });
    expect(
      db
        .prepare('SELECT state, approved_at FROM application_cv_attachments WHERE id = ?')
        .get(fresh),
    ).toEqual({ state: 'em_preparacao', approved_at: null });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM application_cv_attachments WHERE application_id = ?')
        .get(app.applicationId),
    ).toEqual({ n: 2 });
  });

  it('revogação exige motivo e candidatura ainda não enviada', () => {
    const app = appFor(db);
    const id = link(db, { ...app, artifactId: artifact(db) });
    setState(db, id, 'aprovado');
    for (const reason of ['', '   ', 'x'.repeat(301)])
      expect(() =>
        db
          .prepare(
            "UPDATE application_cv_attachments SET state = 'revogado', revoked_at = ?, revocation_reason = ? WHERE id = ?",
          )
          .run(AT, reason, id),
      ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("UPDATE application_cv_attachments SET state = 'revogado' WHERE id = ?").run(id),
    ).toThrow(/CHECK/);
    for (const status of ['enviada', 'pendente_intervencao_humana', 'entrega_confirmada']) {
      setAppStatus(db, app.applicationId, status);
      expect(() => {
        setState(db, id, 'revogado');
      }).toThrow(/já enviada|intervenção/);
    }
    setAppStatus(db, app.applicationId, 'falhou');
    setState(db, id, 'revogado');
  });

  it('aprovação exige motivo', () => {
    const app = appFor(db);
    const id = link(db, { ...app, artifactId: artifact(db) });
    expect(() =>
      db
        .prepare(
          "UPDATE application_cv_attachments SET state = 'aprovado', approved_at = ?, approval_reason = '  ' WHERE id = ?",
        )
        .run(AT, id),
    ).toThrow(/CHECK/);
  });

  it('qualquer mudança no vínculo vence na hora as autorizações de envio ainda não usadas', () => {
    const app = appFor(db);
    const future = '2099-01-01T00:00:00.000Z';
    const authorize = (applicationId: number): number =>
      Number(
        db
          .prepare(
            "INSERT INTO email_authorizations (application_id, kind, binding_hash, reason, created_at, expires_at) VALUES (?, 'real', ?, 'teste', ?, ?)",
          )
          .run(applicationId, 'f'.repeat(64), AT, future).lastInsertRowid,
      );
    const expiry = (id: number): string =>
      (
        db.prepare('SELECT expires_at FROM email_authorizations WHERE id = ?').get(id) as {
          expires_at: string;
        }
      ).expires_at;
    const used = authorize(app.applicationId);
    db.prepare('UPDATE email_authorizations SET used_at = ? WHERE id = ?').run(AT, used);
    const other = appFor(db);
    const untouched = authorize(other.applicationId);

    const first = authorize(app.applicationId);
    const id = link(db, { ...app, artifactId: artifact(db) });
    expect(expiry(first)).toBe(AT);
    const second = authorize(app.applicationId);
    setState(db, id, 'aprovado');
    expect(expiry(second)).toBe(AT);
    const third = authorize(app.applicationId);
    setState(db, id, 'revogado');
    expect(expiry(third)).toBe(AT);
    // Autorização já usada e autorização de outra candidatura não são tocadas.
    expect(expiry(used)).toBe(future);
    expect(expiry(untouched)).toBe(future);
  });

  it('a identidade do vínculo provisório também é imutável, mesmo combinada a uma transição válida', () => {
    const app = appFor(db);
    const first = artifact(db);
    const second = artifact(db, { sha: 'c'.repeat(64) });
    const id = link(db, { ...app, artifactId: first });
    const attempt =
      (sql: string, ...params: unknown[]): (() => unknown) =>
      () =>
        db.prepare(sql).run(...params);
    expect(
      attempt('UPDATE application_cv_attachments SET artifact_id = ? WHERE id = ?', second, id),
    ).toThrow(/imutáveis|só pode ser/);
    expect(
      attempt(
        "UPDATE application_cv_attachments SET artifact_id = ?, state = 'aprovado', approved_at = ? WHERE id = ?",
        second,
        AT,
        id,
      ),
    ).toThrow(/imutáveis/);
    expect(
      attempt(
        "UPDATE application_cv_attachments SET job_id = ?, state = 'aprovado', approved_at = ? WHERE id = ?",
        app.jobId + 1,
        AT,
        id,
      ),
    ).toThrow(/imutáveis/);
    expect(
      attempt("UPDATE application_cv_attachments SET state = 'em_preparacao' WHERE id = ?", id),
    ).toThrow(/aprovado ou substituído/);
    expect(
      db.prepare('SELECT artifact_id, state FROM application_cv_attachments WHERE id = ?').get(id),
    ).toEqual({ artifact_id: first, state: 'em_preparacao' });
  });

  it('só aprova com candidatura preparada ou aprovada para envio, e só substitui se preparada', () => {
    const a = appFor(db);
    const artifactId = artifact(db);
    const toApprove = link(db, { ...a, artifactId });
    setAppStatus(db, a.applicationId, 'aprovada_para_envio');
    expect(() => {
      setState(db, toApprove, 'substituido');
    }).toThrow(/ainda preparada/);
    setState(db, toApprove, 'aprovado');

    const b = appFor(db);
    const pending = link(db, { ...b, artifactId });
    setAppStatus(db, b.applicationId, 'enviada');
    expect(() => {
      setState(db, pending, 'aprovado');
    }).toThrow(/preparada ou aprovada/);
  });

  it('exige datas coerentes com o estado', () => {
    const app = appFor(db);
    const id = link(db, { ...app, artifactId: artifact(db) });
    expect(() =>
      db.prepare("UPDATE application_cv_attachments SET state = 'aprovado' WHERE id = ?").run(id),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare("UPDATE application_cv_attachments SET state = 'substituido' WHERE id = ?")
        .run(id),
    ).toThrow(/CHECK/);
  });

  it('guarda o suficiente para reverificar vaga, variante, modelo e hash do PDF', () => {
    const app = appFor(db);
    const id = link(db, { ...app, artifactId: artifact(db) });
    const joined = db
      .prepare(
        `SELECT l.job_id, l.variant, a.model_hash, a.pdf_sha256, a.pdf_bytes, a.pages, a.file_name
           FROM application_cv_attachments l JOIN cv_artifacts a ON a.id = l.artifact_id WHERE l.id = ?`,
      )
      .get(id);
    expect(joined).toMatchObject({
      job_id: app.jobId,
      variant: 'generico',
      model_hash: MODEL,
      pdf_sha256: HASH,
    });
  });

  it('chaves estrangeiras permanecem íntegras após o uso', () => {
    const app = appFor(db);
    setState(db, link(db, { ...app, artifactId: artifact(db) }), 'aprovado');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
