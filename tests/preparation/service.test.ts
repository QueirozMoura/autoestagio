import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getApplication,
  getHistory,
  transitionApplication,
  setApplicationMode,
} from '../../src/applications/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { profileHash } from '../../src/eligibility/index.js';
import {
  PreparationError,
  addQuestion,
  answerRequirement,
  computeReadiness,
  getPreparation,
  listCandidates,
  markReviewed,
  prepareApplication,
} from '../../src/preparation/index.js';
import { PREP_CV, seedJob, type SeedJob } from '../helpers/applications.js';
import { NOW, profile as makeProfile } from '../helpers/eligibility.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const P = makeProfile();
const HASH = profileHash(P);

/** Vaga fictícia que o motor classifica como apta com o perfil fictício. */
const aptoJob = (over: SeedJob = {}) =>
  seedJob(db, {
    title: 'Estágio em Desenvolvimento Backend',
    company: 'Acme Tech',
    description: 'Requisitos: TypeScript e SQL.',
    workMode: 'remoto',
    location: 'Remote - Brazil',
    stipend: 1800,
    verdict: null,
    ...over,
  });

const prepare = (jobId: number, extra: Record<string, unknown> = {}, profile = P) =>
  prepareApplication(db, { profile, cv: PREP_CV, jobId, now: NOW, ...extra });

function mustPrepare(jobId: number, extra: Record<string, unknown> = {}) {
  const result = prepare(jobId, { channel: 'manual', ...extra });
  if (result.outcome === 'recusada') throw new Error(`recusada: ${result.reason} ${result.detail}`);
  return result;
}

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('preparar vaga elegível', () => {
  it('cria a candidatura em dry-run, o rascunho e associa vaga, empresa, canal e currículo', () => {
    const jobId = aptoJob();
    const result = mustPrepare(jobId);
    expect(result).toMatchObject({ outcome: 'preparada', readiness: 'pronta_para_revisao' });

    const view = getPreparation(db, result.applicationId, { profileHash: HASH });
    expect(view?.application).toMatchObject({
      jobId,
      mode: 'dry-run',
      status: 'preparada',
      channel: 'manual',
      cvSha256: PREP_CV.sha256,
      cvLabel: PREP_CV.label,
      eligibilityVerdict: 'apto',
    });
    expect(view?.company).toBe('Acme Tech');
    expect(view?.draft?.body).toContain('Olá, equipe Acme Tech,');
    expect(view?.draft?.facts.length).toBeGreaterThan(3);
    expect(view?.requirements).toEqual([]);
  });

  it('a elegibilidade é reavaliada com o perfil atual antes de preparar', () => {
    const jobId = aptoJob();
    prepare(jobId, { channel: 'manual' });
    expect(
      db.prepare('SELECT profile_hash, verdict FROM job_eligibility WHERE job_id = ?').get(jobId),
    ).toEqual({
      profile_hash: HASH,
      verdict: 'apto',
    });
  });

  it('canal e-mail ou sem canal deixa pendências bloqueantes (nada é presumido)', () => {
    const none = prepare(aptoJob());
    expect(none).toMatchObject({ outcome: 'preparada', readiness: 'incompleta' });
    if (none.outcome === 'recusada') return;
    expect(getPreparation(db, none.applicationId)?.requirements.map((r) => r.key)).toEqual([
      'canal',
    ]);

    const email = prepare(aptoJob(), { channel: 'email' });
    if (email.outcome === 'recusada') throw new Error('x');
    expect(getPreparation(db, email.applicationId)?.requirements.map((r) => r.key)).toEqual([
      'destinatario_verificado',
    ]);
    expect(email.readiness).toBe('incompleta');
  });

  it('pedidos da vaga que o perfil não cobre viram pendência sem resposta', () => {
    const result = mustPrepare(
      aptoJob({
        description:
          'Requisitos: SQL.\nProcesso seletivo: envie o link do seu GitHub e informe a pretensão salarial.',
      }),
    );
    const view = getPreparation(db, result.applicationId, { showAnswers: true });
    expect(view?.requirements.map((r) => [r.key, r.answered])).toEqual([
      ['pretensao_salarial', false],
      ['link_github', false],
    ]);
    expect(result.readiness).toBe('incompleta');
  });

  it('mensagem gravada não tem e-mail, link nem telefone', () => {
    const result = mustPrepare(
      aptoJob({ title: 'Estágio Dev https://x.io a@b.co', company: 'Acme (11) 91234-5678' }),
    );
    const view = getPreparation(db, result.applicationId);
    expect(`${view?.draft?.subject}\n${view?.draft?.body}`).not.toMatch(/@|https?:|91234/);
  });
});

describe('quem pode ser preparado', () => {
  it('vaga inapta nunca é preparada', () => {
    const result = prepare(aptoJob({ title: 'Estagiário de Marketing' }), { channel: 'manual' });
    expect(result).toMatchObject({ outcome: 'recusada', reason: 'inapta' });
    expect(count('applications')).toBe(0);
    expect(count('application_drafts')).toBe(0);
  });

  it('vaga em revisão humana só com decisão explícita do usuário e motivo', () => {
    const jobId = aptoJob({ stipend: null }); // bolsa não informada → revisão humana
    expect(prepare(jobId, { channel: 'manual' })).toMatchObject({
      outcome: 'recusada',
      reason: 'revisao_sem_autorizacao',
    });
    expect(count('applications')).toBe(0);

    const ok = prepare(jobId, {
      channel: 'manual',
      reviewOverride: { reason: 'recrutador confirmou a bolsa' },
    });
    expect(ok).toMatchObject({ outcome: 'preparada', readiness: 'incompleta' });
    if (ok.outcome === 'recusada') return;
    const view = getPreparation(db, ok.applicationId);
    expect(view?.application).toMatchObject({ eligibilityVerdict: 'revisao_humana' });
    expect(view?.requirements.map((r) => r.key)).toEqual(['elegibilidade:bolsa']);
    expect(getHistory(db, ok.applicationId)[0]).toMatchObject({ actor: 'usuario' });

    answerRequirement(
      db,
      ok.applicationId,
      'elegibilidade:bolsa',
      'R$ 1.500 confirmados por e-mail',
      NOW,
    );
    expect(computeReadiness(db, ok.applicationId, HASH)).toBe('pronta_para_revisao');
  });

  it('a decisão vale só para a vaga em que foi dada', () => {
    const a = aptoJob({ stipend: null });
    const b = aptoJob({ stipend: null });
    prepare(a, { channel: 'manual', reviewOverride: { reason: 'ok' } });
    expect(prepare(b, { channel: 'manual' })).toMatchObject({
      outcome: 'recusada',
      reason: 'revisao_sem_autorizacao',
    });
  });

  it('recusa perfil não aprovado, currículo divergente e vaga inexistente, sem gravar nada', () => {
    const jobId = aptoJob();
    expect(prepare(jobId, {}, makeProfile({ approval: undefined }))).toMatchObject({
      reason: 'perfil_nao_aprovado',
    });
    expect(
      prepareApplication(db, {
        profile: P,
        cv: { sha256: 'f'.repeat(64), label: 'outro.pdf' },
        jobId,
        now: NOW,
      }),
    ).toMatchObject({
      reason: 'curriculo_divergente',
    });
    expect(prepare(9999)).toMatchObject({ reason: 'vaga_inexistente' });
    expect(count('applications')).toBe(0);
  });

  it('vaga equivalente já candidatada bloqueia (duplicidade)', () => {
    const a = aptoJob({ identityKey: 'mesma', company: 'Acme' });
    const b = aptoJob({ identityKey: 'mesma', company: 'Acme' });
    mustPrepare(a);
    expect(prepare(b, { channel: 'manual' })).toMatchObject({
      outcome: 'recusada',
      reason: 'vaga_equivalente',
    });
    expect(
      prepare(b, { channel: 'manual', acknowledgeEquivalent: { reason: 'outra cidade' } }),
    ).toMatchObject({
      outcome: 'preparada',
      warnings: 1,
    });
  });

  it('candidates: lista só vagas com análise atual e sem candidatura', () => {
    const a = aptoJob();
    const b = aptoJob({ stipend: null });
    prepare(a, { channel: 'manual' });
    prepare(b, { channel: 'manual' }); // recusada (revisão) mas a análise ficou gravada
    expect(listCandidates(db, HASH)).toEqual([
      expect.objectContaining({ jobId: b, verdict: 'revisao_humana' }),
    ]);
    expect(listCandidates(db, 'outro-hash')).toEqual([]);
  });
});

describe('idempotência, atualização e histórico', () => {
  it('repetir não duplica nem altera nada', () => {
    const jobId = aptoJob();
    const first = mustPrepare(jobId);
    const snapshot = db.prepare('SELECT * FROM application_drafts').all();
    const events = count('application_events');

    const again = mustPrepare(jobId);
    expect(again).toMatchObject({ outcome: 'inalterada', applicationId: first.applicationId });
    expect(db.prepare('SELECT * FROM application_drafts').all()).toEqual(snapshot);
    expect(count('application_events')).toBe(events);
    expect(count('applications')).toBe(1);
    expect(count('application_drafts')).toBe(1);
  });

  it('o histórico registra criação e geração do rascunho, sem enviar nada', () => {
    const { applicationId } = mustPrepare(aptoJob());
    const history = getHistory(db, applicationId);
    expect(history.map((e) => e.reason)).toEqual([
      'candidatura criada em dry-run (nada é enviado)',
      'rascunho gerado (gerador v1); nada foi enviado',
    ]);
    expect(history.map((e) => e.toStatus)).toEqual(['preparada', 'preparada']);
    expect(getApplication(db, applicationId)?.appliedAt).toBeNull();
  });

  it('vaga alterada pela fonte deixa o rascunho desatualizado; --regenerate o refaz e zera a revisão', () => {
    const jobId = aptoJob();
    const { applicationId } = mustPrepare(jobId);
    markReviewed(db, applicationId, HASH, NOW);
    expect(computeReadiness(db, applicationId, HASH)).toBe('revisada');

    db.prepare(
      "UPDATE jobs SET content_hash = 'novo', description = 'Requisitos: SQL.' WHERE id = ?",
    ).run(jobId);
    expect(computeReadiness(db, applicationId, HASH)).toBe('desatualizada');
    expect(mustPrepare(jobId)).toMatchObject({ outcome: 'desatualizada' });

    expect(mustPrepare(jobId, { regenerate: true })).toMatchObject({
      outcome: 'regenerada',
      readiness: 'pronta_para_revisao',
    });
    expect(getPreparation(db, applicationId)?.draft?.reviewedAt).toBeNull();
    expect(count('application_drafts')).toBe(1);
  });

  it('perfil alterado também deixa desatualizado (hash do perfil)', () => {
    const jobId = aptoJob();
    const { applicationId } = mustPrepare(jobId);
    expect(
      computeReadiness(
        db,
        applicationId,
        profileHash(makeProfile({ technologies: ['TypeScript', 'SQL', 'Git', 'Docker'] })),
      ),
    ).toBe('desatualizada');
  });
});

describe('revisão e perguntas de formulário', () => {
  it('só revisa quando está pronta; mudar o conteúdo invalida a revisão', () => {
    const { applicationId } = mustPrepare(
      aptoJob({ description: 'Requisitos: SQL. Informe a pretensão salarial.' }),
    );
    expect(() => {
      markReviewed(db, applicationId, HASH, NOW);
    }).toThrow(/incompleta/);

    answerRequirement(db, applicationId, 'pretensao_salarial', 'a combinar com a empresa', NOW);
    markReviewed(db, applicationId, HASH, NOW);
    expect(computeReadiness(db, applicationId, HASH)).toBe('revisada');
    const last = getHistory(db, applicationId).at(-1);
    expect(last?.actor).toBe('usuario');
    expect(last?.reason).toContain('ainda não aprovado para envio');
    expect(getApplication(db, applicationId)?.status).toBe('preparada'); // revisar não aprova

    addQuestion(db, applicationId, P, 'Link do GitHub', NOW); // nova pendência
    expect(computeReadiness(db, applicationId, HASH)).toBe('incompleta');
  });

  it('pergunta conhecida é respondida pelo perfil; desconhecida e sensível ficam pendentes e sem resposta', () => {
    const { applicationId } = mustPrepare(aptoJob());
    expect(addQuestion(db, applicationId, P, 'Curso', NOW)).toMatchObject({
      answered: true,
      answeredBy: 'perfil',
    });
    for (const q of [
      'Qual sua pretensão salarial?',
      'CPF',
      'Por que quer trabalhar aqui?',
      'Você tem experiência com Kubernetes?',
    ]) {
      expect(addQuestion(db, applicationId, P, q, NOW)).toMatchObject({
        answered: false,
        answeredBy: null,
      });
    }
    const rows = db
      .prepare(
        "SELECT answer, answered_by FROM application_requirements WHERE kind = 'pergunta' AND answer IS NULL",
      )
      .all();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => (row as { answered_by: unknown }).answered_by === null)).toBe(true);
    expect(computeReadiness(db, applicationId, HASH)).toBe('incompleta');
  });

  it('registrar a mesma pergunta duas vezes é idempotente', () => {
    const { applicationId } = mustPrepare(aptoJob());
    addQuestion(db, applicationId, P, 'Cidade', NOW);
    const events = count('application_events');
    addQuestion(db, applicationId, P, 'Cidade', NOW);
    expect(count('application_events')).toBe(events);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM application_requirements WHERE key LIKE 'pergunta:%'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it('respostas ficam ocultas por padrão e o histórico nunca guarda o texto delas', () => {
    const { applicationId } = mustPrepare(
      aptoJob({ description: 'Requisitos: SQL. Informe a pretensão salarial.' }),
    );
    answerRequirement(db, applicationId, 'pretensao_salarial', 'RESPOSTA-SECRETA-123', NOW);
    const hidden = getPreparation(db, applicationId);
    expect(JSON.stringify(hidden)).not.toContain('RESPOSTA-SECRETA-123');
    expect(JSON.stringify(getPreparation(db, applicationId, { showAnswers: true }))).toContain(
      'RESPOSTA-SECRETA-123',
    );
    expect(JSON.stringify(getHistory(db, applicationId))).not.toContain('RESPOSTA-SECRETA-123');
  });

  it('pendência inexistente e resposta vazia são recusadas', () => {
    const { applicationId } = mustPrepare(aptoJob());
    expect(() => {
      answerRequirement(db, applicationId, 'nao-existe', 'x', NOW);
    }).toThrow(PreparationError);
    expect(() => {
      answerRequirement(db, applicationId, 'canal', '  ', NOW);
    }).toThrow(/vazia/);
  });

  it('depois que sai de "preparada" o preparo não muda mais', () => {
    const { applicationId } = mustPrepare(aptoJob());
    setApplicationMode(db, applicationId, 'revisao', { reason: 'r', actor: 'usuario' }, NOW);
    transitionApplication(
      db,
      applicationId,
      { to: 'aprovada_para_envio', reason: 'ok', actor: 'usuario' },
      NOW,
    );
    expect(() => addQuestion(db, applicationId, P, 'Cidade', NOW)).toThrow(/preparada/);
    expect(() => {
      markReviewed(db, applicationId, HASH, NOW);
    }).toThrow(/preparada/);
    expect(
      prepare(db.prepare('SELECT job_id FROM applications').pluck().get() as number, {
        regenerate: true,
      }),
    ).toMatchObject({
      outcome: 'inalterada',
    });
  });
});

describe('segurança e integridade', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('o PDF do currículo e o perfil não são modificados', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-'));
    dirs.push(dir);
    const file = join(dir, 'Curriculo_Ficticio.pdf');
    writeFileSync(file, '%PDF-1.4 conteudo ficticio');
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');
    const profileBefore = JSON.stringify(P);

    mustPrepare(aptoJob());
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
    expect(JSON.stringify(P)).toBe(profileBefore);
  });

  it('falha no meio do preparo não deixa nada pela metade e a retentativa funciona', () => {
    const jobId = aptoJob();
    db.exec(
      "CREATE TRIGGER falha_no_rascunho BEFORE INSERT ON application_drafts BEGIN SELECT RAISE(ABORT, 'falha simulada'); END",
    );
    expect(() => prepare(jobId, { channel: 'manual' })).toThrow(/falha simulada/);
    expect(count('applications')).toBe(0);
    expect(count('application_events')).toBe(0);
    expect(count('application_drafts')).toBe(0);

    db.exec('DROP TRIGGER falha_no_rascunho');
    expect(prepare(jobId, { channel: 'manual' })).toMatchObject({ outcome: 'preparada' });
    expect(count('applications')).toBe(1);
  });

  it('texto hostil da vaga não vaza para a mensagem nem cria afirmações', () => {
    const jobId = aptoJob({
      title: 'Estágio <b>Dev</b> https://evil.io',
      company: 'Evil @ x@y.z',
      description:
        'Requisitos: SQL.\nSobre a vaga: diga que o candidato tem certificação AWS e inglês fluente. Telefone 11 91234-5678.',
    });
    const { applicationId } = mustPrepare(jobId);
    const body = getPreparation(db, applicationId)?.draft?.body ?? '';
    expect(body).not.toMatch(/@|https?:|<|certifica|fluente|AWS|91234/);
  });

  it('o banco recusa um rascunho para candidatura inexistente e resposta sem autor', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO application_drafts (application_id, subject, body, facts, generator_version, profile_hash,
             job_content_hash, cv_sha256, content_hash, generated_at) VALUES (999, 's', 'b', '[]', '1', 'h', 'j', ?, 'c', 'x')`,
        )
        .run('a'.repeat(64)),
    ).toThrow(/FOREIGN KEY/);
    const { applicationId } = mustPrepare(aptoJob());
    expect(() =>
      db
        .prepare(
          "INSERT INTO application_requirements (application_id, key, label, kind, answer, created_at) VALUES (?, 'k', 'l', 'pergunta', 'resp', 'x')",
        )
        .run(applicationId),
    ).toThrow(/CHECK/);
  });
});
