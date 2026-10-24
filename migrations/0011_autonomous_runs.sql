-- Etapa autônoma: registro de execuções e decisões do modo autônomo. Migração ADITIVA: só cria tabelas novas.
--
-- Uma execução (`autonomous_runs`) agrupa as decisões (`autonomous_decisions`) tomadas sobre cada vaga. Nada aqui
-- autoriza envio: a decisão "candidatar" é só o resultado da política; o envio real depende de um conector e dos
-- mesmos portões já existentes (candidatura única por vaga, autorização, trava mestra). Nenhuma decisão guarda
-- e-mail, corpo de mensagem, credenciais ou caminhos de arquivo.

CREATE TABLE autonomous_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mode        TEXT NOT NULL CHECK (mode IN ('simulacao', 'real')),
  trigger     TEXT NOT NULL CHECK (trigger IN ('manual', 'timer')),
  status      TEXT NOT NULL CHECK (status IN ('executando', 'concluida', 'interrompida', 'falhou')),
  -- Hash da política vigente (não a política): permite saber se mudou entre execuções.
  policy_hash TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  -- Contadores e erros em JSON (sem dados pessoais).
  summary     TEXT
);

CREATE INDEX idx_autonomous_runs_started ON autonomous_runs (started_at);

CREATE TABLE autonomous_decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES autonomous_runs (id),
  job_id      INTEGER NOT NULL REFERENCES jobs (id),
  decision    TEXT NOT NULL CHECK (decision IN (
                'candidatar', 'pendente', 'pendente_canal', 'descartada',
                'ja_candidatada', 'limite_atingido', 'enviada', 'envio_incerto'
              )),
  reasons     TEXT NOT NULL,
  connector   TEXT,
  cv_variant  TEXT,
  -- Pretensão usada no formulário (valor da política), nunca a bolsa oferecida.
  salary_expectation REAL,
  -- Referência à evidência de envio (ex.: id da candidatura/confirmação), nunca o conteúdo.
  evidence    TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (run_id, job_id)
);

CREATE INDEX idx_autonomous_decisions_job ON autonomous_decisions (job_id);
CREATE INDEX idx_autonomous_decisions_created ON autonomous_decisions (created_at);
