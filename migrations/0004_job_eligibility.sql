-- Etapa 3.1: resultado da análise de elegibilidade por vaga (apto, inapto ou revisão humana).
-- Uma linha por vaga, regravada a cada análise. `profile_hash` permite saber se o resultado foi
-- calculado com o perfil atual. Não guarda dados do perfil, só o hash.
CREATE TABLE job_eligibility (
  job_id                INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  verdict               TEXT NOT NULL CHECK (verdict IN ('apto', 'inapto', 'revisao_humana')),
  reasons               TEXT NOT NULL,
  criteria              TEXT NOT NULL,
  differentials_matched INTEGER NOT NULL DEFAULT 0,
  differentials_total   INTEGER NOT NULL DEFAULT 0,
  profile_hash          TEXT NOT NULL,
  evaluated_at          TEXT NOT NULL
);

CREATE INDEX idx_job_eligibility_verdict ON job_eligibility (verdict);
