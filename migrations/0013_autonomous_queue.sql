-- Fila de candidaturas do modo autônomo. Migração ADITIVA: só cria uma tabela.
--
-- Uma linha por vaga (UNIQUE(job_id)): o planejamento do que fazer com ela. Não é candidatura e não autoriza envio.
--   fluxo automatico  o agente pode concluir sozinho (hoje: e-mail de candidatura utilizável);
--   fluxo assistido   exige você (login, CAPTCHA, avaliação ou decisão): fica pronta para a execução assistida.
-- Concluir uma linha exige evidência (confirmação da plataforma ou e-mail); nada é marcado como enviado sem ela.

CREATE TABLE autonomous_queue (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL UNIQUE REFERENCES jobs (id),
  flow               TEXT NOT NULL CHECK (flow IN ('automatico', 'assistido')),
  status             TEXT NOT NULL DEFAULT 'pronta'
                       CHECK (status IN ('pronta', 'em_andamento', 'pendente_humano', 'concluida', 'cancelada')),
  -- 1 = primeira. Recalculada a cada construção para as linhas ainda "pronta".
  priority           INTEGER NOT NULL CHECK (priority >= 1),
  connector          TEXT,
  cv_variant         TEXT,
  -- Pretensão a usar nos formulários (valor da política).
  salary_expectation REAL,
  -- Link de candidatura (ou da vaga); sem parâmetros pessoais.
  apply_url          TEXT,
  -- JSON: barreiras conhecidas do canal (ex.: ["recaptcha"]) e avisos (ex.: modalidade desconhecida).
  barriers           TEXT NOT NULL DEFAULT '[]',
  notes              TEXT,
  -- Preenchidas ao concluir/cancelar.
  evidence           TEXT,
  closed_reason      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (status <> 'concluida' OR evidence IS NOT NULL),
  CHECK (status <> 'cancelada' OR closed_reason IS NOT NULL)
);

CREATE INDEX idx_autonomous_queue_status ON autonomous_queue (status, priority);
