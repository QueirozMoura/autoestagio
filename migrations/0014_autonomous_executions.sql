-- Execuções assistidas da fila. Migração ADITIVA: só cria uma tabela.
--
-- Cada linha registra UMA tentativa de preparar uma candidatura no navegador: as etapas realizadas, os campos
-- preenchidos (com a origem de cada valor e SEM dados pessoais completos), o que ficou para você e o resultado. O
-- executor nunca envia o formulário: "concluida" na fila só existe com evidência da plataforma.

CREATE TABLE autonomous_executions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id      INTEGER NOT NULL REFERENCES autonomous_queue (id),
  mode          TEXT NOT NULL CHECK (mode IN ('planejar', 'preparar')),
  outcome       TEXT NOT NULL CHECK (outcome IN (
                  'pronto_para_revisao', 'campos_desconhecidos', 'login', 'captcha', 'avaliacao',
                  'encerrada', 'sem_formulario', 'erro', 'concluida_com_evidencia'
                )),
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  -- JSON: etapas com estado (ok, pulado, bloqueado, falhou) e detalhe curto.
  steps         TEXT NOT NULL,
  -- JSON: campos preenchidos (rótulo, origem, valor mascarado) e pendências.
  fields        TEXT NOT NULL,
  cv_label      TEXT,
  cv_sha256     TEXT CHECK (cv_sha256 IS NULL OR length(cv_sha256) = 64),
  -- Caminho local da captura de tela (pode conter seus dados): fica em data/, fora do Git.
  screenshot    TEXT,
  evidence      TEXT
);

CREATE INDEX idx_autonomous_executions_queue ON autonomous_executions (queue_id, id);
