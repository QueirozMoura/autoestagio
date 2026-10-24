import { beforeEach, describe, expect, it } from 'vitest';
import {
  freshSummary,
  parsePolicy,
  runAutonomous,
  sourceMetrics,
} from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { seedJob } from '../helpers/applications.js';
import { profile } from '../helpers/eligibility.js';

const NOW = new Date('2026-10-24T12:00:00Z');
let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
  db.prepare(
    "INSERT INTO sources (id, kind, slug, name) VALUES (2, 'greenhouse', 'banco', 'Banco')",
  ).run();
});

const analyze = () =>
  runAutonomous({
    db,
    profile: profile(),
    policy: parsePolicy({}),
    mode: 'simulacao',
    now: () => NOW,
  });

describe('métricas de descoberta', () => {
  it('conta por fonte as vagas novas, em TI, relevantes, por veredito e com e-mail de candidatura utilizável', async () => {
    const base = { verdict: null, workMode: 'remoto', location: 'Brasil', stipend: 1800 } as const;
    seedJob(db, {
      ...base,
      title: 'Estágio em Desenvolvimento Backend',
      description: 'Requisitos: TypeScript e SQL. Envie seu currículo para rh@acme.com.br',
    });
    seedJob(db, { ...base, title: 'Estágio em Marketing' });
    const noBanco = seedJob(db, {
      ...base,
      title: 'Estágio em Suporte Técnico',
      description: 'Atendimento. Accommodation: accommodation@acme.com.br',
    });
    db.prepare('UPDATE jobs SET source_id = 2 WHERE id = ?').run(noBanco);
    await analyze();
    const rows = sourceMetrics(db, profile(), 7, NOW);
    const ashby = rows.find((r) => r.source === 'ashby:fantasia');
    const banco = rows.find((r) => r.source === 'greenhouse:banco');
    expect(ashby).toMatchObject({
      jobs: 2,
      inIt: 1,
      relevant: 1,
      apto: 1,
      inapto: 1,
      automatable: 1,
    });
    // O único e-mail da segunda fonte é de acessibilidade: não conta como canal de candidatura.
    expect(banco).toMatchObject({ jobs: 1, relevant: 1, automatable: 0 });
  });

  it('o resumo de novas só inclui o que foi visto pela primeira vez depois do início da execução', async () => {
    const antiga = seedJob(db, {
      verdict: null,
      title: 'Estágio em Suporte',
      workMode: 'remoto',
      location: 'Brasil',
      stipend: 1800,
    });
    db.prepare("UPDATE jobs SET first_seen_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(antiga);
    seedJob(db, {
      verdict: null,
      title: 'Estágio em Dados',
      workMode: 'remoto',
      location: 'Brasil',
      stipend: 1800,
    });
    db.prepare("UPDATE jobs SET first_seen_at = '2026-10-24T12:30:00Z' WHERE id <> ?").run(antiga);
    await analyze();
    const fresh = freshSummary(db, profile(), NOW);
    expect(fresh).toMatchObject({ total: 1, inIt: 1, apto: 1, descartada: 0 });
    const old = sourceMetrics(db, profile(), 7, NOW).find((r) => r.source === 'ashby:fantasia');
    expect(old).toMatchObject({ jobs: 2, newInWindow: 1 });
  });
});
