-- Autorização permanente do modo autônomo ("concessão"). Migração ADITIVA: só cria uma tabela.
--
-- Uma concessão é uma decisão SUA, registrada no banco (não só em arquivo editável): valida por prazo, amarrada a um
-- hash da política vigente, com os limites e conectores permitidos congelados no momento da criação. Mudar a política
-- invalida a concessão (é preciso autorizar de novo). Pode ser revogada a qualquer momento. Ter uma concessão NÃO
-- liga o envio real: continuam valendo a política (enabled/real.authorized) e todas as travas do canal de e-mail.

CREATE TABLE autonomous_grants (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at           TEXT NOT NULL,
  valid_until          TEXT NOT NULL,
  policy_hash          TEXT NOT NULL,
  -- JSON: conectores permitidos (ex.: ["email"]).
  connectors           TEXT NOT NULL,
  max_per_day          INTEGER NOT NULL CHECK (max_per_day BETWEEN 0 AND 100),
  max_per_run          INTEGER NOT NULL CHECK (max_per_run BETWEEN 0 AND 100),
  min_interval_seconds INTEGER NOT NULL CHECK (min_interval_seconds >= 0),
  salary_expectation   REAL NOT NULL,
  min_stipend          REAL NOT NULL,
  reason               TEXT NOT NULL CHECK (length(reason) > 0),
  revoked_at           TEXT,
  revoked_reason       TEXT,
  CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL)
);

CREATE INDEX idx_autonomous_grants_valid ON autonomous_grants (valid_until);
