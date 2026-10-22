-- Esquema inicial: apenas estrutura. Coleta e análise serão implementadas em fases futuras.

CREATE TABLE sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('gmail', 'gupy', 'career_page', 'other')),
  name       TEXT NOT NULL,
  base_url   TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name)
);

CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES sources (id),
  external_id     TEXT,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  company         TEXT,
  location        TEXT,
  work_mode       TEXT CHECK (work_mode IN ('remoto', 'hibrido', 'presencial')),
  stipend_amount  REAL,
  stipend_currency TEXT,
  description     TEXT,
  content_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'descoberta',
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (content_hash)
);

CREATE UNIQUE INDEX idx_jobs_source_external
  ON jobs (source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_jobs_status ON jobs (status);

CREATE TABLE job_analysis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  score            INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  matched_skills   TEXT NOT NULL DEFAULT '[]',
  missing_skills   TEXT NOT NULL DEFAULT '[]',
  needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  rationale        TEXT,
  analyzed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_job_analysis_job ON job_analysis (job_id);

CREATE TABLE applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL UNIQUE REFERENCES jobs (id),
  mode          TEXT NOT NULL CHECK (mode IN ('dry-run', 'manual', 'auto')),
  status        TEXT NOT NULL DEFAULT 'preparada',
  confirmation  TEXT,
  notes         TEXT,
  applied_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_applications_status ON applications (status);

CREATE TABLE application_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scan_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER REFERENCES sources (id),
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  jobs_found  INTEGER NOT NULL DEFAULT 0,
  jobs_new    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
