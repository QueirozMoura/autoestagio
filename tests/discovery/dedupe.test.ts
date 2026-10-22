import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  DESCRIPTION_MIN_TOKENS,
  descriptionSimilarity,
  judge,
  titleSimilarity,
  type DedupeCandidate,
  type DedupeIncoming,
} from '../../src/discovery/dedupe.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { normalizeJob } from '../../src/discovery/normalize.js';
import { JobStore } from '../../src/discovery/store.js';
import type { RawJob } from '../../src/sources/index.js';

// Textos longos o bastante (≥ 30 palavras) para valerem como prova de descrição.
const DESC_PLATAFORMA =
  'Equipe de plataforma procura estagiário para desenvolver APIs em Node.js e TypeScript, escrever testes automatizados, participar de revisões de código, aprender arquitetura de serviços, observabilidade, integração contínua, entrega contínua, boas práticas de versionamento e documentação técnica junto de pessoas mais experientes do time.';
const DESC_DADOS =
  'Área de dados busca estagiário para construir pipelines de ingestão em Python orquestrados com Airflow, apoiar modelagem dimensional do warehouse, escrever consultas analíticas, cuidar da qualidade das tabelas e produzir relatórios mensais para diretoria acompanhando cientistas e analistas.';

const raw = (overrides: Partial<RawJob> = {}): RawJob => ({
  url: 'https://vagas.alfa.test/jobs/1',
  title: 'Estagiário(a) de Desenvolvimento Backend',
  company: 'Alfa Tecnologia Ltda.',
  location: 'São Paulo, SP',
  ...overrides,
});

describe('similaridade', () => {
  it('títulos: idênticos = 1, diferentes baixo', () => {
    expect(titleSimilarity('estagiario backend', 'estagiario backend')).toBe(1);
    expect(titleSimilarity('estagiario backend java', 'estagiario frontend react')).toBeLessThan(
      0.5,
    );
  });

  it('descrições curtas nunca servem de prova', () => {
    expect(descriptionSimilarity('texto curto', 'texto curto')).toBe(0);
    expect(descriptionSimilarity(null, DESC_PLATAFORMA)).toBe(0);
    expect(DESC_PLATAFORMA.split(' ').length).toBeGreaterThan(DESCRIPTION_MIN_TOKENS);
    expect(descriptionSimilarity(DESC_PLATAFORMA, DESC_PLATAFORMA)).toBe(1);
    expect(descriptionSimilarity(DESC_PLATAFORMA, DESC_DADOS)).toBeLessThan(0.3);
  });
});

describe('judge (função pura)', () => {
  const incoming: DedupeIncoming = {
    sourceId: 2,
    externalId: 'B-1',
    canonicalUrl: 'https://v.test/jobs/1',
    titleKey: 'estagiario backend',
    identityKey: 'id-1',
    description: DESC_PLATAFORMA,
  };
  const candidate: DedupeCandidate = {
    jobId: 10,
    canonicalUrls: ['https://v.test/jobs/1'],
    titleKey: 'estagiario backend',
    identityKey: 'id-1',
    description: DESC_PLATAFORMA,
    sightings: [{ sourceId: 1, externalId: 'A-1' }],
  };

  it('URL igual e título igual → duplicada', () => {
    expect(judge(incoming, candidate)).toMatchObject({
      kind: 'duplicate',
      reason: 'canonical_url',
    });
  });

  it('URL igual com título diferente (página genérica) → só possível, nunca duplicada', () => {
    expect(judge(incoming, { ...candidate, titleKey: 'estagiario de marketing' })).toMatchObject({
      kind: 'possible',
      reason: 'canonical_url_title_differs',
    });
  });

  it('identidade igual sem URL igual exige descrição praticamente idêntica', () => {
    const otherUrl = { ...candidate, canonicalUrls: ['https://outro.test/9'] };
    expect(judge(incoming, otherUrl)).toMatchObject({
      kind: 'duplicate',
      reason: 'identity_and_description',
    });
    expect(judge(incoming, { ...otherUrl, description: DESC_DADOS })).toMatchObject({
      kind: 'possible',
      reason: 'identity_only',
    });
    expect(judge(incoming, { ...otherUrl, description: null })).toMatchObject({
      kind: 'possible',
      reason: 'identity_only',
    });
    expect(judge({ ...incoming, description: null }, otherUrl)).toMatchObject({
      kind: 'possible',
      reason: 'identity_only',
    });
  });

  it('mesma fonte com ids externos diferentes → sempre vagas distintas', () => {
    const sameSource = { ...candidate, sightings: [{ sourceId: 2, externalId: 'B-0' }] };
    expect(judge(incoming, sameSource)).toEqual({ kind: 'distinct' });
  });

  it('nada em comum → distinta', () => {
    expect(
      judge(incoming, { ...candidate, canonicalUrls: ['https://x.test/'], identityKey: 'outra' }),
    ).toEqual({ kind: 'distinct' });
  });
});

describe('ingestJob — deduplicação', () => {
  let db: Db;
  let store: JobStore;
  let sourceA: number;
  let sourceB: number;
  let sourceC: number;

  const ingest = (source: number, overrides: Partial<RawJob>, now = '2026-10-20T10:00:00.000Z') =>
    ingestJob(store, source, normalizeJob(raw(overrides)), now);
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    store = new JobStore(db);
    sourceA = store.upsertSource('greenhouse', 'alfa', 'Alfa');
    sourceB = store.upsertSource('lever', 'agregador', 'Agregador');
    sourceC = store.upsertSource('lever', 'portal', 'Portal');
  });

  describe('identificador externo', () => {
    it('mesmo id na mesma fonte → mesma vaga, sem duplicar', () => {
      const first = ingest(sourceA, { externalId: 'A-1' });
      const second = ingest(sourceA, { externalId: 'A-1' }, '2026-10-21T10:00:00.000Z');
      expect(first.action).toBe('new');
      expect(second).toMatchObject({
        action: 'unchanged',
        jobId: first.jobId,
        matchedBy: 'source_external_id',
      });
      expect(count('jobs')).toBe(1);
      expect(count('job_sightings')).toBe(1);
    });

    it('ids diferentes na mesma fonte → vagas diferentes, mesmo com título, local e URL parecidos', () => {
      ingest(sourceA, { externalId: 'A-1', url: 'https://vagas.alfa.test/jobs/1' });
      const second = ingest(sourceA, { externalId: 'A-2', url: 'https://vagas.alfa.test/jobs/1' });
      expect(second.action).toBe('new');
      expect(count('jobs')).toBe(2);
    });

    it('o mesmo id em fontes diferentes não é a mesma vaga', () => {
      ingest(sourceA, { externalId: '123', url: 'https://a.test/1', title: 'Estágio em QA' });
      const other = ingest(sourceB, {
        externalId: '123',
        url: 'https://b.test/9',
        title: 'Estágio em Dados',
        company: 'Outra Empresa',
      });
      expect(other.action).toBe('new');
      expect(count('jobs')).toBe(2);
    });
  });

  describe('URL canônica', () => {
    it('parâmetros de rastreamento não criam vaga nova', () => {
      const first = ingest(sourceA, {
        externalId: 'A-1',
        url: 'https://vagas.alfa.test/jobs/1?utm_source=x',
      });
      const second = ingest(sourceB, {
        externalId: 'G-1',
        url: 'https://www.vagas.alfa.test/jobs/1/?utm_campaign=y&fbclid=z#aplicar',
        title: 'Estagiário de Desenvolvimento Backend',
      });
      expect(second).toMatchObject({
        action: 'merged',
        jobId: first.jobId,
        matchedBy: 'canonical_url',
      });
      expect(count('jobs')).toBe(1);
      expect(count('job_sightings')).toBe(2);
    });

    it('sem id externo, a mesma URL da mesma fonte é reconhecida', () => {
      const first = ingest(sourceA, { url: 'https://vagas.alfa.test/jobs/1?utm_source=a' });
      const second = ingest(sourceA, { url: 'https://vagas.alfa.test/jobs/1?utm_source=b' });
      expect(second).toMatchObject({ action: 'unchanged', jobId: first.jobId });
      expect(count('jobs')).toBe(1);
      expect(count('job_sightings')).toBe(1);
    });

    it('URL genérica compartilhada por vagas de títulos diferentes não as une', () => {
      const generic = 'https://carreiras.beta.test/vagas';
      ingest(sourceA, { externalId: '1', url: generic, title: 'Estágio em Marketing Digital' });
      const second = ingest(sourceB, {
        externalId: '2',
        url: generic,
        title: 'Estagiário de Engenharia de Dados',
      });
      expect(second.action).toBe('new');
      expect(second.possibleDuplicates).toBe(1);
      expect(count('jobs')).toBe(2);
    });

    it('URLs com ids diferentes são vagas diferentes', () => {
      ingest(sourceA, { externalId: '1', url: 'https://v.test/vaga?id=1' });
      expect(ingest(sourceB, { externalId: '2', url: 'https://v.test/vaga?id=2' }).action).toBe(
        'new',
      );
    });
  });

  describe('identidade normalizada (empresa + título + local)', () => {
    it('com descrição praticamente idêntica → mesma vaga em outra fonte', () => {
      const first = ingest(sourceA, {
        externalId: 'A-1',
        description: `<p>${DESC_PLATAFORMA}</p>`,
      });
      const second = ingest(sourceC, {
        externalId: 'P-1',
        url: 'https://portal.test/p/1',
        company: 'ALFA TECNOLOGIA',
        description: DESC_PLATAFORMA,
      });
      expect(second).toMatchObject({
        action: 'merged',
        jobId: first.jobId,
        matchedBy: 'identity_and_description',
      });
      expect(count('jobs')).toBe(1);
    });

    it('título + empresa + cidade iguais, mas descrições diferentes → vagas distintas (só sinalizadas)', () => {
      const first = ingest(sourceA, { externalId: 'A-1', description: DESC_PLATAFORMA });
      const second = ingest(sourceC, {
        externalId: 'P-1',
        url: 'https://portal.test/p/1',
        description: DESC_DADOS,
      });
      expect(second.action).toBe('new');
      expect(second.possibleDuplicates).toBe(1);
      expect(count('jobs')).toBe(2);
      expect(
        db.prepare('SELECT job_id, other_job_id, reason FROM job_possible_duplicates').all(),
      ).toEqual([{ job_id: first.jobId, other_job_id: second.jobId, reason: 'identity_only' }]);
    });

    it('sem nenhuma descrição, a identidade sozinha nunca unifica', () => {
      ingest(sourceA, { externalId: 'A-1' });
      const second = ingest(sourceC, { externalId: 'P-1', url: 'https://portal.test/p/1' });
      expect(second.action).toBe('new');
      expect(second.possibleDuplicates).toBe(1);
      expect(count('jobs')).toBe(2);
    });

    it('descrição curta demais não corrobora a identidade', () => {
      ingest(sourceA, { externalId: 'A-1', description: 'Vaga de backend.' });
      const second = ingest(sourceC, {
        externalId: 'P-1',
        url: 'https://portal.test/p/1',
        description: 'Vaga de backend.',
      });
      expect(second.action).toBe('new');
      expect(count('jobs')).toBe(2);
    });

    it('vagas distintas da mesma empresa com títulos parecidos não são unificadas', () => {
      ingest(sourceA, {
        externalId: 'A-1',
        title: 'Estagiário Backend Java',
        description: DESC_PLATAFORMA,
      });
      const second = ingest(sourceC, {
        externalId: 'P-1',
        url: 'https://portal.test/p/1',
        title: 'Estagiário Backend Python',
        description: DESC_PLATAFORMA,
      });
      expect(second.action).toBe('new');
      expect(second.possibleDuplicates).toBe(0);
      expect(count('jobs')).toBe(2);
    });

    it('mesma empresa e título em cidades diferentes → vagas diferentes', () => {
      ingest(sourceA, { externalId: 'A-1', description: DESC_PLATAFORMA });
      const second = ingest(sourceC, {
        externalId: 'P-1',
        url: 'https://portal.test/p/1',
        location: 'Campinas, SP',
        description: DESC_PLATAFORMA,
      });
      expect(second.action).toBe('new');
      expect(count('jobs')).toBe(2);
    });

    it('C# e C++ não são confundidos', () => {
      ingest(sourceA, {
        externalId: 'A-1',
        title: 'Estagiário Desenvolvedor C#',
        description: DESC_PLATAFORMA,
      });
      const second = ingest(sourceC, {
        externalId: 'P-1',
        url: 'https://portal.test/p/1',
        title: 'Estagiário Desenvolvedor C++',
        description: DESC_PLATAFORMA,
      });
      expect(second.action).toBe('new');
      expect(count('jobs')).toBe(2);
    });
  });

  describe('first_seen_at / last_seen_at', () => {
    const times = () =>
      db.prepare('SELECT first_seen_at, last_seen_at, updated_at FROM jobs').get() as {
        first_seen_at: string;
        last_seen_at: string;
        updated_at: string;
      };

    it('first_seen_at fica fixo e last_seen_at avança a cada aparição', () => {
      ingest(sourceA, { externalId: 'A-1' }, '2026-10-20T10:00:00.000Z');
      ingest(sourceA, { externalId: 'A-1' }, '2026-10-21T10:00:00.000Z');
      ingest(sourceA, { externalId: 'A-1' }, '2026-10-22T10:00:00.000Z');
      expect(times()).toEqual({
        first_seen_at: '2026-10-20T10:00:00.000Z',
        last_seen_at: '2026-10-22T10:00:00.000Z',
        updated_at: '2026-10-20T10:00:00.000Z',
      });
    });

    it('aparição em outra fonte também renova last_seen_at', () => {
      ingest(sourceA, { externalId: 'A-1', url: 'https://v.test/1' }, '2026-10-20T10:00:00.000Z');
      ingest(
        sourceB,
        { externalId: 'G-1', url: 'https://v.test/1?utm_x=1' },
        '2026-10-23T10:00:00.000Z',
      );
      expect(times().first_seen_at).toBe('2026-10-20T10:00:00.000Z');
      expect(times().last_seen_at).toBe('2026-10-23T10:00:00.000Z');
    });
  });

  describe('alterações feitas pela fonte', () => {
    it('a fonte dona atualiza o conteúdo; first_seen_at e status são preservados', () => {
      const first = ingest(
        sourceA,
        { externalId: 'A-1', compensationText: 'A combinar' },
        '2026-10-20T10:00:00.000Z',
      );
      db.prepare("UPDATE jobs SET status = 'interessante' WHERE id = ?").run(first.jobId);

      const second = ingest(
        sourceA,
        { externalId: 'A-1', compensationText: 'R$ 1.500', title: 'Estagiário Backend Sênior' },
        '2026-10-21T10:00:00.000Z',
      );
      expect(second).toMatchObject({ action: 'updated', jobId: first.jobId });
      expect(
        db
          .prepare('SELECT title, stipend_amount, status, first_seen_at, updated_at FROM jobs')
          .get(),
      ).toEqual({
        title: 'Estagiário Backend Sênior',
        stipend_amount: 1500,
        status: 'interessante',
        first_seen_at: '2026-10-20T10:00:00.000Z',
        updated_at: '2026-10-21T10:00:00.000Z',
      });
    });

    it('outra fonte não sobrescreve o conteúdo da fonte dona, nem ao reaparecer', () => {
      ingest(sourceA, { externalId: 'A-1', url: 'https://v.test/1', description: DESC_PLATAFORMA });
      const variant = {
        externalId: 'G-1',
        url: 'https://v.test/1?utm_x=1',
        title: 'Estagiário de Desenvolvimento Backend',
        description: 'Texto resumido do agregador.',
      };
      expect(ingest(sourceB, variant).action).toBe('merged');
      expect(ingest(sourceB, variant).action).toBe('unchanged'); // reaparição

      expect(db.prepare('SELECT description FROM jobs').get()).toEqual({
        description: DESC_PLATAFORMA,
      });
    });

    it('outra fonte só preenche o que faltava', () => {
      ingest(sourceA, { externalId: 'A-1', url: 'https://v.test/1', company: 'Alfa Tecnologia' });
      ingest(sourceB, {
        externalId: 'G-1',
        url: 'https://v.test/1',
        title: 'Estagiário de Desenvolvimento Backend',
        company: 'Nome Diferente',
        compensationText: 'R$ 1.700',
        postedAt: '2026-10-10T00:00:00Z',
      });
      expect(db.prepare('SELECT company, stipend_amount, posted_at FROM jobs').get()).toEqual({
        company: 'Alfa Tecnologia',
        stipend_amount: 1700,
        posted_at: '2026-10-10T00:00:00.000Z',
      });
    });
  });
});
