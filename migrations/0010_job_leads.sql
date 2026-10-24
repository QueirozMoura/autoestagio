-- Etapa de descoberta ampla: "leads" de alertas (Indeed, LinkedIn...). Migração ADITIVA: só cria uma tabela nova.
--
-- Um lead é uma PISTA de vaga (título, empresa, local...) vinda de um alerta. NÃO é uma vaga coletada da fonte
-- oficial, NÃO é uma candidatura e NÃO autoriza nenhum envio: não há chave estrangeira entre leads e
-- `jobs`/`applications`/envios, de propósito. O canal de candidatura de um lead é "desconhecido" até você
-- confirmá-lo na página oficial; e-mail de recrutador nunca é deduzido do remetente do alerta.

CREATE TABLE job_leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL CHECK (source IN ('indeed', 'linkedin', 'gupy', 'outro')),
  title        TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  company      TEXT CHECK (company IS NULL OR length(trim(company)) BETWEEN 1 AND 200),
  location     TEXT CHECK (location IS NULL OR length(trim(location)) BETWEEN 1 AND 200),
  work_mode    TEXT CHECK (work_mode IS NULL OR work_mode IN ('remoto', 'hibrido', 'presencial')),
  -- Texto da bolsa como publicado no alerta (preservado para auditoria).
  stipend_text TEXT CHECK (stipend_text IS NULL OR length(stipend_text) <= 120),
  -- Só HTTPS, sem parâmetros de rastreamento (links de alertas são pessoais): a aplicação remove query e fragmento.
  url          TEXT CHECK (url IS NULL OR (url LIKE 'https://%' AND length(url) <= 500 AND instr(url, '?') = 0 AND instr(url, '#') = 0)),
  -- Hash de título+empresa+local normalizados: o mesmo lead recebido de novo não duplica.
  lead_key     TEXT NOT NULL CHECK (length(lead_key) = 32),
  received_on  TEXT CHECK (received_on IS NULL OR received_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Como candidatar: só você confirma, na página oficial. Não existe valor "e-mail" de propósito.
  channel      TEXT NOT NULL DEFAULT 'desconhecido' CHECK (channel IN ('desconhecido', 'formulario', 'portal_empresa')),
  status       TEXT NOT NULL DEFAULT 'nova' CHECK (status IN ('nova', 'em_analise', 'descartada', 'aplicada_manualmente')),
  note         TEXT CHECK (note IS NULL OR length(note) <= 300),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (source, lead_key)
);

CREATE INDEX idx_job_leads_status ON job_leads (status);
