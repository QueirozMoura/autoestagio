import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  SimulationError,
  createSimulatedSources,
  runScan,
  runSimulation,
} from '../../src/discovery/index.js';
import { HttpClient } from '../../src/http/index.js';
import {
  createSourceContext,
  parseSourcesConfig,
  type JobSource,
  type RawJob,
} from '../../src/sources/index.js';

const offline = new HttpClient({
  fetch: () => Promise.reject(new Error('rede não deve ser usada')),
  maxRetries: 0,
});

function context(limits: { maxJobsPerSource?: number } = {}) {
  return createSourceContext(parseSourcesConfig({ limits }), { http: offline });
}

function fakeSource(slug: string, jobs: readonly unknown[], failAfter?: Error): JobSource {
  return {
    kind: 'simulado',
    slug,
    name: slug,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *fetchJobs() {
      yield* jobs as RawJob[];
      if (failAfter) throw failAfter;
    },
  };
}

const job = (n: number, overrides: Partial<RawJob> = {}): RawJob => ({
  externalId: `J-${n}`,
  url: `https://vagas.test/jobs/${n}`,
  title: `Estágio ${n}`,
  company: `Empresa ${n}`,
  ...overrides,
});

describe('scan simulado', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  it('percorre as fontes fictícias e relata o que aconteceu', async () => {
    const report = await runScan({
      db,
      sources: createSimulatedSources(),
      context: context(),
      simulated: true,
    });

    expect(report.simulated).toBe(true);
    expect(report.totals).toEqual({
      found: 10,
      new: 6,
      updated: 0,
      duplicates: 2, // G-9001 (URL) e P-77 (identidade + descrição)
      possibleDuplicates: 2, // Q-5 contra A-101 e A-102
      invalid: 2, // sem URL e URL não HTTP
      failed: 0,
    });
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(6);
    expect(count('SELECT COUNT(*) AS n FROM job_sightings')).toBe(8);
    expect(count('SELECT COUNT(*) AS n FROM job_possible_duplicates')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM scan_runs WHERE simulated = 1')).toBe(5);
  });

  it('as vagas persistidas têm os campos normalizados', async () => {
    await runScan({ db, sources: createSimulatedSources(), context: context() });

    const row = db
      .prepare(
        `SELECT canonical_url, title, company, location, work_mode, stipend_amount, stipend_text, posted_at
           FROM jobs WHERE external_id = 'A-101'`,
      )
      .get();
    expect(row).toEqual({
      canonical_url: 'https://vagas.alfa.test/jobs/101',
      title: 'Estagiário(a) de Desenvolvimento Backend',
      company: 'Empresa Alfa Tecnologia Ltda.',
      location: 'São Paulo, SP - Híbrido',
      work_mode: 'hibrido',
      stipend_amount: 1800,
      stipend_text: 'Bolsa de R$ 1.800,00 + VR',
      posted_at: '2026-10-15T13:00:00.000Z',
    });

    // Bolsa a combinar, faixa abaixo do mínimo do perfil e modalidade desconhecida ficam registradas
    // como são: a decisão de elegibilidade é de uma etapa futura.
    expect(
      db
        .prepare(
          "SELECT stipend_amount, stipend_text, work_mode FROM jobs WHERE external_id = 'B-2'",
        )
        .get(),
    ).toEqual({ stipend_amount: null, stipend_text: 'A combinar', work_mode: 'remoto' });
    expect(
      db
        .prepare(
          "SELECT stipend_amount, stipend_max, work_mode FROM jobs WHERE external_id = 'B-1'",
        )
        .get(),
    ).toEqual({ stipend_amount: 1100, stipend_max: 1400, work_mode: 'presencial' });
  });

  describe('execução repetida', () => {
    it('é idempotente: nada novo, nada atualizado, mesmas linhas', async () => {
      const clockTimes = ['2026-10-20T10:00:00.000Z', '2026-10-21T10:00:00.000Z'];
      let run = 0;
      const options = () => ({
        db,
        sources: createSimulatedSources(),
        context: context(),
        simulated: true,
        now: () => new Date(clockTimes[run] ?? clockTimes[0] ?? ''),
      });

      await runScan(options());
      const snapshot = db
        .prepare('SELECT id, canonical_url, first_seen_at FROM jobs ORDER BY id')
        .all();
      run = 1;
      const second = await runScan(options());

      expect(second.totals).toMatchObject({
        new: 0,
        updated: 0,
        duplicates: 8,
        possibleDuplicates: 0,
        invalid: 2,
      });
      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(6);
      expect(count('SELECT COUNT(*) AS n FROM job_sightings')).toBe(8);
      expect(count('SELECT COUNT(*) AS n FROM job_possible_duplicates')).toBe(2);
      expect(count('SELECT COUNT(*) AS n FROM scan_runs')).toBe(10);

      // As mesmas vagas, com os mesmos ids e first_seen_at; last_seen_at avançou.
      expect(
        db.prepare('SELECT id, canonical_url, first_seen_at FROM jobs ORDER BY id').all(),
      ).toEqual(snapshot);
      expect(
        count("SELECT COUNT(*) AS n FROM jobs WHERE last_seen_at = '2026-10-21T10:00:00.000Z'"),
      ).toBe(6);
      expect(
        count("SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at = '2026-10-20T10:00:00.000Z'"),
      ).toBe(6);
    });

    it('muitas repetições seguidas não acumulam nada', async () => {
      for (let i = 0; i < 5; i++) {
        await runScan({ db, sources: createSimulatedSources(), context: context() });
      }
      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(6);
      expect(count('SELECT COUNT(*) AS n FROM job_sightings')).toBe(8);
    });

    it('limitação conhecida: a ordem pode deixar uma duplicata sem unir, mas ela fica sinalizada', async () => {
      // Com a ordem invertida, A-101 chega depois de G-9001 e P-77, que ainda estavam separadas:
      // ela se une a G-9001 (URL) e liga P-77 (identidade + descrição). Unir linhas já existentes
      // poderia quebrar análises e candidaturas, então P-77 só é sinalizada.
      await runScan({ db, sources: createSimulatedSources().reverse(), context: context() });

      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(7);
      // O par G-9001/P-77 já estava sinalizado como "identidade apenas"; a ligação feita por A-101
      // é uma evidência mais forte e prevalece.
      expect(
        db
          .prepare(
            `SELECT a.external_id AS a, b.external_id AS b, d.reason, d.score
               FROM job_possible_duplicates d
               JOIN jobs a ON a.id = d.job_id JOIN jobs b ON b.id = d.other_job_id
              WHERE d.reason = 'linked_by_same_listing'`,
          )
          .all(),
      ).toEqual([{ a: 'P-77', b: 'G-9001', reason: 'linked_by_same_listing', score: 1 }]);
    });
  });

  it('respeita o limite de vagas por fonte', async () => {
    const report = await runScan({
      db,
      sources: [fakeSource('limitada', [job(1), job(2), job(3), job(4)])],
      context: context({ maxJobsPerSource: 2 }),
    });
    expect(report.totals).toMatchObject({ found: 2, new: 2 });
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(2);
  });

  describe('falhas', () => {
    it('falha de uma fonte não derruba as outras e fica registrada', async () => {
      const report = await runScan({
        db,
        sources: [
          fakeSource('quebrada', [job(1)], new Error('API fora do ar')),
          fakeSource('saudavel', [job(2), job(3)]),
        ],
        context: context(),
      });

      const [broken, healthy] = report.sources;
      expect(broken).toMatchObject({ new: 1, errorCategory: 'unavailable' });
      expect(broken?.error).toContain('API fora do ar');
      expect(healthy).toMatchObject({ new: 2, error: null });
      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(3);
      expect(db.prepare('SELECT error FROM scan_runs WHERE error IS NOT NULL').all()).toHaveLength(
        1,
      );
    });

    it('falha ao gravar uma vaga desfaz tudo dela e a coleta continua', async () => {
      // Falha simulada no meio da gravação: depois de inserir em `jobs`, ao registrar a aparição.
      db.exec(`
        CREATE TRIGGER falha_simulada BEFORE INSERT ON job_sightings
        WHEN NEW.url LIKE '%falha%'
        BEGIN SELECT RAISE(ABORT, 'disco cheio (simulado)'); END;
      `);

      const report = await runScan({
        db,
        sources: [
          fakeSource('mista', [job(1), job(2, { url: 'https://vagas.test/falha/2' }), job(3)]),
        ],
        context: context(),
      });

      expect(report.totals).toMatchObject({ found: 3, new: 2, failed: 1 });
      expect(report.sources[0]?.failures[0]).toContain('disco cheio (simulado)');
      // Nenhuma linha órfã da vaga que falhou, em nenhuma tabela.
      expect(count("SELECT COUNT(*) AS n FROM jobs WHERE url LIKE '%falha%'")).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(2);
      expect(count('SELECT COUNT(*) AS n FROM job_sightings')).toBe(2);
      expect(db.prepare('SELECT jobs_new, jobs_failed, error FROM scan_runs').get()).toEqual({
        jobs_new: 2,
        jobs_failed: 1,
        error: 'disco cheio (simulado)',
      });
    });

    it('a vaga que falhou é gravada normalmente quando o problema passa', async () => {
      db.exec(`
        CREATE TRIGGER falha_simulada BEFORE INSERT ON job_sightings
        BEGIN SELECT RAISE(ABORT, 'banco travado (simulado)'); END;
      `);
      const sources = () => [fakeSource('s', [job(1)])];
      expect((await runScan({ db, sources: sources(), context: context() })).totals.failed).toBe(1);

      db.exec('DROP TRIGGER falha_simulada');
      const retry = await runScan({ db, sources: sources(), context: context() });
      expect(retry.totals).toMatchObject({ new: 1, failed: 0 });
      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(1);
    });

    it('interrompe a fonte após falhas seguidas de persistência', async () => {
      db.exec(`
        CREATE TRIGGER falha_simulada BEFORE INSERT ON jobs
        BEGIN SELECT RAISE(ABORT, 'banco indisponível (simulado)'); END;
      `);
      const jobs = Array.from({ length: 20 }, (_, i) => job(i + 1));
      const report = await runScan({
        db,
        sources: [fakeSource('s', jobs)],
        context: context(),
        maxConsecutiveFailures: 3,
      });

      expect(report.totals).toMatchObject({ found: 3, failed: 3, new: 0 });
      expect(report.sources[0]?.error).toContain('3 falhas seguidas');
    });

    it('vagas inválidas são contadas e não derrubam a fonte', async () => {
      const report = await runScan({
        db,
        sources: [
          fakeSource('s', [
            job(1),
            { externalId: 'x', title: 'sem url' },
            job(2, { url: 'ftp://vagas.test/2' }),
            job(3, { title: ' ' }),
            job(4),
          ]),
        ],
        context: context(),
      });
      expect(report.totals).toMatchObject({ found: 5, new: 2, invalid: 3, failed: 0 });
      expect(report.sources[0]?.error).toBeNull();
    });
  });

  it('cancelar interrompe a coleta', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelado'));
    const report = await runScan({
      db,
      sources: [fakeSource('s', [job(1)])],
      context: { ...context(), signal: controller.signal },
    });
    expect(report.sources[0]?.error).toContain('cancelado');
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(0);
  });
});

describe('runSimulation', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
    tempDirs.push(dir);
    return join(dir, 'sim.db');
  };

  it('por padrão roda em memória e repete a execução', async () => {
    const reports = await runSimulation({ repeat: 2 });
    expect(reports).toHaveLength(2);
    expect(reports[0]?.totals.new).toBe(6);
    expect(reports[1]?.totals).toMatchObject({ new: 0, updated: 0 });
  });

  it('pode gravar em arquivo próprio, e repetir a simulação nele continua idempotente', async () => {
    const file = tempFile();
    await runSimulation({ dbFile: file });
    const again = await runSimulation({ dbFile: file });
    expect(again[0]?.totals).toMatchObject({ new: 0, updated: 0 });

    const db = openDatabase(file, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(6);
    db.close();
  });

  it('recusa gravar no banco real do sistema', async () => {
    const real = tempFile();
    await expect(runSimulation({ dbFile: real, protectedDbPath: real })).rejects.toBeInstanceOf(
      SimulationError,
    );
  });

  it('valida --repeat', async () => {
    await expect(runSimulation({ repeat: 0 })).rejects.toBeInstanceOf(SimulationError);
    await expect(runSimulation({ repeat: 11 })).rejects.toBeInstanceOf(SimulationError);
    await expect(runSimulation({ repeat: 1.5 })).rejects.toBeInstanceOf(SimulationError);
  });
});
