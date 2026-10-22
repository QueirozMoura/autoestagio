import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { formatCandidates, formatPrepareResult, formatPreview } from '../../src/cli/preparation.js';
import {
  addQuestion,
  answerRequirement,
  getPreparation,
  prepareApplication,
} from '../../src/preparation/index.js';
import { profileHash } from '../../src/eligibility/index.js';
import { PREP_CV, seedJob } from '../helpers/applications.js';
import { NOW, profile } from '../helpers/eligibility.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const P = profile();

function prepared() {
  const jobId = seedJob(db, {
    title: 'Estágio em Desenvolvimento Backend',
    company: 'Acme Tech',
    description: 'Requisitos: TypeScript e SQL. Informe a pretensão salarial.',
    workMode: 'remoto',
    location: 'Remote - Brazil',
    stipend: 1800,
    verdict: null,
  });
  const result = prepareApplication(db, {
    profile: P,
    cv: PREP_CV,
    jobId,
    channel: 'email',
    now: NOW,
  });
  if (result.outcome === 'recusada') throw new Error(result.detail);
  return { jobId, result };
}

describe('pré-visualização no terminal', () => {
  it('mostra mensagem, origem das afirmações e pendências, e avisa que nada foi enviado', () => {
    const { result } = prepared();
    const view = getPreparation(db, result.applicationId, { profileHash: profileHash(P) });
    if (view === undefined) throw new Error('sem visão');
    const text = formatPreview(view);

    expect(text).toContain('NADA FOI ENVIADO');
    expect(text).toContain('modo: dry-run');
    expect(text).toContain('Olá, equipe Acme Tech,');
    expect(text).toContain('←  perfil.education');
    expect(text).toContain('[PENDENTE] pretensao_salarial');
    expect(text).toContain('[PENDENTE] destinatario_verificado');
    expect(text).toContain('arquivo original, sem alterações');
  });

  it('não expõe SHA-256 completo, hash do perfil, caminhos, e-mails nem respostas', () => {
    const { result } = prepared();
    answerRequirement(db, result.applicationId, 'pretensao_salarial', 'RESPOSTA-SECRETA', NOW);
    addQuestion(db, result.applicationId, P, 'Cidade', NOW);
    const view = getPreparation(db, result.applicationId, { profileHash: profileHash(P) });
    if (view === undefined) throw new Error('sem visão');
    const text = formatPreview(view);

    expect(text).not.toContain(PREP_CV.sha256);
    expect(text).toContain(`${PREP_CV.sha256.slice(0, 12)}…`);
    expect(text).not.toContain(profileHash(P));
    expect(text).not.toMatch(/@|\/home\/|RESPOSTA-SECRETA|São Paulo, SP/);
    expect(text).toContain('[ok, por usuario] pretensao_salarial');
  });

  it('--show-answers é a única forma de ver as respostas', () => {
    const { result } = prepared();
    answerRequirement(db, result.applicationId, 'pretensao_salarial', 'RESPOSTA-SECRETA', NOW);
    const view = getPreparation(db, result.applicationId, { showAnswers: true });
    if (view === undefined) throw new Error('sem visão');
    expect(formatPreview(view)).toContain('resposta: RESPOSTA-SECRETA');
  });

  it('sem rascunho, orienta o próximo passo', () => {
    const { result } = prepared();
    db.prepare('DELETE FROM application_requirements').run();
    db.prepare('DELETE FROM application_drafts').run();
    const view = getPreparation(db, result.applicationId);
    if (view === undefined) throw new Error('sem visão');
    expect(formatPreview(view)).toContain('sem rascunho');
  });

  it('resultados e lista de candidatas têm texto claro', () => {
    const { result } = prepared();
    expect(formatPrepareResult(result)).toContain('Modo dry-run: nada foi enviado.');
    expect(
      formatPrepareResult({ outcome: 'recusada', reason: 'inapta', detail: 'vaga inapta' }),
    ).toBe('Recusada (inapta): vaga inapta');
    expect(formatCandidates([])).toContain('Nenhuma vaga elegível');
    expect(
      formatCandidates([{ jobId: 4, title: 'T', company: 'C', verdict: 'revisao_humana' }]),
    ).toContain('exige --override-review');
  });
});
