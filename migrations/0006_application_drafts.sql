-- Etapa 3.3: preparação de candidaturas (rascunho da mensagem e pendências). Migração aditiva.
-- Nada aqui envia algo: guarda o que SERIA enviado, de onde cada afirmação veio e o que falta.

CREATE TABLE application_drafts (
  application_id    INTEGER PRIMARY KEY REFERENCES applications (id),
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  language          TEXT NOT NULL DEFAULT 'pt-BR',
  -- Lista JSON de {claim, source}: cada afirmação da mensagem e o campo do perfil/vaga de origem.
  facts             TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  -- Entradas usadas: se qualquer uma mudar, o rascunho fica "desatualizado".
  profile_hash      TEXT NOT NULL,
  job_content_hash  TEXT NOT NULL,
  cv_sha256         TEXT NOT NULL CHECK (length(cv_sha256) = 64),
  content_hash      TEXT NOT NULL,
  generated_at      TEXT NOT NULL,
  -- Preenchidos quando uma pessoa revisa exatamente este conteúdo (content_hash).
  reviewed_hash     TEXT,
  reviewed_at       TEXT
);

-- Informações obrigatórias ausentes, perguntas de formulário e pendências de elegibilidade.
-- Resposta só vem do perfil aprovado ou de uma pessoa; nunca é inventada.
CREATE TABLE application_requirements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications (id),
  key            TEXT NOT NULL,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('dado_ausente', 'pergunta', 'canal', 'elegibilidade', 'informativo')),
  blocking       INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0, 1)),
  answer         TEXT,
  answered_by    TEXT CHECK (answered_by IS NULL OR answered_by IN ('perfil', 'usuario')),
  answered_at    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (application_id, key),
  CHECK ((answer IS NULL) = (answered_by IS NULL))
);

CREATE INDEX idx_application_requirements_app ON application_requirements (application_id);
