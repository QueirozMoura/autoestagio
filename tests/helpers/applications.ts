import type { Db } from '../../src/db/index.js';

export const CV = { sha256: 'c'.repeat(64), label: 'Curriculo_Ficticio.pdf' };
/** Currículo que bate com o `approval` do perfil fictício de tests/helpers/eligibility.ts. */
export const PREP_CV = { sha256: 'a'.repeat(64), label: 'Curriculo_Ficticio.pdf' };
export const PROFILE_HASH = 'perfilhash0001';
export const T0 = new Date('2026-10-22T12:00:00.000Z');
export const minutesAfter = (m: number): Date => new Date(T0.getTime() + m * 60_000);

export interface SeedJob {
  title?: string;
  company?: string | null;
  url?: string;
  applyUrl?: string | null;
  identityKey?: string | null;
  externalId?: string | null;
  verdict?: 'apto' | 'inapto' | 'revisao_humana' | null;
  profileHash?: string;
  description?: string | null;
  workMode?: 'remoto' | 'hibrido' | 'presencial' | null;
  location?: string | null;
  stipend?: number | null;
}

let counter = 0;

/** Insere uma vaga FICTÍCIA (e sua análise de elegibilidade) direto no banco. */
export function seedJob(db: Db, overrides: SeedJob = {}): number {
  counter++;
  db.prepare(
    "INSERT OR IGNORE INTO sources (id, kind, slug, name) VALUES (1, 'ashby', 'fantasia', 'Fantasia')",
  ).run();
  const url = overrides.url ?? `https://jobs.exemplo.com/fantasia/${counter}`;
  const id = Number(
    db
      .prepare(
        `INSERT INTO jobs (source_id, external_id, url, canonical_url, apply_url, title, company,
                           content_hash, identity_key, description, work_mode, location,
                           stipend_amount, stipend_max, stipend_currency)
         VALUES (1, @externalId, @url, @url, @applyUrl, @title, @company, @hash, @identity,
                 @description, @workMode, @location, @stipend, @stipend, @currency)`,
      )
      .run({
        externalId: overrides.externalId === undefined ? `ext-${counter}` : overrides.externalId,
        url,
        applyUrl: overrides.applyUrl ?? null,
        title: overrides.title ?? `Estágio em Desenvolvimento ${counter}`,
        company: overrides.company === undefined ? `Empresa ${counter}` : overrides.company,
        hash: `hash-${counter}`,
        identity: overrides.identityKey ?? null,
        description: overrides.description ?? null,
        workMode: overrides.workMode ?? null,
        location: overrides.location ?? null,
        stipend: overrides.stipend ?? null,
        currency: overrides.stipend == null ? null : 'BRL',
      }).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO job_sightings (job_id, source_id, external_id, url, canonical_url, first_seen_at, last_seen_at)
     VALUES (?, 1, ?, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
  ).run(id, overrides.externalId === undefined ? `ext-${counter}` : overrides.externalId, url, url);
  const verdict = overrides.verdict === undefined ? 'apto' : overrides.verdict;
  if (verdict !== null) {
    db.prepare(
      `INSERT INTO job_eligibility (job_id, verdict, reasons, criteria, profile_hash, evaluated_at)
       VALUES (?, ?, '[]', '[]', ?, '2026-10-22T00:00:00Z')`,
    ).run(id, verdict, overrides.profileHash ?? PROFILE_HASH);
  }
  return id;
}
