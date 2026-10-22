import { beforeEach, describe, expect, it } from 'vitest';
import {
  IN_MEMORY,
  getMigrationStatus,
  openDatabase,
  runMigrations,
  type Db,
} from '../../src/db/index.js';
import { runRealScan } from '../../src/discovery/index.js';
import { analyzeJobs, profileHash } from '../../src/eligibility/index.js';
import { parseSourcesConfig } from '../../src/sources/index.js';
import { setup } from '../helpers/adapters.js';
import { NOW, profile } from '../helpers/eligibility.js';
import { jsonResponse } from '../helpers/mock-fetch.js';

const BOARD = 'https://api.ashbyhq.com/posting-api/job-board/fantasia?includeCompensation=true';
const config = parseSourcesConfig({
  targets: [{ kind: 'ashby', slug: 'fantasia', name: 'Fantasia Tech' }],
});

const posting = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  employmentType: 'Intern',
  location: 'São Paulo - Pinheiros',
  isListed: true,
  workplaceType: 'Hybrid',
  address: { postalAddress: { addressLocality: 'São Paulo', addressCountry: 'Brazil' } },
  publishedAt: '2026-10-01T09:00:00.000+00:00',
  jobUrl: `https://jobs.ashbyhq.com/fantasia/${id}`,
  applyUrl: `https://jobs.ashbyhq.com/fantasia/${id}/application`,
  descriptionHtml: '<p>Equipe de plataforma.</p>',
  compensation: { scrapeableCompensationSalarySummary: 'Bolsa de R$ 1.800,00' },
  ...extra,
});

// Dados fictícios (empresa, vagas e textos inventados para os testes).
const BOARD_BODY = {
  jobs: [
    posting('v-apto', 'Estagiário de Desenvolvimento', {
      workplaceType: 'Remote',
      location: 'Remote - Brazil',
    }),
    posting('v-mkt', 'Estagiário de Marketing'),
    posting('v-sem-bolsa', 'Estágio em QA', { compensation: {} }),
    posting('v-ingles', 'Estágio em Dados', {
      descriptionHtml: '<h3>Requisitos</h3><ul><li>Inglês avançado</li><li>SQL</li></ul>',
    }),
    posting('v-hibrido', 'Estágio em Suporte Técnico'),
    posting('v-bolsa-baixa', 'Estágio em Infraestrutura', {
      compensation: { scrapeableCompensationSalarySummary: 'R$ 900' },
    }),
  ],
};

describe('analyzeJobs — integração com SQLite', () => {
  let db: Db;
  beforeEach(async () => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    await runRealScan({
      db,
      config,
      http: setup({ [BOARD]: () => jsonResponse(BOARD_BODY) }).client,
    });
  });

  const verdictOf = (externalId: string): string | undefined =>
    (
      db
        .prepare(
          `SELECT e.verdict FROM job_eligibility e JOIN jobs j ON j.id = e.job_id
            WHERE j.external_id = ?`,
        )
        .get(externalId) as { verdict: string } | undefined
    )?.verdict;

  const rows = (sql: string): unknown[] => db.prepare(sql).all();

  it('classifica vagas do pipeline (Ashby → SQLite) e grava o resultado', () => {
    const report = analyzeJobs({ db, profile: profile(), now: NOW });
    expect(report.total).toBe(6);
    expect(report.counts).toEqual({ apto: 2, inapto: 3, revisao_humana: 1 });
    expect(report.saved).toBe(true);
    expect(rows('SELECT * FROM job_eligibility')).toHaveLength(6);
  });

  it('cada vaga recebe o veredito esperado, pelo motivo certo', () => {
    const report = analyzeJobs({ db, profile: profile(), now: NOW });
    expect(verdictOf('v-apto')).toBe('apto');
    expect(verdictOf('v-hibrido')).toBe('apto'); // Pinheiros: 45 min verificados no perfil
    expect(verdictOf('v-mkt')).toBe('inapto'); // fora de TI
    expect(verdictOf('v-ingles')).toBe('inapto'); // inglês avançado obrigatório × perfil intermediário
    expect(verdictOf('v-bolsa-baixa')).toBe('inapto'); // R$ 900 < R$ 1.200
    expect(verdictOf('v-sem-bolsa')).toBe('revisao_humana'); // sem bolsa: pendente, não descartada

    const noStipend = report.jobs.find((j) => j.title === 'Estágio em QA');
    expect(noStipend?.result.reasons).toEqual([expect.stringMatching(/não descartada/)]);
    const english = report.jobs.find((j) => j.title === 'Estágio em Dados');
    expect(english?.result.reasons.join(' ')).toMatch(/inglês avançado/);
  });

  it('é idempotente: repetir a análise não duplica nem muda nada', () => {
    analyzeJobs({ db, profile: profile(), now: NOW });
    const first = rows('SELECT * FROM job_eligibility ORDER BY job_id');
    analyzeJobs({ db, profile: profile(), now: NOW });
    expect(rows('SELECT * FROM job_eligibility ORDER BY job_id')).toEqual(first);
  });

  it('um perfil diferente regrava o resultado e muda o hash registrado', () => {
    analyzeJobs({ db, profile: profile(), now: NOW });
    const advanced = profile({ languages: [{ language: 'Inglês', level: 'avancado' }] });
    analyzeJobs({ db, profile: advanced, now: NOW });
    expect(verdictOf('v-ingles')).toBe('apto');
    expect(rows('SELECT DISTINCT profile_hash FROM job_eligibility')).toEqual([
      { profile_hash: profileHash(advanced) },
    ]);
    expect(profileHash(advanced)).not.toBe(profileHash(profile()));
  });

  it('não altera as vagas: nem o conteúdo, nem o status', () => {
    const before = rows('SELECT * FROM jobs ORDER BY id');
    analyzeJobs({ db, profile: profile(), now: NOW });
    expect(rows('SELECT * FROM jobs ORDER BY id')).toEqual(before);
  });

  it('save=false analisa sem gravar', () => {
    const report = analyzeJobs({ db, profile: profile(), now: NOW, save: false });
    expect(report.saved).toBe(false);
    expect(report.total).toBe(6);
    expect(rows('SELECT * FROM job_eligibility')).toEqual([]);
  });

  it('com o perfil não aprovado, nenhuma vaga é apta nem inapta', () => {
    const report = analyzeJobs({ db, profile: profile({ approval: undefined }), now: NOW });
    expect(report.counts).toEqual({ apto: 0, inapto: 0, revisao_humana: 6 });
  });

  it('a migração 0004 está aplicada e a vaga removida leva a análise junto', () => {
    expect(getMigrationStatus(db).pending).toEqual([]);
    analyzeJobs({ db, profile: profile(), now: NOW });
    db.prepare('DELETE FROM job_eligibility WHERE job_id = 1').run();
    expect(rows('SELECT * FROM job_eligibility')).toHaveLength(5);
  });
});
