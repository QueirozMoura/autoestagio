-- Persistência de vagas (Etapa 2.2). Migração incremental: a 0001 permanece intacta.
--
-- Reconstrói `sources` e `jobs` (procedimento de 12 passos do SQLite). O executor de migrações
-- desliga as foreign keys durante a migração e confere `foreign_key_check` antes de confirmar.
--
-- Por que reconstruir:
--  * `sources.kind` tinha um CHECK com tipos fixos; os tipos agora são definidos pela aplicação
--    (greenhouse, lever, ...) e ganham um `slug` único por tipo.
--  * `jobs.content_hash` era UNIQUE, o que forçaria a união de vagas distintas com o mesmo
--    conteúdo. Duplicidade passa a ser decidida pela aplicação, com regras que evitam falsos
--    positivos, e o hash serve só para detectar vagas alteradas.

CREATE TABLE sources_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (length(kind) > 0),
  slug       TEXT NOT NULL CHECK (length(slug) > 0),
  name       TEXT NOT NULL,
  base_url   TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, slug)
);

INSERT INTO sources_new (id, kind, slug, name, base_url, enabled, created_at)
SELECT id, kind, name, name, base_url, enabled, created_at FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        INTEGER NOT NULL REFERENCES sources (id),
  external_id      TEXT,
  url              TEXT NOT NULL,
  canonical_url    TEXT NOT NULL,
  title            TEXT NOT NULL,
  company          TEXT,
  location         TEXT,
  work_mode        TEXT CHECK (work_mode IN ('remoto', 'hibrido', 'presencial')),
  stipend_amount   REAL,
  stipend_max      REAL,
  stipend_currency TEXT,
  stipend_text     TEXT,
  description      TEXT,
  posted_at        TEXT,
  content_hash     TEXT NOT NULL,
  identity_key     TEXT,
  status           TEXT NOT NULL DEFAULT 'descoberta',
  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO jobs_new (
  id, source_id, external_id, url, canonical_url, title, company, location, work_mode,
  stipend_amount, stipend_currency, description, content_hash, status,
  first_seen_at, last_seen_at, updated_at
)
SELECT
  id, source_id, external_id, url, url, title, company, location, work_mode,
  stipend_amount, stipend_currency, description, content_hash, status,
  first_seen_at, last_seen_at, last_seen_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE UNIQUE INDEX idx_jobs_source_external
  ON jobs (source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_canonical_url ON jobs (canonical_url);
CREATE INDEX idx_jobs_identity_key ON jobs (identity_key) WHERE identity_key IS NOT NULL;

-- Cada vez que uma fonte lista uma vaga: permite que a mesma vaga venha de várias fontes.
CREATE TABLE job_sightings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES sources (id),
  external_id   TEXT,
  url           TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

INSERT INTO job_sightings (job_id, source_id, external_id, url, canonical_url, first_seen_at, last_seen_at)
SELECT id, source_id, external_id, url, canonical_url, first_seen_at, last_seen_at FROM jobs;

CREATE UNIQUE INDEX idx_sightings_source_external
  ON job_sightings (source_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_sightings_job_source_url
  ON job_sightings (job_id, source_id, canonical_url);
CREATE INDEX idx_sightings_canonical_url ON job_sightings (canonical_url);

-- Pares que parecem a mesma vaga, mas sem prova suficiente para unificar. Servem para revisão.
CREATE TABLE job_possible_duplicates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  other_job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  score        REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  CHECK (job_id <> other_job_id),
  UNIQUE (job_id, other_job_id)
);

-- Contadores por execução de coleta.
ALTER TABLE scan_runs ADD COLUMN jobs_updated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN jobs_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN jobs_possible_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN jobs_invalid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN jobs_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0, 1));
