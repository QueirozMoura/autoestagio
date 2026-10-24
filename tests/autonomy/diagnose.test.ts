import { beforeEach, describe, expect, it } from 'vitest';
import { diagnose, parsePolicy, runAutonomous } from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { seedJob } from '../helpers/applications.js';
import { profile } from '../helpers/eligibility.js';

const NOW = new Date('2026-10-24T12:00:00Z');
let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const analyze = () =>
  runAutonomous({
    db,
    profile: profile(),
    policy: parsePolicy({}),
    mode: 'simulacao',
    now: () => NOW,
  });

describe('diagnóstico das vagas', () => {
  it('separa aptas, dados ausentes e incompatibilidade real, sem relaxar nada', async () => {
    seedJob(db, {
      verdict: null,
      title: 'Estágio em Suporte Técnico',
      workMode: 'hibrido',
      location: 'São Paulo - Pinheiros',
      stipend: 1500,
    });
    seedJob(db, {
      verdict: null,
      title: 'Estágio em Suporte Técnico',
      workMode: 'hibrido',
      location: 'São Paulo - Pinheiros',
      stipend: null,
    });
    seedJob(db, {
      verdict: null,
      title: 'Estágio em Marketing',
      workMode: 'remoto',
      location: 'Brasil',
      stipend: 1500,
    });
    seedJob(db, {
      verdict: null,
      title: 'Estágio em Dados',
      workMode: 'remoto',
      location: 'Brasil',
      stipend: 900,
    });
    await analyze();
    const result = diagnose(db, profile());
    expect(result.total).toBe(4);
    expect(result.byClass).toEqual({ apta: 1, dados_ausentes: 1, incompativel: 2 });
    expect(result.byCriterion.bolsa).toEqual({ nao_atende: 1, indeterminado: 1 });
    expect(result.byCriterion.area?.nao_atende).toBe(1);
    expect(result.missingSets).toEqual([{ missing: ['bolsa'], jobs: 1 }]);
    // Só a pergunta "e se": uma vaga a mais seria apta; bolsa divulgada abaixo do mínimo continua reprovada.
    expect(result.whatIf).toEqual([{ tolerate: ['bolsa'], wouldBeApto: 2 }]);
  });
});
